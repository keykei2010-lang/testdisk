import React, { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  Check,
  Download,
  Eye,
  FileText,
  Filter,
  Image as ImageIcon,
  Music,
  Play,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { DiskAnalysisResult, PartitionEntry } from '../engine/partitions';
import {
  CarvedFile,
  FILE_FORMATS,
  FileFamily,
  carveDiskBuffer,
} from '../engine/signatures';
import { createZipArchive, formatBytes } from '../engine/crc32';
import { HexViewer } from './HexViewer';

interface PhotoRecCarverProps {
  diskBytes: Uint8Array;
  analysis: DiskAnalysisResult;
  initialPartitionId?: string | null;
}

const FAMILIES: FileFamily[] = ['Images', 'Documents', 'Archives', 'Media', 'Databases', 'System'];

export const PhotoRecCarver: React.FC<PhotoRecCarverProps> = ({
  diskBytes,
  analysis,
  initialPartitionId,
}) => {
  const [targetScope, setTargetScope] = useState<string>(initialPartitionId ?? 'whole');
  const [blockSize, setBlockSize] = useState<number>(512);
  const [paranoid, setParanoid] = useState<boolean>(true);
  const [keepCorrupted, setKeepCorrupted] = useState<boolean>(false);
  const [enabledFormats, setEnabledFormats] = useState<Set<string>>(
    () => new Set(FILE_FORMATS.filter((f) => f.enableByDefault).map((f) => f.id)),
  );
  const [showFormatModal, setShowFormatModal] = useState<boolean>(false);
  const [carvedFiles, setCarvedFiles] = useState<CarvedFile[] | null>(null);
  const [selectedFile, setSelectedFile] = useState<CarvedFile | null>(null);
  const [familyFilter, setFamilyFilter] = useState<FileFamily | 'All'>('All');

  const previewUrl = useMemo(() => {
    if (!selectedFile) return null;
    const blob = new Blob([selectedFile.data.slice().buffer], { type: selectedFile.mimeType });
    return URL.createObjectURL(blob);
  }, [selectedFile]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const selectedPartition: PartitionEntry | undefined = useMemo(
    () => analysis.partitions.find((p) => p.id === targetScope),
    [analysis.partitions, targetScope],
  );

  const handleRunSearch = () => {
    const startByte = selectedPartition ? selectedPartition.startOffset : 0;
    const endByte = selectedPartition
      ? selectedPartition.startOffset + selectedPartition.sizeBytes
      : diskBytes.length;

    const files = carveDiskBuffer(diskBytes, {
      startByte,
      endByte,
      blockSize,
      paranoid,
      keepCorrupted,
      enabledFormats,
    });
    setCarvedFiles(files);
    setSelectedFile(files[0] ?? null);
    setFamilyFilter('All');
  };

  const formatStats = useMemo(() => {
    if (!carvedFiles) return [];
    const counts = new Map<string, number>();
    for (const f of carvedFiles) {
      counts.set(f.extension, (counts.get(f.extension) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [carvedFiles]);

  const filteredFiles = useMemo(() => {
    if (!carvedFiles) return [];
    if (familyFilter === 'All') return carvedFiles;
    return carvedFiles.filter((f) => f.family === familyFilter);
  }, [carvedFiles, familyFilter]);

  const handleDownloadSingle = (file: CarvedFile) => {
    const blob = new Blob([file.data.slice().buffer], { type: file.mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadAllZip = () => {
    if (!carvedFiles || carvedFiles.length === 0) return;
    const zipBytes = createZipArchive(
      carvedFiles.map((f) => ({
        name: `${f.recupDir}/${f.filename}`,
        data: f.data,
      })),
    );
    const blob = new Blob([zipBytes.slice().buffer], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `photorec_recovered_${carvedFiles.length}_files.zip`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggleFormat = (id: string) => {
    setEnabledFormats((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleFamily = (family: FileFamily, enable: boolean) => {
    setEnabledFormats((prev) => {
      const next = new Set(prev);
      for (const f of FILE_FORMATS) {
        if (f.family === family) {
          if (enable) next.add(f.id);
          else next.delete(f.id);
        }
      }
      return next;
    });
  };

  return (
    <div className="space-y-6">
      {/* Configuration Card (QPhotoRec workflow) */}
      <div className="bg-white rounded-lg border border-slate-200 p-5 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              PhotoRec Signature Carver
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Carve files directly from unallocated sectors or damaged filesystems using header/footer validation.
            </p>
          </div>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setShowFormatModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              File Formats ({enabledFormats.size}/{FILE_FORMATS.length})
            </button>
            <button
              type="button"
              onClick={handleRunSearch}
              disabled={enabledFormats.size === 0}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-40 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <Play className="w-3.5 h-3.5" />
              Search &amp; Carve
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4 border-t border-slate-100">
          <div>
            <label
              htmlFor="photorec-scope"
              className="block text-xs font-medium text-slate-700 mb-1.5"
            >
              Target Partition / Disk Range
            </label>
            <select
              id="photorec-scope"
              value={targetScope}
              onChange={(e) => setTargetScope(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
            >
              <option value="whole">
                Whole Disk — {analysis.diskName} ({formatBytes(analysis.diskSizeBytes)})
              </option>
              {analysis.partitions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.status === 'Deleted / Lost' ? '[Lost] ' : `Part ${p.order ?? ''} `}
                  {p.detectedFs?.filesystem ?? p.typeName} ({p.name}) · LBA {p.startLba}–{p.endLba} (
                  {formatBytes(p.sizeBytes)})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="photorec-blocksize"
              className="block text-xs font-medium text-slate-700 mb-1.5"
            >
              Sector / Block Alignment
            </label>
            <select
              id="photorec-blocksize"
              value={blockSize}
              onChange={(e) => setBlockSize(Number(e.target.value))}
              className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-md text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
            >
              <option value={512}>512 bytes (Standard Sector Alignment)</option>
              <option value={1024}>1024 bytes (1 KiB Block)</option>
              <option value={4096}>4096 bytes (4 KiB Cluster / Advanced Format)</option>
            </select>
          </div>

          <div className="flex flex-col justify-center gap-2 pt-1">
            <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={paranoid}
                onChange={(e) => setParanoid(e.target.checked)}
                className="rounded border-slate-300 text-slate-900 focus:ring-slate-900"
              />
              Paranoid mode (verify footer &amp; structural integrity)
            </label>
            <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input
                type="checkbox"
                checked={keepCorrupted}
                onChange={(e) => setKeepCorrupted(e.target.checked)}
                className="rounded border-slate-300 text-slate-900 focus:ring-slate-900"
              />
              Keep truncated / corrupted files
            </label>
          </div>
        </div>
      </div>

      {/* Results Area */}
      {carvedFiles === null ? (
        <div className="bg-white rounded-lg border border-slate-200 p-12 text-center space-y-3">
          <Archive className="w-8 h-8 text-slate-400 mx-auto" />
          <div className="text-sm font-medium text-slate-900">Ready to carve {analysis.diskName}</div>
          <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
            Choose a target partition or scan the whole disk image, then click Search &amp; Carve to extract recoverable images, documents, archives, databases, and media.
          </p>
          <div className="pt-2">
            <button
              type="button"
              onClick={handleRunSearch}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md transition-colors"
            >
              <Play className="w-3.5 h-3.5" />
              Run Carving Scan
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Summary Stats Strip */}
          <div className="bg-white rounded-lg border border-slate-200 p-5 flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="text-sm font-semibold text-slate-900 tabular-nums">
                Recovery completed · {carvedFiles.length} {carvedFiles.length === 1 ? 'file' : 'files'} carved
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600 tabular-nums">
                {formatStats.length === 0 ? (
                  <span>No matching signatures found in selected range.</span>
                ) : (
                  formatStats.map(([ext, count], idx) => (
                    <span key={ext} className="inline-flex items-center gap-1">
                      {idx > 0 && <span className="text-slate-300 mr-2" aria-hidden="true">·</span>}
                      <span className="font-mono font-semibold text-slate-900 uppercase">{ext}</span>
                      <span>{count}</span>
                    </span>
                  ))
                )}
              </div>
            </div>

            {carvedFiles.length > 0 && (
              <button
                type="button"
                onClick={handleDownloadAllZip}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-sky-700 hover:bg-sky-800 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                Download All (.zip)
              </button>
            )}
          </div>

          {/* Recovered Files Table + Preview Pane */}
          {carvedFiles.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              <div className="lg:col-span-7 bg-white rounded-lg border border-slate-200 overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-slate-200">
                  <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-md overflow-x-auto">
                    {(['All', ...FAMILIES] as const).map((fam) => (
                      <button
                        key={fam}
                        type="button"
                        onClick={() => setFamilyFilter(fam)}
                        className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                          familyFilter === fam
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {fam}
                      </button>
                    ))}
                  </div>
                  <span className="text-xs text-slate-500 tabular-nums">
                    {filteredFiles.length} shown
                  </span>
                </div>

                <div className="overflow-x-auto max-h-[460px]">
                  <table className="w-full text-left border-collapse">
                    <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 text-xs font-medium text-slate-600">
                      <tr>
                        <th className="py-2.5 px-3">Recovered File</th>
                        <th className="py-2.5 px-3">Type</th>
                        <th className="py-2.5 px-3 text-right">Sector</th>
                        <th className="py-2.5 px-3 text-right">Size</th>
                        <th className="py-2.5 px-3 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {filteredFiles.map((file) => {
                        const isSelected = selectedFile?.id === file.id;
                        return (
                          <tr
                            key={file.id}
                            onClick={() => setSelectedFile(file)}
                            className={`cursor-pointer transition-colors ${
                              isSelected ? 'bg-sky-50/70' : 'hover:bg-slate-50'
                            }`}
                          >
                            <td className="py-2.5 px-3">
                              <div className="font-mono font-medium text-slate-900">
                                {file.recupDir}/{file.filename}
                              </div>
                              {file.metadata.details && (
                                <div className="text-slate-500 truncate max-w-[220px]">
                                  {file.metadata.details}
                                </div>
                              )}
                            </td>
                            <td className="py-2.5 px-3 uppercase font-mono text-slate-700">
                              {file.extension}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-600">
                              {file.sector.toLocaleString()}
                            </td>
                            <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-900 whitespace-nowrap">
                              {formatBytes(file.size)}
                            </td>
                            <td className="py-2.5 px-3 text-right whitespace-nowrap">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDownloadSingle(file);
                                }}
                                className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded transition-colors"
                              >
                                <Download className="w-3 h-3" />
                                Save
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Preview Inspector */}
              <div className="lg:col-span-5 space-y-4">
                {selectedFile ? (
                  <div className="bg-white rounded-lg border border-slate-200 p-5 space-y-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <Eye className="w-4 h-4 text-slate-500 shrink-0" />
                          <h3 className="text-sm font-semibold text-slate-900 font-mono truncate">
                            {selectedFile.filename}
                          </h3>
                        </div>
                        <div className="text-xs text-slate-500 mt-1 tabular-nums">
                          {selectedFile.description} · {formatBytes(selectedFile.size)} · Offset 0x
                          {selectedFile.offset.toString(16).toUpperCase()}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleDownloadSingle(selectedFile)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Download
                      </button>
                    </div>

                    {/* Visual / Audio / Text Preview */}
                    {previewUrl && selectedFile.family === 'Images' && (
                      <div className="bg-slate-100 rounded-md border border-slate-200 p-4 flex flex-col items-center justify-center min-h-[160px]">
                        <img
                          src={previewUrl}
                          alt={selectedFile.filename}
                          referrerPolicy="no-referrer"
                          className="max-h-52 object-contain rounded shadow-xs bg-white"
                        />
                        {selectedFile.metadata.width && selectedFile.metadata.height && (
                          <div className="text-xs text-slate-500 mt-2 font-mono tabular-nums">
                            {selectedFile.metadata.width} × {selectedFile.metadata.height} px
                          </div>
                        )}
                      </div>
                    )}

                    {previewUrl && selectedFile.mimeType.startsWith('audio/') && (
                      <div className="bg-slate-50 rounded-md border border-slate-200 p-4 space-y-2">
                        <div className="flex items-center gap-2 text-xs font-medium text-slate-700">
                          <Music className="w-4 h-4" />
                          Recovered Audio Playback
                        </div>
                        <audio controls src={previewUrl} className="w-full" />
                      </div>
                    )}

                    {selectedFile.extension === 'pdf' && (
                      <div className="bg-slate-50 rounded-md border border-slate-200 p-3 space-y-1.5">
                        <div className="flex items-center gap-1.5 text-xs font-medium text-slate-700">
                          <FileText className="w-3.5 h-3.5" />
                          PDF Structure Extract
                        </div>
                        <pre className="text-xs font-mono text-slate-600 overflow-x-auto max-h-40 whitespace-pre-wrap">
                          {new TextDecoder().decode(selectedFile.data.subarray(0, 600))}
                        </pre>
                      </div>
                    )}

                    <HexViewer
                      bytes={selectedFile.data}
                      baseOffset={selectedFile.offset}
                      maxBytes={256}
                      title="Carved File Header (First 256 B)"
                      highlightStart={0}
                      highlightEnd={Math.min(8, selectedFile.data.length)}
                    />
                  </div>
                ) : (
                  <div className="bg-white rounded-lg border border-slate-200 p-8 text-center text-xs text-slate-500">
                    <ImageIcon className="w-6 h-6 text-slate-400 mx-auto mb-2" />
                    Select a carved file from the table to inspect its preview and binary header.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* File Formats Modal (QPhotoRec FileOpts equivalent) */}
      {showFormatModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg border border-slate-200 w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <Filter className="w-4 h-4 text-slate-700" />
                <h3 className="text-sm font-semibold text-slate-900">
                  PhotoRec File Format Signatures
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowFormatModal(false)}
                className="p-1 text-slate-500 hover:text-slate-900 rounded"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-5 py-2.5 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setEnabledFormats(new Set(FILE_FORMATS.map((f) => f.id)))}
                  className="px-2.5 py-1 font-medium text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-100"
                >
                  Enable All
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setEnabledFormats(
                      new Set(FILE_FORMATS.filter((f) => f.enableByDefault).map((f) => f.id)),
                    )
                  }
                  className="px-2.5 py-1 font-medium text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-100"
                >
                  Reset Default
                </button>
                <button
                  type="button"
                  onClick={() => setEnabledFormats(new Set())}
                  className="px-2.5 py-1 font-medium text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-100"
                >
                  Disable All
                </button>
              </div>
              <span className="text-slate-500 tabular-nums">
                {enabledFormats.size} of {FILE_FORMATS.length} active
              </span>
            </div>

            <div className="overflow-y-auto p-5 space-y-5">
              {FAMILIES.map((family) => {
                const list = FILE_FORMATS.filter((f) => f.family === family);
                const allSelected = list.every((f) => enabledFormats.has(f.id));
                return (
                  <div key={family} className="space-y-2">
                    <div className="flex items-center justify-between border-b border-slate-100 pb-1">
                      <span className="text-xs font-semibold text-slate-800">{family}</span>
                      <button
                        type="button"
                        onClick={() => toggleFamily(family, !allSelected)}
                        className="text-xs text-sky-700 hover:underline"
                      >
                        {allSelected ? 'Uncheck family' : 'Check family'}
                      </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {list.map((fmt) => {
                        const checked = enabledFormats.has(fmt.id);
                        return (
                          <label
                            key={fmt.id}
                            className={`flex items-start gap-2.5 p-2 rounded border text-xs cursor-pointer transition-colors ${
                              checked
                                ? 'border-slate-300 bg-slate-50'
                                : 'border-slate-200 bg-white opacity-70'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleFormat(fmt.id)}
                              className="mt-0.5 rounded border-slate-300 text-slate-900 focus:ring-slate-900"
                            />
                            <div className="min-w-0">
                              <div className="font-mono font-semibold text-slate-900 uppercase">
                                .{fmt.extension}
                              </div>
                              <div className="text-slate-600 truncate">{fmt.description}</div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex justify-end">
              <button
                type="button"
                onClick={() => setShowFormatModal(false)}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md"
              >
                <Check className="w-3.5 h-3.5" />
                Apply Selection
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
