export interface UsnJournalEntry {
  usn: number;
  recordNumber: number;
  parentRecord: number;
  filename: string;
  reconstructedPath: string;
  timestampMs?: number;
  reasonFlags: number;
  isDirectory: boolean;
  isDelete: boolean;
}

const WINDOWS_EPOCH_DIFF_MS = 11644473600000;

export const USN_REASON_FILE_DELETE = 0x00000200;
export const USN_REASON_RENAME_OLD_NAME = 0x00001000;
export const USN_REASON_CLOSE = 0x80000000;

function filetimeToUnixMs(dv: DataView, pos: number): number | undefined {
  if (pos + 8 > dv.byteLength) return undefined;
  const lo = dv.getUint32(pos, true);
  const hi = dv.getUint32(pos + 4, true);
  const ticks = hi * 4294967296 + lo;
  if (ticks <= 0) return undefined;
  const ms = Math.floor(ticks / 10000 - WINDOWS_EPOCH_DIFF_MS);
  return ms > 0 ? ms : undefined;
}

function decodeUtf16Le(buf: Uint8Array, pos: number, byteLen: number): string {
  const charCount = Math.floor(byteLen / 2);
  let out = '';
  for (let i = 0; i < charCount && pos + i * 2 + 1 < buf.length; i++) {
    const code = buf[pos + i * 2] | (buf[pos + i * 2 + 1] << 8);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}

function buildPathFromDirMap(
  partId: string,
  parentRecord: number,
  filename: string,
  dirMap?: Map<string, { parentRecord: number; name: string }>,
): string {
  if (!dirMap || dirMap.size === 0) return `\\$UsnJrnl\\${filename}`;
  const segments = [filename];
  const visited = new Set<number>();
  let cur = parentRecord;
  let guard = 0;
  while (cur > 5 && !visited.has(cur) && guard < 32) {
    visited.add(cur);
    const node = dirMap.get(`${partId}:${cur}`);
    if (!node || !node.name || node.name === '.') break;
    segments.unshift(node.name);
    if (node.parentRecord === cur) break;
    cur = node.parentRecord;
    guard++;
  }
  return `\\${segments.join('\\')}`;
}

/**
 * Parses NTFS $UsnJrnl:$J (USN_RECORD_V2 and USN_RECORD_V3) change journal buffers
 * to recover recently deleted filenames, timestamps, MFT record references, and original paths.
 */
export function parseUsnJournalBuffer(
  buf: Uint8Array,
  options?: {
    dirMap?: Map<string, { parentRecord: number; name: string }>;
    partId?: string;
    onlyDeletes?: boolean;
    maxEntries?: number;
  },
): UsnJournalEntry[] {
  const dirMap = options?.dirMap;
  const partId = options?.partId ?? 'part-0';
  const onlyDeletes = options?.onlyDeletes ?? true;
  const maxEntries = options?.maxEntries ?? 5000;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: UsnJournalEntry[] = [];
  const seen = new Set<string>();

  let pos = 0;
  while (pos + 60 <= buf.length && out.length < maxEntries) {
    const recLen = dv.getUint32(pos, true);
    if (recLen === 0) {
      // Zero-padded gap at page boundary; advance 8 bytes until next valid record
      pos += 8;
      continue;
    }

    const majorVer = dv.getUint16(pos + 4, true);
    const minorVer = dv.getUint16(pos + 6, true);
    if (
      recLen < 60 ||
      recLen > 2048 ||
      pos + recLen > buf.length ||
      minorVer !== 0 ||
      (majorVer !== 2 && majorVer !== 3)
    ) {
      pos += 8;
      continue;
    }

    let fileRef: number;
    let parentRef: number;
    let usn: number;
    let tsMs: number | undefined;
    let reason: number;
    let fileAttrs: number;
    let fnLen: number;
    let fnOff: number;

    if (majorVer === 2) {
      fileRef = dv.getUint32(pos + 8, true) + (dv.getUint16(pos + 12, true) * 4294967296);
      parentRef = dv.getUint32(pos + 16, true) + (dv.getUint16(pos + 20, true) * 4294967296);
      usn = dv.getUint32(pos + 24, true) + dv.getUint32(pos + 28, true) * 4294967296;
      tsMs = filetimeToUnixMs(dv, pos + 32);
      reason = dv.getUint32(pos + 40, true);
      fileAttrs = dv.getUint32(pos + 52, true);
      fnLen = dv.getUint16(pos + 56, true);
      fnOff = dv.getUint16(pos + 58, true);
    } else {
      // USN_RECORD_V3 (128-bit MFT FRNs: lowest 6 bytes in first uint64 store record index)
      if (recLen < 76) {
        pos += 8;
        continue;
      }
      fileRef = dv.getUint32(pos + 8, true) + (dv.getUint16(pos + 12, true) * 4294967296);
      parentRef = dv.getUint32(pos + 24, true) + (dv.getUint16(pos + 28, true) * 4294967296);
      usn = dv.getUint32(pos + 40, true) + dv.getUint32(pos + 44, true) * 4294967296;
      tsMs = filetimeToUnixMs(dv, pos + 48);
      reason = dv.getUint32(pos + 56, true);
      fileAttrs = dv.getUint32(pos + 68, true);
      fnLen = dv.getUint16(pos + 72, true);
      fnOff = dv.getUint16(pos + 74, true);
    }

    if (fnLen > 0 && fnOff >= 56 && pos + fnOff + fnLen <= pos + recLen) {
      const isDir = (fileAttrs & 0x10) !== 0;
      const isDelete = (reason & (USN_REASON_FILE_DELETE | USN_REASON_RENAME_OLD_NAME)) !== 0;
      if (!onlyDeletes || isDelete) {
        const filename = decodeUtf16Le(buf, pos + fnOff, fnLen);
        const isRecycleName = /^\$[RI][A-Za-z0-9]{4,}/i.test(filename);
        if (filename && (!filename.startsWith('$') || isRecycleName) && !isDir) {
          const dedupeKey = `${fileRef}:${filename}`;
          if (!seen.has(dedupeKey)) {
            seen.add(dedupeKey);
            out.push({
              usn,
              recordNumber: fileRef,
              parentRecord: parentRef,
              filename,
              reconstructedPath: buildPathFromDirMap(partId, parentRef, filename, dirMap),
              timestampMs: tsMs,
              reasonFlags: reason,
              isDirectory: isDir,
              isDelete,
            });
          }
        }
      }
    }

    // USN records are 8-byte aligned
    pos += (recLen + 7) & ~7;
  }

  return out;
}
