import React from 'react';
import { Check, SlidersHorizontal, X } from 'lucide-react';
import { FILE_FORMATS, FileFamily } from '../engine/signatures';
import {
  GroupByKey,
  RecoveryLikelihoodTier,
  SortDir,
  SortKey,
} from '../engine/explorerTypes';

interface FilterPopoverProps {
  blockSize: number;
  paranoid: boolean;
  keepCorrupted: boolean;
  enabledFormats: Set<string>;
  statusFilter: 'all' | 'ok' | 'truncated';
  likelihoodFilter: 'all' | RecoveryLikelihoodTier;
  sizeFilter: 'all' | 'small' | 'medium' | 'large';
  hideDuplicates: boolean;
  sortKey: SortKey;
  sortDir: SortDir;
  groupBy: GroupByKey;
  onChangeBlockSize: (size: number) => void;
  onChangeParanoid: (val: boolean) => void;
  onChangeKeepCorrupted: (val: boolean) => void;
  onChangeEnabledFormats: (next: Set<string>) => void;
  onChangeStatusFilter: (val: 'all' | 'ok' | 'truncated') => void;
  onChangeLikelihoodFilter: (val: 'all' | RecoveryLikelihoodTier) => void;
  onChangeSizeFilter: (val: 'all' | 'small' | 'medium' | 'large') => void;
  onChangeHideDuplicates: (val: boolean) => void;
  onChangeSortKey: (val: SortKey) => void;
  onChangeSortDir: (val: SortDir) => void;
  onChangeGroupBy: (val: GroupByKey) => void;
  onApplyAndRescan: () => void;
  onClose: () => void;
}

const FAMILIES: FileFamily[] = ['Pictures', 'Videos', 'Documents', 'Audio', 'Archives', 'Others'];

