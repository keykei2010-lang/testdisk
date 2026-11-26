export interface RecycleBinMeta {
  version: number;
  originalSize: number;
  deletedAtMs?: number;
  originalPath: string;
  originalName: string;
}

const WINDOWS_EPOCH_DIFF_MS = 11644473600000;

function filetimeToUnixMs(lo: number, hi: number): number | undefined {
  const ticks = hi * 4294967296 + lo;
  if (ticks <= 0) return undefined;
  const ms = Math.floor(ticks / 10000 - WINDOWS_EPOCH_DIFF_MS);
  return ms > 0 ? ms : undefined;
}

function readUtf16LeNullTerm(bytes: Uint8Array, start: number, maxBytes: number): string {
  let out = '';
  const end = Math.min(bytes.length, start + maxBytes);
  for (let i = start; i + 1 < end; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}

/**
 * Parses a Windows Vista/7/10/11 $Recycle.Bin $Ixxxxxx metadata file.
 */
export function parseWindowsRecycleIFile(bytes: Uint8Array): RecycleBinMeta | null {
  if (bytes.length < 28) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const verLo = dv.getUint32(0, true);
  const verHi = dv.getUint32(4, true);
  if (verHi !== 0 || (verLo !== 1 && verLo !== 2)) return null;

  const sizeLo = dv.getUint32(8, true);
  const sizeHi = dv.getUint32(12, true);
  const originalSize = sizeHi * 4294967296 + sizeLo;

  const ftLo = dv.getUint32(16, true);
  const ftHi = dv.getUint32(20, true);
  const deletedAtMs = filetimeToUnixMs(ftLo, ftHi);

  const originalPath =
    verLo === 1
      ? readUtf16LeNullTerm(bytes, 24, 520)
      : readUtf16LeNullTerm(bytes, 28, Math.min(2048, dv.getUint32(24, true) * 2));

  if (!originalPath) return null;
  const parts = originalPath.split(/[\\/]/);
  const originalName = parts[parts.length - 1] || originalPath;

  return {
    version: verLo,
    originalSize,
    deletedAtMs,
    originalPath,
    originalName,
  };
}
