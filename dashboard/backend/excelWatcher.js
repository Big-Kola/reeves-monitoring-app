// FuelOps Monitor - Excel watcher
//
// Watches the three data workbooks and imports any new rows automatically.
// Export workbooks are only ever read; a row that fails validation is skipped
// and logged rather than crashing the app.

const chokidar = require('chokidar');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const {
  loadData,
  saveData,
  addEquipmentReading,
  addDelivery,
  addMaintenance,
  addAlert,
  getRecordState,
  markRecordProcessed,
  getDashboardStats
} = require('./storage');
const {
  evaluateEquipmentReading,
  evaluateDelivery,
  detectTrends,
  buildRecurringAlerts
} = require('./monitoring');
const { DATA_DIR, STORAGE_DIR } = require('./config');

const FILES = {
  bowser: 'Bowser_Readings.xlsx',
  peddler: 'Peddler_Deliveries.xlsx',
  maintenance: 'Maintenance_Log.xlsx'
};

const LOG_PATH = path.join(STORAGE_DIR, 'watcher.log');
const MAX_LOG_BYTES = 512 * 1024;

let watchers = {};
let isMonitoring = true;
let mainWindow = null;
let notificationCallback = null;
let processing = false;

const watcherStatus = {
  state: 'Starting',
  startedAt: null,
  lastChangeAt: null,
  lastChangeFile: null,
  lastReadAt: null,
  lastRowsFound: 0,
  lastImportAt: null,
  lastImportCount: 0,
  lastSkipped: 0,
  lastError: null
};

// Console output is invisible for the packaged Windows build, so the same
// lines are also appended to storage/watcher.log for diagnosis.
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > MAX_LOG_BYTES) {
      fs.writeFileSync(LOG_PATH, '');
    }
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch (err) {
    console.error('[FuelOps Watcher] Could not write log:', err.message);
  }
}

function setMainWindow(window) {
  mainWindow = window;
}

function setNotificationCallback(callback) {
  notificationCallback = callback;
}

function setMonitoring(state) {
  isMonitoring = state;
  watcherStatus.state = state ? 'Active' : 'Paused';
}

function getMonitoringState() {
  return isMonitoring;
}

function sheetToRows(worksheet) {
  const matrix = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    defval: '',
    blankrows: false,
    raw: true
  });
  if (!matrix.length) return [];

  // Trim header cells so a stray space cannot hide a column.
  const headers = (matrix[0] || []).map(cell => String(cell).trim());
  const rows = [];
  for (let r = 1; r < matrix.length; r++) {
    const raw = matrix[r] || [];
    const row = {};
    let hasValue = false;
    headers.forEach((header, c) => {
      if (!header) return;
      const value = raw[c] === undefined ? '' : raw[c];
      row[header] = value;
      if (value !== '' && value !== null && value !== undefined) hasValue = true;
    });
    if (hasValue) rows.push(row);
  }
  return rows;
}

// Throws on failure so the caller can retry while Excel is still writing.
function readWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('No worksheet found');
  return sheetToRows(workbook.Sheets[sheetName]);
}

function parseExcelFile(filePath) {
  try {
    return readWorkbook(filePath);
  } catch (err) {
    log('[FuelOps Watcher] Workbook read failed:', path.basename(filePath), '-', err.message);
    return [];
  }
}

// Excel may still be flushing the file when the change event arrives. Retry a
// few times instead of silently importing nothing.
async function readWorkbookWithRetry(filePath) {
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      log('[FuelOps Watcher] Attempting workbook read:', filePath);
      const rows = readWorkbook(filePath);
      watcherStatus.lastReadAt = new Date().toISOString();
      watcherStatus.lastRowsFound = rows.length;
      watcherStatus.lastError = null;
      log('[FuelOps Watcher] Workbook read successful. Rows found:', rows.length);
      return rows;
    } catch (err) {
      watcherStatus.lastError = err.message;
      log('[FuelOps Watcher] Workbook read failed (attempt', `${attempt}/${maxAttempts}):`, err.message);
      if (attempt === maxAttempts) {
        log('[FuelOps Watcher] Giving up on read until the next file change.');
        return [];
      }
      await new Promise(resolve => setTimeout(resolve, 250 * attempt));
    }
  }
  return [];
}

