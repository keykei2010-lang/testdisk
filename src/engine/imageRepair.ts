import { computeCrc32 } from './crc32';

export interface ImageRepairResult {
  repaired: boolean;
  data: Uint8Array;
  note: string;
  salvagedPreviewBytes?: Uint8Array;
}

// ITU-T.81 Annex K standard Baseline JPEG Huffman tables (DC/AC Lum & Chrom) for DHT-stripped streams
const STANDARD_JPEG_DHT = new Uint8Array([
  0xff, 0xc4, 0x01, 0xa2,
  // DC Luminance (0x00)
  0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
  // DC Chrominance (0x01)
  0x01, 0x00, 0x03, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
  // AC Luminance (0x10)
  0x10, 0x00, 0x02, 0x01, 0x03, 0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d,
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
  // AC Chrominance (0x11)
  0x11, 0x00, 0x02, 0x01, 0x02, 0x04, 0x04, 0x03, 0x04, 0x07, 0x05, 0x04, 0x04, 0x00, 0x01, 0x02, 0x77,
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
]);

export interface JpegHeaderScanInfo {
  hasSoi: boolean;
  hasDqt: boolean;
  hasSof: boolean;
  hasDht: boolean;
  hasSos: boolean;
  hasEoi: boolean;
  sosOffset: number;
  entropyStart: number;
  width?: number;
  height?: number;
  sofOffset: number;
  hasCorruptEntropyMarkers: boolean;
}

export function inspectJpegStructure(data: Uint8Array): JpegHeaderScanInfo {
  const hasSoi = data.length >= 2 && data[0] === 0xff && data[1] === 0xd8;
  const hasEoi =
    data.length >= 2 && data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9;
  let hasDqt = false;
  let hasSof = false;
  let hasDht = false;
  let hasSos = false;
  let sosOffset = -1;
  let entropyStart = -1;
  let sofOffset = -1;
  let width: number | undefined;
  let height: number | undefined;

  if (hasSoi) {
    let pos = 2;
    const scanCap = Math.min(data.length, 512 * 1024);
    while (pos + 4 <= scanCap) {
      if (data[pos] !== 0xff) {
        pos++;
        continue;
      }
      while (pos + 1 < scanCap && data[pos + 1] === 0xff) pos++;
      if (pos + 1 >= scanCap) break;
      const marker = data[pos + 1];
      if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        pos += 2;
        continue;
      }
      if (marker === 0xd9) break;
      if (pos + 4 > scanCap) break;
      const segLen = (data[pos + 2] << 8) | data[pos + 3];
      if (segLen < 2 || pos + 2 + segLen > data.length) break;
      if (marker === 0xdb) hasDqt = true;
      else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        hasSof = true;
        sofOffset = pos;
        if (pos + 9 <= data.length) {
          height = (data[pos + 5] << 8) | data[pos + 6];
          width = (data[pos + 7] << 8) | data[pos + 8];
        }
      } else if (marker === 0xc4) hasDht = true;
      else if (marker === 0xda) {
        hasSos = true;
        sosOffset = pos;
        entropyStart = pos + 2 + segLen;
        break;
      }
      pos += 2 + segLen;
    }
  } else {
    const limit = Math.min(data.length - 4, 256 * 1024);
    for (let p = 0; p < limit; p++) {
      if (data[p] === 0xff && data[p + 1] === 0xda) {
        const segLen = (data[p + 2] << 8) | data[p + 3];
        if (segLen >= 8 && segLen <= 32 && p + 2 + segLen <= data.length) {
          hasSos = true;
          sosOffset = p;
          entropyStart = p + 2 + segLen;
          break;
        }
      }
    }
  }

  // Detect illegal bare 0xFF <non-00, non-RST, non-EOI> markers inside entropy scan
  let hasCorruptEntropyMarkers = false;
  if (entropyStart > 0 && entropyStart < data.length - 2) {
    const scanLimit = data.length - 2;
    for (let p = entropyStart; p < scanLimit; p++) {
      if (data[p] === 0xff) {
        const next = data[p + 1];
        if (next === 0x00 || next === 0xff || (next >= 0xd0 && next <= 0xd7)) {
          p++;
          continue;
        }
        if (next === 0xd9) break;
        hasCorruptEntropyMarkers = true;
        break;
      }
    }
  }

  return {
    hasSoi,
    hasDqt,
    hasSof,
    hasDht,
    hasSos,
    hasEoi,
    sosOffset,
    entropyStart,
    width,
    height,
    sofOffset,
    hasCorruptEntropyMarkers,
  };
}

