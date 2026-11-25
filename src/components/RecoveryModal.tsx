import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Archive, CheckCircle2, Folder, HardDrive, X } from 'lucide-react';
import { createZipArchive, formatBytes } from '../engine/crc32';
import {
  getDesktopBridge,
  NativeRecoverFailure,
  WindowsVolumeInfo,
} from '../engine/desktopBridge';
import { FileSourceRef } from '../engine/explorerTypes';
import { repairFileBuffer, resolvePreferredExtension } from '../engine/recoveryHealth';

export interface RecoverableItem {
  id: string;
  filename: string;
  extension: string;
  family: string;
  partitionName: string;
  originalPath?: string;
  modifiedAt?: number;
  size: number;
  status: 'OK' | 'OK_TRUNCATED' | 'HEADER_ONLY' | 'UNKNOWN';
  data: Uint8Array;
  sourceRef?: FileSourceRef;
  discoveryCrc32?: number;
}

interface RecoveryModalProps {
  items: RecoverableItem[];
  diskName: string;
  scannedDevicePath?: string | null;
  repairedDiskBytes?: Uint8Array | null;
  onClose: () => void;
}

const MAX_IN_MEMORY_ZIP_BYTES = 512 * 1024 * 1024;
const LAST_DEST_STORAGE_KEY = 'td_last_dest_dir';

function readSavedDestDir(): string | null {
  try {
    const val = window.localStorage.getItem(LAST_DEST_STORAGE_KEY);
    return val && val.trim() ? val.trim() : null;
  } catch {
    return null;
  }
}

function saveLastDestDir(dir: string) {
  try {
    if (dir) window.localStorage.setItem(LAST_DEST_STORAGE_KEY, dir);
  } catch {
    // ignore storage errors
  }
}

function extractDriveLetter(pathStr?: string | null): string | null {
  if (!pathStr) return null;
  const m = pathStr.trim().match(/^([A-Za-z]):/);
  return m ? m[1].toUpperCase() : null;
}

function makeUniqueArchivePath(folder: string, filename: string, used: Set<string>): string {
  const basePath = `${folder}/${filename}`;
  if (!used.has(basePath)) {
    used.add(basePath);
    return basePath;
  }
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  let idx = 2;
  while (used.has(`${folder}/${stem}_${idx}${ext}`)) {
    idx++;
  }
  const unique = `${folder}/${stem}_${idx}${ext}`;
  used.add(unique);
  return unique;
}