// Returns the first non-empty value found among the supplied keys.
function pick(row, keys, fallback = '') {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

function normalizeBowserRow(row) {
  return {
    Timestamp: pick(row, ['Timestamp', 'timestamp', 'DateTime', 'Date Time']),
    'Equipment ID': pick(row, ['Equipment ID', 'Equipment', 'equipmentId', 'Unit', 'unit']),
    'Equipment Type': pick(row, ['Equipment Type', 'Type', 'type'], 'Aviation Bowser'),
    'Flow Rate L/min': pick(row, ['Flow Rate L/min', 'Flow Rate', 'Flow', 'flowRate']),
    'Delivery Pressure bar': pick(row, ['Delivery Pressure bar', 'Delivery Pressure', 'Pressure', 'pressure']),
    'Filter dP bar': pick(row, ['Filter dP bar', 'Filter dP', 'Filter DP', 'filterDp']),
    'Water Check': pick(row, ['Water Check', 'Water', 'water'], 'Clear'),
    'Interlock Status': pick(row, ['Interlock Status', 'Interlock', 'interlock'], 'Pass'),
    'Operating Hours': pick(row, ['Operating Hours', 'Hours', 'hours']),
    'Days Until Service': pick(row, ['Days Until Service', 'Days To Service', 'daysUntilService']),
    Notes: pick(row, ['Notes', 'notes', 'Remarks'])
  };
}

function normalizePeddlerRow(row) {
  return {
    Timestamp: pick(row, ['Timestamp', 'timestamp', 'DateTime', 'Date Time']),
    'Trip ID': pick(row, ['Trip ID', 'Trip Id', 'Trip', 'tripId']),
    'Equipment ID': pick(row, ['Equipment ID', 'Equipment', 'equipmentId', 'Peddler']),
    Transporter: pick(row, ['Transporter', 'transporter', 'Company']),
    'Truck Number': pick(row, ['Truck Number', 'Truck', 'Vehicle', 'truckNumber']),
    Driver: pick(row, ['Driver', 'driver']),
    Route: pick(row, ['Route', 'route']),
    'Quantity Loaded L': pick(row, ['Quantity Loaded L', 'Quantity Loaded', 'Loaded', 'loaded']),
    'Quantity Received L': pick(row, ['Quantity Received L', 'Quantity Received', 'Received', 'received']),
    'Seal Status': pick(row, ['Seal Status', 'Seal', 'seal'], 'Intact'),
    'Transit Delay Hrs': pick(row, ['Transit Delay Hrs', 'Transit Delay', 'Delay', 'delay']),
    Notes: pick(row, ['Notes', 'notes', 'Remarks'])
  };
}

function normalizeMaintenanceRow(row) {
  return {
    Date: pick(row, ['Date', 'date', 'Timestamp', 'timestamp']),
    'Equipment ID': pick(row, ['Equipment ID', 'Equipment', 'equipmentId']),
    'Equipment Type': pick(row, ['Equipment Type', 'Type', 'type']),
    'Fault Category': pick(row, ['Fault Category', 'Category', 'faultCategory']),
    'Fault Description': pick(row, ['Fault Description', 'Description', 'faultDescription']),
    'Downtime Hours': pick(row, ['Downtime Hours', 'Downtime', 'downtime']),
    'Action Taken': pick(row, ['Action Taken', 'Action', 'actionTaken']),
    Technician: pick(row, ['Technician', 'technician']),
    Status: pick(row, ['Status', 'status'], 'Open'),
    'Next Service Date': pick(row, ['Next Service Date', 'Next Service', 'nextService']),
    Notes: pick(row, ['Notes', 'notes', 'Remarks'])
  };
}

async function processBowserFile(data) {
  const added = [];
  const rows = await readWorkbookWithRetry(path.join(DATA_DIR, FILES.bowser));
  let skipped = 0;
  for (const row of rows) {
    const normalized = normalizeBowserRow(row);
    if (!normalized['Equipment ID']) {
      skipped++;
      log('[FuelOps Watcher] Skipping Bowser row: missing Equipment ID.');
      continue;
    }
    if (!normalized.Timestamp) {
      log('[FuelOps Watcher] Bowser row has no Timestamp; identifying by row contents:', normalized['Equipment ID']);
    }
    if (getRecordState(data, normalized, 'bowser') === 'processed') {
      skipped++;
      continue;
    }
    try {
      const reading = addEquipmentReading(data, normalized);
      markRecordProcessed(data, normalized, 'bowser');
      added.push(reading);
      log('[FuelOps Watcher] Importing Bowser', reading.id, '-', new Date().toISOString());
    } catch (err) {
      skipped++;
      log('[FuelOps Watcher] Skipping invalid Bowser row:', err.message);
    }
  }
  log('[FuelOps Watcher] Bowser rows found:', rows.length, 'new:', added.length, 'skipped:', skipped);
  watcherStatus.lastSkipped = skipped;
  return added;
}

async function processPeddlerFile(data) {
  const added = [];
  const rows = await readWorkbookWithRetry(path.join(DATA_DIR, FILES.peddler));
  let skipped = 0;
  for (const row of rows) {
    const normalized = normalizePeddlerRow(row);
    if (!normalized['Trip ID']) {
      skipped++;
      log('[FuelOps Watcher] Skipping Delivery row: missing Trip ID.');
      continue;
    }
    if (getRecordState(data, normalized, 'peddler') === 'processed') {
      skipped++;
      continue;
    }
    try {
      const delivery = addDelivery(data, normalized);
      markRecordProcessed(data, normalized, 'peddler');
      added.push(delivery);
      log('[FuelOps Watcher] Importing Delivery', delivery.tripId, '-', new Date().toISOString());
    } catch (err) {
      skipped++;
      log('[FuelOps Watcher] Skipping invalid Delivery row:', err.message);
    }
  }
  log('[FuelOps Watcher] Delivery rows found:', rows.length, 'new:', added.length, 'skipped:', skipped);
  return added;
}

async function processMaintenanceFile(data) {
  const added = [];
  const rows = await readWorkbookWithRetry(path.join(DATA_DIR, FILES.maintenance));
  let skipped = 0;
  for (const row of rows) {
    const normalized = normalizeMaintenanceRow(row);
    if (!normalized['Equipment ID']) {
      skipped++;
      log('[FuelOps Watcher] Skipping Maintenance row: missing Equipment ID.');
      continue;
    }
    if (getRecordState(data, normalized, 'maintenance') === 'processed') {
      skipped++;
      continue;
    }
    try {
      const record = addMaintenance(data, normalized);
      markRecordProcessed(data, normalized, 'maintenance');
      added.push(record);
      log('[FuelOps Watcher] Importing Maintenance for', record.equipmentId, '-', new Date().toISOString());
    } catch (err) {
      skipped++;
      log('[FuelOps Watcher] Skipping invalid Maintenance row:', err.message);
    }
  }
  log('[FuelOps Watcher] Maintenance rows found:', rows.length, 'new:', added.length, 'skipped:', skipped);
  return added;
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function showNotification(title, body) {
  log('[FuelOps Notification] Sending notification:', title, '-', body);
  if (notificationCallback) {
    try {
      notificationCallback(title, body);
    } catch (err) {
      log('[FuelOps Notification] Callback failed:', err.message);
    }
  }
  sendToRenderer('show-notification', { title, body });
}

// Only these severities should surface a Windows notification.
const NOTIFIABLE = new Set(['warning', 'critical', 'review']);

function notifyAlerts(alerts) {
  const notifiable = alerts.filter(a => NOTIFIABLE.has(a.severity));
  const MAX = 3;
  notifiable.slice(0, MAX).forEach(alert => {
    const title = `FuelOps Monitor — ${alert.equipmentId || alert.details?.tripId || 'Alert'}`;
    showNotification(title, alert.message);
  });
  if (notifiable.length > MAX) {
    showNotification('FuelOps Monitor',
      `${notifiable.length - MAX} additional alert(s) received. Open the app for details.`);
  }
}

let pendingRun = false;
let pendingForce = false;
let pendingNotify = false;

// Imports new/changed rows, evaluates rules, persists and notifies.
// force=true processes even while monitoring is paused (manual entries).
// options.notifySummary shows a confirmation toast when rows imported cleanly.
async function processAllFiles(force = false, options = {}) {
  if (!isMonitoring && !force) return { imported: 0, alerts: 0 };
  if (processing) {
    // A save landed while the previous pass was still running. Re-run after it.
    pendingRun = true;
    pendingForce = pendingForce || force;
    pendingNotify = pendingNotify || !!options.notifySummary;
    return { imported: 0, alerts: 0, queued: true };
  }
  processing = true;
  const notifySummary = !!options.notifySummary;

  const data = loadData();
  const settings = data.settings;
  const newAlerts = [];
  const store = data.processedFingerprints || {};
  const fingerprintCount = () => Object.values(store)
    .reduce((total, map) => total + Object.keys(map).length, 0);
  const fingerprintsBefore = fingerprintCount();

  try {
    const newReadings = await processBowserFile(data);
    const newDeliveries = await processPeddlerFile(data);
    const newMaintenance = await processMaintenanceFile(data);
    const totalNew = newReadings.length + newDeliveries.length + newMaintenance.length;

    log('[FuelOps Monitoring] Running rules for', totalNew, 'new/changed record(s).');
    for (const reading of newReadings) {
      newAlerts.push(...evaluateEquipmentReading(reading, settings));
    }
    for (const delivery of newDeliveries) {
      newAlerts.push(...evaluateDelivery(delivery, settings));
    }

    // Trend checks for equipment that received a new reading.
    const affected = new Set(newReadings.map(r => r.id));
    for (const id of affected) {
      const equipment = data.equipment.find(e => e.id === id);
      if (equipment) {
        for (const trend of detectTrends(equipment, settings)) {
          trend.dedupe = true;
          newAlerts.push(trend);
        }
      }
    }

    const savedAlerts = [];
    for (const alert of newAlerts) {
      const saved = addAlert(data, alert, { dedupe: !!alert.dedupe });
      if (saved) savedAlerts.push(saved);
    }

    // Recurring-issue detection across stored alerts.
    if (savedAlerts.length > 0) {
      for (const recurring of buildRecurringAlerts(data)) {
        const saved = addAlert(data, recurring, { dedupe: true });
        if (saved) savedAlerts.push(saved);
      }
    }

    // Fingerprints may be added when migrating records from an older version,
    // even when no rows were imported. Persist them so later edits are caught.
    const fingerprintsChanged = fingerprintCount() !== fingerprintsBefore;

    if (totalNew > 0 || savedAlerts.length > 0 || fingerprintsChanged) {
      const saved = saveData(data);
      log('[FuelOps Storage] Record stored:', totalNew, 'new/changed; save returned', String(saved));
      if (saved && totalNew > 0) {
        // Read storage back to prove the record is on disk without a restart.
        const verify = loadData();
        const verified = verify.processedRecords.bowser.length +
          verify.processedRecords.peddler.length +
          verify.processedRecords.maintenance.length;
        log('[FuelOps Storage] Verify after save: total processed keys =', verified);
      }
    }
    if (totalNew > 0 || savedAlerts.length > 0) {
      log('[FuelOps Renderer] Sending data-updated event.');
      sendToRenderer('data-updated', { stats: getDashboardStats(data) });
    }

    if (totalNew > 0) {
      watcherStatus.lastImportAt = new Date().toISOString();
      watcherStatus.lastImportCount = totalNew;
    }

    if (savedAlerts.length > 0) {
      notifyAlerts(savedAlerts);
    } else if (totalNew > 0 && notifySummary) {
      showNotification('FuelOps Monitor — Excel updated',
        `${totalNew} record(s) imported from Excel. No abnormal conditions detected.`);
    }

    if (totalNew > 0) {
      log(`[FuelOps Watcher] Imported ${totalNew} new/changed record(s) (${savedAlerts.length} alert(s)).`);
    }
    return { imported: totalNew, alerts: savedAlerts.length };
  } catch (err) {
    watcherStatus.lastError = err.message;
    log('[FuelOps Watcher] Error processing Excel files:', err.message);
    return { imported: 0, alerts: 0, error: err.message };
  } finally {
    processing = false;
    if (pendingRun) {
      const nextForce = pendingForce;
      const nextNotify = pendingNotify;
      pendingRun = false;
      pendingForce = false;
      pendingNotify = false;
      setTimeout(() => processAllFiles(nextForce, { notifySummary: nextNotify }), 150);
    }
  }
}

let debounceTimer = null;

function scheduleProcessing() {
  if (!isMonitoring) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    processAllFiles(false, { notifySummary: true });
  }, 300);
}

