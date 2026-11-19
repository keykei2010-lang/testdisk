import React, { useRef, useState } from 'react';
import {
  CheckCircle2,
  Download,
  FileSearch,
  HelpCircle,
  Upload,
  AlertTriangle,
} from 'lucide-react';
import { IdentifyResult, identifyBuffer } from '../engine/signatures';
import { buildSampleUnknownFiles } from '../engine/sampleDisk';
import { formatBytes } from '../engine/crc32';
import { HexViewer } from './HexViewer';

interface IdentifiedItem {
  id: string;
  originalName: string;
  bytes: Uint8Array;
  result: IdentifyResult | null;
}

export const FileIdentifier: React.FC = () => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<IdentifiedItem[]>(() => {
    return buildSampleUnknownFiles().map((s, idx) => ({
      id: `sample-${idx}`,
      originalName: s.name,
      bytes: s.bytes,
      result: identifyBuffer(s.bytes),
    }));
  });
  const [selectedId, setSelectedId] = useState<string>('sample-0');

  const handleFilesSelected = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const added: IdentifiedItem[] = [];
    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i];
      const buf = new Uint8Array(await f.arrayBuffer());
      added.push({
        id: `${Date.now()}-${i}-${f.name}`,
        originalName: f.name,
        bytes: buf,
        result: identifyBuffer(buf),
      });
    }
    setItems((prev) => [...added, ...prev]);
    if (added[0]) setSelectedId(added[0].id);
  };

  const handleLoadSamples = () => {
    const samples = buildSampleUnknownFiles().map((s, idx) => ({
      id: `sample-${Date.now()}-${idx}`,
      originalName: s.name,
      bytes: s.bytes,
      result: identifyBuffer(s.bytes),
    }));
    setItems(samples);
    setSelectedId(samples[0].id);
  };

  const handleDownloadCorrected = (item: IdentifiedItem) => {
    if (!item.result) return;
    const base = item.originalName.replace(/\.[^.]+$/, '');
    const newName = `${base}.${item.result.extension}`;
    const blob = new Blob([item.bytes.slice().buffer], { type: item.result.mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = newName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const selected = items.find((i) => i.id === selectedId) ?? items[0] ?? null;

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-lg border border-slate-200 p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            fidentify Binary Signature Analyzer
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Identify true file types, validate structural sizes (--check), and restore missing extensions for unknown files.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={handleLoadSamples}
            className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap"
          >
            Load Sample Files
          </button>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap"
          >
            <Upload className="w-3.5 h-3.5" />
            Inspect Local Files
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              void handleFilesSelected(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-7 bg-white rounded-lg border border-slate-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">Analyzed Files</h3>
            <span className="text-xs text-slate-500 tabular-nums">{items.length} items</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs font-medium text-slate-600">
                  <th className="py-2.5 px-4">Filename</th>
                  <th className="py-2.5 px-3">Detected Format</th>
                  <th className="py-2.5 px-3 text-right">Actual Size</th>
                  <th className="py-2.5 px-3 text-right">Calculated Size</th>
                  <th className="py-2.5 px-4 text-right">Export</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {items.map((item) => {
                  const isSel = selected?.id === item.id;
                  const res = item.result;
                  const sizeMismatch =
                    res && res.calculatedSize !== null && res.calculatedSize !== item.bytes.length;
                  return (
                    <tr
                      key={item.id}
                      onClick={() => setSelectedId(item.id)}
                      className={`cursor-pointer transition-colors ${
                        isSel ? 'bg-sky-50/70' : 'hover:bg-slate-50'
                      }`}
                    >
                      <td className="py-2.5 px-4 font-mono text-slate-900 font-medium">
                        {item.originalName}
                      </td>
                      <td className="py-2.5 px-3">
                        {res ? (
                          <div className="flex items-center gap-1.5">
                            {res.status === 'OK_TRUNCATED' ? (
                              <AlertTriangle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                            ) : (
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                            )}
                            <span className="font-mono font-semibold text-slate-900 uppercase">
                              .{res.extension}
                            </span>
                            <span className="text-slate-500 truncate max-w-[140px]">
                              {res.family}
                            </span>
                          </div>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-slate-500">
                            <HelpCircle className="w-3.5 h-3.5 shrink-0" />
                            unknown
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
                        {formatBytes(item.bytes.length)}
                      </td>
                      <td
                        className={`py-2.5 px-3 text-right font-mono tabular-nums ${
                          sizeMismatch ? 'text-amber-700 font-medium' : 'text-slate-700'
                        }`}
                      >
                        {res?.calculatedSize ? formatBytes(res.calculatedSize) : '—'}
                      </td>
                      <td className="py-2.5 px-4 text-right whitespace-nowrap">
                        {res ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDownloadCorrected(item);
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded transition-colors"
                          >
                            <Download className="w-3 h-3" />
                            .{res.extension}
                          </button>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="lg:col-span-5 space-y-4">
          {selected ? (
            <div className="bg-white rounded-lg border border-slate-200 p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <FileSearch className="w-4 h-4 text-slate-600 shrink-0" />
                  <h3 className="text-sm font-semibold text-slate-900 font-mono truncate">
                    {selected.originalName}
                  </h3>
                </div>
                {selected.result && (
                  <span className="text-xs font-mono font-semibold text-sky-700 whitespace-nowrap">
                    .{selected.result.extension}
                  </span>
                )}
              </div>

              {selected.result ? (
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between py-1.5 border-b border-slate-100">
                    <span className="text-slate-500">Description</span>
                    <span className="text-slate-900 font-medium text-right">
                      {selected.result.description}
                    </span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-100">
                    <span className="text-slate-500">MIME Type</span>
                    <span className="font-mono text-slate-900">{selected.result.mimeType}</span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-100">
                    <span className="text-slate-500">Signature Match</span>
                    <span className="font-mono text-slate-900 tabular-nums">
                      Offset +{selected.result.matchedOffset} ({selected.result.matchedLength} B)
                    </span>
                  </div>
                  <div className="flex justify-between py-1.5 border-b border-slate-100">
                    <span className="text-slate-500">Validation Status</span>
                    <span className="font-medium text-slate-900">{selected.result.status}</span>
                  </div>
                  {selected.result.metadata.details && (
                    <div className="flex justify-between py-1.5 border-b border-slate-100">
                      <span className="text-slate-500">Extracted Metadata</span>
                      <span className="text-slate-900 text-right">
                        {selected.result.metadata.details}
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs text-slate-500">
                  No known PhotoRec magic signature matched this file header. Inspect the raw hex bytes below.
                </p>
              )}

              <HexViewer
                bytes={selected.bytes}
                baseOffset={0}
                maxBytes={256}
                title="Header Signature Highlight"
                highlightStart={selected.result?.matchedOffset ?? 0}
                highlightEnd={
                  selected.result
                    ? selected.result.matchedOffset + selected.result.matchedLength
                    : 0
                }
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
