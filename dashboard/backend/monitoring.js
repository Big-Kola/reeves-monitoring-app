// FuelOps Monitor - monitoring rules
//
// All thresholds here are DEMONSTRATION values. They must be replaced with
// approved equipment manufacturer limits and company procedures before any
// operational use. See README.md and the Settings page.

const THRESHOLD_DEFAULTS = {
  minimumFlow: 1500,            // L/min
  minimumPressure: 2.5,         // bar
  maximumPressure: 5.0,         // bar
  maximumFilterDp: 1.0,         // bar
  serviceWarningDays: 14,       // days
  deliveryVarianceThreshold: 0.5, // %
  transitDelayThreshold: 2      // hours
};

// Internal severities map to the labels shown in the UI and notifications.
//   warning  -> "Needs Attention"
//   critical -> "Critical"
//   review   -> "Review Required"
//   info     -> "Information"
const SEVERITY_LABELS = {
  critical: 'Critical',
  warning: 'Needs Attention',
  review: 'Review Required',
  info: 'Information'
};

const WATER_CRITICAL_VALUES = ['detected', 'fail', 'failed', 'alarm', 'positive', 'present', 'contaminated'];
const INTERLOCK_CRITICAL_VALUES = ['fail', 'failed', 'fault', 'error', 'blocked'];
const SEAL_REVIEW_VALUES = ['broken', 'damaged', 'missing', 'tampered', 'open', 'compromised'];

function getSeverityLabel(severity) {
  return SEVERITY_LABELS[severity] || severity;
}

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asText(value) {
  return (value === null || value === undefined ? '' : String(value)).toLowerCase().trim();
}

function createAlert(equipmentId, equipmentType, category, severity, message, details, timestamp) {
  return {
    equipmentId,
    equipmentType,
    category,
    severity,
    message,
    details: details || {},
    timestamp: timestamp || new Date().toISOString()
  };
}

function evaluateEquipmentReading(reading, settings) {
  const alerts = [];
  const cfg = { ...THRESHOLD_DEFAULTS, ...(settings || {}) };
  const equipmentId = reading.id;
  const equipmentType = reading.type;
  const timestamp = reading.timestamp;

  const flow = asNumber(reading.flowRate);
  const pressure = asNumber(reading.pressure);
  const filterDp = asNumber(reading.filterDp);
  const water = asText(reading.water);
  const interlock = asText(reading.interlock);
  const daysUntilService = asNumber(reading.daysUntilService);

  if (flow !== null && flow < cfg.minimumFlow) {
    alerts.push(createAlert(equipmentId, equipmentType, 'flow', 'warning',
      `Flow rate below configured threshold (${flow} L/min). Minimum: ${cfg.minimumFlow} L/min`,
      { flow, threshold: cfg.minimumFlow }, timestamp));
  }

  if (pressure !== null && (pressure < cfg.minimumPressure || pressure > cfg.maximumPressure)) {
    alerts.push(createAlert(equipmentId, equipmentType, 'pressure', 'warning',
      `Delivery pressure outside configured range (${pressure} bar). Range: ${cfg.minimumPressure}-${cfg.maximumPressure} bar`,
      { pressure, min: cfg.minimumPressure, max: cfg.maximumPressure }, timestamp));
  }

  if (filterDp !== null && filterDp > cfg.maximumFilterDp) {
    alerts.push(createAlert(equipmentId, equipmentType, 'filter', 'warning',
      `Filter differential pressure above configured threshold (${filterDp} bar). Maximum: ${cfg.maximumFilterDp} bar. Qualified inspection recommended.`,
      { filterDp, threshold: cfg.maximumFilterDp }, timestamp));
  }

  if (water && WATER_CRITICAL_VALUES.some(v => water.includes(v))) {
    alerts.push(createAlert(equipmentId, equipmentType, 'water', 'critical',
      `Water condition requires immediate qualified operational review. Detected: ${reading.water}`,
      { water: reading.water }, timestamp));
  }

  if (interlock && INTERLOCK_CRITICAL_VALUES.some(v => interlock.includes(v))) {
    alerts.push(createAlert(equipmentId, equipmentType, 'interlock', 'critical',
      `Safety/interlock check failed. Qualified technical review required. Status: ${reading.interlock}`,
      { interlock: reading.interlock }, timestamp));
  }

  if (daysUntilService !== null) {
    if (daysUntilService <= 0) {
      alerts.push(createAlert(equipmentId, equipmentType, 'maintenance', 'critical',
        `Maintenance overdue by ${Math.abs(daysUntilService)} day(s). Qualified service required.`,
        { daysUntilService }, timestamp));
    } else if (daysUntilService <= cfg.serviceWarningDays) {
      alerts.push(createAlert(equipmentId, equipmentType, 'maintenance', 'warning',
        `Service due in ${daysUntilService} day(s). Schedule qualified maintenance.`,
        { daysUntilService, warningDays: cfg.serviceWarningDays }, timestamp));
    }
  }

  return alerts;
}

