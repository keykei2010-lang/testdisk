import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Download,
  Eye,
  FileText,
  HardDrive,
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
import { getDesktopBridge } from '../engine/desktopBridge';
import { formatShortDate } from '../engine/recoveryHealth';
import { HexViewer } from './HexViewer';

interface ExplorerInspectorProps {
  focusedFile: ExplorerFileItem | null;
  focusedPartition: PartitionEntry | null;
  analysis: DiskAnalysisResult;
  diskBytes: Uint8Array;
  onRestorePartitionToMbr: (partition: PartitionEntry) => void;
  onRepairFile: (item: ExplorerFileItem) => void;
  lightboxOpen: boolean;
  onSetLightboxOpen: (open: boolean) => void;
}

function likelihoodColors(tier: ExplorerFileItem['recoveryTier']) {
  if (tier === 'high') {
    return {
      text: 'text-emerald-400',
      bar: 'bg-emerald-500',
      badge: 'bg-emerald-500/15 border-emerald-500/35 text-emerald-300',
      dot: 'bg-emerald-400',
    };
  }
  if (tier === 'medium') {
    return {
      text: 'text-amber-400',
      bar: 'bg-amber-500',
      badge: 'bg-amber-500/15 border-amber-500/35 text-amber-300',
      dot: 'bg-amber-400',
    };
  }
  return {
    text: 'text-rose-400',
    bar: 'bg-rose-500',
    badge: 'bg-rose-500/15 border-rose-500/35 text-rose-300',
    dot: 'bg-rose-400',
  };
}

