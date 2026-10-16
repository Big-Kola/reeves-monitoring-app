// FuelOps Monitor - Excel watcher
//
// Watches the three data workbooks and imports any new rows automatically.
// Export workbooks are only ever read; a row that fails validation is skipped
// and logged rather than crashing the app.

const chokidar = require('chokidar');
const XLSX = require('xlsx');
const path = require('path');
const {
  loadData,
  saveData,
  addEquipmentReading,
  addDelivery,
  addMaintenance,
  addAlert,
  isRecordProcessed,
  markRecordProcessed,
  getDashboardStats
} = require('./storage');
const {
  evaluateEquipmentReading,
  evaluateDelivery,
  detectTrends,
  buildRecurringAlerts
} = require('./monitoring');
const { DATA_DIR } = require('./config');

const FILES = {
  bowser: 'Bowser_Readings.xlsx',
  peddler: 'Peddler_Deliveries.xlsx',
  maintenance: 'Maintenance_Log.xlsx'
};

let watchers = {};
let isMonitoring = true;
let mainWindow = null;
let notificationCallback = null;
let processing = false;

function setMainWindow(window) {
  mainWindow = window;
}

function setNotificationCallback(callback) {
  notificationCallback = callback;
}

function setMonitoring(state) {
  isMonitoring = state;
}

function getMonitoringState() {
  return isMonitoring;
}

function parseExcelFile(filePath) {
  try {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      console.warn(`No sheet found in ${path.basename(filePath)}`);
      return [];
    }
    const worksheet = workbook.Sheets[sheetName];
    return XLSX.utils.sheet_to_json(worksheet, { defval: '' });
  } catch (err) {
    console.error(`Error reading Excel file ${path.basename(filePath)}:`, err.message);
    return [];
  }
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

function processBowserFile(data) {
  const added = [];
  for (const row of parseExcelFile(path.join(DATA_DIR, FILES.bowser))) {
    const normalized = normalizeBowserRow(row);
    if (!normalized['Equipment ID'] || !normalized.Timestamp) continue;
    if (isRecordProcessed(data, normalized, 'bowser')) continue;
    try {
      added.push(addEquipmentReading(data, normalized));
      markRecordProcessed(data, normalized, 'bowser');
    } catch (err) {
      console.error('Skipping invalid bowser row:', err.message);
    }
  }
  return added;
}

function processPeddlerFile(data) {
  const added = [];
  for (const row of parseExcelFile(path.join(DATA_DIR, FILES.peddler))) {
    const normalized = normalizePeddlerRow(row);
    if (!normalized['Trip ID'] || !normalized.Timestamp) continue;
    if (isRecordProcessed(data, normalized, 'peddler')) continue;
    try {
      added.push(addDelivery(data, normalized));
      markRecordProcessed(data, normalized, 'peddler');
    } catch (err) {
      console.error('Skipping invalid peddler row:', err.message);
    }
  }
  return added;
}

function processMaintenanceFile(data) {
  const added = [];
  for (const row of parseExcelFile(path.join(DATA_DIR, FILES.maintenance))) {
    const normalized = normalizeMaintenanceRow(row);
    if (!normalized['Equipment ID'] || !normalized.Date) continue;
    if (isRecordProcessed(data, normalized, 'maintenance')) continue;
    try {
      added.push(addMaintenance(data, normalized));
      markRecordProcessed(data, normalized, 'maintenance');
    } catch (err) {
      console.error('Skipping invalid maintenance row:', err.message);
    }
  }
  return added;
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function showNotification(title, body) {
  if (notificationCallback) {
    try {
      notificationCallback(title, body);
    } catch (err) {
      console.error('Notification callback failed:', err.message);
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

// Imports any new rows, evaluates rules, persists and notifies.
// force=true processes even while monitoring is paused (manual entries).
async function processAllFiles(force = false) {
  if (!isMonitoring && !force) return { imported: 0, alerts: 0 };
  if (processing) return { imported: 0, alerts: 0 };
  processing = true;

  const data = loadData();
  const settings = data.settings;
  const newAlerts = [];

  try {
    const newReadings = processBowserFile(data);
    const newDeliveries = processPeddlerFile(data);
    const newMaintenance = processMaintenanceFile(data);
    const totalNew = newReadings.length + newDeliveries.length + newMaintenance.length;

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

    if (totalNew > 0 || savedAlerts.length > 0) {
      saveData(data);
      sendToRenderer('data-updated', { stats: getDashboardStats(data) });
    }

    if (savedAlerts.length > 0) notifyAlerts(savedAlerts);

    if (totalNew > 0) {
      console.log(`Imported ${totalNew} new record(s) (${savedAlerts.length} alert(s)).`);
    }
    return { imported: totalNew, alerts: savedAlerts.length };
  } catch (err) {
    console.error('Error processing Excel files:', err);
    return { imported: 0, alerts: 0, error: err.message };
  } finally {
    processing = false;
  }
}

function setupWatchers() {
  // Excel (and many editors) save by writing a temp file and renaming it over
  // the target, which produces add/unlink events rather than a plain change.
  // Polling is the most reliable way to notice those saves on Windows, and we
  // listen for add as well as change.
  const options = {
    persistent: true,
    usePolling: true,
    interval: 1000,
    awaitWriteFinish: {
      stabilityThreshold: 1200,
      pollInterval: 250
    },
    ignoreInitial: true
  };

  Object.entries(FILES).forEach(([key, filename]) => {
    const filePath = path.join(DATA_DIR, filename);
    watchers[key] = chokidar.watch(filePath, options);

    const trigger = () => {
      console.log(`Excel file changed: ${filename}`);
      setTimeout(() => processAllFiles(), 400);
    };

    watchers[key].on('change', trigger);
    watchers[key].on('add', trigger);

    watchers[key].on('error', (err) => {
      console.error(`Watcher error for ${filename}:`, err.message);
    });
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

module.exports = {
  setupWatchers,
  stopWatchers,
  processAllFiles,
  parseExcelFile,
  normalizeBowserRow,
  normalizePeddlerRow,
  normalizeMaintenanceRow,
  setMainWindow,
  setNotificationCallback,
  setMonitoring,
  getMonitoringState,
  FILES,
  DATA_DIR
};