function evaluateDelivery(delivery, settings) {
  const alerts = [];
  const cfg = { ...THRESHOLD_DEFAULTS, ...(settings || {}) };
  const equipmentId = delivery.equipmentId;
  const timestamp = delivery.timestamp;

  const variancePercent = asNumber(delivery.variancePercent);
  if (variancePercent !== null && variancePercent > cfg.deliveryVarianceThreshold) {
    alerts.push(createAlert(equipmentId, 'Peddler Delivery', 'delivery-variance', 'review',
      `Delivery variance is ${variancePercent.toFixed(2)}%. Reconciliation required. Threshold: ${cfg.deliveryVarianceThreshold}%`,
      { variancePercent, varianceLitres: delivery.varianceLitres, threshold: cfg.deliveryVarianceThreshold, tripId: delivery.tripId }, timestamp));
  }

  const delay = asNumber(delivery.transitDelay);
  if (delay !== null && delay > cfg.transitDelayThreshold) {
    alerts.push(createAlert(equipmentId, 'Peddler Delivery', 'transit-delay', 'review',
      `Transit delay exceeds threshold (${delay} hrs). Threshold: ${cfg.transitDelayThreshold} hrs`,
      { delay, threshold: cfg.transitDelayThreshold, tripId: delivery.tripId }, timestamp));
  }

  const sealStatus = asText(delivery.sealStatus);
  if (sealStatus && sealStatus !== 'intact' && !SEAL_REVIEW_VALUES.includes(sealStatus)) {
    alerts.push(createAlert(equipmentId, 'Peddler Delivery', 'seal', 'review',
      `Seal status requires review: ${delivery.sealStatus}`,
      { sealStatus: delivery.sealStatus, tripId: delivery.tripId }, timestamp));
  } else if (SEAL_REVIEW_VALUES.includes(sealStatus)) {
    alerts.push(createAlert(equipmentId, 'Peddler Delivery', 'seal', 'review',
      `Seal not Intact (${delivery.sealStatus}). Reconciliation and handling review required.`,
      { sealStatus: delivery.sealStatus, tripId: delivery.tripId }, timestamp));
  }

  return alerts;
}

// Readings are stored newest-first, so readings[0] is the latest.
function detectTrends(equipment, settings) {
  const trends = [];
  const readings = (equipment && equipment.readings) || [];
  if (readings.length < 3) return trends;

  const recent = readings.slice(0, 3);
  const older = recent[2];
  const middle = recent[1];
  const latest = recent[0];

  const filterDp = [older.filterDp, middle.filterDp, latest.filterDp];
  if (filterDp.every(v => typeof v === 'number') &&
      filterDp[2] > filterDp[1] && filterDp[1] > filterDp[0]) {
    trends.push(createAlert(equipment.id, equipment.type, 'trend-filter', 'warning',
      `Rising filter dP trend detected over last 3 readings (${filterDp.join(' -> ')} bar)`,
      { values: filterDp }, latest.timestamp));
  }

  const flow = [older.flowRate, middle.flowRate, latest.flowRate];
  if (flow.every(v => typeof v === 'number') &&
      flow[2] < flow[1] && flow[1] < flow[0]) {
    trends.push(createAlert(equipment.id, equipment.type, 'trend-flow', 'warning',
      `Declining flow trend detected over last 3 readings (${flow.join(' -> ')} L/min)`,
      { values: flow }, latest.timestamp));
  }

  return trends;
}

// Counts how many times each fault category has occurred for an equipment.
// Categories 'recurring-*' and 'trend-*' are meta-alerts and are ignored.
function findRecurringCategories(data, equipmentId, threshold = 3) {
  const counts = {};
  for (const alert of (data.alerts || [])) {
    if (alert.equipmentId !== equipmentId) continue;
    const category = alert.category || '';
    if (category.startsWith('recurring') || category.startsWith('trend')) continue;
    counts[category] = (counts[category] || 0) + 1;
  }
  return Object.entries(counts)
    .filter(([, count]) => count >= threshold)
    .map(([category, count]) => ({ category, count }));
}

function buildRecurringAlerts(data, threshold = 3) {
  const out = [];
  for (const equipment of (data.equipment || [])) {
    const recurring = findRecurringCategories(data, equipment.id, threshold);
    for (const item of recurring) {
      out.push(createAlert(equipment.id, equipment.type, `recurring-${item.category}`, 'warning',
        `Recurring issue detected: ${item.category} (${item.count} recorded alerts)`,
        { category: item.category, count: item.count }, new Date().toISOString()));
      }
  }
  return out;
}

// Evaluate everything from scratch. Kept for full re-evaluation scenarios.
function evaluateAll(data) {
  const alerts = [];
  const settings = data.settings || THRESHOLD_DEFAULTS;

  for (const equipment of (data.equipment || [])) {
    if (equipment.latest) {
      alerts.push(...evaluateEquipmentReading(equipment.latest, settings));
      alerts.push(...detectTrends(equipment, settings));
    }
  }

  for (const delivery of (data.deliveries || [])) {
    alerts.push(...evaluateDelivery(delivery, settings));
  }

  alerts.push(...buildRecurringAlerts(data));

  return alerts;
}

// Determine an equipment health status from its open alerts.
function getEquipmentHealth(equipmentId, alerts) {
  const open = (alerts || []).filter(a => a.equipmentId === equipmentId && a.status === 'Open');
  if (open.some(a => a.severity === 'critical')) return 'critical';
  if (open.some(a => a.category && a.category.startsWith('recurring'))) return 'warning';
  if (open.some(a => a.severity === 'warning')) return 'warning';
  if (open.some(a => a.severity === 'review')) return 'review';
  return 'healthy';
}

module.exports = {
  evaluateEquipmentReading,
  evaluateDelivery,
  evaluateAll,
  detectTrends,
  findRecurringCategories,
  buildRecurringAlerts,
  getEquipmentHealth,
  getSeverityLabel,
  SEVERITY_LABELS,
  THRESHOLD_DEFAULTS,
  WATER_CRITICAL_VALUES,
  INTERLOCK_CRITICAL_VALUES,
  SEAL_REVIEW_VALUES
};
