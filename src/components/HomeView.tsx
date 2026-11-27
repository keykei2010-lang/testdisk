import React, { useEffect, useState } from 'react';
import {
  Check,
  CheckCircle2,
  CreditCard,
  Disc,
  FileQuestion,
  FlaskConical,
  Folder,
  FolderInput,
  HardDrive,
  Monitor,
  RefreshCw,
  Shield,
  ShieldAlert,
  Trash2,
  Usb,
  Wrench,
} from 'lucide-react';
import { formatBytes } from '../engine/crc32';
import { EngineCapabilities, ScanMode } from '../engine/explorerTypes';
import { RecoverySelfTestResult, runRecoverySelfTest } from '../engine/recoveryHealth';
import {
  getDesktopBridge,
  WindowsDriveInfo,
  WindowsVolumeInfo,
} from '../engine/desktopBridge';
import { MediaRepairLab } from './MediaRepairLab';

export type HomeNavSection = 'hardware' | 'sdcard' | 'repair' | 'partition';

interface HomeViewProps {
  scanMode: ScanMode;
  onChangeScanMode: (mode: ScanMode) => void;
  unallocatedOnly: boolean;
  onChangeUnallocatedOnly: (val: boolean) => void;
  capabilities: EngineCapabilities | null;
  onRelaunchAsAdmin: () => Promise<void>;
  onScanPhysicalDrive: (drive: WindowsDriveInfo) => Promise<void>;
  onOpenDiskPicker: () => void;
  onScanFolder: () => void;
  onScanRecycleBin: () => Promise<void>;
  onScanDesktop: () => Promise<void>;
  onOpenUnknownFiles: () => void;
  onOpenSessionPicker: () => void;
  hasExistingResults: boolean;
  onReturnToResults: () => void;
}

