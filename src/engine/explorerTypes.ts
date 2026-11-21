import { FileFamily, IdentifyMetadata } from './signatures';

export type RecoveryLikelihoodTier = 'high' | 'medium' | 'low';

export interface ExtentRun {
  offset: number;
  length: number;
}

export interface FileSourceRef {
  kind: 'memory' | 'native-device' | 'native-runs' | 'native-file' | 'browser-file';
  devicePath?: string;
  offset: number;
  size: number;
  runs?: ExtentRun[];
  browserFile?: File;
}

export type ScanMode = 'quick' | 'full';
export type DeletedFilter = 'all' | 'deleted' | 'existing';

export interface ExplorerFileItem {
  id: string;
  filename: string;
  extension: string;
  family: FileFamily;
  mimeType: string;
  size: number;
  calculatedSize: number | null;
  status: 'OK' | 'OK_TRUNCATED' | 'HEADER_ONLY' | 'UNKNOWN';
  sourceKind: 'carved' | 'ntfs-mft' | 'fidentify' | 'recycle-bin' | 'folder';
  isDeleted?: boolean;
  scanPhase?: 'quick' | 'deep' | 'vss' | 'usn';
  partitionId: string;
  partitionName: string;
  originalPath?: string;
  offset: number;
  sector: number;
  matchedOffset: number;
  matchedLength: number;
  metadata: IdentifyMetadata;
  description: string;
  data: Uint8Array;
  sourceRef?: FileSourceRef;
  modifiedAt: number;
  recoveryChance: number;
  recoveryTier: RecoveryLikelihoodTier;
  recoveryReason: string;
  repaired?: boolean;
  contentFingerprint?: string;
}

export type TreeMode = 'path' | 'type';

export type SortKey = 'name' | 'date' | 'type' | 'size' | 'likelihood' | 'origin';
export type SortDir = 'asc' | 'desc';
export type GroupByKey = 'none' | 'likelihood' | 'type' | 'origin' | 'date';

export type SelectedTreeNode =
  | { kind: 'all-types' }
  | { kind: 'family'; family: FileFamily }
  | { kind: 'ext'; family: FileFamily; extension: string }
  | { kind: 'disk-root' }
  | { kind: 'partition'; partitionId: string }
  | { kind: 'folder-node'; partitionId: string; folderPath: string }
  | { kind: 'ntfs-mft' }
  | { kind: 'unallocated' }
  | { kind: 'recycle-bin' }
  | { kind: 'folder-scan' }
  | { kind: 'fidentify' };

export function extractFolderSegments(originalPath?: string): string[] {
  if (!originalPath) return [];
  let cleaned = originalPath.trim();
  // Strip raw drive prefixes like \\.\PhysicalDrive0 @ sector 123
  if (/^\\\\\.\\PhysicalDrive/i.test(cleaned) || cleaned.includes('@ sector')) {
    return [];
  }
  cleaned = cleaned
    .replace(/^(FAT32|exFAT|NTFS)\s+/i, '')
    .replace(/^[A-Za-z]:[\\/]?/, '')
    .replace(/^[\\/]+/, '');
  const parts = cleaned.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 1) return [];
  // Drop trailing filename segment, return directory hierarchy segments
  return parts.slice(0, -1);
}

export function treeNodeKey(node: SelectedTreeNode): string {
  switch (node.kind) {
    case 'all-types':
      return 'type:all';
    case 'family':
      return `type:fam:${node.family}`;
    case 'ext':
      return `type:ext:${node.family}:${node.extension}`;
    case 'disk-root':
      return 'path:root';
    case 'partition':
      return `path:part:${node.partitionId}`;
    case 'folder-node':
      return `path:dir:${node.partitionId}:${node.folderPath}`;
    case 'ntfs-mft':
      return 'path:ntfs-mft';
    case 'unallocated':
      return 'path:unalloc';
    case 'recycle-bin':
      return 'path:recycle';
    case 'folder-scan':
      return 'path:folder';
    case 'fidentify':
      return 'path:fidentify';
  }
}

export function itemMatchesNode(item: ExplorerFileItem, node: SelectedTreeNode): boolean {
  switch (node.kind) {
    case 'all-types':
      return true;
    case 'family':
      return item.family === node.family;
    case 'ext':
      return item.family === node.family && item.extension === node.extension;
    case 'disk-root':
      return item.sourceKind === 'carved' || item.sourceKind === 'ntfs-mft';
    case 'partition':
      return (
        (item.sourceKind === 'carved' || item.sourceKind === 'ntfs-mft') &&
        item.partitionId === node.partitionId
      );
    case 'folder-node': {
      if (item.partitionId !== node.partitionId) return false;
      const itemFolder = extractFolderSegments(item.originalPath).join('/');
      return (
        itemFolder === node.folderPath ||
        itemFolder.startsWith(`${node.folderPath}/`)
      );
    }
    case 'ntfs-mft':
      return item.sourceKind === 'ntfs-mft';
    case 'unallocated':
      return (
        (item.sourceKind === 'carved' || item.sourceKind === 'ntfs-mft') &&
        item.partitionId === 'unallocated'
      );
    case 'recycle-bin':
      return item.sourceKind === 'recycle-bin';
    case 'folder-scan':
      return item.sourceKind === 'folder';
    case 'fidentify':
      return item.sourceKind === 'fidentify';
  }
}

export interface SerializedScanSessionItem {
  id: string;
  filename: string;
  extension: string;
  family: FileFamily;
  mimeType: string;
  size: number;
  calculatedSize: number | null;
  status: ExplorerFileItem['status'];
  sourceKind: ExplorerFileItem['sourceKind'];
  isDeleted?: boolean;
  scanPhase?: 'quick' | 'deep' | 'vss' | 'usn';
  partitionId: string;
  partitionName: string;
  originalPath?: string;
  offset: number;
  sector: number;
  matchedOffset: number;
  matchedLength: number;
  metadata: IdentifyMetadata;
  description: string;
  sourceRef?: Omit<FileSourceRef, 'browserFile'>;
  modifiedAt: number;
  recoveryChance: number;
  recoveryTier: RecoveryLikelihoodTier;
  recoveryReason: string;
  contentFingerprint?: string;
  headerSampleHex?: string;
}

export interface SavedScanSession {
  version: 1;
  savedAt: string;
  diskName: string;
  diskSizeBytes: number;
  devicePath?: string;
  resumeOffset?: number;
  items: SerializedScanSessionItem[];
}
