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
      hexBytes: { val: number; highlighted: boolean }[];
      asciiChars: { ch: string; highlighted: boolean }[];
    }[] = [];

    for (let i = 0; i < slice.length; i += 16) {
      const hexBytes: { val: number; highlighted: boolean }[] = [];
      const asciiChars: { ch: string; highlighted: boolean }[] = [];
      for (let j = 0; j < 16 && i + j < slice.length; j++) {
        const val = slice[i + j];
        const rel = i + j;
        const highlighted =
          highlightStart !== undefined &&
          highlightEnd !== undefined &&
          rel >= highlightStart &&
          rel < highlightEnd;
        hexBytes.push({ val, highlighted });
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
    <div className="bg-[#11151C] text-slate-200 rounded-md border border-[#2A3446] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-[#141922] border-b border-[#2A3446] gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-slate-200 truncate">{title}</span>
          <span className="text-[11px] font-mono text-slate-400 tabular-nums whitespace-nowrap">
            0x{baseOffset.toString(16).padStart(6, '0').toUpperCase()}
          </span>
        </div>
        {onStepSector && currentLba !== undefined && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => onStepSector(-1)}
              disabled={currentLba <= 0}
              className="inline-flex items-center p-1 text-xs rounded bg-[#1F2735] text-slate-200 hover:bg-[#283244] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label="Previous sector"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="text-[11px] font-mono text-slate-300 tabular-nums px-1">
              LBA {currentLba}
            </span>
            <button
              type="button"
              onClick={() => onStepSector(1)}
              disabled={maxLba !== undefined && currentLba >= maxLba}
              className="inline-flex items-center p-1 text-xs rounded bg-[#1F2735] text-slate-200 hover:bg-[#283244] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              aria-label="Next sector"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      <div className="overflow-x-auto max-h-56 p-2.5 font-mono text-[11px] leading-5">
        <div className="min-w-[460px]">
          {rows.map((row) => (
            <div key={row.offset} className="flex items-center gap-2.5 hover:bg-[#1F2735]/70 px-1 rounded">
              <span className="text-slate-500 select-none tabular-nums w-16 shrink-0">
                {row.offset.toString(16).padStart(6, '0')}
              </span>
              <div className="flex items-center gap-1 flex-1">
                {row.hexBytes.map((b, idx) => (
                  <span
                    key={idx}
                    className={`w-4 text-center tabular-nums ${
                      idx === 8 ? 'ml-1' : ''
                    } ${
                      b.highlighted
                        ? 'bg-[#2E7CF6]/30 text-[#60A5FA] rounded-xs font-semibold'
                        : b.val === 0
                          ? 'text-slate-600'
                          : 'text-slate-300'
                    }`}
                  >
                    {b.val.toString(16).padStart(2, '0')}
                  </span>
                ))}
              </div>
              <div className="text-slate-400 border-l border-[#2A3446] pl-2 select-text shrink-0 w-28">
                {row.asciiChars.map((a, idx) => (
                  <span
                    key={idx}
                    className={a.highlighted ? 'text-[#60A5FA] font-semibold' : ''}
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