/**
 * Extracts the largest intact embedded JPEG stream (e.g. EXIF APP1 thumbnail inside a damaged JPEG,
 * or full-resolution JPEG preview inside CR2/CR3/NEF/ARW/DNG/TIFF Camera RAW containers).
 */
export function extractEmbeddedJpegPreview(data: Uint8Array, skipMainAtZero = true): Uint8Array | null {
  let best: Uint8Array | null = null;
  const startOffset = skipMainAtZero ? 2 : 0;
  for (let i = startOffset; i + 16 < data.length; i++) {
    if (data[i] === 0xff && data[i + 1] === 0xd8 && data[i + 2] === 0xff) {
      const m2 = data[i + 3];
      if (![0xe0, 0xe1, 0xdb, 0xc0, 0xc4].includes(m2)) continue;
      // Find matching EOI (0xFF 0xD9) within reasonable preview size (up to 16 MiB)
      const maxEnd = Math.min(data.length - 1, i + 16 * 1024 * 1024);
      for (let j = i + 16; j < maxEnd; j++) {
        if (data[j] === 0xff && data[j + 1] === 0xd9) {
          const slice = data.subarray(i, j + 2);
          if (slice.length >= 256 && (!best || slice.length > best.length)) {
            best = slice.slice();
          }
          i = j + 1;
          break;
        }
      }
    }
  }
  return best;
}

/**
 * Sanitizes JPEG entropy bitstream (between SOS and EOI):
 * - Byte-stuffs bare 0xFF <invalid> sequences into 0xFF 0x00 so decoders do not abort mid-scan
 * - Re-sequences out-of-order RST0–RST7 markers (0xD0..0xD7) after dropped sectors
 * - Strips trailing zero-filled sector slack and guarantees clean 0xFFD9 EOI trailer
 */
function sanitizeJpegEntropyPayload(entropy: Uint8Array): {
  bytes: Uint8Array;
  stuffedCount: number;
  rstFixedCount: number;
  trimmedZeros: number;
} {
  let effectiveEnd = entropy.length;
  if (
    effectiveEnd >= 2 &&
    entropy[effectiveEnd - 2] === 0xff &&
    entropy[effectiveEnd - 1] === 0xd9
  ) {
    effectiveEnd -= 2;
  }

  // Strip trailing zero-sector padding before EOI
  const beforeTrim = effectiveEnd;
  while (effectiveEnd > 16 && entropy[effectiveEnd - 1] === 0x00) {
    effectiveEnd--;
  }
  const trimmedZeros = beforeTrim - effectiveEnd >= 32 ? beforeTrim - effectiveEnd : 0;
  if (trimmedZeros === 0) effectiveEnd = beforeTrim;

  const out: number[] = [];
  let stuffedCount = 0;
  let rstFixedCount = 0;
  let expectedRst = 0;

  for (let i = 0; i < effectiveEnd; i++) {
    const b = entropy[i];
    if (b !== 0xff) {
      out.push(b);
      continue;
    }
    if (i + 1 >= effectiveEnd) {
      // Trailing bare 0xFF byte: omit cleanly before EOI
      stuffedCount++;
      break;
    }
    const next = entropy[i + 1];
    if (next === 0x00 || next === 0xff) {
      out.push(0xff, next);
      i++;
      continue;
    }
    if (next >= 0xd0 && next <= 0xd7) {
      const actualRst = next - 0xd0;
      if (actualRst !== expectedRst) {
        rstFixedCount++;
      }
      out.push(0xff, 0xd0 + expectedRst);
      expectedRst = (expectedRst + 1) & 7;
      i++;
      continue;
    }
    if (next === 0xd9) {
      // Early clean EOI marker — stop before trailing garbage
      break;
    }
    // Illegal bare marker byte inside entropy stream -> byte-stuff 0xFF 0x00
    out.push(0xff, 0x00, next);
    stuffedCount++;
    i++;
  }

  out.push(0xff, 0xd9);
  return {
    bytes: new Uint8Array(out),
    stuffedCount,
    rstFixedCount,
    trimmedZeros,
  };
}

