const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopBridge', {
  isDesktop: true,
  platform: process.platform,
  listWindowsDrives: () => ipcRenderer.invoke('win:list-drives'),
  readDiskBytes: (devicePath, startByte, maxBytes) =>
    ipcRenderer.invoke('win:read-disk-bytes', { devicePath, startByte, maxBytes }),
  pickDiskImage: () => ipcRenderer.invoke('win:pick-disk-image'),
  pickFolder: () => ipcRenderer.invoke('win:pick-folder'),
  scanFolder: (folderPath) => ipcRenderer.invoke('win:scan-folder', folderPath),
  scanRecycleBin: () => ipcRenderer.invoke('win:scan-recycle-bin'),
  startDriveScan: (params) => ipcRenderer.invoke('win:start-drive-scan', params),
  pauseDriveScan: (scanId) => ipcRenderer.invoke('win:pause-drive-scan', scanId),
  resumeDriveScan: (scanId) => ipcRenderer.invoke('win:resume-drive-scan', scanId),
  cancelDriveScan: (scanId) => ipcRenderer.invoke('win:cancel-drive-scan', scanId),
  onDriveScanProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('win:drive-scan-progress', listener);
    return () => ipcRenderer.removeListener('win:drive-scan-progress', listener);
  },
  recoverFilesToFolder: (params) => ipcRenderer.invoke('win:recover-files', params),
  saveTextReport: (params) => ipcRenderer.invoke('win:save-text-report', params),
});
