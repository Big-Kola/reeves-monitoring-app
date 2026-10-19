// FuelOps Monitor - local JSON persistence
//
// Stores all imported/manual data in storage/app-data.json. The file is created
// automatically if missing and the app degrades gracefully if it is corrupt.

const fs = require('fs');
const path = require('path');
const { getEquipmentHealth, getSeverityLabel } = require('./monitoring');
const { STORAGE_PATH } = require('./config');

const DEFAULT_DATA = {
  equipment: [],
  deliveries: [],
  maintenance: [],
  alerts: [],
  settings: {
    minimumFlow: 1500,
    minimumPressure: 2.5,
    maximumPressure: 5.0,
    maximumFilterDp: 1.0,
    serviceWarningDays: 14,
    deliveryVarianceThreshold: 0.5,
    transitDelayThreshold: 2
  },
  processedRecords: {
    bowser: [],
    peddler: [],
    maintenance: []
  },
  processedFingerprints: {
    bowser: {},
    peddler: {},
    maintenance: {}
  },
  alertResolutions: []
};

function ensureStorageExists() {
  const dir = path.dirname(STORAGE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(STORAGE_PATH)) {
    fs.writeFileSync(STORAGE_PATH, JSON.stringify(DEFAULT_DATA, null, 2));
  }
}

function deepDefaults(data) {
  return {
    ...DEFAULT_DATA,
    ...data,
    settings: { ...DEFAULT_DATA.settings, ...(data && data.settings) },
    processedRecords: {
      bowser: [],
      peddler: [],
      maintenance: [],
      ...((data && data.processedRecords) || {})
    },
    processedFingerprints: {
      bowser: {},
      peddler: {},
      maintenance: {},
      ...((data && data.processedFingerprints) || {})
    }
  };
}

