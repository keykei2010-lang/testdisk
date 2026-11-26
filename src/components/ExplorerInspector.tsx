import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Download,
  FileText,
  Film,
  HardDrive,
  Image as ImageIcon,
  Maximize2,
  Music,
  RotateCcw,
  ShieldAlert,
  Wrench,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { DiskAnalysisResult, PartitionEntry } from '../engine/partitions';
import { ExplorerFileItem } from '../engine/explorerTypes';
import { formatBytes } from '../engine/crc32';
import { getDesktopBridge, VideoPreviewResult } from '../engine/desktopBridge';
import {
  formatShortDate,
  isNonMediaRepairableExtension,
  resolvePreferredExtension,
} from '../engine/recoveryHealth';
import { useMediaUrl } from '../utils/useMediaUrl';
import { HexViewer } from './HexViewer';

interface ExplorerInspectorProps {
  focusedFile: ExplorerFileItem | null;
  focusedPartition: PartitionEntry | null;
  analysis: DiskAnalysisResult;
  diskBytes: Uint8Array;
  onRestorePartitionToMbr: (partition: PartitionEntry) => void;
  onRepairFile: (item: ExplorerFileItem, referenceBytes?: Uint8Array) => Promise<void> | void;
  onBitLockerUnlocked?: () => void;
  lightboxOpen: boolean;
  onSetLightboxOpen: (open: boolean) => void;
}

function likelihoodColors(tier: ExplorerFileItem['recoveryTier']) {
  if (tier === 'high') {
    return { text: 'text-emerald-400', bar: 'bg-emerald-500', label: 'Excellent' };
  }
  if (tier === 'medium') {
    return { text: 'text-amber-400', bar: 'bg-amber-500', label: 'Fair' };
  }
  return { text: 'text-rose-400', bar: 'bg-rose-500', label: 'Poor' };
}

