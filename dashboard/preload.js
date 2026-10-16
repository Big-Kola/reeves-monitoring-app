// FuelOps Monitor - preload bridge
//
// The renderer runs with contextIsolation enabled and has no direct access to
// Node.js. Only the functions below are exposed on window.fuelops.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fuelops', {
  // Data
  getDashboardData: () => ipcRenderer.invoke('getDashboardData'),
  getEquipment: () => ipcRenderer.invoke('getEquipment'),
  getEquipmentList: () => ipcRenderer.invoke('getEquipmentList'),
  getEquipmentDetail: (id) => ipcRenderer.invoke('getEquipmentDetail', id),
  getDeliveries: () => ipcRenderer.invoke('getDeliveries'),
  getAlerts: () => ipcRenderer.invoke('getAlerts'),
  getMaintenance: () => ipcRenderer.invoke('getMaintenance'),
  getHistory: (filters) => ipcRenderer.invoke('getHistory', filters),
  getSettings: () => ipcRenderer.invoke('getSettings'),

  // Mutations
  updateSettings: (settings) => ipcRenderer.invoke('updateSettings', settings),
  resolveAlert: (alertId, resolution) => ipcRenderer.invoke('resolveAlert', { alertId, resolution }),
  updateAlertStatus: (alertId, status) => ipcRenderer.invoke('updateAlertStatus', { alertId, status }),
  addManualReading: (reading) => ipcRenderer.invoke('addManualReading', reading),
  addManualDelivery: (delivery) => ipcRenderer.invoke('addManualDelivery', delivery),
  addMaintenance: (record) => ipcRenderer.invoke('addMaintenance', record),
  exportCsv: (type, filters) => ipcRenderer.invoke('exportCsv', { type, filters }),

  // Monitoring control
  getMonitoringState: () => ipcRenderer.invoke('getMonitoringState'),
  setMonitoring: (state) => ipcRenderer.invoke('setMonitoring', state),

  // Events pushed from the main process
  onDataUpdated: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('data-updated', listener);
    return () => ipcRenderer.removeListener('data-updated', listener);
  },
  onShowNotification: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('show-notification', listener);
    return () => ipcRenderer.removeListener('show-notification', listener);
  },
  onMonitoringState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('monitoring-state', listener);
    return () => ipcRenderer.removeListener('monitoring-state', listener);
  }
});