function filePathFor(key) {
  return path.join(DATA_DIR, FILES[key]);
}

function setupWatchers() {
  // Watch the directory, not individual files: Excel saves by writing a temp
  // file and renaming it over the target, so the watched file can be replaced.
  // Watching the folder plus polling reliably catches every save on Windows.
  stopWatchers();

  const filenames = new Set(Object.values(FILES));
  const options = {
    persistent: true,
    usePolling: true,
    interval: 700,
    awaitWriteFinish: {
      stabilityThreshold: 800,
      pollInterval: 200
    },
    ignored: /[\\/]~\$/,
    ignoreInitial: true,
    depth: 0
  };

  log('[FuelOps Watcher] Starting watcher');
  log('[FuelOps Watcher] Bowser file:', filePathFor('bowser'));
  log('[FuelOps Watcher] Delivery file:', filePathFor('peddler'));
  log('[FuelOps Watcher] Maintenance file:', filePathFor('maintenance'));

  const watcher = chokidar.watch(DATA_DIR, options);
  watchers.all = watcher;
  watcherStatus.state = isMonitoring ? 'Active' : 'Paused';
  watcherStatus.startedAt = new Date().toISOString();
  watcherStatus.lastError = null;

  const trigger = (filePath) => {
    const filename = path.basename(filePath);
    if (!filenames.has(filename)) return; // ignore Excel lock/temp files
    watcherStatus.lastChangeAt = new Date().toISOString();
    watcherStatus.lastChangeFile = filePath;
    log('[FuelOps Watcher] Change detected:', filePath);
    scheduleProcessing();
  };

  watcher.on('add', trigger);
  watcher.on('change', trigger);
  watcher.on('unlink', (filePath) => {
    const filename = path.basename(filePath);
    if (filenames.has(filename)) {
      log('[FuelOps Watcher] File removed (waiting for replacement):', filename);
    }
  });
  watcher.on('error', (err) => {
    watcherStatus.lastError = err.message;
    watcherStatus.state = 'Error';
    log('[FuelOps Watcher] Watcher error:', err.message);
  });

  // Import whatever is already present on startup.
  processAllFiles();
}