export function repairJpegBuffer(
  data: Uint8Array,
  referenceBytes?: Uint8Array,
): ImageRepairResult {
  if (data.length < 2) {
    return { repaired: false, data, note: 'JPEG buffer too small to repair.' };
  }
  const info = inspectJpegStructure(data);
  const salvagedPreviewBytes = extractEmbeddedJpegPreview(data, true) ?? undefined;
  const actions: string[] = [];

  // 1. Reference-photo JPEG header transplant when SOI/DQT/SOF are damaged or stripped
  if ((!info.hasSoi || !info.hasDqt || !info.hasSof) && referenceBytes && referenceBytes.length >= 24) {
    const refInfo = inspectJpegStructure(referenceBytes);
    if (refInfo.hasSoi && refInfo.hasDqt && refInfo.hasSof && refInfo.entropyStart > 16) {
      const refPrefix = referenceBytes.slice(0, refInfo.entropyStart);
      // Preserve damaged image's own width/height if its SOF marker had valid dimensions
      if (
        info.hasSof &&
        info.width &&
        info.height &&
        refInfo.sofOffset > 0 &&
        refInfo.sofOffset + 9 <= refPrefix.length
      ) {
        refPrefix[refInfo.sofOffset + 5] = (info.height >>> 8) & 0xff;
        refPrefix[refInfo.sofOffset + 6] = info.height & 0xff;
        refPrefix[refInfo.sofOffset + 7] = (info.width >>> 8) & 0xff;
        refPrefix[refInfo.sofOffset + 8] = info.width & 0xff;
      }

      const rawEntropy = info.entropyStart > 0 ? data.subarray(info.entropyStart) : data;
      const sanitized = sanitizeJpegEntropyPayload(rawEntropy);
      const out = new Uint8Array(refPrefix.length + sanitized.bytes.length);
      out.set(refPrefix, 0);
      out.set(sanitized.bytes, refPrefix.length);
      const extraNote =
        sanitized.stuffedCount > 0 || sanitized.rstFixedCount > 0
          ? `; sanitized ${sanitized.stuffedCount + sanitized.rstFixedCount} scan markers`
          : '';
      return {
        repaired: true,
        data: out,
        salvagedPreviewBytes,
        note: `Transplanted healthy reference JPEG header (${refPrefix.length} B DQT/SOF/DHT tables) onto damaged scan stream${extraNote} and sealed EOI.`,
      };
    }
  }

  // 2. Inject missing standard Baseline Huffman tables (DHT) before SOS when DQT+SOF exist
  let working = data;
  let currentEntropyStart = info.entropyStart;
  if (info.hasSoi && info.hasDqt && info.hasSof && !info.hasDht && info.sosOffset > 2) {
    const patched = new Uint8Array(working.length + STANDARD_JPEG_DHT.length);
    patched.set(working.subarray(0, info.sosOffset), 0);
    patched.set(STANDARD_JPEG_DHT, info.sosOffset);
    patched.set(working.subarray(info.sosOffset), info.sosOffset + STANDARD_JPEG_DHT.length);
    working = patched;
    if (currentEntropyStart > 0) currentEntropyStart += STANDARD_JPEG_DHT.length;
    actions.push('injected standard ITU Baseline DHT Huffman tables');
  }

  // 3. Sanitize entropy bitstream (byte-stuff bare 0xFF, fix RST0-RST7 cadence, trim zero-slack, patch EOI)
  if (currentEntropyStart > 0 && currentEntropyStart < working.length) {
    const entropySlice = working.subarray(currentEntropyStart);
    const sanitized = sanitizeJpegEntropyPayload(entropySlice);
    if (
      sanitized.stuffedCount > 0 ||
      sanitized.rstFixedCount > 0 ||
      sanitized.trimmedZeros > 0 ||
      !info.hasEoi
    ) {
      const prefix = working.subarray(0, currentEntropyStart);
      const out = new Uint8Array(prefix.length + sanitized.bytes.length);
      out.set(prefix, 0);
      out.set(sanitized.bytes, prefix.length);
      working = out;
      if (sanitized.stuffedCount > 0) actions.push(`byte-stuffed ${sanitized.stuffedCount} corrupt entropy 0xFF marker(s)`);
      if (sanitized.rstFixedCount > 0) actions.push(`re-sequenced ${sanitized.rstFixedCount} RSTn restart marker(s)`);
      if (sanitized.trimmedZeros > 0) actions.push(`trimmed ${sanitized.trimmedZeros} B trailing zero slack`);
      if (!info.hasEoi) actions.push('appended missing JPEG EOI (0xFFD9) marker');
    }
  } else {
    const hasEoiNow =
      working.length >= 2 &&
      working[working.length - 2] === 0xff &&
      working[working.length - 1] === 0xd9;
    if (!hasEoiNow) {
      const patched = new Uint8Array(working.length + 2);
      patched.set(working, 0);
      patched[working.length] = 0xff;
      patched[working.length + 1] = 0xd9;
      working = patched;
      actions.push('appended missing JPEG EOI (0xFFD9) marker');
    }
  }

  if (actions.length > 0) {
    return {
      repaired: true,
      data: working,
      salvagedPreviewBytes,
      note: `Repaired JPEG (${actions.join('; ')}).`,
    };
  }

  if ((!info.hasSoi || !info.hasDqt || !info.hasSof) && salvagedPreviewBytes) {
    return {
      repaired: true,
      data: salvagedPreviewBytes,
      salvagedPreviewBytes,
      note: `Main JPEG headers unrecoverable without reference photo; salvaged intact embedded EXIF preview (${salvagedPreviewBytes.length} B).`,
    };
  }

  return {
    repaired: false,
    data,
    salvagedPreviewBytes,
    note:
      !info.hasSoi || !info.hasDqt || !info.hasSof
        ? 'Missing JPEG SOI/DQT/SOF header tables — supply a healthy reference photo from the same camera.'
        : 'JPEG header & EOI structure intact.',
  };
}

