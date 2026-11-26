import React from 'react';
import { Wrench, X } from 'lucide-react';
import { PartitionEntry } from '../engine/partitions';

interface LostPartitionsModalProps {
  lostPartitions: PartitionEntry[];
  canRestoreMbr?: boolean;
  restoreDisabledReason?: string;
  onInspectLostPartition: (partition: PartitionEntry) => void;
  onRestoreToMbr: (partition: PartitionEntry) => void;
  onClose: () => void;
}

export const LostPartitionsModal: React.FC<LostPartitionsModalProps> = ({
  lostPartitions,
  canRestoreMbr = true,
  restoreDisabledReason,
  onInspectLostPartition,
  onRestoreToMbr,
  onClose,
}) => {
  if (lostPartitions.length === 0) return null;
  const primaryLost = lostPartitions[0];

  return (
    <div
      className="fixed inset-0 z-50 bg-black/65 flex items-center justify-center p-4 animate-backdrop-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lost-partitions-title"
    >
      <div className="w-full max-w-[440px] rounded-lg bg-[#222630] border border-[#343A48] shadow-2xl overflow-hidden animate-modal-in relative">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 text-slate-400 hover:text-white p-1 rounded transition-colors"
          aria-label="Close lost partitions dialog"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="px-6 pt-7 pb-6 text-center space-y-4">
          <div className="space-y-1.5">
            <h3 id="lost-partitions-title" className="text-base font-semibold text-slate-100">
              Lost partitions found...
            </h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Detected {lostPartitions.length} unmapped filesystem
              {lostPartitions.length > 1 ? 's' : ''} (
              {lostPartitions.map((p) => p.detectedFs?.filesystem ?? p.typeName).join(', ')}). We
              recommend checking and recovering your found data.
            </p>
          </div>

          <div className="mx-auto w-60 rounded-lg bg-[#181B22] border border-[#2D3342] p-4 shadow-inner">
            <div className="space-y-2.5">
              <div className="flex items-center gap-2">
                <span className="w-3.5 h-3.5 rounded-sm bg-[#3A7AFE] inline-flex items-center justify-center text-[9px] text-white font-bold">
                  ✓
                </span>
                <span className="w-4 h-3 rounded-xs bg-sky-400/80 inline-block" />
                <span className="h-2.5 flex-1 rounded bg-[#2D3342]" />
              </div>
              <div className="pl-4 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="w-3.5 h-3.5 rounded-sm bg-[#3A7AFE] inline-flex items-center justify-center text-[9px] text-white font-bold">
                    ✓
                  </span>
                  <span className="w-4 h-3 rounded-xs bg-[#4C8DFF] inline-block" />
                  <span className="h-2 w-24 rounded bg-[#2A303E]" />
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-3.5 h-3.5 rounded-sm bg-[#3A7AFE] inline-flex items-center justify-center text-[9px] text-white font-bold">
                    ✓
                  </span>
                  <span className="w-4 h-3 rounded-xs bg-amber-400/90 inline-block" />
                  <span className="h-2 w-20 rounded bg-[#2A303E]" />
                </div>
              </div>
            </div>
          </div>

          <div className="pt-1 flex flex-col items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-8 py-2 rounded-md text-xs font-medium bg-[#3A7AFE] hover:bg-[#2F6EEB] text-white transition-colors"
            >
              Got it
            </button>
            <div className="flex items-center gap-3 text-[11px]">
              <button
                type="button"
                onClick={() => {
                  onInspectLostPartition(primaryLost);
                  onClose();
                }}
                className="text-slate-300 hover:text-white hover:underline"
              >
                Inspect in Path View
              </button>
              {canRestoreMbr ? (
                <>
                  <span className="text-slate-600">·</span>
                  <button
                    type="button"
                    onClick={() => {
                      onRestoreToMbr(primaryLost);
                      onClose();
                    }}
                    className="inline-flex items-center gap-1 text-[#60A5FA] hover:underline"
                  >
                    <Wrench className="w-3 h-3" />
                    Restore Partition to MBR
                  </button>
                </>
              ) : restoreDisabledReason ? (
                <span className="text-slate-500" title={restoreDisabledReason}>
                  · {restoreDisabledReason}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
