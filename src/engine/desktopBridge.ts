export interface WindowsDriveInfo {
  number: number;
  devicePath: string;
  name: string;
  sizeBytes: number;
  busType: string;
  partitionStyle: string;
  status: string;
  letters: string[];
}

export interface WindowsVolumeInfo {
  driveLetter: string; // e.g. 'C:'
  rootPath: string; // e.g. 'C:\\'
  label: string;
  fileSystem: string;
  freeBytes: number;
  totalBytes: number;
}

export interface NativeScannedEntry {
  id: string;
  filename: string;
  originalPath: string;
  extensionHint: string;
  size: number;
  modifiedAt: number;
  sourceKind: 'recycle-bin' | 'folder' | 'carved' | 'ntfs-mft';
  isDeleted?: boolean;
  scanPhase?: 'quick' | 'deep' | 'vss' | 'usn';
  offset: number;
  sector: number;
  devicePath: string;
  headerSample: Uint8Array;
  calculatedSize?: number | null;
  truncated?: boolean;
  runs?: { offset: number; length: number }[];
  mftResident?: boolean;
  mftOverwritten?: boolean;
  mftBitmapIntact?: boolean;
}

export interface NativeScanProgressEvent {
  scanId: string;
  phase?: 'quick' | 'deep';
  currentBytes: number;
  totalBytes: number;
  percent: number;
  foundCount: number;
  foundBytes: number;
  latestName?: string;
}

export interface NativeScanBatchEvent {
  scanId: string;
  entries: NativeScannedEntry[];
}

export interface LocationScanResponse {
  entries: NativeScannedEntry[];
  path?: string;
  deletedLookupStatus?: 'scanned' | 'needs-admin' | 'unsupported';
  backingDrive?: {
    devicePath: string;
    totalBytes: number;
    label: string;
    relPrefix?: string;
  };
}

export interface BitLockerVolumeInfo {
  mountPoint: string;
  encryptionMethod: string;
  volumeStatus: string;
  protectionStatus: string;
  lockStatus: string;
}

export interface NativeRecoverRequestItem {
  filename: string;
  folder: string;
  sourceKind: 'memory' | 'native-device' | 'native-runs' | 'native-file';
  devicePath?: string;
  offset: number;
  size: number;
  runs?: { offset: number; length: number }[];
  memoryBytes?: Uint8Array;
  extension: string;
  repairIfTruncated: boolean;
  modifiedAtMs?: number;
}

export interface DesktopBridge {
  isDesktop: boolean;
  platform: string;
  listWindowsDrives: () => Promise<WindowsDriveInfo[]>;
  listWindowsVolumes: () => Promise<WindowsVolumeInfo[]>;
  listBitLockerVolumes: () => Promise<BitLockerVolumeInfo[]>;
  unlockBitLocker: (params: {
    driveLetter: string;
    recoveryKey?: string;
    password?: string;
  }) => Promise<{ ok: boolean; message?: string; error?: string }>;
  readDiskBytes: (
    devicePath: string,
    startByte?: number,
    maxBytes?: number,
  ) => Promise<Uint8Array>;
  pickDiskImage: () => Promise<{ path: string; name: string; sizeBytes: number } | null>;
  pickFolder: () => Promise<string | null>;
  scanFolder: (folderPath: string) => Promise<LocationScanResponse>;
  scanRecycleBin: () => Promise<LocationScanResponse>;
  scanDesktop: () => Promise<LocationScanResponse>;
  startDriveScan: (params: {
    scanId: string;
    devicePath: string;
    totalBytes: number;
    blockSize: number;
    scanMode?: 'quick' | 'full';
    startPhase?: 'quick' | 'deep';
    includeExisting?: boolean;
    pathFilter?: string;
    resumeOffset?: number;
  }) => Promise<NativeScannedEntry[]>;
  pauseDriveScan: (scanId: string) => Promise<void>;
  resumeDriveScan: (scanId: string) => Promise<void>;
  cancelDriveScan: (scanId: string) => Promise<void>;
  onDriveScanProgress: (cb: (ev: NativeScanProgressEvent) => void) => () => void;
  onDriveScanBatch: (cb: (ev: NativeScanBatchEvent) => void) => () => void;
  recoverFilesToFolder: (params: {
    destinationDir: string | null;
    items: NativeRecoverRequestItem[];
  }) => Promise<{
    canceled?: boolean;
    savedCount: number;
    destinationDir: string;
    repairedCount: number;
    error?: string;
  }>;
  saveTextReport: (params: {
    defaultName: string;
    title: string;
    filters: { name: string; extensions: string[] }[];
    content: string;
  }) => Promise<{ canceled: boolean; filePath?: string }>;
}

export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as { desktopBridge?: DesktopBridge };
  return win.desktopBridge?.isDesktop ? win.desktopBridge : null;
}
