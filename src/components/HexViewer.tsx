import React, { useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface HexViewerProps {
  bytes: Uint8Array;
  baseOffset?: number;
  maxBytes?: number;
  title?: string;
  highlightStart?: number;
  highlightEnd?: number;
  onStepSector?: (delta: number) => void;
  currentLba?: number;
  maxLba?: number;
}

export const HexViewer: React.FC<HexViewerProps> = ({
  bytes,
  baseOffset = 0,
  maxBytes = 512,
  title = 'Hex & ASCII Dump',
  highlightStart,
  highlightEnd,
  onStepSector,
  currentLba,
  maxLba,
}) => {
  const slice = useMemo(() => {
    return bytes.subarray(0, Math.min(bytes.length, maxBytes));
  }, [bytes, maxBytes]);

  const rows = useMemo(() => {
    const out: {
      offset: number;
      hexBytes: { val: number; absPos: number; highlighted: boolean }[];
      asciiChars: { ch: string; highlighted: boolean }[];
    }[] = [];

    for (let i = 0; i < slice.length; i += 16) {
      const hexBytes: { val: number; absPos: number; highlighted: boolean }[] = [];
      const asciiChars: { ch: string; highlighted: boolean }[] = [];
      for (let j = 0; j < 16 && i + j < slice.length; j++) {
        const val = slice[i + j];
        const rel = i + j;
        const highlighted =
          highlightStart !== undefined &&
          highlightEnd !== undefined &&
          rel >= highlightStart &&
          rel < highlightEnd;
        hexBytes.push({ val, absPos: baseOffset + rel, highlighted });
        asciiChars.push({
          ch: val >= 32 && val <= 126 ? String.fromCharCode(val) : '.',
          highlighted,
        });
      }
      out.push({
        offset: baseOffset + i,
        hexBytes,
        asciiChars,
      });
    }
    return out;
  }, [slice, baseOffset, highlightStart, highlightEnd]);

  return (
    <div className="bg-slate-900 text-slate-100 rounded-lg border border-slate-800 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-950/60 border-b border-slate-800">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-xs font-medium text-slate-200 truncate">{title}</span>
          <span className="text-xs font-mono text-slate-400 tabular-nums whitespace-nowrap">
            0x{baseOffset.toString(16).padStart(8, '0').toUpperCase()} ({slice.length} B)
          </span>
        </div>
        {onStepSector && currentLba !== undefined && (
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => onStepSector(-1)}
              disabled={currentLba <= 0}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              Prev
            </button>
            <span className="text-xs font-mono text-slate-300 tabular-nums px-1.5">
              LBA {currentLba}
            </span>
            <button
              type="button"
              onClick={() => onStepSector(1)}
              disabled={maxLba !== undefined && currentLba >= maxLba}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
            >
              Next
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      <div className="overflow-x-auto max-h-80 p-3 font-mono text-xs leading-5 tracking-wide">
        <div className="min-w-[640px]">
          {rows.map((row) => (
            <div key={row.offset} className="flex items-center gap-4 hover:bg-slate-800/60 px-1 rounded">
              <span className="text-slate-500 select-none tabular-nums w-20 shrink-0">
                {row.offset.toString(16).padStart(8, '0')}
              </span>
              <div className="flex items-center gap-1.5 flex-1">
                {row.hexBytes.map((b, idx) => (
                  <span
                    key={idx}
                    className={`w-5 text-center tabular-nums ${
                      idx === 8 ? 'ml-1.5' : ''
                    } ${
                      b.highlighted
                        ? 'bg-sky-500/25 text-sky-300 rounded-xs font-semibold'
                        : b.val === 0
                          ? 'text-slate-600'
                          : 'text-slate-200'
                    }`}
                  >
                    {b.val.toString(16).padStart(2, '0')}
                  </span>
                ))}
              </div>
              <div className="text-slate-400 border-l border-slate-800 pl-3 select-text shrink-0 w-36">
                {row.asciiChars.map((a, idx) => (
                  <span
                    key={idx}
                    className={a.highlighted ? 'text-sky-300 font-semibold' : ''}
                  >
                    {a.ch}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
