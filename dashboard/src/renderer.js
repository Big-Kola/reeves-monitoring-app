// FuelOps Monitor - renderer (UI logic)
//
// Pure vanilla JS single-page app. All privileged work happens in the main
// process; this file only talks to it through window.fuelops (see preload.js).

const api = window.fuelops;

const state = {
  page: 'dashboard',
  equipmentList: [],
  settings: null,
  monitoring: true,
  alertCount: 0
};

let settingsStatusTimer = null;

const PAGE_META = {
  dashboard: ['Dashboard', 'Live operational overview'],
  equipment: ['Equipment', 'Asset health and latest readings'],
  deliveries: ['Deliveries', 'Trip reconciliation and variance'],
  maintenance: ['Maintenance', 'Faults, downtime and service history'],
  alerts: ['Alerts', 'Open, investigating and resolved alerts'],
  history: ['History', 'Search, filter and export records'],
  settings: ['Settings', 'Monitoring thresholds (demonstration values)']
};

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function pageEl(name) {
  return document.getElementById(`page-${name}`);
}

function tag(text, cls) {
  return el('span', `tag ${cls}`, text);
}

const SEVERITY_CLASS = { warning: 'tag-amber', critical: 'tag-red', review: 'tag-review', info: 'tag-blue' };
const SEVERITY_LABEL = { warning: 'Needs Attention', critical: 'Critical', review: 'Review Required', info: 'Information' };

function severityTag(severity) {
  return tag(SEVERITY_LABEL[severity] || severity, SEVERITY_CLASS[severity] || 'tag-muted');
}

function healthTag(health) {
  const map = {
    healthy: ['Healthy', 'tag-green'],
    warning: ['Needs Attention', 'tag-amber'],
    critical: ['Critical', 'tag-red'],
    review: ['Review Required', 'tag-review']
  };
  const [label, cls] = map[health] || ['Unknown', 'tag-muted'];
  return tag(label, cls);
}

function statusTag(status) {
  const map = {
    OK: 'tag-green',
    Open: 'tag-red',
    Investigating: 'tag-amber',
    Resolved: 'tag-green',
    'Review Required': 'tag-review'
  };
  return tag(status, map[status] || 'tag-muted');
}

function tr(cells, className) {
  const row = el('tr', className || '');
  cells.forEach(cell => {
    if (cell instanceof Node) {
      row.append(cell);
    } else {
      row.append(el('td', null, cell === null || cell === undefined ? '—' : String(cell)));
    }
  });
  return row;
}

function table(headers, rows) {
  const wrap = el('div', 'table-wrap');
  const t = el('table');
  const thead = el('thead');
  const headRow = el('tr');
  headers.forEach(h => headRow.append(el('th', null, h)));
  thead.append(headRow);
  t.append(thead);

  const tbody = el('tbody');
  if (!rows.length) {
    const r = el('tr');
    const td = el('td', 'empty-row', 'No records');
    td.colSpan = headers.length;
    r.append(td);
    tbody.append(r);
  } else {
    rows.forEach(r => tbody.append(r));
  }
  t.append(tbody);
  wrap.append(t);
  return wrap;
}

function panel(title, rightNode) {
  const p = el('div', 'panel');
  const head = el('div', 'panel-head');
  head.append(el('h2', null, title));
  if (rightNode) head.append(rightNode);
  p.append(head);
  return p;
}

function fmtNum(value, digits = 0) {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString();
}

function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString();
}

function nowStamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
}

function openModal({ title, body, footer, wide }) {
  const root = document.getElementById('modal-root');
  root.innerHTML = '';
  const overlay = el('div', 'modal-overlay');
  const modal = el('div', `modal${wide ? ' wide' : ''}`);

  const head = el('div', 'modal-head');
  head.append(el('h2', null, title));
  const close = el('button', 'close', '\u00d7');
  close.onclick = closeModal;
  head.append(close);

  const bodyEl = el('div', 'modal-body');
  if (body) bodyEl.append(body);

  modal.append(head, bodyEl);
  if (footer && footer.length) {
    const foot = el('div', 'modal-foot');
    footer.forEach(b => foot.append(b));
    modal.append(foot);
  }
  overlay.append(modal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  root.append(overlay);
  return { body: bodyEl };
}

function field(label, control, hint) {
  const f = el('div', 'field');
  f.append(el('label', null, label));
  f.append(control);
  if (hint) f.append(el('span', 'hint', hint));
  return f;
}

function input(type, value, placeholder) {
  const i = el('input');
  i.type = type;
  if (value !== undefined && value !== null) i.value = value;
  if (placeholder) i.placeholder = placeholder;
  return i;
}

function textarea(value, placeholder) {
  const t = el('textarea');
  t.rows = 3;
  if (value) t.value = value;
  if (placeholder) t.placeholder = placeholder;
  return t;
}

function select(options, value) {
  const s = el('select');
  options.forEach(opt => {
    const o = el('option', null, opt);
    o.value = opt;
    if (opt === value) o.selected = true;
    s.append(o);
  });
  return s;
}

// ---------------------------------------------------------------------------
// Toasts / notifications
// ---------------------------------------------------------------------------

function toast(severity, title, body) {
  const area = document.getElementById('notification-area');
  const t = el('div', `toast ${severity || ''}`);
  t.append(el('div', 't-title', title));
  if (body) t.append(el('div', 't-body', body));
  area.append(t);
  setTimeout(() => {
    t.style.transition = 'opacity 0.4s ease';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 400);
  }, 6500);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const RENDERERS = {
  dashboard: renderDashboard,
  equipment: renderEquipment,
  deliveries: renderDeliveries,
  maintenance: renderMaintenance,
  alerts: renderAlerts,
  history: renderHistory,
  settings: renderSettings
};

function navigate(pageName) {
  if (settingsStatusTimer) {
    clearInterval(settingsStatusTimer);
    settingsStatusTimer = null;
  }
  state.page = pageName;
  const [title, subtitle] = PAGE_META[pageName] || ['FuelOps', ''];
  document.getElementById('page-title').textContent = title;
  document.getElementById('page-subtitle').textContent = subtitle;

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.page === pageName);
  });
  document.querySelectorAll('.page').forEach(p => {
    p.classList.toggle('active', p.id === `page-${pageName}`);
  });

  refreshCurrentPage();
}

