const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { DATA_DIR } = require('./config');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function createBowserTemplate() {
  const filePath = path.join(DATA_DIR, 'Bowser_Readings.xlsx');
  if (fs.existsSync(filePath)) return filePath;

  const headers = [
    'Timestamp',
    'Equipment ID',
    'Equipment Type',
    'Flow Rate L/min',
    'Delivery Pressure bar',
    'Filter dP bar',
    'Water Check',
    'Interlock Status',
    'Operating Hours',
    'Days Until Service',
    'Notes'
  ];

  const sampleData = [
    ['2026-10-15 08:00', 'Bowser 01', 'Aviation Bowser', 1850, 3.6, 0.55, 'Clear', 'Pass', 1220, 21, 'Normal operation'],
    ['2026-10-15 08:30', 'Bowser 02', 'Aviation Bowser', 1380, 3.7, 1.20, 'Clear', 'Pass', 1620, 9, 'Example abnormal reading - filter dP high'],
    ['2026-10-15 09:00', 'Bowser 03', 'Aviation Bowser', 1920, 3.5, 0.45, 'Clear', 'Pass', 980, 45, 'Normal operation'],
    ['2026-10-15 09:30', 'Bowser 04', 'Aviation Bowser', 1200, 3.6, 1.20, 'Clear', 'Pass', 2100, 7, 'Example abnormal reading - low flow, high filter dP'],
    ['2026-10-15 10:00', 'Bowser 05', 'Aviation Bowser', 1780, 3.6, 0.60, 'Detected', 'Fail', 640, 30, 'Example critical - water detected and interlock fail']
  ];

  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...sampleData]);
  
  const colWidths = [
    { wch: 20 }, { wch: 15 }, { wch: 18 }, { wch: 15 }, { wch: 18 },
    { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 15 }, { wch: 18 }, { wch: 30 }
  ];
  worksheet['!cols'] = colWidths;

  XLSX.utils.book_append_sheet(workbook, worksheet, 'Readings');
  XLSX.writeFile(workbook, filePath);
  console.log('Created Bowser_Readings.xlsx template');
  return filePath;
}

function createPeddlerTemplate() {
  const filePath = path.join(DATA_DIR, 'Peddler_Deliveries.xlsx');
  if (fs.existsSync(filePath)) return filePath;

  const headers = [
    'Timestamp',
    'Trip ID',
    'Equipment ID',
    'Transporter',
    'Truck Number',
    'Driver',
    'Route',
    'Quantity Loaded L',
    'Quantity Received L',
    'Seal Status',
    'Transit Delay Hrs',
    'Notes'
  ];

  const sampleData = [
    ['2026-10-15 09:00', 'TRP-001', 'Peddler 01', 'Sample Logistics', 'ABC-123', 'Driver 1', 'Depot → Station A', 20000, 19880, 'Intact', 0.5, 'Normal example'],
    ['2026-10-15 10:00', 'TRP-002', 'Peddler 02', 'Sample Logistics', 'ABC-456', 'Driver 2', 'Depot → Station B', 20000, 19400, 'Intact', 3.0, 'Example abnormal variance - 3%'],
    ['2026-10-15 11:00', 'TRP-003', 'Peddler 03', 'Sample Logistics', 'ABC-789', 'Driver 3', 'Depot → Station C', 20000, 19950, 'Intact', 1.0, 'Normal delivery'],
    ['2026-10-15 12:00', 'TRP-004', 'Peddler 04', 'Sample Logistics', 'DEF-001', 'Driver 4', 'Depot → Station D', 15000, 14550, 'Broken', 2.5, 'Example seal issue and variance']
  ];

  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...sampleData]);
  
  const colWidths = [
    { wch: 20 }, { wch: 12 }, { wch: 15 }, { wch: 18 }, { wch: 14 },
    { wch: 12 }, { wch: 22 }, { wch: 18 }, { wch: 20 }, { wch: 14 }, { wch: 15 }, { wch: 30 }
  ];
  worksheet['!cols'] = colWidths;

  XLSX.utils.book_append_sheet(workbook, worksheet, 'Deliveries');
  XLSX.writeFile(workbook, filePath);
  console.log('Created Peddler_Deliveries.xlsx template');
  return filePath;
}