export const RecoveryModal: React.FC<RecoveryModalProps> = ({
  items,
  diskName,
  scannedDevicePath,
  repairedDiskBytes,
  onClose,
}) => {
  const desktop = getDesktopBridge();
  const totalBytes = items.reduce((sum, i) => sum + i.size, 0);
  const exceedsZipRamLimit = totalBytes > MAX_IN_MEMORY_ZIP_BYTES;

  const [destinationMode, setDestinationMode] = useState<'folder' | 'zip'>(
    desktop || exceedsZipRamLimit ? 'folder' : 'zip',
  );
  const [volumes, setVolumes] = useState<WindowsVolumeInfo[]>([]);
  const [selectedRootDir, setSelectedRootDir] = useState<string | null>(() => readSavedDestDir());
  const [folderLayout, setFolderLayout] = useState<'type' | 'path'>('type');
  const [enableFileRepair, setEnableFileRepair] = useState<boolean>(true);
  const [referenceVideoName, setReferenceVideoName] = useState<string | null>(null);
  const [referenceVideoBytes, setReferenceVideoBytes] = useState<Uint8Array | null>(null);
  const [includeRepairedImg, setIncludeRepairedImg] = useState<boolean>(!!repairedDiskBytes);
  const [saving, setSaving] = useState<boolean>(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [reportPath, setReportPath] = useState<string | null>(null);
  const [failures, setFailures] = useState<NativeRecoverFailure[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const sourceDriveLetters = useMemo(() => {
    const letters = new Set<string>();
    const fromScanned = extractDriveLetter(scannedDevicePath);
    if (fromScanned) letters.add(fromScanned);
    const firstItemDrive = extractDriveLetter(items[0]?.sourceRef?.devicePath);
    if (firstItemDrive) letters.add(firstItemDrive);
    // Physical drive labels look like "Samsung SSD 980 (C:, D:)"
    const parenMatch = diskName.match(/\(([^)]+)\)/);
    if (parenMatch) {
      for (const m of parenMatch[1].matchAll(/\b([A-Za-z]):/g)) {
        letters.add(m[1].toUpperCase());
      }
    }
    return letters;
  }, [scannedDevicePath, items, diskName]);

  const selectedDriveLetter = extractDriveLetter(selectedRootDir);
  const sameDriveWarning =
    destinationMode === 'folder' &&
    selectedDriveLetter !== null &&
    sourceDriveLetters.has(selectedDriveLetter);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, saving]);

  const didInitDefaultRef = useRef(false);

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    desktop
      .listWindowsVolumes()
      .then((list) => {
        if (!active) return;
        setVolumes(list);
        if (list.length > 0 && !didInitDefaultRef.current) {
          didInitDefaultRef.current = true;
          setSelectedRootDir((cur) => {
            if (cur !== null) return cur;
            const safeVol =
              list.find((v) => !sourceDriveLetters.has(v.driveLetter.slice(0, 1).toUpperCase())) ??
              list[0];
            return `${safeVol.rootPath}Recovered_Files`;
          });
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [desktop, sourceDriveLetters]);

  const truncatedCount = items.filter((i) => i.status === 'OK_TRUNCATED').length;
  const hasBrokenVideo = items.some(
    (i) =>
      i.status === 'OK_TRUNCATED' &&
      ['mp4', 'mov', 'm4v', '3gp'].includes(i.extension.toLowerCase()),
  );
  const hasBrokenJpeg = items.some(
    (i) =>
      i.status === 'OK_TRUNCATED' && ['jpg', 'jpeg'].includes(i.extension.toLowerCase()),
  );
  const supportsDirectoryPicker =
    !!desktop ||
    (typeof window !== 'undefined' &&
      'showDirectoryPicker' in window &&
      window.self === window.top);

  const resolveOutputFolder = (item: RecoverableItem) => {
    if (folderLayout === 'type') {
      return `${item.family}/${item.extension}`;
    }
    if (item.originalPath && item.originalPath.includes('\\')) {
      const stripped = item.originalPath
        .replace(/^(FAT32|exFAT|NTFS)\s+/i, '')
        .replace(/^[A-Za-z]:\\/, '')
        .split(/[\\/]/)
        .slice(0, -1)
        .filter(Boolean)
        .join('/');
      if (stripped) return stripped;
    }
    return item.partitionName.replace(/[^a-zA-Z0-9._-]/g, '_');
  };

  const handleSave = async () => {
    setErrorMessage(null);
    setResultMessage(null);
    setReportPath(null);
    setFailures([]);
    setSaving(true);

    try {
      const filteredItems = items.filter((item) => {
        if (item.status === 'UNKNOWN') return !enableFileRepair;
        return true;
      });

      if (filteredItems.length === 0) {
        setErrorMessage('No valid recoverable files found in selection.');
        setSaving(false);
        return;
      }

      // 1. Native Windows Desktop streaming copy
      if (desktop && destinationMode === 'folder') {
        const reqItems = filteredItems.map((item) => {
          const folder = resolveOutputFolder(item);
          const refKind = item.sourceRef?.kind;
          const outName = resolvePreferredExtension(item.filename, item.extension);
          if (
            refKind === 'native-device' ||
            refKind === 'native-runs' ||
            refKind === 'native-file' ||
            refKind === 'native-tsk'
          ) {
            return {
              filename: outName,
              folder,
              sourceKind: refKind,
              devicePath: item.sourceRef?.devicePath,
              offset: item.sourceRef?.offset ?? 0,
              size: item.sourceRef?.size ?? item.size,
              runs: item.sourceRef?.runs,
              tskInode: item.sourceRef?.tskInode,
              tskOffset: item.sourceRef?.tskOffset,
              discoveryCrc32: item.discoveryCrc32,
              extension: item.extension,
              repairIfTruncated: enableFileRepair && item.status === 'OK_TRUNCATED',
              modifiedAtMs: item.modifiedAt,
            };
          }
          let payload = item.data;
          if (enableFileRepair && item.status === 'OK_TRUNCATED') {
            const rep = repairFileBuffer(item.extension, payload, referenceVideoBytes ?? undefined);
            if (rep.repaired) payload = rep.data;
          }
          return {
            filename: outName,
            folder,
            sourceKind: 'memory' as const,
            offset: 0,
            size: payload.length,
            discoveryCrc32: item.discoveryCrc32,
            memoryBytes: payload,
            extension: item.extension,
            repairIfTruncated: false,
            modifiedAtMs: item.modifiedAt,
          };
        });

        if (includeRepairedImg && repairedDiskBytes) {
          reqItems.push({
            filename: diskName.replace(/(\.[^.]+)?$/, '_repaired$1'),
            folder: 'Repaired_Disk_Image',
            sourceKind: 'memory',
            offset: 0,
            size: repairedDiskBytes.length,
            discoveryCrc32: undefined,
            memoryBytes: repairedDiskBytes,
            extension: 'img',
            repairIfTruncated: false,
            modifiedAtMs: undefined,
          });
        }

        const res = await desktop.recoverFilesToFolder({
          destinationDir: selectedRootDir,
          scannedDevicePath: scannedDevicePath ?? undefined,
          items: reqItems,
        });
        if (res.error) {
          setErrorMessage(res.error);
        } else if (!res.canceled) {
          if (res.destinationDir) saveLastDestDir(res.destinationDir);
          const extras: string[] = [];
          if ((res.verifiedCount ?? 0) > 0) extras.push(`${res.verifiedCount} CRC-verified`);
          if (res.repairedCount > 0) extras.push(`${res.repairedCount} repaired`);
          const extraNote = extras.length > 0 ? ` (${extras.join(', ')})` : '';
          setResultMessage(
            `Saved ${res.savedCount} file(s) to "${res.destinationDir}"${extraNote}.`,
          );
          if (res.reportPath) setReportPath(res.reportPath);
          if (res.failures && res.failures.length > 0) setFailures(res.failures);
        }
        setSaving(false);
        return;
      }

      // 2. Browser File System Access API
      if (
        destinationMode === 'folder' &&
        typeof window !== 'undefined' &&
        'showDirectoryPicker' in window
      ) {
        const dirPicker = (
          window as unknown as {
            showDirectoryPicker: (opts?: { mode?: string }) => Promise<FileSystemDirectoryHandle>;
          }
        ).showDirectoryPicker;
        const rootHandle = await dirPicker({ mode: 'readwrite' });

        let repairedCount = 0;
        const usedPaths = new Set<string>();
        for (const item of filteredItems) {
          const folder = resolveOutputFolder(item);
          const outName = resolvePreferredExtension(item.filename, item.extension);
          const uniquePath = makeUniqueArchivePath(folder, outName, usedPaths);
          const uniqueFilename = uniquePath.slice(folder.length + 1);
          const parts = folder.split('/').filter(Boolean);
          let curDir = rootHandle;
          for (const part of parts) {
            curDir = await curDir.getDirectoryHandle(part, { create: true });
          }
          const fileHandle = await curDir.getFileHandle(uniqueFilename, { create: true });
          const writable = await fileHandle.createWritable();

          if (item.sourceRef?.browserFile) {
            if (enableFileRepair && item.status === 'OK_TRUNCATED') {
              let payload: Uint8Array = new Uint8Array(
                await item.sourceRef.browserFile.arrayBuffer(),
              );
              const rep = repairFileBuffer(
                item.extension,
                payload,
                referenceVideoBytes ?? undefined,
              );
              if (rep.repaired) {
                payload = rep.data;
                repairedCount++;
              }
              await writable.write(payload.slice().buffer);
            } else {
              await writable.write(item.sourceRef.browserFile);
            }
          } else {
            let payload = item.data;
            if (enableFileRepair && item.status === 'OK_TRUNCATED') {
              const rep = repairFileBuffer(
                item.extension,
                payload,
                referenceVideoBytes ?? undefined,
              );
              if (rep.repaired) {
                payload = rep.data;
                repairedCount++;
              }
            }
            await writable.write(payload.slice().buffer);
          }
          await writable.close();
        }
        setResultMessage(
          `Saved ${filteredItems.length} file(s) directly to "${rootHandle.name}"${repairedCount > 0 ? ` (${repairedCount} repaired)` : ''}.`,
        );
        setSaving(false);
        return;
      }

      // 3. Portable ZIP Archive
      if (exceedsZipRamLimit) {
        setErrorMessage(
          `Selection totals ${formatBytes(totalBytes)}, exceeding 512 MiB in-memory ZIP limit. Choose a Local Folder instead.`,
        );
        setSaving(false);
        return;
      }

      let repairedCount = 0;
      const usedArchivePaths = new Set<string>();
      const archiveFiles: { name: string; data: Uint8Array }[] = [];
      for (const item of filteredItems) {
        let payload = item.data;
        if (item.sourceRef?.browserFile) {
          payload = new Uint8Array(await item.sourceRef.browserFile.arrayBuffer());
        } else if (desktop && item.sourceRef?.kind === 'native-file' && item.sourceRef.devicePath) {
          payload = await desktop.readDiskBytes(item.sourceRef.devicePath, 0, item.size);
        } else if (
          desktop &&
          item.sourceRef?.kind === 'native-tsk' &&
          item.sourceRef.devicePath
        ) {
          payload = await desktop.readDiskBytes(
            item.sourceRef.devicePath,
            0,
            item.size,
            item.sourceRef.tskInode,
            item.sourceRef.tskOffset,
          );
        } else if (
          desktop &&
          item.sourceRef?.kind === 'native-runs' &&
          item.sourceRef.devicePath &&
          item.sourceRef.runs &&
          item.sourceRef.runs.length > 0
        ) {
          const targetLen = Math.min(item.size, MAX_IN_MEMORY_ZIP_BYTES);
          const assembled = new Uint8Array(targetLen);
          let cursor = 0;
          for (const run of item.sourceRef.runs) {
            if (cursor >= targetLen) break;
            const want = Math.min(run.length, targetLen - cursor);
            if (want <= 0) continue;
            if (run.offset >= 0) {
              const part = await desktop.readDiskBytes(item.sourceRef.devicePath, run.offset, want);
              assembled.set(part.subarray(0, want), cursor);
            }
            cursor += want;
          }
          payload = assembled.subarray(0, cursor);
        } else if (
          desktop &&
          item.sourceRef?.kind === 'native-device' &&
          item.sourceRef.devicePath
        ) {
          payload = await desktop.readDiskBytes(
            item.sourceRef.devicePath,
            item.sourceRef.offset,
            item.size,
          );
        }

        if (enableFileRepair && item.status === 'OK_TRUNCATED') {
          const rep = repairFileBuffer(item.extension, payload, referenceVideoBytes ?? undefined);
          if (rep.repaired) {
            payload = rep.data;
            repairedCount++;
          }
        }

        const folder = resolveOutputFolder(item);
        const outName = resolvePreferredExtension(item.filename, item.extension);
        const archivePath = makeUniqueArchivePath(folder, outName, usedArchivePaths);
        archiveFiles.push({ name: archivePath, data: payload });
      }

      if (includeRepairedImg && repairedDiskBytes) {
        archiveFiles.push({
          name: diskName.replace(/(\.[^.]+)?$/, '_repaired$1'),
          data: repairedDiskBytes,
        });
      }

      const zipBytes = createZipArchive(archiveFiles);
      const blob = new Blob([zipBytes.slice().buffer], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `recovery_${archiveFiles.length}_files.zip`;
      a.click();
      URL.revokeObjectURL(url);
      setResultMessage(
        `Saved ${archiveFiles.length} file(s) into recovery_${archiveFiles.length}_files.zip${repairedCount > 0 ? ` (${repairedCount} repaired)` : ''}.`,
      );
    } catch (err) {
      if ((err as { name?: string })?.name !== 'AbortError') {
        setErrorMessage('Could not write to local folder; try choosing another folder or ZIP.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/65 flex items-center justify-center p-4 animate-backdrop-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="recovery-modal-title"
    >
      <div className="w-full max-w-[490px] rounded-lg bg-[#222630] border border-[#343A48] shadow-2xl overflow-hidden animate-modal-in relative">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3.5 right-3.5 text-slate-400 hover:text-white p-1 rounded transition-colors"
          aria-label="Close modal"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="px-6 pt-6 pb-5 space-y-4">
          {/* Centered Save Icon & Summary (matches Screenshot 3) */}
          <div className="text-center space-y-1.5">
            <div className="mx-auto w-12 h-12 flex items-center justify-center mb-1">
              <svg viewBox="0 0 48 48" className="w-11 h-11" aria-hidden="true">
                <path
                  d="M8 6h26l8 8v26a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"
                  fill="#3A7AFE"
                />
                <rect x="13" y="6" width="18" height="12" rx="1.5" fill="#DCE8FF" />
                <rect x="24" y="8.5" width="4" height="7" rx="1" fill="#3A7AFE" />
                <rect x="12" y="25" width="24" height="13" rx="2" fill="#1847B8" />
                <rect x="16" y="29" width="16" height="2" rx="1" fill="#93C5FD" />
              </svg>
            </div>
            <h3 id="recovery-modal-title" className="text-sm font-semibold text-slate-100">
              Choose a destination path to save the file:
            </h3>
            <p className="text-xs text-slate-400 tabular-nums">
              You have{' '}
              <span className="text-[#4C8DFF] font-medium">
                {items.length} file(s) ({formatBytes(totalBytes)})
              </span>{' '}
              to recover.
            </p>
          </div>

          {/* Destination Mode Tabs (Local Folder | Portable ZIP) */}
          <div className="grid grid-cols-2 border-b border-[#2F3544] text-xs">
            <button
              type="button"
              onClick={() => setDestinationMode('folder')}
              className={`py-2 font-medium border-b-2 transition-colors ${
                destinationMode === 'folder'
                  ? 'border-[#3A7AFE] text-slate-100 bg-[#282D39]'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              Local
            </button>
            <button
              type="button"
              onClick={() => setDestinationMode('zip')}
              className={`py-2 font-medium border-b-2 transition-colors ${
                destinationMode === 'zip'
                  ? 'border-[#3A7AFE] text-slate-100 bg-[#282D39]'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              Portable ZIP
            </button>
          </div>

          {/* Destination Selector List Box */}
          <div className="bg-[#181B22] border border-[#2D3342] rounded-md p-2.5 space-y-2 min-h-[156px]">
            {destinationMode === 'folder' ? (
              <div className="space-y-1.5">
                {volumes.map((vol) => {
                  const target = `${vol.rootPath}Recovered_Files`;
                  const isSel = selectedRootDir === target;
                  return (
                    <button
                      key={vol.driveLetter}
                      type="button"
                      onClick={() => setSelectedRootDir(target)}
                      className={`w-full flex items-center justify-between px-3 py-2.5 rounded text-left text-xs transition-colors ${
                        isSel
                          ? 'bg-[#2B3344] border border-[#3E4C66] text-white'
                          : 'hover:bg-[#222630] border border-transparent text-slate-200'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span
                          className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center shrink-0 ${
                            isSel ? 'border-[#3A7AFE] bg-[#3A7AFE]' : 'border-slate-500'
                          }`}
                        >
                          {isSel && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                        </span>
                        <HardDrive className="w-5 h-5 text-[#4C8DFF] shrink-0" />
                        <div className="min-w-0">
                          <div className="font-medium truncate">
                            {vol.label} ({vol.driveLetter})
                          </div>
                          <div className="text-[11px] text-slate-400 font-mono tabular-nums">
                            {formatBytes(vol.freeBytes)} / {formatBytes(vol.totalBytes)} free
                          </div>
                        </div>
                      </div>
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    </button>
                  );
                })}

                <button
                  type="button"
                  onClick={() => setSelectedRootDir(null)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded text-left text-xs transition-colors ${
                    selectedRootDir === null
                      ? 'bg-[#2B3344] border border-[#3E4C66] text-white'
                      : 'hover:bg-[#222630] border border-transparent text-slate-200'
                  }`}
                >
                  <span
                    className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center shrink-0 ${
                      selectedRootDir === null
                        ? 'border-[#3A7AFE] bg-[#3A7AFE]'
                        : 'border-slate-500'
                    }`}
                  >
                    {selectedRootDir === null && (
                      <span className="w-1.5 h-1.5 rounded-full bg-white" />
                    )}
                  </span>
                  <Folder className="w-5 h-5 text-[#4C8DFF] fill-[#4C8DFF]/30 shrink-0" />
                  <div className="min-w-0">
                    <div className="font-medium">Choose folder...</div>
                    <div className="text-[11px] text-slate-400 truncate">
                      {supportsDirectoryPicker
                        ? 'Stream directly to a selected folder on another drive'
                        : 'Browser iframe sandbox — switch to Portable ZIP or Windows .exe'}
                    </div>
                  </div>
                </button>
              </div>
            ) : (
              <div className="p-2.5 flex items-start gap-3 text-xs text-slate-300">
                <Archive className="w-5 h-5 text-[#4C8DFF] shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <div className="font-medium text-slate-100">
                    Portable ZIP Package (recovery_{items.length}_files.zip)
                  </div>
                  <div className="text-[11px] text-slate-400 leading-relaxed">
                    Bundles recovered files cleanly offline with CRC32 verification. Recommended up
                    to 512 MiB; use Local Folder for multi-GB video streams.
                  </div>
                </div>
              </div>
            )}

            <div className="pt-2 mt-1 border-t border-[#262B36] flex items-center justify-between px-2 text-[11px] text-slate-400">
              <span>Folder layout:</span>
              <div className="flex items-center gap-3">
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="folderLayout"
                    checked={folderLayout === 'type'}
                    onChange={() => setFolderLayout('type')}
                    className="accent-[#3A7AFE]"
                  />
                  <span className="text-slate-200">By Type</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="radio"
                    name="folderLayout"
                    checked={folderLayout === 'path'}
                    onChange={() => setFolderLayout('path')}
                    className="accent-[#3A7AFE]"
                  />
                  <span className="text-slate-200">By Origin Path</span>
                </label>
              </div>
            </div>

            {repairedDiskBytes && (
              <label className="flex items-center justify-between px-2 pt-1 text-[11px] text-slate-300 cursor-pointer">
                <span>Include repaired partition table (.img)</span>
                <input
                  type="checkbox"
                  checked={includeRepairedImg}
                  onChange={(e) => setIncludeRepairedImg(e.target.checked)}
                  className="accent-[#3A7AFE]"
                />
              </label>
            )}

            {(hasBrokenVideo || hasBrokenJpeg) && enableFileRepair && (
              <div className="flex items-center justify-between gap-2 px-2 pt-1.5 border-t border-[#262B36] text-[11px] text-slate-300">
                <span className="truncate" title={referenceVideoName || undefined}>
                  {referenceVideoName
                    ? `Reference sample: ${referenceVideoName}`
                    : hasBrokenVideo
                      ? 'Optional healthy camera .mp4/.mov/.jpg for header/moov repair'
                      : 'Optional healthy camera .jpg for header repair'}
                </span>
                <label className="px-2 py-0.5 rounded bg-[#262B36] hover:bg-[#2F3644] border border-[#343A48] text-slate-200 cursor-pointer shrink-0">
                  Choose Sample
                  <input
                    type="file"
                    accept=".mp4,.mov,.m4v,.3gp,.jpg,.jpeg"
                    className="hidden"
                    onChange={async (e) => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      const slice = new Uint8Array(await f.slice(0, 8 * 1024 * 1024).arrayBuffer());
                      setReferenceVideoName(f.name);
                      setReferenceVideoBytes(slice);
                      e.target.value = '';
                    }}
                  />
                </label>
              </div>
            )}
          </div>

          {sameDriveWarning && (
            <div className="flex items-start gap-2 text-xs text-amber-200 bg-amber-500/10 border border-amber-500/35 rounded-md px-3 py-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <span>
                Destination is on the same drive as the scanned source ({selectedDriveLetter}:) —
                saving here may overwrite unallocated clusters. Pick a different drive if possible.
              </span>
            </div>
          )}

          {resultMessage && (
            <div className="space-y-1.5 text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-md px-3 py-2 animate-slide-down">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{resultMessage}</span>
              </div>
              {reportPath && (
                <div className="text-[11px] font-mono text-emerald-200/85 pl-6 break-all">
                  Audit log: {reportPath}
                </div>
              )}
            </div>
          )}

          {failures.length > 0 && (
            <div className="text-xs text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2 space-y-1 max-h-28 overflow-y-auto">
              <div className="font-medium">
                {failures.length} item(s) had warnings/skipped writes:
              </div>
              {failures.slice(0, 6).map((f, idx) => (
                <div key={`${f.filename}-${idx}`} className="text-[11px] font-mono text-amber-200/85">
                  · {f.filename}: {f.reason}
                </div>
              ))}
              {failures.length > 6 && (
                <div className="text-[11px] text-amber-300">
                  +{failures.length - 6} more (see TestDisk-Recovery-Report.txt)
                </div>
              )}
            </div>
          )}

          {errorMessage && (
            <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2">
              {errorMessage}
            </div>
          )}

          {/* Bottom Bar: Enable file repair toggle + Save button (matches Screenshot 3) */}
          <div className="flex items-center justify-between pt-1">
            <label className="inline-flex items-center gap-2.5 text-xs text-slate-200 cursor-pointer select-none">
              <button
                type="button"
                role="switch"
                aria-checked={enableFileRepair}
                onClick={() => setEnableFileRepair((v) => !v)}
                className={`relative w-8 h-4.5 rounded-full transition-colors ${
                  enableFileRepair ? 'bg-[#3A7AFE]' : 'bg-[#363D4E]'
                }`}
              >
                <span
                  className={`block w-3.5 h-3.5 rounded-full bg-white transition-transform translate-y-[2px] ${
                    enableFileRepair ? 'translate-x-[16px]' : 'translate-x-[2px]'
                  }`}
                />
              </button>
              <span>
                Enable file repair
                {truncatedCount > 0 && (
                  <span className="text-slate-400 ml-1">({truncatedCount} fixable)</span>
                )}
              </span>
            </label>

            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || items.length === 0}
              className="px-7 py-1.5 text-xs font-medium text-white bg-[#3A7AFE] hover:bg-[#2F6EEB] disabled:opacity-40 rounded-md transition-colors"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
