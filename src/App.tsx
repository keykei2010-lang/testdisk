import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArrowDownUp,
  ArrowLeft,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  FileCode,
  FileQuestion,
  FileText,
  Film,
  FolderOpen,
  FolderSearch,
  HardDrive,
  Home,
  LayoutGrid,
  LayoutList,
  Music,
  Pause,
  Play,
  RotateCcw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
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
  carveDiskBufferAsync,
  FILE_FORMATS,
  FileFamily,
  identifyBuffer,
} from './engine/signatures';
import {
  buildSampleDiskImage,
  buildSampleUnknownFiles,
} from './engine/sampleDisk';
import {
  ExplorerFileItem,
  GroupByKey,
  itemMatchesNode,
  RecoveryLikelihoodTier,
  SelectedTreeNode,
  SortDir,
  SortKey,
  TreeMode,
  treeNodeKey,
} from './engine/explorerTypes';
import {
  computeContentFingerprint,
  computeRecoveryLikelihood,
  deriveCarvedTimestamp,
  formatShortDate,
  repairFileBuffer,
} from './engine/recoveryHealth';
import { formatBytes } from './engine/crc32';
import { scanNtfsMftRecordsInBuffer } from './engine/ntfsMft';
import { buildDfxmlReport } from './engine/dfxml';
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
import { OfflineIndicator, PWAInstallButton } from './components/PWAInstallButton';

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
  if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'svg', 'heic'].includes(e)) {
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

function toFileUrl(winOrPosixPath: string): string {
  const normalized = winOrPosixPath.replace(/\\/g, '/').replace(/^\/+/, '');
  return `file:///${normalized}`;
}

interface ThumbnailProps {
  item: ExplorerFileItem;
  size?: 'sm' | 'lg';
}

const FileThumbnail: React.FC<ThumbnailProps> = ({ item, size = 'sm' }) => {
  const imgUrl = useMemo(() => {
    if (item.family !== 'Pictures') return null;
    if (item.sourceRef?.browserFile) {
      return URL.createObjectURL(item.sourceRef.browserFile);
    }
    if (item.sourceRef?.kind === 'native-file' && item.sourceRef.devicePath) {
      return toFileUrl(item.sourceRef.devicePath);
    }
    const blob = new Blob([item.data.slice().buffer], { type: item.mimeType });
    return URL.createObjectURL(blob);
  }, [item]);

  useEffect(() => {
    return () => {
      if (imgUrl && imgUrl.startsWith('blob:')) URL.revokeObjectURL(imgUrl);
    };
  }, [imgUrl]);

  const boxClass = size === 'lg' ? 'w-16 h-16' : 'w-7 h-7';
  const iconClass = size === 'lg' ? 'w-7 h-7' : 'w-4 h-4';

  if (imgUrl) {
    return (
      <img
        src={imgUrl}
        alt={item.filename}
        loading="lazy"
        referrerPolicy="no-referrer"
        className={`${boxClass} rounded object-cover bg-[#11151C] border border-[#2A3446] shrink-0 transition-transform duration-150 group-hover:scale-105`}
      />
    );
  }

  return (
    <div
      className={`${boxClass} rounded bg-[#181E29] border border-[#2A3446] flex items-center justify-center shrink-0 transition-transform duration-150 group-hover:scale-105`}
    >
      {item.family === 'Videos' ? (
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

function getGroupLabel(item: ExplorerFileItem, groupBy: GroupByKey): string {
  switch (groupBy) {
    case 'none':
      return '';
    case 'likelihood':
      return item.recoveryTier === 'high'
        ? 'High Likelihood (85% – 100%)'
        : item.recoveryTier === 'medium'
          ? 'Fair Likelihood (50% – 84%)'
          : 'Low Likelihood (< 50%)';
    case 'type':
      return `${item.family} (.${item.extension.toUpperCase()})`;
    case 'origin':
      return item.partitionName;
    case 'date': {
      const ageHours = (Date.now() - item.modifiedAt) / 3600000;
      if (ageHours <= 24) return 'Last 24 Hours';
      if (ageHours <= 120) return 'Earlier This Week';
      return 'Older Volume Snapshot';
    }
  }
}

export const App: React.FC = () => {
  const initialSample = useMemo(() => buildSampleDiskImage(), []);

  const [diskName, setDiskName] = useState<string>(initialSample.name);
  const [diskBytes, setDiskBytes] = useState<Uint8Array>(initialSample.bytes);
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
  const [sortKey, setSortKey] = useState<SortKey>('likelihood');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [groupBy, setGroupBy] = useState<GroupByKey>('none');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [sortMenuOpen, setSortMenuOpen] = useState<boolean>(false);
  const [filterOpen, setFilterOpen] = useState<boolean>(false);
  const [recoveryOpen, setRecoveryOpen] = useState<boolean>(false);
  const [driveHubOpen, setDriveHubOpen] = useState<boolean>(false);
  const [lightboxOpen, setLightboxOpen] = useState<boolean>(false);

  // Scanner & PhotoRec options
  const [blockSize, setBlockSize] = useState<number>(512);
  const [paranoid, setParanoid] = useState<boolean>(true);
  const [keepCorrupted, setKeepCorrupted] = useState<boolean>(true);
  const [statusFilter, setStatusFilter] = useState<'all' | 'ok' | 'truncated'>('all');
  const [likelihoodFilter, setLikelihoodFilter] = useState<'all' | RecoveryLikelihoodTier>('all');
  const [sizeFilter, setSizeFilter] = useState<'all' | 'small' | 'medium' | 'large'>('all');
  const [hideDuplicates, setHideDuplicates] = useState<boolean>(false);
  const [enabledFormats, setEnabledFormats] = useState<Set<string>>(
    () => new Set(FILE_FORMATS.filter((f) => f.enableByDefault).map((f) => f.id)),
  );
  const [scanPartitionScope, setScanPartitionScope] = useState<string | null>(null);
  const [scanNonce, setScanNonce] = useState<number>(0);

  // Scan execution state
  const [useNativeScan, setUseNativeScan] = useState<boolean>(false);
  const [isScanning, setIsScanning] = useState<boolean>(true);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const isPausedRef = useRef<boolean>(false);
  const activeNativeScanIdRef = useRef<string | null>(null);
  const nativeDriveTargetRef = useRef<{
    devicePath: string;
    totalBytes: number;
    label: string;
  } | null>(null);
  const [scanProgress, setScanProgress] = useState<ScanProgressState>(() => ({
    currentSector: 0,
    totalSectors: Math.max(1, Math.floor(initialSample.bytes.length / 512)),
    percent: 0,
    foundCount: 0,
    foundBytes: 0,
  }));

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
  const sortMenuRef = useRef<HTMLDivElement>(null);

  const analysis = useMemo(
    () => analyzeDiskImage(diskName, diskBytes),
    [diskName, diskBytes],
  );

  const lostPartitions = useMemo(
    () => analysis.partitions.filter((p) => p.status === 'Deleted / Lost'),
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

  // Close sort dropdown or context menu on outside click
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) {
        setSortMenuOpen(false);
      }
      setContextMenu(null);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, []);

  // Async sector carver effect for in-memory disk images (skipped during native streaming scans)
  useEffect(() => {
    if (useNativeScan) return;
    let cancelled = false;
    isPausedRef.current = false;

    const scopedPartition = scanPartitionScope
      ? analysis.partitions.find((p) => p.id === scanPartitionScope)
      : null;
    const startByte = scopedPartition ? scopedPartition.startOffset : 0;
    const endByte = scopedPartition
      ? Math.min(diskBytes.length, (scopedPartition.endLba + 1) * analysis.sectorSize)
      : diskBytes.length;

    const run = async () => {
      const results = await carveDiskBufferAsync(
        diskBytes,
        {
          startByte,
          endByte,
          blockSize,
          paranoid,
          keepCorrupted,
          enabledFormats,
        },
        (prog) => {
          if (cancelled) return;
          setScanProgress({
            currentSector: prog.currentSector,
            totalSectors: prog.totalSectors,
            percent: prog.percent,
            foundCount: prog.foundCount,
            foundBytes: prog.foundBytes,
            latestFilename: prog.latestFile?.filename,
          });
        },
        {
          isCancelled: () => cancelled,
          isPaused: () => isPausedRef.current,
        },
      );

      if (cancelled) return;

      const mapped: ExplorerFileItem[] = results.map((c) => {
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
        };
      });

      const rawMftRecords = scanNtfsMftRecordsInBuffer(diskBytes, analysis.partitions).filter(
        (m) => !scopedPartition || m.partitionId === scopedPartition.id,
      );
      const mftMapped: ExplorerFileItem[] = rawMftRecords.map((m) => {
        const res = m.reconstructedBytes.length > 0 ? identifyBuffer(m.reconstructedBytes) : null;
        const extHint = (m.filename.split('.').pop() || '').toLowerCase();
        const fallback = inferFallbackFromExt(extHint);
        const ext = res?.extension || extHint || 'bin';
        const family = res?.family ?? fallback.family;
        const mimeType = res?.mimeType ?? fallback.mimeType;
        const description = res?.description ?? fallback.description;
        const isResident = m.residentData !== null;
        const status: ExplorerFileItem['status'] =
          isResident || m.reconstructedBytes.length >= m.fileSize
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
        });
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
          partitionId: m.partitionId,
          partitionName: m.partitionName,
          offset: m.extents[0]?.offset ?? m.mftOffset,
          sector: Math.floor((m.extents[0]?.offset ?? m.mftOffset) / analysis.sectorSize),
          matchedOffset: res?.matchedOffset ?? 0,
          matchedLength: res?.matchedLength ?? 0,
          metadata: {
            ...(res?.metadata ?? {}),
            details: isResident
              ? `NTFS MFT Record #${m.recordNumber} (Resident Data)`
              : `NTFS MFT Record #${m.recordNumber} (${m.extents.length} extent${m.extents.length === 1 ? '' : 's'})`,
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

      const combined = [...mapped, ...mftMapped];
      setCarvedItems(combined);
      setIsScanning(false);
      setIsPaused(false);
      setFocusedFileId((cur) => cur ?? combined[0]?.id ?? null);
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
    enabledFormats,
    scanNonce,
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

  const handleNavBack = () => {
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
  };

  const handleNavUp = () => {
    if (selectedNode.kind === 'ext') {
      navigateToNode({ kind: 'family', family: selectedNode.family });
    } else if (selectedNode.kind === 'family') {
      navigateToNode({ kind: 'all-types' });
    } else if (
      selectedNode.kind === 'partition' ||
      selectedNode.kind === 'unallocated' ||
      selectedNode.kind === 'ntfs-mft'
    ) {
      navigateToNode({ kind: 'disk-root' });
    }
  };

  const handleNavHome = () => {
    if (treeMode === 'type') {
      navigateToNode({ kind: 'all-types' });
    } else {
      navigateToNode({ kind: 'disk-root' });
    }
  };

  const startFreshScanState = (bytes: Uint8Array, scopePartitionId?: string | null) => {
    setUseNativeScan(false);
    nativeDriveTargetRef.current = null;
    isPausedRef.current = false;
    setIsPaused(false);
    setIsScanning(true);
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
              ? `NTFS $MFT deleted record (${entry.runs?.length ?? 0} extent${entry.runs?.length === 1 ? '' : 's'})`
              : 'Streamed disk signature',
        },
        description,
        data: sample,
        sourceRef: {
          kind: isMftItem
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
        },
        modifiedAt: res?.metadata.takenAtMs ?? (entry.modifiedAt || Date.now()),
        recoveryChance: assessment.chance,
        recoveryTier: assessment.tier,
        recoveryReason: assessment.reason,
        contentFingerprint: computeContentFingerprint(entry.size, sample),
      };
    },
    [mapOffsetToPartition],
  );

  const runNativeStreamingScan = async (
    devicePath: string,
    totalBytes: number,
    label: string,
  ) => {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    setLoadError(null);
    setMbrActionNotice(null);

    if (activeNativeScanIdRef.current) {
      await bridge.cancelDriveScan(activeNativeScanIdRef.current).catch(() => {});
    }

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

    setUseNativeScan(true);
    setDiskName(label);
    setDiskBytes(headBytes);
    setRepairedDiskBytes(null);
    setLostBannerDismissed(false);
    setIsScanning(true);
    setIsPaused(false);
    setCarvedItems([]);
    setCheckedIds(new Set());
    setFocusedFileId(null);
    setScanProgress({
      currentSector: 0,
      totalSectors: Math.max(1, Math.floor(totalBytes / 512)),
      percent: 0,
      foundCount: 0,
      foundBytes: 0,
    });

    const unsub = bridge.onDriveScanProgress((ev) => {
      if (ev.scanId !== scanId) return;
      setScanProgress({
        currentSector: Math.floor(ev.currentBytes / 512),
        totalSectors: Math.max(1, Math.floor(ev.totalBytes / 512)),
        percent: ev.percent,
        foundCount: ev.foundCount,
        foundBytes: ev.foundBytes,
        latestFilename: ev.latestName,
      });
    });

    try {
      const entries = await bridge.startDriveScan({
        scanId,
        devicePath,
        totalBytes,
        blockSize,
      });
      if (activeNativeScanIdRef.current !== scanId) return;
      const mapped = entries.map((e) => mapNativeEntryToExplorerItem(e, resolveLocalPart));
      setCarvedItems(mapped);
      setIsScanning(false);
      setFocusedFileId(mapped[0]?.id ?? null);
    } finally {
      unsub();
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
        `Image "${file.name}" exceeds the 256 MiB browser memory limit. In the Windows .exe, use "Open Disk Image" for multi-GB streaming.`,
      );
      return;
    }
    const buf = new Uint8Array(await file.arrayBuffer());
    setDiskName(file.name);
    setDiskBytes(buf);
    setRepairedDiskBytes(null);
    setLostBannerDismissed(false);
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
        setDiskName(picked.name);
        setDiskBytes(bytes);
        setRepairedDiskBytes(null);
        setLostBannerDismissed(false);
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
      const entries = await bridge.scanFolder(folderPath);
      const mapped = entries.map((e) => mapNativeEntryToExplorerItem(e));
      setLocationItems((prev) => [
        ...mapped,
        ...prev.filter((i) => i.sourceKind !== 'folder'),
      ]);
      setFocusedFileId(mapped[0]?.id ?? null);
      navigateToNode({ kind: 'folder-scan' });
      if (mapped.length === 0) {
        setMbrActionNotice(`No files found inside "${folderPath}".`);
      }
    } catch {
      setLoadError('Could not read the selected folder.');
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
      const entries = await bridge.scanRecycleBin();
      const mapped = entries.map((e) => mapNativeEntryToExplorerItem(e));
      setLocationItems((prev) => [
        ...mapped,
        ...prev.filter((i) => i.sourceKind !== 'recycle-bin'),
      ]);
      setFocusedFileId(mapped[0]?.id ?? null);
      navigateToNode({ kind: 'recycle-bin' });
      if (mapped.length === 0) {
        setMbrActionNotice(
          'No deleted items found in Windows $Recycle.Bin (or Administrator permission required).',
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

    setLocationItems((prev) => [
      ...added,
      ...prev.filter((i) => i.sourceKind !== (isRecycle ? 'recycle-bin' : 'folder')),
    ]);
    setFocusedFileId(added[0]?.id ?? null);
    navigateToNode(isRecycle ? { kind: 'recycle-bin' } : { kind: 'folder-scan' });
  };

  const handleResetSample = () => {
    const sample = buildSampleDiskImage();
    setLoadError(null);
    setMbrActionNotice(null);
    setDiskName(sample.name);
    setDiskBytes(sample.bytes);
    setRepairedDiskBytes(null);
    setLostBannerDismissed(false);
    startFreshScanState(sample.bytes, null);
  };

  const handleInspectUnknownFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;

    const added: ExplorerFileItem[] = [];
    for (const file of list) {
      const buf = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
      const res = identifyBuffer(buf);
      const sampledFull = file.size <= buf.length;
      const status = res ? (sampledFull ? res.status : 'OK') : 'UNKNOWN';
      const calculatedSize = sampledFull ? (res?.calculatedSize ?? null) : file.size;
      const assessment = computeRecoveryLikelihood({
        status,
        size: file.size,
        calculatedSize,
        partitionId: 'fidentify',
        metadata: res?.metadata ?? {},
        extension: res?.extension ?? 'unknown',
        data: buf,
      });
      added.push({
        id: `fid-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        filename: file.name,
        extension: res?.extension ?? 'unknown',
        family: res?.family ?? 'Others',
        mimeType: res?.mimeType ?? 'application/octet-stream',
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
        metadata: res?.metadata ?? { details: 'Unrecognized binary header' },
        description: res?.description ?? 'Unrecognized binary signature',
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
        recoveryReason: assessment.reason,
        contentFingerprint: computeContentFingerprint(file.size, buf),
      });
    }

    setFidentifyItems((prev) => [...added, ...prev]);
    setFocusedFileId(added[0].id);
    navigateToNode({ kind: 'fidentify' });
  };

  const handleLoadSampleUnknown = () => {
    const samples = buildSampleUnknownFiles();
    const now = Date.now();
    const added: ExplorerFileItem[] = samples.map((s, idx) => {
      const res = identifyBuffer(s.bytes);
      const status = res?.status ?? 'UNKNOWN';
      const assessment = computeRecoveryLikelihood({
        status,
        size: s.bytes.length,
        calculatedSize: res?.calculatedSize ?? null,
        partitionId: 'fidentify',
        metadata: res?.metadata ?? {},
        extension: res?.extension ?? 'unknown',
        data: s.bytes,
      });
      return {
        id: `fid-sample-${now}-${idx}`,
        filename: s.name,
        extension: res?.extension ?? 'unknown',
        family: res?.family ?? 'Others',
        mimeType: res?.mimeType ?? 'application/octet-stream',
        size: s.bytes.length,
        calculatedSize: res?.calculatedSize ?? null,
        status,
        sourceKind: 'fidentify',
        partitionId: 'fidentify',
        partitionName: 'Unknown Files (fidentify)',
        offset: 0,
        sector: 0,
        matchedOffset: res?.matchedOffset ?? 0,
        matchedLength: res?.matchedLength ?? 0,
        metadata: res?.metadata ?? { details: 'Unrecognized binary header' },
        description: res?.description ?? 'Unrecognized binary signature',
        data: s.bytes,
        modifiedAt: res?.metadata.takenAtMs ?? (now - idx * 3600000),
        recoveryChance: assessment.chance,
        recoveryTier: assessment.tier,
        recoveryReason: assessment.reason,
        contentFingerprint: computeContentFingerprint(s.bytes.length, s.bytes),
      };
    });
    setFidentifyItems((prev) => [...added, ...prev]);
    setFocusedFileId(added[0].id);
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

  const handleRepairFile = (target: ExplorerFileItem) => {
    const res = repairFileBuffer(target.extension, target.data);
    if (!res.repaired) return;
    const assessment = computeRecoveryLikelihood({
      status: 'OK',
      size: res.data.length,
      calculatedSize: res.data.length,
      partitionId: target.partitionId,
      metadata: target.metadata,
      extension: target.extension,
      data: res.data,
      repaired: true,
    });
    const updater = (list: ExplorerFileItem[]) =>
      list.map((item) =>
        item.id === target.id
          ? {
              ...item,
              data: res.data,
              size: res.data.length,
              calculatedSize: res.data.length,
              status: 'OK' as const,
              repaired: true,
              recoveryChance: assessment.chance,
              recoveryTier: assessment.tier,
              recoveryReason: res.note,
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
    if (
      bridge &&
      item.sourceRef &&
      (item.sourceRef.kind === 'native-device' ||
        item.sourceRef.kind === 'native-runs' ||
        item.sourceRef.kind === 'native-file')
    ) {
      await bridge.recoverFilesToFolder({
        destinationDir: null,
        items: [
          {
            filename: item.filename,
            folder: item.family,
            sourceKind: item.sourceRef.kind,
            devicePath: item.sourceRef.devicePath,
            offset: item.sourceRef.offset,
            size: item.sourceRef.size,
            runs: item.sourceRef.runs,
            extension: item.extension,
            repairIfTruncated: item.status === 'OK_TRUNCATED',
            modifiedAtMs: item.modifiedAt,
          },
        ],
      });
      return;
    }

    const blob = item.sourceRef?.browserFile
      ? item.sourceRef.browserFile
      : new Blob([item.data.slice().buffer], { type: item.mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Filter + Sort visible center pane files
  const visibleItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = allItems.filter((item) => {
      if (!itemMatchesNode(item, selectedNode)) return false;
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
    statusFilter,
    likelihoodFilter,
    sizeFilter,
    hideDuplicates,
    searchQuery,
    sortKey,
    sortDir,
  ]);

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

  const groupedSections = useMemo(() => {
    if (groupBy === 'none') {
      return [{ label: '', items: visibleItems }];
    }
    const map = new Map<string, ExplorerFileItem[]>();
    for (const item of visibleItems) {
      const label = getGroupLabel(item, groupBy);
      const list = map.get(label);
      if (list) list.push(item);
      else map.set(label, [item]);
    }
    return Array.from(map.entries()).map(([label, items]) => ({ label, items }));
  }, [visibleItems, groupBy]);

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

  // Keyboard navigation across visible file items (ArrowUp/Down, Space, Enter)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
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
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visibleItems, focusedFileId, filterOpen, recoveryOpen, driveHubOpen, lightboxOpen]);

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
        if (selectedNode.kind === 'partition') {
          const p = analysis.partitions.find((x) => x.id === selectedNode.partitionId);
          const fs = p?.detectedFs?.filesystem ?? p?.typeName ?? 'Partition';
          const lbl =
            p?.status === 'Deleted / Lost'
              ? `Lost Partition (${fs})`
              : `${fs} (${p?.name ?? selectedNode.partitionId})`;
          crumbs.push({ label: lbl, node: selectedNode });
        } else if (selectedNode.kind === 'ntfs-mft') {
          crumbs.push({ label: 'Deleted NTFS ($MFT)', node: selectedNode });
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
    hideDuplicates ||
    statusFilter !== 'all' ||
    likelihoodFilter !== 'all' ||
    sizeFilter !== 'all' ||
    enabledFormats.size !== FILE_FORMATS.filter((f) => f.enableByDefault).length;

  const sortLabels: Record<SortKey, string> = {
    name: 'Name',
    date: 'Date Modified',
    type: 'Type',
    size: 'Size',
    likelihood: 'Likelihood',
    origin: 'Origin',
  };

  return (
    <div
      className="h-screen flex flex-col bg-[#11151C] text-slate-100 overflow-hidden"
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
        } else {
          void handleInspectUnknownFiles(files);
        }
      }}
    >
      {/* Top Window Bar */}
      <header className="h-14 shrink-0 bg-[#181E29] border-b border-[#2A3446] px-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-7 h-7 rounded-md bg-[#2E7CF6] flex items-center justify-center shrink-0">
            <HardDrive className="w-4 h-4 text-white" />
          </div>
          <span className="text-sm font-semibold tracking-tight text-slate-100 whitespace-nowrap truncate">
            TestDisk &amp; PhotoRec
          </span>
          <button
            type="button"
            onClick={() => setDriveHubOpen(true)}
            className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#11151C] border border-[#2A3446] text-[11px] font-mono text-slate-300 hover:text-white hover:border-[#3B4963] transition-colors whitespace-nowrap"
            title="Inspect partition map and choose scan target"
          >
            <span className="text-[#38BDF8]">{diskName}</span>
            <span className="text-slate-500">·</span>
            <span>{scanPartitionScope ? 'Targeted Partition' : 'Full Disk'}</span>
          </button>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <OfflineIndicator />
          <PWAInstallButton />
          <button
            type="button"
            onClick={() => void handleScanRecycleBin()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-[#1F2735] text-slate-200 border border-[#2A3446] hover:bg-[#283244] active:scale-[0.98] transition-all whitespace-nowrap shrink-0"
            title="Scan Windows $Recycle.Bin ($I/$R deleted files)"
          >
            <Trash2 className="w-3.5 h-3.5 text-amber-400" />
            Recycle Bin
          </button>
          <button
            type="button"
            onClick={() => void handleScanFolder()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-[#1F2735] text-slate-200 border border-[#2A3446] hover:bg-[#283244] active:scale-[0.98] transition-all whitespace-nowrap shrink-0"
            title="Scan any folder for photos, videos, or damaged files"
          >
            <FolderSearch className="w-3.5 h-3.5 text-[#38BDF8]" />
            Scan Folder
          </button>
          <button
            type="button"
            onClick={() => unknownInputRef.current?.click()}
            className="hidden xl:inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-[#1F2735] text-slate-200 border border-[#2A3446] hover:bg-[#283244] active:scale-[0.98] transition-all whitespace-nowrap shrink-0"
          >
            <FileQuestion className="w-3.5 h-3.5 text-emerald-400" />
            Inspect Unknown File
          </button>
          <button
            type="button"
            onClick={handleResetSample}
            className="hidden lg:inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-[#1F2735] text-slate-200 border border-[#2A3446] hover:bg-[#283244] active:scale-[0.98] transition-all whitespace-nowrap shrink-0"
            title="Reload built-in Windows drive sample image"
          >
            <RotateCcw className="w-3.5 h-3.5 text-slate-400" />
            Reset Sample
          </button>
          <button
            type="button"
            onClick={() => void handleOpenDiskPicker()}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md bg-[#2E7CF6] text-white hover:bg-[#2569D6] active:scale-[0.98] transition-all whitespace-nowrap shrink-0"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            Open Disk Image
          </button>

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
        </div>
      </header>

      {/* Explorer Navigation, Sort & Group, Filter, and Search Toolbar */}
      <div className="h-12 shrink-0 bg-[#141922] border-b border-[#2A3446] px-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={handleNavHome}
              className="p-1.5 rounded bg-[#1F2735] border border-[#2A3446] text-slate-300 hover:text-white hover:bg-[#283244] transition-colors"
              title="Home"
              aria-label="Home"
            >
              <Home className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleNavBack}
              disabled={navIndex <= 0}
              className="p-1.5 rounded bg-[#1F2735] border border-[#2A3446] text-slate-300 hover:text-white hover:bg-[#283244] disabled:opacity-35 transition-colors"
              title="Back"
              aria-label="Back"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
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
              className="p-1.5 rounded bg-[#1F2735] border border-[#2A3446] text-slate-300 hover:text-white hover:bg-[#283244] disabled:opacity-35 transition-colors"
              title="Up one level"
              aria-label="Up one level"
            >
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="h-5 w-px bg-[#2A3446] mx-1 shrink-0" />

          {/* Interactive Breadcrumb Trail */}
          <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs min-w-0 overflow-hidden">
            {breadcrumbs.map((crumb, idx) => {
              const isLast = idx === breadcrumbs.length - 1;
              return (
                <React.Fragment key={`${crumb.label}-${idx}`}>
                  {idx > 0 && <ChevronRight className="w-3.5 h-3.5 text-slate-500 shrink-0" />}
                  <button
                    type="button"
                    onClick={() => navigateToNode(crumb.node)}
                    className={`px-1.5 py-0.5 rounded truncate transition-colors ${
                      isLast
                        ? 'text-slate-100 font-medium'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-[#1F2735]'
                    }`}
                  >
                    {crumb.label}
                  </button>
                </React.Fragment>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* View Mode Toggle */}
          <div className="flex items-center bg-[#11151C] rounded-md border border-[#2A3446] p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={`p-1 rounded transition-colors ${
                viewMode === 'list' ? 'bg-[#283244] text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
              title="List view"
              aria-label="List view"
            >
              <LayoutList className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              className={`p-1 rounded transition-colors ${
                viewMode === 'grid' ? 'bg-[#283244] text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
              title="Thumbnail grid view"
              aria-label="Grid view"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Dedicated Sort & Group Button */}
          <div className="relative" ref={sortMenuRef}>
            <button
              type="button"
              onClick={() => setSortMenuOpen((o) => !o)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors whitespace-nowrap ${
                groupBy !== 'none' || sortMenuOpen
                  ? 'bg-[#2E7CF6]/15 border-[#2E7CF6] text-[#60A5FA]'
                  : 'bg-[#1F2735] border-[#2A3446] text-slate-200 hover:bg-[#283244]'
              }`}
            >
              <ArrowDownUp className="w-3.5 h-3.5" />
              <span>Sort: {sortLabels[sortKey]}</span>
              <ChevronDown className="w-3 h-3 opacity-70" />
            </button>

            {sortMenuOpen && (
              <div className="absolute right-0 mt-1.5 w-60 rounded-lg bg-[#181E29] border border-[#2A3446] shadow-2xl z-40 py-2 text-xs animate-modal-in">
                <div className="px-3 py-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                  Sort By
                </div>
                {(
                  [
                    ['name', 'Name'],
                    ['size', 'Size'],
                    ['date', 'Date Modified'],
                    ['likelihood', 'Likelihood of Recovery'],
                    ['type', 'File Type'],
                    ['origin', 'Origin / Partition'],
                  ] as [SortKey, string][]
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setSortKey(key)}
                    className="w-full px-3 py-1.5 flex items-center justify-between text-left text-slate-200 hover:bg-[#283244] transition-colors"
                  >
                    <span>{label}</span>
                    {sortKey === key && <Check className="w-3.5 h-3.5 text-[#38BDF8]" />}
                  </button>
                ))}

                <div className="my-1.5 border-t border-[#2A3446]" />
                <div className="px-3 py-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                  Order
                </div>
                <div className="px-3 py-1 grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => setSortDir('asc')}
                    className={`py-1 rounded border text-center transition-colors ${
                      sortDir === 'asc'
                        ? 'bg-[#2E7CF6] border-[#2E7CF6] text-white'
                        : 'bg-[#11151C] border-[#2A3446] text-slate-300 hover:bg-[#1F2735]'
                    }`}
                  >
                    Ascending
                  </button>
                  <button
                    type="button"
                    onClick={() => setSortDir('desc')}
                    className={`py-1 rounded border text-center transition-colors ${
                      sortDir === 'desc'
                        ? 'bg-[#2E7CF6] border-[#2E7CF6] text-white'
                        : 'bg-[#11151C] border-[#2A3446] text-slate-300 hover:bg-[#1F2735]'
                    }`}
                  >
                    Descending
                  </button>
                </div>

                <div className="my-1.5 border-t border-[#2A3446]" />
                <div className="px-3 py-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                  Group By
                </div>
                {(
                  [
                    ['none', 'None (Flat List)'],
                    ['likelihood', 'Recovery Likelihood'],
                    ['type', 'File Type'],
                    ['origin', 'Origin / Partition'],
                    ['date', 'Date Modified'],
                  ] as [GroupByKey, string][]
                ).map(([gKey, gLabel]) => (
                  <button
                    key={gKey}
                    type="button"
                    onClick={() => {
                      setGroupBy(gKey);
                      setCollapsedGroups(new Set());
                    }}
                    className="w-full px-3 py-1.5 flex items-center justify-between text-left text-slate-200 hover:bg-[#283244] transition-colors"
                  >
                    <span>{gLabel}</span>
                    {groupBy === gKey && <Check className="w-3.5 h-3.5 text-[#38BDF8]" />}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Filter Modal Trigger */}
          <button
            type="button"
            onClick={() => setFilterOpen(true)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors whitespace-nowrap ${
              hasCustomFilters
                ? 'bg-[#2E7CF6]/15 border-[#2E7CF6] text-[#60A5FA]'
                : 'bg-[#1F2735] border-[#2A3446] text-slate-200 hover:bg-[#283244]'
            }`}
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            Filter
          </button>

          {/* Export DFXML Forensic Report */}
          <button
            type="button"
            onClick={() => void handleExportDfxml()}
            disabled={allItems.length === 0}
            title="Export forensic inventory & byte runs as DFXML XML"
            className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border bg-[#1F2735] border-[#2A3446] text-slate-200 hover:bg-[#283244] disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
          >
            <FileCode className="w-3.5 h-3.5 text-[#38BDF8]" />
            DFXML
          </button>

          {/* Search Box */}
          <div className="relative w-48 lg:w-60">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search files or folders"
              className="w-full pl-8 pr-7 py-1.5 rounded-md bg-[#11151C] border border-[#2A3446] text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-[#2E7CF6]"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200"
                aria-label="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Main 3-Pane Explorer Body */}
      <div className="flex-1 min-h-0 flex relative">
        {dragActive && (
          <div className="absolute inset-0 z-40 bg-[#11151C]/85 border-2 border-dashed border-[#2E7CF6] flex items-center justify-center pointer-events-none animate-backdrop-in">
            <div className="bg-[#181E29] border border-[#2A3446] rounded-lg px-6 py-4 text-center space-y-1 animate-modal-in">
              <Upload className="w-6 h-6 text-[#38BDF8] mx-auto" />
              <div className="text-sm font-medium text-slate-100">
                Drop Disk Image (.img / .dd / .raw / .iso) or Unknown Files
              </div>
              <div className="text-xs text-slate-400">
                All binary parsing runs locally in your Windows browser session
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

        {/* Center File List & Contextual Action Strip */}
        <main className="flex-1 min-w-0 flex flex-col bg-[#11151C]">
          {loadError && (
            <div className="mx-4 mt-3 px-3.5 py-2.5 rounded-md bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center justify-between gap-3 animate-slide-down">
              <span>{loadError}</span>
              <button type="button" onClick={() => setLoadError(null)} className="text-rose-200">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {mbrActionNotice && (
            <div className="mx-4 mt-3 px-3.5 py-2.5 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center justify-between gap-3 animate-slide-down">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{mbrActionNotice}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={handleDownloadRepairedImg}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-100 font-medium"
                >
                  <Download className="w-3 h-3" />
                  Export Repaired .img
                </button>
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

          {/* Lost Partition Notification Banner */}
          {lostPartitions.length > 0 && !lostBannerDismissed && (
            <div className="mx-4 mt-3 px-4 py-2.5 rounded-md bg-[#181E29] border border-[#2A3446] flex flex-wrap items-center justify-between gap-3 text-xs animate-slide-down">
              <div className="flex items-center gap-2.5">
                <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
                <div>
                  <span className="font-semibold text-slate-100">Lost partitions found</span>
                  <span className="text-slate-400 ml-2">
                    Detected {lostPartitions.length} unmapped Windows/disk filesystem
                    {lostPartitions.length > 1 ? 's' : ''} (
                    {lostPartitions
                      .map((p) => p.detectedFs?.filesystem ?? p.typeName)
                      .join(', ')}
                    ) outside the active MBR table.
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    navigateToNode({
                      kind: 'partition',
                      partitionId: lostPartitions[0].id,
                    });
                    setFocusedFileId(null);
                  }}
                  className="px-2.5 py-1 rounded bg-[#1F2735] border border-[#2A3446] text-slate-200 hover:bg-[#283244] transition-colors"
                >
                  Inspect Lost Partition
                </button>
                <button
                  type="button"
                  onClick={() => handleRestorePartitionToMbr(lostPartitions[0])}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#2E7CF6] text-white hover:bg-[#2569D6] font-medium transition-colors"
                >
                  <Wrench className="w-3 h-3" />
                  Restore to MBR
                </button>
                <button
                  type="button"
                  onClick={() => setLostBannerDismissed(true)}
                  className="p-1 text-slate-400 hover:text-slate-200"
                  aria-label="Dismiss lost partition banner"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* Contextual Partition Geometry Strip in Path Mode */}
          {treeMode === 'path' &&
            (selectedNode.kind === 'disk-root' || selectedNode.kind === 'partition') && (
              <div className="mx-4 mt-3 px-4 py-2.5 rounded-md bg-[#141922] border border-[#2A3446] flex flex-wrap items-center justify-between gap-3 text-xs animate-slide-down">
                {focusedPartition ? (
                  <>
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="font-semibold text-slate-100">
                        {focusedPartition.detectedFs?.filesystem ?? focusedPartition.typeName} ·{' '}
                        {focusedPartition.name}
                      </span>
                      <span className="text-slate-400 font-mono tabular-nums">
                        LBA {focusedPartition.startLba}–{focusedPartition.endLba} ·{' '}
                        {formatBytes(focusedPartition.sizeBytes)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {focusedPartition.status === 'Deleted / Lost' && (
                        <button
                          type="button"
                          onClick={() => handleRestorePartitionToMbr(focusedPartition)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#2E7CF6] text-white hover:bg-[#2569D6] font-medium"
                        >
                          <Wrench className="w-3 h-3" />
                          Write to MBR
                        </button>
                      )}
                      {repairedDiskBytes && (
                        <button
                          type="button"
                          onClick={handleDownloadRepairedImg}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#1F2735] border border-[#2A3446] text-slate-200 hover:bg-[#283244]"
                        >
                          <Download className="w-3 h-3" />
                          Export Repaired .img
                        </button>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-3">
                      <span className="font-semibold text-slate-100">{analysis.diskName}</span>
                      <span className="text-slate-400 font-mono tabular-nums">
                        {analysis.arch} · {analysis.partitions.length} partitions ·{' '}
                        {formatBytes(analysis.diskSizeBytes)}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setDriveHubOpen(true)}
                      className="px-2.5 py-1 rounded bg-[#1F2735] border border-[#2A3446] text-slate-200 hover:bg-[#283244]"
                    >
                      Partition Map &amp; Scan Scope
                    </button>
                  </>
                )}
              </div>
            )}

          {/* Contextual fidentify Drop Strip */}
          {selectedNode.kind === 'fidentify' && (
            <div className="mx-4 mt-3 px-4 py-3 rounded-md bg-[#181E29] border border-[#2A3446] flex flex-wrap items-center justify-between gap-3 text-xs animate-slide-down">
              <div>
                <div className="font-semibold text-slate-100">
                  Unknown File Signature Inspector (fidentify)
                </div>
                <div className="text-slate-400 mt-0.5">
                  Drop or select extensionless / corrupted files to identify their true format by magic header.
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleLoadSampleUnknown}
                  className="px-3 py-1.5 rounded bg-[#1F2735] border border-[#2A3446] text-slate-200 hover:bg-[#283244]"
                >
                  Load Sample Unknown Files
                </button>
                <button
                  type="button"
                  onClick={() => unknownInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#2E7CF6] text-white hover:bg-[#2569D6] font-medium"
                >
                  <Upload className="w-3.5 h-3.5" />
                  Select Files
                </button>
              </div>
            </div>
          )}

          {/* Center File Table or Grid */}
          <div className="flex-1 min-h-0 overflow-y-auto mt-2">
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
                    ? 'Click "Select Files" or "Load Sample Unknown Files" above to inspect raw binary headers.'
                    : 'Try switching between Type and Path in the left sidebar, or adjust Filter options.'}
                </div>
              </div>
            ) : viewMode === 'list' ? (
              <table className="w-full text-left border-collapse text-xs">
                <thead className="sticky top-0 z-10 bg-[#141922] border-y border-[#2A3446] text-slate-400 select-none">
                  <tr>
                    <th className="w-10 py-2.5 pl-4 pr-2">
                      <input
                        type="checkbox"
                        checked={allVisibleChecked}
                        onChange={toggleAllVisible}
                        aria-label="Select all visible files"
                        className="w-3.5 h-3.5 rounded border-[#3B4963] bg-[#11151C] text-[#2E7CF6] cursor-pointer"
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
                      className="py-2.5 px-2 font-medium cursor-pointer hover:text-slate-200 text-right"
                    >
                      Size {sortKey === 'size' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                    </th>
                    <th
                      onClick={() => toggleSort('likelihood')}
                      className="py-2.5 px-2 font-medium cursor-pointer hover:text-slate-200 text-right"
                    >
                      Likelihood {sortKey === 'likelihood' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                    </th>
                    <th
                      onClick={() => toggleSort('origin')}
                      className="py-2.5 pl-2 pr-4 font-medium cursor-pointer hover:text-slate-200 text-right hidden xl:table-cell"
                    >
                      Origin {sortKey === 'origin' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1E2532]">
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
                            className="bg-[#141922]/90 cursor-pointer hover:bg-[#1A212E] select-none"
                          >
                            <td colSpan={7} className="px-4 py-2 font-semibold text-slate-200">
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
                            const lbc = likelihoodBadgeClasses(item.recoveryTier);
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
                                    ? 'bg-[#283244] text-white'
                                    : 'hover:bg-[#1A212E] text-slate-200'
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
                                    className="w-3.5 h-3.5 rounded border-[#3B4963] bg-[#11151C] text-[#2E7CF6] cursor-pointer"
                                  />
                                </td>
                                <td className="py-2 px-2">
                                  <div className="flex items-center gap-2.5 min-w-0">
                                    <FileThumbnail item={item} size="sm" />
                                    <span className="font-mono truncate">{item.filename}</span>
                                  </div>
                                </td>
                                <td className="py-2 px-2 font-mono text-slate-400 tabular-nums whitespace-nowrap hidden lg:table-cell">
                                  {formatShortDate(item.modifiedAt)}
                                </td>
                                <td className="py-2 px-2 text-slate-300 uppercase font-mono whitespace-nowrap">
                                  {item.extension} File
                                </td>
                                <td className="py-2 px-2 text-right font-mono text-slate-300 tabular-nums whitespace-nowrap">
                                  {formatBytes(item.size)}
                                </td>
                                <td className="py-2 px-2 text-right whitespace-nowrap">
                                  <div className="inline-flex items-center justify-end gap-2">
                                    <div className="w-12 h-1.5 rounded-full bg-[#11151C] overflow-hidden hidden sm:block">
                                      <div
                                        className={`h-full rounded-full ${lbc.bar}`}
                                        style={{ width: `${item.recoveryChance}%` }}
                                      />
                                    </div>
                                    <span
                                      className={`font-mono font-semibold tabular-nums ${lbc.text}`}
                                    >
                                      {item.recoveryChance}%
                                    </span>
                                  </div>
                                </td>
                                <td className="py-2 pl-2 pr-4 text-right text-slate-400 truncate max-w-[160px] hidden xl:table-cell">
                                  {item.partitionName}
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
                          className="w-full flex items-center gap-2 px-2 py-1.5 rounded bg-[#141922] border border-[#2A3446] text-xs font-semibold text-slate-200 hover:bg-[#1A212E]"
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
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                          {section.items.map((item) => {
                            const isFocused = focusedFileId === item.id;
                            const isChecked = checkedIds.has(item.id);
                            const lbc = likelihoodBadgeClasses(item.recoveryTier);
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
                                    ? 'bg-[#283244] border-[#2E7CF6]'
                                    : 'bg-[#181E29] border-[#2A3446] hover:bg-[#1F2735] hover:-translate-y-0.5'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => toggleFileCheck(item.id)}
                                  onClick={(e) => e.stopPropagation()}
                                  aria-label={`Select ${item.filename}`}
                                  className="absolute top-2.5 left-2.5 w-3.5 h-3.5 rounded border-[#3B4963] bg-[#11151C] text-[#2E7CF6] cursor-pointer"
                                />
                                <span
                                  className={`absolute top-2 right-2.5 text-[11px] font-mono font-semibold tabular-nums ${lbc.text}`}
                                >
                                  {item.recoveryChance}%
                                </span>

                                <div className="flex justify-center py-4 relative">
                                  <FileThumbnail item={item} size="lg" />
                                  {(item.family === 'Pictures' || item.family === 'Videos') && (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setFocusedFileId(item.id);
                                        setLightboxOpen(true);
                                      }}
                                      className="absolute bottom-2 right-2 p-1 rounded bg-[#11151C]/90 border border-[#2A3446] text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity"
                                      title="Zoom preview"
                                      aria-label={`Zoom ${item.filename}`}
                                    >
                                      <ZoomIn className="w-3 h-3" />
                                    </button>
                                  )}
                                </div>
                                <div className="text-xs font-mono text-slate-100 truncate text-center">
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
          lightboxOpen={lightboxOpen}
          onSetLightboxOpen={setLightboxOpen}
        />
      </div>

      {/* Bottom Live Discovery Strip + Scan & Recovery Bar */}
      <footer className="shrink-0 bg-[#181E29] border-t border-[#2A3446] relative overflow-hidden">
        {isScanning && !isPaused && (
          <div className="h-0.5 w-full bg-[#11151C] overflow-hidden">
            <div className="h-full w-1/3 bg-gradient-to-r from-transparent via-[#2E7CF6] to-transparent animate-scan-sweep" />
          </div>
        )}
        <div className="h-16 px-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3.5 min-w-0">
            {/* Circular SVG Progress Ring */}
            <div className="relative w-10 h-10 flex items-center justify-center shrink-0">
              <svg className="w-10 h-10 -rotate-90" viewBox="0 0 36 36">
                <circle
                  cx="18"
                  cy="18"
                  r={ringRadius}
                  fill="none"
                  stroke="#2A3446"
                  strokeWidth="3"
                />
                <circle
                  cx="18"
                  cy="18"
                  r={ringRadius}
                  fill="none"
                  stroke="#2E7CF6"
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
              <div className="text-xs font-medium text-slate-100 flex items-center gap-2 whitespace-nowrap">
                <span>
                  {isScanning
                    ? isPaused
                      ? 'Scan paused'
                      : 'Advanced Scanning,'
                    : 'Scan complete ·'}
                </span>
                <span className="text-slate-300 tabular-nums">
                  Files Found:{' '}
                  <span className="text-[#60A5FA] font-semibold">
                    {isScanning ? scanProgress.foundCount : carvedItems.length}
                  </span>{' '}
                  <span className="text-slate-400">
                    ({formatBytes(isScanning ? scanProgress.foundBytes : totalDiscoveredBytes)})
                  </span>
                </span>
              </div>
              <div className="flex items-center gap-2.5 text-[11px] text-slate-400 font-mono tabular-nums mt-0.5 truncate">
                <span>
                  Reading sector {scanProgress.currentSector.toLocaleString()}/
                  {scanProgress.totalSectors.toLocaleString()}
                </span>
                {scanProgress.latestFilename && isScanning && (
                  <span className="hidden md:inline text-slate-500 truncate">
                    · Carving {scanProgress.latestFilename}
                  </span>
                )}
                {isScanning ? (
                  useNativeScan ? (
                    <span className="inline-flex items-center gap-2.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          const bridge = getDesktopBridge();
                          const scanId = activeNativeScanIdRef.current;
                          if (!bridge || !scanId) return;
                          const next = !isPaused;
                          setIsPaused(next);
                          if (next) void bridge.pauseDriveScan(scanId);
                          else void bridge.resumeDriveScan(scanId);
                        }}
                        className="inline-flex items-center gap-1 text-slate-300 hover:text-white font-sans shrink-0"
                      >
                        {isPaused ? (
                          <>
                            <Play className="w-3 h-3" /> Resume
                          </>
                        ) : (
                          <>
                            <Pause className="w-3 h-3" /> Pause
                          </>
                        )}
                      </button>
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
                        className="inline-flex items-center gap-1 text-amber-300 hover:text-white font-sans shrink-0"
                      >
                        <X className="w-3 h-3" /> Stop Scan
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        const next = !isPaused;
                        isPausedRef.current = next;
                        setIsPaused(next);
                      }}
                      className="inline-flex items-center gap-1 text-slate-300 hover:text-white font-sans shrink-0"
                    >
                      {isPaused ? (
                        <>
                          <Play className="w-3 h-3" /> Resume
                        </>
                      ) : (
                        <>
                          <Pause className="w-3 h-3" /> Pause
                        </>
                      )}
                    </button>
                  )
                ) : (
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
                    className="inline-flex items-center gap-1 text-[#60A5FA] hover:underline font-sans shrink-0"
                  >
                    <RotateCcw className="w-3 h-3" /> Re-scan
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            {checkedItems.length > 0 && (
              <div className="text-xs text-slate-300 tabular-nums hidden sm:flex items-center gap-2">
                <span>
                  Selected:{' '}
                  <span className="text-[#60A5FA] font-medium">
                    {checkedItems.length} {checkedItems.length === 1 ? 'file' : 'files'} (
                    {formatBytes(checkedBytes)})
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
              className="px-5 py-2 rounded-md text-xs font-medium bg-[#2E7CF6] hover:bg-[#2569D6] active:scale-[0.98] disabled:opacity-40 text-white transition-all whitespace-nowrap shrink-0"
            >
              {checkedItems.length > 0 ? 'Recover' : 'Recover All...'}
            </button>
          </div>
        </div>
      </footer>

      {/* Right-Click File Context Menu */}
      {contextMenu && (
        <div
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 200),
            top: Math.min(contextMenu.y, window.innerHeight - 170),
          }}
          onMouseDown={(e) => e.stopPropagation()}
          className="fixed z-50 w-48 rounded-md bg-[#181E29] border border-[#2A3446] shadow-2xl py-1 text-xs animate-modal-in"
        >
          <button
            type="button"
            onClick={() => {
              setFocusedFileId(contextMenu.item.id);
              setLightboxOpen(true);
              setContextMenu(null);
            }}
            className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-slate-200 hover:bg-[#283244]"
          >
            <Eye className="w-3.5 h-3.5 text-[#38BDF8]" />
            Preview &amp; Zoom
          </button>
          <button
            type="button"
            onClick={() => {
              void handleDownloadSingleFile(contextMenu.item);
              setContextMenu(null);
            }}
            className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-slate-200 hover:bg-[#283244]"
          >
            <Download className="w-3.5 h-3.5 text-emerald-400" />
            Save File Directly
          </button>
          {contextMenu.item.status === 'OK_TRUNCATED' && !contextMenu.item.repaired && (
            <button
              type="button"
              onClick={() => {
                handleRepairFile(contextMenu.item);
                setContextMenu(null);
              }}
              className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-amber-300 hover:bg-[#283244]"
            >
              <Wrench className="w-3.5 h-3.5" />
              Repair File Structure
            </button>
          )}
          <div className="my-1 border-t border-[#2A3446]" />
          <button
            type="button"
            onClick={() => {
              toggleFileCheck(contextMenu.item.id);
              setContextMenu(null);
            }}
            className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-slate-200 hover:bg-[#283244]"
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
          statusFilter={statusFilter}
          likelihoodFilter={likelihoodFilter}
          sizeFilter={sizeFilter}
          hideDuplicates={hideDuplicates}
          onChangeBlockSize={setBlockSize}
          onChangeParanoid={setParanoid}
          onChangeKeepCorrupted={setKeepCorrupted}
          onChangeEnabledFormats={setEnabledFormats}
          onChangeStatusFilter={setStatusFilter}
          onChangeLikelihoodFilter={setLikelihoodFilter}
          onChangeSizeFilter={setSizeFilter}
          onChangeHideDuplicates={setHideDuplicates}
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
          repairedDiskBytes={repairedDiskBytes}
          onClose={() => setRecoveryOpen(false)}
        />
      )}

      {driveHubOpen && (
        <DriveHubModal
          analysis={analysis}
          activePartitionScope={scanPartitionScope}
          onStartTargetedScan={(part) => startFreshScanState(diskBytes, part ? part.id : null)}
          onOpenPhysicalDrive={handleOpenPhysicalDrive}
          onScanFolder={() => void handleScanFolder()}
          onScanRecycleBin={handleScanRecycleBin}
          onOpenDiskPicker={() => void handleOpenDiskPicker()}
          onClose={() => setDriveHubOpen(false)}
        />
      )}
    </div>
  );
};

export default App;