export const HomeView: React.FC<HomeViewProps> = ({
  scanMode,
  onChangeScanMode,
  unallocatedOnly,
  onChangeUnallocatedOnly,
  capabilities,
  onRelaunchAsAdmin,
  onScanPhysicalDrive,
  onOpenDiskPicker,
  onScanFolder,
  onScanRecycleBin,
  onScanDesktop,
  onOpenUnknownFiles,
  onOpenSessionPicker,
  hasExistingResults,
  onReturnToResults,
}) => {
  const desktop = getDesktopBridge();
  const [section, setSection] = useState<HomeNavSection>('hardware');
  const [drives, setDrives] = useState<WindowsDriveInfo[]>([]);
  const [volumes, setVolumes] = useState<WindowsVolumeInfo[]>([]);
  const [loadingDrives, setLoadingDrives] = useState<boolean>(false);
  const [selectedDevicePath, setSelectedDevicePath] = useState<string | null>(null);
  const [selectedQuickTarget, setSelectedQuickTarget] = useState<
    'recycle' | 'desktop' | 'folder' | 'image' | 'unknown' | null
  >(desktop ? null : 'image');
  const [scanningDrivePath, setScanningDrivePath] = useState<string | null>(null);
  const [elevating, setElevating] = useState<boolean>(false);
  const [selfTestBusy, setSelfTestBusy] = useState<boolean>(false);
  const [selfTestResult, setSelfTestResult] = useState<RecoverySelfTestResult | null>(null);

  const loadHardware = async () => {
    if (!desktop) return;
    setLoadingDrives(true);
    try {
      const [drvList, volList] = await Promise.all([
        desktop.listWindowsDrives(),
        desktop.listWindowsVolumes(),
      ]);
      setDrives(drvList);
      setVolumes(volList);
      setSelectedDevicePath((cur) => {
        if (cur && drvList.some((d) => d.devicePath === cur)) return cur;
        return selectedQuickTarget ? null : drvList[0]?.devicePath ?? null;
      });
    } finally {
      setLoadingDrives(false);
    }
  };

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    Promise.all([desktop.listWindowsDrives(), desktop.listWindowsVolumes()])
      .then(([drvList, volList]) => {
        if (!active) return;
        setDrives(drvList);
        setVolumes(volList);
        if (drvList.length > 0) {
          setSelectedDevicePath((cur) => cur ?? drvList[0].devicePath);
          setSelectedQuickTarget(null);
        } else {
          setSelectedQuickTarget((cur) => cur ?? 'recycle');
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [desktop]);

  const externalDrives = drives.filter((d) =>
    /^(USB|SD|MMC|1394|iSCSI)$/i.test(d.busType),
  );
  const internalDrives = drives.filter(
    (d) => !/^(USB|SD|MMC|1394|iSCSI)$/i.test(d.busType),
  );

  const selectSection = (nextSection: HomeNavSection) => {
    setSection(nextSection);
    if (nextSection === 'sdcard') {
      if (selectedDevicePath && !externalDrives.some((d) => d.devicePath === selectedDevicePath)) {
        setSelectedDevicePath(externalDrives[0]?.devicePath ?? null);
      } else if (!selectedDevicePath && !selectedQuickTarget && externalDrives.length > 0) {
        setSelectedDevicePath(externalDrives[0].devicePath);
      }
    } else if (nextSection === 'hardware') {
      if (!selectedDevicePath && !selectedQuickTarget && drives.length > 0) {
        setSelectedDevicePath(drives[0].devicePath);
      }
    }
  };

  const selectedDrive = drives.find((d) => d.devicePath === selectedDevicePath) ?? null;

  const getVolumeUsage = (drv: WindowsDriveInfo) => {
    const matchedVols = volumes.filter((v) => drv.letters.includes(v.driveLetter));
    if (matchedVols.length === 0) {
      return {
        label: drv.letters.length > 0 ? `${drv.name} (${drv.letters.join(', ')})` : drv.name,
        ratioText: formatBytes(drv.sizeBytes),
        usedPct: 0,
      };
    }
    const primary = matchedVols[0];
    const total = matchedVols.reduce((s, v) => s + v.totalBytes, 0);
    const free = matchedVols.reduce((s, v) => s + v.freeBytes, 0);
    const used = Math.max(0, total - free);
    const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
    const displayName =
      primary.label && primary.label !== 'Local Disk'
        ? `${primary.label} (${drv.letters.join(', ')})`
        : `${drv.name} (${drv.letters.join(', ')})`;
    return {
      label: displayName,
      ratioText: `${formatBytes(used)} / ${formatBytes(total)}`,
      usedPct: pct,
    };
  };

  const triggerSearch = async () => {
    if (section === 'repair') {
      onOpenUnknownFiles();
      return;
    }
    if (selectedDrive) {
      setScanningDrivePath(selectedDrive.devicePath);
      try {
        await onScanPhysicalDrive(selectedDrive);
      } finally {
        setScanningDrivePath(null);
      }
      return;
    }
    if (section === 'partition') {
      onOpenDiskPicker();
      return;
    }
    switch (selectedQuickTarget) {
      case 'recycle':
        await onScanRecycleBin();
        break;
      case 'desktop':
        await onScanDesktop();
        break;
      case 'folder':
        onScanFolder();
        break;
      case 'unknown':
        onOpenUnknownFiles();
        break;
      case 'image':
      default:
        onOpenDiskPicker();
        break;
    }
  };

  const handleSelfTest = async () => {
    setSelfTestBusy(true);
    try {
      const res = await runRecoverySelfTest();
      setSelfTestResult(res);
    } finally {
      setSelfTestBusy(false);
    }
  };

  const renderDriveCard = (drv: WindowsDriveInfo, isExternal: boolean) => {
    const isSel = selectedDevicePath === drv.devicePath;
    const usage = getVolumeUsage(drv);
    return (
      <button
        key={drv.devicePath}
        type="button"
        onClick={() => {
          setSelectedDevicePath(drv.devicePath);
          setSelectedQuickTarget(null);
        }}
        className={`relative text-left p-3.5 rounded-md border transition-all flex items-center gap-3.5 ${
          isSel
            ? 'bg-[#222938] border-[#3A7AFE]'
            : 'bg-[#191C23] border-[#2B303C] hover:border-[#3D4659] hover:bg-[#1E222B]'
        }`}
      >
        {isSel && (
          <span className="absolute top-2 right-2 w-4 h-4 rounded-full bg-[#3A7AFE] flex items-center justify-center">
            <Check className="w-2.5 h-2.5 text-white stroke-[3]" />
          </span>
        )}
        <div className="w-11 h-11 rounded-md bg-[#242A38] border border-[#323A4D] flex items-center justify-center shrink-0">
          {isExternal ? (
            <Usb className="w-5 h-5 text-[#4C8DFF]" />
          ) : (
            <HardDrive className="w-5 h-5 text-[#4C8DFF]" />
          )}
        </div>
        <div className="min-w-0 flex-1 pr-4">
          <div className="text-xs font-medium text-slate-100 truncate">{usage.label}</div>
          <div className="w-full h-1 rounded-full bg-[#2B3140] overflow-hidden mt-2">
            <div
              className="h-full bg-[#3A7AFE] rounded-full"
              style={{ width: `${Math.max(4, usage.usedPct)}%` }}
            />
          </div>
          <div className="text-[11px] font-mono text-slate-400 tabular-nums mt-1.5">
            {usage.ratioText}
          </div>
        </div>
      </button>
    );
  };

  const navItems: {
    id: HomeNavSection;
    group: 'data' | 'advanced';
    label: string;
    icon: React.ReactNode;
  }[] = [
    {
      id: 'hardware',
      group: 'data',
      label: 'Hardware Disk',
      icon: <HardDrive className="w-4 h-4 shrink-0" />,
    },
    {
      id: 'sdcard',
      group: 'data',
      label: 'SD Card',
      icon: <CreditCard className="w-4 h-4 shrink-0" />,
    },
    {
      id: 'repair',
      group: 'advanced',
      label: 'File Repair',
      icon: <Wrench className="w-4 h-4 shrink-0" />,
    },
    {
      id: 'partition',
      group: 'advanced',
      label: 'Lost Partition Rescue',
      icon: <ShieldAlert className="w-4 h-4 shrink-0" />,
    },
  ];

  return (
    <div className="flex-1 min-h-0 flex">
      {/* Left Navigation Sidebar matching Screenshot 4 */}
      <aside className="w-56 shrink-0 bg-[#16181F] border-r border-[#252932] py-5 px-3 flex flex-col justify-between select-none">
        <div className="space-y-6">
          <div>
            <div className="px-3 mb-2 text-[11px] font-medium text-slate-400">
              Data Recovery
            </div>
            <div className="space-y-1">
              {navItems
                .filter((i) => i.group === 'data')
                .map((item) => {
                  const active = section === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => selectSection(item.id)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-xs transition-colors ${
                        active
                          ? 'bg-[#262B36] text-white font-medium'
                          : 'text-slate-300 hover:bg-[#1E222B] hover:text-white'
                      }`}
                    >
                      <span className={active ? 'text-[#4C8DFF]' : 'text-slate-400'}>
                        {item.icon}
                      </span>
                      <span>{item.label}</span>
                    </button>
                  );
                })}
            </div>
          </div>

          <div>
            <div className="px-3 mb-2 text-[11px] font-medium text-slate-400">
              Advanced Features
            </div>
            <div className="space-y-1">
              {navItems
                .filter((i) => i.group === 'advanced')
                .map((item) => {
                  const active = section === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => selectSection(item.id)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-xs transition-colors ${
                        active
                          ? 'bg-[#262B36] text-white font-medium'
                          : 'text-slate-300 hover:bg-[#1E222B] hover:text-white'
                      }`}
                    >
                      <span className={active ? 'text-[#4C8DFF]' : 'text-slate-400'}>
                        {item.icon}
                      </span>
                      <span>{item.label}</span>
                    </button>
                  );
                })}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <button
            type="button"
            disabled={selfTestBusy}
            onClick={() => void handleSelfTest()}
            className="w-full inline-flex items-center gap-2 px-3 py-2 rounded-md text-xs text-slate-300 bg-[#1B2029] hover:bg-[#232935] border border-[#2D3342] text-left transition-colors disabled:opacity-50"
            title="Verify MBR, NTFS $MFT, FAT32 LFN, CRC-32 carving & MP4 moov synthesis with a synthetic SHA-256 disk image"
          >
            <FlaskConical className="w-3.5 h-3.5 text-[#4C8DFF] shrink-0" />
            <span>{selfTestBusy ? 'Running Self-Test...' : 'Run Engine Self-Test'}</span>
          </button>

          {hasExistingResults && (
            <button
              type="button"
              onClick={onReturnToResults}
              className="w-full px-3 py-2 rounded-md text-xs text-slate-300 bg-[#1E222B] hover:bg-[#262B36] border border-[#2D3342] text-left transition-colors"
            >
              Return to Current Scan
            </button>
          )}
        </div>
      </aside>

      {/* Main Content Area matching Screenshot 4 */}
      <main className="flex-1 min-w-0 bg-[#1E2129] flex flex-col">
        <div className="flex-1 overflow-y-auto px-8 py-6 space-y-6">
          {(section === 'hardware' || section === 'sdcard') && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <h1 className="text-[17px] font-semibold text-slate-100 tracking-tight">
                    {section === 'sdcard'
                      ? 'Select an SD card or removable drive to scan'
                      : 'Select a location to search for lost data'}
                  </h1>
                  {desktop && (
                    <button
                      type="button"
                      onClick={() => void loadHardware()}
                      className="p-1.5 rounded text-slate-400 hover:text-slate-100 hover:bg-[#262B36] transition-colors"
                      title="Refresh connected drives"
                      aria-label="Refresh connected drives"
                    >
                      <RefreshCw
                        className={`w-4 h-4 ${loadingDrives ? 'animate-spin' : ''}`}
                      />
                    </button>
                  )}
                </div>

                {desktop && capabilities && (
                  <div className="flex items-center gap-2 text-[11px]">
                    {capabilities.isAdmin ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300">
                        <Shield className="w-3 h-3" />
                        Administrator Mode
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={elevating}
                        onClick={async () => {
                          setElevating(true);
                          try {
                            await onRelaunchAsAdmin();
                          } finally {
                            setElevating(false);
                          }
                        }}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/35 text-amber-200 font-medium transition-colors disabled:opacity-50"
                      >
                        <ShieldAlert className="w-3 h-3" />
                        {elevating ? 'Requesting UAC...' : 'Relaunch as Administrator'}
                      </button>
                    )}
                    <span className="hidden xl:inline text-slate-400 font-mono">
                      {[
                        capabilities.sleuthkit && 'Sleuth Kit',
                        capabilities.fidentify && 'fidentify',
                        capabilities.ffmpeg && 'FFmpeg',
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'Built-in Recovery Engine'}
                    </span>
                  </div>
                )}
              </div>

              {(section === 'hardware' || section === 'sdcard') && (
                <div className="px-3.5 py-2 rounded-md bg-[#181B22] border border-[#2B303C] text-[11px] text-slate-400 leading-relaxed">
                  <strong className="text-slate-200 font-medium">SSD / NVMe TRIM &amp; Safety Advisory:</strong>{' '}
                  Modern SSDs discard deleted blocks shortly after file deletion (TRIM). Stop writing to
                  the target drive immediately and always save recovered files to a separate physical drive.
                </div>
              )}

              {selfTestResult && (
                <div
                  className={`p-3.5 rounded-md border text-xs space-y-2 ${
                    selfTestResult.passed
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
                      : 'bg-rose-500/10 border-rose-500/30 text-rose-200'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 font-medium">
                      <CheckCircle2 className="w-4 h-4 shrink-0" />
                      <span>
                        Engine Self-Test:{' '}
                        {selfTestResult.checks.filter((c) => c.passed).length}/
                        {selfTestResult.checks.length} checks passed in {selfTestResult.durationMs}ms
                        {selfTestResult.sha256Hex
                          ? ` · SHA-256 ${selfTestResult.sha256Hex.slice(0, 12)}...`
                          : ''}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelfTestResult(null)}
                      className="text-[11px] opacity-80 hover:opacity-100 underline"
                    >
                      Dismiss
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-[11px]">
                    {selfTestResult.checks.map((chk) => (
                      <div key={chk.name} className="truncate">
                        <span className="font-semibold">{chk.passed ? '[PASS]' : '[FAIL]'}</span>{' '}
                        {chk.name} — <span className="opacity-85">{chk.detail}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {desktop ? (
                <div className="space-y-5">
                  {section === 'hardware' ? (
                    <>
                      <div className="space-y-2.5">
                        <div className="text-xs font-medium text-slate-400">
                          External drives ({externalDrives.length})
                        </div>
                        {externalDrives.length > 0 ? (
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                            {externalDrives.map((drv) => renderDriveCard(drv, true))}
                          </div>
                        ) : (
                          <div className="text-xs text-slate-500">
                            No external USB or removable drives detected.
                          </div>
                        )}
                      </div>

                      <div className="space-y-2.5">
                        <div className="text-xs font-medium text-slate-400">
                          Internal drives ({internalDrives.length})
                        </div>
                        {internalDrives.length > 0 ? (
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                            {internalDrives.map((drv) => renderDriveCard(drv, false))}
                          </div>
                        ) : (
                          <div className="text-xs text-slate-500">
                            {loadingDrives
                              ? 'Reading Windows disk layout...'
                              : 'Run as Administrator to list physical internal drives.'}
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="space-y-2.5">
                      <div className="text-xs font-medium text-slate-400">
                        Removable &amp; SD Card drives ({externalDrives.length})
                      </div>
                      {externalDrives.length > 0 ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                          {externalDrives.map((drv) => renderDriveCard(drv, true))}
                        </div>
                      ) : (
                        <div className="p-4 rounded-md bg-[#181B22] border border-[#2B303C] text-xs text-slate-400">
                          No SD card or USB reader detected. Insert media and click Refresh, or
                          choose a folder or raw card image below.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-4 rounded-md bg-[#181B22] border border-[#2B303C] text-xs text-slate-400">
                  Direct physical drive scanning requires the Windows desktop app (.exe). Choose
                  a location or raw disk image (.img / .dd / .raw / .iso) below to begin.
                </div>
              )}

              {/* Specify a location (click to select, then click Search for Lost Data) */}
              <div className="space-y-3 pt-1">
                <div className="text-xs font-medium text-slate-400">Specify a location</div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3.5 max-w-3xl">
                  {(
                    [
                      {
                        id: 'recycle',
                        label: 'Recycle Bin',
                        icon: <Trash2 className="w-5 h-5 text-slate-300" />,
                      },
                      {
                        id: 'desktop',
                        label: 'Desktop',
                        icon: <Monitor className="w-5 h-5 text-[#4C8DFF]" />,
                      },
                      {
                        id: 'folder',
                        label: 'Select Folder',
                        icon: <Folder className="w-5 h-5 text-[#4C8DFF] fill-[#4C8DFF]/25" />,
                      },
                      {
                        id: 'image',
                        label: 'Disk Image',
                        icon: <Disc className="w-5 h-5 text-[#60A5FA]" />,
                      },
                      {
                        id: 'unknown',
                        label: 'Unknown File (fidentify)',
                        icon: <FileQuestion className="w-5 h-5 text-emerald-400" />,
                      },
                    ] as const
                  ).map((tile) => {
                    const isTileSel = !selectedDevicePath && selectedQuickTarget === tile.id;
                    return (
                      <button
                        key={tile.id}
                        type="button"
                        onClick={() => {
                          setSelectedDevicePath(null);
                          setSelectedQuickTarget(tile.id);
                        }}
                        className={`relative flex items-center gap-3.5 p-3.5 rounded-md border text-left transition-colors ${
                          isTileSel
                            ? 'bg-[#222938] border-[#3A7AFE]'
                            : 'bg-[#191C23] border-[#2B303C] hover:border-[#3D4659] hover:bg-[#252A36]'
                        }`}
                      >
                        {isTileSel && (
                          <span className="absolute top-2 right-2 w-4 h-4 rounded-full bg-[#3A7AFE] flex items-center justify-center">
                            <Check className="w-2.5 h-2.5 text-white stroke-[3]" />
                          </span>
                        )}
                        <div className="w-11 h-11 rounded-lg bg-[#252B37] border border-[#323A4C] flex items-center justify-center shrink-0">
                          {tile.icon}
                        </div>
                        <span className="text-xs font-medium text-slate-200 pr-4">{tile.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {section === 'repair' && (
            <MediaRepairLab onOpenUnknownFiles={onOpenUnknownFiles} />
          )}

          {section === 'partition' && (
            <div className="max-w-2xl space-y-5">
              <div className="space-y-1.5">
                <h1 className="text-[17px] font-semibold text-slate-100 tracking-tight">
                  Lost Partition Rescue
                </h1>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Analyze Intel/MBR and GPT partition tables, scan unallocated sectors for deleted
                  NTFS, FAT32, and exFAT boot sectors, and restore lost partitions cleanly.
                </p>
              </div>

              {desktop && drives.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {drives.map((drv) =>
                    renderDriveCard(drv, /^(USB|SD|MMC|1394|iSCSI)$/i.test(drv.busType)),
                  )}
                </div>
              )}

              <button
                type="button"
                onClick={onOpenDiskPicker}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-md bg-[#262B36] hover:bg-[#2E3543] border border-[#343A48] text-xs font-medium text-slate-100 transition-colors"
              >
                <Disc className="w-4 h-4 text-[#4C8DFF]" />
                Open Raw Disk Image (.img / .dd / .raw / .iso)
              </button>
            </div>
          )}
        </div>

        {/* Bottom Home Bar matching Screenshot 4 */}
        <footer className="h-16 shrink-0 px-8 border-t border-[#262A34] bg-[#1A1D24] flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={onOpenSessionPicker}
            className="inline-flex items-center gap-2 text-xs text-slate-300 hover:text-white transition-colors"
          >
            <FolderInput className="w-3.5 h-3.5 text-slate-400" />
            Load Saved Session (.tdscan.json)
          </button>

          <div className="flex flex-wrap items-center gap-2.5">
            <div
              className="hidden sm:inline-flex items-center bg-[#14171D] rounded-md border border-[#2D3342] p-0.5 text-[11px]"
              role="group"
              aria-label="Deep scan cluster coverage"
            >
              <button
                type="button"
                onClick={() => onChangeUnallocatedOnly(false)}
                className={`px-2.5 py-1.5 rounded transition-colors ${
                  !unallocatedOnly
                    ? 'bg-[#2A3244] text-white font-medium'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Scan every sector including active and deleted clusters"
              >
                Whole Volume
              </button>
              <button
                type="button"
                onClick={() => onChangeUnallocatedOnly(true)}
                className={`px-2.5 py-1.5 rounded transition-colors ${
                  unallocatedOnly
                    ? 'bg-[#2A3244] text-white font-medium'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Skip allocated NTFS $Bitmap clusters during deep sector carving (faster)"
              >
                Unallocated Only
              </button>
            </div>

            <div
              className="inline-flex items-center bg-[#14171D] rounded-md border border-[#2D3342] p-0.5 text-[11px]"
              role="group"
              aria-label="Scan depth mode"
            >
              <button
                type="button"
                onClick={() => onChangeScanMode('quick')}
                className={`px-3 py-1.5 rounded transition-colors ${
                  scanMode === 'quick'
                    ? 'bg-[#2A3244] text-white font-medium'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Fast filesystem metadata scan ($MFT, $UsnJrnl, FAT32, exFAT, VSS)"
              >
                Quick Scan
              </button>
              <button
                type="button"
                onClick={() => onChangeScanMode('full')}
                className={`px-3 py-1.5 rounded transition-colors ${
                  scanMode === 'full'
                    ? 'bg-[#2A3244] text-white font-medium'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
                title="Quick metadata scan followed by deep sector-by-sector raw signature carving"
              >
                Quick + Deep Scan
              </button>
            </div>

            <button
              type="button"
              onClick={() => void triggerSearch()}
              disabled={
                scanningDrivePath !== null ||
                (section !== 'repair' &&
                  section !== 'partition' &&
                  !selectedDrive &&
                  !selectedQuickTarget)
              }
              className="px-7 py-2 rounded-md text-xs font-medium bg-[#3A7AFE] hover:bg-[#2F6EEB] active:scale-[0.98] disabled:opacity-40 text-white transition-all whitespace-nowrap shrink-0"
            >
              {scanningDrivePath
                ? 'Starting Scan...'
                : section === 'repair'
                  ? 'Inspect Unknown File'
                  : section === 'partition' && !selectedDrive
                    ? 'Open Disk Image'
                    : 'Search for Lost Data'}
            </button>
          </div>
        </footer>
      </main>
    </div>
  );
};
