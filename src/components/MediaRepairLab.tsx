import React, { useEffect, useRef, useState } from 'react';
import {
  Archive,
  CheckCircle2,
  Download,
  FileCode,
  FileQuestion,
  FileText,
  Film,
  Image as ImageIcon,
  Music,
  Play,
  Trash2,
  Upload,
  Wrench,
} from 'lucide-react';
import { formatBytes } from '../engine/crc32';
import { getDesktopBridge } from '../engine/desktopBridge';
import {
  diagnoseMediaFile,
  repairFileBuffer,
  resolvePreferredExtension,
} from '../engine/recoveryHealth';
import { identifyBuffer } from '../engine/signatures';

interface MediaRepairLabProps {
  onOpenUnknownFiles: () => void;
}

interface RepairQueueItem {
  id: string;
  file: File;
  nativePath?: string;
  extension: string;
  size: number;
  diagnosis: string;
  needsReferenceHint: boolean;
  status: 'queued' | 'repairing' | 'repaired' | 'unchanged' | 'failed';
  tierLabel?: string;
  resultNote?: string;
  repairedBytes?: Uint8Array;
  repairedSize?: number;
  salvagedPreviewBytes?: Uint8Array;
  previewUrl?: string;
  previewIsVideo?: boolean;
  previewFailed?: boolean;
}

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif']);
const RAW_EXTS = new Set(['cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'rw2', 'tif', 'tiff', 'psd', 'psb']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v', '3gp', 'avi', 'mkv', 'webm']);
const AUDIO_EXTS = new Set(['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac', 'opus']);
const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'apk', 'jar', 'rpa']);
const CODE_EXTS = new Set(['json', 'xml', 'svg', 'html', 'htm', 'aep', 'aepx', 'rpy', 'py', 'sql', 'ini']);
const DOC_EXTS = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub', 'doc', 'xls', 'ppt', 'msg', 'msi', 'pub', 'pst', 'ost', 'sqlite', 'db', 'sqlite3', 'txt', 'csv', 'eml', 'rtf', 'kra', 'ora', 'kmz']);

function mimeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    case 'gif':
      return 'image/gif';
    case 'svg':
      return 'image/svg+xml';
    case 'mp4':
    case 'm4v':
    case '3gp':
      return 'video/mp4';
    case 'mov':
      return 'video/quicktime';
    case 'avi':
      return 'video/x-msvideo';
    case 'mkv':
      return 'video/x-matroska';
    case 'webm':
      return 'video/webm';
    case 'wav':
      return 'audio/wav';
    case 'mp3':
      return 'audio/mpeg';
    case 'flac':
      return 'audio/flac';
    case 'pdf':
      return 'application/pdf';
    case 'json':
      return 'application/json';
    case 'xml':
    case 'aepx':
      return 'application/xml';
    case 'html':
    case 'htm':
      return 'text/html';
    case 'txt':
    case 'rpy':
    case 'py':
    case 'csv':
    case 'sql':
    case 'ini':
      return 'text/plain';
    case 'rtf':
      return 'application/rtf';
    case 'zip':
    case 'docx':
    case 'xlsx':
    case 'pptx':
    case 'apk':
    case 'jar':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}

