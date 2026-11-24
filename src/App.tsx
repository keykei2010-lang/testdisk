import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  FileCode,
  FileQuestion,
  FileSpreadsheet,
  FileText,
  Film,
  Filter,
  Folder,
  FolderOpen,
  HardDrive,
  Home,
  Image as ImageIcon,
  Layers,
  LayoutGrid,
  LayoutList,
  Music,
  Pause,
  Play,
  RotateCcw,
  Save,
  Search,
  Shield,
  ShieldAlert,
  Square,
  Upload,
  Wrench,
  X,
  ZoomIn,
} from 'lucide-react';
import {
  analyzeDiskImage,
  PartitionEntry,
  writeMbrPartitionTable,
} from './engine/partitions';
import {
  CarvedFile,
  carveDiskBufferAsync,
  FILE_FORMATS,
  FileFamily,
  identifyBuffer,
} from './engine/signatures';
import {
  DeletedFilter,
  EngineCapabilities,
  ExplorerFileItem,
  GridThumbSize,
  GroupByKey,
  itemMatchesNode,
  RecoveryLikelihoodTier,
  SavedScanSession,
  ScanMode,
  SelectedTreeNode,
  SerializedScanSessionItem,
  SortDir,
  SortKey,
  TreeMode,
  treeNodeKey,
} from './engine/explorerTypes';
import {
  buildCsvReport,
  computeContentFingerprint,
  computeRecoveryLikelihood,
  deriveCarvedTimestamp,
  formatShortDate,
  repairFileBuffer,
  resolvePreferredExtension,
} from './engine/recoveryHealth';
import { formatBytes } from './engine/crc32';
import { extractNtfsAllocatedChecker, scanNtfsMftRecordsInBuffer } from './engine/ntfsMft';
import { scanFatAndExfatDeletedInBuffer } from './engine/fatExfat';
import { buildDfxmlReport } from './engine/dfxml';
import { useMediaUrl } from './utils/useMediaUrl';
import {
  getDesktopBridge,
  NativeScannedEntry,
  WindowsDriveInfo,
} from './engine/desktopBridge';
import { parseWindowsRecycleIFile, RecycleBinMeta } from './engine/recycleBin';
import { ExplorerSidebar } from './components/ExplorerSidebar';
import { ExplorerInspector } from './components/ExplorerInspector';
import { FilterPopover } from './components/FilterPopover';
import { RecoveryModal } from './components/RecoveryModal';
import { DriveHubModal } from './components/DriveHubModal';
import { LostPartitionsModal } from './components/LostPartitionsModal';
import { HomeView } from './components/HomeView';

interface ScanProgressState {
  currentSector: number;
  totalSectors: number;
  percent: number;
  foundCount: number;
  foundBytes: number;
  latestFilename?: string;
}

function inferFallbackFromExt(ext: string): {
  family: FileFamily;
  mimeType: string;
  description: string;
} {
  const e = ext.toLowerCase();
  if (
    [
      'jpg',
      'jpeg',
      'png',
      'gif',
      'bmp',
      'webp',
      'tif',
      'tiff',
      'svg',
      'heic',
      'cr2',
      'cr3',
      'nef',
      'arw',
      'dng',
      'raf',
      'orf',
      'rw2',
    ].includes(e)
  ) {
    return {
      family: 'Pictures',
      mimeType: e === 'jpg' || e === 'jpeg' ? 'image/jpeg' : e === 'svg' ? 'image/svg+xml' : `image/${e}`,
      description: `${e.toUpperCase()} Image`,
    };
  }
  if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'm4v', '3gp'].includes(e)) {
    return {
      family: 'Videos',
      mimeType: e === 'mov' ? 'video/quicktime' : e === 'webm' ? 'video/webm' : 'video/mp4',
      description: `${e.toUpperCase()} Video Stream`,
    };
  }
  if (['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma'].includes(e)) {
    return {
      family: 'Audio',
      mimeType: e === 'mp3' ? 'audio/mpeg' : `audio/${e}`,
      description: `${e.toUpperCase()} Audio Track`,
    };
  }
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'json', 'xml', 'md'].includes(e)) {
    return {
      family: 'Documents',
      mimeType: e === 'pdf' ? 'application/pdf' : 'text/plain',
      description: `${e.toUpperCase()} Document`,
    };
  }
  if (['zip', 'rar', '7z', 'gz', 'tar', 'iso'].includes(e)) {
    return {
      family: 'Archives',
      mimeType: 'application/zip',
      description: `${e.toUpperCase()} Archive`,
    };
  }
  return {
    family: 'Others',
    mimeType: 'application/octet-stream',
    description: e ? `${e.toUpperCase()} File` : 'Binary File',
  };
}

interface ThumbnailProps {
  item: ExplorerFileItem;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

const FileThumbnail: React.FC<ThumbnailProps> = ({ item, size = 'sm' }) => {
  const isPicture = item.family === 'Pictures';
  const cacheKey = `${item.id}:${item.repaired ? '1' : '0'}:${item.data.byteLength}`;
  const imgUrl = useMediaUrl({
    enabled: isPicture,
    cacheKey,
    browserFile: item.sourceRef?.browserFile,
    nativeKind: item.sourceRef?.kind,
    devicePath: item.sourceRef?.devicePath,
    data: item.data,
    mimeType: item.mimeType,
  });
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  const boxClass =
    size === 'xl'
      ? 'w-24 h-24'
      : size === 'lg'
        ? 'w-16 h-16'
        : size === 'md'
          ? 'w-12 h-12'
          : 'w-7 h-7';
  const iconClass =
    size === 'xl'
      ? 'w-9 h-9'
      : size === 'lg'
        ? 'w-7 h-7'
        : size === 'md'
          ? 'w-5 h-5'
          : 'w-4 h-4';

  if (isPicture && imgUrl && failedUrl !== imgUrl) {
    return (
      <img
        key={imgUrl}
        src={imgUrl}
        alt={item.filename}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailedUrl(imgUrl)}
        className={`${boxClass} rounded object-cover bg-[#11151C] border border-[#2A3446] shrink-0 transition-transform duration-150 group-hover:scale-105`}
      />
    );
  }

  return (
    <div
      className={`${boxClass} rounded bg-[#181E29] border border-[#2A3446] flex items-center justify-center shrink-0 transition-transform duration-150 group-hover:scale-105`}
    >
      {isPicture ? (
        <ImageIcon
          className={`${iconClass} ${
            item.status === 'OK_TRUNCATED' && !item.repaired ? 'text-amber-400' : 'text-sky-400'
          }`}
        />
      ) : item.family === 'Videos' ? (
        <Film className={`${iconClass} text-violet-400`} />
      ) : item.family === 'Documents' ? (
        <FileText className={`${iconClass} text-sky-400`} />
      ) : item.family === 'Audio' ? (
        <Music className={`${iconClass} text-rose-400`} />
      ) : item.family === 'Archives' ? (
        <Archive className={`${iconClass} text-emerald-400`} />
      ) : (
        <FileQuestion className={`${iconClass} text-slate-400`} />
      )}
    </div>
  );
};

function likelihoodBadgeClasses(tier: RecoveryLikelihoodTier) {
  if (tier === 'high') return { text: 'text-emerald-400', bar: 'bg-emerald-500' };
  if (tier === 'medium') return { text: 'text-amber-400', bar: 'bg-amber-500' };
  return { text: 'text-rose-400', bar: 'bg-rose-500' };
}

function getGroupLabel(item: ExplorerFileItem, groupBy: GroupByKey, nowMs: number): string {
  switch (groupBy) {
    case 'none':
      return '';
    case 'likelihood':
      return item.recoveryTier === 'high'
        ? 'High Health (85% – 100%)'
        : item.recoveryTier === 'medium'
          ? 'Fair Health (50% – 84%)'
          : 'Low Health (< 50%)';
    case 'type':
      return `${item.family} (.${item.extension.toUpperCase()})`;
    case 'origin':
      return item.partitionName;
    case 'date': {
      const ageHours = (nowMs - item.modifiedAt) / 3600000;
      if (ageHours <= 24) return 'Last 24 Hours';
      if (ageHours <= 120) return 'Earlier This Week';
      return 'Older Volume Snapshot';
    }
  }
}

function bytesToHexSample(bytes: Uint8Array, limit = 4096): string {
  const slice = bytes.subarray(0, limit);
  let out = '';
  for (let i = 0; i < slice.length; i++) {
    out += slice[i].toString(16).padStart(2, '0');
  }
  return out;
}

function hexSampleToBytes(hex?: string): Uint8Array {
  if (!hex || hex.length < 2) return new Uint8Array(0);
  const len = Math.floor(hex.length / 2);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  return out;
}

const EMPTY_DISK_BYTES = new Uint8Array(0);