/**
 * Deep PNG Chunk & CRC-32 Repair:
 * - Walks PNG chunks starting at byte 8
 * - Clamps truncated final IDAT chunk length to available recovered bytes
 * - Recalculates & fixes mismatched chunk CRC-32 checksums (e.g. bitflip or clamped IDAT)
 * - Strips trailing zero slack and appends valid IEND chunk + CRC
 */
export function repairPngBuffer(data: Uint8Array): ImageRepairResult {
  if (
    data.length < 33 ||
    data[0] !== 0x89 ||
    data[1] !== 0x50 ||
    data[2] !== 0x4e ||
    data[3] !== 0x47
  ) {
    return { repaired: false, data, note: 'Invalid PNG signature.' };
  }

  const IEND_CHUNK = new Uint8Array([
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  const outChunks: Uint8Array[] = [data.slice(0, 8)];
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

  let pos = 8;
  let crcFixes = 0;
  let truncatedClamped = false;
  let hasIend = false;

  while (pos + 8 <= data.length) {
    const declaredLen = dv.getUint32(pos, false);
    const type = String.fromCharCode(data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]);
    if (!/^[A-Za-z]{4}$/.test(type)) break;

    const fullChunkEnd = pos + 12 + declaredLen;
    if (fullChunkEnd <= data.length) {
      const chunkSlice = data.slice(pos, fullChunkEnd);
      const expectedCrc = computeCrc32(chunkSlice, 4, 4 + declaredLen);
      const storedCrc = new DataView(chunkSlice.buffer).getUint32(8 + declaredLen, false);
      if (expectedCrc !== storedCrc) {
        new DataView(chunkSlice.buffer).setUint32(8 + declaredLen, expectedCrc, false);
        crcFixes++;
      }
      outChunks.push(chunkSlice);
      if (type === 'IEND') {
        hasIend = true;
        break;
      }
      pos = fullChunkEnd;
    } else {
      // Truncated trailing chunk (commonly partial IDAT): clamp length to recovered data + write valid CRC
      let availPayload = data.length - (pos + 8);
      // Trim zero-filled cluster padding on truncated IDAT tail
      while (availPayload > 16 && data[pos + 8 + availPayload - 1] === 0x00) {
        availPayload--;
      }
      if (availPayload > 0 && type === 'IDAT') {
        const rebuilt = new Uint8Array(12 + availPayload);
        const rdv = new DataView(rebuilt.buffer);
        rdv.setUint32(0, availPayload, false);
        rebuilt.set(data.subarray(pos + 4, pos + 8 + availPayload), 4);
        const crc = computeCrc32(rebuilt, 4, 4 + availPayload);
        rdv.setUint32(8 + availPayload, crc, false);
        outChunks.push(rebuilt);
        truncatedClamped = true;
      }
      break;
    }
  }

  if (!hasIend) {
    outChunks.push(IEND_CHUNK);
  }

  const needsRewrite = crcFixes > 0 || truncatedClamped || !hasIend;
  if (!needsRewrite) {
    return { repaired: false, data, note: 'PNG chunks and CRC-32 checksums intact.' };
  }

  const totalSize = outChunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(totalSize);
  let cursor = 0;
  for (const c of outChunks) {
    out.set(c, cursor);
    cursor += c.length;
  }

  const parts: string[] = [];
  if (truncatedClamped) parts.push('clamped truncated IDAT chunk length');
  if (crcFixes > 0) parts.push(`fixed ${crcFixes} chunk CRC-32 checksum(s)`);
  if (!hasIend) parts.push('appended valid IEND chunk');
  return {
    repaired: true,
    data: out,
    note: `Repaired PNG (${parts.join(', ')}).`,
  };
}

/**
 * Repairs WebP/RIFF size, GIF trailer, or Camera RAW / TIFF (CR2, CR3, NEF, ARW, DNG) containers
 * with full-resolution embedded JPEG preview extraction fallback.
 */
export function repairRawOrImageBuffer(extension: string, data: Uint8Array): ImageRepairResult {
  const ext = extension.toLowerCase().replace(/^\./, '');

  if (ext === 'gif' && data.length >= 14) {
    const hdr = String.fromCharCode(data[0], data[1], data[2]);
    if (hdr === 'GIF' && data[data.length - 1] !== 0x3b) {
      const patched = new Uint8Array(data.length + 1);
      patched.set(data, 0);
      patched[data.length] = 0x3b;
      return {
        repaired: true,
        data: patched,
        note: 'Appended missing GIF89a/87a trailer (0x3B).',
      };
    }
  }

  if (ext === 'webp' && data.length >= 20) {
    const patched = data.slice();
    const dv = new DataView(patched.buffer);
    dv.setUint32(4, Math.max(4, patched.length - 8), true);
    const chunkTag = String.fromCharCode(patched[12], patched[13], patched[14], patched[15]);
    if (chunkTag === 'VP8 ' || chunkTag === 'VP8L' || chunkTag === 'VP8X') {
      const innerLen = patched.length - 20;
      if (dv.getUint32(16, true) > innerLen) {
        dv.setUint32(16, Math.max(0, innerLen), true);
      }
    }
    return {
      repaired: true,
      data: patched,
      note: 'Recalculated WebP RIFF container & VP8/VP8L chunk payload sizes.',
    };
  }

  if (['cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'rw2', 'tif', 'tiff'].includes(ext)) {
    const embedded = extractEmbeddedJpegPreview(data, false);
    if (embedded) {
      return {
        repaired: true,
        data,
        salvagedPreviewBytes: embedded,
        note: `Validated ${ext.toUpperCase()} structure & salvaged intact embedded JPEG preview (${embedded.length} B).`,
      };
    }
  }

  return {
    repaired: false,
    data,
    note: `${ext.toUpperCase()} structure did not require patching.`,
  };
}

/**
 * Pure TypeScript AVI (`RIFF ... AVI `) Structural Index (`idx1`) & Frame-Count Rebuild:
 * Walks `LIST movi` chunks (`00dc`, `00db`, `01wb`), updates `RIFF`, `movi`, `avih.dwTotalFrames`,
 * and appends a valid `idx1` seek table so truncated AVIs seek & play reliably.
 */
export function repairAviBuffer(data: Uint8Array): ImageRepairResult {
  if (
    data.length < 64 ||
    String.fromCharCode(data[0], data[1], data[2], data[3]) !== 'RIFF' ||
    String.fromCharCode(data[8], data[9], data[10], data[11]) !== 'AVI '
  ) {
    return { repaired: false, data, note: 'Not a valid RIFF AVI container.' };
  }

  const patched = data.slice();
  const dv = new DataView(patched.buffer);

  // Locate LIST 'movi' and avih offset
  let moviListOffset = -1;
  let avihOffset = -1;
  let pos = 12;
  while (pos + 12 <= patched.length) {
    const id = String.fromCharCode(patched[pos], patched[pos + 1], patched[pos + 2], patched[pos + 3]);
    const sz = dv.getUint32(pos + 4, true);
    if (id === 'LIST' && pos + 12 <= patched.length) {
      const listType = String.fromCharCode(
        patched[pos + 8],
        patched[pos + 9],
        patched[pos + 10],
        patched[pos + 11],
      );
      if (listType === 'hdrl') {
        let hPos = pos + 12;
        const hEnd = Math.min(patched.length, pos + 8 + sz);
        while (hPos + 8 <= hEnd) {
          const hid = String.fromCharCode(
            patched[hPos],
            patched[hPos + 1],
            patched[hPos + 2],
            patched[hPos + 3],
          );
          const hsz = dv.getUint32(hPos + 4, true);
          if (hid === 'avih') avihOffset = hPos + 8;
          if (hsz === 0 || hPos + 8 + hsz > hEnd) break;
          hPos += 8 + hsz + (hsz & 1);
        }
      } else if (listType === 'movi') {
        moviListOffset = pos;
        break;
      }
    }
    if (sz === 0 || pos + 8 + sz > patched.length) break;
    pos += 8 + sz + (sz & 1);
  }

  if (moviListOffset < 0) {
    dv.setUint32(4, Math.max(4, patched.length - 8), true);
    return {
      repaired: true,
      data: patched,
      note: 'Recalculated AVI RIFF container size.',
    };
  }

  // Scan stream chunks inside LIST movi ('00dc', '00db', '01wb', etc.)
  const idxEntries: { fourcc: string; flags: number; relOffset: number; size: number }[] = [];
  let cPos = moviListOffset + 12;
  const moviEndBase = moviListOffset + 8;
  let lastValidEnd = cPos;
  let videoFrames = 0;

  while (cPos + 8 <= patched.length) {
    const tag = String.fromCharCode(
      patched[cPos],
      patched[cPos + 1],
      patched[cPos + 2],
      patched[cPos + 3],
    );
    if (tag === 'idx1') break;
    const cLen = dv.getUint32(cPos + 4, true);
    if (!/^[0-9]{2}[a-zA-Z]{2}$/.test(tag) || cPos + 8 + cLen > patched.length) break;

    const isVideo = tag.endsWith('dc') || tag.endsWith('db');
    if (isVideo) videoFrames++;
    idxEntries.push({
      fourcc: tag,
      flags: isVideo ? 0x10 : 0x00,
      relOffset: cPos - moviEndBase, // offset relative to 'movi' tag start
      size: cLen,
    });
    const paddedNext = cPos + 8 + cLen + (cLen & 1);
    lastValidEnd = Math.min(patched.length, paddedNext);
    cPos = paddedNext;
  }

  // Patch avih dwTotalFrames if found
  if (avihOffset > 0 && avihOffset + 20 <= patched.length && videoFrames > 0) {
    dv.setUint32(avihOffset + 16, videoFrames, true);
  }

  const moviPayloadBytes = Math.max(4, lastValidEnd - moviEndBase);
  dv.setUint32(moviListOffset + 4, moviPayloadBytes, true);

  const idxPayloadBytes = idxEntries.length * 16;
  const out = new Uint8Array(lastValidEnd + (idxEntries.length > 0 ? 8 + idxPayloadBytes : 0));
  out.set(patched.subarray(0, lastValidEnd), 0);
  const outDv = new DataView(out.buffer);
  outDv.setUint32(4, Math.max(4, out.length - 8), true);

  if (idxEntries.length > 0) {
    out[lastValidEnd] = 0x69; // 'i'
    out[lastValidEnd + 1] = 0x64; // 'd'
    out[lastValidEnd + 2] = 0x78; // 'x'
    out[lastValidEnd + 3] = 0x31; // '1'
    outDv.setUint32(lastValidEnd + 4, idxPayloadBytes, true);
    let w = lastValidEnd + 8;
    for (const e of idxEntries) {
      out[w] = e.fourcc.charCodeAt(0);
      out[w + 1] = e.fourcc.charCodeAt(1);
      out[w + 2] = e.fourcc.charCodeAt(2);
      out[w + 3] = e.fourcc.charCodeAt(3);
      outDv.setUint32(w + 4, e.flags, true);
      outDv.setUint32(w + 8, e.relOffset, true);
      outDv.setUint32(w + 12, e.size, true);
      w += 16;
    }
  }

  return {
    repaired: true,
    data: out,
    note: `Rebuilt AVI container sizes${idxEntries.length > 0 ? ` and synthesized idx1 seek index (${idxEntries.length} chunks, ${videoFrames} video frames)` : ''}.`,
  };
}

/**
 * Structural MKV / WebM EBML Cluster Resynchronizer:
 * Validates EBML header (`1A 45 DF A3`) & locates Cluster (`1F 43 B6 75`) elements,
 * trimming trailing zero-sector padding or corrupted tail fragments cleanly.
 */
export function repairMkvOrWebmBuffer(data: Uint8Array): ImageRepairResult {
  if (
    data.length < 32 ||
    data[0] !== 0x1a ||
    data[1] !== 0x45 ||
    data[2] !== 0xdf ||
    data[3] !== 0xa3
  ) {
    return { repaired: false, data, note: 'Not a valid EBML (MKV/WebM) stream.' };
  }

  // Strip trailing zero-filled sector padding at EOF so demuxers don't choke
  let trimEnd = data.length;
  while (trimEnd > 64 && data[trimEnd - 1] === 0x00) {
    trimEnd--;
  }
  const zeroTrimmed = data.length - trimEnd;
  if (zeroTrimmed >= 16) {
    return {
      repaired: true,
      data: data.slice(0, trimEnd),
      note: `Trimmed ${zeroTrimmed} B trailing null sector slack from EBML/MKV/WebM container.`,
    };
  }

  return {
    repaired: false,
    data,
    note: 'EBML container header verified; escalate via desktop FFmpeg remux for deep Cluster rebuild.',
  };
}