export const FilterPopover: React.FC<FilterPopoverProps> = ({
  blockSize,
  paranoid,
  keepCorrupted,
  enabledFormats,
  statusFilter,
  likelihoodFilter,
  sizeFilter,
  hideDuplicates,
  sortKey,
  sortDir,
  groupBy,
  onChangeBlockSize,
  onChangeParanoid,
  onChangeKeepCorrupted,
  onChangeEnabledFormats,
  onChangeStatusFilter,
  onChangeLikelihoodFilter,
  onChangeSizeFilter,
  onChangeHideDuplicates,
  onChangeSortKey,
  onChangeSortDir,
  onChangeGroupBy,
  onApplyAndRescan,
  onClose,
}) => {
  const toggleFormat = (id: string) => {
    const next = new Set(enabledFormats);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChangeEnabledFormats(next);
  };

  const toggleFamily = (family: FileFamily, enable: boolean) => {
    const next = new Set(enabledFormats);
    for (const f of FILE_FORMATS) {
      if (f.family === family) {
        if (enable) next.add(f.id);
        else next.delete(f.id);
      }
    }
    onChangeEnabledFormats(next);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/65 flex items-center justify-center p-4 animate-backdrop-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="filter-modal-title"
    >
      <div className="w-full max-w-2xl max-h-[86vh] flex flex-col rounded-lg bg-[#222630] border border-[#343A48] shadow-2xl overflow-hidden animate-modal-in">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#2E3340]">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-[#4C8DFF]" />
            <h3 id="filter-modal-title" className="text-sm font-semibold text-slate-100">
              Filter, Sort &amp; Scan Options
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-100 p-1 rounded"
            aria-label="Close filters"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto p-5 space-y-5 text-xs">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-[#181B22] p-4 rounded-md border border-[#2C313E]">
            <div>
              <label className="block font-medium text-slate-300 mb-1.5">Sort By</label>
              <div className="flex gap-2">
                <select
                  value={sortKey}
                  onChange={(e) => onChangeSortKey(e.target.value as SortKey)}
                  className="flex-1 px-3 py-1.5 rounded bg-[#222630] border border-[#343A48] text-slate-100"
                >
                  <option value="name">Name</option>
                  <option value="date">Date Modified</option>
                  <option value="type">File Type</option>
                  <option value="size">File Size</option>
                  <option value="likelihood">Recovery Health</option>
                  <option value="origin">Origin / Partition</option>
                </select>
                <select
                  value={sortDir}
                  onChange={(e) => onChangeSortDir(e.target.value as SortDir)}
                  className="px-2.5 py-1.5 rounded bg-[#222630] border border-[#343A48] text-slate-100"
                >
                  <option value="asc">Asc ↑</option>
                  <option value="desc">Desc ↓</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block font-medium text-slate-300 mb-1.5">Group Files By</label>
              <select
                value={groupBy}
                onChange={(e) => onChangeGroupBy(e.target.value as GroupByKey)}
                className="w-full px-3 py-1.5 rounded bg-[#222630] border border-[#343A48] text-slate-100"
              >
                <option value="none">None (Flat List)</option>
                <option value="likelihood">Recovery Health Tier</option>
                <option value="type">File Type</option>
                <option value="origin">Origin / Partition</option>
                <option value="date">Date Modified</option>
              </select>
            </div>

            <div>
              <label className="block font-medium text-slate-300 mb-1.5">
                Sector / Block Alignment
              </label>
              <select
                value={blockSize}
                onChange={(e) => onChangeBlockSize(Number(e.target.value))}
                className="w-full px-3 py-1.5 rounded bg-[#222630] border border-[#343A48] text-slate-100"
              >
                <option value={512}>512 bytes (Standard Sector)</option>
                <option value={1024}>1024 bytes (1 KiB Block)</option>
                <option value={4096}>4096 bytes (4 KiB Cluster)</option>
              </select>
            </div>

            <div>
              <label className="block font-medium text-slate-300 mb-1.5">
                Visible File Integrity
              </label>
              <select
                value={statusFilter}
                onChange={(e) =>
                  onChangeStatusFilter(e.target.value as 'all' | 'ok' | 'truncated')
                }
                className="w-full px-3 py-1.5 rounded bg-[#222630] border border-[#343A48] text-slate-100"
              >
                <option value="all">All Carved Files</option>
                <option value="ok">Intact Files Only</option>
                <option value="truncated">Truncated / Repairable Only</option>
              </select>
            </div>

            <div>
              <label className="block font-medium text-slate-300 mb-1.5">
                Recovery Health Tier
              </label>
              <select
                value={likelihoodFilter}
                onChange={(e) =>
                  onChangeLikelihoodFilter(e.target.value as 'all' | RecoveryLikelihoodTier)
                }
                className="w-full px-3 py-1.5 rounded bg-[#222630] border border-[#343A48] text-slate-100"
              >
                <option value="all">All Health Tiers</option>
                <option value="high">High (85–100%)</option>
                <option value="medium">Fair (50–84%)</option>
                <option value="low">Low (&lt; 50%)</option>
              </select>
            </div>

            <div>
              <label className="block font-medium text-slate-300 mb-1.5">
                File Size Range
              </label>
              <select
                value={sizeFilter}
                onChange={(e) =>
                  onChangeSizeFilter(e.target.value as 'all' | 'small' | 'medium' | 'large')
                }
                className="w-full px-3 py-1.5 rounded bg-[#222630] border border-[#343A48] text-slate-100"
              >
                <option value="all">Any File Size</option>
                <option value="small">Small (&lt; 2 KB)</option>
                <option value="medium">Medium (2 KB – 100 KB)</option>
                <option value="large">Large (&gt; 100 KB)</option>
              </select>
            </div>

            <label className="inline-flex items-center gap-2 text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={paranoid}
                onChange={(e) => onChangeParanoid(e.target.checked)}
                className="rounded border-slate-600 bg-[#16181F] accent-[#3A7AFE]"
              />
              Paranoid validation (verify structural footers)
            </label>

            <label className="inline-flex items-center gap-2 text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={keepCorrupted}
                onChange={(e) => onChangeKeepCorrupted(e.target.checked)}
                className="rounded border-slate-600 bg-[#16181F] accent-[#3A7AFE]"
              />
              Keep corrupted / truncated files
            </label>

            <label className="inline-flex items-center gap-2 text-slate-300 cursor-pointer sm:col-span-2">
              <input
                type="checkbox"
                checked={hideDuplicates}
                onChange={(e) => onChangeHideDuplicates(e.target.checked)}
                className="rounded border-slate-600 bg-[#16181F] accent-[#3A7AFE]"
              />
              Hide duplicate files (deduplicate by byte size + CRC32 fingerprint)
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onChangeEnabledFormats(new Set(FILE_FORMATS.map((f) => f.id)))}
                className="px-2.5 py-1 rounded bg-[#2B303C] border border-[#343A48] text-slate-200 hover:bg-[#343B49]"
              >
                Enable All
              </button>
              <button
                type="button"
                onClick={() =>
                  onChangeEnabledFormats(
                    new Set(FILE_FORMATS.filter((f) => f.enableByDefault).map((f) => f.id)),
                  )
                }
                className="px-2.5 py-1 rounded bg-[#2B303C] border border-[#343A48] text-slate-200 hover:bg-[#343B49]"
              >
                Reset Default
              </button>
              <button
                type="button"
                onClick={() => onChangeEnabledFormats(new Set())}
                className="px-2.5 py-1 rounded bg-[#2B303C] border border-[#343A48] text-slate-200 hover:bg-[#343B49]"
              >
                Disable All
              </button>
            </div>
            <span className="text-slate-400 tabular-nums">
              {enabledFormats.size} of {FILE_FORMATS.length} formats active
            </span>
          </div>

          <div className="space-y-4">
            {FAMILIES.map((family) => {
              const list = FILE_FORMATS.filter((f) => f.family === family);
              const allSelected = list.every((f) => enabledFormats.has(f.id));
              return (
                <div key={family} className="space-y-2">
                  <div className="flex items-center justify-between border-b border-[#2E3340] pb-1">
                    <span className="font-semibold text-slate-200">{family}</span>
                    <button
                      type="button"
                      onClick={() => toggleFamily(family, !allSelected)}
                      className="text-[#4C8DFF] hover:underline"
                    >
                      {allSelected ? 'Uncheck all' : 'Check all'}
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {list.map((fmt) => {
                      const checked = enabledFormats.has(fmt.id);
                      return (
                        <label
                          key={fmt.id}
                          className={`flex items-start gap-2.5 p-2 rounded border cursor-pointer transition-colors ${
                            checked
                              ? 'border-[#3E4C66] bg-[#262B36]'
                              : 'border-[#2C313E] bg-[#181B22] opacity-65'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleFormat(fmt.id)}
                            className="mt-0.5 rounded border-slate-600 bg-[#16181F] accent-[#3A7AFE]"
                          />
                          <div className="min-w-0">
                            <div className="font-mono font-semibold text-slate-100 uppercase">
                              .{fmt.extension}
                            </div>
                            <div className="text-slate-400 truncate">{fmt.description}</div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="px-5 py-3.5 border-t border-[#2E3340] bg-[#181B22] flex justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium text-slate-300 bg-[#2B303C] hover:bg-[#343B49] rounded-md"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              onApplyAndRescan();
              onClose();
            }}
            disabled={enabledFormats.size === 0}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white bg-[#3A7AFE] hover:bg-[#2F6EEB] disabled:opacity-40 rounded-md"
          >
            <Check className="w-3.5 h-3.5" />
            Apply &amp; Re-scan
          </button>
        </div>
      </div>
    </div>
  );
};