function createMaintenanceTemplate() {
  const filePath = path.join(DATA_DIR, 'Maintenance_Log.xlsx');
  if (fs.existsSync(filePath)) return filePath;

  const headers = [
    'Date',
    'Equipment ID',
    'Equipment Type',
    'Fault Category',
    'Fault Description',
    'Downtime Hours',
    'Action Taken',
    'Technician',
    'Status',
    'Next Service Date',
    'Notes'
  ];

  const sampleData = [
    ['2026-09-15', 'Bowser 01', 'Aviation Bowser', 'Filter', 'Filter differential pressure high', 2, 'Replaced filter element', 'Tech A', 'Resolved', '2026-10-29', 'Filter replaced, pressure normalized'],
    ['2026-09-20', 'Bowser 02', 'Aviation Bowser', 'Flow', 'Flow rate below minimum', 4, 'Cleaned flow meter and checked pump', 'Tech B', 'Resolved', '2026-10-04', 'Flow restored to normal'],
    ['2026-10-01', 'Peddler 01', 'Diesel Peddler', 'Seal', 'Seal found broken on delivery', 1, 'Replaced seal, investigated handling', 'Tech C', 'Resolved', '2026-11-01', 'New seal procedures implemented'],
    ['2026-10-10', 'Bowser 03', 'Aviation Bowser', 'Water', 'Water detected in sample', 3, 'Drained tank, inspected for leaks', 'Tech A', 'Investigating', '2026-10-24', 'Tank inspection in progress']
  ];

  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...sampleData]);
  
  const colWidths = [
    { wch: 14 }, { wch: 15 }, { wch: 18 }, { wch: 15 }, { wch: 35 },
    { wch: 15 }, { wch: 30 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 35 }
  ];
  worksheet['!cols'] = colWidths;

  XLSX.utils.book_append_sheet(workbook, worksheet, 'Maintenance');
  XLSX.writeFile(workbook, filePath);
  console.log('Created Maintenance_Log.xlsx template');
  return filePath;
}

function createAllTemplates() {
  ensureDataDir();
  createBowserTemplate();
  createPeddlerTemplate();
  createMaintenanceTemplate();
}

const BOWSER_HEADERS = [
  'Timestamp', 'Equipment ID', 'Equipment Type', 'Flow Rate L/min',
  'Delivery Pressure bar', 'Filter dP bar', 'Water Check',
  'Interlock Status', 'Operating Hours', 'Days Until Service', 'Notes'
];
const PEDDLER_HEADERS = [
  'Timestamp', 'Trip ID', 'Equipment ID', 'Transporter', 'Truck Number',
  'Driver', 'Route', 'Quantity Loaded L', 'Quantity Received L',
  'Seal Status', 'Transit Delay Hrs', 'Notes'
];
const MAINTENANCE_HEADERS = [
  'Date', 'Equipment ID', 'Equipment Type', 'Fault Category',
  'Fault Description', 'Downtime Hours', 'Action Taken',
  'Technician', 'Status', 'Next Service Date', 'Notes'
];