function stopWatchers() {
  Object.values(watchers).forEach(w => {
    try { w.close(); } catch (err) { /* ignore */ }
  });
  watchers = {};
}

function reconnectWatchers() {
  log('[FuelOps Watcher] Reconnect requested.');
  setupWatchers();
  return getStatus();
}

function getStatus() {
  const files = Object.entries(FILES).map(([key, name]) => {
    const filePath = filePathFor(key);
    let exists = false;
    try { exists = fs.existsSync(filePath); } catch (err) { exists = false; }
    return { key, name, path: filePath, exists };
  });
  const missing = files.filter(f => !f.exists);
  let state = isMonitoring ? 'Active' : 'Paused';
  if (missing.length) state = 'Missing File';
  if (watcherStatus.lastError) state = 'Error';
  return {
    ...watcherStatus,
    state,
    watching: !!watchers.all,
    dataDir: DATA_DIR,
    logPath: LOG_PATH,
    files,
    missing
  };
}

// Read-only health check of the three workbooks.
async function checkConnection() {
  const checks = [];
  for (const [key, name] of Object.entries(FILES)) {
    const filePath = filePathFor(key);
    if (!fs.existsSync(filePath)) {
      checks.push({ key, name, path: filePath, ok: false, error: 'File not found' });
      continue;
    }
    try {
      const rows = readWorkbook(filePath);
      checks.push({ key, name, path: filePath, ok: true, rows: rows.length });
    } catch (err) {
      checks.push({ key, name, path: filePath, ok: false, error: err.message });
    }
  }
  log('[FuelOps Watcher] Connection check:', checks.map(c => `${c.name}=${c.ok ? c.rows + ' rows' : c.error}`).join('; '));
  return { status: getStatus(), checks };
}

module.exports = {
  setupWatchers,
  stopWatchers,
  reconnectWatchers,
  getStatus,
  checkConnection,
  processAllFiles,
  parseExcelFile,
  normalizeBowserRow,
  normalizePeddlerRow,
  normalizeMaintenanceRow,
  setMainWindow,
  setNotificationCallback,
  setMonitoring,
  getMonitoringState,
  log,
  FILES,
  DATA_DIR
};
