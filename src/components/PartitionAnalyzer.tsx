import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  HardDrive,
  RefreshCw,
  Search,
  ShieldAlert,
  Wrench,
} from 'lucide-react';
import {
  DiskAnalysisResult,
  PartitionEntry,
  writeMbrPartitionTable,
} from '../engine/partitions';
import { formatBytes } from '../engine/crc32';
import { HexViewer } from './HexViewer';

interface PartitionAnalyzerProps {
  diskName: string;
  diskBytes: Uint8Array;
  analysis: DiskAnalysisResult;
  onUpdateDiskBytes: (newBytes: Uint8Array, newName?: string) => void;
  onReanalyze: () => void;
  onLoadSampleDisk: () => void;
  onOpenInPhotoRec: (partition: PartitionEntry) => void;
}

export const PartitionAnalyzer: React.FC<PartitionAnalyzerProps> = ({
  diskName,
  diskBytes,
  analysis,
  onUpdateDiskBytes,
  onReanalyze,
  onLoadSampleDisk,
  onOpenInPhotoRec,
}) => {
  const [inspectLba, setInspectLba] = useState<number>(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    return new Set(analysis.partitions.map((p) => p.id));
  });
  const [writeFeedback, setWriteFeedback] = useState<string | null>(null);

  const lostCount = analysis.partitions.filter((p) => p.status === 'Deleted / Lost').length;

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleWriteMbrAndApply = (downloadAfter: boolean) => {
    const toWrite = analysis.partitions.filter((p) => selectedIds.has(p.id));
    if (toWrite.length === 0) return;
    const patched = writeMbrPartitionTable(diskBytes, toWrite);
    onUpdateDiskBytes(patched, diskName);
    setWriteFeedback(
      `Wrote ${Math.min(toWrite.length, 4)} partition entries to Sector 0 MBR (0x1BE–0x1FD, sig 0x55AA).`,
    );

    if (downloadAfter) {
      const blob = new Blob([patched.slice().buffer], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = diskName.replace(/(\.[^.]+)?$/, '_repaired$1');
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const sectorOffset = inspectLba * analysis.sectorSize;
  const sectorSlice = diskBytes.subarray(sectorOffset, sectorOffset + analysis.sectorSize);
  const inspectedPart = analysis.partitions.find((p) => p.startLba === inspectLba);

  return (
    <div className="space-y-6">
      {/* Disk Summary Header */}
      <div className="bg-white rounded-lg border border-slate-200 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <HardDrive className="w-5 h-5 text-slate-700 shrink-0" />
              <h2 className="text-lg font-semibold text-slate-900">{analysis.diskName}</h2>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 tabular-nums">
              <span>{formatBytes(analysis.diskSizeBytes)}</span>
              <span aria-hidden="true">·</span>
              <span>{analysis.totalSectors.toLocaleString()} sectors ({analysis.sectorSize} B/sector)</span>
              <span aria-hidden="true">·</span>
              <span>Table: {analysis.arch}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono">MBR Sig: {analysis.mbrDiskSignature}</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={onLoadSampleDisk}
              className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              Reset Sample Image
            </button>
            <button
              type="button"
              onClick={onReanalyze}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Analyse Sectors
            </button>
            <button
              type="button"
              onClick={() => handleWriteMbrAndApply(false)}
              disabled={selectedIds.size === 0 || analysis.arch === 'EFI GPT'}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed rounded-md transition-colors whitespace-nowrap shrink-0"
              title={
                analysis.arch === 'EFI GPT'
                  ? 'Direct MBR write disabled on EFI GPT images'
                  : 'Commit checked partitions to Sector 0 MBR'
              }
            >
              <Wrench className="w-3.5 h-3.5" />
              Write Partition Table
            </button>
            <button
              type="button"
              onClick={() => handleWriteMbrAndApply(true)}
              disabled={selectedIds.size === 0 || analysis.arch === 'EFI GPT'}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-sky-700 bg-sky-50 border border-sky-200 hover:bg-sky-100 disabled:opacity-40 disabled:cursor-not-allowed rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              Export Repaired .img
            </button>
          </div>
        </div>

        {/* Diagnostic Notices */}
        {(analysis.warnings.length > 0 || writeFeedback) && (
          <div className="mt-4 pt-4 border-t border-slate-100 space-y-2">
            {writeFeedback && (
              <div className="flex items-center gap-2 text-xs text-emerald-700">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{writeFeedback}</span>
              </div>
            )}
            {analysis.warnings.map((w, idx) => (
              <div key={idx} className="flex items-center gap-2 text-xs text-amber-700">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{w}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* GPT Header Metadata if present */}
      {analysis.gptHeader && (
        <div className="bg-white rounded-lg border border-slate-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-900">EFI GPT Header (LBA 1)</h3>
            <span className="text-xs text-slate-500 font-mono">
              Disk GUID: {analysis.gptHeader.diskGuid}
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
            <div>
              <div className="text-slate-500">Revision / Size</div>
              <div className="font-mono font-medium text-slate-900 mt-0.5 tabular-nums">
                v{analysis.gptHeader.revision} · {analysis.gptHeader.headerSize} B
              </div>
            </div>
            <div>
              <div className="text-slate-500">Usable LBA Range</div>
              <div className="font-mono font-medium text-slate-900 mt-0.5 tabular-nums">
                {analysis.gptHeader.firstUsableLba} – {analysis.gptHeader.lastUsableLba}
              </div>
            </div>
            <div>
              <div className="text-slate-500">Header CRC32</div>
              <div
                className={`font-mono font-medium mt-0.5 ${
                  analysis.gptHeader.headerCrcValid ? 'text-emerald-700' : 'text-red-700'
                }`}
              >
                0x{analysis.gptHeader.headerCrcStored.toString(16).toUpperCase()}{' '}
                {analysis.gptHeader.headerCrcValid ? '(Valid)' : '(Mismatch)'}
              </div>
            </div>
            <div>
              <div className="text-slate-500">Entries CRC32</div>
              <div
                className={`font-mono font-medium mt-0.5 ${
                  analysis.gptHeader.entriesCrcValid ? 'text-emerald-700' : 'text-red-700'
                }`}
              >
                0x{analysis.gptHeader.entriesCrcStored.toString(16).toUpperCase()}{' '}
                {analysis.gptHeader.entriesCrcValid ? '(Valid)' : '(Mismatch)'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Partition Table */}
      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Discovered Partitions &amp; Filesystem Structures
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {lostCount > 0
                ? `${lostCount} deleted partition detected outside the active table. Check rows to include when writing MBR.`
                : 'All detected filesystems are mapped in the active partition table.'}
            </p>
          </div>
          <span className="text-xs text-slate-500 tabular-nums">
            {analysis.partitions.length} {analysis.partitions.length === 1 ? 'entry' : 'entries'}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                <th className="py-2.5 px-4 w-10">Write</th>
                <th className="py-2.5 px-3">Slot</th>
                <th className="py-2.5 px-3">Status</th>
                <th className="py-2.5 px-3">Partition Type</th>
                <th className="py-2.5 px-3">Filesystem / Label</th>
                <th className="py-2.5 px-3 text-right">Start LBA</th>
                <th className="py-2.5 px-3 text-right">End LBA</th>
                <th className="py-2.5 px-3 text-right">Size</th>
                <th className="py-2.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {analysis.partitions.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-slate-500">
                    No MBR, GPT, or filesystem boot sectors detected in this image. Try scanning raw data in PhotoRec Carver.
                  </td>
                </tr>
              ) : (
                analysis.partitions.map((part) => {
                  const isInspected = inspectLba === part.startLba;
                  const isLost = part.status === 'Deleted / Lost';
                  return (
                    <tr
                      key={part.id}
                      className={`transition-colors ${
                        isInspected ? 'bg-sky-50/70' : 'hover:bg-slate-50'
                      }`}
                    >
                      <td className="py-2.5 px-4">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(part.id)}
                          onChange={() => toggleSelect(part.id)}
                          aria-label={`Include ${part.name} in MBR write`}
                          className="rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                        />
                      </td>
                      <td className="py-2.5 px-3 font-mono text-slate-700 tabular-nums">
                        {part.order ?? '—'}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        {isLost ? (
                          <span className="inline-flex items-center gap-1.5 font-medium text-amber-700">
                            <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                            Deleted / Lost
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700">
                            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                            {part.status}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-slate-800 whitespace-nowrap">
                        <span className="font-mono text-slate-500 mr-1.5">{part.typeCode}</span>
                        {part.typeName}
                      </td>
                      <td className="py-2.5 px-3 text-slate-700">
                        {part.detectedFs ? (
                          <div>
                            <span className="font-medium text-slate-900">
                              {part.detectedFs.filesystem}
                            </span>
                            {part.detectedFs.label && (
                              <span className="text-slate-500 ml-1.5">[{part.detectedFs.label}]</span>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-500">{part.name}</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
                        {part.startLba.toLocaleString()}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
                        {part.endLba.toLocaleString()}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-900 font-medium whitespace-nowrap">
                        {formatBytes(part.sizeBytes)}
                      </td>
                      <td className="py-2.5 px-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setInspectLba(part.startLba)}
                            className={`px-2.5 py-1 rounded text-xs font-medium transition-colors whitespace-nowrap ${
                              isInspected
                                ? 'bg-sky-600 text-white'
                                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                            }`}
                          >
                            Inspect Sector
                          </button>
                          <button
                            type="button"
                            onClick={() => onOpenInPhotoRec(part)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium bg-slate-900 text-white hover:bg-slate-800 transition-colors whitespace-nowrap"
                          >
                            <Search className="w-3 h-3" />
                            Carve
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Boot Sector Details + Hex Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white rounded-lg border border-slate-200 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">
              {inspectLba === 0 ? 'Master Boot Record (LBA 0)' : `Sector LBA ${inspectLba}`}
            </h3>
            {inspectLba !== 0 && (
              <button
                type="button"
                onClick={() => setInspectLba(0)}
                className="text-xs font-medium text-sky-700 hover:underline whitespace-nowrap"
              >
                Jump to LBA 0
              </button>
            )}
          </div>

          {inspectLba === 0 ? (
            <div className="space-y-3 text-xs">
              <div className="flex justify-between py-1.5 border-b border-slate-100">
                <span className="text-slate-500">Boot Signature (0x1FE)</span>
                <span className="font-mono font-medium text-slate-900">
                  {analysis.mbrSignatureValid ? '0x55AA (Valid)' : 'Missing / Invalid'}
                </span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-100">
                <span className="text-slate-500">Disk Identifier (0x1B8)</span>
                <span className="font-mono font-medium text-slate-900">{analysis.mbrDiskSignature}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-100">
                <span className="text-slate-500">Partition Table Range</span>
                <span className="font-mono font-medium text-slate-900">0x1BE – 0x1FD (64 B)</span>
              </div>
              <p className="text-slate-500 leading-relaxed pt-1">
                Highlighted bytes in the hex viewer mark the 4 primary MBR partition table slots (0x1BE–0x1FD) and the 0x55AA signature.
              </p>
            </div>
          ) : inspectedPart?.detectedFs ? (
            <div className="space-y-2.5 text-xs">
              <div className="flex justify-between py-1.5 border-b border-slate-100">
                <span className="text-slate-500">Filesystem</span>
                <span className="font-medium text-slate-900">{inspectedPart.detectedFs.filesystem}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-100">
                <span className="text-slate-500">Volume Label</span>
                <span className="font-mono text-slate-900">{inspectedPart.detectedFs.label}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-100">
                <span className="text-slate-500">OEM / Version</span>
                <span className="font-mono text-slate-900">{inspectedPart.detectedFs.oemOrVersion}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-100">
                <span className="text-slate-500">Bytes / Sector</span>
                <span className="font-mono tabular-nums text-slate-900">
                  {inspectedPart.detectedFs.bytesPerSector}
                </span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-slate-100">
                <span className="text-slate-500">Sectors / Cluster</span>
                <span className="font-mono tabular-nums text-slate-900">
                  {inspectedPart.detectedFs.sectorsPerCluster}
                </span>
              </div>
              <p className="text-slate-500 pt-1">{inspectedPart.detectedFs.details}</p>
            </div>
          ) : (
            <p className="text-xs text-slate-500 leading-relaxed">
              Raw sector view at LBA {inspectLba} (byte offset 0x{sectorOffset.toString(16).toUpperCase()}). Use Prev/Next controls to step through adjacent sectors.
            </p>
          )}
        </div>

        <div className="lg:col-span-2">
          <HexViewer
            bytes={sectorSlice}
            baseOffset={sectorOffset}
            maxBytes={512}
            title={inspectLba === 0 ? 'Sector 0 — MBR & Partition Table' : `Sector ${inspectLba}`}
            highlightStart={inspectLba === 0 ? 0x1be : undefined}
            highlightEnd={inspectLba === 0 ? 0x200 : undefined}
            currentLba={inspectLba}
            maxLba={Math.max(0, analysis.totalSectors - 1)}
            onStepSector={(delta) =>
              setInspectLba((cur) => Math.max(0, Math.min(analysis.totalSectors - 1, cur + delta)))
            }
          />
        </div>
      </div>
    </div>
  );
};
