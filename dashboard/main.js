// FuelOps Monitor - Electron main process
//
// Wires the Excel watcher, monitoring rules, local storage, system tray and
// Windows notifications together, and exposes a small IPC surface to the
// renderer (see preload.js).

const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  Notification,
  dialog,
  nativeImage,
  shell
} = require('electron');
const path = require('path');
const fs = require('fs');

const templates = require('./backend/templates');
const excelWatcher = require('./backend/excelWatcher');
const {
  loadData,
  saveData,
  resolveAlert,
  updateAlertStatus,
  updateSettings,
  getDashboardStats,
  getHistory
} = require('./backend/storage');
const {
  detectTrends,
  findRecurringCategories,
  getEquipmentHealth,
  getSeverityLabel
} = require('./backend/monitoring');

const ASSETS_DIR = path.join(__dirname, 'assets');
const ICON_PATH = path.join(ASSETS_DIR, 'icon.ico');
const ICON_PNG_PATH = path.join(ASSETS_DIR, 'icon.png');
const TRAY_ICON_PATH = path.join(ASSETS_DIR, 'tray.png');

let mainWindow = null;
let tray = null;
let isQuitting = false;

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0b1626',
    title: 'FuelOps Monitor',
    icon: fs.existsSync(ICON_PNG_PATH) ? ICON_PNG_PATH : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Surface renderer warnings/errors in the terminal for troubleshooting.
  const minLevel = process.env.FUELOPS_VERBOSE_RENDERER ? 0 : 2;
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= minLevel) console.error(`[renderer] ${message} (${sourceId}:${line})`);
  });

  mainWindow.on('close', (event) => {
    // Closing the window hides the app; monitoring keeps running in the tray.
    if (!isQuitting && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open external links in the default browser rather than a new window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------------------------------------------------------------------------
// System tray
// ---------------------------------------------------------------------------

function buildTrayMenu() {
  if (!tray) return;
  const monitoring = excelWatcher.getMonitoringState();
  const menu = Menu.buildFromTemplate([
    { label: 'Open FuelOps Monitor', click: showWindow },
    { type: 'separator' },
    {
      label: 'Pause Monitoring',
      enabled: monitoring,
      click: () => setMonitoring(false)
    },
    {
      label: 'Resume Monitoring',
      enabled: !monitoring,
      click: () => setMonitoring(true)
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
}

function setMonitoring(state) {
  excelWatcher.setMonitoring(state);
  buildTrayMenu();
  if (tray) {
    tray.setToolTip(state ? 'FuelOps Monitor — Monitoring active' : 'FuelOps Monitor — Monitoring paused');
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('monitoring-state', state);
  }
  if (state) excelWatcher.processAllFiles();
}

function createTray() {
  let image = nativeImage.createFromPath(TRAY_ICON_PATH);
  if (image.isEmpty()) {
    image = nativeImage.createFromPath(ICON_PATH);
  }
  if (image.isEmpty()) {
    console.warn('Tray icon not found; close-to-tray disabled.');
    return;
  }
  try {
    tray = new Tray(image);
    tray.setToolTip('FuelOps Monitor — Monitoring active');
    tray.on('click', showWindow);
    buildTrayMenu();
  } catch (err) {
    console.error('Failed to create tray:', err.message);
    tray = null;
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function sendNotification(title, body) {
  const supported = Notification.isSupported();
  excelWatcher.log(`[FuelOps Notification] Supported: ${supported}`, '-', title, '-', body);
  if (!supported) return;
  try {
    excelWatcher.log('[FuelOps Notification] Showing notification for', title);
    const notification = new Notification({
      title,
      body,
      icon: fs.existsSync(ICON_PNG_PATH) ? ICON_PNG_PATH : undefined
    });
    notification.on('click', showWindow);
    notification.show();
  } catch (err) {
    excelWatcher.log('[FuelOps Notification] Failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Data shaping helpers
// ---------------------------------------------------------------------------

function equipmentWithHealth(data) {
  return (data.equipment || []).map(e => ({
    id: e.id,
    type: e.type,
    latest: e.latest || (e.readings && e.readings[0]) || null,
    readingCount: (e.readings || []).length,
    health: getEquipmentHealth(e.id, data.alerts)
  }));
}

function maintenanceDueSoon(data) {
  return (data.equipment || [])
    .map(e => ({ id: e.id, type: e.type, latest: e.latest || (e.readings && e.readings[0]) }))
    .filter(e => e.latest && typeof e.latest.daysUntilService === 'number' &&
      e.latest.daysUntilService <= data.settings.serviceWarningDays)
    .sort((a, b) => a.latest.daysUntilService - b.latest.daysUntilService)
    .map(e => ({
      id: e.id,
      type: e.type,
      daysUntilService: e.latest.daysUntilService,
      nextService: e.latest.timestamp
    }));
}

// ---------------------------------------------------------------------------
// IPC API
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('getDashboardData', () => {
    const data = loadData();
    return {
      stats: getDashboardStats(data),
      equipment: equipmentWithHealth(data),
      recentAlerts: (data.alerts || []).slice(0, 8),
      recentDeliveries: (data.deliveries || []).slice(0, 6),
      maintenanceDue: maintenanceDueSoon(data),
      monitoring: excelWatcher.getMonitoringState(),
      settings: data.settings
    };
  });

  ipcMain.handle('getEquipment', () => {
    const data = loadData();
    return equipmentWithHealth(data);
  });

  ipcMain.handle('getEquipmentDetail', (_event, id) => {
    const data = loadData();
    const equipment = (data.equipment || []).find(e => e.id === id);
    if (!equipment) return null;
    const readings = (equipment.readings || []).map(r => ({ ...r }));
    return {
      id: equipment.id,
      type: equipment.type,
      health: getEquipmentHealth(equipment.id, data.alerts),
      latest: equipment.latest || readings[0] || null,
      readings,
      alerts: (data.alerts || []).filter(a => a.equipmentId === id),
      maintenance: (data.maintenance || []).filter(m => m.equipmentId === id),
      trends: detectTrends({ ...equipment, readings }, data.settings),
      recurring: findRecurringCategories(data, id)
    };
  });

  ipcMain.handle('getEquipmentList', () => {
    const data = loadData();
    return (data.equipment || []).map(e => ({ id: e.id, type: e.type }));
  });

  ipcMain.handle('getDeliveries', () => {
    const data = loadData();
    return (data.deliveries || []).map(d => ({
      ...d,
      status: getDeliveryStatus(d, data.settings)
    }));
  });

  ipcMain.handle('getAlerts', () => {
    const data = loadData();
    return (data.alerts || []).map(a => ({ ...a, severityLabel: getSeverityLabel(a.severity) }));
  });

  ipcMain.handle('getMaintenance', () => {
    const data = loadData();
    // A fault is recurring when the same fault category has been logged for the
    // same equipment three or more times.
    const counts = {};
    (data.maintenance || []).forEach(m => {
      const key = `${m.equipmentId}|${(m.faultCategory || '').toLowerCase()}`;
      counts[key] = (counts[key] || 0) + 1;
    });
    return (data.maintenance || []).map(m => {
      const key = `${m.equipmentId}|${(m.faultCategory || '').toLowerCase()}`;
      return { ...m, recurring: counts[key] >= 3 };
    });
  });

  ipcMain.handle('getHistory', (_event, filters) => {
    const data = loadData();
    return getHistory(data, filters || {});
  });

  ipcMain.handle('getSettings', () => loadData().settings);

  ipcMain.handle('updateSettings', (_event, settings) => {
    const data = loadData();
    const numeric = {};
    for (const [key, value] of Object.entries(settings || {})) {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) numeric[key] = n;
    }
    updateSettings(data, numeric);
    saveData(data);
    return data.settings;
  });

  ipcMain.handle('resolveAlert', (_event, payload) => {
    const data = loadData();
    const { alertId, resolution } = payload || {};
    const ok = resolveAlert(data, alertId, resolution || {});
    if (ok) saveData(data);
    return { ok };
  });

  ipcMain.handle('updateAlertStatus', (_event, payload) => {
    const data = loadData();
    const { alertId, status } = payload || {};
    const ok = updateAlertStatus(data, alertId, status);
    if (ok) saveData(data);
    return { ok };
  });

  ipcMain.handle('addManualReading', async (_event, reading) => {
    try {
      templates.appendBowserReading(reading);
      const result = await excelWatcher.processAllFiles(true);
      return { ok: true, ...result };
    } catch (err) {
      console.error('Manual reading failed:', err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('addManualDelivery', async (_event, delivery) => {
    try {
      templates.appendPeddlerDelivery(delivery);
      const result = await excelWatcher.processAllFiles(true);
      return { ok: true, ...result };
    } catch (err) {
      console.error('Manual delivery failed:', err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('addMaintenance', async (_event, record) => {
    try {
      templates.appendMaintenanceRecord(record);
      const result = await excelWatcher.processAllFiles(true);
      return { ok: true, ...result };
    } catch (err) {
      console.error('Manual maintenance failed:', err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('exportCsv', async (_event, payload) => {
    const data = loadData();
    const { type = 'all', filters = {} } = payload || {};
    const rows = getHistory(data, { ...filters, type });
    const csv = toCsv(rows);
    const stamp = new Date().toISOString().slice(0, 10);
    const defaultPath = `FuelOps_${type}_${stamp}.csv`;

    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export CSV',
      defaultPath,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    });

    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(result.filePath, csv, 'utf-8');
      return { ok: true, path: result.filePath, count: rows.length };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('getMonitoringState', () => excelWatcher.getMonitoringState());
  ipcMain.handle('setMonitoring', (_event, state) => {
    setMonitoring(!!state);
    return excelWatcher.getMonitoringState();
  });

  ipcMain.handle('getDataFolder', () => ({
    dataDir: excelWatcher.DATA_DIR,
    files: excelWatcher.FILES
  }));

  ipcMain.handle('openDataFolder', async () => {
    const error = await shell.openPath(excelWatcher.DATA_DIR);
    return { ok: !error, error: error || undefined };
  });

  ipcMain.handle('getWatcherStatus', () => excelWatcher.getStatus());

  ipcMain.handle('reconnectWatcher', () => excelWatcher.reconnectWatchers());

  ipcMain.handle('checkConnection', () => excelWatcher.checkConnection());
}

function getDeliveryStatus(delivery, settings) {
  if (typeof delivery.variancePercent === 'number' &&
      delivery.variancePercent > settings.deliveryVarianceThreshold) {
    return 'Review Required';
  }
  const seal = (delivery.sealStatus || '').toLowerCase();
  if (seal && seal !== 'intact') return 'Review Required';
  if (typeof delivery.transitDelay === 'number' &&
      delivery.transitDelay > settings.transitDelayThreshold) {
    return 'Review Required';
  }
  return 'OK';
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function toCsv(rows) {
  if (!rows || rows.length === 0) return 'No records\n';
  const preferred = [
    'type', 'timestamp', 'equipmentId', 'tripId', 'transporter', 'truckNumber',
    'driver', 'route', 'quantityLoaded', 'quantityReceived', 'varianceLitres',
    'variancePercent', 'sealStatus', 'transitDelay', 'flowRate', 'pressure',
    'filterDp', 'water', 'interlock', 'operatingHours', 'daysUntilService',
    'faultCategory', 'faultDescription', 'downtimeHours', 'actionTaken',
    'technician', 'status', 'nextServiceDate', 'category', 'severity',
    'severityLabel', 'message', 'notes'
  ];
  const extraKeys = new Set();
  rows.forEach(row => Object.keys(row).forEach(k => {
    if (k !== 'details' && !preferred.includes(k)) extraKeys.add(k);
  }));
  const headers = [...preferred, ...extraKeys].filter(h => h !== 'details' && h !== 'statusChangedAt' && h !== 'resolution');
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => csvEscape(row[h])).join(','));
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    app.setAppUserModelId('com.fuelops.monitor');

    // Create the demo Excel workbooks if they are missing.
    try {
      templates.createAllTemplates();
    } catch (err) {
      console.error('Template creation failed:', err.message);
    }

    registerIpc();
    createWindow();
    createTray();

    excelWatcher.setMainWindow(mainWindow);
    excelWatcher.setNotificationCallback(sendNotification);
    excelWatcher.log('[FuelOps Watcher] Watching data folder:', excelWatcher.DATA_DIR);
    excelWatcher.setupWatchers();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });

    // Optional automated smoke check: FUELOPS_SMOKE=1 npm start
    if (process.env.FUELOPS_SMOKE) {
      setTimeout(() => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) win.close();
        setTimeout(() => {
          const windows = BrowserWindow.getAllWindows();
          const visible = windows[0] ? windows[0].isVisible() : false;
          console.log(`[smoke] after close -> windows=${windows.length} visible=${visible} tray=${!!tray}`);
          console.log('[smoke] close kept app alive:', windows.length === 1 && !visible && !!tray);
          isQuitting = true;
          app.quit();
        }, 1200);
      }, 6000);
    }
  });

  app.on('window-all-closed', () => {
    // Keep running in the tray while monitoring is enabled.
    if (process.platform !== 'darwin' && !tray) app.quit();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    excelWatcher.stopWatchers();
  });
}