export const App: React.FC = () => {
  const [activeScreen, setActiveScreen] = useState<'home' | 'explorer'>('home');
  const [diskName, setDiskName] = useState<string>('');
  const [diskBytes, setDiskBytes] = useState<Uint8Array>(EMPTY_DISK_BYTES);
  const [repairedDiskBytes, setRepairedDiskBytes] = useState<Uint8Array | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Explorer navigation state
  const [treeMode, setTreeMode] = useState<TreeMode>('type');
  const [selectedNode, setSelectedNode] = useState<SelectedTreeNode>({
    kind: 'family',
    family: 'Pictures',
  });
  const [navHistory, setNavHistory] = useState<SelectedTreeNode[]>([
    { kind: 'family', family: 'Pictures' },
  ]);
  const [navIndex, setNavIndex] = useState<number>(0);

  // View, sort, group & filter options
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [groupBy, setGroupBy] = useState<GroupByKey>('none');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [filterOpen, setFilterOpen] = useState<boolean>(false);
  const [recoveryOpen, setRecoveryOpen] = useState<boolean>(false);
  const [driveHubOpen, setDriveHubOpen] = useState<boolean>(false);
  const [lostModalOpen, setLostModalOpen] = useState<boolean>(false);
  const [lightboxOpen, setLightboxOpen] = useState<boolean>(false);
  const [scanBannerDismissed, setScanBannerDismissed] = useState<boolean>(false);
  const [sessionReferenceMs] = useState<number>(() => Date.now());

  // Scanner & PhotoRec options
  const [blockSize, setBlockSize] = useState<number>(512);
  const [paranoid, setParanoid] = useState<boolean>(true);
  const [keepCorrupted, setKeepCorrupted] = useState<boolean>(true);
  const [statusFilter, setStatusFilter] = useState<'all' | 'ok' | 'truncated'>('all');
  const [deletedFilter, setDeletedFilter] = useState<DeletedFilter>('all');
  const [likelihoodFilter, setLikelihoodFilter] = useState<'all' | RecoveryLikelihoodTier>('all');
  const [sizeFilter, setSizeFilter] = useState<'all' | 'small' | 'medium' | 'large'>('all');
  const [hideDuplicates, setHideDuplicates] = useState<boolean>(false);
  const [unallocatedOnly, setUnallocatedOnly] = useState<boolean>(false);
  const [gridThumbSize, setGridThumbSize] = useState<GridThumbSize>('md');
  const [capabilities, setCapabilities] = useState<EngineCapabilities | null>(null);
  const [scannedDevicePath, setScannedDevicePath] = useState<string | null>(null);
  const [enabledFormats, setEnabledFormats] = useState<Set<string>>(
    () => new Set(FILE_FORMATS.filter((f) => f.enableByDefault).map((f) => f.id)),
  );
  const [scanPartitionScope, setScanPartitionScope] = useState<string | null>(null);
  const [scanNonce, setScanNonce] = useState<number>(0);

  // Two-stage & execution state
  const [scanMode, setScanMode] = useState<ScanMode>('full');
  const [scanPhase, setScanPhase] = useState<'quick' | 'deep'>('quick');
  const [completedQuickOnly, setCompletedQuickOnly] = useState<boolean>(false);
  const [forceDeepRun, setForceDeepRun] = useState<boolean>(false);
  const [useNativeScan, setUseNativeScan] = useState<boolean>(false);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const isPausedRef = useRef<boolean>(false);
  const activeNativeScanIdRef = useRef<string | null>(null);
  const nativeDriveTargetRef = useRef<{
    devicePath: string;
    totalBytes: number;
    label: string;
  } | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgressState>({
    currentSector: 0,
    totalSectors: 1,
    percent: 0,
    foundCount: 0,
    foundBytes: 0,
  });

  // Discovered items + location scans ($Recycle.Bin / folders) + fidentify queue
  const [carvedItems, setCarvedItems] = useState<ExplorerFileItem[]>([]);
  const [locationItems, setLocationItems] = useState<ExplorerFileItem[]>([]);
  const [fidentifyItems, setFidentifyItems] = useState<ExplorerFileItem[]>([]);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const [focusedFileId, setFocusedFileId] = useState<string | null>(null);
  const [lostBannerDismissed, setLostBannerDismissed] = useState<boolean>(false);
  const [mbrActionNotice, setMbrActionNotice] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState<boolean>(false);
  const [recycleTargetMode, setRecycleTargetMode] = useState<boolean>(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    item: ExplorerFileItem;
  } | null>(null);

  const diskInputRef = useRef<HTMLInputElement>(null);
  const unknownInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const sessionInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    let active = true;
    bridge
      .getEngineCapabilities()
      .then((caps) => {
        if (active) setCapabilities(caps);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const handleRelaunchAsAdmin = useCallback(async () => {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    const res = await bridge.relaunchAsAdmin();
    if (!res.ok && res.error) {
      setLoadError(res.error);
    }
  }, []);

  const analysis = useMemo(
    () => analyzeDiskImage(diskName, diskBytes),
    [diskName, diskBytes],
  );

  const lostPartitions = useMemo(
    () => analysis.partitions.filter((p) => p.status === 'Deleted / Lost'),
    [analysis.partitions],
  );

  const bitlockerPartitions = useMemo(
    () => analysis.partitions.filter((p) => p.detectedFs?.encrypted === 'BitLocker'),
    [analysis.partitions],
  );

  const mapOffsetToPartition = useCallback(
    (offset: number): { partitionId: string; partitionName: string } => {
      const lba = Math.floor(offset / analysis.sectorSize);
      const hit = analysis.partitions.find((p) => lba >= p.startLba && lba <= p.endLba);
      if (hit) {
        const fs = hit.detectedFs?.filesystem ?? hit.typeName;
        const label =
          hit.status === 'Deleted / Lost'
            ? `Lost Partition (${fs})`
            : `${fs} (${hit.name})`;
        return { partitionId: hit.id, partitionName: label };
      }
      return { partitionId: 'unallocated', partitionName: 'Reconstructed' };
    },
    [analysis.partitions, analysis.sectorSize],
  );

  // Close context menu on outside click
  useEffect(() => {
    const onDown = () => {
      setContextMenu(null);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, []);

  // Two-Stage Async Scan for in-memory disk images (Quick metadata first, then live-streaming Deep Sector Carving)
  useEffect(() => {
    if (useNativeScan || diskBytes.length === 0) return;
    let cancelled = false;
    isPausedRef.current = false;

    const scopedPartition = scanPartitionScope
      ? analysis.partitions.find((p) => p.id === scanPartitionScope)
      : null;
    const startByte = scopedPartition ? scopedPartition.startOffset : 0;
    const endByte = scopedPartition
      ? Math.min(diskBytes.length, (scopedPartition.endLba + 1) * analysis.sectorSize)
      : diskBytes.length;

    const mapCarved = (c: CarvedFile): ExplorerFileItem => {
      const origin = mapOffsetToPartition(c.offset);
      const assessment = computeRecoveryLikelihood({
        status: c.status,
        size: c.size,
        calculatedSize: c.calculatedSize,
        partitionId: origin.partitionId,
        metadata: c.metadata,
        extension: c.extension,
        data: c.data,
      });
      return {
        id: c.id,
        filename: c.filename,
        extension: c.extension,
        family: c.family,
        mimeType: c.mimeType,
        size: c.size,
        calculatedSize: c.calculatedSize,
        status: c.status,
        sourceKind: 'carved',
        isDeleted: true,
        scanPhase: 'deep',
        partitionId: origin.partitionId,
        partitionName: origin.partitionName,
        offset: c.offset,
        sector: c.sector,
        matchedOffset: 0,
        matchedLength: 4,
        metadata: c.metadata,
        description: c.description,
        data: c.data,
        sourceRef: {
          kind: 'memory',
          offset: c.offset,
          size: c.size,
        },
        modifiedAt: c.metadata.takenAtMs ?? deriveCarvedTimestamp(c.sector, origin.partitionId),
        recoveryChance: assessment.chance,
        recoveryTier: assessment.tier,
        recoveryReason: assessment.reason,
        contentFingerprint: computeContentFingerprint(c.size, c.data),
        discoveryCrc32: c.discoveryCrc32,
      };
    };

    const run = async () => {
      const runFullDepth = scanMode === 'full' || forceDeepRun;
      setScanPhase('quick');
      setCompletedQuickOnly(false);

      // Stage 1: Fast Filesystem Metadata (NTFS $MFT + FAT32 + exFAT deleted + active records)
      const rawMftRecords = scanNtfsMftRecordsInBuffer(diskBytes, analysis.partitions, {
        includeExisting: true,
      }).filter((m) => !scopedPartition || m.partitionId === scopedPartition.id);
      const mftMapped: ExplorerFileItem[] = rawMftRecords.map((m) => {
        const res = m.reconstructedBytes.length > 0 ? identifyBuffer(m.reconstructedBytes) : null;
        const extHint = (m.filename.split('.').pop() || '').toLowerCase();
        const fallback = inferFallbackFromExt(extHint);
        const ext = res?.extension || extHint || 'bin';
        const family = res?.family ?? fallback.family;
        const mimeType = res?.mimeType ?? fallback.mimeType;
        const description = res?.description ?? fallback.description;
        const isResident = m.residentData !== null;
        const status: ExplorerFileItem['status'] = m.overwritten
          ? 'HEADER_ONLY'
          : isResident || m.reconstructedBytes.length >= m.fileSize
            ? 'OK'
            : m.reconstructedBytes.length > 0
              ? 'OK_TRUNCATED'
              : 'HEADER_ONLY';
        const assessment = computeRecoveryLikelihood({
          status,
          size: m.fileSize,
          calculatedSize: m.fileSize,
          partitionId: m.partitionId,
          metadata: res?.metadata ?? {},
          extension: ext,
          data: m.reconstructedBytes,
          mftResident: isResident,
          mftOverwritten: m.overwritten,
          mftBitmapIntact: m.bitmapChecked && !m.overwritten,
        });
        const bitmapNote = m.bitmapChecked
          ? m.overwritten
            ? ` · ${m.overwrittenClusters}/${m.totalClusters} clusters overwritten`
            : ' · $Bitmap verified intact'
          : '';
        return {
          id: `mft-${m.mftOffset}-${m.recordNumber}`,
          filename: m.filename,
          extension: ext,
          family,
          mimeType,
          size: m.fileSize,
          calculatedSize: m.fileSize,
          status,
          sourceKind: 'ntfs-mft',
          isDeleted: !m.inUse,
          scanPhase: 'quick',
          partitionId: m.partitionId,
          partitionName: m.partitionName,
          originalPath: m.reconstructedPath,
          offset: m.extents[0]?.offset ?? m.mftOffset,
          sector: Math.floor((m.extents[0]?.offset ?? m.mftOffset) / analysis.sectorSize),
          matchedOffset: res?.matchedOffset ?? 0,
          matchedLength: res?.matchedLength ?? 0,
          metadata: {
            ...(res?.metadata ?? {}),
            details: isResident
              ? `NTFS MFT Record #${m.recordNumber} (Resident Data)`
              : `NTFS MFT Record #${m.recordNumber} (${m.extents.length} extent${m.extents.length === 1 ? '' : 's'}${bitmapNote})`,
          },
          description,
          data: m.reconstructedBytes,
          sourceRef: {
            kind: 'memory',
            offset: m.extents[0]?.offset ?? m.mftOffset,
            size: m.fileSize,
            runs: m.extents.length > 0 ? m.extents : undefined,
          },
          modifiedAt: res?.metadata.takenAtMs ?? m.modifiedAtMs,
          recoveryChance: assessment.chance,
          recoveryTier: assessment.tier,
          recoveryReason: assessment.reason,
          contentFingerprint: computeContentFingerprint(m.fileSize, m.reconstructedBytes),
        };
      });

      const rawFatExfat = scanFatAndExfatDeletedInBuffer(diskBytes, analysis.partitions, {
        includeExisting: true,
      }).filter((f) => !scopedPartition || f.partitionId === scopedPartition.id);
      const fatExfatMapped: ExplorerFileItem[] = rawFatExfat.map((f) => {
        const res = f.reconstructedBytes.length > 0 ? identifyBuffer(f.reconstructedBytes) : null;
        const extHint = (f.filename.split('.').pop() || '').toLowerCase();
        const fallback = inferFallbackFromExt(extHint);
        const ext = res?.extension || extHint || 'bin';
        const family = res?.family ?? fallback.family;
        const mimeType = res?.mimeType ?? fallback.mimeType;
        const description = res?.description ?? fallback.description;
        const status: ExplorerFileItem['status'] = f.overwritten
          ? 'HEADER_ONLY'
          : f.reconstructedBytes.length >= f.fileSize
            ? 'OK'
            : f.reconstructedBytes.length > 0
              ? 'OK_TRUNCATED'
              : 'HEADER_ONLY';
        const assessment = computeRecoveryLikelihood({
          status,
          size: f.fileSize,
          calculatedSize: f.fileSize,
          partitionId: f.partitionId,
          metadata: res?.metadata ?? {},
          extension: ext,
          data: f.reconstructedBytes,
          mftOverwritten: f.overwritten,
          mftBitmapIntact: f.bitmapChecked && !f.overwritten,
        });
        return {
          id: f.id,
          filename: f.filename,
          extension: ext,
          family,
          mimeType,
          size: f.fileSize,
          calculatedSize: f.fileSize,
          status,
          sourceKind: 'ntfs-mft',
          isDeleted: f.isDeleted,
          scanPhase: 'quick',
          partitionId: f.partitionId,
          partitionName: f.partitionName,
          originalPath: f.reconstructedPath,
          offset: f.extents[0]?.offset ?? 0,
          sector: Math.floor((f.extents[0]?.offset ?? 0) / analysis.sectorSize),
          matchedOffset: res?.matchedOffset ?? 0,
          matchedLength: res?.matchedLength ?? 0,
          metadata: {
            ...(res?.metadata ?? {}),
            details: `${f.fsType} ${f.isDeleted ? 'deleted' : 'existing'} entry (${f.extents.length} cluster run${f.extents.length === 1 ? '' : 's'}${
              f.bitmapChecked ? (f.overwritten ? ' · cluster reallocated' : ' · bitmap intact') : ''
            })`,
          },
          description,
          data: f.reconstructedBytes,
          sourceRef: {
            kind: 'memory',
            offset: f.extents[0]?.offset ?? 0,
            size: f.fileSize,
            runs: f.extents.length > 0 ? f.extents : undefined,
          },
          modifiedAt: res?.metadata.takenAtMs ?? f.modifiedAtMs,
          recoveryChance: assessment.chance,
          recoveryTier: assessment.tier,
          recoveryReason: assessment.reason,
          contentFingerprint: computeContentFingerprint(f.fileSize, f.reconstructedBytes),
        };
      });

      const stage1Items = [...mftMapped, ...fatExfatMapped];
      if (cancelled) return;

      setCarvedItems(stage1Items);
      setFocusedFileId((cur) =>
        cur && stage1Items.some((x) => x.id === cur) ? cur : stage1Items[0]?.id ?? null,
      );

      if (!runFullDepth) {
        const totalSectors = Math.max(1, Math.floor(endByte / 512));
        setScanProgress({
          currentSector: totalSectors,
          totalSectors,
          percent: 100,
          foundCount: stage1Items.length,
          foundBytes: stage1Items.reduce((s, x) => s + x.size, 0),
        });
        setIsScanning(false);
        setIsPaused(false);
        setCompletedQuickOnly(true);
        return;
      }

      // Stage 2: Deep Sector Carving streaming batches smoothly while user browses & previews
      setScanPhase('deep');
      const stage1Offsets = new Set(stage1Items.map((i) => i.offset).filter((o) => o > 0));
      const stage1Bytes = stage1Items.reduce((s, x) => s + x.size, 0);
      const allocatedChecker = unallocatedOnly
        ? extractNtfsAllocatedChecker(diskBytes, analysis.partitions)
        : undefined;

      const results = await carveDiskBufferAsync(
        diskBytes,
        {
          startByte,
          endByte,
          blockSize,
          paranoid,
          keepCorrupted,
          unallocatedOnly,
          allocatedChecker,
          enabledFormats,
        },
        (prog) => {
          if (cancelled) return;
          setScanProgress({
            currentSector: prog.currentSector,
            totalSectors: prog.totalSectors,
            percent: prog.percent,
            foundCount: stage1Items.length + prog.foundCount,
            foundBytes: stage1Bytes + prog.foundBytes,
            latestFilename: prog.latestFile?.filename,
          });
        },
        {
          isCancelled: () => cancelled,
          isPaused: () => isPausedRef.current,
          onBatch: (batch) => {
            if (cancelled) return;
            const freshMapped = batch
              .filter((b) => !stage1Offsets.has(b.offset))
              .map(mapCarved);
            if (freshMapped.length === 0) return;
            setCarvedItems((prev) => {
              const seen = new Set(prev.map((x) => x.id));
              const add = freshMapped.filter((x) => !seen.has(x.id));
              return add.length > 0 ? [...prev, ...add] : prev;
            });
            setFocusedFileId((cur) => cur ?? freshMapped[0]?.id ?? null);
          },
        },
      );

      if (cancelled) return;

      const mapped = results.filter((b) => !stage1Offsets.has(b.offset)).map(mapCarved);
      const combined = [...stage1Items, ...mapped];
      setCarvedItems(combined);
      setIsScanning(false);
      setIsPaused(false);
      setCompletedQuickOnly(false);
      setFocusedFileId((cur) =>
        cur && combined.some((x) => x.id === cur) ? cur : combined[0]?.id ?? null,
      );
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [
    useNativeScan,
    diskBytes,
    blockSize,
    paranoid,
    keepCorrupted,
    unallocatedOnly,
    enabledFormats,
    scanNonce,
    scanMode,
    forceDeepRun,
    scanPartitionScope,
    analysis.partitions,
    analysis.sectorSize,
    mapOffsetToPartition,
  ]);

  const allItems = useMemo(
    () => [...carvedItems, ...locationItems, ...fidentifyItems],
    [carvedItems, locationItems, fidentifyItems],
  );

  const navigateToNode = useCallback(
    (node: SelectedTreeNode) => {
      setSelectedNode(node);
      if (node.kind === 'all-types' || node.kind === 'family' || node.kind === 'ext') {
        setTreeMode('type');
      } else {
        setTreeMode('path');
      }
      setNavHistory((prev) => {
        const sliced = prev.slice(0, navIndex + 1);
        const last = sliced[sliced.length - 1];
        if (last && treeNodeKey(last) === treeNodeKey(node)) return sliced;
        return [...sliced, node];
      });
      setNavIndex((idx) => idx + 1);
    },
    [navIndex],
  );

  const handleTreeModeChange = (mode: TreeMode) => {
    setTreeMode(mode);
    if (mode === 'path') {
      navigateToNode({ kind: 'disk-root' });
    } else {
      navigateToNode({ kind: 'all-types' });
    }
  };

  const handleNavBack = useCallback(() => {
    if (navIndex <= 0) return;
    const nextIdx = navIndex - 1;
    const target = navHistory[nextIdx];
    setNavIndex(nextIdx);
    setSelectedNode(target);
    if (target.kind === 'all-types' || target.kind === 'family' || target.kind === 'ext') {
      setTreeMode('type');
    } else {
      setTreeMode('path');
    }
  }, [navIndex, navHistory]);

  const handleNavForward = useCallback(() => {
    if (navIndex >= navHistory.length - 1) return;
    const nextIdx = navIndex + 1;
    const target = navHistory[nextIdx];
    setNavIndex(nextIdx);
    setSelectedNode(target);
    if (target.kind === 'all-types' || target.kind === 'family' || target.kind === 'ext') {
      setTreeMode('type');
    } else {
      setTreeMode('path');
    }
  }, [navIndex, navHistory]);

  const handleNavUp = () => {
    if (selectedNode.kind === 'ext') {
      navigateToNode({ kind: 'family', family: selectedNode.family });
    } else if (selectedNode.kind === 'family') {
      navigateToNode({ kind: 'all-types' });
    } else if (selectedNode.kind === 'folder-node') {
      const segs = selectedNode.folderPath.split('/').filter(Boolean);
      if (segs.length > 1) {
        navigateToNode({
          kind: 'folder-node',
          partitionId: selectedNode.partitionId,
          folderPath: segs.slice(0, -1).join('/'),
        });
      } else {
        navigateToNode({ kind: 'partition', partitionId: selectedNode.partitionId });
      }
    } else if (
      selectedNode.kind === 'partition' ||
      selectedNode.kind === 'unallocated' ||
      selectedNode.kind === 'ntfs-mft'
    ) {
      navigateToNode({ kind: 'disk-root' });
    }
  };

  const handleNavHome = () => {
    setActiveScreen('home');
  };

  const startFreshScanState = (bytes: Uint8Array, scopePartitionId?: string | null) => {
    if (bytes.length === 0) return;
    setActiveScreen('explorer');
    setUseNativeScan(false);
    setScannedDevicePath(null);
    nativeDriveTargetRef.current = null;
    isPausedRef.current = false;
    setIsPaused(false);
    setIsScanning(true);
    setForceDeepRun(false);
    setCompletedQuickOnly(false);
    setScanPhase('quick');
    setCarvedItems([]);
    setCheckedIds(new Set());
    setFocusedFileId(null);
    if (scopePartitionId !== undefined) {
      setScanPartitionScope(scopePartitionId);
    }
    setScanProgress({
      currentSector: 0,
      totalSectors: Math.max(1, Math.floor(bytes.length / 512)),
      percent: 0,
      foundCount: 0,
      foundBytes: 0,
    });
    setScanNonce((n) => n + 1);
  };

  const mapNativeEntryToExplorerItem = useCallback(
    (
      entry: NativeScannedEntry,
      partResolver?: (offset: number) => { partitionId: string; partitionName: string },
    ): ExplorerFileItem => {
      const sample =
        entry.headerSample instanceof Uint8Array
          ? entry.headerSample
          : new Uint8Array(entry.headerSample);
      const res = identifyBuffer(sample);
      const fallback = inferFallbackFromExt(entry.extensionHint);

      const isLocationItem =
        entry.sourceKind === 'recycle-bin' || entry.sourceKind === 'folder';
      const isMftItem = entry.sourceKind === 'ntfs-mft';
      const ext = res?.extension || entry.extensionHint || 'bin';
      const family = res?.family ?? fallback.family;
      const mimeType = res?.mimeType ?? fallback.mimeType;
      const description = res?.description ?? fallback.description;

      const sampledFullFile = entry.size <= sample.length;
      const status: ExplorerFileItem['status'] = isMftItem
        ? entry.mftOverwritten
          ? 'HEADER_ONLY'
          : entry.truncated
            ? 'OK_TRUNCATED'
            : 'OK'
        : entry.sourceKind === 'carved'
          ? entry.truncated
            ? 'OK_TRUNCATED'
            : 'OK'
          : res
            ? sampledFullFile
              ? res.status
              : 'OK'
            : entry.size > 0
              ? 'OK'
              : 'HEADER_ONLY';

      const calculatedSize =
        entry.sourceKind === 'carved' || isMftItem
          ? (entry.calculatedSize ?? res?.calculatedSize ?? entry.size)
          : sampledFullFile
            ? (res?.calculatedSize ?? entry.size)
            : entry.size;

      const origin =
        entry.sourceKind === 'recycle-bin'
          ? { partitionId: 'recycle-bin', partitionName: 'Windows Recycle Bin ($Recycle.Bin)' }
          : entry.sourceKind === 'folder'
            ? { partitionId: 'folder-scan', partitionName: entry.originalPath || 'Scanned Folder' }
            : (partResolver ? partResolver(entry.offset) : mapOffsetToPartition(entry.offset));

      const assessment = computeRecoveryLikelihood({
        status,
        size: entry.size,
        calculatedSize,
        partitionId: origin.partitionId,
        metadata: res?.metadata ?? {},
        extension: ext,
        data: sample,
        mftResident: entry.mftResident,
        mftOverwritten: entry.mftOverwritten,
        mftBitmapIntact: entry.mftBitmapIntact,
      });

      return {
        id: entry.id,
        filename: entry.filename,
        extension: ext,
        family,
        mimeType,
        size: entry.size,
        calculatedSize,
        status,
        sourceKind: entry.sourceKind,
        isDeleted: entry.isDeleted,
        scanPhase: entry.scanPhase,
        partitionId: origin.partitionId,
        partitionName: origin.partitionName,
        originalPath: entry.originalPath,
        offset: entry.offset,
        sector: entry.sector,
        matchedOffset: res?.matchedOffset ?? 0,
        matchedLength: res?.matchedLength ?? 0,
        metadata: res?.metadata ?? {
          details: isLocationItem
            ? `Streamed handle (${formatBytes(entry.size)})`
            : isMftItem
              ? `${entry.isDeleted === false ? 'Existing' : 'Deleted'} filesystem record (${entry.runs?.length ?? 0} extent${entry.runs?.length === 1 ? '' : 's'})`
              : 'Streamed disk signature',
        },
        description,
        data: sample,
        sourceRef: {
          kind: entry.tskInode
            ? 'native-tsk'
            : isMftItem
              ? entry.runs && entry.runs.length > 0
                ? 'native-runs'
                : entry.mftResident
                  ? 'memory'
                  : 'native-device'
              : entry.sourceKind === 'carved'
                ? 'native-device'
                : 'native-file',
          devicePath: entry.devicePath,
          offset: entry.offset,
          size: entry.size,
          runs: entry.runs,
          tskInode: entry.tskInode,
          tskOffset: entry.tskOffset,
        },
        modifiedAt: res?.metadata.takenAtMs ?? (entry.modifiedAt || Date.now()),
        recoveryChance: assessment.chance,
        recoveryTier: assessment.tier,
        recoveryReason: assessment.reason,
        contentFingerprint: computeContentFingerprint(entry.size, sample),
        discoveryCrc32: entry.discoveryCrc32,
      };
    },
    [mapOffsetToPartition],
  );

  const runNativeStreamingScan = async (
    devicePath: string,
    totalBytes: number,
    label: string,
    overrideScanMode?: ScanMode,
    overrideStartPhase?: 'quick' | 'deep',
  ) => {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    setLoadError(null);
    setMbrActionNotice(null);

    if (activeNativeScanIdRef.current) {
      await bridge.cancelDriveScan(activeNativeScanIdRef.current).catch(() => {});
    }

    const effectiveMode = overrideScanMode ?? scanMode;
    const effectiveStartPhase = overrideStartPhase ?? 'quick';

    const headLimit = Math.min(totalBytes || 1024 * 1024, 1024 * 1024);
    const headBytes = await bridge.readDiskBytes(devicePath, 0, headLimit);
    const localAnalysis = analyzeDiskImage(label, headBytes);
    const resolveLocalPart = (offset: number) => {
      const lba = Math.floor(offset / localAnalysis.sectorSize);
      const hit = localAnalysis.partitions.find((p) => lba >= p.startLba && lba <= p.endLba);
      if (hit) {
        const fs = hit.detectedFs?.filesystem ?? hit.typeName;
        return {
          partitionId: hit.id,
          partitionName:
            hit.status === 'Deleted / Lost' ? `Lost Partition (${fs})` : `${fs} (${hit.name})`,
        };
      }
      return { partitionId: 'unallocated', partitionName: 'Reconstructed' };
    };

    const scanId = `scan-${Date.now()}`;
    activeNativeScanIdRef.current = scanId;
    nativeDriveTargetRef.current = { devicePath, totalBytes, label };
    setScannedDevicePath(devicePath);

    setActiveScreen('explorer');
    setUseNativeScan(true);
    setDiskName(label);
    setDiskBytes(headBytes);
    setRepairedDiskBytes(null);
    setLostBannerDismissed(false);
    setIsScanning(true);
    setIsPaused(false);
    setCompletedQuickOnly(false);
    setScanPhase(effectiveStartPhase);
    if (effectiveStartPhase !== 'deep') {
      setCarvedItems([]);
      setCheckedIds(new Set());
      setFocusedFileId(null);
    }
    setScanProgress({
      currentSector: 0,
      totalSectors: Math.max(1, Math.floor(totalBytes / 512)),
      percent: 0,
      foundCount: 0,
      foundBytes: 0,
    });

    const unsubProgress = bridge.onDriveScanProgress((ev) => {
      if (ev.scanId !== scanId) return;
      if (ev.phase) setScanPhase(ev.phase);
      setScanProgress({
        currentSector: Math.floor(ev.currentBytes / 512),
        totalSectors: Math.max(1, Math.floor(ev.totalBytes / 512)),
        percent: ev.percent,
        foundCount: ev.foundCount,
        foundBytes: ev.foundBytes,
        latestFilename: ev.latestName,
      });
    });

    const unsubBatch = bridge.onDriveScanBatch((batchEv) => {
      if (batchEv.scanId !== scanId || batchEv.entries.length === 0) return;
      const incoming = batchEv.entries.map((e) =>
        mapNativeEntryToExplorerItem(e, resolveLocalPart),
      );
      setCarvedItems((prev) => {
        const existingIds = new Set(prev.map((x) => x.id));
        const fresh = incoming.filter((x) => !existingIds.has(x.id));
        return fresh.length > 0 ? [...prev, ...fresh] : prev;
      });
      setFocusedFileId((cur) => cur ?? incoming[0]?.id ?? null);
    });

    const hasLostOnTarget = localAnalysis.partitions.some(
      (p) => p.status === 'Deleted / Lost',
    );
    if (hasLostOnTarget) {
      setLostModalOpen(true);
    }

    try {
      const entries = await bridge.startDriveScan({
        scanId,
        devicePath,
        totalBytes,
        blockSize,
        scanMode: effectiveMode,
        startPhase: effectiveStartPhase,
        unallocatedOnly,
        includeExisting: true,
      });
      if (activeNativeScanIdRef.current !== scanId) return;
      const mapped = entries.map((e) => mapNativeEntryToExplorerItem(e, resolveLocalPart));
      setCarvedItems((prev) => {
        if (effectiveStartPhase === 'deep' && prev.length > 0) {
          const seen = new Set(prev.map((x) => x.id));
          const fresh = mapped.filter((x) => !seen.has(x.id));
          return [...prev, ...fresh];
        }
        return mapped;
      });
      setIsScanning(false);
      setCompletedQuickOnly(effectiveMode === 'quick');
      setFocusedFileId((cur) => (cur && mapped.some((x) => x.id === cur) ? cur : cur ?? mapped[0]?.id ?? null));
    } finally {
      unsubProgress();
      unsubBatch();
      if (activeNativeScanIdRef.current === scanId) {
        activeNativeScanIdRef.current = null;
      }
    }
  };

  const handleOpenDiskImage = async (file: File | undefined) => {
    if (!file) return;
    setLoadError(null);
    setMbrActionNotice(null);
    if (file.size > 256 * 1024 * 1024) {
      setLoadError(
        `Image "${file.name}" exceeds the 256 MiB browser memory limit. In the Windows .exe, use "Select Drive / Image" for multi-GB streaming.`,
      );
      return;
    }
    const buf = new Uint8Array(await file.arrayBuffer());
    const localCheck = analyzeDiskImage(file.name, buf);
    setDiskName(file.name);
    setDiskBytes(buf);
    setRepairedDiskBytes(null);
    setLostBannerDismissed(false);
    setScanBannerDismissed(false);
    if (localCheck.partitions.some((p) => p.status === 'Deleted / Lost')) {
      setLostModalOpen(true);
    }
    startFreshScanState(buf, null);
  };

  const handleOpenDiskPicker = async () => {
    const bridge = getDesktopBridge();
    if (!bridge) {
      diskInputRef.current?.click();
      return;
    }
    const picked = await bridge.pickDiskImage();
    if (!picked) return;
    try {
      if (picked.sizeBytes > 128 * 1024 * 1024) {
        await runNativeStreamingScan(picked.path, picked.sizeBytes, picked.name);
      } else {
        const bytes = await bridge.readDiskBytes(picked.path, 0, picked.sizeBytes);
        const localCheck = analyzeDiskImage(picked.name, bytes);
        setDiskName(picked.name);
        setDiskBytes(bytes);
        setRepairedDiskBytes(null);
        setLostBannerDismissed(false);
        setScanBannerDismissed(false);
        if (localCheck.partitions.some((p) => p.status === 'Deleted / Lost')) {
          setLostModalOpen(true);
        }
        startFreshScanState(bytes, null);
      }
    } catch {
      setLoadError(`Could not open disk image "${picked.name}".`);
    }
  };

  const handleOpenPhysicalDrive = async (drive: WindowsDriveInfo) => {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    try {
      const label =
        drive.letters.length > 0 ? `${drive.name} (${drive.letters.join(', ')})` : drive.name;
      await runNativeStreamingScan(drive.devicePath, drive.sizeBytes, label);
    } catch {
      setLoadError(
        `Could not read ${drive.devicePath}. Make sure you launched TestDisk-PhotoRec.exe as Administrator.`,
      );
      setIsScanning(false);
    }
  };

  const handleScanFolder = async () => {
    const bridge = getDesktopBridge();
    setLoadError(null);
    setMbrActionNotice(null);
    if (!bridge) {
      setRecycleTargetMode(false);
      folderInputRef.current?.click();
      return;
    }
    try {
      const folderPath = await bridge.pickFolder();
      if (!folderPath) return;
      const res = await bridge.scanFolder(folderPath);
      const mapped = res.entries.map((e) => mapNativeEntryToExplorerItem(e));
      if (!diskName) setDiskName(folderPath);
      setLocationItems((prev) => [
        ...mapped,
        ...prev.filter((i) => i.sourceKind !== 'folder'),
      ]);
      setFocusedFileId(mapped[0]?.id ?? null);
      setActiveScreen('explorer');
      navigateToNode({ kind: 'folder-scan' });
      if (res.deletedLookupStatus === 'needs-admin') {
        setMbrActionNotice(
          `Indexed ${mapped.length} live/Shadow Copy files in "${folderPath}". Run as Administrator to also inspect deleted $MFT / $UsnJrnl records on ${res.backingDrive || 'the backing drive'}.`,
        );
      } else if (mapped.length === 0) {
        setMbrActionNotice(`No files found inside "${folderPath}".`);
      }
    } catch {
      setLoadError('Could not read the selected folder.');
    }
  };

  const handleScanDesktop = async () => {
    const bridge = getDesktopBridge();
    setLoadError(null);
    setMbrActionNotice(null);
    if (!bridge) {
      setRecycleTargetMode(false);
      folderInputRef.current?.click();
      return;
    }
    try {
      const res = await bridge.scanDesktop();
      const mapped = res.entries.map((e) => mapNativeEntryToExplorerItem(e));
      if (!diskName) setDiskName(res.path || 'Desktop');
      setLocationItems((prev) => [
        ...mapped,
        ...prev.filter((i) => i.sourceKind !== 'folder'),
      ]);
      setFocusedFileId(mapped[0]?.id ?? null);
      setActiveScreen('explorer');
      navigateToNode({ kind: 'folder-scan' });
      if (res.deletedLookupStatus === 'needs-admin') {
        setMbrActionNotice(
          `Indexed ${mapped.length} Desktop / Shadow Copy files. Run as Administrator to also search emptied deleted files on ${res.backingDrive || 'the backing drive'}.`,
        );
      } else if (mapped.length === 0) {
        setMbrActionNotice('No files found inside Windows Desktop.');
      }
    } catch {
      setLoadError('Could not read the Windows Desktop folder.');
    }
  };

  const handleScanRecycleBin = async () => {
    const bridge = getDesktopBridge();
    setLoadError(null);
    setMbrActionNotice(null);
    if (!bridge) {
      setRecycleTargetMode(true);
      folderInputRef.current?.click();
      return;
    }
    try {
      const res = await bridge.scanRecycleBin();
      const mapped = res.entries.map((e) => mapNativeEntryToExplorerItem(e));
      if (!diskName) setDiskName('Recycle Bin ($Recycle.Bin)');
      setLocationItems((prev) => [
        ...mapped,
        ...prev.filter((i) => i.sourceKind !== 'recycle-bin'),
      ]);
      setFocusedFileId(mapped[0]?.id ?? null);
      setActiveScreen('explorer');
      navigateToNode({ kind: 'recycle-bin' });
      if (res.deletedLookupStatus === 'needs-admin') {
        setMbrActionNotice(
          `Found ${mapped.length} items currently in $Recycle.Bin. Run as Administrator to scan emptied Recycle Bin entries via $MFT / $UsnJrnl on ${res.backingDrive || 'the physical drive'}.`,
        );
      } else if (mapped.length === 0) {
        setMbrActionNotice(
          'No deleted items found in Windows $Recycle.Bin.',
        );
      }
    } catch {
      setLoadError(
        'Could not scan Windows $Recycle.Bin. Try launching TestDisk-PhotoRec.exe as Administrator.',
      );
    }
  };

  const handleBrowserFolderSelected = async (fileList: FileList) => {
    const allFiles = Array.from(fileList).slice(0, 5000);
    if (allFiles.length === 0) return;
    setLoadError(null);
    setMbrActionNotice(null);

    const hasRecyclePairs = allFiles.some(
      (f) => f.name.startsWith('$I') || f.name.startsWith('$R') || f.webkitRelativePath.includes('$Recycle.Bin'),
    );
    const isRecycle = recycleTargetMode || hasRecyclePairs;

    // 1. Parse all $Ixxxxxx Recycle Bin metadata records (tiny files)
    const iMetaByKey = new Map<string, RecycleBinMeta>();
    for (const file of allFiles) {
      if (file.name.startsWith('$I') && file.size <= 65536) {
        const buf = new Uint8Array(await file.arrayBuffer());
        const meta = parseWindowsRecycleIFile(buf);
        if (meta) {
          const dir = file.webkitRelativePath.split('/').slice(0, -1).join('/');
          iMetaByKey.set(`${dir}::${file.name.slice(2)}`, meta);
        }
      }
    }

    // 2. Scan payload files reading ONLY 64 KB headers (zero RAM blowup for multi-GB .mp4 videos)
    const added: ExplorerFileItem[] = [];
    for (const file of allFiles) {
      if (hasRecyclePairs && file.name.startsWith('$I')) continue;
      if (file.name === 'desktop.ini') continue;

      const parts = (file.webkitRelativePath || file.name).split('/');
      const relDir = parts.slice(0, -1).join('/');
      const key = `${relDir}::${file.name.startsWith('$R') ? file.name.slice(2) : file.name}`;
      let recycleMeta = file.name.startsWith('$R') ? iMetaByKey.get(key) : undefined;
      let restoredOriginalPath = recycleMeta?.originalPath;

      // Resolve nested deleted $Rxxxxxx folder paths (RecoveryShared::ResolveRecyclePaths)
      if (!recycleMeta && parts.length > 2) {
        for (let idx = parts.length - 2; idx >= 0; idx--) {
          if (parts[idx].startsWith('$R') && parts[idx].length > 2) {
            const ancestorDir = parts.slice(0, idx).join('/');
            const folderMeta = iMetaByKey.get(`${ancestorDir}::${parts[idx].slice(2)}`);
            if (folderMeta) {
              recycleMeta = folderMeta;
              const subRel = parts.slice(idx + 1).join('\\');
              restoredOriginalPath = folderMeta.originalPath
                ? `${folderMeta.originalPath}\\${subRel}`
                : subRel;
              break;
            }
          }
        }
      }

      const displayName =
        recycleMeta && file.name.startsWith('$R')
          ? recycleMeta.originalName || file.name
          : file.name;
      const extHint = (displayName.split('.').pop() || '').toLowerCase();

      const headerSample = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
      const res = identifyBuffer(headerSample);
      const fallback = inferFallbackFromExt(extHint);

      const ext = res?.extension || extHint || 'bin';
      const family = res?.family ?? fallback.family;
      const mimeType = res?.mimeType ?? fallback.mimeType;
      const description = res?.description ?? fallback.description;
      const sampledFull = file.size <= headerSample.length;
      const status: ExplorerFileItem['status'] = res
        ? sampledFull
          ? res.status
          : 'OK'
        : file.size > 0
          ? 'OK'
          : 'HEADER_ONLY';
      const calculatedSize = sampledFull ? (res?.calculatedSize ?? file.size) : file.size;

      const sourceKind: ExplorerFileItem['sourceKind'] = isRecycle ? 'recycle-bin' : 'folder';
      const partitionId = isRecycle ? 'recycle-bin' : 'folder-scan';
      const partitionName = restoredOriginalPath
        ? `Recycle Bin (${restoredOriginalPath})`
        : isRecycle
          ? 'Recycle Bin ($Recycle.Bin)'
          : file.webkitRelativePath || 'Scanned Folder';

      const assessment = computeRecoveryLikelihood({
        status,
        size: file.size,
        calculatedSize,
        partitionId,
        metadata: res?.metadata ?? {},
        extension: ext,
        data: headerSample,
      });

      added.push({
        id: `${sourceKind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        filename: displayName,
        extension: ext,
        family,
        mimeType,
        size: file.size,
        calculatedSize,
        status,
        sourceKind,
        isDeleted: isRecycle,
        scanPhase: 'quick',
        partitionId,
        partitionName,
        originalPath: restoredOriginalPath || file.webkitRelativePath || displayName,
        offset: 0,
        sector: 0,
        matchedOffset: res?.matchedOffset ?? 0,
        matchedLength: res?.matchedLength ?? 0,
        metadata: res?.metadata ?? {
          details: `Streamed browser file (${formatBytes(file.size)})`,
        },
        description,
        data: headerSample,
        sourceRef: {
          kind: 'browser-file',
          offset: 0,
          size: file.size,
          browserFile: file,
        },
        modifiedAt: res?.metadata.takenAtMs ?? recycleMeta?.deletedAtMs ?? (file.lastModified || Date.now()),
        recoveryChance: assessment.chance,
        recoveryTier: assessment.tier,
        recoveryReason: assessment.reason,
        contentFingerprint: computeContentFingerprint(file.size, headerSample),
      });
    }

    if (!diskName) {
      setDiskName(isRecycle ? 'Recycle Bin ($Recycle.Bin)' : 'Scanned Folder');
    }
    setLocationItems((prev) => [
      ...added,
      ...prev.filter((i) => i.sourceKind !== (isRecycle ? 'recycle-bin' : 'folder')),
    ]);
    setScanProgress({
      currentSector: added.length,
      totalSectors: Math.max(1, added.length),
      percent: 100,
      foundCount: added.length,
      foundBytes: added.reduce((s, f) => s + f.size, 0),
    });
    setFocusedFileId(added[0]?.id ?? null);
    setActiveScreen('explorer');
    navigateToNode(isRecycle ? { kind: 'recycle-bin' } : { kind: 'folder-scan' });
  };

  const handleInspectUnknownFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    const bridge = getDesktopBridge();
    const unknownPaths: string[] = [];
    const staged: { file: File; buf: Uint8Array; res: ReturnType<typeof identifyBuffer>; nativePath?: string }[] = [];

    for (const file of list) {
      const readCap = Math.min(file.size, 32 * 1024 * 1024);
      const buf = new Uint8Array(await file.slice(0, readCap).arrayBuffer());
      const res = identifyBuffer(buf);
      const nativePath = (file as File & { path?: string }).path;
      if (!res && bridge && nativePath) {
        unknownPaths.push(nativePath);
      }
      staged.push({ file, buf, res, nativePath });
    }

    let nativeIdMap: Record<string, string> = {};
    if (bridge && unknownPaths.length > 0) {
      nativeIdMap = await bridge.identifyFilesNative(unknownPaths).catch(() => ({}));
    }

    const added: ExplorerFileItem[] = [];
    for (const { file, buf, res, nativePath } of staged) {
      const nativeExt = nativePath ? nativeIdMap[nativePath] : undefined;
      const detectedExt = res?.extension || (nativeExt && nativeExt !== 'unknown' ? nativeExt : undefined);
      const fallback = detectedExt ? inferFallbackFromExt(detectedExt) : null;
      const sampledFull = file.size <= buf.length;
      const status = res
        ? sampledFull
          ? res.status
          : 'OK'
        : detectedExt
          ? 'OK'
          : 'UNKNOWN';
      const calculatedSize = sampledFull ? (res?.calculatedSize ?? null) : file.size;
      const assessment = computeRecoveryLikelihood({
        status,
        size: file.size,
        calculatedSize,
        partitionId: 'fidentify',
        metadata: res?.metadata ?? {},
        extension: detectedExt ?? 'unknown',
        data: buf,
      });
      const resolvedExt = detectedExt ?? 'unknown';
      const preferredName =
        resolvedExt !== 'unknown'
          ? resolvePreferredExtension(file.name, resolvedExt)
          : file.name;
      added.push({
        id: `fid-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        filename: preferredName,
        extension: resolvedExt,
        family: res?.family ?? fallback?.family ?? 'Others',
        mimeType: res?.mimeType ?? fallback?.mimeType ?? 'application/octet-stream',
        size: file.size,
        calculatedSize,
        status,
        sourceKind: 'fidentify',
        partitionId: 'fidentify',
        partitionName: 'Unknown Files (fidentify)',
        offset: 0,
        sector: 0,
        matchedOffset: res?.matchedOffset ?? 0,
        matchedLength: res?.matchedLength ?? 0,
        metadata: res?.metadata ?? {
          details: detectedExt
            ? `Identified via bundled PhotoRec fidentify (.${detectedExt})`
            : 'Unrecognized binary header',
        },
        description:
          res?.description ??
          fallback?.description ??
          'Unrecognized binary signature',
        data: buf,
        sourceRef: {
          kind: 'browser-file',
          offset: 0,
          size: file.size,
          browserFile: file,
        },
        modifiedAt: res?.metadata.takenAtMs ?? (file.lastModified || Date.now()),
        recoveryChance: assessment.chance,
        recoveryTier: assessment.tier,
        recoveryReason: detectedExt && !res
          ? `Identified via PhotoRec fidentify (.${detectedExt})`
          : assessment.reason,
        contentFingerprint: computeContentFingerprint(file.size, buf),
      });
    }

    if (!diskName) setDiskName('File Identification');
    setFidentifyItems((prev) => [...added, ...prev]);
    setFocusedFileId(added[0].id);
    setActiveScreen('explorer');
    navigateToNode({ kind: 'fidentify' });
  };

  const handleRestorePartitionToMbr = (targetPart?: PartitionEntry) => {
    const activeEntries = analysis.partitions.filter((p) => p.status !== 'Deleted / Lost');
    const toRestore = targetPart ? [targetPart] : lostPartitions;
    const merged = [...activeEntries, ...toRestore]
      .filter((p, idx, arr) => arr.findIndex((x) => x.startLba === p.startLba) === idx)
      .sort((a, b) => a.startLba - b.startLba)
      .slice(0, 4);

    const patched = writeMbrPartitionTable(diskBytes, merged);
    setDiskBytes(patched);
    setRepairedDiskBytes(patched);
    setLostBannerDismissed(true);
    setMbrActionNotice(
      `Partition table patched in memory (${merged.length} primary MBR entries). Export the repaired .img or recover files.`,
    );
  };

  const handleRepairFile = async (
    target: ExplorerFileItem,
    referenceBytes?: Uint8Array,
  ): Promise<void> => {
    let sourceBytes = target.data;
    if (
      target.sourceRef?.browserFile &&
      sourceBytes.length < target.sourceRef.browserFile.size
    ) {
      sourceBytes = new Uint8Array(await target.sourceRef.browserFile.arrayBuffer());
    }

    const bridge = getDesktopBridge();
    let repairedData: Uint8Array | null = null;
    let repairNote = '';

    if (bridge) {
      const isNative =
        target.sourceRef &&
        ['native-device', 'native-runs', 'native-file', 'native-tsk'].includes(
          target.sourceRef.kind,
        );
      const ipcRes = await bridge
        .repairMediaFile({
          filename: target.filename,
          extension: target.extension,
          sourceKind: isNative ? (target.sourceRef?.kind as 'native-file') : 'memory',
          filePath:
            target.sourceRef?.kind === 'native-file'
              ? target.sourceRef.devicePath
              : undefined,
          devicePath: target.sourceRef?.devicePath,
          offset: target.sourceRef?.offset,
          size: target.sourceRef?.size,
          runs: target.sourceRef?.runs,
          tskInode: target.sourceRef?.tskInode,
          tskOffset: target.sourceRef?.tskOffset,
          buffer: isNative ? undefined : sourceBytes,
          referenceBuffer: referenceBytes,
          allowTranscodeFallback: true,
        })
        .catch(() => null);

      if (ipcRes?.ok && ipcRes.repairedBytes) {
        repairedData =
          ipcRes.repairedBytes instanceof Uint8Array
            ? ipcRes.repairedBytes
            : new Uint8Array(ipcRes.repairedBytes);
        repairNote = ipcRes.note;
      }
    }

    if (!repairedData) {
      const rep = repairFileBuffer(target.extension, sourceBytes, referenceBytes);
      if (!rep.repaired) return;
      repairedData = rep.data;
      repairNote = rep.note;
    }

    const assessment = computeRecoveryLikelihood({
      status: 'OK',
      size: repairedData.length,
      calculatedSize: repairedData.length,
      partitionId: target.partitionId,
      metadata: target.metadata,
      extension: target.extension,
      data: repairedData,
      repaired: true,
    });
    const updater = (list: ExplorerFileItem[]) =>
      list.map((item) =>
        item.id === target.id
          ? {
              ...item,
              data: repairedData!,
              size: repairedData!.length,
              calculatedSize: repairedData!.length,
              status: 'OK' as const,
              repaired: true,
              sourceRef: {
                kind: 'memory' as const,
                offset: 0,
                size: repairedData!.length,
              },
              recoveryChance: assessment.chance,
              recoveryTier: assessment.tier,
              recoveryReason: repairNote,
            }
          : item,
      );
    setCarvedItems(updater);
    setLocationItems(updater);
    setFidentifyItems(updater);
  };

  const handleDownloadRepairedImg = () => {
    const src = repairedDiskBytes ?? diskBytes;
    const blob = new Blob([src.slice().buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = diskName.replace(/(\.[^.]+)?$/, '_repaired$1');
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadSingleFile = async (item: ExplorerFileItem) => {
    const bridge = getDesktopBridge();
    const outName = resolvePreferredExtension(item.filename, item.extension);
    if (
      !item.repaired &&
      bridge &&
      item.sourceRef &&
      (item.sourceRef.kind === 'native-device' ||
        item.sourceRef.kind === 'native-runs' ||
        item.sourceRef.kind === 'native-file' ||
        item.sourceRef.kind === 'native-tsk')
    ) {
      await bridge.recoverFilesToFolder({
        destinationDir: null,
        scannedDevicePath: scannedDevicePath ?? undefined,
        items: [
          {
            filename: outName,
            folder: item.family,
            sourceKind: item.sourceRef.kind,
            devicePath: item.sourceRef.devicePath,
            offset: item.sourceRef.offset,
            size: item.sourceRef.size,
            runs: item.sourceRef.runs,
            tskInode: item.sourceRef.tskInode,
            tskOffset: item.sourceRef.tskOffset,
            discoveryCrc32: item.discoveryCrc32,
            extension: item.extension,
            repairIfTruncated: item.status === 'OK_TRUNCATED',
            modifiedAtMs: item.modifiedAt,
          },
        ],
      });
      return;
    }

    const blob =
      item.repaired || !item.sourceRef?.browserFile
        ? new Blob([item.data.slice().buffer], { type: item.mimeType })
        : item.sourceRef.browserFile;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = outName;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Filter + Sort visible center pane files
  const visibleItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = allItems.filter((item) => {
      if (!itemMatchesNode(item, selectedNode)) return false;
      if (deletedFilter === 'deleted' && item.isDeleted === false) return false;
      if (deletedFilter === 'existing' && item.isDeleted !== false) return false;
      if (statusFilter === 'ok' && item.status !== 'OK') return false;
      if (statusFilter === 'truncated' && item.status === 'OK') return false;
      if (likelihoodFilter !== 'all' && item.recoveryTier !== likelihoodFilter) return false;
      if (sizeFilter === 'small' && item.size >= 2048) return false;
      if (sizeFilter === 'medium' && (item.size < 2048 || item.size > 102400)) return false;
      if (sizeFilter === 'large' && item.size <= 102400) return false;
      if (q) {
        const hay = `${item.filename} ${item.extension} ${item.partitionName} ${item.description}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    filtered.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'name':
          cmp = a.filename.localeCompare(b.filename);
          break;
        case 'date':
          cmp = a.modifiedAt - b.modifiedAt;
          break;
        case 'origin':
          cmp = a.partitionName.localeCompare(b.partitionName);
          break;
        case 'type':
          cmp = a.extension.localeCompare(b.extension);
          break;
        case 'size':
          cmp = a.size - b.size;
          break;
        case 'likelihood':
          cmp = a.recoveryChance - b.recoveryChance;
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

    if (!hideDuplicates) return filtered;

    const seen = new Set<string>();
    const deduped: ExplorerFileItem[] = [];
    for (const item of filtered) {
      const fp = item.contentFingerprint;
      if (fp) {
        if (seen.has(fp)) continue;
        seen.add(fp);
      }
      deduped.push(item);
    }
    return deduped;
  }, [
    allItems,
    selectedNode,
    deletedFilter,
    statusFilter,
    likelihoodFilter,
    sizeFilter,
    hideDuplicates,
    searchQuery,
    sortKey,
    sortDir,
  ]);

  const handleExportCsv = async () => {
    const exportItems = visibleItems.length > 0 ? visibleItems : allItems;
    if (exportItems.length === 0) return;
    const csv = buildCsvReport(exportItems, diskName || 'Disk');
    const baseName = diskName.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/\.[^.]+$/, '');
    const defaultName = `${baseName || 'recovery'}_inventory.csv`;
    const bridge = getDesktopBridge();
    if (bridge) {
      const res = await bridge.saveTextReport({
        defaultName,
        title: 'Export Recovery Inventory CSV',
        filters: [{ name: 'CSV Spreadsheet', extensions: ['csv'] }],
        content: csv,
      });
      if (!res.canceled && res.filePath) {
        setMbrActionNotice(`CSV inventory exported to ${res.filePath}`);
      }
      return;
    }
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportDfxml = async () => {
    const exportItems = visibleItems.length > 0 ? visibleItems : allItems;
    if (exportItems.length === 0) return;
    const xml = buildDfxmlReport({
      diskName,
      diskSizeBytes: analysis.diskSizeBytes,
      items: exportItems,
    });
    const baseName = diskName.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/\.[^.]+$/, '');
    const defaultName = `${baseName || 'recovery'}_report.dfxml.xml`;
    const bridge = getDesktopBridge();
    if (bridge) {
      const res = await bridge.saveTextReport({
        defaultName,
        title: 'Export DFXML Forensic Report',
        filters: [{ name: 'DFXML Report', extensions: ['xml', 'dfxml'] }],
        content: xml,
      });
      if (!res.canceled && res.filePath) {
        setMbrActionNotice(`DFXML report exported to ${res.filePath}`);
      }
      return;
    }
    const blob = new Blob([xml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportSession = async () => {
    if (allItems.length === 0) return;
    const serialized: SerializedScanSessionItem[] = allItems.slice(0, 5000).map((item) => ({
      id: item.id,
      filename: item.filename,
      extension: item.extension,
      family: item.family,
      mimeType: item.mimeType,
      size: item.size,
      calculatedSize: item.calculatedSize,
      status: item.status,
      sourceKind: item.sourceKind,
      isDeleted: item.isDeleted,
      scanPhase: item.scanPhase,
      partitionId: item.partitionId,
      partitionName: item.partitionName,
      originalPath: item.originalPath,
      offset: item.offset,
      sector: item.sector,
      matchedOffset: item.matchedOffset,
      matchedLength: item.matchedLength,
      metadata: item.metadata,
      description: item.description,
      sourceRef: item.sourceRef
        ? {
            kind: item.sourceRef.kind,
            devicePath: item.sourceRef.devicePath,
            offset: item.sourceRef.offset,
            size: item.sourceRef.size,
            runs: item.sourceRef.runs,
          }
        : undefined,
      modifiedAt: item.modifiedAt,
      recoveryChance: item.recoveryChance,
      recoveryTier: item.recoveryTier,
      recoveryReason: item.recoveryReason,
      contentFingerprint: item.contentFingerprint,
      headerSampleHex:
        item.size <= 131072
          ? bytesToHexSample(item.data, item.data.length)
          : bytesToHexSample(item.data, 4096),
    }));

    const session: SavedScanSession = {
      version: 1,
      savedAt: new Date().toISOString(),
      diskName,
      diskSizeBytes: analysis.diskSizeBytes,
      devicePath: nativeDriveTargetRef.current?.devicePath,
      resumeOffset: scanProgress.currentSector * 512,
      items: serialized,
    };

    const json = JSON.stringify(session);
    const baseName = diskName.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/\.[^.]+$/, '');
    const defaultName = `${baseName || 'recovery'}.tdscan.json`;
    const bridge = getDesktopBridge();
    if (bridge) {
      const res = await bridge.saveTextReport({
        defaultName,
        title: 'Save Scan Session (.tdscan.json)',
        filters: [{ name: 'TestDisk Scan Session', extensions: ['json', 'tdscan.json'] }],
        content: json,
      });
      if (!res.canceled && res.filePath) {
        setMbrActionNotice(`Scan session saved to ${res.filePath}`);
      }
      return;
    }
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportSession = async (file: File | undefined) => {
    if (!file) return;
    setLoadError(null);
    setMbrActionNotice(null);
    try {
      const parsed = JSON.parse(await file.text()) as SavedScanSession;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.items)) {
        setLoadError('Invalid scan session file format.');
        return;
      }
      const restored: ExplorerFileItem[] = parsed.items.map((s) => ({
        id: s.id,
        filename: s.filename,
        extension: s.extension,
        family: s.family,
        mimeType: s.mimeType,
        size: s.size,
        calculatedSize: s.calculatedSize,
        status: s.status,
        sourceKind: s.sourceKind,
        isDeleted: s.isDeleted,
        scanPhase: s.scanPhase,
        partitionId: s.partitionId,
        partitionName: s.partitionName,
        originalPath: s.originalPath,
        offset: s.offset,
        sector: s.sector,
        matchedOffset: s.matchedOffset,
        matchedLength: s.matchedLength,
        metadata: s.metadata,
        description: s.description,
        data: hexSampleToBytes(s.headerSampleHex),
        sourceRef: s.sourceRef,
        modifiedAt: s.modifiedAt,
        recoveryChance: s.recoveryChance,
        recoveryTier: s.recoveryTier,
        recoveryReason: s.recoveryReason,
        contentFingerprint: s.contentFingerprint,
      }));

      setActiveScreen('explorer');
      setUseNativeScan(true);
      setIsScanning(false);
      setIsPaused(false);
      setDiskName(parsed.diskName);
      setCarvedItems(restored.filter((i) => i.sourceKind === 'carved' || i.sourceKind === 'ntfs-mft'));
      setLocationItems(restored.filter((i) => i.sourceKind === 'recycle-bin' || i.sourceKind === 'folder'));
      setFidentifyItems(restored.filter((i) => i.sourceKind === 'fidentify'));
      setCheckedIds(new Set());
      setFocusedFileId(restored[0]?.id ?? null);
      setScanProgress({
        currentSector: Math.floor((parsed.resumeOffset ?? parsed.diskSizeBytes) / 512),
        totalSectors: Math.max(1, Math.floor(parsed.diskSizeBytes / 512)),
        percent: 100,
        foundCount: restored.length,
        foundBytes: restored.reduce((sum, x) => sum + x.size, 0),
      });
      setMbrActionNotice(
        `Loaded saved scan session (${restored.length} files from ${parsed.diskName}).`,
      );
    } catch {
      setLoadError('Could not parse scan session JSON file.');
    }
  };

  const groupedSections = useMemo(() => {
    if (groupBy === 'none') {
      return [{ label: '', items: visibleItems }];
    }
    const map = new Map<string, ExplorerFileItem[]>();
    for (const item of visibleItems) {
      const label = getGroupLabel(item, groupBy, sessionReferenceMs);
      const list = map.get(label);
      if (list) list.push(item);
      else map.set(label, [item]);
    }
    return Array.from(map.entries()).map(([label, items]) => ({ label, items }));
  }, [visibleItems, groupBy, sessionReferenceMs]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'likelihood' || key === 'size' || key === 'date' ? 'desc' : 'asc');
    }
  };

  const toggleFileCheck = (id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleToggleNodeCheck = (node: SelectedTreeNode, check: boolean) => {
    const matching = allItems.filter((i) => itemMatchesNode(i, node));
    setCheckedIds((prev) => {
      const next = new Set(prev);
      for (const m of matching) {
        if (check) next.add(m.id);
        else next.delete(m.id);
      }
      return next;
    });
  };

  const allVisibleChecked =
    visibleItems.length > 0 && visibleItems.every((i) => checkedIds.has(i.id));

  const toggleAllVisible = () => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleChecked) {
        for (const item of visibleItems) next.delete(item.id);
      } else {
        for (const item of visibleItems) next.add(item.id);
      }
      return next;
    });
  };

  const focusedFile = useMemo(
    () => allItems.find((i) => i.id === focusedFileId) ?? null,
    [allItems, focusedFileId],
  );

  // Keyboard navigation + global Ctrl+F search focus + Alt+Arrow history + mouse back/forward buttons
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && activeScreen === 'explorer') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (e.altKey && e.key === 'ArrowLeft' && activeScreen === 'explorer') {
        e.preventDefault();
        handleNavBack();
        return;
      }
      if (e.altKey && e.key === 'ArrowRight' && activeScreen === 'explorer') {
        e.preventDefault();
        handleNavForward();
        return;
      }

      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (filterOpen || recoveryOpen || driveHubOpen || lightboxOpen) return;
      if (visibleItems.length === 0) return;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const curIdx = visibleItems.findIndex((i) => i.id === focusedFileId);
        const nextIdx =
          curIdx === -1
            ? 0
            : e.key === 'ArrowDown'
              ? Math.min(visibleItems.length - 1, curIdx + 1)
              : Math.max(0, curIdx - 1);
        setFocusedFileId(visibleItems[nextIdx].id);
      } else if (e.key === ' ' && focusedFileId) {
        e.preventDefault();
        toggleFileCheck(focusedFileId);
      } else if (e.key === 'Enter' && focusedFileId) {
        e.preventDefault();
        setLightboxOpen(true);
      }
    };
    const onMouseUp = (e: MouseEvent) => {
      if (activeScreen !== 'explorer') return;
      if (e.button === 3) {
        e.preventDefault();
        handleNavBack();
      } else if (e.button === 4) {
        e.preventDefault();
        handleNavForward();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [
    activeScreen,
    visibleItems,
    focusedFileId,
    filterOpen,
    recoveryOpen,
    driveHubOpen,
    lightboxOpen,
    handleNavBack,
    handleNavForward,
  ]);

  const focusedPartition = useMemo(() => {
    if (selectedNode.kind === 'partition') {
      return analysis.partitions.find((p) => p.id === selectedNode.partitionId) ?? null;
    }
    return null;
  }, [selectedNode, analysis.partitions]);

  const checkedItems = useMemo(
    () => allItems.filter((i) => checkedIds.has(i.id)),
    [allItems, checkedIds],
  );

  const checkedBytes = useMemo(
    () => checkedItems.reduce((sum, i) => sum + i.size, 0),
    [checkedItems],
  );

  const recoveryPayload = checkedItems.length > 0 ? checkedItems : allItems;

  const totalDiscoveredBytes = useMemo(
    () => carvedItems.reduce((sum, i) => sum + i.size, 0),
    [carvedItems],
  );

  const breadcrumbs = useMemo(() => {
    const crumbs: { label: string; node: SelectedTreeNode }[] = [];
    if (treeMode === 'type') {
      crumbs.push({ label: 'All Types', node: { kind: 'all-types' } });
      if (selectedNode.kind === 'family') {
        crumbs.push({ label: selectedNode.family, node: selectedNode });
      } else if (selectedNode.kind === 'ext') {
        crumbs.push({
          label: selectedNode.family,
          node: { kind: 'family', family: selectedNode.family },
        });
        crumbs.push({ label: selectedNode.extension, node: selectedNode });
      }
    } else {
      if (selectedNode.kind === 'fidentify') {
        crumbs.push({ label: 'Unknown Files (fidentify)', node: selectedNode });
      } else if (selectedNode.kind === 'recycle-bin') {
        crumbs.push({ label: 'Recycle Bin ($Recycle.Bin)', node: selectedNode });
      } else if (selectedNode.kind === 'folder-scan') {
        crumbs.push({ label: 'Scanned Folder', node: selectedNode });
      } else {
        crumbs.push({ label: diskName, node: { kind: 'disk-root' } });
        if (selectedNode.kind === 'partition' || selectedNode.kind === 'folder-node') {
          const p = analysis.partitions.find((x) => x.id === selectedNode.partitionId);
          const fs = p?.detectedFs?.filesystem ?? p?.typeName ?? 'Partition';
          const lbl =
            p?.status === 'Deleted / Lost'
              ? `Lost Partition (${fs})`
              : `${fs} (${p?.name ?? selectedNode.partitionId})`;
          crumbs.push({
            label: lbl,
            node: { kind: 'partition', partitionId: selectedNode.partitionId },
          });
          if (selectedNode.kind === 'folder-node') {
            const segs = selectedNode.folderPath.split('/').filter(Boolean);
            for (let i = 0; i < segs.length; i++) {
              crumbs.push({
                label: segs[i],
                node: {
                  kind: 'folder-node',
                  partitionId: selectedNode.partitionId,
                  folderPath: segs.slice(0, i + 1).join('/'),
                },
              });
            }
          }
        } else if (selectedNode.kind === 'ntfs-mft') {
          crumbs.push({ label: 'Deleted Filesystem ($MFT / FAT)', node: selectedNode });
        } else if (selectedNode.kind === 'unallocated') {
          crumbs.push({ label: 'Reconstructed', node: selectedNode });
        }
      }
    }
    return crumbs;
  }, [treeMode, selectedNode, diskName, analysis.partitions]);

  const ringRadius = 15;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringOffset = ringCircumference * (1 - scanProgress.percent / 100);

  const hasCustomFilters =
    blockSize !== 512 ||
    !paranoid ||
    !keepCorrupted ||
    unallocatedOnly ||
    hideDuplicates ||
    groupBy !== 'none' ||
    deletedFilter !== 'all' ||
    statusFilter !== 'all' ||
    likelihoodFilter !== 'all' ||
    sizeFilter !== 'all' ||
    enabledFormats.size !== FILE_FORMATS.filter((f) => f.enableByDefault).length;

  const truncatedVideoCount = useMemo(
    () =>
      allItems.filter(
        (i) => i.family === 'Videos' && i.status === 'OK_TRUNCATED' && !i.repaired,
      ).length,
    [allItems],
  );

  const renderBreadcrumbLeadIcon = () => {
    if (treeMode === 'type') {
      const fam =
        selectedNode.kind === 'family' || selectedNode.kind === 'ext'
          ? selectedNode.family
          : null;
      switch (fam) {
        case 'Pictures':
          return <ImageIcon className="w-4 h-4 text-amber-400 shrink-0" />;
        case 'Videos':
          return <Film className="w-4 h-4 text-violet-400 shrink-0" />;
        case 'Documents':
          return <FileText className="w-4 h-4 text-sky-400 shrink-0" />;
        case 'Audio':
          return <Music className="w-4 h-4 text-rose-400 shrink-0" />;
        case 'Archives':
          return <Archive className="w-4 h-4 text-emerald-400 shrink-0" />;
        default:
          return <Layers className="w-4 h-4 text-[#4C8DFF] shrink-0" />;
      }
    }
    if (selectedNode.kind === 'folder-node') {
      return <Folder className="w-4 h-4 text-[#4C8DFF] fill-[#4C8DFF]/30 shrink-0" />;
    }
    return <HardDrive className="w-4 h-4 text-[#4C8DFF] shrink-0" />;
  };

  return (
    <div
      className="h-screen flex flex-col bg-[#1A1D24] text-slate-100 overflow-hidden"
      onDragOver={(e) => {
        e.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragActive(false);
        const files = e.dataTransfer.files;
        if (files.length === 0) return;
        const first = files[0];
        if (/\.(img|dd|raw|iso|bin|dmg)$/i.test(first.name)) {
          void handleOpenDiskImage(first);
        } else if (/\.tdscan\.json$/i.test(first.name)) {
          void handleImportSession(first);
        } else {
          void handleInspectUnknownFiles(files);
        }
      }}
    >
      {/* Top Window Bar (Minimal Charcoal Header) */}
      <header className="h-11 shrink-0 bg-[#16181F] border-b border-[#262A34] px-4 flex items-center justify-between gap-3 select-none">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-6 h-6 rounded bg-[#3A7AFE] flex items-center justify-center shrink-0 shadow-sm">
            <HardDrive className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="text-[13px] font-semibold tracking-tight text-slate-100 whitespace-nowrap">
            TestDisk &amp; PhotoRec
          </span>
          {activeScreen === 'explorer' && diskName && (
            <button
              type="button"
              onClick={() => setDriveHubOpen(true)}
              className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded bg-[#222630] border border-[#303542] text-[11px] font-mono text-slate-300 hover:text-white hover:border-[#41495B] transition-colors whitespace-nowrap"
              title="Inspect partition map, connected drives, and scan target"
            >
              <span className="text-[#60A5FA]">{diskName}</span>
              <span className="text-slate-500">·</span>
              <span>{scanPartitionScope ? 'Partition Scope' : 'Full Disk'}</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {activeScreen === 'explorer' && (
            <>
              {allItems.length > 0 && (
                <button
                  type="button"
                  onClick={() => void handleExportSession()}
                  className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded bg-[#222630] text-slate-200 border border-[#303542] hover:bg-[#2B303C] transition-all whitespace-nowrap shrink-0"
                  title="Save discovered file catalog as .tdscan.json session"
                >
                  <Save className="w-3.5 h-3.5 text-slate-300" />
                  Save Session
                </button>
              )}
              {allItems.length > 0 && (
                <button
                  type="button"
                  onClick={() => void handleExportCsv()}
                  className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded bg-[#222630] text-slate-200 border border-[#303542] hover:bg-[#2B303C] transition-all whitespace-nowrap shrink-0"
                  title="Export discovered file inventory as CSV spreadsheet"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-400" />
                  CSV
                </button>
              )}
              {allItems.length > 0 && (
                <button
                  type="button"
                  onClick={() => void handleExportDfxml()}
                  className="hidden lg:inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded bg-[#222630] text-slate-200 border border-[#303542] hover:bg-[#2B303C] transition-all whitespace-nowrap shrink-0"
                  title="Export forensic inventory & byte runs as DFXML XML"
                >
                  <FileCode className="w-3.5 h-3.5 text-[#60A5FA]" />
                  DFXML
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleOpenDiskPicker()}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded bg-[#222630] text-slate-200 border border-[#303542] hover:bg-[#2B303C] transition-all whitespace-nowrap shrink-0"
                title="Open another disk image or physical drive"
              >
                <FolderOpen className="w-3.5 h-3.5 text-[#60A5FA]" />
                Open Image
              </button>
            </>
          )}

          <input
            ref={diskInputRef}
            type="file"
            accept=".img,.dd,.raw,.iso,.bin,.dmg"
            className="hidden"
            onChange={(e) => {
              void handleOpenDiskImage(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <input
            ref={unknownInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void handleInspectUnknownFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            {...({ webkitdirectory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void handleBrowserFolderSelected(e.target.files);
              e.target.value = '';
            }}
          />
          <input
            ref={sessionInputRef}
            type="file"
            accept=".json,.tdscan.json"
            className="hidden"
            onChange={(e) => {
              void handleImportSession(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
      </header>

      {activeScreen === 'home' ? (
        <div className="flex-1 min-h-0 flex flex-col relative">
          {dragActive && (
            <div className="absolute inset-0 z-40 bg-[#16181F]/85 border-2 border-dashed border-[#3A7AFE] flex items-center justify-center pointer-events-none animate-backdrop-in">
              <div className="bg-[#222630] border border-[#343A48] rounded-lg px-6 py-4 text-center space-y-1 animate-modal-in">
                <Upload className="w-6 h-6 text-[#60A5FA] mx-auto" />
                <div className="text-sm font-medium text-slate-100">
                  Drop Disk Image (.img / .dd / .raw / .iso), Session (.tdscan.json), or Unknown Files
                </div>
                <div className="text-xs text-slate-400">
                  All binary parsing runs locally on your machine
                </div>
              </div>
            </div>
          )}
          {loadError && (
            <div className="mx-6 mt-3 px-3.5 py-2 rounded-md bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center justify-between gap-3">
              <span>{loadError}</span>
              <div className="flex items-center gap-2 shrink-0">
                {loadError.includes('Administrator') && capabilities && !capabilities.isAdmin && (
                  <button
                    type="button"
                    onClick={() => void handleRelaunchAsAdmin()}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-amber-500/20 border border-amber-400/40 text-amber-100 hover:bg-amber-500/30 font-medium"
                  >
                    <Shield className="w-3 h-3" />
                    Relaunch as Administrator
                  </button>
                )}
                <button type="button" onClick={() => setLoadError(null)} className="text-rose-200">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
          <HomeView
            scanMode={scanMode}
            onChangeScanMode={setScanMode}
            unallocatedOnly={unallocatedOnly}
            onChangeUnallocatedOnly={setUnallocatedOnly}
            capabilities={capabilities}
            onRelaunchAsAdmin={handleRelaunchAsAdmin}
            onScanPhysicalDrive={handleOpenPhysicalDrive}
            onOpenDiskPicker={() => void handleOpenDiskPicker()}
            onScanFolder={() => void handleScanFolder()}
            onScanRecycleBin={handleScanRecycleBin}
            onScanDesktop={handleScanDesktop}
            onOpenUnknownFiles={() => unknownInputRef.current?.click()}
            onOpenSessionPicker={() => sessionInputRef.current?.click()}
            hasExistingResults={allItems.length > 0 || diskBytes.length > 0}
            onReturnToResults={() => setActiveScreen('explorer')}
          />
        </div>
      ) : (
        <>
          {/* Explorer Navigation, Breadcrumb, View Toggle, Filter & Search Toolbar (Screenshots 1 & 2) */}
          <div className="h-11 shrink-0 bg-[#1D2028] border-b border-[#2A2E39] px-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={handleNavHome}
                  className="p-1.5 rounded bg-[#262B36] border border-[#343A48] text-slate-300 hover:text-white hover:bg-[#2F3644] transition-colors"
                  title="Home"
                  aria-label="Home"
                >
                  <Home className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="h-4 w-px bg-[#2E3340] mx-0.5 shrink-0" />

              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={handleNavBack}
                  disabled={navIndex <= 0}
                  className="p-1.5 rounded text-slate-300 hover:text-white hover:bg-[#262B36] disabled:opacity-35 transition-colors"
                  title="Back (Alt+Left)"
                  aria-label="Back"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={handleNavForward}
                  disabled={navIndex >= navHistory.length - 1}
                  className="p-1.5 rounded text-slate-300 hover:text-white hover:bg-[#262B36] disabled:opacity-35 transition-colors"
                  title="Forward (Alt+Right)"
                  aria-label="Forward"
                >
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={handleNavUp}
                  disabled={
                    selectedNode.kind === 'all-types' ||
                    selectedNode.kind === 'disk-root' ||
                    selectedNode.kind === 'fidentify' ||
                    selectedNode.kind === 'recycle-bin' ||
                    selectedNode.kind === 'folder-scan'
                  }
                  className="p-1.5 rounded text-slate-300 hover:text-white hover:bg-[#262B36] disabled:opacity-35 transition-colors"
                  title="Up one level"
                  aria-label="Up one level"
                >
                  <ArrowUp className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Interactive Breadcrumb Trail with matching leading icon */}
              <nav
                aria-label="Breadcrumb"
                className="flex items-center gap-1.5 text-xs min-w-0 overflow-hidden pl-1"
              >
                {renderBreadcrumbLeadIcon()}
                {breadcrumbs.map((crumb, idx) => {
                  const isLast = idx === breadcrumbs.length - 1;
                  return (
                    <React.Fragment key={`${crumb.label}-${idx}`}>
                      {idx > 0 && <ChevronRight className="w-3.5 h-3.5 text-slate-500 shrink-0" />}
                      <button
                        type="button"
                        onClick={() => navigateToNode(crumb.node)}
                        className={`px-1 py-0.5 rounded truncate transition-colors ${
                          isLast
                            ? 'text-slate-100 font-medium'
                            : 'text-slate-300 hover:text-white hover:bg-[#262B36]'
                        }`}
                      >
                        {crumb.label}
                      </button>
                    </React.Fragment>
                  );
                })}
              </nav>
            </div>

            {/* Right Toolbar: Deleted Toggle, View Toggle, Filter & Search */}
            <div className="flex items-center gap-2 shrink-0">
              <div
                className="flex items-center bg-[#262B36] rounded border border-[#343A48] p-0.5 text-[11px]"
                role="group"
                aria-label="Deletion visibility"
              >
                {([
                  { id: 'all', label: 'All' },
                  { id: 'deleted', label: 'Deleted' },
                  { id: 'existing', label: 'Existing' },
                ] as const).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setDeletedFilter(opt.id)}
                    className={`px-2 py-0.5 rounded-xs font-medium transition-colors whitespace-nowrap ${
                      deletedFilter === opt.id
                        ? 'bg-[#3A7AFE] text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              <div className="flex items-center bg-[#262B36] rounded border border-[#343A48] p-0.5">
                <button
                  type="button"
                  onClick={() => setViewMode('list')}
                  className={`p-1 rounded-xs transition-colors ${
                    viewMode === 'list' ? 'bg-[#363D4E] text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="List view"
                  aria-label="List view"
                >
                  <LayoutList className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('grid')}
                  className={`p-1 rounded-xs transition-colors ${
                    viewMode === 'grid' ? 'bg-[#363D4E] text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                  title="Thumbnail grid view"
                  aria-label="Grid view"
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                </button>
              </div>

              {viewMode === 'grid' && (
                <div
                  className="hidden sm:flex items-center bg-[#262B36] rounded border border-[#343A48] p-0.5 text-[10px] font-mono"
                  role="group"
                  aria-label="Grid thumbnail size"
                >
                  {(['sm', 'md', 'lg'] as const).map((sz) => (
                    <button
                      key={sz}
                      type="button"
                      onClick={() => setGridThumbSize(sz)}
                      className={`px-1.5 py-0.5 rounded-xs uppercase transition-colors ${
                        gridThumbSize === sz
                          ? 'bg-[#3A7AFE] text-white'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                      title={`Grid size: ${sz.toUpperCase()}`}
                    >
                      {sz[0]}
                    </button>
                  ))}
                </div>
              )}

              <button
                type="button"
                onClick={() => setFilterOpen(true)}
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium border transition-colors whitespace-nowrap ${
                  hasCustomFilters
                    ? 'bg-[#3A7AFE]/20 border-[#3A7AFE] text-[#60A5FA]'
                    : 'bg-[#262B36] border-[#343A48] text-slate-200 hover:bg-[#2F3644]'
                }`}
              >
                <Filter className="w-3.5 h-3.5" />
                Filter
              </button>

              <div className="relative w-52 lg:w-60">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search files (Ctrl+F)"
                  className="w-full pl-3 pr-8 py-1 rounded bg-[#262B36] border border-[#343A48] text-xs text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-[#3A7AFE]"
                />
                {searchQuery ? (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                    aria-label="Clear search"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                ) : (
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                )}
              </div>
            </div>
          </div>

          {/* Main 3-Pane Explorer Body */}
          <div className="flex-1 min-h-0 flex relative">
            {dragActive && (
              <div className="absolute inset-0 z-40 bg-[#16181F]/85 border-2 border-dashed border-[#3A7AFE] flex items-center justify-center pointer-events-none animate-backdrop-in">
                <div className="bg-[#222630] border border-[#343A48] rounded-lg px-6 py-4 text-center space-y-1 animate-modal-in">
                  <Upload className="w-6 h-6 text-[#60A5FA] mx-auto" />
                  <div className="text-sm font-medium text-slate-100">
                    Drop Disk Image (.img / .dd / .raw / .iso), Session (.tdscan.json), or Unknown Files
                  </div>
                  <div className="text-xs text-slate-400">
                    All binary parsing runs locally on your machine
                  </div>
                </div>
              </div>
            )}

        {/* Left Sidebar */}
        <ExplorerSidebar
          treeMode={treeMode}
          onChangeTreeMode={handleTreeModeChange}
          selectedNode={selectedNode}
          onSelectNode={navigateToNode}
          analysis={analysis}
          allItems={allItems}
          checkedIds={checkedIds}
          onToggleNodeCheck={handleToggleNodeCheck}
        />

        {/* Center File List & Contextual Strips */}
        <main className="flex-1 min-w-0 flex flex-col bg-[#1A1D24]">
          {loadError && (
            <div className="mx-3 mt-2.5 px-3.5 py-2 rounded-md bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center justify-between gap-3 animate-slide-down">
              <span>{loadError}</span>
              <div className="flex items-center gap-2 shrink-0">
                {loadError.includes('Administrator') && capabilities && !capabilities.isAdmin && (
                  <button
                    type="button"
                    onClick={() => void handleRelaunchAsAdmin()}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-amber-500/20 border border-amber-400/40 text-amber-100 hover:bg-amber-500/30 font-medium"
                  >
                    <Shield className="w-3 h-3" />
                    Relaunch as Administrator
                  </button>
                )}
                <button type="button" onClick={() => setLoadError(null)} className="text-rose-200">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          {mbrActionNotice && (
            <div className="mx-3 mt-2.5 px-3.5 py-2 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center justify-between gap-3 animate-slide-down">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{mbrActionNotice}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {mbrActionNotice.includes('Administrator') && capabilities && !capabilities.isAdmin && (
                  <button
                    type="button"
                    onClick={() => void handleRelaunchAsAdmin()}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-amber-500/20 border border-amber-400/40 text-amber-100 hover:bg-amber-500/30 font-medium"
                  >
                    <Shield className="w-3 h-3" />
                    Relaunch as Administrator
                  </button>
                )}
                {repairedDiskBytes && (
                  <button
                    type="button"
                    onClick={handleDownloadRepairedImg}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-100 font-medium"
                  >
                    <Download className="w-3 h-3" />
                    Export Repaired .img
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setMbrActionNotice(null)}
                  className="text-emerald-200"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          {bitlockerPartitions.length > 0 && (
            <div className="mx-3 mt-2.5 px-3.5 py-2 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs flex flex-wrap items-center justify-between gap-3 animate-slide-down">
              <div className="flex items-center gap-2.5">
                <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
                <span>
                  <strong className="font-semibold text-amber-100">
                    BitLocker Encrypted Volume Detected (-FVE-FS-)
                  </strong>
                  <span className="ml-2 text-amber-200/90">
                    Unlock the volume with its Windows BitLocker recovery key before scanning
                    unencrypted sectors.
                  </span>
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setFocusedFileId(null);
                  navigateToNode({ kind: 'partition', partitionId: bitlockerPartitions[0].id });
                }}
                className="px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/40 text-amber-100 font-medium whitespace-nowrap"
              >
                Unlock Volume
              </button>
            </div>
          )}

          {/* Contextual fidentify Drop Strip */}
          {selectedNode.kind === 'fidentify' && (
            <div className="mx-3 mt-2.5 px-3.5 py-2.5 rounded-md bg-[#222630] border border-[#2E3340] flex flex-wrap items-center justify-between gap-3 text-xs animate-slide-down">
              <div>
                <div className="font-semibold text-slate-100">
                  Unknown File Signature Inspector (fidentify)
                </div>
                <div className="text-slate-400 mt-0.5">
                  Drop or select extensionless / corrupted files to identify their true format by magic header.
                </div>
              </div>
              <button
                type="button"
                onClick={() => unknownInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#3A7AFE] text-white hover:bg-[#2F6EEB] font-medium"
              >
                <Upload className="w-3.5 h-3.5" />
                Select Files
              </button>
            </div>
          )}

          {/* Center File Table or Grid */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            {visibleItems.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center p-8 text-center text-xs text-slate-400 space-y-2 animate-row-fade">
                <FileQuestion className="w-8 h-8 text-slate-600" />
                <div className="text-sm font-medium text-slate-300">
                  {isScanning
                    ? 'Scanning disk sectors for matching signatures...'
                    : selectedNode.kind === 'fidentify'
                      ? 'No unknown files queued yet'
                      : 'No matching files in this view'}
                </div>
                <div className="max-w-sm text-slate-500">
                  {selectedNode.kind === 'fidentify'
                    ? 'Click "Select Files" above or drop extensionless / corrupted files to inspect raw binary headers.'
                    : 'Try switching between Type and Path in the left sidebar, or adjust Filter options.'}
                </div>
              </div>
            ) : viewMode === 'list' ? (
              <table className="w-full text-left border-collapse text-xs">
                <thead className="sticky top-0 z-10 bg-[#1D2028] border-b border-[#2A2E39] text-slate-400 select-none">
                  <tr>
                    <th className="w-10 py-2.5 pl-4 pr-2">
                      <input
                        type="checkbox"
                        checked={allVisibleChecked}
                        onChange={toggleAllVisible}
                        aria-label="Select all visible files"
                        className="w-3.5 h-3.5 rounded-xs border-[#464E5E] bg-[#16181F] text-[#3A7AFE] cursor-pointer"
                      />
                    </th>
                    <th
                      onClick={() => toggleSort('name')}
                      className="py-2.5 px-2 font-medium cursor-pointer hover:text-slate-200"
                    >
                      Name {sortKey === 'name' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                    </th>
                    <th
                      onClick={() => toggleSort('date')}
                      className="py-2.5 px-2 font-medium cursor-pointer hover:text-slate-200 hidden lg:table-cell"
                    >
                      Date Modified {sortKey === 'date' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                    </th>
                    <th
                      onClick={() => toggleSort('type')}
                      className="py-2.5 px-2 font-medium cursor-pointer hover:text-slate-200"
                    >
                      Type {sortKey === 'type' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                    </th>
                    <th
                      onClick={() => toggleSort('size')}
                      className="py-2.5 pl-2 pr-4 font-medium cursor-pointer hover:text-slate-200 text-right"
                    >
                      Size {sortKey === 'size' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#232732]">
                  {groupedSections.map((section) => {
                    const isCollapsed = section.label !== '' && collapsedGroups.has(section.label);
                    return (
                      <React.Fragment key={section.label || 'all'}>
                        {section.label && (
                          <tr
                            onClick={() =>
                              setCollapsedGroups((prev) => {
                                const next = new Set(prev);
                                if (next.has(section.label)) next.delete(section.label);
                                else next.add(section.label);
                                return next;
                              })
                            }
                            className="bg-[#1D2028] cursor-pointer hover:bg-[#242833] select-none"
                          >
                            <td colSpan={5} className="px-4 py-2 font-semibold text-slate-200">
                              <div className="flex items-center gap-2">
                                {isCollapsed ? (
                                  <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                                ) : (
                                  <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                                )}
                                <span>{section.label}</span>
                                <span className="text-[11px] font-mono text-slate-400 tabular-nums">
                                  ({section.items.length})
                                </span>
                              </div>
                            </td>
                          </tr>
                        )}

                        {!isCollapsed &&
                          section.items.map((item) => {
                            const isFocused = focusedFileId === item.id;
                            const isChecked = checkedIds.has(item.id);
                            return (
                              <tr
                                key={item.id}
                                onClick={() => setFocusedFileId(item.id)}
                                onDoubleClick={() => {
                                  setFocusedFileId(item.id);
                                  setLightboxOpen(true);
                                }}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  setFocusedFileId(item.id);
                                  setContextMenu({ x: e.clientX, y: e.clientY, item });
                                }}
                                className={`group cursor-pointer transition-colors duration-100 animate-row-fade ${
                                  isFocused
                                    ? 'bg-[#2C3444] text-white'
                                    : 'hover:bg-[#232732] text-slate-200'
                                }`}
                              >
                                <td
                                  className="py-2 pl-4 pr-2"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleFileCheck(item.id);
                                  }}
                                >
                                  <input
                                    type="checkbox"
                                    checked={isChecked}
                                    onChange={() => {}}
                                    aria-label={`Select ${item.filename}`}
                                    className="w-3.5 h-3.5 rounded-xs border-[#464E5E] bg-[#16181F] text-[#3A7AFE] cursor-pointer"
                                  />
                                </td>
                                <td className="py-2 px-2">
                                  <div className="flex items-center gap-2.5 min-w-0">
                                    <FileThumbnail item={item} size="sm" />
                                    <span className="truncate">{item.filename}</span>
                                    {item.scanPhase === 'vss' && (
                                      <span className="px-1 py-0.5 rounded-xs bg-indigo-500/15 border border-indigo-400/30 text-[9px] font-mono text-indigo-300 shrink-0">
                                        VSS
                                      </span>
                                    )}
                                    {item.scanPhase === 'usn' && (
                                      <span className="px-1 py-0.5 rounded-xs bg-amber-500/15 border border-amber-400/30 text-[9px] font-mono text-amber-300 shrink-0">
                                        USN
                                      </span>
                                    )}
                                    {item.isDeleted && item.scanPhase !== 'vss' && item.scanPhase !== 'usn' && (
                                      <span className="px-1 py-0.5 rounded-xs bg-rose-500/15 border border-rose-400/25 text-[9px] font-mono text-rose-300 shrink-0">
                                        DEL
                                      </span>
                                    )}
                                  </div>
                                </td>
                                <td className="py-2 px-2 font-mono text-slate-400 tabular-nums whitespace-nowrap hidden lg:table-cell">
                                  {formatShortDate(item.modifiedAt)}
                                </td>
                                <td className="py-2 px-2 text-slate-300 uppercase whitespace-nowrap">
                                  {item.extension} File
                                </td>
                                <td className="py-2 pl-2 pr-4 text-right font-mono text-slate-300 tabular-nums whitespace-nowrap">
                                  {formatBytes(item.size)}
                                </td>
                              </tr>
                            );
                          })}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className="p-4 space-y-5">
                {groupedSections.map((section) => {
                  const isCollapsed = section.label !== '' && collapsedGroups.has(section.label);
                  return (
                    <div key={section.label || 'grid-all'} className="space-y-3">
                      {section.label && (
                        <button
                          type="button"
                          onClick={() =>
                            setCollapsedGroups((prev) => {
                              const next = new Set(prev);
                              if (next.has(section.label)) next.delete(section.label);
                              else next.add(section.label);
                              return next;
                            })
                          }
                          className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded bg-[#1D2028] border border-[#2A2E39] text-xs font-semibold text-slate-200 hover:bg-[#242833]"
                        >
                          {isCollapsed ? (
                            <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                          ) : (
                            <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                          )}
                          <span>{section.label}</span>
                          <span className="text-[11px] font-mono text-slate-400 tabular-nums">
                            ({section.items.length})
                          </span>
                        </button>
                      )}

                      {!isCollapsed && (
                        <div
                          className={`grid gap-3 ${
                            gridThumbSize === 'sm'
                              ? 'grid-cols-3 sm:grid-cols-4 lg:grid-cols-6'
                              : gridThumbSize === 'lg'
                                ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'
                                : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4'
                          }`}
                        >
                          {section.items.map((item) => {
                            const isFocused = focusedFileId === item.id;
                            const isChecked = checkedIds.has(item.id);
                            const lbc = likelihoodBadgeClasses(item.recoveryTier);
                            const thumbSize =
                              gridThumbSize === 'sm' ? 'md' : gridThumbSize === 'lg' ? 'xl' : 'lg';
                            return (
                              <div
                                key={item.id}
                                onClick={() => setFocusedFileId(item.id)}
                                onDoubleClick={() => {
                                  setFocusedFileId(item.id);
                                  setLightboxOpen(true);
                                }}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  setFocusedFileId(item.id);
                                  setContextMenu({ x: e.clientX, y: e.clientY, item });
                                }}
                                className={`group rounded-md border p-3 cursor-pointer transition-all duration-150 relative animate-row-fade ${
                                  isFocused
                                    ? 'bg-[#2C3444] border-[#3A7AFE]'
                                    : 'bg-[#20242D] border-[#2C313E] hover:bg-[#272C37] hover:-translate-y-0.5'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => toggleFileCheck(item.id)}
                                  onClick={(e) => e.stopPropagation()}
                                  aria-label={`Select ${item.filename}`}
                                  className="absolute top-2.5 left-2.5 w-3.5 h-3.5 rounded-xs border-[#464E5E] bg-[#16181F] text-[#3A7AFE] cursor-pointer"
                                />
                                <span
                                  className={`absolute top-2 right-2.5 text-[11px] font-mono font-semibold tabular-nums ${lbc.text}`}
                                >
                                  {item.recoveryChance}%
                                </span>

                                <div className="flex justify-center py-4 relative">
                                  <FileThumbnail item={item} size={thumbSize} />
                                  {(item.family === 'Pictures' || item.family === 'Videos') && (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setFocusedFileId(item.id);
                                        setLightboxOpen(true);
                                      }}
                                      className="absolute bottom-2 right-2 p-1 rounded bg-[#16181F]/90 border border-[#303542] text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity"
                                      title="Zoom preview"
                                      aria-label={`Zoom ${item.filename}`}
                                    >
                                      <ZoomIn className="w-3 h-3" />
                                    </button>
                                  )}
                                </div>
                                <div className="text-xs text-slate-100 truncate text-center">
                                  {item.filename}
                                </div>
                                <div className="text-[11px] text-slate-400 text-center tabular-nums mt-0.5">
                                  {item.extension.toUpperCase()} · {formatBytes(item.size)}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </main>

        {/* Right File / Partition Preview, Zoom & Hex Inspector */}
        <ExplorerInspector
          focusedFile={focusedFile}
          focusedPartition={focusedPartition}
          analysis={analysis}
          diskBytes={diskBytes}
          onRestorePartitionToMbr={(p) => handleRestorePartitionToMbr(p)}
          onRepairFile={handleRepairFile}
          onBitLockerUnlocked={() => {
            if (nativeDriveTargetRef.current) {
              const t = nativeDriveTargetRef.current;
              void runNativeStreamingScan(t.devicePath, t.totalBytes, t.label);
            }
          }}
          lightboxOpen={lightboxOpen}
          onSetLightboxOpen={setLightboxOpen}
        />
      </div>

      {/* Contextual Floating Blue Action / Status Strip (matches Screenshots 1 & 3) */}
      {(isScanning ||
        (lostPartitions.length > 0 && !lostBannerDismissed) ||
        (truncatedVideoCount > 0 && !scanBannerDismissed)) && (
        <div className="bg-[#1A1D24] px-3 pt-2 pb-1.5 shrink-0">
          <div className="px-4 py-2 rounded-md bg-[#2D3958]/95 border border-[#445682] text-xs text-slate-100 flex items-center justify-between gap-3">
            {isScanning ? (
              <>
                <div className="flex items-center gap-2.5 min-w-0">
                  <HardDrive className="w-4 h-4 text-[#60A5FA] shrink-0" />
                  <span className="truncate">
                    {scanPhase === 'quick'
                      ? 'Quick Scan is indexing filesystem metadata ($MFT / FAT / $UsnJrnl) — browse or preview results anytime.'
                      : 'Deep Scan is carving raw disk sectors across CPU threads — browse and preview live as files appear.'}
                  </span>
                </div>
                <span className="text-[11px] font-mono text-slate-300 shrink-0 tabular-nums">
                  {scanProgress.percent}%
                </span>
              </>
            ) : lostPartitions.length > 0 && !lostBannerDismissed ? (
              <>
                <div className="flex items-center gap-2.5 min-w-0">
                  <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
                  <span className="truncate">
                    <strong className="font-semibold">Lost partitions found</strong> — Detected{' '}
                    {lostPartitions.length} unmapped filesystem
                    {lostPartitions.length > 1 ? 's' : ''} (
                    {lostPartitions
                      .map((p) => p.detectedFs?.filesystem ?? p.typeName)
                      .join(', ')}
                    ).
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setLostModalOpen(true)}
                    className="px-2.5 py-1 rounded bg-[#1E2538] border border-[#4D6396] text-slate-100 hover:bg-[#252E46] transition-colors"
                  >
                    Details
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRestorePartitionToMbr(lostPartitions[0])}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#3A7AFE] hover:bg-[#2F6EEB] text-white font-medium transition-colors"
                  >
                    <Wrench className="w-3 h-3" />
                    Restore to MBR
                  </button>
                  <button
                    type="button"
                    onClick={() => setLostBannerDismissed(true)}
                    className="p-0.5 text-slate-300 hover:text-white"
                    aria-label="Dismiss lost partition banner"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2.5 min-w-0">
                  <Film className="w-4 h-4 text-[#60A5FA] shrink-0" />
                  <span className="truncate">
                    Smart video reorganization ready — Enable file repair on save or click the
                    repair wrench to fix {truncatedVideoCount} truncated video
                    {truncatedVideoCount > 1 ? 's' : ''}.
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setScanBannerDismissed(true)}
                  className="p-0.5 text-slate-300 hover:text-white shrink-0"
                  aria-label="Dismiss video repair banner"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Bottom Circular Progress & Recover Bar (matches Screenshots 1-3) */}
      <footer className="shrink-0 bg-[#16181F] border-t border-[#262A34] relative overflow-hidden">
        {isScanning && !isPaused && (
          <div className="h-0.5 w-full bg-[#111318] overflow-hidden">
            <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-[#3A7AFE] to-transparent animate-scan-sweep" />
          </div>
        )}
        <div className="h-16 px-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3.5 min-w-0">
            <div className="relative w-10 h-10 flex items-center justify-center shrink-0">
              <svg className="w-10 h-10 -rotate-90" viewBox="0 0 36 36">
                <circle
                  cx="18"
                  cy="18"
                  r={ringRadius}
                  fill="none"
                  stroke="#2A2E39"
                  strokeWidth="3"
                />
                <circle
                  cx="18"
                  cy="18"
                  r={ringRadius}
                  fill="none"
                  stroke="#3A7AFE"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={ringCircumference}
                  strokeDashoffset={ringOffset}
                  className="transition-[stroke-dashoffset] duration-200 ease-out"
                />
              </svg>
              <span className="absolute text-[10px] font-mono font-semibold text-slate-200 tabular-nums">
                {scanProgress.percent}%
              </span>
            </div>

            <div className="min-w-0">
              <div className="text-xs font-medium text-slate-100 flex items-center gap-1.5 whitespace-nowrap">
                <span>
                  {isScanning
                    ? isPaused
                      ? 'Scan Paused ,'
                      : scanPhase === 'quick'
                        ? 'Quick Scanning ,'
                        : 'Deep Scanning ,'
                    : completedQuickOnly
                      ? 'Quick Scan Complete ,'
                      : 'Scan Complete ,'}
                </span>
                <span className="text-slate-200 tabular-nums">
                  Files Found:{' '}
                  <span className="text-[#4C8DFF] font-semibold">
                    {isScanning ? scanProgress.foundCount : carvedItems.length || allItems.length}
                  </span>{' '}
                  <span className="text-slate-400">
                    (
                    {formatBytes(
                      isScanning
                        ? scanProgress.foundBytes
                        : carvedItems.length > 0
                          ? totalDiscoveredBytes
                          : allItems.reduce((s, i) => s + i.size, 0),
                    )}
                    )
                  </span>
                </span>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-slate-400 font-mono tabular-nums mt-0.5 truncate">
                {isScanning && (
                  <span className="inline-flex items-center gap-1.5 shrink-0 mr-1">
                    <button
                      type="button"
                      onClick={() => {
                        if (useNativeScan) {
                          const bridge = getDesktopBridge();
                          const scanId = activeNativeScanIdRef.current;
                          if (!bridge || !scanId) return;
                          const next = !isPaused;
                          setIsPaused(next);
                          if (next) void bridge.pauseDriveScan(scanId);
                          else void bridge.resumeDriveScan(scanId);
                        } else {
                          const next = !isPaused;
                          isPausedRef.current = next;
                          setIsPaused(next);
                        }
                      }}
                      className="p-0.5 text-slate-300 hover:text-white"
                      title={isPaused ? 'Resume scan' : 'Pause scan'}
                      aria-label={isPaused ? 'Resume scan' : 'Pause scan'}
                    >
                      {isPaused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                    </button>
                    {useNativeScan && (
                      <button
                        type="button"
                        onClick={() => {
                          const bridge = getDesktopBridge();
                          if (bridge && activeNativeScanIdRef.current) {
                            void bridge.cancelDriveScan(activeNativeScanIdRef.current);
                            activeNativeScanIdRef.current = null;
                          }
                          setIsPaused(false);
                          setIsScanning(false);
                        }}
                        className="p-0.5 text-slate-300 hover:text-rose-400"
                        title="Stop scan"
                        aria-label="Stop scan"
                      >
                        <Square className="w-3 h-3 fill-current" />
                      </button>
                    )}
                  </span>
                )}
                <span>
                  Reading sector: {scanProgress.currentSector.toLocaleString()}/
                  {scanProgress.totalSectors.toLocaleString()}
                </span>
                {!isScanning && (diskBytes.length > 0 || useNativeScan) && (
                  <div className="inline-flex items-center gap-2 shrink-0 ml-1">
                    <button
                      type="button"
                      onClick={() => {
                        if (nativeDriveTargetRef.current) {
                          const t = nativeDriveTargetRef.current;
                          void runNativeStreamingScan(t.devicePath, t.totalBytes, t.label);
                        } else {
                          startFreshScanState(diskBytes);
                        }
                      }}
                      className="inline-flex items-center gap-1 text-[#4C8DFF] hover:underline font-sans shrink-0"
                    >
                      <RotateCcw className="w-3 h-3" /> Re-scan
                    </button>
                    {completedQuickOnly && (
                      <button
                        type="button"
                        onClick={() => {
                          if (nativeDriveTargetRef.current) {
                            const t = nativeDriveTargetRef.current;
                            void runNativeStreamingScan(t.devicePath, t.totalBytes, t.label, 'full', 'deep');
                          } else {
                            isPausedRef.current = false;
                            setIsPaused(false);
                            setIsScanning(true);
                            setCompletedQuickOnly(false);
                            setScanPhase('deep');
                            setForceDeepRun(true);
                          }
                        }}
                        className="px-2.5 py-0.5 rounded bg-[#262B36] hover:bg-[#313847] border border-[#3B4255] text-[#60A5FA] font-sans font-medium whitespace-nowrap transition-colors"
                      >
                        Run Deep Scan
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            {checkedItems.length > 0 && (
              <div className="text-xs text-slate-300 tabular-nums hidden sm:flex items-center gap-2">
                <span>
                  Selected: {checkedItems.length} {checkedItems.length === 1 ? 'file' : 'files'}{' '}
                  <span className="text-[#4C8DFF] font-medium">
                    ({formatBytes(checkedBytes)})
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setCheckedIds(new Set())}
                  className="text-slate-400 hover:text-slate-200 underline"
                >
                  Clear
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={() => setRecoveryOpen(true)}
              disabled={recoveryPayload.length === 0}
              className="px-6 py-2 rounded-md text-xs font-medium bg-[#3A7AFE] hover:bg-[#2F6EEB] active:scale-[0.98] disabled:opacity-40 text-white transition-all whitespace-nowrap shrink-0"
            >
              {checkedItems.length > 0 ? 'Recover' : 'Recover All ...'}
            </button>
          </div>
        </div>
      </footer>
        </>
      )}

      {/* Right-Click File Context Menu */}
      {contextMenu && (
        <div
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 200),
            top: Math.min(contextMenu.y, window.innerHeight - 170),
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className="fixed z-50 w-48 rounded-md bg-[#222630] border border-[#343A48] shadow-2xl py-1 text-xs animate-modal-in"
        >
          <button
            type="button"
            onClick={() => {
              setFocusedFileId(contextMenu.item.id);
              setLightboxOpen(true);
              setContextMenu(null);
            }}
            className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-slate-200 hover:bg-[#2C3444]"
          >
            <Eye className="w-3.5 h-3.5 text-[#60A5FA]" />
            Preview &amp; Zoom
          </button>
          <button
            type="button"
            onClick={() => {
              void handleDownloadSingleFile(contextMenu.item);
              setContextMenu(null);
            }}
            className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-slate-200 hover:bg-[#2C3444]"
          >
            <Download className="w-3.5 h-3.5 text-emerald-400" />
            Save File Directly
          </button>
          {contextMenu.item.status === 'OK_TRUNCATED' && !contextMenu.item.repaired && (
            <button
              type="button"
              onClick={() => {
                void handleRepairFile(contextMenu.item);
                setContextMenu(null);
              }}
              className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-amber-300 hover:bg-[#2C3444]"
            >
              <Wrench className="w-3.5 h-3.5" />
              Repair File Structure
            </button>
          )}
          <div className="my-1 border-t border-[#2E3340]" />
          <button
            type="button"
            onClick={() => {
              toggleFileCheck(contextMenu.item.id);
              setContextMenu(null);
            }}
            className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-slate-200 hover:bg-[#2C3444]"
          >
            <Check className="w-3.5 h-3.5 text-slate-400" />
            {checkedIds.has(contextMenu.item.id) ? 'Uncheck for Recovery' : 'Check for Recovery'}
          </button>
        </div>
      )}

      {filterOpen && (
        <FilterPopover
          blockSize={blockSize}
          paranoid={paranoid}
          keepCorrupted={keepCorrupted}
          enabledFormats={enabledFormats}
          deletedFilter={deletedFilter}
          statusFilter={statusFilter}
          likelihoodFilter={likelihoodFilter}
          sizeFilter={sizeFilter}
          hideDuplicates={hideDuplicates}
          unallocatedOnly={unallocatedOnly}
          gridThumbSize={gridThumbSize}
          sortKey={sortKey}
          sortDir={sortDir}
          groupBy={groupBy}
          onChangeBlockSize={setBlockSize}
          onChangeParanoid={setParanoid}
          onChangeKeepCorrupted={setKeepCorrupted}
          onChangeEnabledFormats={setEnabledFormats}
          onChangeDeletedFilter={setDeletedFilter}
          onChangeStatusFilter={setStatusFilter}
          onChangeLikelihoodFilter={setLikelihoodFilter}
          onChangeSizeFilter={setSizeFilter}
          onChangeHideDuplicates={setHideDuplicates}
          onChangeUnallocatedOnly={setUnallocatedOnly}
          onChangeGridThumbSize={setGridThumbSize}
          onChangeSortKey={setSortKey}
          onChangeSortDir={setSortDir}
          onChangeGroupBy={(val) => {
            setGroupBy(val);
            setCollapsedGroups(new Set());
          }}
          onApplyAndRescan={() => {
            if (nativeDriveTargetRef.current) {
              const t = nativeDriveTargetRef.current;
              void runNativeStreamingScan(t.devicePath, t.totalBytes, t.label);
            } else {
              startFreshScanState(diskBytes);
            }
          }}
          onClose={() => setFilterOpen(false)}
        />
      )}

      {recoveryOpen && (
        <RecoveryModal
          items={recoveryPayload}
          diskName={diskName}
          scannedDevicePath={scannedDevicePath}
          repairedDiskBytes={repairedDiskBytes}
          onClose={() => setRecoveryOpen(false)}
        />
      )}

      {driveHubOpen && (
        <DriveHubModal
          analysis={analysis}
          activePartitionScope={scanPartitionScope}
          capabilities={capabilities}
          onRelaunchAsAdmin={handleRelaunchAsAdmin}
          onStartTargetedScan={(part) => startFreshScanState(diskBytes, part ? part.id : null)}
          onOpenPhysicalDrive={handleOpenPhysicalDrive}
          onScanFolder={() => void handleScanFolder()}
          onScanRecycleBin={handleScanRecycleBin}
          onOpenDiskPicker={() => void handleOpenDiskPicker()}
          onClose={() => setDriveHubOpen(false)}
        />
      )}

      {lostModalOpen && lostPartitions.length > 0 && (
        <LostPartitionsModal
          lostPartitions={lostPartitions}
          onInspectLostPartition={(p) => {
            navigateToNode({ kind: 'partition', partitionId: p.id });
            setFocusedFileId(null);
          }}
          onRestoreToMbr={(p) => handleRestorePartitionToMbr(p)}
          onClose={() => setLostModalOpen(false)}
        />
      )}
    </div>
  );
};

export default App;