async function refreshCurrentPage() {
  const renderer = RENDERERS[state.page];
  if (!renderer) return;
  try {
    await renderer();
  } catch (err) {
    console.error('Render error:', err);
    const root = pageEl(state.page);
    root.innerHTML = '';
    root.append(el('div', 'panel', `Unable to load page: ${err.message}`));
  }
}

function setLastUpdated() {
  document.getElementById('last-updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

async function updateAlertBadge() {
  try {
    const alerts = await api.getAlerts();
    state.alertCount = alerts.filter(a => a.status === 'Open').length;
    const badge = document.getElementById('nav-alert-count');
    badge.textContent = state.alertCount;
    badge.classList.toggle('zero', state.alertCount === 0);
  } catch (err) {
    // non-fatal
  }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

async function renderDashboard() {
  const data = await api.getDashboardData();
  state.settings = data.settings;
  const root = pageEl('dashboard');
  root.innerHTML = '';
  const s = data.stats;

  const cards = [
    ['Total Equipment', s.totalEquipment, ''],
    ['Healthy', s.healthy, 'green'],
    ['Needs Attention', s.needsAttention, 'amber'],
    ['Critical', s.critical, 'red'],
    ['Open Alerts', s.openAlerts, s.openAlerts > 0 ? 'red' : ''],
    ["Today's Deliveries", s.todaysDeliveries, ''],
    ['Total Litres Loaded', fmtNum(s.totalLoaded), ''],
    ['Total Litres Received', fmtNum(s.totalReceived), ''],
    ['Recorded Variance', `${s.totalVariance}%`, s.totalVariance > (data.settings.deliveryVarianceThreshold || 0.5) ? 'review' : ''],
    ['Maintenance Due', s.maintenanceDue, s.maintenanceDue > 0 ? 'amber' : '']
  ];

  const grid = el('div', 'stats-grid');
  cards.forEach(([label, value, cls]) => {
    const c = el('div', `stat-card ${cls}`);
    c.append(el('div', 'label', label));
    c.append(el('div', `value ${cls}`, String(value)));
    grid.append(c);
  });
  root.append(grid);

  const twoCol = el('div', 'grid-2');

  // Equipment health summary
  const healthPanel = panel('Equipment Health Summary', el('span', 'muted', `${data.equipment.length} asset(s)`));
  if (!data.equipment.length) {
    healthPanel.append(el('p', 'hint-text', 'No equipment data yet. Add readings manually or save rows in data/Bowser_Readings.xlsx.'));
  } else {
    const rows = data.equipment.map(eq => {
      const latest = eq.latest || {};
      return tr([
        eq.id,
        eq.type || '—',
        healthTag(eq.health),
        latest.flowRate === null || latest.flowRate === undefined ? '—' : `${fmtNum(latest.flowRate)} L/min`
      ]);
    });
    healthPanel.append(table(['Equipment', 'Type', 'Health', 'Latest Flow'], rows));
  }
  twoCol.append(healthPanel);

  // Recent alerts
  const alertPanel = panel('Recent Alerts', el('span', 'muted', `${s.openAlerts} open`));
  if (!data.recentAlerts.length) {
    alertPanel.append(el('p', 'hint-text', 'No alerts recorded.'));
  } else {
    data.recentAlerts.forEach(a => alertPanel.append(alertRow(a)));
  }
  twoCol.append(alertPanel);

  root.append(twoCol);

  const twoCol2 = el('div', 'grid-2');

  // Recent deliveries
  const delPanel = panel("Recent Deliveries", el('span', 'muted', `${data.recentDeliveries.length} shown`));
  if (!data.recentDeliveries.length) {
    delPanel.append(el('p', 'hint-text', 'No deliveries recorded.'));
  } else {
    const rows = data.recentDeliveries.map(d => tr([
      d.tripId,
      d.equipmentId,
      `${fmtNum(d.varianceLitres)} L`,
      d.variancePercent === null || d.variancePercent === undefined ? '—' : `${fmtNum(d.variancePercent, 2)}%`,
      sealTag(d.sealStatus)
    ]));
    delPanel.append(table(['Trip', 'Equipment', 'Variance', 'Variance %', 'Seal'], rows));
  }
  twoCol2.append(delPanel);

  // Maintenance due soon
  const maintPanel = panel('Maintenance Due Soon', el('span', 'muted', `${data.maintenanceDue.length} asset(s)`));
  if (!data.maintenanceDue.length) {
    maintPanel.append(el('p', 'hint-text', 'No services due within the warning window.'));
  } else {
    const rows = data.maintenanceDue.map(m => tr([
      m.id,
      m.type || '—',
      `${m.daysUntilService} day(s)`,
      m.daysUntilService <= 0 ? tag('Overdue', 'tag-red') : tag('Due soon', 'tag-amber')
    ]));
    maintPanel.append(table(['Equipment', 'Type', 'Days Until Service', 'Status'], rows));
  }
  twoCol2.append(maintPanel);

  root.append(twoCol2);
  setLastUpdated();
  updateAlertBadge();
}

function sealTag(seal) {
  const s = (seal || '').toLowerCase();
  return s === 'intact' ? tag(seal, 'tag-green') : tag(seal || '—', 'tag-review');
}

function alertRow(a) {
  const row = el('div', `alert-row ${a.severity || ''}`);
  const main = el('div', 'a-main');
  const head = el('div', 'a-head');
  head.append(el('span', 'a-eq', a.equipmentId || a.details?.tripId || 'Alert'));
  head.append(severityTag(a.severity));
  if (a.status && a.status !== 'Open') head.append(statusTag(a.status));
  main.append(head);
  main.append(el('div', 'a-msg', a.message));
  main.append(el('div', 'a-time', fmtDateTime(a.timestamp)));
  row.append(main);
  return row;
}

// ---------------------------------------------------------------------------
// Equipment
// ---------------------------------------------------------------------------

async function renderEquipment() {
  const [list, settings] = await Promise.all([api.getEquipment(), api.getSettings()]);
  state.equipmentList = list;
  state.settings = settings;

  const root = pageEl('equipment');
  root.innerHTML = '';

  const bar = el('div', 'flex-between');
  bar.style.marginBottom = '16px';
  const title = el('h2', null, `${list.length} asset(s)`);
  title.style.fontSize = '1rem';
  bar.append(title);

  const actions = el('div', 'gap-1');
  const addBtn = el('button', 'btn btn-primary', '+ Add Reading');
  addBtn.onclick = openReadingForm;
  actions.append(addBtn);
  bar.append(actions);
  root.append(bar);

  if (!list.length) {
    const p = el('div', 'panel');
    p.append(el('p', 'hint-text', 'No equipment yet. Click "Add Reading" or add a row to data/Bowser_Readings.xlsx.'));
    root.append(p);
    return;
  }

  const grid = el('div', 'equipment-grid');
  list.forEach(eq => grid.append(equipmentCard(eq, settings)));
  root.append(grid);
}

function equipmentCard(eq, settings) {
  const latest = eq.latest || {};
  const card = el('div', 'equipment-card');
  card.onclick = () => openEquipmentDetail(eq.id);

  const head = el('div', 'eq-head');
  const left = el('div');
  left.append(el('div', 'eq-id', eq.id));
  left.append(el('div', 'eq-type', eq.type || '—'));
  head.append(left);
  head.append(healthTag(eq.health));
  card.append(head);

  const metrics = el('div', 'eq-metrics');
  const metric = (k, v, cls) => {
    const m = el('div', 'eq-metric');
    m.append(el('span', 'k', k));
    m.append(el('span', `v ${cls || ''}`, v));
    metrics.append(m);
  };

  const flow = latest.flowRate;
  const flowCls = typeof flow === 'number' && flow < settings.minimumFlow ? 'bad' : '';
  metric('Flow', flow === null || flow === undefined ? '—' : `${fmtNum(flow)} L/min`, flowCls);

  const pressure = latest.pressure;
  const pressureCls = typeof pressure === 'number' &&
    (pressure < settings.minimumPressure || pressure > settings.maximumPressure) ? 'bad' : '';
  metric('Pressure', pressure === null || pressure === undefined ? '—' : `${pressure} bar`, pressureCls);

  const dp = latest.filterDp;
  const dpCls = typeof dp === 'number' && dp > settings.maximumFilterDp ? 'bad' : '';
  metric('Filter dP', dp === null || dp === undefined ? '—' : `${dp} bar`, dpCls);

  const water = (latest.water || '').toString().toLowerCase();
  const waterCls = water && water !== 'clear' ? 'crit' : '';
  metric('Water', latest.water || '—', waterCls);

  const interlock = (latest.interlock || '').toString().toLowerCase();
  const interlockCls = ['fail', 'failed', 'fault', 'error'].some(v => interlock.includes(v)) ? 'crit' : '';
  metric('Interlock', latest.interlock || '—', interlockCls);

  metric('Op. Hours', latest.operatingHours === null || latest.operatingHours === undefined ? '—' : fmtNum(latest.operatingHours));
  metric('Days to Service', latest.daysUntilService === null || latest.daysUntilService === undefined ? '—' : String(latest.daysUntilService),
    typeof latest.daysUntilService === 'number' && latest.daysUntilService <= settings.serviceWarningDays ? 'bad' : '');

  card.append(metrics);
  return card;
}

async function openEquipmentDetail(id) {
  const detail = await api.getEquipmentDetail(id);
  if (!detail) { toast('critical', 'Not found', `Equipment ${id} was not found.`); return; }

  const body = el('div');
  const latest = detail.latest || {};

  const metrics = el('div', 'detail-grid');
  const dm = (k, v, cls) => {
    const m = el('div', 'detail-metric');
    m.append(el('div', 'k', k));
    m.append(el('div', `v ${cls || ''}`, v));
    metrics.append(m);
  };
  const healthMetric = el('div', 'detail-metric');
  healthMetric.append(el('div', 'k', 'Health'));
  const hv = el('div', 'v');
  hv.append(healthTag(detail.health));
  healthMetric.append(hv);
  metrics.append(healthMetric);

  dm('Flow', latest.flowRate === null || latest.flowRate === undefined ? '—' : `${fmtNum(latest.flowRate)} L/min`);
  dm('Pressure', latest.pressure === null || latest.pressure === undefined ? '—' : `${latest.pressure} bar`);
  dm('Filter dP', latest.filterDp === null || latest.filterDp === undefined ? '—' : `${latest.filterDp} bar`);
  dm('Water', latest.water || '—');
  dm('Interlock', latest.interlock || '—');
  dm('Op. Hours', latest.operatingHours === null || latest.operatingHours === undefined ? '—' : fmtNum(latest.operatingHours));
  dm('Days to Service', latest.daysUntilService === null || latest.daysUntilService === undefined ? '—' : String(latest.daysUntilService));
  body.append(metrics);

  // Trend warnings
  body.append(el('div', 'section-title', 'Trend warnings'));
  if (!detail.trends.length) {
    body.append(el('p', 'hint-text', 'No trend warnings.'));
  } else {
    const list = el('div', 'trend-list');
    detail.trends.forEach(t => list.append(el('div', 'trend-item', t.message)));
    body.append(list);
  }

  // Recurring issues
  body.append(el('div', 'section-title', 'Recurring issues'));
  if (!detail.recurring.length) {
    body.append(el('p', 'hint-text', 'No recurring issues.'));
  } else {
    const list = el('div', 'trend-list');
    detail.recurring.forEach(r => list.append(el('div', 'trend-item', `${r.category}: ${r.count} recorded alerts`)));
    body.append(list);
  }

  // Alerts
  body.append(el('div', 'section-title', `Alerts (${detail.alerts.length})`));
  if (!detail.alerts.length) {
    body.append(el('p', 'hint-text', 'No alerts for this asset.'));
  } else {
    detail.alerts.slice(0, 12).forEach(a => body.append(alertRow(a)));
  }

  // Maintenance history
  body.append(el('div', 'section-title', `Maintenance history (${detail.maintenance.length})`));
  if (!detail.maintenance.length) {
    body.append(el('p', 'hint-text', 'No maintenance records.'));
  } else {
    const rows = detail.maintenance.map(m => tr([
      fmtDate(m.date), m.faultCategory || '—', m.faultDescription || '—',
      m.status || '—', m.actionTaken || '—'
    ]));
    body.append(table(['Date', 'Category', 'Fault', 'Status', 'Action'], rows));
  }

  // Readings history
  body.append(el('div', 'section-title', `Latest readings (${detail.readings.length})`));
  const readingRows = detail.readings.slice(0, 20).map(r => tr([
    fmtDateTime(r.timestamp),
    r.flowRate === null || r.flowRate === undefined ? '—' : fmtNum(r.flowRate),
    r.pressure === null || r.pressure === undefined ? '—' : r.pressure,
    r.filterDp === null || r.filterDp === undefined ? '—' : r.filterDp,
    r.water || '—',
    r.interlock || '—'
  ]));
  body.append(table(['Timestamp', 'Flow (L/min)', 'Pressure (bar)', 'Filter dP (bar)', 'Water', 'Interlock'], readingRows));

  openModal({
    title: `${detail.id} — ${detail.type || 'Equipment'}`,
    body,
    wide: true,
    footer: [(() => { const b = el('button', 'btn', 'Close'); b.onclick = closeModal; return b; })()]
  });
}

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

async function renderDeliveries() {
  const [deliveries, settings] = await Promise.all([api.getDeliveries(), api.getSettings()]);
  state.settings = settings;

  const root = pageEl('deliveries');
  root.innerHTML = '';

  const bar = el('div', 'flex-between');
  bar.style.marginBottom = '16px';
  const title = el('h2', null, `${deliveries.length} delivery record(s)`);
  title.style.fontSize = '1rem';
  bar.append(title);
  const addBtn = el('button', 'btn btn-primary', '+ Add Delivery');
  addBtn.onclick = openDeliveryForm;
  bar.append(addBtn);
  root.append(bar);

  const rows = deliveries.map(d => {
    const abnormal = d.status !== 'OK';
    return tr([
      d.tripId || '—',
      fmtDateTime(d.timestamp),
      d.equipmentId || '—',
      d.transporter || '—',
      d.route || '—',
      fmtNum(d.quantityLoaded),
      fmtNum(d.quantityReceived),
      fmtNum(d.varianceLitres),
      d.variancePercent === null || d.variancePercent === undefined ? '—' : `${fmtNum(d.variancePercent, 2)}%`,
      sealTag(d.sealStatus),
      d.transitDelay === null || d.transitDelay === undefined ? '—' : `${d.transitDelay} h`,
      statusTag(d.status)
    ], abnormal ? 'abnormal' : '');
  });

  root.append(table(
    ['Trip ID', 'Date', 'Equipment', 'Transporter', 'Route', 'Loaded', 'Received', 'Variance L', 'Variance %', 'Seal', 'Delay', 'Status'],
    rows
  ));
}

function openDeliveryForm() {
  const form = el('div', 'form-grid');
  const f = {
    timestamp: input('text', nowStamp()),
    tripId: input('text', `TRP-${Date.now().toString().slice(-5)}`),
    equipmentId: input('text', ''),
    transporter: input('text', ''),
    truckNumber: input('text', ''),
    driver: input('text', ''),
    route: input('text', ''),
    loaded: input('number', '20000'),
    received: input('number', ''),
    seal: select(['Intact', 'Broken', 'Damaged', 'Missing', 'Tampered', 'Open'], 'Intact'),
    delay: input('number', '0'),
    notes: textarea('')
  };
  form.append(
    field('Timestamp', f.timestamp, 'YYYY-MM-DD HH:MM'),
    field('Trip ID', f.tripId),
    field('Equipment / Peddler', f.equipmentId),
    field('Transporter', f.transporter),
    field('Truck Number', f.truckNumber),
    field('Driver', f.driver),
    field('Route', f.route),
    field('Quantity Loaded (L)', f.loaded),
    field('Quantity Received (L)', f.received),
    field('Seal Status', f.seal),
    field('Transit Delay (hrs)', f.delay),
    field('Notes', f.notes)
  );

  const save = el('button', 'btn btn-primary', 'Save Delivery');
  save.onclick = async () => {
    if (!f.tripId.value.trim()) { toast('warning', 'Missing Trip ID', 'A Trip ID is required.'); return; }
    const payload = {
      Timestamp: f.timestamp.value.trim() || nowStamp(),
      'Trip ID': f.tripId.value.trim(),
      'Equipment ID': f.equipmentId.value.trim(),
      Transporter: f.transporter.value.trim(),
      'Truck Number': f.truckNumber.value.trim(),
      Driver: f.driver.value.trim(),
      Route: f.route.value.trim(),
      'Quantity Loaded L': f.loaded.value,
      'Quantity Received L': f.received.value,
      'Seal Status': f.seal.value,
      'Transit Delay Hrs': f.delay.value,
      Notes: f.notes.value.trim()
    };
    const res = await api.addManualDelivery(payload);
    if (res.ok) {
      closeModal();
      toast('info', 'Delivery saved', `${res.imported} record(s) imported, ${res.alerts} alert(s) raised.`);
      refreshCurrentPage();
    } else {
      toast('critical', 'Save failed', res.error || 'Unknown error');
    }
  };

  const cancel = el('button', 'btn btn-ghost', 'Cancel');
  cancel.onclick = closeModal;

  openModal({ title: 'Add Delivery (manual entry)', body: form, footer: [cancel, save] });
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

async function renderMaintenance() {
  const records = await api.getMaintenance();
  const root = pageEl('maintenance');
  root.innerHTML = '';

  const bar = el('div', 'flex-between');
  bar.style.marginBottom = '16px';
  const title = el('h2', null, `${records.length} maintenance record(s)`);
  title.style.fontSize = '1rem';
  bar.append(title);
  const addBtn = el('button', 'btn btn-primary', '+ Add Maintenance');
  addBtn.onclick = openMaintenanceForm;
  bar.append(addBtn);
  root.append(bar);

  const rows = records.map(m => tr([
    m.equipmentId || '—',
    m.faultCategory || '—',
    m.faultDescription || '—',
    m.downtimeHours === null || m.downtimeHours === undefined ? '—' : `${m.downtimeHours} h`,
    m.actionTaken || '—',
    statusTag(m.status || 'Open'),
    fmtDate(m.nextServiceDate),
    m.recurring ? tag('Recurring', 'tag-amber') : tag('—', 'tag-muted')
  ], m.recurring ? 'abnormal' : ''));

  root.append(table(
    ['Equipment', 'Fault Category', 'Fault Description', 'Downtime', 'Action Taken', 'Status', 'Next Service', 'Recurring'],
    rows
  ));
}

function openMaintenanceForm() {
  const form = el('div', 'form-grid');
  const today = new Date().toISOString().slice(0, 10);
  const f = {
    date: input('date', today),
    equipmentId: input('text', ''),
    equipmentType: input('text', ''),
    category: select(['Filter', 'Flow', 'Pressure', 'Water', 'Interlock', 'Seal', 'Electrical', 'Mechanical', 'Other'], 'Filter'),
    description: input('text', ''),
    downtime: input('number', '0'),
    action: input('text', ''),
    technician: input('text', ''),
    status: select(['Open', 'Investigating', 'Resolved'], 'Open'),
    nextService: input('date', ''),
    notes: textarea('')
  };
  form.append(
    field('Date', f.date),
    field('Equipment ID', f.equipmentId),
    field('Equipment Type', f.equipmentType),
    field('Fault Category', f.category),
    field('Fault Description', f.description),
    field('Downtime Hours', f.downtime),
    field('Action Taken', f.action),
    field('Technician', f.technician),
    field('Status', f.status),
    field('Next Service Date', f.nextService),
    field('Notes', f.notes)
  );

  const save = el('button', 'btn btn-primary', 'Save Maintenance');
  save.onclick = async () => {
    if (!f.equipmentId.value.trim()) { toast('warning', 'Missing Equipment', 'An Equipment ID is required.'); return; }
    const payload = {
      Date: f.date.value || today,
      'Equipment ID': f.equipmentId.value.trim(),
      'Equipment Type': f.equipmentType.value.trim(),
      'Fault Category': f.category.value,
      'Fault Description': f.description.value.trim(),
      'Downtime Hours': f.downtime.value,
      'Action Taken': f.action.value.trim(),
      Technician: f.technician.value.trim(),
      Status: f.status.value,
      'Next Service Date': f.nextService.value,
      Notes: f.notes.value.trim()
    };
    const res = await api.addMaintenance(payload);
    if (res.ok) {
      closeModal();
      toast('info', 'Maintenance saved', `${res.imported} record(s) imported.`);
      refreshCurrentPage();
    } else {
      toast('critical', 'Save failed', res.error || 'Unknown error');
    }
  };

  const cancel = el('button', 'btn btn-ghost', 'Cancel');
  cancel.onclick = closeModal;
  openModal({ title: 'Add Maintenance (manual entry)', body: form, footer: [cancel, save] });
}

// ---------------------------------------------------------------------------
// Reading form (manual equipment entry)
// ---------------------------------------------------------------------------

function openReadingForm() {
  const form = el('div', 'form-grid');
  const f = {
    timestamp: input('text', nowStamp()),
    equipmentId: input('text', ''),
    equipmentType: select(['Aviation Bowser', 'Diesel Peddler', 'Fuel Truck', 'Other'], 'Aviation Bowser'),
    flow: input('number', ''),
    pressure: input('number', ''),
    filterDp: input('number', ''),
    water: select(['Clear', 'Detected', 'Alarm', 'Fail'], 'Clear'),
    interlock: select(['Pass', 'Fail', 'Fault', 'Error'], 'Pass'),
    hours: input('number', ''),
    daysService: input('number', ''),
    notes: textarea('')
  };
  form.append(
    field('Timestamp', f.timestamp, 'YYYY-MM-DD HH:MM'),
    field('Equipment ID', f.equipmentId),
    field('Equipment Type', f.equipmentType),
    field('Flow Rate (L/min)', f.flow),
    field('Delivery Pressure (bar)', f.pressure),
    field('Filter dP (bar)', f.filterDp),
    field('Water Check', f.water),
    field('Interlock Status', f.interlock),
    field('Operating Hours', f.hours),
    field('Days Until Service', f.daysService),
    field('Notes', f.notes)
  );

  const save = el('button', 'btn btn-primary', 'Save Reading');
  save.onclick = async () => {
    if (!f.equipmentId.value.trim()) { toast('warning', 'Missing Equipment', 'An Equipment ID is required.'); return; }
    const payload = {
      Timestamp: f.timestamp.value.trim() || nowStamp(),
      'Equipment ID': f.equipmentId.value.trim(),
      'Equipment Type': f.equipmentType.value,
      'Flow Rate L/min': f.flow.value,
      'Delivery Pressure bar': f.pressure.value,
      'Filter dP bar': f.filterDp.value,
      'Water Check': f.water.value,
      'Interlock Status': f.interlock.value,
      'Operating Hours': f.hours.value,
      'Days Until Service': f.daysService.value,
      Notes: f.notes.value.trim()
    };
    const res = await api.addManualReading(payload);
    if (res.ok) {
      closeModal();
      toast('info', 'Reading saved', `${res.imported} record(s) imported, ${res.alerts} alert(s) raised.`);
      refreshCurrentPage();
    } else {
      toast('critical', 'Save failed', res.error || 'Unknown error');
    }
  };

  const cancel = el('button', 'btn btn-ghost', 'Cancel');
  cancel.onclick = closeModal;
  openModal({ title: 'Add Equipment Reading (manual entry)', body: form, footer: [cancel, save], wide: true });
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

async function renderAlerts() {
  const [alerts, settings] = await Promise.all([api.getAlerts(), api.getSettings()]);
  state.settings = settings;
  state.alertCount = alerts.filter(a => a.status === 'Open').length;

  const root = pageEl('alerts');
  root.innerHTML = '';

  // Status filter
  const bar = el('div', 'filter-bar');
  const statusOptions = ['All', 'Open', 'Investigating', 'Resolved'];
  const statusSelect = select(statusOptions, renderAlerts.currentFilter || 'All');
  renderAlerts.currentFilter = renderAlerts.currentFilter || 'All';
  statusSelect.onchange = () => {
    renderAlerts.currentFilter = statusSelect.value;
    renderAlerts();
  };
  bar.append(field('Status', statusSelect));
  root.append(bar);

  const filter = renderAlerts.currentFilter;
  const filtered = filter === 'All' ? alerts : alerts.filter(a => a.status === filter);

  const openCount = alerts.filter(a => a.status === 'Open').length;
  const info = panel(`Alerts (${filtered.length})`, el('span', 'muted', `${openCount} open`));

  if (!filtered.length) {
    info.append(el('p', 'hint-text', 'No alerts match this filter.'));
  } else {
    filtered.forEach(a => info.append(alertRowWithActions(a)));
  }
  root.append(info);
  updateAlertBadge();
}

function alertRowWithActions(a) {
  const row = el('div', `alert-row ${a.severity || ''}`);
  const main = el('div', 'a-main');
  const head = el('div', 'a-head');
  head.append(el('span', 'a-eq', a.equipmentId || a.details?.tripId || 'Alert'));
  head.append(severityTag(a.severity));
  head.append(statusTag(a.status));
  main.append(head);
  main.append(el('div', 'a-msg', a.message));
  main.append(el('div', 'a-time', `${fmtDateTime(a.timestamp)} · ${a.category || ''}`));
  if (a.resolution) {
    main.append(el('div', 'a-time', `Resolution: ${a.resolution.actionTaken || ''} ${a.resolution.rootCause ? `· Cause: ${a.resolution.rootCause}` : ''}`));
  }
  row.append(main);

  if (a.status === 'Resolved') return row;

  const actions = el('div');
  actions.style.display = 'flex';
  actions.style.flexDirection = 'column';
  actions.style.gap = '6px';

  const resolveBtn = el('button', 'btn btn-sm btn-primary', 'Resolve');
  resolveBtn.onclick = (e) => { e.stopPropagation(); openResolveForm(a); };
  actions.append(resolveBtn);

  if (a.status === 'Open') {
    const investigating = el('button', 'btn btn-sm', 'Investigating');
    investigating.onclick = async (e) => {
      e.stopPropagation();
      await api.updateAlertStatus(a.id, 'Investigating');
      refreshCurrentPage();
      updateAlertBadge();
    };
    actions.append(investigating);
  }

  row.append(actions);
  return row;
}

function openResolveForm(alert) {
  const form = el('div', 'form-grid');
  const rootCause = input('text', '');
  const action = input('text', '');
  const notes = textarea('');
  form.append(
    field('Root Cause', rootCause, 'e.g. Blocked filter element'),
    field('Action Taken', action, 'e.g. Filter replaced and dP re-tested'),
    field('Resolution Notes', notes)
  );

  const save = el('button', 'btn btn-primary', 'Mark Resolved');
  save.onclick = async () => {
    const res = await api.resolveAlert(alert.id, {
      rootCause: rootCause.value.trim(),
      actionTaken: action.value.trim(),
      notes: notes.value.trim()
    });
    if (res.ok) {
      closeModal();
      toast('info', 'Alert resolved', alert.equipmentId || '');
      refreshCurrentPage();
      updateAlertBadge();
    } else {
      toast('critical', 'Resolve failed', 'Alert not found.');
    }
  };
  const cancel = el('button', 'btn btn-ghost', 'Cancel');
  cancel.onclick = closeModal;

  const body = el('div');
  body.append(el('p', 'hint-text', alert.message));
  body.append(el('div', 'mt-1'));
  body.append(form);
  openModal({ title: `Resolve Alert — ${alert.equipmentId || ''}`, body, footer: [cancel, save] });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const HISTORY_COLUMNS = {
  all: ['Type', 'Timestamp', 'Equipment/Trip', 'Details', 'Status'],
  reading: ['Timestamp', 'Equipment', 'Flow (L/min)', 'Pressure (bar)', 'Filter dP (bar)', 'Water', 'Interlock'],
  delivery: ['Timestamp', 'Trip ID', 'Equipment', 'Transporter', 'Loaded', 'Received', 'Variance L', 'Variance %', 'Seal', 'Status'],
  maintenance: ['Timestamp', 'Equipment', 'Fault Category', 'Fault Description', 'Downtime', 'Action Taken', 'Status'],
  alert: ['Timestamp', 'Equipment/Trip', 'Category', 'Severity', 'Message', 'Status']
};

async function renderHistory() {
  const [equipmentList, settings] = await Promise.all([api.getEquipmentList(), api.getSettings()]);
  state.settings = settings;

  const root = pageEl('history');
  root.innerHTML = '';

  const filters = renderHistory.filters || (renderHistory.filters = {
    type: 'all', equipment: 'all', transporter: 'all', status: 'all', severity: 'all', from: '', to: ''
  });

  const bar = el('div', 'filter-bar');
  const typeSel = select(['all', 'reading', 'delivery', 'maintenance', 'alert'], filters.type);
  const eqSel = select(['all', ...equipmentList.map(e => e.id)], filters.equipment);
  const transporterSel = select(['all'], filters.transporter);
  const statusSel = select(['all', 'Open', 'Investigating', 'Resolved', 'OK'], filters.status);
  const severitySel = select(['all', 'warning', 'critical', 'review'], filters.severity);
  const fromInput = input('date', filters.from);
  const toInput = input('date', filters.to);

  const applyFilters = () => {
    renderHistory.filters = {
      type: typeSel.value,
      equipment: eqSel.value,
      transporter: transporterSel.value,
      status: statusSel.value,
      severity: severitySel.value,
      from: fromInput.value,
      to: toInput.value
    };
    renderHistory();
  };

  [typeSel, eqSel, transporterSel, statusSel, severitySel].forEach(s => { s.onchange = applyFilters; });
  [fromInput, toInput].forEach(i => { i.onchange = applyFilters; });

  bar.append(
    field('Type', typeSel),
    field('Equipment', eqSel),
    field('Transporter', transporterSel),
    field('Status', statusSel),
    field('Severity', severitySel),
    field('From', fromInput),
    field('To', toInput)
  );

  const exportBtn = el('button', 'btn', 'Export CSV');
  exportBtn.onclick = async () => {
    const res = await api.exportCsv(filters.type, filters);
    if (res.ok) toast('info', 'CSV exported', `${res.count} row(s) saved to ${res.path}`);
    else if (!res.canceled) toast('critical', 'Export failed', res.error || '');
  };
  bar.append(field(' ', exportBtn));
  root.append(bar);

  const rows = await api.getHistory(filters);

  // Populate transporter options if not already.
  const transporters = Array.from(new Set(rows.map(r => r.transporter).filter(Boolean)));
  if (transporters.length && transporterSel.options.length <= 1) {
    transporters.forEach(tp => {
      const o = el('option', null, tp);
      o.value = tp;
      transporterSel.append(o);
    });
  }

  const columns = HISTORY_COLUMNS[filters.type] || HISTORY_COLUMNS.all;
  const bodyRows = rows.map(row => tr(historyCells(row, filters.type)));
  const wrapPanel = el('div', 'panel');
  const head = el('div', 'panel-head');
  head.append(el('h2', null, `${rows.length} record(s)`));
  wrapPanel.append(head);
  wrapPanel.append(table(columns, bodyRows));
  root.append(wrapPanel);
}

function historyCells(row, type) {
  if (type === 'all') {
    return [
      row.type,
      fmtDateTime(row.timestamp),
      row.equipmentId || row.tripId || '—',
      summarizeRow(row),
      row.status || '—'
    ];
  }
  if (type === 'reading') {
    return [fmtDateTime(row.timestamp), row.equipmentId || row.id, fmtNum(row.flowRate), row.pressure ?? '—', row.filterDp ?? '—', row.water || '—', row.interlock || '—'];
  }
  if (type === 'delivery') {
    return [fmtDateTime(row.timestamp), row.tripId, row.equipmentId, row.transporter, fmtNum(row.quantityLoaded), fmtNum(row.quantityReceived), fmtNum(row.varianceLitres), row.variancePercent == null ? '—' : `${fmtNum(row.variancePercent, 2)}%`, sealTag(row.sealStatus), row.status || '—'];
  }
  if (type === 'maintenance') {
    return [fmtDate(row.timestamp || row.date), row.equipmentId, row.faultCategory, row.faultDescription, row.downtimeHours == null ? '—' : `${row.downtimeHours} h`, row.actionTaken, row.status];
  }
  if (type === 'alert') {
    return [fmtDateTime(row.timestamp), row.equipmentId, row.category, severityTag(row.severity), row.message, row.status];
  }
  return [];
}

function summarizeRow(row) {
  if (row.type === 'reading') return `Flow ${fmtNum(row.flowRate)} L/min · dP ${row.filterDp ?? '—'} bar`;
  if (row.type === 'delivery') return `${fmtNum(row.quantityLoaded)} → ${fmtNum(row.quantityReceived)} L`;
  if (row.type === 'maintenance') return row.faultDescription || row.faultCategory || '—';
  if (row.type === 'alert') return row.message || '—';
  return '—';
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function renderSettings() {
  const settings = await api.getSettings();
  state.settings = settings;

  const root = pageEl('settings');
  root.innerHTML = '';

  const warning = el('div', 'banner banner-warning');
  warning.style.margin = '0 0 18px';
  warning.append(el('strong', null, 'Important: '));
  warning.append(document.createTextNode(
    'Real limits must be obtained from the equipment manufacturer, approved company procedures, and qualified aviation/fuel personnel. The values below are demonstration defaults only.'
  ));
  root.append(warning);

  const p = panel('Monitoring Thresholds');
  const form = el('div', 'form-grid');

  const fields = [
    ['minimumFlow', 'Minimum Flow (L/min)', 'flow'],
    ['minimumPressure', 'Minimum Pressure (bar)', 'pressure'],
    ['maximumPressure', 'Maximum Pressure (bar)', 'pressure'],
    ['maximumFilterDp', 'Maximum Filter dP (bar)', 'filter'],
    ['serviceWarningDays', 'Service Warning (days)', 'days'],
    ['deliveryVarianceThreshold', 'Delivery Variance Threshold (%)', 'variance'],
    ['transitDelayThreshold', 'Delay Threshold (hours)', 'delay']
  ];

  const inputs = {};
  fields.forEach(([key, label]) => {
    const i = input('number', settings[key]);
    i.step = '0.1';
    inputs[key] = i;
    form.append(field(label, i));
  });
  p.append(form);

  const save = el('button', 'btn btn-primary', 'Save Settings');
  save.style.marginTop = '16px';
  save.onclick = async () => {
    const payload = {};
    Object.entries(inputs).forEach(([key, i]) => { payload[key] = i.value; });
    const updated = await api.updateSettings(payload);
    state.settings = updated;
    toast('info', 'Settings saved', 'Thresholds updated and persisted.');
    refreshCurrentPage();
  };
  p.append(save);
  root.append(p);

  const conn = panel('Excel Connection');
  const connText = el('p');
  connText.style.margin = '0 0 10px';
  connText.style.fontSize = '0.85rem';
  connText.append(document.createTextNode(
    'FuelOps watches the folder below continuously. Adding a row or changing cells in any of the three workbooks is imported and evaluated within about a second (no refresh needed).'
  ));
  conn.append(connText);

  const stateLine = el('div');
  stateLine.style.margin = '4px 0 10px';
  stateLine.append(el('span', null, 'Status: '));
  const stateValue = el('span', null, '…');
  stateValue.style.fontWeight = '600';
  stateLine.append(stateValue);
  conn.append(stateLine);

  function infoRow(label) {
    const line = el('div');
    line.style.margin = '3px 0';
    line.style.fontSize = '0.82rem';
    const l = el('span', null, `${label}: `);
    l.style.opacity = '0.75';
    const v = el('span', null, '—');
    v.style.wordBreak = 'break-all';
    line.append(l, v);
    conn.append(line);
    return v;
  }

  const dataDirValue = infoRow('Watched Data Folder');
  const bowserValue = infoRow('Bowser File');
  const peddlerValue = infoRow('Delivery File');
  const maintenanceValue = infoRow('Maintenance File');
  const lastChangeValue = infoRow('Last File Change Detected');
  const lastImportValue = infoRow('Last Successful Import');
  const lastImportCountValue = infoRow('Last Import');
  const lastSkippedValue = infoRow('Rows Skipped (last read)');
  const lastErrorValue = infoRow('Last Watcher Error');

  const buttons = el('div');
  buttons.style.marginTop = '12px';
  buttons.style.display = 'flex';
  buttons.style.gap = '8px';
  buttons.style.flexWrap = 'wrap';

  const openFolder = el('button', 'btn', 'Open Data Folder');
  openFolder.onclick = async () => {
    const res = await api.openDataFolder();
    if (!res.ok) toast('critical', 'Could not open folder', res.error || 'Unknown error');
  };

  const reconnect = el('button', 'btn', 'Reconnect Excel Watcher');
  reconnect.onclick = async () => {
    reconnect.disabled = true;
    const status = await api.reconnectWatcher();
    reconnect.disabled = false;
    toast('info', 'Watcher reconnected', `Status: ${status.state}`);
    refreshWatcherStatus();
  };

  const check = el('button', 'btn', 'Check Connection');
  check.onclick = async () => {
    check.disabled = true;
    const result = await api.checkConnection();
    check.disabled = false;
    const bad = (result.checks || []).filter(c => !c.ok);
    if (bad.length) toast('critical', 'Connection problem', bad.map(c => `${c.name}: ${c.error}`).join('; '));
    else toast('info', 'Connection OK', result.checks.map(c => `${c.name}: ${c.rows} rows`).join(', '));
    refreshWatcherStatus();
  };

  buttons.append(openFolder, reconnect, check);
  conn.append(buttons);
  root.append(conn);

  async function refreshWatcherStatus() {
    try {
      const s = await api.getWatcherStatus();
      stateValue.textContent = s.state;
      stateValue.style.color = s.state === 'Active' ? '#5fd18b'
        : s.state === 'Paused' ? '#e6b45a' : '#ef6d6d';
      dataDirValue.textContent = s.dataDir || '—';
      const byKey = {};
      (s.files || []).forEach(f => { byKey[f.key] = f; });
      const fmtFile = f => f ? `${f.path} ${f.exists ? '(found)' : '(MISSING)'}` : '—';
      bowserValue.textContent = fmtFile(byKey.bowser);
      peddlerValue.textContent = fmtFile(byKey.peddler);
      maintenanceValue.textContent = fmtFile(byKey.maintenance);
      lastChangeValue.textContent = s.lastChangeAt ? `${s.lastChangeAt} (${s.lastChangeFile || ''})` : 'none yet';
      lastImportValue.textContent = s.lastImportAt || 'none yet';
      lastImportCountValue.textContent = s.lastImportCount ? `${s.lastImportCount} record(s)` : '0 records';
      lastSkippedValue.textContent = String(s.lastSkipped ?? 0);
      lastErrorValue.textContent = s.lastError || 'None';
    } catch (err) {
      stateValue.textContent = 'Unavailable';
      stateValue.style.color = '#ef6d6d';
    }
  }

  if (settingsStatusTimer) clearInterval(settingsStatusTimer);
  refreshWatcherStatus();
  settingsStatusTimer = setInterval(refreshWatcherStatus, 2000);

  const guide = panel('How thresholds drive status');
  const guideText = [
    'Flow below minimum → Needs Attention',
    'Pressure outside range → Needs Attention',
    'Filter dP above maximum → Needs Attention',
    'Water detected / alarm / fail → Critical',
    'Interlock fail → Critical',
    'Service due soon → Needs Attention',
    'Service overdue → Critical',
    'Delivery variance above threshold → Review Required',
    'Seal not Intact → Review Required',
    'Delay above threshold → Review Required',
    'Same fault category 3+ times → Recurring Issue'
  ];
  const ul = el('ul');
  ul.style.paddingLeft = '18px';
  ul.style.lineHeight = '1.7';
  ul.style.fontSize = '0.84rem';
  guideText.forEach(t => ul.append(el('li', null, t)));
  guide.append(ul);
  root.append(guide);
}

// ---------------------------------------------------------------------------
// Monitoring state / bootstrap
// ---------------------------------------------------------------------------

async function initMonitoringControls() {
  const stateEl = document.getElementById('monitor-state');
  const btn = document.getElementById('toggle-monitoring');

  const apply = (monitoring) => {
    state.monitoring = monitoring;
    stateEl.innerHTML = '';
    stateEl.append(el('span', `dot ${monitoring ? 'dot-green' : 'dot-amber'}`));
    stateEl.append(document.createTextNode(monitoring ? ' Monitoring active' : ' Monitoring paused'));
    btn.textContent = monitoring ? 'Pause Monitoring' : 'Resume Monitoring';
  };

  state.monitoring = await api.getMonitoringState();
  apply(state.monitoring);

  btn.onclick = async () => {
    const next = await api.setMonitoring(!state.monitoring);
    apply(next);
    toast('info', next ? 'Monitoring resumed' : 'Monitoring paused', next ? 'Excel watcher is active.' : 'Excel watcher is paused. Manual entries still import.');
  };

  api.onMonitoringState(apply);
}

function bootstrap() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.onclick = () => navigate(btn.dataset.page);
  });
  document.getElementById('quick-refresh').onclick = () => {
    refreshCurrentPage();
    toast('info', 'Refreshed', 'Data reloaded from local storage.');
  };

  api.onDataUpdated(() => {
    refreshCurrentPage();
    updateAlertBadge();
  });

  api.onShowNotification(({ title, body }) => {
    const severity = (body || '').toLowerCase().includes('critical') ? 'critical' : 'warning';
    toast(severity, title, body);
  });

  initMonitoringControls();
  navigate('dashboard');
  console.log('[FuelOps] UI ready');
}

window.addEventListener('DOMContentLoaded', bootstrap);