export const MediaRepairLab: React.FC<MediaRepairLabProps> = ({ onOpenUnknownFiles }) => {
  const desktop = getDesktopBridge();
  const [items, setItems] = useState<RepairQueueItem[]>([]);
  const [refFile, setRefFile] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [allowTranscode, setAllowTranscode] = useState<boolean>(true);
  const [runningBatch, setRunningBatch] = useState<boolean>(false);
  const [dragOver, setDragOver] = useState<boolean>(false);
  const mediaInputRef = useRef<HTMLInputElement | null>(null);
  const createdUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    const urls = createdUrlsRef.current;
    return () => {
      for (const u of urls) {
        if (u.startsWith('blob:')) URL.revokeObjectURL(u);
      }
    };
  }, []);

  const ingestFiles = async (fileList: FileList | File[]) => {
    const list = Array.from(fileList);
    if (list.length === 0) return;

    const staged: RepairQueueItem[] = [];
    for (const file of list) {
      const headSize = Math.min(file.size, 4 * 1024 * 1024);
      const head = new Uint8Array(await file.slice(0, headSize).arrayBuffer());
      const sig = identifyBuffer(head);
      const fileExt = (file.name.split('.').pop() || '').toLowerCase();
      const detectedExt = sig?.extension?.toLowerCase();
      const keepFilenameContainerExt =
        fileExt &&
        ((detectedExt === 'zip' && DOC_EXTS.has(fileExt)) ||
          (detectedExt === 'zip' && ARCHIVE_EXTS.has(fileExt)) ||
          (detectedExt === 'doc' && ['xls', 'ppt', 'msg', 'msi', 'pub', 'db'].includes(fileExt)) ||
          (detectedExt === 'pst' && fileExt === 'ost') ||
          (detectedExt === 'sqlite' && (fileExt === 'db' || fileExt === 'sqlite3')) ||
          (detectedExt === 'xml' && ['svg', 'aepx', 'html', 'htm'].includes(fileExt)) ||
          (detectedExt === 'txt' && (CODE_EXTS.has(fileExt) || DOC_EXTS.has(fileExt))) ||
          !detectedExt ||
          detectedExt === 'bin');
      const ext = (keepFilenameContainerExt ? fileExt : detectedExt || fileExt || 'mp4').toLowerCase();
      const diag = diagnoseMediaFile(ext, head);
      const nativePath =
        desktop?.getPathForFile?.(file) ?? (file as File & { path?: string }).path;

      staged.push({
        id: `mrl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        file,
        nativePath,
        extension: ext,
        size: file.size,
        diagnosis: diag.issue,
        needsReferenceHint: diag.needsReferenceHint,
        status: 'queued',
      });
    }
    setItems((prev) => [...staged, ...prev]);
  };

  const repairOneItem = async (item: RepairQueueItem) => {
    setItems((prev) =>
      prev.map((x) => (x.id === item.id ? { ...x, status: 'repairing', resultNote: undefined } : x)),
    );

    try {
      const refBytes = refFile?.bytes;
      if (desktop) {
        const useBuffer = !item.nativePath && item.file.size <= 192 * 1024 * 1024;
        const srcBuf = useBuffer ? new Uint8Array(await item.file.arrayBuffer()) : undefined;
        const res = await desktop.repairMediaFile({
          filename: item.file.name,
          extension: item.extension,
          filePath: item.nativePath,
          buffer: srcBuf,
          referenceBuffer: refBytes,
          allowTranscodeFallback: allowTranscode,
        });

        if (res.ok || res.salvagedPreviewBytes) {
          let previewUrl = res.previewDataUrl;
          let previewIsVideo = false;
          if (!previewUrl && res.repairedBytes && (IMAGE_EXTS.has(item.extension) || VIDEO_EXTS.has(item.extension))) {
            const blobUrl = URL.createObjectURL(
              new Blob([res.repairedBytes.slice().buffer], { type: mimeForExt(item.extension) }),
            );
            createdUrlsRef.current.push(blobUrl);
            previewUrl = blobUrl;
            previewIsVideo = VIDEO_EXTS.has(item.extension);
          } else if (!previewUrl && res.salvagedPreviewBytes) {
            const blobUrl = URL.createObjectURL(
              new Blob([res.salvagedPreviewBytes.slice().buffer], { type: 'image/jpeg' }),
            );
            createdUrlsRef.current.push(blobUrl);
            previewUrl = blobUrl;
          }
          setItems((prev) =>
            prev.map((x) =>
              x.id === item.id
                ? {
                    ...x,
                    status: 'repaired',
                    tierLabel: res.ok ? res.tier : 'exif-preview',
                    resultNote: res.note,
                    repairedBytes: res.repairedBytes,
                    repairedSize: res.repairedSize || res.salvagedPreviewBytes?.length,
                    salvagedPreviewBytes: res.salvagedPreviewBytes,
                    previewUrl,
                    previewIsVideo,
                    previewFailed: false,
                  }
                : x,
            ),
          );
          return;
        }

        if (item.nativePath || item.file.size > 256 * 1024 * 1024) {
          setItems((prev) =>
            prev.map((x) =>
              x.id === item.id
                ? {
                    ...x,
                    status: res.tier === 'none' ? 'unchanged' : 'failed',
                    resultNote: res.note,
                  }
                : x,
            ),
          );
          return;
        }
      }

      // Pure-TypeScript browser fallback (full buffer up to 256 MiB)
      if (item.file.size > 256 * 1024 * 1024) {
        setItems((prev) =>
          prev.map((x) =>
            x.id === item.id
              ? {
                  ...x,
                  status: 'failed',
                  resultNote: 'File exceeds 256 MiB browser limit — run the Windows desktop app (.exe) for multi-GB streaming & FFmpeg repair.',
                }
              : x,
          ),
        );
        return;
      }

      const raw = new Uint8Array(await item.file.arrayBuffer());
      const rep = repairFileBuffer(item.extension, raw, refBytes);
      if (!rep.repaired && !rep.salvagedPreviewBytes) {
        setItems((prev) =>
          prev.map((x) =>
            x.id === item.id
              ? {
                  ...x,
                  status: 'unchanged',
                  resultNote: rep.note,
                }
              : x,
          ),
        );
        return;
      }

      let previewUrl: string | undefined;
      let previewIsVideo = false;
      if (rep.repaired && (IMAGE_EXTS.has(item.extension) || VIDEO_EXTS.has(item.extension))) {
        previewUrl = URL.createObjectURL(
          new Blob([rep.data.slice().buffer], { type: mimeForExt(item.extension) }),
        );
        createdUrlsRef.current.push(previewUrl);
        previewIsVideo = VIDEO_EXTS.has(item.extension);
      } else if (rep.salvagedPreviewBytes) {
        previewUrl = URL.createObjectURL(
          new Blob([rep.salvagedPreviewBytes.slice().buffer], { type: 'image/jpeg' }),
        );
        createdUrlsRef.current.push(previewUrl);
      }

      setItems((prev) =>
        prev.map((x) =>
          x.id === item.id
            ? {
                ...x,
                status: 'repaired',
                tierLabel: rep.repaired ? 'structural-ts' : 'exif-preview',
                resultNote: rep.note,
                repairedBytes: rep.repaired ? rep.data : undefined,
                repairedSize: rep.repaired ? rep.data.length : rep.salvagedPreviewBytes?.length,
                salvagedPreviewBytes: rep.salvagedPreviewBytes,
                previewUrl,
                previewIsVideo,
                previewFailed: false,
              }
            : x,
        ),
      );
    } catch (err) {
      setItems((prev) =>
        prev.map((x) =>
          x.id === item.id
            ? {
                ...x,
                status: 'failed',
                resultNote: err instanceof Error ? err.message : 'Unexpected repair failure',
              }
            : x,
        ),
      );
    }
  };

  const handleRepairAll = async () => {
    const queue = items.filter((i) => i.status === 'queued' || i.status === 'failed' || i.status === 'unchanged');
    if (queue.length === 0) return;
    setRunningBatch(true);
    try {
      for (const item of queue) {
        await repairOneItem(item);
      }
    } finally {
      setRunningBatch(false);
    }
  };

  const handleSaveItem = async (item: RepairQueueItem) => {
    const preferred = resolvePreferredExtension(item.file.name, item.extension);
    const outName = preferred.replace(/(\.[^.]+)?$/, '_repaired$1');

    if (item.repairedBytes) {
      const blob = new Blob([item.repairedBytes.slice().buffer], {
        type: mimeForExt(item.extension),
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = outName;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }

    if (desktop && item.nativePath) {
      const res = await desktop.repairMediaFile({
        filename: item.file.name,
        extension: item.extension,
        filePath: item.nativePath,
        referenceBuffer: refFile?.bytes,
        allowTranscodeFallback: allowTranscode,
        saveWithDialog: true,
      });
      if (res && !res.canceled) {
        if (!res.ok) {
          setItems((prev) =>
            prev.map((x) =>
              x.id === item.id
                ? {
                    ...x,
                    status:
                      res.tier === 'exif-preview' && x.salvagedPreviewBytes ? 'repaired' : 'failed',
                    resultNote: res.error || res.note || 'Unable to save repaired file.',
                  }
                : x,
            ),
          );
        } else if (res.outputPath) {
          setItems((prev) =>
            prev.map((x) =>
              x.id === item.id
                ? { ...x, resultNote: `${res.note} · Saved to ${res.outputPath}` }
                : x,
            ),
          );
        }
      }
    }
  };

  const handleSavePreviewJpeg = (item: RepairQueueItem) => {
    if (!item.salvagedPreviewBytes) return;
    const stem = item.file.name.replace(/\.[^.]+$/, '');
    const blob = new Blob([item.salvagedPreviewBytes.slice().buffer], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${stem}_preview.jpg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const pendingCount = items.filter(
    (i) => i.status === 'queued' || i.status === 'failed' || i.status === 'unchanged',
  ).length;
  const repairedCount = items.filter((i) => i.status === 'repaired').length;

  return (
    <div className="max-w-4xl space-y-5">
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
        <div className="space-y-1 min-w-0 flex-1">
          <h1 className="text-[17px] font-semibold text-slate-100 tracking-tight">
            Media &amp; Document Repair Lab
          </h1>
          <p className="text-xs text-slate-400 leading-relaxed max-w-xl">
            Rebuild unplayable MP4/MOV/HEVC videos missing <code className="text-slate-300">moov</code> atoms,
            fix JPEG/PNG/AVI/RAW previews, and structurally repair Office (<code className="text-slate-300">.docx/.xlsx/.pptx</code>),{' '}
            <code className="text-slate-300">.pdf</code>, <code className="text-slate-300">.psd/.aep/.aepx</code>, SQLite, Outlook{' '}
            <code className="text-slate-300">.pst/.msg</code>, Ren&apos;Py (<code className="text-slate-300">.rpa/.rpy</code>), and ZIP archives.
          </p>
        </div>

        <button
          type="button"
          onClick={onOpenUnknownFiles}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#232834] hover:bg-[#2B3140] border border-[#323A4B] text-xs font-medium text-slate-200 whitespace-nowrap shrink-0 transition-colors"
        >
          <FileQuestion className="w-3.5 h-3.5 text-emerald-400" />
          Identify Extensionless Files (fidentify)
        </button>
      </div>

      {/* Drop / Add Files + Reference Sample Strip */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length > 0) {
            void ingestFiles(e.dataTransfer.files);
          }
        }}
        className={`rounded-md border border-dashed p-6 transition-colors text-center space-y-3 ${
          dragOver
            ? 'border-[#3A7AFE] bg-[#1E2534]'
            : 'border-[#343B4D] bg-[#181B22]'
        }`}
      >
        <input
          ref={mediaInputRef}
          type="file"
          multiple
          accept=".mp4,.mov,.m4v,.3gp,.avi,.mkv,.webm,.jpg,.jpeg,.png,.webp,.bmp,.gif,.cr2,.cr3,.nef,.arw,.dng,.orf,.rw2,.tif,.tiff,.wav,.mp3,.flac,.pdf,.docx,.xlsx,.pptx,.odt,.ods,.odp,.epub,.zip,.apk,.jar,.kra,.ora,.kmz,.psd,.psb,.aep,.aepx,.sqlite,.db,.sqlite3,.doc,.xls,.ppt,.msg,.pst,.ost,.rpa,.rpy,.json,.xml,.svg,.html,.tar,.gz,*"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void ingestFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <div className="w-10 h-10 rounded-md bg-[#222836] border border-[#323A4E] flex items-center justify-center mx-auto">
          <Upload className="w-4 h-4 text-[#4C8DFF]" />
        </div>
        <div className="space-y-1">
          <div className="text-xs font-medium text-slate-100">
            Drop corrupted videos, photos, documents, projects, or databases here
          </div>
          <div className="text-[11px] text-slate-400 font-mono">
            MP4 · MOV · MKV · AVI · JPG · PNG · CR2/NEF · DOCX · XLSX · PDF · PSD · AEP · SQLITE · PST · RPA · RPY · ZIP
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
          <button
            type="button"
            onClick={() => mediaInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-[#3A7AFE] hover:bg-[#2F6EEB] text-xs font-medium text-white whitespace-nowrap shrink-0 transition-colors"
          >
            Add Damaged Files
          </button>

          <label className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md bg-[#232834] hover:bg-[#2C3242] border border-[#343C4E] text-xs text-slate-200 cursor-pointer whitespace-nowrap shrink-0 transition-colors">
            <Wrench className="w-3.5 h-3.5 text-[#60A5FA]" />
            <span>
              {refFile ? `Reference: ${refFile.name}` : 'Optional Reference Video / Photo'}
            </span>
            <input
              type="file"
              accept=".mp4,.mov,.m4v,.3gp,.jpg,.jpeg"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const slice = new Uint8Array(await f.slice(0, 8 * 1024 * 1024).arrayBuffer());
                setRefFile({ name: f.name, bytes: slice });
                e.target.value = '';
              }}
            />
          </label>

          {refFile && (
            <button
              type="button"
              onClick={() => setRefFile(null)}
              className="text-[11px] text-slate-400 hover:text-slate-200 underline whitespace-nowrap shrink-0"
            >
              Clear reference
            </button>
          )}
        </div>
      </div>

      {/* Repair Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 rounded-md bg-[#181B22] border border-[#2B303C]">
        <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={allowTranscode}
            onChange={(e) => setAllowTranscode(e.target.checked)}
            className="accent-[#3A7AFE]"
          />
          <span>
            Enable FFmpeg salvage re-encode fallback (desktop .exe when lossless remux fails)
          </span>
        </label>

        <div className="flex items-center gap-2.5 shrink-0">
          {items.length > 0 && (
            <button
              type="button"
              onClick={() => {
                for (const u of createdUrlsRef.current) {
                  if (u.startsWith('blob:')) URL.revokeObjectURL(u);
                }
                createdUrlsRef.current = [];
                setItems([]);
              }}
              disabled={runningBatch}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded text-xs text-slate-400 hover:text-slate-200 disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear Queue
            </button>
          )}
          <button
            type="button"
            disabled={runningBatch || pendingCount === 0}
            onClick={() => void handleRepairAll()}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-[#3A7AFE] hover:bg-[#2F6EEB] disabled:opacity-40 text-xs font-medium text-white whitespace-nowrap shrink-0 transition-colors"
          >
            <Play className="w-3.5 h-3.5" />
            {runningBatch
              ? 'Repairing...'
              : pendingCount > 0
                ? `Repair ${pendingCount} File${pendingCount === 1 ? '' : 's'}`
                : repairedCount > 0
                  ? `${repairedCount} Repaired`
                  : 'Repair Queue Empty'}
          </button>
        </div>
      </div>

      {/* Queue List */}
      {items.length > 0 && (
        <div className="rounded-md border border-[#2B303C] bg-[#181B22] divide-y divide-[#252A36]">
          {items.map((item) => {
            const isImg = IMAGE_EXTS.has(item.extension) || RAW_EXTS.has(item.extension);
            const isVid = VIDEO_EXTS.has(item.extension);
            return (
              <div
                key={item.id}
                className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  <div className="w-16 h-12 rounded bg-[#12151B] border border-[#2A303D] flex items-center justify-center overflow-hidden shrink-0">
                    {item.previewUrl && !item.previewFailed && item.previewIsVideo ? (
                      <video
                        src={item.previewUrl}
                        muted
                        onError={() =>
                          setItems((prev) =>
                            prev.map((x) => (x.id === item.id ? { ...x, previewFailed: true } : x)),
                          )
                        }
                        className="w-full h-full object-cover"
                      />
                    ) : item.previewUrl && !item.previewFailed ? (
                      <img
                        src={item.previewUrl}
                        alt={item.file.name}
                        onError={() =>
                          setItems((prev) =>
                            prev.map((x) => (x.id === item.id ? { ...x, previewFailed: true } : x)),
                          )
                        }
                        className="w-full h-full object-cover"
                      />
                    ) : isVid ? (
                      <Film className="w-5 h-5 text-[#60A5FA]" />
                    ) : isImg ? (
                      <ImageIcon className="w-5 h-5 text-amber-400" />
                    ) : AUDIO_EXTS.has(item.extension) ? (
                      <Music className="w-5 h-5 text-violet-400" />
                    ) : ARCHIVE_EXTS.has(item.extension) ? (
                      <Archive className="w-5 h-5 text-amber-300" />
                    ) : CODE_EXTS.has(item.extension) ? (
                      <FileCode className="w-5 h-5 text-emerald-400" />
                    ) : DOC_EXTS.has(item.extension) ? (
                      <FileText className="w-5 h-5 text-sky-400" />
                    ) : (
                      <Wrench className="w-5 h-5 text-slate-400" />
                    )}
                  </div>

                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-medium text-slate-100 truncate max-w-[260px]">
                        {item.file.name}
                      </span>
                      <span className="text-slate-500">·</span>
                      <span className="font-mono text-slate-400 uppercase tabular-nums">
                        {item.extension}
                      </span>
                      <span className="text-slate-500">·</span>
                      <span className="font-mono text-slate-400 tabular-nums">
                        {formatBytes(item.repairedSize ?? item.size)}
                      </span>
                      {item.tierLabel && (
                        <>
                          <span className="text-slate-500">·</span>
                          <span className="font-mono text-[11px] text-emerald-400">
                            {item.tierLabel}
                          </span>
                        </>
                      )}
                    </div>

                    <div
                      className={`text-[11px] leading-snug ${
                        item.status === 'repaired'
                          ? 'text-emerald-300'
                          : item.status === 'failed'
                            ? 'text-rose-300'
                            : 'text-slate-400'
                      }`}
                    >
                      {item.resultNote || item.diagnosis}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                  {item.salvagedPreviewBytes && (
                    <button
                      type="button"
                      onClick={() => handleSavePreviewJpeg(item)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#232834] hover:bg-[#2C3242] border border-[#3A4358] text-xs font-medium text-amber-200 whitespace-nowrap shrink-0 transition-colors"
                    >
                      <Download className="w-3.5 h-3.5 text-amber-300" />
                      Save Preview JPEG
                    </button>
                  )}
                  {item.status === 'repaired' &&
                  (item.repairedBytes ||
                    (desktop && item.nativePath && item.tierLabel !== 'exif-preview')) ? (
                    <button
                      type="button"
                      onClick={() => void handleSaveItem(item)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/40 text-xs font-medium text-emerald-200 whitespace-nowrap shrink-0 transition-colors"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <Download className="w-3.5 h-3.5" />
                      Save Repaired
                    </button>
                  ) : item.status !== 'repaired' ? (
                    <button
                      type="button"
                      disabled={item.status === 'repairing'}
                      onClick={() => void repairOneItem(item)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#262C39] hover:bg-[#31394B] border border-[#363F54] text-xs font-medium text-slate-200 disabled:opacity-45 whitespace-nowrap shrink-0 transition-colors"
                    >
                      <Wrench className="w-3.5 h-3.5 text-[#60A5FA]" />
                      {item.status === 'repairing' ? 'Repairing...' : 'Repair Now'}
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
