import { EngineCapabilities } from './explorerTypes';

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
  modifiedAt?: number;
  sourceKind: 'recycle-bin' | 'folder' | 'carved' | 'ntfs-mft';
  isDeleted?: boolean;
  scanPhase?: 'quick' | 'deep' | 'vss' | 'usn';
  offset: number;
  sector: number;
  devicePath: string;
  headerSample: Uint8Array;
  calculatedSize?: number | null;
  truncated?: boolean;
  sizeEstimated?: boolean;
  ntfsCompressed?: boolean;
  ntfsEncrypted?: boolean;
  runs?: { offset: number; length: number }[];
  tskInode?: string;
  tskOffset?: number;
  sectorSize?: number;
  discoveryCrc32?: number;
  mftResident?: boolean;
  mftOverwritten?: boolean;
  mftBitmapIntact?: boolean;
  partitionName?: string;
  details?: string;
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
  incomplete?: boolean;
  skippedSectors?: number;
  skippedBytes?: number;
  warnings?: string[];
}

export interface NativeScanBatchEvent {
  scanId: string;
  entries: NativeScannedEntry[];
}

export interface DriveScanResult {
  entries: NativeScannedEntry[];
  warnings: string[];
  incomplete: boolean;
  skippedSectors: number;
  skippedBytes: number;
}

export interface LostPartitionScanResponse {
  partitions: import('./partitions').PartitionEntry[];
  sectorSize: number;
  limitBytes: number;
  warnings: string[];
}

export interface LocationScanResponse {
  entries: NativeScannedEntry[];
  path?: string;
  deletedLookupStatus?: 'scanned' | 'partial' | 'needs-admin' | 'io-error' | 'unsupported';
  backingDrive?:
    | string
    | {
        devicePath: string;
        totalBytes: number;
        label: string;
        relPrefix?: string;
      };
  scannedVolumes?: string[];
  needsAdminVolumes?: string[];
  liveCount?: number;
  vssCount?: number;
  emptiedCount?: number;
}

export interface BitLockerVolumeInfo {
  mountPoint: string;
  encryptionMethod: string;
  volumeStatus: string;
  protectionStatus: string;
  lockStatus: string;
}

export interface VideoPreviewResult {
  thumbnailDataUrl?: string;
  codec?: string | null;
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
}

export interface NativeRecoverFailure {
  filename: string;
  reason: string;
}

export interface NativeRecoverRequestItem {
  filename: string;
  folder: string;
  sourceKind: 'memory' | 'native-device' | 'native-runs' | 'native-file' | 'native-tsk';
  devicePath?: string;
  offset: number;
  size: number;
  runs?: { offset: number; length: number }[];
  tskInode?: string;
  tskOffset?: number;
  sectorSize?: number;
  discoveryCrc32?: number;
  ntfsCompressed?: boolean;
  ntfsEncrypted?: boolean;
  memoryBytes?: Uint8Array;
  extension: string;
  repairIfTruncated: boolean;
  modifiedAtMs?: number;
}

export interface RepairMediaFileParams {
  filename: string;
  extension: string;
  filePath?: string;
  buffer?: Uint8Array;
  sourceKind?: 'memory' | 'native-device' | 'native-runs' | 'native-file' | 'native-tsk';
  devicePath?: string;
  offset?: number;
  size?: number;
  runs?: { offset: number; length: number }[];
  tskInode?: string;
  tskOffset?: number;
  sectorSize?: number;
  referenceBuffer?: Uint8Array;
  allowTranscodeFallback?: boolean;
  saveWithDialog?: boolean;
}

export interface RepairMediaFileResult {
  ok: boolean;
  canceled?: boolean;
  tier: string;
  repairedSize: number;
  note: string;
  previewDataUrl?: string;
  outputPath?: string;
  repairedBytes?: Uint8Array;
  salvagedPreviewBytes?: Uint8Array;
  unverifiedDestination?: boolean;
  error?: string;
}

export interface DesktopBridge {
  isDesktop: boolean;
  platform: string;
  getEngineCapabilities: () => Promise<EngineCapabilities>;
  relaunchAsAdmin: () => Promise<{ ok: boolean; error?: string }>;
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
    tskInode?: string,
    tskOffset?: number,
    sectorSize?: number,
  ) => Promise<Uint8Array>;
  readDiskBytesDetailed?: (
    devicePath: string,
    startByte?: number,
    maxBytes?: number,
    tskInode?: string,
    tskOffset?: number,
    sectorSize?: number,
  ) => Promise<{ bytes: Uint8Array; badSectors: number; badBytes: number; shortRead: boolean }>;
  probeVideoPreview: (params: {
    filePath?: string;
    buffer?: Uint8Array;
    tskInode?: string;
    tskOffset?: number;
    sectorSize?: number;
    devicePath?: string;
  }) => Promise<VideoPreviewResult | null>;
  repairMediaFile: (params: RepairMediaFileParams) => Promise<RepairMediaFileResult>;
  identifyFilesNative: (filePaths: string[]) => Promise<Record<string, string>>;
  pickDiskImage: () => Promise<{ path: string; name: string; sizeBytes: number } | null>;
  pickFolder: () => Promise<string | null>;
  scanFolder: (folderPath: string) => Promise<LocationScanResponse>;
  scanRecycleBin: () => Promise<LocationScanResponse>;
  scanDesktop: () => Promise<LocationScanResponse>;
  scanLostPartitions: (params: {
    devicePath: string;
    totalBytes?: number;
  }) => Promise<LostPartitionScanResponse>;
  startDriveScan: (params: {
    scanId: string;
    devicePath: string;
    totalBytes: number;
    blockSize: number;
    scanMode?: 'quick' | 'full';
    startPhase?: 'quick' | 'deep';
    unallocatedOnly?: boolean;
    includeExisting?: boolean;
    pathFilter?: string;
    resumeOffset?: number;
  }) => Promise<DriveScanResult>;
  pauseDriveScan: (scanId: string) => Promise<void>;
  resumeDriveScan: (scanId: string) => Promise<void>;
  cancelDriveScan: (scanId: string) => Promise<void>;
  onDriveScanProgress: (cb: (ev: NativeScanProgressEvent) => void) => () => void;
  onDriveScanBatch: (cb: (ev: NativeScanBatchEvent) => void) => () => void;
  recoverFilesToFolder: (params: {
    destinationDir: string | null;
    items: NativeRecoverRequestItem[];
    scannedDevicePath?: string;
    keepOriginalOnRepair?: boolean;
    allowUnverifiedDestination?: boolean;
  }) => Promise<{
    canceled?: boolean;
    savedCount: number;
    verifiedCount?: number;
    partialCount?: number;
    originalKeptCount?: number;
    destinationDir: string;
    repairedCount: number;
    reportPath?: string;
    failures?: NativeRecoverFailure[];
    unverifiedDestination?: boolean;
    error?: string;
  }>;
  saveTextReport: (params: {
    defaultName: string;
    title: string;
    filters: { name: string; extensions: string[] }[];
    content: string;
    scannedDevicePath?: string;
    allowUnverifiedDestination?: boolean;
  }) => Promise<{
    canceled: boolean;
    filePath?: string;
    unverifiedDestination?: boolean;
    error?: string;
  }>;
}

export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as { desktopBridge?: DesktopBridge };
  return win.desktopBridge?.isDesktop ? win.desktopBridge : null;
}
