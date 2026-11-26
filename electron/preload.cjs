const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopBridge', {
  isDesktop: true,
  platform: process.platform,
  getEngineCapabilities: () => ipcRenderer.invoke('win:get-engine-capabilities'),
  relaunchAsAdmin: () => ipcRenderer.invoke('win:relaunch-admin'),
  listWindowsDrives: () => ipcRenderer.invoke('win:list-drives'),
  listWindowsVolumes: () => ipcRenderer.invoke('win:list-volumes'),
  listBitLockerVolumes: () => ipcRenderer.invoke('win:list-bitlocker'),
  unlockBitLocker: (params) => ipcRenderer.invoke('win:unlock-bitlocker', params),
  readDiskBytes: (devicePath, startByte, maxBytes, tskInode, tskOffset) =>
    ipcRenderer.invoke('win:read-disk-bytes', { devicePath, startByte, maxBytes, tskInode, tskOffset }),
  probeVideoPreview: (params) => ipcRenderer.invoke('win:probe-video-preview', params),
  repairMediaFile: (params) => ipcRenderer.invoke('win:repair-media-file', params),
  identifyFilesNative: (filePaths) => ipcRenderer.invoke('win:identify-files', filePaths),
  pickDiskImage: () => ipcRenderer.invoke('win:pick-disk-image'),
  pickFolder: () => ipcRenderer.invoke('win:pick-folder'),
  scanFolder: (folderPath) => ipcRenderer.invoke('win:scan-folder', folderPath),
  scanRecycleBin: () => ipcRenderer.invoke('win:scan-recycle-bin'),
  scanDesktop: () => ipcRenderer.invoke('win:scan-desktop'),
  scanLostPartitions: (params) => ipcRenderer.invoke('win:scan-lost-partitions', params),
  startDriveScan: (params) => ipcRenderer.invoke('win:start-drive-scan', params),
  pauseDriveScan: (scanId) => ipcRenderer.invoke('win:pause-drive-scan', scanId),
  resumeDriveScan: (scanId) => ipcRenderer.invoke('win:resume-drive-scan', scanId),
  cancelDriveScan: (scanId) => ipcRenderer.invoke('win:cancel-drive-scan', scanId),
  onDriveScanProgress: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('win:drive-scan-progress', listener);
    return () => ipcRenderer.removeListener('win:drive-scan-progress', listener);
  },
  onDriveScanBatch: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('win:drive-scan-batch', listener);
    return () => ipcRenderer.removeListener('win:drive-scan-batch', listener);
  },
  recoverFilesToFolder: (params) => ipcRenderer.invoke('win:recover-files', params),
  saveTextReport: (params) => ipcRenderer.invoke('win:save-text-report', params),
});