// Maps any known header spelling to the canonical field values. This lets the
// app append to a workbook whose header row uses short or long names.
const HEADER_ALIASES = {
  timestamp: ['Timestamp', 'timestamp', 'DateTime', 'Date Time'],
  date: ['Date', 'date', 'Timestamp', 'timestamp'],
  'equipment id': ['Equipment ID', 'Equipment', 'equipmentId', 'Unit', 'unit'],
  equipment: ['Equipment', 'Equipment ID', 'equipmentId', 'Unit', 'unit'],
  'equipment type': ['Equipment Type', 'Type', 'type'],
  type: ['Type', 'Equipment Type', 'type'],
  'flow rate l/min': ['Flow Rate L/min', 'Flow Rate', 'Flow', 'flowRate'],
  'flow rate': ['Flow Rate', 'Flow Rate L/min', 'Flow', 'flowRate'],
  flow: ['Flow', 'Flow Rate L/min', 'Flow Rate', 'flowRate'],
  'delivery pressure bar': ['Delivery Pressure bar', 'Delivery Pressure', 'Pressure', 'pressure'],
  pressure: ['Pressure', 'Delivery Pressure bar', 'Delivery Pressure', 'pressure'],
  'filter dp bar': ['Filter dP bar', 'Filter dP', 'Filter DP', 'filterDp'],
  'filter dp': ['Filter dP', 'Filter dP bar', 'Filter DP', 'filterDp'],
  'water check': ['Water Check', 'Water', 'water'],
  water: ['Water', 'Water Check', 'water'],
  'interlock status': ['Interlock Status', 'Interlock', 'interlock'],
  interlock: ['Interlock', 'Interlock Status', 'interlock'],
  'operating hours': ['Operating Hours', 'Hours', 'hours'],
  hours: ['Hours', 'Operating Hours', 'hours'],
  'days until service': ['Days Until Service', 'Days To Service', 'daysUntilService'],
  notes: ['Notes', 'notes', 'Remarks'],
  'trip id': ['Trip ID', 'Trip Id', 'Trip', 'tripId'],
  transporter: ['Transporter', 'transporter', 'Company'],
  'truck number': ['Truck Number', 'Truck', 'Vehicle', 'truckNumber'],
  driver: ['Driver', 'driver'],
  route: ['Route', 'route'],
  'quantity loaded l': ['Quantity Loaded L', 'Quantity Loaded', 'Loaded', 'loaded'],
  'quantity received l': ['Quantity Received L', 'Quantity Received', 'Received', 'received'],
  'seal status': ['Seal Status', 'Seal', 'seal'],
  'transit delay hrs': ['Transit Delay Hrs', 'Transit Delay', 'Delay', 'delay'],
  'fault category': ['Fault Category', 'Category', 'faultCategory'],
  'fault description': ['Fault Description', 'Description', 'faultDescription'],
  'downtime hours': ['Downtime Hours', 'Downtime', 'downtime'],
  'action taken': ['Action Taken', 'Action', 'actionTaken'],
  technician: ['Technician', 'technician'],
  status: ['Status', 'status'],
  'next service date': ['Next Service Date', 'Next Service', 'nextService']
};

function resolveFieldValue(record, header) {
  const key = String(header).trim().toLowerCase();
  const candidates = HEADER_ALIASES[key] || [header];
  for (const candidate of candidates) {
    const value = record[candidate];
    if (value !== undefined && value !== null) return value;
  }
  return '';
}

function readSheetHeaders(worksheet) {
  const ref = worksheet['!ref'];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref);
  const headers = [];
  for (let col = range.s.c; col <= range.e.c; col++) {
    const cell = worksheet[XLSX.utils.encode_cell({ r: range.s.r, c: col })];
    headers.push(cell ? String(cell.v).trim() : '');
  }
  return headers;
}

// Appends a record to an existing sheet using its actual header row, or creates
// the sheet with the canonical headers when missing.
function appendRecord(filePath, sheetName, canonicalHeaders, record) {
  let workbook;
  if (fs.existsSync(filePath)) {
    workbook = XLSX.readFile(filePath);
  } else {
    workbook = XLSX.utils.book_new();
  }

  let worksheet = workbook.Sheets[sheetName];
  let headers;
  if (worksheet) {
    headers = readSheetHeaders(worksheet);
  }
  if (!worksheet || headers.length === 0 || headers.every(h => h === '')) {
    headers = canonicalHeaders;
    worksheet = XLSX.utils.aoa_to_sheet([headers]);
    if (workbook.SheetNames.includes(sheetName)) delete workbook.Sheets[sheetName];
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  }

  const row = headers.map(header => resolveFieldValue(record, header));
  XLSX.utils.sheet_add_aoa(worksheet, [row], { origin: -1 });
  XLSX.writeFile(workbook, filePath);
}

function appendBowserReading(reading) {
  appendRecord(path.join(DATA_DIR, 'Bowser_Readings.xlsx'), 'Readings', BOWSER_HEADERS, reading);
}

function appendPeddlerDelivery(delivery) {
  appendRecord(path.join(DATA_DIR, 'Peddler_Deliveries.xlsx'), 'Deliveries', PEDDLER_HEADERS, delivery);
}

function appendMaintenanceRecord(record) {
  appendRecord(path.join(DATA_DIR, 'Maintenance_Log.xlsx'), 'Maintenance', MAINTENANCE_HEADERS, record);
}

module.exports = {
  createAllTemplates,
  createBowserTemplate,
  createPeddlerTemplate,
  createMaintenanceTemplate,
  appendBowserReading,
  appendPeddlerDelivery,
  appendMaintenanceRecord,
  BOWSER_HEADERS,
  PEDDLER_HEADERS,
  MAINTENANCE_HEADERS
};