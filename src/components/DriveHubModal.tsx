import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  FlaskConical,
  FolderOpen,
  FolderSearch,
  HardDrive,
  Play,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Usb,
  X,
} from 'lucide-react';
import { DiskAnalysisResult, PartitionEntry } from '../engine/partitions';
import { formatBytes } from '../engine/crc32';
import { getDesktopBridge, WindowsDriveInfo } from '../engine/desktopBridge';
import { EngineCapabilities } from '../engine/explorerTypes';
import { RecoverySelfTestResult, runRecoverySelfTest } from '../engine/recoveryHealth';

interface DriveHubModalProps {
  analysis: DiskAnalysisResult;
  activePartitionScope: string | null;
  capabilities?: EngineCapabilities | null;
  onRelaunchAsAdmin?: () => Promise<void>;
  onStartTargetedScan: (partition: PartitionEntry | null) => void;
  onOpenPhysicalDrive: (drive: WindowsDriveInfo) => Promise<void>;
  onScanFolder: () => void;
  onScanRecycleBin: () => Promise<void>;
  onOpenDiskPicker: () => void;
  onClose: () => void;
}

export const DriveHubModal: React.FC<DriveHubModalProps> = ({
  analysis,
  activePartitionScope,
  capabilities,
  onRelaunchAsAdmin,
  onStartTargetedScan,
  onOpenPhysicalDrive,
  onScanFolder,
  onScanRecycleBin,
  onOpenDiskPicker,
  onClose,
}) => {
  const desktop = getDesktopBridge();
  const [winDrives, setWinDrives] = useState<WindowsDriveInfo[]>([]);
  const [loadingDrives, setLoadingDrives] = useState<boolean>(false);
  const [openingDrive, setOpeningDrive] = useState<string | null>(null);
  const [scanningBin, setScanningBin] = useState<boolean>(false);
  const [selfTestBusy, setSelfTestBusy] = useState<boolean>(false);
  const [selfTestResult, setSelfTestResult] = useState<RecoverySelfTestResult | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    desktop
      .listWindowsDrives()
      .then((list) => {
        if (active) setWinDrives(list);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [desktop]);

  const refreshDrives = async () => {
    if (!desktop) return;
    setLoadingDrives(true);
    try {
      const list = await desktop.listWindowsDrives();
      setWinDrives(list);
    } finally {
      setLoadingDrives(false);
    }
  };

  const totalSectors = Math.max(1, analysis.totalSectors);

  return (
    <div className="fixed inset-0 z-50 bg-black/65 flex items-center justify-center p-4 animate-backdrop-in">
      <div className="w-full max-w-2xl max-h-[86vh] flex flex-col rounded-lg bg-[#222630] border border-[#343A48] shadow-2xl overflow-hidden animate-modal-in">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#2A3446]">
          <div className="flex items-center gap-2">
            <HardDrive className="w-4 h-4 text-[#38BDF8]" />
            <h3 className="text-sm font-semibold text-slate-100">
              Select Location, Folder, or Drive to Scan
            </h3>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={selfTestBusy}
              onClick={async () => {
                setSelfTestBusy(true);
                try {
                  setSelfTestResult(await runRecoverySelfTest());
                } finally {
                  setSelfTestBusy(false);
                }
              }}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#181B22] hover:bg-[#2A3140] border border-[#343A48] text-xs text-slate-200 disabled:opacity-50"
            >
              <FlaskConical className="w-3.5 h-3.5 text-[#4C8DFF]" />
              {selfTestBusy ? 'Testing...' : 'Run Engine Self-Test'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-slate-100 p-1 rounded"
              aria-label="Close drive overview"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="p-5 space-y-5 text-xs overflow-y-auto">
          {selfTestResult && (
            <div
              className={`p-3 rounded-md border space-y-1.5 ${
                selfTestResult.passed
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
                  : 'bg-rose-500/10 border-rose-500/30 text-rose-200'
              }`}
            >
              <div className="flex items-center gap-1.5 font-medium">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                <span>
                  {selfTestResult.checks.filter((c) => c.passed).length}/{selfTestResult.checks.length}{' '}
                  checks passed ({selfTestResult.durationMs}ms) · SHA-256{' '}
                  {selfTestResult.sha256Hex.slice(0, 12)}...
                </span>
              </div>
            </div>
          )}
          {/* Common Windows Locations (matching EaseUS Specify a Location) */}
          <div className="space-y-2">
            <div className="font-semibold text-slate-200">Common Locations</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                disabled={scanningBin}
                onClick={async () => {
                  setScanningBin(true);
                  try {
                    await onScanRecycleBin();
                    onClose();
                  } finally {
                    setScanningBin(false);
                  }
                }}
                className="flex items-center gap-3 p-3.5 rounded-md bg-[#181B22] border border-[#2D3342] hover:border-[#2E7CF6] hover:bg-[#1A212E] text-left transition-colors"
              >
                <div className="w-9 h-9 rounded-md bg-amber-500/15 border border-amber-500/35 flex items-center justify-center shrink-0">
                  <Trash2 className="w-4 h-4 text-amber-400" />
                </div>
                <div className="min-w-0">
                  <div className="font-semibold text-slate-100">
                    {scanningBin ? 'Scanning $Recycle.Bin...' : 'Recycle Bin ($Recycle.Bin)'}
                  </div>
                  <div className="text-slate-400 mt-0.5 truncate">
                    {desktop
                      ? 'Scan all Windows drives for $I/$R deleted files'
                      : 'Select a $Recycle.Bin folder to inspect'}
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => {
                  onClose();
                  onScanFolder();
                }}
                className="flex items-center gap-3 p-3.5 rounded-md bg-[#181B22] border border-[#2D3342] hover:border-[#2E7CF6] hover:bg-[#1A212E] text-left transition-colors"
              >
                <div className="w-9 h-9 rounded-md bg-[#2E7CF6]/15 border border-[#2E7CF6]/35 flex items-center justify-center shrink-0">
                  <FolderSearch className="w-4 h-4 text-[#38BDF8]" />
                </div>
                <div className="min-w-0">
                  <div className="font-semibold text-slate-100">Select Folder</div>
                  <div className="text-slate-400 mt-0.5 truncate">
                    Scan any folder for .jpeg, .mp4, or damaged files
                  </div>
                </div>
              </button>
            </div>
          </div>

          {/* Windows Physical Drives Section (Active inside Windows Desktop .exe) */}
          {desktop && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-slate-200">
                  Windows Physical Drives (Streaming Sector Scan)
                </span>
                <div className="flex items-center gap-3">
                  {capabilities && !capabilities.isAdmin && onRelaunchAsAdmin && (
                    <button
                      type="button"
                      onClick={() => void onRelaunchAsAdmin()}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/35 text-amber-200 hover:bg-amber-500/25"
                    >
                      <ShieldAlert className="w-3 h-3" />
                      Relaunch as Admin
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void refreshDrives()}
                    className="inline-flex items-center gap-1 text-[#60A5FA] hover:underline"
                  >
                    <RefreshCw className={`w-3 h-3 ${loadingDrives ? 'animate-spin' : ''}`} />
                    Refresh Drives
                  </button>
                </div>
              </div>
              {winDrives.length === 0 ? (
                <div className="p-3 rounded-md bg-[#181B22] border border-[#2D3342] text-slate-400">
                  Querying Windows physical drives... Ensure app is running as Administrator.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {winDrives.map((drv) => (
                    <div
                      key={drv.devicePath}
                      className="flex items-center justify-between p-3 rounded-md bg-[#181B22] border border-[#2D3342] hover:border-[#3B4963]"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {drv.busType === 'USB' ? (
                          <Usb className="w-4 h-4 text-amber-400 shrink-0" />
                        ) : (
                          <HardDrive className="w-4 h-4 text-[#38BDF8] shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-100 truncate">
                            {drv.name}{' '}
                            {drv.letters.length > 0 && (
                              <span className="text-[#60A5FA] font-mono">
                                ({drv.letters.join(', ')})
                              </span>
                            )}
                          </div>
                          <div className="text-slate-400 font-mono tabular-nums mt-0.5">
                            {drv.devicePath} · {drv.busType} · {drv.partitionStyle} ·{' '}
                            {formatBytes(drv.sizeBytes)}
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={openingDrive !== null}
                        onClick={async () => {
                          setOpeningDrive(drv.devicePath);
                          try {
                            await onOpenPhysicalDrive(drv);
                            onClose();
                          } finally {
                            setOpeningDrive(null);
                          }
                        }}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-[#3A7AFE] hover:bg-[#2F6EEB] disabled:opacity-40 text-white font-medium shrink-0"
                      >
                        <Play className="w-3 h-3" />
                        {openingDrive === drv.devicePath ? 'Scanning...' : 'Scan Drive'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Disk Summary Header */}
          <div className="bg-[#181B22] border border-[#2D3342] rounded-md p-4 flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="text-sm font-semibold text-slate-100">
                {analysis.diskSizeBytes > 0 ? analysis.diskName : 'No Raw Disk Image Loaded'}
              </div>
              <div className="text-slate-400 font-mono tabular-nums">
                {analysis.diskSizeBytes > 0
                  ? `${analysis.arch} · ${formatBytes(analysis.diskSizeBytes)} · ${analysis.totalSectors.toLocaleString()} sectors (${analysis.sectorSize} B/sector)`
                  : 'Open a .img, .dd, .raw, or .iso file to inspect its partition map'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenDiskPicker();
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#1F2735] border border-[#2A3446] text-slate-200 hover:bg-[#283244]"
            >
              <FolderOpen className="w-3.5 h-3.5 text-[#38BDF8]" />
              Load Disk Image (.img / .dd)
            </button>
          </div>

          {analysis.diskSizeBytes > 0 && (
            <>
              {/* Visual Partition Map Bar */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-slate-300 font-medium">
                  <span>Loaded Image Partition Map</span>
                  <span className="text-slate-400 font-mono tabular-nums">
                    MBR Sig: {analysis.mbrSignatureValid ? '0x55AA Valid' : 'Missing'}
                  </span>
                </div>
                <div className="h-7 rounded-md bg-[#181B22] border border-[#2D3342] overflow-hidden flex p-0.5 gap-0.5">
                  {analysis.partitions.map((part) => {
                    const widthPct = Math.max(8, (part.sectors / totalSectors) * 100);
                    const isLost = part.status === 'Deleted / Lost';
                    return (
                      <button
                        key={part.id}
                        type="button"
                        onClick={() => {
                          onStartTargetedScan(part);
                          onClose();
                        }}
                        style={{ width: `${widthPct}%` }}
                        className={`h-full rounded-xs px-2 text-[11px] font-mono truncate flex items-center justify-center transition-opacity hover:opacity-90 ${
                          isLost
                            ? 'bg-amber-500/25 border border-amber-500/50 text-amber-200'
                            : 'bg-[#2E7CF6]/25 border border-[#2E7CF6]/45 text-sky-200'
                        }`}
                        title={`Click to scan ${part.name} (LBA ${part.startLba}–${part.endLba})`}
                      >
                        {part.detectedFs?.filesystem ?? part.typeName}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Target Selection List */}
              <div className="space-y-2">
                <div
                  onClick={() => {
                    onStartTargetedScan(null);
                    onClose();
                  }}
                  className={`flex items-center justify-between p-3 rounded-md border cursor-pointer transition-colors ${
                    activePartitionScope === null
                      ? 'bg-[#283244] border-[#2E7CF6]'
                      : 'bg-[#1F2735] border-[#2A3446] hover:bg-[#242D3D]'
                  }`}
                >
                  <div>
                    <div className="font-semibold text-slate-100">
                      Full Loaded Image Scan (All Partitions + Unallocated Space)
                    </div>
                    <div className="text-slate-400 font-mono tabular-nums mt-0.5">
                      LBA 0 – {analysis.totalSectors - 1} · {formatBytes(analysis.diskSizeBytes)}
                    </div>
                  </div>
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#2E7CF6] text-white font-medium">
                    <Play className="w-3 h-3" /> Scan All
                  </span>
                </div>

                {analysis.partitions.map((part) => {
                  const isLost = part.status === 'Deleted / Lost';
                  const isSelected = activePartitionScope === part.id;
                  return (
                    <div
                      key={part.id}
                      onClick={() => {
                        onStartTargetedScan(part);
                        onClose();
                      }}
                      className={`flex items-center justify-between p-3 rounded-md border cursor-pointer transition-colors ${
                        isSelected
                          ? 'bg-[#283244] border-[#2E7CF6]'
                          : 'bg-[#1F2735] border-[#2A3446] hover:bg-[#242D3D]'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          {isLost && <ShieldAlert className="w-3.5 h-3.5 text-amber-400 shrink-0" />}
                          <span className="font-semibold text-slate-100 truncate">
                            {isLost
                              ? `Lost Partition (${part.detectedFs?.filesystem ?? part.typeName})`
                              : `${part.detectedFs?.filesystem ?? part.typeName} · ${part.name}`}
                          </span>
                        </div>
                        <div className="text-slate-400 font-mono tabular-nums mt-0.5">
                          LBA {part.startLba} – {part.endLba} · {formatBytes(part.sizeBytes)} ·{' '}
                          {part.detectedFs?.details ?? part.typeName}
                        </div>
                      </div>
                      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#141922] border border-[#2A3446] text-slate-200 hover:text-white shrink-0">
                        <Play className="w-3 h-3 text-[#38BDF8]" /> Scan Range
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
