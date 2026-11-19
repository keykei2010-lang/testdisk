import React, { useState } from 'react';
import { Archive, CheckCircle2, FolderOutput, HardDriveDownload, Wrench, X } from 'lucide-react';
import { createZipArchive, formatBytes } from '../engine/crc32';
import { getDesktopBridge } from '../engine/desktopBridge';
import { FileSourceRef } from '../engine/explorerTypes';
import { repairFileBuffer } from '../engine/recoveryHealth';
import { identifyBuffer } from '../engine/signatures';

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
}

interface RecoveryModalProps {
  items: RecoverableItem[];
  diskName: string;
  repairedDiskBytes?: Uint8Array | null;
  onClose: () => void;
}

const MAX_IN_MEMORY_ZIP_BYTES = 512 * 1024 * 1024;

export const RecoveryModal: React.FC<RecoveryModalProps> = ({
  items,
  diskName,
  repairedDiskBytes,
  onClose,
}) => {
  const desktop = getDesktopBridge();
  const totalBytes = items.reduce((sum, i) => sum + i.size, 0);
  const exceedsZipRamLimit = totalBytes > MAX_IN_MEMORY_ZIP_BYTES;

  const [destinationMode, setDestinationMode] = useState<'zip' | 'folder'>(
    desktop || exceedsZipRamLimit ? 'folder' : 'zip',
  );
  const [folderLayout, setFolderLayout] = useState<'type' | 'path'>('type');
  const [enableFileRepair, setEnableFileRepair] = useState<boolean>(true);
  const [verifyHeaders, setVerifyHeaders] = useState<boolean>(true);
  const [includeRepairedImg, setIncludeRepairedImg] = useState<boolean>(!!repairedDiskBytes);
  const [saving, setSaving] = useState<boolean>(false);
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const truncatedCount = items.filter((i) => i.status === 'OK_TRUNCATED').length;
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
    setSaving(true);

    try {
      const filteredItems = verifyHeaders
        ? items.filter((item) => {
            if (item.status === 'UNKNOWN') return !enableFileRepair;
            if (item.sourceRef && item.sourceRef.kind !== 'memory') return true;
            return identifyBuffer(item.data) !== null;
          })
        : items;

      if (filteredItems.length === 0) {
        setErrorMessage('No files passed header verification.');
        setSaving(false);
        return;
      }

      // 1. Native Windows Desktop streaming copy (4 MiB chunks + atomic .partial + timestamps)
      if (desktop && destinationMode === 'folder') {
        const reqItems = filteredItems.map((item) => {
          const folder = resolveOutputFolder(item);
          const refKind = item.sourceRef?.kind;
          if (refKind === 'native-device' || refKind === 'native-runs' || refKind === 'native-file') {
            return {
              filename: item.filename,
              folder,
              sourceKind: refKind,
              devicePath: item.sourceRef?.devicePath,
              offset: item.sourceRef?.offset ?? 0,
              size: item.sourceRef?.size ?? item.size,
              runs: item.sourceRef?.runs,
              extension: item.extension,
              repairIfTruncated: enableFileRepair && item.status === 'OK_TRUNCATED',
              modifiedAtMs: item.modifiedAt,
            };
          }
          let payload = item.data;
          if (enableFileRepair && item.status === 'OK_TRUNCATED') {
            const rep = repairFileBuffer(item.extension, payload);
            if (rep.repaired) payload = rep.data;
          }
          return {
            filename: item.filename,
            folder,
            sourceKind: 'memory' as const,
            offset: 0,
            size: payload.length,
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
            memoryBytes: repairedDiskBytes,
            extension: 'img',
            repairIfTruncated: false,
            modifiedAtMs: undefined,
          });
        }

        const res = await desktop.recoverFilesToFolder({
          destinationDir: null,
          items: reqItems,
        });
        if (res.error) {
          setErrorMessage(res.error);
        } else if (!res.canceled) {
          const repNote =
            res.repairedCount > 0 ? ` (${res.repairedCount} truncated file repaired)` : '';
          setResultMessage(
            `Streamed ${res.savedCount} file(s) to "${res.destinationDir}"${repNote}.`,
          );
        }
        setSaving(false);
        return;
      }

      // 2. Browser File System Access API (Direct folder write, streams File blobs cleanly)
      if (destinationMode === 'folder' && typeof window !== 'undefined' && 'showDirectoryPicker' in window) {
        const dirPicker = (
          window as unknown as {
            showDirectoryPicker: (opts?: { mode?: string }) => Promise<FileSystemDirectoryHandle>;
          }
        ).showDirectoryPicker;
        const rootHandle = await dirPicker({ mode: 'readwrite' });

        let repairedCount = 0;
        for (const item of filteredItems) {
          const folder =
            folderLayout === 'type'
              ? `${item.family}/${item.extension}`
              : item.partitionName.replace(/[^a-zA-Z0-9._-]/g, '_');
          const parts = folder.split('/').filter(Boolean);
          let curDir = rootHandle;
          for (const part of parts) {
            curDir = await curDir.getDirectoryHandle(part, { create: true });
          }
          const fileHandle = await curDir.getFileHandle(item.filename, { create: true });
          const writable = await fileHandle.createWritable();

          if (item.sourceRef?.browserFile) {
            await writable.write(item.sourceRef.browserFile);
          } else {
            let payload = item.data;
            if (enableFileRepair && item.status === 'OK_TRUNCATED') {
              const rep = repairFileBuffer(item.extension, payload);
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

      // 3. In-memory Portable ZIP Archive
      if (exceedsZipRamLimit) {
        setErrorMessage(
          `Selection totals ${formatBytes(totalBytes)}, which exceeds the 512 MiB in-memory ZIP buffer. Switch to "Local Folder" to stream large videos safely.`,
        );
        setSaving(false);
        return;
      }

      let repairedCount = 0;
      const archiveFiles: { name: string; data: Uint8Array }[] = [];
      for (const item of filteredItems) {
        let payload = item.data;
        if (item.sourceRef?.browserFile) {
          payload = new Uint8Array(await item.sourceRef.browserFile.arrayBuffer());
        } else if (desktop && item.sourceRef?.kind === 'native-file' && item.sourceRef.devicePath) {
          payload = await desktop.readDiskBytes(item.sourceRef.devicePath, 0, item.size);
        } else if (desktop && item.sourceRef?.kind === 'native-device' && item.sourceRef.devicePath) {
          payload = await desktop.readDiskBytes(
            item.sourceRef.devicePath,
            item.sourceRef.offset,
            item.size,
          );
        }

        if (enableFileRepair && item.status === 'OK_TRUNCATED') {
          const rep = repairFileBuffer(item.extension, payload);
          if (rep.repaired) {
            payload = rep.data;
            repairedCount++;
          }
        }

        const folder =
          folderLayout === 'type'
            ? `${item.family}/${item.extension}`
            : item.partitionName.replace(/[^a-zA-Z0-9._-]/g, '_');
        archiveFiles.push({ name: `${folder}/${item.filename}`, data: payload });
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
        `Packaged ${archiveFiles.length} file(s) into recovery_${archiveFiles.length}_files.zip${repairedCount > 0 ? ` (${repairedCount} repaired)` : ''}.`,
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
    <div className="fixed inset-0 z-50 bg-black/65 flex items-center justify-center p-4 animate-backdrop-in">
      <div className="w-full max-w-lg rounded-lg bg-[#181E29] border border-[#2A3446] shadow-2xl overflow-hidden animate-modal-in">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#2A3446]">
          <h3 className="text-sm font-semibold text-slate-100">
            Choose Recovery Destination
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-100 p-1 rounded"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          <div className="text-center space-y-1">
            <div className="w-11 h-11 rounded-lg bg-[#2E7CF6]/15 border border-[#2E7CF6]/30 flex items-center justify-center mx-auto mb-3">
              <HardDriveDownload className="w-5 h-5 text-[#38BDF8]" />
            </div>
            <p className="text-sm font-semibold text-slate-100">
              Export {items.length} recovered {items.length === 1 ? 'file' : 'files'}
            </p>
            <p className="text-xs text-slate-400 tabular-nums">
              Total payload: <span className="text-[#60A5FA] font-mono">{formatBytes(totalBytes)}</span> ·{' '}
              {desktop ? '4 MiB streaming disk copy' : 'Packaged offline'}
            </p>
          </div>

          <div className="grid grid-cols-2 bg-[#11151C] p-1 rounded-md border border-[#2A3446]">
            <button
              type="button"
              onClick={() => setDestinationMode('folder')}
              className={`py-2 text-xs font-medium rounded transition-colors flex items-center justify-center gap-1.5 ${
                destinationMode === 'folder'
                  ? 'bg-[#283244] text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <FolderOutput className="w-3.5 h-3.5" />
              Local Folder
            </button>
            <button
              type="button"
              onClick={() => setDestinationMode('zip')}
              className={`py-2 text-xs font-medium rounded transition-colors flex items-center justify-center gap-1.5 ${
                destinationMode === 'zip'
                  ? 'bg-[#283244] text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Archive className="w-3.5 h-3.5" />
              Portable ZIP Archive
            </button>
          </div>

          <div className="bg-[#1F2735] border border-[#2A3446] rounded-md p-4 space-y-3 text-xs">
            <div className="space-y-2">
              <div className="font-medium text-slate-200">Output Folder Organization</div>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex items-center gap-2 p-2 rounded bg-[#181E29] border border-[#2A3446] cursor-pointer">
                  <input
                    type="radio"
                    name="folderLayout"
                    checked={folderLayout === 'type'}
                    onChange={() => setFolderLayout('type')}
                    className="text-[#2E7CF6]"
                  />
                  <span className="text-slate-200">By File Type</span>
                </label>
                <label className="flex items-center gap-2 p-2 rounded bg-[#181E29] border border-[#2A3446] cursor-pointer">
                  <input
                    type="radio"
                    name="folderLayout"
                    checked={folderLayout === 'path'}
                    onChange={() => setFolderLayout('path')}
                    className="text-[#2E7CF6]"
                  />
                  <span className="text-slate-200">By Origin / Path</span>
                </label>
              </div>
            </div>

            {destinationMode === 'folder' && (
              <div className="text-slate-300 leading-relaxed">
                {supportsDirectoryPicker
                  ? 'Select a destination folder (on a different drive than the source) to stream recovered photos and large videos directly without high RAM usage.'
                  : 'Direct folder write requires the Windows desktop app or a top-level Chromium window. Switch to Portable ZIP Archive or run the Windows .exe.'}
              </div>
            )}

            <div className="pt-2 border-t border-[#2A3446] space-y-2">
              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <span className="text-slate-200 inline-flex items-center gap-1.5">
                  <Wrench className="w-3.5 h-3.5 text-[#38BDF8]" />
                  Enable file repair
                  {truncatedCount > 0 && (
                    <span className="text-[11px] text-amber-300">({truncatedCount} fixable)</span>
                  )}
                </span>
                <input
                  type="checkbox"
                  checked={enableFileRepair}
                  onChange={(e) => setEnableFileRepair(e.target.checked)}
                  className="rounded border-slate-600 bg-[#11151C] text-[#2E7CF6]"
                />
              </label>

              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <span className="text-slate-300">Verify file headers before export (Paranoid check)</span>
                <input
                  type="checkbox"
                  checked={verifyHeaders}
                  onChange={(e) => setVerifyHeaders(e.target.checked)}
                  className="rounded border-slate-600 bg-[#11151C] text-[#2E7CF6]"
                />
              </label>

              {repairedDiskBytes && (
                <label className="flex items-center justify-between gap-3 cursor-pointer">
                  <span className="text-slate-300">Include repaired partition table image (.img)</span>
                  <input
                    type="checkbox"
                    checked={includeRepairedImg}
                    onChange={(e) => setIncludeRepairedImg(e.target.checked)}
                    className="rounded border-slate-600 bg-[#11151C] text-[#2E7CF6]"
                  />
                </label>
              )}
            </div>
          </div>

          {resultMessage && (
            <div className="flex items-center gap-2 text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-md px-3 py-2 animate-slide-down">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{resultMessage}</span>
            </div>
          )}

          {errorMessage && (
            <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2">
              {errorMessage}
            </div>
          )}
        </div>

        <div className="px-6 py-3.5 bg-[#141922] border-t border-[#2A3446] flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-[#1F2735] hover:bg-[#283244] rounded-md transition-colors"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || items.length === 0}
            className="px-5 py-1.5 text-xs font-medium text-white bg-[#2E7CF6] hover:bg-[#2569D6] disabled:opacity-40 rounded-md transition-colors"
          >
            {saving ? 'Recovering...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};