function loadData() {
  ensureStorageExists();
  try {
    const raw = fs.readFileSync(STORAGE_PATH, 'utf-8');
    if (!raw.trim()) return JSON.parse(JSON.stringify(DEFAULT_DATA));
    const data = JSON.parse(raw);
    return deepDefaults(data);
  } catch (err) {
    console.error('Error loading storage, using defaults:', err.message);
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
}

function saveData(data) {
  ensureStorageExists();
  try {
    fs.writeFileSync(STORAGE_PATH, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.error('Error saving storage:', err.message);
    return false;
  }
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function generateRecordKey(record, type) {
  const timestamp = record.Timestamp || record.Date || record.timestamp || record.date || '';
  const id = record['Equipment ID'] || record['Equipment'] || record['Trip ID'] || record['tripId'] || '';
  // Rows added without a date still import. Their identity comes from the
  // row's own values, so an unchanged row is de-duplicated and an edited row
  // is re-evaluated instead of being ignored.
  if (!timestamp) {
    return `${type}:no-ts:${id}:${recordFingerprint(record)}`;
  }
  return `${type}:${timestamp}:${id}`;
}

// A stable fingerprint of every cell in the row. The record key (timestamp +
// equipment) identifies a row; the fingerprint notices when its values change,
// so editing an existing Excel row is re-imported and re-evaluated immediately.
function recordFingerprint(record) {
  return Object.keys(record || {})
    .sort()
    .map(key => `${key}=${JSON.stringify(record[key] ?? '')}`)
    .join('|');
}

function getFingerprintStore(data, type) {
  if (!data.processedFingerprints) data.processedFingerprints = {};
  if (!data.processedFingerprints[type]) data.processedFingerprints[type] = {};
  return data.processedFingerprints[type];
}

// Returns 'new' | 'changed' | 'processed'.
function getRecordState(data, record, type) {
  const key = generateRecordKey(record, type);
  const store = getFingerprintStore(data, type);
  const current = recordFingerprint(record);

  if (!(data.processedRecords[type] || []).includes(key)) return 'new';

  // Migration: records imported by an older version have no fingerprint yet.
  // Remember their current content so future edits can be detected without
  // re-importing everything on the first launch after updating.
  if (store[key] === undefined) {
    store[key] = current;
    return 'processed';
  }

  return store[key] === current ? 'processed' : 'changed';
}

function isRecordProcessed(data, record, type) {
  return getRecordState(data, record, type) === 'processed';
}

function markRecordProcessed(data, record, type) {
  if (!data.processedRecords[type]) data.processedRecords[type] = [];
  const key = generateRecordKey(record, type);
  const store = getFingerprintStore(data, type);
  store[key] = recordFingerprint(record);

  if (!data.processedRecords[type].includes(key)) {
    data.processedRecords[type].push(key);
  }

  if (data.processedRecords[type].length > 10000) {
    data.processedRecords[type] = data.processedRecords[type].slice(-5000);
    const live = new Set(data.processedRecords[type]);
    for (const oldKey of Object.keys(store)) {
      if (!live.has(oldKey)) delete store[oldKey];
    }
  }
}

// Adds a reading and returns the processed reading object so the caller can
// run monitoring rules against exactly what was added.
function addEquipmentReading(data, reading) {
  const processedReading = {
    id: reading['Equipment ID'],
    type: reading['Equipment Type'] || 'Equipment',
    timestamp: reading.Timestamp,
    flowRate: toNumberOrNull(reading['Flow Rate L/min']),
    pressure: toNumberOrNull(reading['Delivery Pressure bar']),
    filterDp: toNumberOrNull(reading['Filter dP bar']),
    water: reading['Water Check'] || 'Clear',
    interlock: reading['Interlock Status'] || 'Pass',
    operatingHours: toNumberOrNull(reading['Operating Hours']),
    daysUntilService: toNumberOrNull(reading['Days Until Service']),
    notes: reading.Notes || ''
  };

  const existing = data.equipment.find(e => e.id === reading['Equipment ID']);
  if (existing) {
    existing.readings = existing.readings || [];
    // If this row was edited, replace the old version instead of duplicating it.
    existing.readings = existing.readings.filter(
      r => String(r.timestamp) !== String(processedReading.timestamp)
    );
    existing.readings.unshift(processedReading);
    if (existing.readings.length > 100) existing.readings = existing.readings.slice(0, 100);
    existing.latest = processedReading;
    if (reading['Equipment Type']) existing.type = reading['Equipment Type'];
  } else {
    data.equipment.push({
      id: reading['Equipment ID'],
      type: reading['Equipment Type'] || 'Equipment',
      readings: [processedReading],
      latest: processedReading
    });
  }
  return processedReading;
}

function addDelivery(data, delivery) {
  const loaded = toNumberOrNull(delivery['Quantity Loaded L']);
  const received = toNumberOrNull(delivery['Quantity Received L']);
  const varianceLitres = (loaded !== null && received !== null) ? loaded - received : null;
  const variancePercent = (varianceLitres !== null && loaded > 0)
    ? Number((varianceLitres / loaded * 100).toFixed(2))
    : null;

  const processed = {
    tripId: delivery['Trip ID'],
    timestamp: delivery.Timestamp,
    equipmentId: delivery['Equipment ID'],
    transporter: delivery.Transporter,
    truckNumber: delivery['Truck Number'],
    driver: delivery.Driver,
    route: delivery.Route,
    quantityLoaded: loaded,
    quantityReceived: received,
    varianceLitres,
    variancePercent,
    sealStatus: delivery['Seal Status'] || 'Intact',
    transitDelay: toNumberOrNull(delivery['Transit Delay Hrs']),
    notes: delivery.Notes || ''
  };

  // Replace an edited trip rather than showing the same trip twice.
  data.deliveries = data.deliveries.filter(
    d => String(d.tripId) !== String(processed.tripId)
  );
  data.deliveries.unshift(processed);
  if (data.deliveries.length > 500) data.deliveries = data.deliveries.slice(0, 500);
  return processed;
}

function addMaintenance(data, record) {
  const processed = {
    date: record.Date,
    equipmentId: record['Equipment ID'],
    equipmentType: record['Equipment Type'],
    faultCategory: record['Fault Category'],
    faultDescription: record['Fault Description'],
    downtimeHours: toNumberOrNull(record['Downtime Hours']),
    actionTaken: record['Action Taken'],
    technician: record.Technician,
    status: record.Status || 'Open',
    nextServiceDate: record['Next Service Date'],
    notes: record.Notes || ''
  };

  // Replace an edited maintenance entry rather than duplicating it.
  data.maintenance = data.maintenance.filter(m =>
    !(String(m.date) === String(processed.date) &&
      String(m.equipmentId) === String(processed.equipmentId) &&
      String(m.faultCategory) === String(processed.faultCategory))
  );
  data.maintenance.unshift(processed);
  if (data.maintenance.length > 500) data.maintenance = data.maintenance.slice(0, 500);
  return processed;
}

function alertSignature(alert) {
  return [
    alert.equipmentId || '',
    alert.category || '',
    alert.message || '',
    JSON.stringify(alert.details || {})
  ].join('|');
}

function hasOpenAlert(data, alert) {
  const sig = alertSignature(alert);
  return (data.alerts || []).some(a => a.status === 'Open' && alertSignature(a) === sig);
}

// options.dedupe prevents duplicate Open alerts with the same signature
// (used for trend/recurring meta-alerts which are recomputed on each import).
function addAlert(data, alert, options = {}) {
  if (!data.alerts) data.alerts = [];
  if (options.dedupe && hasOpenAlert(data, alert)) return null;

  const newAlert = {
    id: `ALT-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    timestamp: alert.timestamp || new Date().toISOString(),
    equipmentId: alert.equipmentId || alert.details?.tripId || '',
    category: alert.category,
    severity: alert.severity,
    severityLabel: getSeverityLabel(alert.severity),
    message: alert.message,
    status: 'Open',
    details: alert.details || {}
  };
  data.alerts.unshift(newAlert);
  if (data.alerts.length > 1000) data.alerts = data.alerts.slice(0, 1000);
  return newAlert;
}

function updateAlertStatus(data, alertId, status) {
  const alert = data.alerts.find(a => a.id === alertId);
  if (!alert) return false;
  alert.status = status;
  if (status !== 'Open') alert.statusChangedAt = new Date().toISOString();
  return true;
}

function resolveAlert(data, alertId, resolution) {
  const alert = data.alerts.find(a => a.id === alertId);
  if (!alert) return false;
  alert.status = 'Resolved';
  alert.resolvedAt = new Date().toISOString();
  alert.resolution = {
    rootCause: resolution.rootCause || '',
    actionTaken: resolution.actionTaken || '',
    notes: resolution.notes || ''
  };
  data.alertResolutions.push({
    alertId,
    resolvedAt: alert.resolvedAt,
    ...alert.resolution
  });
  return true;
}

function updateSettings(data, newSettings) {
  data.settings = { ...data.settings, ...newSettings };
  return data.settings;
}

function getDashboardStats(data) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  let healthy = 0;
  let needsAttention = 0;
  let critical = 0;

  for (const equipment of (data.equipment || [])) {
    const health = getEquipmentHealth(equipment.id, data.alerts);
    if (health === 'critical') critical++;
    else if (health === 'warning' || health === 'review') needsAttention++;
    else healthy++;
  }

  const todaysDeliveries = (data.deliveries || []).filter(d => new Date(d.timestamp) >= todayStart);
  const totalLoaded = todaysDeliveries.reduce((sum, d) => sum + (d.quantityLoaded || 0), 0);
  const totalReceived = todaysDeliveries.reduce((sum, d) => sum + (d.quantityReceived || 0), 0);
  const totalVariance = totalLoaded > 0
    ? Number(((totalLoaded - totalReceived) / totalLoaded * 100).toFixed(2))
    : 0;

  const maintenanceDue = (data.equipment || []).filter(e => {
    const latest = e.latest || (e.readings && e.readings[0]);
    return latest && typeof latest.daysUntilService === 'number' &&
      latest.daysUntilService <= data.settings.serviceWarningDays;
  }).length;

  return {
    totalEquipment: (data.equipment || []).length,
    healthy,
    needsAttention,
    critical,
    openAlerts: (data.alerts || []).filter(a => a.status === 'Open').length,
    todaysDeliveries: todaysDeliveries.length,
    totalLoaded,
    totalReceived,
    totalVariance,
    maintenanceDue
  };
}

// Applies History page filters across all record types.
function getHistory(data, filters = {}) {
  const rows = [];

  for (const e of (data.equipment || [])) {
    for (const r of (e.readings || [])) {
      rows.push({ ...r, equipmentId: e.id, type: 'reading' });
    }
  }
  for (const d of (data.deliveries || [])) {
    rows.push({ ...d, type: 'delivery' });
  }
  for (const m of (data.maintenance || [])) {
    rows.push({ ...m, timestamp: m.date, type: 'maintenance' });
  }
  for (const a of (data.alerts || [])) {
    rows.push({ ...a, type: 'alert' });
  }

  const { type, equipment, from, to, status, transporter, severity } = filters;

  return rows.filter(row => {
    if (type && type !== 'all' && row.type !== type) return false;

    const equipmentId = row.equipmentId || row.id || '';
    if (equipment && equipment !== 'all' && equipmentId !== equipment) return false;

    if (transporter && transporter !== 'all' && row.transporter !== transporter) return false;

    if (status && status !== 'all') {
      const rowStatus = row.status || '';
      if (rowStatus.toLowerCase() !== status.toLowerCase()) return false;
    }

    if (severity && severity !== 'all' && row.severity !== severity) return false;

    if (from) {
      const t = new Date(row.timestamp);
      if (!Number.isNaN(t.getTime()) && t < new Date(`${from}T00:00:00`)) return false;
    }
    if (to) {
      const t = new Date(row.timestamp);
      if (!Number.isNaN(t.getTime()) && t > new Date(`${to}T23:59:59`)) return false;
    }

    return true;
  });
}

module.exports = {
  STORAGE_PATH,
  loadData,
  saveData,
  addEquipmentReading,
  addDelivery,
  addMaintenance,
  addAlert,
  updateAlertStatus,
  resolveAlert,
  updateSettings,
  getDashboardStats,
  getHistory,
  isRecordProcessed,
  getRecordState,
  markRecordProcessed,
  recordFingerprint,
  alertSignature,
  toNumberOrNull,
  DEFAULT_DATA
};