export const ExplorerInspector: React.FC<ExplorerInspectorProps> = ({
  focusedFile,
  focusedPartition,
  analysis,
  diskBytes,
  onRestorePartitionToMbr,
  onRepairFile,
  onBitLockerUnlocked,
  lightboxOpen,
  onSetLightboxOpen,
}) => {
  const desktop = getDesktopBridge();
  const [blLetter, setBlLetter] = useState<string>('C:');
  const [blSecret, setBlSecret] = useState<string>('');
  const [blSecretType, setBlSecretType] = useState<'key' | 'password'>('key');
  const [blNotice, setBlNotice] = useState<string | null>(null);
  const [blBusy, setBlBusy] = useState<boolean>(false);
  const partitionKey = focusedPartition?.id ?? 'disk-root';
  const [sectorOverride, setSectorOverride] = useState<{
    partitionKey: string;
    lba: number;
  } | null>(null);
  const inspectLba =
    sectorOverride && sectorOverride.partitionKey === partitionKey
      ? sectorOverride.lba
      : (focusedPartition?.startLba ?? 0);

  const [showHex, setShowHex] = useState<boolean>(false);

  const fileKey = focusedFile?.id ?? 'none';
  const [zoomState, setZoomState] = useState<{
    fileKey: string;
    inlineZoom: number;
    modalZoom: number;
    panX: number;
    panY: number;
  }>({
    fileKey: 'none',
    inlineZoom: 1,
    modalZoom: 1,
    panX: 0,
    panY: 0,
  });

  const inlineZoom = zoomState.fileKey === fileKey ? zoomState.inlineZoom : 1;
  const modalZoom = zoomState.fileKey === fileKey ? zoomState.modalZoom : 1;
  const panX = zoomState.fileKey === fileKey ? zoomState.panX : 0;
  const panY = zoomState.fileKey === fileKey ? zoomState.panY : 0;

  const dragRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    origPanX: number;
    origPanY: number;
  }>({ active: false, startX: 0, startY: 0, origPanX: 0, origPanY: 0 });
  const [isDragging, setIsDragging] = useState<boolean>(false);

  const updateZoom = (
    patch: Partial<{ inlineZoom: number; modalZoom: number; panX: number; panY: number }>,
  ) => {
    setZoomState((prev) => {
      const base =
        prev.fileKey === fileKey
          ? prev
          : { fileKey, inlineZoom: 1, modalZoom: 1, panX: 0, panY: 0 };
      return { ...base, ...patch, fileKey };
    });
  };

  const clampZoom = (val: number) => Math.min(5, Math.max(0.5, Math.round(val * 100) / 100));

  const isPreviewMedia =
    focusedFile?.family === 'Pictures' ||
    focusedFile?.family === 'Audio' ||
    focusedFile?.family === 'Videos';
  const previewCacheKey = focusedFile
    ? `${focusedFile.id}:${focusedFile.repaired ? '1' : '0'}:${focusedFile.data.byteLength}`
    : 'none';
  const previewUrl = useMediaUrl({
    enabled: Boolean(focusedFile && isPreviewMedia),
    cacheKey: previewCacheKey,
    browserFile: focusedFile?.sourceRef?.browserFile,
    nativeKind: focusedFile?.sourceRef?.kind,
    devicePath: focusedFile?.sourceRef?.devicePath,
    data: focusedFile?.data,
    mimeType: focusedFile?.mimeType,
  });
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null);
  const [failedVideoUrl, setFailedVideoUrl] = useState<string | null>(null);
  const [videoProbeState, setVideoProbeState] = useState<{
    fileId: string;
    result: VideoPreviewResult | null;
  } | null>(null);
  const [loadedHexState, setLoadedHexState] = useState<{
    fileId: string;
    bytes: Uint8Array;
  } | null>(null);

  useEffect(() => {
    if (!desktop || !focusedFile || focusedFile.family !== 'Videos') return;
    let active = true;
    const ref = focusedFile.sourceRef;
    const params =
      ref?.kind === 'native-file' && ref.devicePath
        ? { filePath: ref.devicePath }
        : ref?.kind === 'native-tsk' && ref.devicePath
          ? {
              devicePath: ref.devicePath,
              tskInode: ref.tskInode,
              tskOffset: ref.tskOffset,
            }
          : focusedFile.data.byteLength > 0
            ? { buffer: focusedFile.data }
            : null;
    if (!params) return;

    desktop
      .probeVideoPreview(params)
      .then((res) => {
        if (!active) return;
        setVideoProbeState({ fileId: focusedFile.id, result: res });
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [desktop, focusedFile]);

  useEffect(() => {
    if (!showHex || !desktop || !focusedFile || focusedFile.data.length > 0) return;
    const ref = focusedFile.sourceRef;
    if (!ref?.devicePath) return;
    let active = true;
    desktop
      .readDiskBytes(
        ref.devicePath,
        ref.kind === 'native-file' ? 0 : ref.offset,
        4096,
        ref.tskInode,
        ref.tskOffset,
      )
      .then((bytes) => {
        if (!active || bytes.length === 0) return;
        setLoadedHexState({ fileId: focusedFile.id, bytes });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [showHex, desktop, focusedFile]);

  useEffect(() => {
    if (!lightboxOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onSetLightboxOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [lightboxOpen, onSetLightboxOpen]);

  const handleDownloadFile = async (item: ExplorerFileItem) => {
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
            repairIfTruncated:
              item.status === 'OK_TRUNCATED' ||
              (item.status === 'HEADER_ONLY' && isNonMediaRepairableExtension(item.extension)),
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

  // --- Mode A: Focused File Inspector (Matches Screenshot 1 right pane) ---
  if (focusedFile) {
    const isImage = focusedFile.family === 'Pictures';
    const isAudio = focusedFile.family === 'Audio';
    const isVideo = focusedFile.family === 'Videos';
    const isZoomableMedia = isImage || isVideo;
    const isTextLike = [
      'pdf', 'txt', 'json', 'xml', 'svg', 'html', 'htm', 'eml',
      'aepx', 'rpy', 'py', 'ini', 'sql', 'csv', 'rtf', 'md', 'log',
    ].includes(focusedFile.extension.toLowerCase());
    const canRepairNonMedia =
      !focusedFile.repaired &&
      isNonMediaRepairableExtension(focusedFile.extension) &&
      (focusedFile.status === 'OK_TRUNCATED' || focusedFile.status === 'HEADER_ONLY' || focusedFile.recoveryChance < 90);

    const lc = likelihoodColors(focusedFile.recoveryTier);
    const videoProbe =
      videoProbeState?.fileId === focusedFile.id ? videoProbeState.result : null;
    const videoMetaParts = [
      videoProbe?.codec ? videoProbe.codec.toUpperCase() : null,
      videoProbe?.width && videoProbe?.height
        ? `${videoProbe.width}×${videoProbe.height}`
        : null,
      videoProbe?.durationSec != null && videoProbe.durationSec > 0
        ? `${Math.round(videoProbe.durationSec)}s`
        : null,
    ].filter(Boolean);
    const hexBytes =
      focusedFile.data.length > 0
        ? focusedFile.data
        : loadedHexState?.fileId === focusedFile.id
          ? loadedHexState.bytes
          : focusedFile.data;

    return (
      <>
        <aside className="w-72 xl:w-[304px] shrink-0 bg-[#1E2129] border-l border-[#2A2E39] flex flex-col relative">
          <div key={focusedFile.id} className="flex-1 overflow-y-auto p-4 pb-16 space-y-4 animate-row-fade">
            {/* Centered Media Preview Box */}
            <div className="bg-[#14171D] rounded-md border border-[#2A2E39] overflow-hidden flex flex-col items-center justify-center min-h-[156px] p-2.5 relative group">
              {previewUrl && isImage && failedPreviewUrl !== previewUrl ? (
                <div
                  className="w-full h-36 flex items-center justify-center overflow-hidden cursor-zoom-in"
                  onDoubleClick={() => onSetLightboxOpen(true)}
                  onWheel={(e) => {
                    e.preventDefault();
                    updateZoom({
                      inlineZoom: clampZoom(inlineZoom + (e.deltaY < 0 ? 0.25 : -0.25)),
                    });
                  }}
                >
                  <img
                    key={previewUrl}
                    src={previewUrl}
                    alt={focusedFile.filename}
                    referrerPolicy="no-referrer"
                    onError={() => setFailedPreviewUrl(previewUrl)}
                    style={{ transform: `scale(${inlineZoom})` }}
                    className="max-h-36 object-contain rounded transition-transform duration-150 ease-out"
                  />
                </div>
              ) : isImage ? (
                <div className="text-center space-y-1.5 py-4 px-2">
                  <ImageIcon
                    className={`w-7 h-7 mx-auto ${
                      focusedFile.status === 'OK_TRUNCATED' && !focusedFile.repaired
                        ? 'text-amber-400'
                        : 'text-slate-400'
                    }`}
                  />
                  <div className="text-xs text-slate-300 font-medium">
                    {focusedFile.status === 'OK_TRUNCATED' && !focusedFile.repaired
                      ? 'Truncated image header/footer'
                      : 'Raw carved image bitstream'}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {focusedFile.status === 'OK_TRUNCATED' && !focusedFile.repaired
                      ? 'Use Repair Corrupted Structure below'
                      : 'Inspect hex or save file to open externally'}
                  </div>
                </div>
              ) : previewUrl && isAudio ? (
                <div className="w-full space-y-2 py-2">
                  <div className="flex items-center justify-center gap-2 text-xs text-slate-300">
                    <Music className="w-4 h-4 text-rose-400" />
                    <span>Audio Stream Ready</span>
                  </div>
                  <audio controls src={previewUrl} className="w-full h-9" />
                </div>
              ) : isVideo && previewUrl && failedVideoUrl !== previewUrl ? (
                <div
                  className="w-full h-36 flex items-center justify-center overflow-hidden relative"
                  onDoubleClick={() => onSetLightboxOpen(true)}
                  onWheel={(e) => {
                    e.preventDefault();
                    updateZoom({
                      inlineZoom: clampZoom(inlineZoom + (e.deltaY < 0 ? 0.25 : -0.25)),
                    });
                  }}
                >
                  <video
                    controls
                    src={previewUrl}
                    onError={() => setFailedVideoUrl(previewUrl)}
                    style={{ transform: `scale(${inlineZoom})` }}
                    className="max-h-36 w-full rounded transition-transform duration-150 ease-out"
                  />
                  {videoMetaParts.length > 0 && (
                    <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/75 border border-white/10 text-[10px] font-mono text-slate-200 pointer-events-none">
                      {videoMetaParts.join(' · ')}
                    </span>
                  )}
                </div>
              ) : isVideo && videoProbe?.thumbnailDataUrl ? (
                <div
                  className="w-full h-36 flex items-center justify-center overflow-hidden relative cursor-zoom-in"
                  onDoubleClick={() => onSetLightboxOpen(true)}
                  onWheel={(e) => {
                    e.preventDefault();
                    updateZoom({
                      inlineZoom: clampZoom(inlineZoom + (e.deltaY < 0 ? 0.25 : -0.25)),
                    });
                  }}
                >
                  <img
                    src={videoProbe.thumbnailDataUrl}
                    alt={`${focusedFile.filename} keyframe`}
                    style={{ transform: `scale(${inlineZoom})` }}
                    className="max-h-36 object-contain rounded transition-transform duration-150 ease-out"
                  />
                  <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/75 border border-white/10 text-[10px] font-mono text-violet-300 pointer-events-none">
                    FFmpeg Keyframe
                  </span>
                  {videoMetaParts.length > 0 && (
                    <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/75 border border-white/10 text-[10px] font-mono text-slate-200 pointer-events-none">
                      {videoMetaParts.join(' · ')}
                    </span>
                  )}
                </div>
              ) : isVideo ? (
                <div className="text-center space-y-1.5 py-4 px-2">
                  <Film className="w-7 h-7 mx-auto text-violet-400" />
                  <div className="text-xs text-slate-300 font-medium">
                    {videoMetaParts.length > 0 ? videoMetaParts.join(' · ') : 'Video Stream Ready'}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    Save file to reconstruct container &amp; play externally
                  </div>
                </div>
              ) : isTextLike ? (
                <div className="w-full space-y-1.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-[#4C8DFF] font-medium">
                    <FileText className="w-3.5 h-3.5" />
                    <span>Document Preview</span>
                  </div>
                  <pre className="text-[11px] font-mono text-slate-300 max-h-28 overflow-hidden whitespace-pre-wrap break-all">
                    {new TextDecoder().decode(focusedFile.data.subarray(0, 320))}
                  </pre>
                </div>
              ) : (
                <div className="text-center space-y-1.5 py-4">
                  <div className="text-base font-mono font-bold uppercase text-[#4C8DFF]">
                    .{focusedFile.extension}
                  </div>
                  <div className="text-xs text-slate-400">{focusedFile.description}</div>
                </div>
              )}

              {isZoomableMedia && (
                <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none">
                  <div className="flex items-center gap-1 bg-[#1E2129]/95 border border-[#2A2E39] rounded px-1.5 py-0.5 pointer-events-auto shadow-lg">
                    <button
                      type="button"
                      onClick={() => updateZoom({ inlineZoom: clampZoom(inlineZoom - 0.25) })}
                      className="p-0.5 text-slate-300 hover:text-white"
                      aria-label="Zoom out thumbnail"
                    >
                      <ZoomOut className="w-3 h-3" />
                    </button>
                    <span className="text-[10px] font-mono text-slate-200 tabular-nums px-1">
                      {Math.round(inlineZoom * 100)}%
                    </span>
                    <button
                      type="button"
                      onClick={() => updateZoom({ inlineZoom: clampZoom(inlineZoom + 0.25) })}
                      className="p-0.5 text-slate-300 hover:text-white"
                      aria-label="Zoom in thumbnail"
                    >
                      <ZoomIn className="w-3 h-3" />
                    </button>
                    {inlineZoom !== 1 && (
                      <button
                        type="button"
                        onClick={() => updateZoom({ inlineZoom: 1 })}
                        className="p-0.5 text-slate-400 hover:text-white"
                        aria-label="Reset thumbnail zoom"
                      >
                        <RotateCcw className="w-2.5 h-2.5" />
                      </button>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onSetLightboxOpen(true)}
                    className="p-1 rounded bg-[#1E2129]/95 border border-[#2A2E39] text-slate-200 hover:text-white pointer-events-auto shadow-lg"
                    aria-label="Enlarge preview"
                  >
                    <Maximize2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>

            {/* Full-width Preview button (exact Screenshot 1 layout) */}
            <button
              type="button"
              onClick={() => {
                updateZoom({ modalZoom: 1, panX: 0, panY: 0 });
                onSetLightboxOpen(true);
              }}
              className="w-full py-2 px-4 rounded-md text-xs font-medium bg-[#2B303C] hover:bg-[#343B49] text-slate-100 transition-colors"
            >
              Preview
            </button>

            {/* Clean Vertical Metadata Stack matching Screenshot 1 */}
            <div className="space-y-3 text-xs pt-1">
              <div>
                <div className="text-slate-400 text-[11px]">Name</div>
                <div className="text-slate-100 mt-0.5 break-all font-medium">
                  {focusedFile.filename}
                </div>
              </div>

              <div>
                <div className="text-slate-400 text-[11px]">Size</div>
                <div className="text-slate-200 mt-0.5 tabular-nums font-mono">
                  {formatBytes(focusedFile.size)}
                </div>
              </div>

              <div>
                <div className="text-slate-400 text-[11px]">Type</div>
                <div className="text-slate-200 mt-0.5 uppercase">
                  {focusedFile.extension} File
                </div>
              </div>

              <div>
                <div className="text-slate-400 text-[11px]">Date Modified</div>
                <div className="text-slate-200 mt-0.5 font-mono tabular-nums">
                  {formatShortDate(focusedFile.modifiedAt)}
                </div>
              </div>

              <div>
                <div className="text-slate-400 text-[11px]">State</div>
                <div
                  className={`mt-0.5 font-medium ${
                    focusedFile.isDeleted === false ? 'text-slate-200' : 'text-amber-300'
                  }`}
                >
                  {focusedFile.isDeleted === false
                    ? 'Existing Active File'
                    : focusedFile.scanPhase === 'vss'
                      ? 'Deleted (Recovered via Shadow Copy)'
                      : focusedFile.scanPhase === 'usn'
                        ? 'Deleted (NTFS Journal History)'
                        : 'Deleted · Recoverable'}
                </div>
                {(focusedFile.ntfsEncrypted || focusedFile.ntfsCompressed || focusedFile.sizeEstimated) && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {focusedFile.ntfsEncrypted && (
                      <span className="px-1.5 py-0.5 rounded bg-rose-500/15 border border-rose-500/30 text-[10px] text-rose-200">
                        NTFS Encrypted (EFS)
                      </span>
                    )}
                    {focusedFile.ntfsCompressed && (
                      <span className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-[10px] text-amber-200">
                        NTFS Compressed
                      </span>
                    )}
                    {focusedFile.sizeEstimated && (
                      <span className="px-1.5 py-0.5 rounded bg-sky-500/15 border border-sky-500/30 text-[10px] text-sky-200">
                        Estimated Size
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div>
                <div className="text-slate-400 text-[11px]">Path</div>
                <div
                  className="text-slate-200 mt-0.5 truncate"
                  title={focusedFile.originalPath || focusedFile.partitionName}
                >
                  {focusedFile.originalPath || focusedFile.partitionName}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-slate-400">Recovery Health</span>
                  <span className={`font-mono font-semibold tabular-nums ${lc.text}`}>
                    {focusedFile.recoveryChance}% ·{' '}
                    {focusedFile.repaired ? 'Repaired' : lc.label}
                  </span>
                </div>
                <div className="w-full h-1 rounded-full bg-[#2A2E39] overflow-hidden mt-1.5">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${lc.bar}`}
                    style={{ width: `${focusedFile.recoveryChance}%` }}
                  />
                </div>
                <div className="text-[11px] text-slate-400 mt-1 leading-snug">
                  {focusedFile.recoveryReason}
                </div>
              </div>

              {((focusedFile.status === 'OK_TRUNCATED' && !focusedFile.repaired) ||
                canRepairNonMedia ||
                (!focusedFile.repaired &&
                  ((isImage && previewUrl !== null && failedPreviewUrl === previewUrl) ||
                    (isVideo && previewUrl !== null && failedVideoUrl === previewUrl)))) && (
                <div className="space-y-1.5">
                  <button
                    type="button"
                    onClick={() => void onRepairFile(focusedFile)}
                    className="w-full inline-flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-md text-xs font-medium bg-amber-500/15 border border-amber-500/35 text-amber-200 hover:bg-amber-500/25 transition-colors"
                  >
                    <Wrench className="w-3.5 h-3.5" />
                    Repair Corrupted Structure
                  </button>
                  {['mp4', 'mov', 'm4v', '3gp'].includes(focusedFile.extension.toLowerCase()) && (
                    <label className="block w-full text-center py-1 px-2.5 rounded border border-[#343A48] bg-[#242934] hover:bg-[#2C3342] text-[11px] text-slate-200 cursor-pointer transition-colors">
                      Repair with Healthy Reference Video (.mp4/.mov)
                      <input
                        type="file"
                        accept=".mp4,.mov,.m4v,.3gp"
                        className="hidden"
                        onChange={async (e) => {
                          const f = e.target.files?.[0];
                          if (!f) return;
                          const refBytes = new Uint8Array(
                            await f.slice(0, 8 * 1024 * 1024).arrayBuffer(),
                          );
                          void onRepairFile(focusedFile, refBytes);
                          e.target.value = '';
                        }}
                      />
                    </label>
                  )}
                  {['jpg', 'jpeg'].includes(focusedFile.extension.toLowerCase()) && (
                    <label className="block w-full text-center py-1 px-2.5 rounded border border-[#343A48] bg-[#242934] hover:bg-[#2C3342] text-[11px] text-slate-200 cursor-pointer transition-colors">
                      Repair with Healthy Reference Photo (.jpg/.jpeg)
                      <input
                        type="file"
                        accept=".jpg,.jpeg"
                        className="hidden"
                        onChange={async (e) => {
                          const f = e.target.files?.[0];
                          if (!f) return;
                          const refBytes = new Uint8Array(
                            await f.slice(0, 4 * 1024 * 1024).arrayBuffer(),
                          );
                          void onRepairFile(focusedFile, refBytes);
                          e.target.value = '';
                        }}
                      />
                    </label>
                  )}
                </div>
              )}

              {focusedFile.metadata.camera && (
                <div>
                  <div className="text-slate-400 text-[11px]">Camera / EXIF</div>
                  <div className="text-slate-200 mt-0.5">{focusedFile.metadata.camera}</div>
                </div>
              )}

              {focusedFile.sourceRef?.runs && focusedFile.sourceRef.runs.length > 1 && (
                <div>
                  <div className="text-slate-400 text-[11px]">Cluster Extents</div>
                  <div className="text-emerald-300 font-mono mt-0.5">
                    {focusedFile.sourceRef.runs.length} runs linked via{' '}
                    {focusedFile.sourceKind === 'carved'
                      ? 'video cluster stitcher'
                      : 'filesystem metadata'}
                  </div>
                </div>
              )}

              {focusedFile.discoveryCrc32 !== undefined && (
                <div>
                  <div className="text-slate-400 text-[11px]">64 KiB Discovery CRC-32</div>
                  <div className="text-emerald-300 font-mono mt-0.5 tabular-nums">
                    0x{focusedFile.discoveryCrc32.toString(16).padStart(8, '0').toUpperCase()}
                  </div>
                </div>
              )}

              {focusedFile.sourceRef?.kind === 'native-tsk' && focusedFile.sourceRef.tskInode && (
                <div>
                  <div className="text-slate-400 text-[11px]">Sleuth Kit Inode</div>
                  <div className="text-sky-300 font-mono mt-0.5 tabular-nums">
                    Inode {focusedFile.sourceRef.tskInode} (Offset 0x
                    {(focusedFile.sourceRef.tskOffset ?? 0).toString(16)})
                  </div>
                </div>
              )}

              {focusedFile.metadata.details && (
                <div>
                  <div className="text-slate-400 text-[11px]">Details</div>
                  <div className="text-slate-300 mt-0.5">{focusedFile.metadata.details}</div>
                </div>
              )}
            </div>

            {/* Save File + Hex Toggle */}
            <div className="pt-2 border-t border-[#2A2E39] space-y-2.5">
              <button
                type="button"
                onClick={() => void handleDownloadFile(focusedFile)}
                className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-md text-xs font-medium bg-[#3A7AFE] hover:bg-[#2F6EEB] text-white transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                Save File
              </button>

              <button
                type="button"
                onClick={() => setShowHex((v) => !v)}
                className="text-[11px] font-medium text-[#60A5FA] hover:underline"
              >
                {showHex ? 'Hide Header Hex' : 'Inspect Header Hex'}
              </button>

              {showHex && (
                <HexViewer
                  bytes={hexBytes}
                  baseOffset={focusedFile.offset}
                  maxBytes={128}
                  title="Magic Header Bytes"
                  highlightStart={focusedFile.matchedOffset}
                  highlightEnd={focusedFile.matchedOffset + focusedFile.matchedLength}
                />
              )}
            </div>
          </div>

          {/* Floating circular diagnostic/repair tool button matching Screenshots 1-3 */}
          <button
            type="button"
            onClick={() => {
              if ((focusedFile.status === 'OK_TRUNCATED' && !focusedFile.repaired) || canRepairNonMedia) {
                onRepairFile(focusedFile);
              } else {
                setShowHex((v) => !v);
              }
            }}
            title={
              (focusedFile.status === 'OK_TRUNCATED' && !focusedFile.repaired) || canRepairNonMedia
                ? 'Repair corrupted file structure'
                : 'Toggle binary hex signature inspector'
            }
            aria-label="Quick repair and hex inspector"
            className="absolute bottom-4 right-4 w-9 h-9 rounded-full bg-[#2B303C] hover:bg-[#3A7AFE] border border-[#3B4252] text-[#60A5FA] hover:text-white shadow-lg flex items-center justify-center transition-colors"
          >
            <Wrench className="w-4 h-4" />
          </button>
        </aside>

        {/* Fullscreen Preview & Zoom Lightbox */}
        {lightboxOpen && (
          <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 animate-backdrop-in">
            <div className="w-full max-w-4xl rounded-lg bg-[#1E2129] border border-[#2F3544] overflow-hidden shadow-2xl animate-modal-in flex flex-col max-h-[90vh]">
              <div className="flex items-center justify-between px-4 py-3 border-b border-[#2A2E39] gap-3">
                <div className="flex items-center gap-3 min-w-0 text-xs">
                  <span className="font-mono text-slate-100 truncate">
                    {focusedFile.filename} · {formatBytes(focusedFile.size)}
                  </span>
                  <span className="text-slate-500">·</span>
                  <span className={`font-mono font-semibold tabular-nums ${lc.text}`}>
                    {focusedFile.recoveryChance}% {lc.label}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onSetLightboxOpen(false)}
                  className="text-slate-400 hover:text-white p-1 rounded"
                  aria-label="Close preview"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {isZoomableMedia && (
                <div className="px-4 py-2 bg-[#16181F] border-b border-[#2A2E39] flex flex-wrap items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        updateZoom({
                          modalZoom: clampZoom(modalZoom - 0.25),
                          panX: modalZoom - 0.25 <= 1 ? 0 : panX,
                          panY: modalZoom - 0.25 <= 1 ? 0 : panY,
                        })
                      }
                      className="p-1.5 rounded bg-[#262B36] border border-[#343A48] text-slate-200 hover:bg-[#2F3644]"
                      aria-label="Zoom out"
                    >
                      <ZoomOut className="w-3.5 h-3.5" />
                    </button>
                    <input
                      type="range"
                      min={50}
                      max={500}
                      step={10}
                      value={Math.round(modalZoom * 100)}
                      onChange={(e) => {
                        const next = Number(e.target.value) / 100;
                        updateZoom({
                          modalZoom: next,
                          panX: next <= 1 ? 0 : panX,
                          panY: next <= 1 ? 0 : panY,
                        });
                      }}
                      aria-label="Zoom magnification"
                      className="w-32 accent-[#3A7AFE] cursor-pointer"
                    />
                    <button
                      type="button"
                      onClick={() => updateZoom({ modalZoom: clampZoom(modalZoom + 0.25) })}
                      className="p-1.5 rounded bg-[#262B36] border border-[#343A48] text-slate-200 hover:bg-[#2F3644]"
                      aria-label="Zoom in"
                    >
                      <ZoomIn className="w-3.5 h-3.5" />
                    </button>
                    <span className="font-mono text-slate-200 tabular-nums w-12 text-center">
                      {Math.round(modalZoom * 100)}%
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {[
                      { label: 'Fit', z: 1 },
                      { label: '150%', z: 1.5 },
                      { label: '250%', z: 2.5 },
                      { label: '400%', z: 4 },
                    ].map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => updateZoom({ modalZoom: preset.z, panX: 0, panY: 0 })}
                        className={`px-2 py-1 rounded text-[11px] font-mono border transition-colors ${
                          Math.abs(modalZoom - preset.z) < 0.05
                            ? 'bg-[#3A7AFE] border-[#3A7AFE] text-white'
                            : 'bg-[#262B36] border-[#343A48] text-slate-300 hover:bg-[#2F3644]'
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div
                className={`p-6 bg-[#14171D] flex-1 flex flex-col items-center justify-center min-h-[340px] max-h-[65vh] overflow-hidden select-none ${
                  isZoomableMedia && modalZoom > 1
                    ? isDragging
                      ? 'cursor-grabbing'
                      : 'cursor-grab'
                    : isZoomableMedia
                      ? 'cursor-zoom-in'
                      : ''
                }`}
                onWheel={(e) => {
                  if (!isZoomableMedia) return;
                  e.preventDefault();
                  const next = clampZoom(modalZoom + (e.deltaY < 0 ? 0.2 : -0.2));
                  updateZoom({
                    modalZoom: next,
                    panX: next <= 1 ? 0 : panX,
                    panY: next <= 1 ? 0 : panY,
                  });
                }}
                onPointerDown={(e) => {
                  if (!isZoomableMedia || modalZoom <= 1) return;
                  dragRef.current = {
                    active: true,
                    startX: e.clientX,
                    startY: e.clientY,
                    origPanX: panX,
                    origPanY: panY,
                  };
                  setIsDragging(true);
                }}
                onPointerMove={(e) => {
                  if (!dragRef.current.active) return;
                  updateZoom({
                    panX: dragRef.current.origPanX + (e.clientX - dragRef.current.startX),
                    panY: dragRef.current.origPanY + (e.clientY - dragRef.current.startY),
                  });
                }}
                onPointerUp={() => {
                  dragRef.current.active = false;
                  setIsDragging(false);
                }}
                onPointerLeave={() => {
                  dragRef.current.active = false;
                  setIsDragging(false);
                }}
                onDoubleClick={() => {
                  if (!isZoomableMedia) return;
                  if (modalZoom > 1.1) {
                    updateZoom({ modalZoom: 1, panX: 0, panY: 0 });
                  } else {
                    updateZoom({ modalZoom: 2.5, panX: 0, panY: 0 });
                  }
                }}
              >
                {previewUrl && isImage && failedPreviewUrl !== previewUrl ? (
                  <img
                    key={previewUrl}
                    src={previewUrl}
                    alt={focusedFile.filename}
                    referrerPolicy="no-referrer"
                    onError={() => setFailedPreviewUrl(previewUrl)}
                    draggable={false}
                    style={{ transform: `translate(${panX}px, ${panY}px) scale(${modalZoom})` }}
                    className={`max-h-[54vh] object-contain rounded ${
                      isDragging ? '' : 'transition-transform duration-150 ease-out'
                    }`}
                  />
                ) : isImage ? (
                  <div className="w-full max-w-xl space-y-3 text-center">
                    <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs">
                      <ImageIcon className="w-4 h-4" />
                      <span>
                        Browser cannot decode partial bitstream — displaying carved hex header
                      </span>
                    </div>
                    <div className="max-h-[44vh] overflow-auto text-left">
                      <HexViewer
                        bytes={focusedFile.data}
                        baseOffset={focusedFile.offset}
                        maxBytes={512}
                        title="Image Payload Hex"
                        highlightStart={focusedFile.matchedOffset}
                        highlightEnd={focusedFile.matchedOffset + focusedFile.matchedLength}
                      />
                    </div>
                  </div>
                ) : previewUrl && isAudio ? (
                  <audio controls src={previewUrl} className="w-full max-w-md" />
                ) : isVideo && previewUrl && failedVideoUrl !== previewUrl ? (
                  <video
                    controls
                    src={previewUrl}
                    onError={() => setFailedVideoUrl(previewUrl)}
                    style={{ transform: `translate(${panX}px, ${panY}px) scale(${modalZoom})` }}
                    className={`max-h-[54vh] rounded ${
                      isDragging ? '' : 'transition-transform duration-150 ease-out'
                    }`}
                  />
                ) : isVideo && videoProbe?.thumbnailDataUrl ? (
                  <div className="space-y-2 text-center">
                    <img
                      src={videoProbe.thumbnailDataUrl}
                      alt={`${focusedFile.filename} keyframe`}
                      draggable={false}
                      style={{ transform: `translate(${panX}px, ${panY}px) scale(${modalZoom})` }}
                      className={`max-h-[48vh] object-contain rounded mx-auto ${
                        isDragging ? '' : 'transition-transform duration-150 ease-out'
                      }`}
                    />
                    {videoMetaParts.length > 0 && (
                      <div className="text-[11px] font-mono text-slate-300">
                        FFmpeg Keyframe · {videoMetaParts.join(' · ')}
                      </div>
                    )}
                  </div>
                ) : isTextLike ? (
                  <pre className="w-full max-h-[54vh] overflow-auto text-xs font-mono text-slate-200 whitespace-pre-wrap break-all">
                    {new TextDecoder().decode(hexBytes.subarray(0, 8192))}
                  </pre>
                ) : (
                  <div className="w-full max-h-[54vh] overflow-auto">
                    <HexViewer
                      bytes={hexBytes}
                      baseOffset={focusedFile.offset}
                      maxBytes={512}
                      title="Binary Payload (First 512 B)"
                      highlightStart={focusedFile.matchedOffset}
                      highlightEnd={focusedFile.matchedOffset + focusedFile.matchedLength}
                    />
                  </div>
                )}
              </div>

              <div className="px-4 py-3 border-t border-[#2A2E39] bg-[#16181F] flex items-center justify-between gap-2">
                <div className="text-xs text-slate-400 flex items-center gap-2">
                  {focusedFile.status === 'OK' || focusedFile.repaired ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  ) : (
                    <ShieldAlert className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  )}
                  <span>{focusedFile.recoveryReason}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {focusedFile.status === 'OK_TRUNCATED' && !focusedFile.repaired && (
                    <button
                      type="button"
                      onClick={() => onRepairFile(focusedFile)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-amber-500/20 border border-amber-500/35 text-amber-200 rounded-md hover:bg-amber-500/30"
                    >
                      <Wrench className="w-3.5 h-3.5" />
                      Repair File
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleDownloadFile(focusedFile)}
                    className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium bg-[#3A7AFE] text-white rounded-md hover:bg-[#2F6EEB]"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Save File
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  // --- Mode B: Partition / Disk Inspector (Matches Screenshot 2 right pane) ---
  const sectorOffset = inspectLba * analysis.sectorSize;
  const sectorSlice = diskBytes.subarray(sectorOffset, sectorOffset + analysis.sectorSize);
  const isLost = focusedPartition?.status === 'Deleted / Lost';

  const canRestoreMbr =
    isLost &&
    Boolean(focusedPartition) &&
    analysis.arch !== 'EFI GPT' &&
    diskBytes.length >= analysis.diskSizeBytes &&
    diskBytes.length > 0;

  return (
    <aside className="w-72 xl:w-[304px] shrink-0 bg-[#1E2129] border-l border-[#2A2E39] flex flex-col relative">
      <div className="flex-1 overflow-y-auto p-4 pb-16 space-y-4 animate-row-fade">
        <div className="bg-[#14171D] rounded-md border border-[#2A2E39] p-6 flex items-center justify-center">
          <div className="w-16 h-16 rounded-lg bg-[#3A7AFE]/20 border border-[#3A7AFE]/40 flex items-center justify-center">
            <HardDrive className="w-8 h-8 text-[#4C8DFF]" />
          </div>
        </div>

        <button
          type="button"
          disabled={isLost && Boolean(focusedPartition) && !canRestoreMbr}
          onClick={() => {
            if (isLost && focusedPartition) {
              if (canRestoreMbr) onRestorePartitionToMbr(focusedPartition);
            } else {
              setShowHex((v) => !v);
            }
          }}
          title={
            isLost && focusedPartition && !canRestoreMbr
              ? analysis.arch === 'EFI GPT'
                ? 'MBR partition restore is disabled on EFI GPT disks'
                : 'MBR partition export is available only for full in-memory disk images'
              : undefined
          }
          className="w-full py-2 px-4 rounded-md text-xs font-medium bg-[#2B303C] hover:bg-[#343B49] disabled:opacity-45 disabled:cursor-not-allowed text-slate-100 transition-colors"
        >
          {isLost && focusedPartition
            ? canRestoreMbr
              ? 'Restore Partition'
              : analysis.arch === 'EFI GPT'
                ? 'GPT Disk (Inspect & Recover Files)'
                : 'Streamed Drive (Recover Files Directly)'
            : showHex
              ? 'Hide Sector Hex'
              : 'Inspect Sector Hex'}
        </button>

        {focusedPartition?.detectedFs?.encrypted === 'BitLocker' && (
          <div className="p-3 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs space-y-2">
            <div className="font-semibold text-amber-100">BitLocker Volume (-FVE-FS-)</div>
            <p className="text-amber-200/90 leading-relaxed">
              This partition is encrypted with Windows BitLocker. Raw sector carving cannot decode
              encrypted clusters until the volume is unlocked.
            </p>
            {desktop && (
              <div className="space-y-1.5 pt-1 border-t border-amber-500/25">
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={blLetter}
                    onChange={(e) => setBlLetter(e.target.value)}
                    placeholder="D:"
                    className="w-12 px-2 py-1 rounded bg-[#14171D] border border-amber-500/30 text-slate-100 text-[11px] font-mono"
                    aria-label="BitLocker drive letter"
                  />
                  <select
                    value={blSecretType}
                    onChange={(e) => setBlSecretType(e.target.value as 'key' | 'password')}
                    className="flex-1 px-2 py-1 rounded bg-[#14171D] border border-amber-500/30 text-slate-100 text-[11px]"
                  >
                    <option value="key">48-Digit Recovery Key</option>
                    <option value="password">Password</option>
                  </select>
                </div>
                <input
                  type="password"
                  value={blSecret}
                  onChange={(e) => setBlSecret(e.target.value)}
                  placeholder={blSecretType === 'key' ? 'XXXXXX-XXXXXX-...' : 'BitLocker password'}
                  className="w-full px-2 py-1 rounded bg-[#14171D] border border-amber-500/30 text-slate-100 text-[11px] font-mono"
                />
                <button
                  type="button"
                  disabled={blBusy || !blSecret.trim()}
                  onClick={async () => {
                    setBlBusy(true);
                    setBlNotice(null);
                    try {
                      const res = await desktop.unlockBitLocker({
                        driveLetter: blLetter,
                        recoveryKey: blSecretType === 'key' ? blSecret.trim() : undefined,
                        password: blSecretType === 'password' ? blSecret.trim() : undefined,
                      });
                      setBlNotice(res.ok ? res.message || 'Unlocked successfully.' : res.error || 'Unlock failed.');
                      if (res.ok && onBitLockerUnlocked) onBitLockerUnlocked();
                    } finally {
                      setBlBusy(false);
                    }
                  }}
                  className="w-full py-1 px-2.5 rounded bg-amber-500/25 hover:bg-amber-500/35 text-amber-100 font-medium text-[11px] disabled:opacity-40"
                >
                  {blBusy ? 'Unlocking...' : 'Unlock BitLocker Volume'}
                </button>
                {blNotice && <div className="text-[11px] text-amber-100">{blNotice}</div>}
              </div>
            )}
          </div>
        )}

        <div className="space-y-3 text-xs pt-1">
          <div>
            <div className="text-slate-400 text-[11px]">Name</div>
            <div className="text-slate-100 mt-0.5 font-medium truncate">
              {focusedPartition ? focusedPartition.name : analysis.diskName}
            </div>
          </div>

          <div>
            <div className="text-slate-400 text-[11px]">Size</div>
            <div className="text-slate-200 mt-0.5 font-mono tabular-nums">
              {formatBytes(focusedPartition ? focusedPartition.sizeBytes : analysis.diskSizeBytes)}
            </div>
          </div>

          <div>
            <div className="text-slate-400 text-[11px]">Type</div>
            <div className="text-slate-200 mt-0.5">
              {focusedPartition
                ? `${focusedPartition.detectedFs?.filesystem ?? focusedPartition.typeName} Volume`
                : `${analysis.arch} Disk`}
            </div>
          </div>

          <div>
            <div className="text-slate-400 text-[11px]">Path</div>
            <div className="text-slate-200 mt-0.5 font-mono tabular-nums">
              {focusedPartition
                ? `LBA ${focusedPartition.startLba} – ${focusedPartition.endLba}`
                : `${analysis.totalSectors.toLocaleString()} × ${analysis.sectorSize} B`}
            </div>
          </div>
        </div>

        {showHex && sectorSlice.length > 0 && (
          <HexViewer
            bytes={sectorSlice}
            baseOffset={sectorOffset}
            maxBytes={256}
            title={inspectLba === 0 ? 'Sector 0 — MBR Table' : `Sector ${inspectLba}`}
            highlightStart={inspectLba === 0 ? 0x1be : undefined}
            highlightEnd={inspectLba === 0 ? 0x200 : undefined}
            currentLba={inspectLba}
            maxLba={Math.max(0, analysis.totalSectors - 1)}
            onStepSector={(delta) =>
              setSectorOverride({
                partitionKey,
                lba: Math.max(0, Math.min(analysis.totalSectors - 1, inspectLba + delta)),
              })
            }
          />
        )}
      </div>

      <button
        type="button"
        onClick={() => {
          if (isLost && focusedPartition && canRestoreMbr) {
            onRestorePartitionToMbr(focusedPartition);
          } else {
            setShowHex((v) => !v);
          }
        }}
        title="Partition and sector tools"
        aria-label="Partition tools"
        className="absolute bottom-4 right-4 w-9 h-9 rounded-full bg-[#2B303C] hover:bg-[#3A7AFE] border border-[#3B4252] text-[#60A5FA] hover:text-white shadow-lg flex items-center justify-center transition-colors"
      >
        <Wrench className="w-4 h-4" />
      </button>
    </aside>
  );
};
