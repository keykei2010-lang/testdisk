export interface ExifExtractResult {
  camera?: string;
  takenAtMs?: number;
  orientation?: number;
}

function readU16(buf: Uint8Array, pos: number, le: boolean): number {
  if (pos + 2 > buf.length) return 0;
  return le ? (buf[pos] | (buf[pos + 1] << 8)) >>> 0 : ((buf[pos] << 8) | buf[pos + 1]) >>> 0;
}

function readU32(buf: Uint8Array, pos: number, le: boolean): number {
  if (pos + 4 > buf.length) return 0;
  return le
    ? (buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24)) >>> 0
    : ((buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]) >>> 0;
}

function readAsciiZ(buf: Uint8Array, start: number, maxLen: number): string {
  let s = '';
  const end = Math.min(buf.length, start + maxLen);
  for (let i = start; i < end; i++) {
    const ch = buf[i];
    if (ch === 0) break;
    if (ch >= 0x20 && ch <= 0x7e) s += String.fromCharCode(ch);
  }
  return s.trim();
}

function parseExifDateString(str: string): number | undefined {
  // Format: "YYYY:MM:DD HH:MM:SS"
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(str.trim());
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const min = Number(m[5]);
  const sec = Number(m[6]);
  if (year < 1990 || year > 2100 || month < 0 || month > 11 || day < 1 || day > 31) {
    return undefined;
  }
  const ms = Date.UTC(year, month, day, hour, min, sec);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Parses an APP1 EXIF segment payload (starting right after segment length, or full JPEG buffer).
 */
export function parseExifFromJpeg(buf: Uint8Array, start = 0, maxEnd = buf.length): ExifExtractResult | null {
  // Locate APP1 ("Exif\0\0") within first 64 KB of JPEG
  const limit = Math.min(buf.length, maxEnd, start + 65536);
  let tiffBase = -1;

  for (let i = start + 2; i + 12 < limit; i++) {
    if (
      buf[i] === 0xff &&
      buf[i + 1] === 0xe1 &&
      buf[i + 4] === 0x45 &&
      buf[i + 5] === 0x78 &&
      buf[i + 6] === 0x69 &&
      buf[i + 7] === 0x66 &&
      buf[i + 8] === 0x00 &&
      buf[i + 9] === 0x00
    ) {
      tiffBase = i + 10;
      break;
    }
  }

  if (tiffBase === -1 || tiffBase + 8 >= limit) return null;

  const endian0 = buf[tiffBase];
  const endian1 = buf[tiffBase + 1];
  if (!((endian0 === 0x49 && endian1 === 0x49) || (endian0 === 0x4d && endian1 === 0x4d))) {
    return null;
  }
  const le = endian0 === 0x49;
  if (readU16(buf, tiffBase + 2, le) !== 42) return null;

  const ifd0Rel = readU32(buf, tiffBase + 4, le);
  const ifd0Pos = tiffBase + ifd0Rel;
  if (ifd0Pos + 2 > limit) return null;

  let make = '';
  let model = '';
  let orientation: number | undefined;
  let exifIfdRel = 0;
  let dateStr = '';

  const readIfd = (ifdPos: number, isExifSub: boolean) => {
    if (ifdPos + 2 > limit) return;
    const count = Math.min(128, readU16(buf, ifdPos, le));
    for (let idx = 0; idx < count; idx++) {
      const entryPos = ifdPos + 2 + idx * 12;
      if (entryPos + 12 > limit) break;
      const tag = readU16(buf, entryPos, le);
      const type = readU16(buf, entryPos + 2, le);
      const numValues = readU32(buf, entryPos + 4, le);
      const valOffsetField = entryPos + 8;

      if (!isExifSub) {
        if (tag === 0x010f && type === 2 && numValues > 0 && numValues <= 64) {
          const ptr = numValues <= 4 ? valOffsetField : tiffBase + readU32(buf, valOffsetField, le);
          if (ptr >= tiffBase && ptr + numValues <= limit) make = readAsciiZ(buf, ptr, numValues);
        } else if (tag === 0x0110 && type === 2 && numValues > 0 && numValues <= 64) {
          const ptr = numValues <= 4 ? valOffsetField : tiffBase + readU32(buf, valOffsetField, le);
          if (ptr >= tiffBase && ptr + numValues <= limit) model = readAsciiZ(buf, ptr, numValues);
        } else if (tag === 0x0112 && type === 3) {
          orientation = readU16(buf, valOffsetField, le);
        } else if (tag === 0x8769) {
          exifIfdRel = readU32(buf, valOffsetField, le);
        } else if (tag === 0x0132 && type === 2 && numValues >= 19 && !dateStr) {
          const ptr = tiffBase + readU32(buf, valOffsetField, le);
          if (ptr >= tiffBase && ptr + 19 <= limit) dateStr = readAsciiZ(buf, ptr, numValues);
        }
      } else {
        if ((tag === 0x9003 || tag === 0x9004) && type === 2 && numValues >= 19) {
          const ptr = tiffBase + readU32(buf, valOffsetField, le);
          if (ptr >= tiffBase && ptr + 19 <= limit) {
            const candidate = readAsciiZ(buf, ptr, numValues);
            if (!dateStr || tag === 0x9003) dateStr = candidate;
          }
        }
      }
    }
  };

  readIfd(ifd0Pos, false);
  if (exifIfdRel > 0 && tiffBase + exifIfdRel + 2 <= limit) {
    readIfd(tiffBase + exifIfdRel, true);
  }

  const camera =
    make && model
      ? model.toLowerCase().startsWith(make.toLowerCase())
        ? model
        : `${make} ${model}`
      : model || make || undefined;

  const takenAtMs = dateStr ? parseExifDateString(dateStr) : undefined;
  if (!camera && !takenAtMs && orientation === undefined) return null;
  return { camera, takenAtMs, orientation };
}