export const ExplorerInspector: React.FC<ExplorerInspectorProps> = ({
  focusedFile,
  focusedPartition,
  analysis,
  diskBytes,
  onRestorePartitionToMbr,
  onRepairFile,
  lightboxOpen,
  onSetLightboxOpen,
}) => {
  const partitionKey = focusedPartition?.id ?? 'disk-root';
  const [sectorOverride, setSectorOverride] = useState<{
    partitionKey: string;
    lba: number;
  } | null>(null);
  const inspectLba =
    sectorOverride && sectorOverride.partitionKey === partitionKey
      ? sectorOverride.lba
      : (focusedPartition?.startLba ?? 0);

  const [showHex, setShowHex] = useState<boolean>(true);

  // Scoped zoom & pan state keyed by file ID so switching files resets cleanly without useEffect setState
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

  const updateZoom = (patch: Partial<{ inlineZoom: number; modalZoom: number; panX: number; panY: number }>) => {
    setZoomState((prev) => {
      const base =
        prev.fileKey === fileKey
          ? prev
          : { fileKey, inlineZoom: 1, modalZoom: 1, panX: 0, panY: 0 };
      return { ...base, ...patch, fileKey };
    });
  };

  const clampZoom = (val: number) => Math.min(5, Math.max(0.5, Math.round(val * 100) / 100));

  const previewUrl = useMemo(() => {
    if (!focusedFile) return null;
    if (focusedFile.sourceRef?.browserFile) {
      return URL.createObjectURL(focusedFile.sourceRef.browserFile);
    }
    if (focusedFile.sourceRef?.kind === 'native-file' && focusedFile.sourceRef.devicePath) {
      const normalized = focusedFile.sourceRef.devicePath.replace(/\\/g, '/');
      return `file:///${normalized.replace(/^\/+/, '')}`;
    }
    const blob = new Blob([focusedFile.data.slice().buffer], { type: focusedFile.mimeType });
    return URL.createObjectURL(blob);
  }, [focusedFile]);

  useEffect(() => {
    return () => {
      if (previewUrl && previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

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
    const outName =
      item.sourceKind === 'fidentify' && item.extension !== 'unknown'
        ? `${item.filename.replace(/\.[^.]+$/, '')}.${item.extension}`
        : item.filename;

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
            filename: outName,
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
    a.download = outName;
    a.click();
    URL.revokeObjectURL(url);
  };

  // --- Mode A: Focused File Inspector ---
  if (focusedFile) {
    const isImage = focusedFile.family === 'Pictures';
    const isAudio = focusedFile.family === 'Audio';
    const isVideo = focusedFile.family === 'Videos';
    const isZoomableMedia = isImage || isVideo;
    const isTextLike =
      focusedFile.extension === 'pdf' ||
      focusedFile.extension === 'txt' ||
      focusedFile.extension === 'json' ||
      focusedFile.extension === 'xml' ||
      focusedFile.extension === 'svg';

    const lc = likelihoodColors(focusedFile.recoveryTier);

    return (
      <>
        <aside className="w-80 xl:w-96 shrink-0 bg-[#181E29] border-l border-[#2A3446] flex flex-col overflow-y-auto">
          <div key={focusedFile.id} className="p-4 space-y-4 animate-row-fade">
            {/* Inline Preview Card with Quick Windows-style Thumbnail Zoom */}
            <div className="bg-[#11151C] rounded-md border border-[#2A3446] overflow-hidden flex flex-col items-center justify-center min-h-[164px] p-3 relative group">
              {previewUrl && isImage ? (
                <div
                  className="w-full h-40 flex items-center justify-center overflow-hidden cursor-zoom-in"
                  onDoubleClick={() => onSetLightboxOpen(true)}
                  onWheel={(e) => {
                    e.preventDefault();
                    updateZoom({ inlineZoom: clampZoom(inlineZoom + (e.deltaY < 0 ? 0.25 : -0.25)) });
                  }}
                >
                  <img
                    src={previewUrl}
                    alt={focusedFile.filename}
                    referrerPolicy="no-referrer"
                    style={{ transform: `scale(${inlineZoom})` }}
                    className="max-h-36 object-contain rounded transition-transform duration-150 ease-out"
                  />
                </div>
              ) : previewUrl && isAudio ? (
                <div className="w-full space-y-2.5 py-2">
                  <div className="flex items-center justify-center gap-2 text-xs text-slate-300">
                    <Music className="w-4 h-4 text-rose-400" />
                    <span>Audio Stream Ready</span>
                  </div>
                  <audio controls src={previewUrl} className="w-full h-9" />
                </div>
              ) : previewUrl && isVideo ? (
                <div
                  className="w-full h-40 flex items-center justify-center overflow-hidden"
                  onDoubleClick={() => onSetLightboxOpen(true)}
                  onWheel={(e) => {
                    e.preventDefault();
                    updateZoom({ inlineZoom: clampZoom(inlineZoom + (e.deltaY < 0 ? 0.25 : -0.25)) });
                  }}
                >
                  <video
                    controls
                    src={previewUrl}
                    style={{ transform: `scale(${inlineZoom})` }}
                    className="max-h-36 w-full rounded transition-transform duration-150 ease-out"
                  />
                </div>
              ) : isTextLike ? (
                <div className="w-full space-y-1.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-sky-400 font-medium">
                    <FileText className="w-3.5 h-3.5" />
                    <span>Structure Extract</span>
                  </div>
                  <pre className="text-[11px] font-mono text-slate-300 max-h-28 overflow-hidden whitespace-pre-wrap break-all">
                    {new TextDecoder().decode(focusedFile.data.subarray(0, 320))}
                  </pre>
                </div>
              ) : (
                <div className="text-center space-y-1.5 py-4">
                  <div className="text-base font-mono font-bold uppercase text-[#38BDF8]">
                    .{focusedFile.extension}
                  </div>
                  <div className="text-xs text-slate-400">{focusedFile.description}</div>
                </div>
              )}

              {/* Quick inline zoom controls for images & videos */}
              {isZoomableMedia && (
                <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none">
                  <div className="flex items-center gap-1 bg-[#181E29]/95 border border-[#2A3446] rounded px-1.5 py-0.5 pointer-events-auto shadow-lg">
                    <button
                      type="button"
                      onClick={() => updateZoom({ inlineZoom: clampZoom(inlineZoom - 0.25) })}
                      className="p-0.5 text-slate-300 hover:text-white"
                      title="Zoom out thumbnail"
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
                      title="Zoom in thumbnail"
                      aria-label="Zoom in thumbnail"
                    >
                      <ZoomIn className="w-3 h-3" />
                    </button>
                    {inlineZoom !== 1 && (
                      <button
                        type="button"
                        onClick={() => updateZoom({ inlineZoom: 1 })}
                        className="p-0.5 text-slate-400 hover:text-white"
                        title="Reset zoom"
                        aria-label="Reset thumbnail zoom"
                      >
                        <RotateCcw className="w-2.5 h-2.5" />
                      </button>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => onSetLightboxOpen(true)}
                    className="p-1.5 rounded bg-[#181E29]/95 border border-[#2A3446] text-slate-200 hover:text-white pointer-events-auto shadow-lg"
                    title="Open Windows-style zoom viewer"
                    aria-label="Enlarge preview"
                  >
                    <Maximize2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  updateZoom({ modalZoom: 1, panX: 0, panY: 0 });
                  onSetLightboxOpen(true);
                }}
                className="inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-md text-xs font-medium bg-[#1F2735] border border-[#2A3446] text-slate-200 hover:bg-[#283244] active:scale-[0.98] transition-all whitespace-nowrap"
              >
                <Eye className="w-3.5 h-3.5" />
                {isZoomableMedia ? 'Preview & Zoom' : 'Preview'}
              </button>
              <button
                type="button"
                onClick={() => void handleDownloadFile(focusedFile)}
                className="inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-md text-xs font-medium bg-[#2E7CF6] text-white hover:bg-[#2569D6] active:scale-[0.98] transition-all whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                Save File
              </button>
            </div>

            {/* Recovery Likelihood Meter */}
            <div className="bg-[#11151C] rounded-md border border-[#2A3446] p-3 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400 font-medium">Recovery Likelihood</span>
                <span
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border text-[11px] font-mono font-semibold tabular-nums ${lc.badge}`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${lc.dot}`} />
                  {focusedFile.recoveryChance}% · {focusedFile.repaired ? 'Repaired' : lc.text.includes('emerald') ? 'Excellent' : lc.text.includes('amber') ? 'Fair' : 'Poor'}
                </span>
              </div>
              <div className="w-full h-1.5 rounded-full bg-[#1F2735] overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ease-out ${lc.bar}`}
                  style={{ width: `${focusedFile.recoveryChance}%` }}
                />
              </div>
              <div className="text-[11px] text-slate-400 leading-snug">
                {focusedFile.recoveryReason}
              </div>

              {focusedFile.status === 'OK_TRUNCATED' && !focusedFile.repaired && (
                <button
                  type="button"
                  onClick={() => onRepairFile(focusedFile)}
                  className="w-full mt-1 inline-flex items-center justify-center gap-1.5 py-1.5 px-3 rounded text-xs font-medium bg-amber-500/15 border border-amber-500/35 text-amber-200 hover:bg-amber-500/25 transition-colors"
                >
                  <Wrench className="w-3.5 h-3.5" />
                  Repair Truncated Structure
                </button>
              )}
            </div>

            {/* Metadata Breakdown */}
            <div className="space-y-2.5 text-xs pt-1">
              <div>
                <div className="text-slate-400">Name</div>
                <div className="font-mono text-slate-100 mt-0.5 break-all">
                  {focusedFile.filename}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-slate-400">Size</div>
                  <div className="font-mono text-slate-100 mt-0.5 tabular-nums">
                    {formatBytes(focusedFile.size)}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400">Date Modified</div>
                  <div className="font-mono text-slate-100 mt-0.5 tabular-nums">
                    {formatShortDate(focusedFile.modifiedAt)}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-slate-400">Type</div>
                  <div className="text-slate-100 mt-0.5 uppercase font-mono">
                    {focusedFile.extension} File
                  </div>
                </div>
                <div>
                  <div className="text-slate-400">Integrity</div>
                  <div className="mt-0.5 flex items-center gap-1">
                    {focusedFile.status === 'OK' || focusedFile.repaired ? (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        <span className="text-emerald-300">
                          {focusedFile.repaired ? 'Repaired' : 'Intact'}
                        </span>
                      </>
                    ) : (
                      <>
                        <ShieldAlert className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        <span className="text-amber-300">{focusedFile.status}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>

              <div>
                <div className="text-slate-400">Origin Path</div>
                <div
                  className="text-slate-200 mt-0.5 truncate"
                  title={focusedFile.originalPath || focusedFile.partitionName}
                >
                  {focusedFile.originalPath || focusedFile.partitionName}
                  {focusedFile.sourceKind === 'carved' &&
                    ` · Sector ${focusedFile.sector.toLocaleString()}`}
                </div>
              </div>

              {focusedFile.metadata.camera && (
                <div>
                  <div className="text-slate-400">Camera / EXIF</div>
                  <div className="text-slate-200 mt-0.5">{focusedFile.metadata.camera}</div>
                </div>
              )}

              {focusedFile.sourceRef?.runs && focusedFile.sourceRef.runs.length > 1 && (
                <div>
                  <div className="text-slate-400">Fragmented NTFS Extents</div>
                  <div className="text-emerald-300 font-mono mt-0.5">
                    {focusedFile.sourceRef.runs.length} cluster runs linked via $MFT
                  </div>
                </div>
              )}

              {focusedFile.metadata.details && (
                <div>
                  <div className="text-slate-400">Signature Details</div>
                  <div className="text-slate-200 mt-0.5">{focusedFile.metadata.details}</div>
                </div>
              )}
            </div>

            {/* Collapsible Hex Signature Inspector */}
            <div className="pt-2 border-t border-[#2A3446] space-y-2">
              <button
                type="button"
                onClick={() => setShowHex((v) => !v)}
                className="text-xs font-medium text-[#60A5FA] hover:underline"
              >
                {showHex ? 'Hide Header Hex' : 'Inspect Header Hex'}
              </button>
              {showHex && (
                <HexViewer
                  bytes={focusedFile.data}
                  baseOffset={focusedFile.offset}
                  maxBytes={128}
                  title="Magic Header Bytes"
                  highlightStart={focusedFile.matchedOffset}
                  highlightEnd={focusedFile.matchedOffset + focusedFile.matchedLength}
                />
              )}
            </div>
          </div>
        </aside>

        {/* Fullscreen Windows-style Preview & Zoom Lightbox */}
        {lightboxOpen && (
          <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 animate-backdrop-in">
            <div className="w-full max-w-4xl rounded-lg bg-[#181E29] border border-[#2A3446] overflow-hidden shadow-2xl animate-modal-in flex flex-col max-h-[90vh]">
              {/* Lightbox Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-[#2A3446] gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-xs font-mono text-slate-100 truncate">
                    {focusedFile.filename} · {formatBytes(focusedFile.size)}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-mono tabular-nums shrink-0 ${lc.badge}`}
                  >
                    {focusedFile.recoveryChance}% Recovery Likelihood
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

              {/* Windows Photos / Media Zoom Toolbar for Images & Videos */}
              {isZoomableMedia && (
                <div className="px-4 py-2 bg-[#141922] border-b border-[#2A3446] flex flex-wrap items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        updateZoom({ modalZoom: clampZoom(modalZoom - 0.25), panX: modalZoom - 0.25 <= 1 ? 0 : panX, panY: modalZoom - 0.25 <= 1 ? 0 : panY })
                      }
                      className="p-1.5 rounded bg-[#1F2735] border border-[#2A3446] text-slate-200 hover:bg-[#283244]"
                      title="Zoom out"
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
                      className="w-32 accent-[#2E7CF6] cursor-pointer"
                    />
                    <button
                      type="button"
                      onClick={() => updateZoom({ modalZoom: clampZoom(modalZoom + 0.25) })}
                      className="p-1.5 rounded bg-[#1F2735] border border-[#2A3446] text-slate-200 hover:bg-[#283244]"
                      title="Zoom in"
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
                            ? 'bg-[#2E7CF6] border-[#2E7CF6] text-white'
                            : 'bg-[#1F2735] border-[#2A3446] text-slate-300 hover:bg-[#283244]'
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                    <span className="text-[11px] text-slate-500 ml-2 hidden sm:inline">
                      Scroll wheel to zoom · Drag to pan · Double-click to toggle
                    </span>
                  </div>
                </div>
              )}

              {/* Interactive Viewport */}
              <div
                className={`p-6 bg-[#11151C] flex-1 flex flex-col items-center justify-center min-h-[340px] max-h-[65vh] overflow-hidden select-none ${
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
                {previewUrl && isImage ? (
                  <img
                    src={previewUrl}
                    alt={focusedFile.filename}
                    referrerPolicy="no-referrer"
                    draggable={false}
                    style={{
                      transform: `translate(${panX}px, ${panY}px) scale(${modalZoom})`,
                    }}
                    className={`max-h-[54vh] object-contain rounded ${
                      isDragging ? '' : 'transition-transform duration-150 ease-out'
                    }`}
                  />
                ) : previewUrl && isAudio ? (
                  <audio controls src={previewUrl} className="w-full max-w-md" />
                ) : previewUrl && isVideo ? (
                  <video
                    controls
                    src={previewUrl}
                    style={{
                      transform: `translate(${panX}px, ${panY}px) scale(${modalZoom})`,
                    }}
                    className={`max-h-[54vh] rounded ${
                      isDragging ? '' : 'transition-transform duration-150 ease-out'
                    }`}
                  />
                ) : isTextLike ? (
                  <pre className="w-full max-h-[54vh] overflow-auto text-xs font-mono text-slate-200 whitespace-pre-wrap break-all">
                    {new TextDecoder().decode(focusedFile.data.subarray(0, 8192))}
                  </pre>
                ) : (
                  <div className="w-full max-h-[54vh] overflow-auto">
                    <HexViewer
                      bytes={focusedFile.data}
                      baseOffset={focusedFile.offset}
                      maxBytes={512}
                      title="Binary Payload (First 512 B)"
                      highlightStart={focusedFile.matchedOffset}
                      highlightEnd={focusedFile.matchedOffset + focusedFile.matchedLength}
                    />
                  </div>
                )}
              </div>

              {/* Lightbox Footer */}
              <div className="px-4 py-3 border-t border-[#2A3446] bg-[#141922] flex items-center justify-between gap-2">
                <div className="text-xs text-slate-400">
                  {focusedFile.recoveryReason}
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
                    onClick={() => handleDownloadFile(focusedFile)}
                    className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium bg-[#2E7CF6] text-white rounded-md hover:bg-[#2569D6]"
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

  // --- Mode B: Partition / Disk Inspector ---
  const sectorOffset = inspectLba * analysis.sectorSize;
  const sectorSlice = diskBytes.subarray(sectorOffset, sectorOffset + analysis.sectorSize);
  const isLost = focusedPartition?.status === 'Deleted / Lost';

  return (
    <aside className="w-80 xl:w-96 shrink-0 bg-[#181E29] border-l border-[#2A3446] flex flex-col overflow-y-auto">
      <div className="p-4 space-y-4 animate-row-fade">
        <div className="bg-[#11151C] rounded-md border border-[#2A3446] p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-md bg-[#2E7CF6]/15 border border-[#2E7CF6]/30 flex items-center justify-center shrink-0">
            <HardDrive className="w-5 h-5 text-[#38BDF8]" />
          </div>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-slate-100 truncate">
              {focusedPartition ? focusedPartition.name : analysis.diskName}
            </div>
            <div className="text-[11px] text-slate-400 tabular-nums mt-0.5">
              {focusedPartition
                ? `${focusedPartition.detectedFs?.filesystem ?? focusedPartition.typeName} · ${formatBytes(focusedPartition.sizeBytes)}`
                : `${analysis.arch} · ${formatBytes(analysis.diskSizeBytes)}`}
            </div>
          </div>
        </div>

        {isLost && focusedPartition && (
          <button
            type="button"
            onClick={() => onRestorePartitionToMbr(focusedPartition)}
            className="w-full inline-flex items-center justify-center gap-1.5 py-2 px-3 rounded-md text-xs font-medium bg-[#2E7CF6] text-white hover:bg-[#2569D6] transition-colors"
          >
            <Wrench className="w-3.5 h-3.5" />
            Restore Lost Partition to MBR
          </button>
        )}

        <div className="space-y-2 text-xs">
          <div className="flex justify-between py-1 border-b border-[#2A3446]">
            <span className="text-slate-400">Scheme / Signature</span>
            <span className="font-mono text-slate-200">
              {analysis.arch} ({analysis.mbrSignatureValid ? '0x55AA' : 'No sig'})
            </span>
          </div>
          {focusedPartition ? (
            <>
              <div className="flex justify-between py-1 border-b border-[#2A3446]">
                <span className="text-slate-400">LBA Range</span>
                <span className="font-mono text-slate-200 tabular-nums">
                  {focusedPartition.startLba} – {focusedPartition.endLba}
                </span>
              </div>
              {focusedPartition.detectedFs && (
                <div className="flex justify-between py-1 border-b border-[#2A3446]">
                  <span className="text-slate-400">Boot / Superblock</span>
                  <span className="text-slate-200 text-right">
                    {focusedPartition.detectedFs.details}
                  </span>
                </div>
              )}
            </>
          ) : (
            <div className="flex justify-between py-1 border-b border-[#2A3446]">
              <span className="text-slate-400">Total Sectors</span>
              <span className="font-mono text-slate-200 tabular-nums">
                {analysis.totalSectors.toLocaleString()} × {analysis.sectorSize} B
              </span>
            </div>
          )}
        </div>

        <HexViewer
          bytes={sectorSlice}
          baseOffset={sectorOffset}
          maxBytes={512}
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
      </div>
    </aside>
  );
};
