import { parseExifFromJpeg } from './exif';

export type FileFamily = 'Pictures' | 'Videos' | 'Documents' | 'Audio' | 'Archives' | 'Others';

export interface FileFormatDefinition {
  id: string;
  extension: string;
  description: string;
  family: FileFamily;
  mimeType: string;
  signatureHex: string;
  signatureOffset: number;
  enableByDefault: boolean;
  maxFilesize: number;
}

export interface IdentifyMetadata {
  width?: number;
  height?: number;
  details?: string;
  subExtension?: string;
  camera?: string;
  takenAtMs?: number;
  jpegValid?: {
    hasDqt: boolean;
    hasDht: boolean;
    hasSof: boolean;
    hasExif: boolean;
    hasEoi: boolean;
  };
}

export interface IdentifyResult {
  formatId: string;
  extension: string;
  description: string;
  family: FileFamily;
  mimeType: string;
  matchedOffset: number;
  matchedLength: number;
  calculatedSize: number | null;
  status: 'OK' | 'OK_TRUNCATED' | 'HEADER_ONLY';
  metadata: IdentifyMetadata;
}

export interface CarvedFile {
  id: string;
  filename: string;
  recupDir: string;
  formatId: string;
  extension: string;
  description: string;
  family: FileFamily;
  mimeType: string;
  offset: number;
  sector: number;
  size: number;
  calculatedSize: number | null;
  status: 'OK' | 'OK_TRUNCATED';
  metadata: IdentifyMetadata;
  data: Uint8Array;
  partitionId?: string;
  partitionName?: string;
}

export interface CarveOptions {
  startByte: number;
  endByte: number;
  blockSize: number;
  paranoid: boolean;
  keepCorrupted: boolean;
  enabledFormats: Set<string>;
}

export interface CarveProgress {
  currentSector: number;
  totalSectors: number;
  percent: number;
  foundCount: number;
  foundBytes: number;
  latestFile?: CarvedFile;
}

const MB = 1024 * 1024;

export const FILE_FORMATS: FileFormatDefinition[] = [
  {
    id: 'jpg',
    extension: 'jpg',
    description: 'JPG picture (JPEG / JFIF / Exif)',
    family: 'Pictures',
    mimeType: 'image/jpeg',
    signatureHex: 'FF D8 FF',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 50 * MB,
  },
  {
    id: 'png',
    extension: 'png',
    description: 'Portable Network Graphics (PNG)',
    family: 'Pictures',
    mimeType: 'image/png',
    signatureHex: '89 50 4E 47 0D 0A 1A 0A',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 50 * MB,
  },
  {
    id: 'gif',
    extension: 'gif',
    description: 'Graphics Interchange Format (GIF87a/89a)',
    family: 'Pictures',
    mimeType: 'image/gif',
    signatureHex: '47 49 46 38',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 20 * MB,
  },
  {
    id: 'bmp',
    extension: 'bmp',
    description: 'Windows Bitmap Image (BMP)',
    family: 'Pictures',
    mimeType: 'image/bmp',
    signatureHex: '42 4D',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 30 * MB,
  },
  {
    id: 'webp',
    extension: 'webp',
    description: 'WebP RIFF Image',
    family: 'Pictures',
    mimeType: 'image/webp',
    signatureHex: '52 49 46 46 ... 57 45 42 50',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 30 * MB,
  },
  {
    id: 'tiff',
    extension: 'tif',
    description: 'Tagged Image File Format (TIFF / RAW)',
    family: 'Pictures',
    mimeType: 'image/tiff',
    signatureHex: '49 49 2A 00 / 4D 4D 00 2A',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 100 * MB,
  },
  {
    id: 'ico',
    extension: 'ico',
    description: 'Windows Icon Resource (.ico)',
    family: 'Pictures',
    mimeType: 'image/x-icon',
    signatureHex: '00 00 01 00',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 4 * MB,
  },
  {
    id: 'cur',
    extension: 'cur',
    description: 'Windows Cursor Resource (.cur)',
    family: 'Pictures',
    mimeType: 'image/x-icon',
    signatureHex: '00 00 02 00',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 4 * MB,
  },
  {
    id: 'pdf',
    extension: 'pdf',
    description: 'Portable Document Format (PDF)',
    family: 'Documents',
    mimeType: 'application/pdf',
    signatureHex: '25 50 44 46 2D 31 2E',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 100 * MB,
  },
  {
    id: 'zip',
    extension: 'zip',
    description: 'ZIP archive (including DOCX / XLSX / PPTX / APK / EPUB)',
    family: 'Archives',
    mimeType: 'application/zip',
    signatureHex: '50 4B 03 04',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 200 * MB,
  },
  {
    id: '7z',
    extension: '7z',
    description: '7-Zip compressed archive',
    family: 'Archives',
    mimeType: 'application/x-7z-compressed',
    signatureHex: '37 7A BC AF 27 1C',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 200 * MB,
  },
  {
    id: 'gz',
    extension: 'gz',
    description: 'gzip compressed data',
    family: 'Archives',
    mimeType: 'application/gzip',
    signatureHex: '1F 8B 08',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 100 * MB,
  },
  {
    id: 'rar',
    extension: 'rar',
    description: 'RAR archive (v4 / v5)',
    family: 'Archives',
    mimeType: 'application/vnd.rar',
    signatureHex: '52 61 72 21 1A 07',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 200 * MB,
  },
  {
    id: 'sqlite',
    extension: 'sqlite',
    description: 'SQLite 3.x database',
    family: 'Others',
    mimeType: 'application/vnd.sqlite3',
    signatureHex: '53 51 4C 69 74 65 20 66 6F 72 6D 61 74 20 33 00',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 200 * MB,
  },
  {
    id: 'mp4',
    extension: 'mp4',
    description: 'MPEG-4 / QuickTime ISO BMFF Video',
    family: 'Videos',
    mimeType: 'video/mp4',
    signatureHex: '66 74 79 70',
    signatureOffset: 4,
    enableByDefault: true,
    maxFilesize: 500 * MB,
  },
  {
    id: 'wav',
    extension: 'wav',
    description: 'Microsoft RIFF WAVE Audio',
    family: 'Audio',
    mimeType: 'audio/wav',
    signatureHex: '52 49 46 46 ... 57 41 56 45',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 200 * MB,
  },
  {
    id: 'avi',
    extension: 'avi',
    description: 'Microsoft RIFF AVI Video',
    family: 'Videos',
    mimeType: 'video/x-msvideo',
    signatureHex: '52 49 46 46 ... 41 56 49 20',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 500 * MB,
  },
  {
    id: 'mp3',
    extension: 'mp3',
    description: 'MPEG Audio Layer III (ID3v2)',
    family: 'Audio',
    mimeType: 'audio/mpeg',
    signatureHex: '49 44 33',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 50 * MB,
  },
  {
    id: 'flac',
    extension: 'flac',
    description: 'Free Lossless Audio Codec (FLAC)',
    family: 'Audio',
    mimeType: 'audio/flac',
    signatureHex: '66 4C 61 43',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 200 * MB,
  },
  {
    id: 'ogg',
    extension: 'ogg',
    description: 'Ogg Vorbis / Opus Container',
    family: 'Audio',
    mimeType: 'audio/ogg',
    signatureHex: '4F 67 67 53',
    signatureOffset: 0,
    enableByDefault: true,
    maxFilesize: 200 * MB,
  },
  {
    id: 'elf',
    extension: 'elf',
    description: 'Executable and Linkable Format (ELF)',
    family: 'Others',
    mimeType: 'application/x-elf',
    signatureHex: '7F 45 4C 46',
    signatureOffset: 0,
    enableByDefault: false,
    maxFilesize: 100 * MB,
  },
  {
    id: 'exe',
    extension: 'exe',
    description: 'Windows Portable Executable (MZ/PE)',
    family: 'Others',
    mimeType: 'application/vnd.microsoft.portable-executable',
    signatureHex: '4D 5A',
    signatureOffset: 0,
    enableByDefault: false,
    maxFilesize: 100 * MB,
  },
  {
    id: 'txt',
    extension: 'txt',
    description: 'UTF-8 / ASCII Text, JSON, or XML',
    family: 'Documents',
    mimeType: 'text/plain',
    signatureHex: 'Printable UTF-8 / <?xml / {',
    signatureOffset: 0,
    enableByDefault: false,
    maxFilesize: 10 * MB,
  },
];

const FORMAT_MAP = new Map<string, FileFormatDefinition>(
  FILE_FORMATS.map((f) => [f.id, f]),
);

function readUint16BE(buf: Uint8Array, pos: number): number {
  return ((buf[pos] << 8) | buf[pos + 1]) >>> 0;
}

function readUint16LE(buf: Uint8Array, pos: number): number {
  return (buf[pos] | (buf[pos + 1] << 8)) >>> 0;
}

function readUint32BE(buf: Uint8Array, pos: number): number {
  return (
    ((buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]) >>> 0
  );
}

function readUint32LE(buf: Uint8Array, pos: number): number {
  return (
    (buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24)) >>> 0
  );
}

function readAscii(buf: Uint8Array, pos: number, len: number): string {
  let out = '';
  const end = Math.min(buf.length, pos + len);
  for (let i = pos; i < end; i++) {
    out += String.fromCharCode(buf[i]);
  }
  return out;
}

function indexOfBytes(
  haystack: Uint8Array,
  needle: number[],
  from: number,
  maxEnd: number,
): number {
  const limit = Math.min(haystack.length, maxEnd) - needle.length;
  for (let i = from; i <= limit; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

function validateAndMeasureJpg(
  buf: Uint8Array,
  start: number,
  maxEnd: number,
): { size: number; truncated: boolean; meta: IdentifyMetadata } | null {
  if (start + 4 > maxEnd) return null;
  if (buf[start] !== 0xff || buf[start + 1] !== 0xd8 || buf[start + 2] !== 0xff) return null;
  const m4 = buf[start + 3];
  if (
    m4 !== 0xe0 &&
    m4 !== 0xe1 &&
    m4 !== 0xe2 &&
    m4 !== 0xdb &&
    m4 !== 0xee &&
    m4 !== 0xfe &&
    m4 !== 0xc0 &&
    m4 !== 0xc2
  ) {
    return null;
  }

  let pos = start + 2;
  let width: number | undefined;
  let height: number | undefined;
  let hasDqt = false;
  let hasDht = false;
  let hasSof = false;
  let hasExif = false;
  let sawSos = false;

  const exif = parseExifFromJpeg(buf, start, maxEnd);
  const attachMeta = (baseDetails: string, hasEoi: boolean): IdentifyMetadata => ({
    width,
    height,
    camera: exif?.camera,
    takenAtMs: exif?.takenAtMs,
    jpegValid: { hasDqt, hasDht, hasSof, hasExif, hasEoi },
    details: exif?.camera ? `${baseDetails} · ${exif.camera}` : baseDetails,
  });

  // Digler-inspired JPEG marker walker + bulk_extractor entropy scan (skips embedded EXIF thumbnails cleanly)
  while (pos + 2 <= maxEnd) {
    if (buf[pos] !== 0xff) {
      if (sawSos) {
        // Walk entropy-coded scan stream handling 0xFF 0x00 stuffing & RSTn markers
        let scanPos = pos;
        let foundEoi = -1;
        while (scanPos + 1 < maxEnd) {
          if (buf[scanPos] === 0xff) {
            const nextB = buf[scanPos + 1];
            if (nextB === 0xd9) {
              foundEoi = scanPos;
              break;
            }
            if (nextB === 0x00 || nextB === 0xff || (nextB >= 0xd0 && nextB <= 0xd7)) {
              scanPos += nextB === 0xff ? 1 : 2;
              continue;
            }
          }
          scanPos++;
        }
        if (foundEoi !== -1) {
          const dimText = width && height ? `${width}x${height} px` : 'JFIF/Exif stream';
          return {
            size: foundEoi + 2 - start,
            truncated: false,
            meta: attachMeta(dimText, true),
          };
        }
        return {
          size: Math.min(maxEnd - start, 2 * MB),
          truncated: true,
          meta: attachMeta('Missing FFD9 EOI', false),
        };
      }
      return null;
    }

    while (pos < maxEnd && buf[pos] === 0xff) pos++;
    if (pos >= maxEnd) break;
    const marker = buf[pos];
    pos++;

    if (marker === 0xd9) {
      const dimText = width && height ? `${width}x${height} px` : 'JPEG';
      return {
        size: pos - start,
        truncated: false,
        meta: attachMeta(dimText, true),
      };
    }
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd8)) {
      continue;
    }
    if (pos + 2 > maxEnd) break;
    const segLen = readUint16BE(buf, pos);
    if (segLen < 2 || pos + segLen > maxEnd) {
      if (sawSos) break;
      return null;
    }

    if (marker === 0xdb) hasDqt = true;
    if (marker === 0xc4) hasDht = true;
    if (marker === 0xe1) hasExif = true;
    if ((marker === 0xc0 || marker === 0xc1 || marker === 0xc2) && segLen >= 7 && pos + 7 <= maxEnd) {
      hasSof = true;
      height = readUint16BE(buf, pos + 3);
      width = readUint16BE(buf, pos + 5);
    }
    if (marker === 0xda) {
      sawSos = true;
    }

    pos += segLen;
  }

  if (sawSos) {
    return {
      size: Math.min(maxEnd - start, 2 * MB),
      truncated: true,
      meta: attachMeta('Truncated JPEG stream', false),
    };
  }
  return null;
}

function validateAndMeasurePng(
  buf: Uint8Array,
  start: number,
  maxEnd: number,
): { size: number; truncated: boolean; meta: IdentifyMetadata } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (start + 33 > maxEnd) return null;
  for (let i = 0; i < 8; i++) {
    if (buf[start + i] !== sig[i]) return null;
  }

  // Validate IHDR (from file_png.c: png_check_ihdr)
  const ihdrLen = readUint32BE(buf, start + 8);
  const ihdrType = readAscii(buf, start + 12, 4);
  if (ihdrType !== 'IHDR' || ihdrLen !== 13) return null;
  const width = readUint32BE(buf, start + 16);
  const height = readUint32BE(buf, start + 20);
  const bitDepth = buf[start + 24];
  const colorType = buf[start + 25];
  if (width === 0 || height === 0 || width > 65535 || height > 65535) return null;
  if (![0, 2, 3, 4, 6].includes(colorType)) return null;
  if (![1, 2, 4, 8, 16].includes(bitDepth)) return null;

  let pos = start + 8;
  while (pos + 12 <= maxEnd) {
    const chunkLen = readUint32BE(buf, pos);
    const chunkType = readAscii(buf, pos + 4, 4);
    if (chunkLen > 32 * MB) return null;
    const nextPos = pos + 12 + chunkLen;
    if (nextPos > maxEnd) {
      return {
        size: maxEnd - start,
        truncated: true,
        meta: { width, height, details: `${width}x${height} px · truncated` },
      };
    }
    pos = nextPos;
    if (chunkType === 'IEND') {
      return {
        size: pos - start,
        truncated: false,
        meta: { width, height, details: `${width}x${height} px · ${bitDepth}-bit` },
      };
    }
  }
  return null;
}

function validateAndMeasureGif(
  buf: Uint8Array,
  start: number,
  maxEnd: number,
): { size: number; truncated: boolean; meta: IdentifyMetadata } | null {
  if (start + 13 > maxEnd) return null;
  const hdr = readAscii(buf, start, 6);
  if (hdr !== 'GIF87a' && hdr !== 'GIF89a') return null;
  const width = readUint16LE(buf, start + 6);
  const height = readUint16LE(buf, start + 8);
  if (width === 0 || height === 0) return null;

  const packed = buf[start + 10];
  let pos = start + 13;
  if ((packed & 0x80) !== 0) {
    const gctSize = 3 * (1 << ((packed & 0x07) + 1));
    pos += gctSize;
  }

  while (pos < maxEnd) {
    const blockId = buf[pos];
    if (blockId === 0x3b) {
      return {
        size: pos + 1 - start,
        truncated: false,
        meta: { width, height, details: `${hdr} · ${width}x${height} px` },
      };
    }
    if (blockId === 0x2c) {
      // Image descriptor
      if (pos + 10 > maxEnd) break;
      const lPacked = buf[pos + 9];
      pos += 10;
      if ((lPacked & 0x80) !== 0) {
        pos += 3 * (1 << ((lPacked & 0x07) + 1));
      }
      if (pos >= maxEnd) break;
      pos += 1; // LZW minimum code size
      while (pos < maxEnd) {
        const subLen = buf[pos];
        pos += 1;
        if (subLen === 0) break;
        pos += subLen;
      }
    } else if (blockId === 0x21) {
      // Extension block
      if (pos + 2 > maxEnd) break;
      pos += 2;
      while (pos < maxEnd) {
        const subLen = buf[pos];
        pos += 1;
        if (subLen === 0) break;
        pos += subLen;
      }
    } else {
      break;
    }
  }
  return {
    size: Math.min(maxEnd - start, 64 * 1024),
    truncated: true,
    meta: { width, height, details: `${hdr} · ${width}x${height} px` },
  };
}

function validateAndMeasurePdf(
  buf: Uint8Array,
  start: number,
  maxEnd: number,
): { size: number; truncated: boolean; meta: IdentifyMetadata } | null {
  if (start + 8 > maxEnd) return null;
  const sig = readAscii(buf, start, 7);
  if (!sig.startsWith('%PDF-1.') && !sig.startsWith('%PDF-2.')) return null;
  const version = readAscii(buf, start + 5, 3);
  const eofMarker = [0x25, 0x25, 0x45, 0x4f, 0x46]; // %%EOF
  const searchLimit = Math.min(maxEnd, start + 10 * MB);
  let lastEof = -1;
  let scan = start + 8;
  while (scan < searchLimit) {
    const idx = indexOfBytes(buf, eofMarker, scan, searchLimit);
    if (idx === -1) break;
    lastEof = idx;
    // Check if another %PDF- starts before we keep scanning
    const nextPdf = indexOfBytes(buf, [0x25, 0x50, 0x44, 0x46, 0x2d], idx + 5, searchLimit);
    if (nextPdf !== -1) {
      // Stop before the next PDF file
      break;
    }
    scan = idx + 5;
  }

  // Optional /Title extraction (like file_rename_pdf in file_pdf.c)
  let title: string | undefined;
  const titleIdx = indexOfBytes(buf, [0x2f, 0x54, 0x69, 0x74, 0x6c, 0x65], start, Math.min(maxEnd, start + 65536));
  if (titleIdx !== -1) {
    const openParen = indexOfBytes(buf, [0x28], titleIdx, Math.min(maxEnd, titleIdx + 32));
    if (openParen !== -1) {
      const closeParen = indexOfBytes(buf, [0x29], openParen + 1, Math.min(maxEnd, openParen + 128));
      if (closeParen !== -1) {
        const rawTitle = readAscii(buf, openParen + 1, closeParen - openParen - 1).replace(/[^\x20-\x7e]/g, '').trim();
        if (rawTitle.length > 0) title = rawTitle;
      }
    }
  }

  if (lastEof !== -1) {
    let end = lastEof + 5;
    if (end < maxEnd && buf[end] === 0x0d) end++;
    if (end < maxEnd && buf[end] === 0x0a) end++;
    return {
      size: end - start,
      truncated: false,
      meta: {
        details: title ? `PDF ${version} · "${title}"` : `PDF ${version}`,
      },
    };
  }
  return null;
}

function validateAndMeasureZip(
  buf: Uint8Array,
  start: number,
  maxEnd: number,
): { size: number; truncated: boolean; meta: IdentifyMetadata } | null {
  if (start + 30 > maxEnd) return null;
  if (buf[start] !== 0x50 || buf[start + 1] !== 0x4b || buf[start + 2] !== 0x03 || buf[start + 3] !== 0x04) {
    return null;
  }

  const compression = readUint16LE(buf, start + 8);
  const fnameLen = readUint16LE(buf, start + 26);
  const extraLen = readUint16LE(buf, start + 28);
  if (fnameLen === 0 || fnameLen > 512 || compression > 99) return null;
  if (start + 30 + fnameLen > maxEnd) return null;

  const firstFilename = readAscii(buf, start + 30, fnameLen);
  let subExtension = 'zip';
  if (firstFilename.startsWith('word/')) subExtension = 'docx';
  else if (firstFilename.startsWith('xl/')) subExtension = 'xlsx';
  else if (firstFilename.startsWith('ppt/')) subExtension = 'pptx';
  else if (firstFilename === 'mimetype') {
    const mimeContent = readAscii(buf, start + 30 + fnameLen + extraLen, 64);
    if (mimeContent.includes('opendocument.text')) subExtension = 'odt';
    else if (mimeContent.includes('opendocument.spreadsheet')) subExtension = 'ods';
    else if (mimeContent.includes('epub+zip')) subExtension = 'epub';
  } else if (firstFilename.includes('AndroidManifest.xml')) subExtension = 'apk';
  else if (firstFilename.includes('META-INF/')) subExtension = 'jar';

  // Scan forward for EOCD (PK\x05\x06) and also detect sub-types along the way
  const searchLimit = Math.min(maxEnd, start + 16 * MB);
  const eocdSig = [0x50, 0x4b, 0x05, 0x06];
  const eocdPos = indexOfBytes(buf, eocdSig, start + 30, searchLimit);
  if (eocdPos !== -1 && eocdPos + 22 <= maxEnd) {
    const commentLen = readUint16LE(buf, eocdPos + 20);
    const totalSize = eocdPos + 22 + commentLen - start;
    // Check if OOXML folders appear anywhere inside central directory
    if (subExtension === 'zip') {
      const sliceStr = readAscii(buf, start, Math.min(totalSize, 4096));
      if (sliceStr.includes('word/')) subExtension = 'docx';
      else if (sliceStr.includes('xl/')) subExtension = 'xlsx';
      else if (sliceStr.includes('ppt/')) subExtension = 'pptx';
    }
    return {
      size: totalSize,
      truncated: false,
      meta: {
        subExtension,
        details: `${subExtension.toUpperCase()} · first entry "${firstFilename}"`,
      },
    };
  }
  return null;
}

function validateAndMeasureMp4(
  buf: Uint8Array,
  start: number,
  maxEnd: number,
): { size: number; truncated: boolean; meta: IdentifyMetadata } | null {
  if (start + 12 > maxEnd) return null;
  if (readAscii(buf, start + 4, 4) !== 'ftyp') return null;
  const firstSize = readUint32BE(buf, start);
  if (firstSize < 16 || firstSize > 1024) return null;
  const brand = readAscii(buf, start + 8, 4).trim();
  const validBrands = [
    'isom',
    'iso2',
    'mp41',
    'mp42',
    'M4V',
    'M4A',
    'qt',
    'avc1',
    '3gp4',
    '3gp5',
    'heic',
    'mif1',
  ];
  if (!validBrands.some((b) => brand.startsWith(b)) && !/^[a-zA-Z0-9]{3,4}$/.test(brand)) {
    return null;
  }

  let pos = start;
  const boxNames: string[] = [];
  let hasMoov = false;
  let hasMdat = false;

  while (pos + 8 <= maxEnd && boxNames.length < 128) {
    let boxSize = readUint32BE(buf, pos);
    const boxType = readAscii(buf, pos + 4, 4);
    if (boxSize === 1 && pos + 16 <= maxEnd) {
      boxSize = readUint32BE(buf, pos + 8) * 4294967296 + readUint32BE(buf, pos + 12);
    } else if (boxSize === 0) {
      boxSize = maxEnd - pos;
    }
    if (boxSize < 8 || !/^[\x20-\x7e]{4}$/.test(boxType)) break;
    boxNames.push(boxType);
    if (boxType === 'moov') hasMoov = true;
    if (boxType === 'mdat') hasMdat = true;
    if (pos + boxSize > maxEnd) {
      return {
        size: maxEnd - start,
        truncated: true,
        meta: {
          subExtension: brand === 'qt' ? 'mov' : brand === 'heic' ? 'heic' : 'mp4',
          details: `ISO BMFF (${brand}) · boxes: ${boxNames.join(', ')}${!hasMoov && hasMdat ? ' (moov pending/at EOF)' : ''}`,
        },
      };
    }
    pos += boxSize;
  }

  if (pos > start + firstSize || boxNames.length >= 1) {
    const missingIndex = hasMdat && !hasMoov && boxNames.length >= 2;
    return {
      size: pos - start,
      truncated: missingIndex,
      meta: {
        subExtension: brand === 'qt' ? 'mov' : brand === 'heic' ? 'heic' : 'mp4',
        details: missingIndex
          ? `ISO BMFF (${brand}) · ${boxNames.join(' → ')} (missing moov index atom)`
          : `ISO BMFF (${brand}) · ${boxNames.join(' → ')}`,
      },
    };
  }
  return null;
}

export function identifyBuffer(
  buf: Uint8Array,
  enabledFormats?: Set<string>,
): IdentifyResult | null {
  const isEnabled = (id: string) => !enabledFormats || enabledFormats.has(id);

  // 1. PNG
  if (isEnabled('png')) {
    const png = validateAndMeasurePng(buf, 0, buf.length);
    if (png) {
      const def = FORMAT_MAP.get('png')!;
      return {
        formatId: 'png',
        extension: 'png',
        description: def.description,
        family: def.family,
        mimeType: def.mimeType,
        matchedOffset: 0,
        matchedLength: 8,
        calculatedSize: png.size,
        status: png.truncated ? 'OK_TRUNCATED' : 'OK',
        metadata: png.meta,
      };
    }
  }

  // 2. JPG
  if (isEnabled('jpg')) {
    const jpg = validateAndMeasureJpg(buf, 0, buf.length);
    if (jpg) {
      const def = FORMAT_MAP.get('jpg')!;
      return {
        formatId: 'jpg',
        extension: 'jpg',
        description: def.description,
        family: def.family,
        mimeType: def.mimeType,
        matchedOffset: 0,
        matchedLength: 3,
        calculatedSize: jpg.size,
        status: jpg.truncated ? 'OK_TRUNCATED' : 'OK',
        metadata: jpg.meta,
      };
    }
  }

  // 3. GIF
  if (isEnabled('gif')) {
    const gif = validateAndMeasureGif(buf, 0, buf.length);
    if (gif) {
      const def = FORMAT_MAP.get('gif')!;
      return {
        formatId: 'gif',
        extension: 'gif',
        description: def.description,
        family: def.family,
        mimeType: def.mimeType,
        matchedOffset: 0,
        matchedLength: 6,
        calculatedSize: gif.size,
        status: gif.truncated ? 'OK_TRUNCATED' : 'OK',
        metadata: gif.meta,
      };
    }
  }

  // 4. BMP
  if (isEnabled('bmp') && buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
    const bfSize = readUint32LE(buf, 2);
    const dibSize = readUint32LE(buf, 14);
    if ([12, 40, 52, 56, 108, 124].includes(dibSize) && bfSize >= 26 && bfSize < 100 * MB) {
      const w = dibSize >= 40 ? readUint32LE(buf, 18) : readUint16LE(buf, 18);
      const h = dibSize >= 40 ? readUint32LE(buf, 22) : readUint16LE(buf, 20);
      const def = FORMAT_MAP.get('bmp')!;
      return {
        formatId: 'bmp',
        extension: 'bmp',
        description: def.description,
        family: def.family,
        mimeType: def.mimeType,
        matchedOffset: 0,
        matchedLength: 2,
        calculatedSize: bfSize,
        status: bfSize <= buf.length ? 'OK' : 'OK_TRUNCATED',
        metadata: { width: w, height: h, details: `${w}x${h} px · DIB ${dibSize}B` },
      };
    }
  }

  // 5. RIFF (WEBP / WAV / AVI)
  if (buf.length >= 12 && readAscii(buf, 0, 4) === 'RIFF') {
    const riffSize = readUint32LE(buf, 4) + 8;
    const fourcc = readAscii(buf, 8, 4);
    if (fourcc === 'WEBP' && isEnabled('webp')) {
      const def = FORMAT_MAP.get('webp')!;
      return {
        formatId: 'webp',
        extension: 'webp',
        description: def.description,
        family: def.family,
        mimeType: def.mimeType,
        matchedOffset: 0,
        matchedLength: 12,
        calculatedSize: riffSize,
        status: riffSize <= buf.length ? 'OK' : 'OK_TRUNCATED',
        metadata: { details: 'RIFF WebP image' },
      };
    }
    if (fourcc === 'WAVE' && isEnabled('wav')) {
      const def = FORMAT_MAP.get('wav')!;
      return {
        formatId: 'wav',
        extension: 'wav',
        description: def.description,
        family: def.family,
        mimeType: def.mimeType,
        matchedOffset: 0,
        matchedLength: 12,
        calculatedSize: riffSize,
        status: riffSize <= buf.length ? 'OK' : 'OK_TRUNCATED',
        metadata: { details: 'RIFF PCM Audio' },
      };
    }
    if (fourcc === 'AVI ' && isEnabled('avi')) {
      const def = FORMAT_MAP.get('avi')!;
      return {
        formatId: 'avi',
        extension: 'avi',
        description: def.description,
        family: def.family,
        mimeType: def.mimeType,
        matchedOffset: 0,
        matchedLength: 12,
        calculatedSize: riffSize,
        status: riffSize <= buf.length ? 'OK' : 'OK_TRUNCATED',
        metadata: { details: 'RIFF AVI Video' },
      };
    }
  }

  // 6. TIFF
  if (
    isEnabled('tiff') &&
    buf.length >= 8 &&
    ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
      (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a))
  ) {
    const def = FORMAT_MAP.get('tiff')!;
    const endian = buf[0] === 0x49 ? 'Little-Endian (II)' : 'Big-Endian (MM)';
    return {
      formatId: 'tiff',
      extension: 'tif',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 4,
      calculatedSize: buf.length,
      status: 'HEADER_ONLY',
      metadata: { details: `TIFF ${endian}` },
    };
  }

  // 7. PDF
  if (isEnabled('pdf')) {
    const pdf = validateAndMeasurePdf(buf, 0, buf.length);
    if (pdf) {
      const def = FORMAT_MAP.get('pdf')!;
      return {
        formatId: 'pdf',
        extension: 'pdf',
        description: def.description,
        family: def.family,
        mimeType: def.mimeType,
        matchedOffset: 0,
        matchedLength: 7,
        calculatedSize: pdf.size,
        status: pdf.truncated ? 'OK_TRUNCATED' : 'OK',
        metadata: pdf.meta,
      };
    }
  }

  // 8. ZIP & Office OOXML
  if (isEnabled('zip')) {
    const zip = validateAndMeasureZip(buf, 0, buf.length);
    if (zip) {
      const def = FORMAT_MAP.get('zip')!;
      return {
        formatId: 'zip',
        extension: zip.meta.subExtension ?? 'zip',
        description: def.description,
        family: def.family,
        mimeType: def.mimeType,
        matchedOffset: 0,
        matchedLength: 4,
        calculatedSize: zip.size,
        status: zip.truncated ? 'OK_TRUNCATED' : 'OK',
        metadata: zip.meta,
      };
    }
  }

  // 9. 7z
  if (
    isEnabled('7z') &&
    buf.length >= 32 &&
    buf[0] === 0x37 &&
    buf[1] === 0x7a &&
    buf[2] === 0xbc &&
    buf[3] === 0xaf &&
    buf[4] === 0x27 &&
    buf[5] === 0x1c
  ) {
    const nextOffset = readUint32LE(buf, 12);
    const nextSize = readUint32LE(buf, 20);
    const calc = 32 + nextOffset + nextSize;
    const def = FORMAT_MAP.get('7z')!;
    return {
      formatId: '7z',
      extension: '7z',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 6,
      calculatedSize: calc,
      status: calc <= buf.length ? 'OK' : 'OK_TRUNCATED',
      metadata: { details: `7z v${buf[6]}.${buf[7]} · NextHeader @ +${32 + nextOffset}` },
    };
  }

  // 10. GZ
  if (isEnabled('gz') && buf.length >= 10 && buf[0] === 0x1f && buf[1] === 0x8b && buf[2] === 0x08) {
    const def = FORMAT_MAP.get('gz')!;
    return {
      formatId: 'gz',
      extension: 'gz',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 3,
      calculatedSize: buf.length,
      status: 'HEADER_ONLY',
      metadata: { details: `Deflate stream (FLG=0x${buf[3].toString(16).padStart(2, '0')})` },
    };
  }

  // 11. RAR
  if (
    isEnabled('rar') &&
    buf.length >= 7 &&
    buf[0] === 0x52 &&
    buf[1] === 0x61 &&
    buf[2] === 0x72 &&
    buf[3] === 0x21 &&
    buf[4] === 0x1a &&
    buf[5] === 0x07
  ) {
    const def = FORMAT_MAP.get('rar')!;
    return {
      formatId: 'rar',
      extension: 'rar',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 6,
      calculatedSize: buf.length,
      status: 'HEADER_ONLY',
      metadata: { details: buf[6] === 0x01 ? 'RAR5 format' : 'RAR4 format' },
    };
  }

  // 12. SQLite 3
  if (isEnabled('sqlite') && buf.length >= 100 && readAscii(buf, 0, 15) === 'SQLite format 3' && buf[15] === 0) {
    let pageSize = readUint16BE(buf, 16);
    if (pageSize === 1) pageSize = 65536;
    const pageCount = readUint32BE(buf, 28);
    const calc = pageSize * pageCount;
    const def = FORMAT_MAP.get('sqlite')!;
    return {
      formatId: 'sqlite',
      extension: 'sqlite',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 16,
      calculatedSize: calc > 0 ? calc : buf.length,
      status: calc > 0 && calc <= buf.length ? 'OK' : calc > buf.length ? 'OK_TRUNCATED' : 'HEADER_ONLY',
      metadata: { details: `Page size ${pageSize} B · ${pageCount} pages` },
    };
  }

  // 12b. Windows Icon (.ico) / Cursor (.cur)
  if (
    (isEnabled('ico') || isEnabled('cur')) &&
    buf.length >= 22 &&
    buf[0] === 0x00 &&
    buf[1] === 0x00 &&
    (buf[2] === 0x01 || buf[2] === 0x02) &&
    buf[3] === 0x00
  ) {
    const count = readUint16LE(buf, 4);
    if (count >= 1 && count <= 32 && buf.length >= 6 + count * 16) {
      let maxEnd = 6 + count * 16;
      let validDir = true;
      for (let i = 0; i < count; i++) {
        const entryOff = 6 + i * 16;
        const dataSz = readUint32LE(buf, entryOff + 8);
        const imgOff = readUint32LE(buf, entryOff + 12);
        if (dataSz === 0 || imgOff < 6 + count * 16 || dataSz > 2 * MB) {
          validDir = false;
          break;
        }
        maxEnd = Math.max(maxEnd, imgOff + dataSz);
      }
      if (validDir && maxEnd > 22) {
        const isCur = buf[2] === 0x02;
        const id = isCur ? 'cur' : 'ico';
        if (isEnabled(id)) {
          const def = FORMAT_MAP.get(id)!;
          return {
            formatId: id,
            extension: id,
            description: def.description,
            family: def.family,
            mimeType: def.mimeType,
            matchedOffset: 0,
            matchedLength: 4,
            calculatedSize: Math.min(maxEnd, buf.length),
            status: maxEnd <= buf.length ? 'OK' : 'OK_TRUNCATED',
            metadata: { details: `${count} embedded ${isCur ? 'cursor' : 'icon'} frame${count === 1 ? '' : 's'}` },
          };
        }
      }
    }
  }

  // 13. MP4 / MOV / HEIC
  if (isEnabled('mp4')) {
    const mp4 = validateAndMeasureMp4(buf, 0, buf.length);
    if (mp4) {
      const def = FORMAT_MAP.get('mp4')!;
      const sub = mp4.meta.subExtension ?? 'mp4';
      const isHeic = sub === 'heic';
      return {
        formatId: 'mp4',
        extension: sub,
        description: isHeic ? 'High Efficiency Image Container (HEIC)' : def.description,
        family: isHeic ? 'Pictures' : def.family,
        mimeType: isHeic ? 'image/heic' : sub === 'mov' ? 'video/quicktime' : def.mimeType,
        matchedOffset: 4,
        matchedLength: 4,
        calculatedSize: mp4.size,
        status: mp4.truncated ? 'OK_TRUNCATED' : 'OK',
        metadata: mp4.meta,
      };
    }
  }

  // 14. MP3 ID3v2
  if (isEnabled('mp3') && buf.length >= 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const tagSize =
      ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    const def = FORMAT_MAP.get('mp3')!;
    return {
      formatId: 'mp3',
      extension: 'mp3',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 3,
      calculatedSize: buf.length,
      status: 'HEADER_ONLY',
      metadata: { details: `ID3v2.${buf[3]} tag (${tagSize} B)` },
    };
  }

  // 15. FLAC
  if (isEnabled('flac') && buf.length >= 4 && readAscii(buf, 0, 4) === 'fLaC') {
    const def = FORMAT_MAP.get('flac')!;
    return {
      formatId: 'flac',
      extension: 'flac',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 4,
      calculatedSize: buf.length,
      status: 'HEADER_ONLY',
      metadata: { details: 'FLAC lossless audio stream' },
    };
  }

  // 16. OGG
  if (isEnabled('ogg') && buf.length >= 28 && readAscii(buf, 0, 4) === 'OggS') {
    const def = FORMAT_MAP.get('ogg')!;
    return {
      formatId: 'ogg',
      extension: 'ogg',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 4,
      calculatedSize: buf.length,
      status: 'HEADER_ONLY',
      metadata: { details: 'Ogg bitstream page container' },
    };
  }

  // 17. ELF
  if (isEnabled('elf') && buf.length >= 20 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    const elfClass = buf[4] === 2 ? '64-bit' : buf[4] === 1 ? '32-bit' : 'Unknown';
    const def = FORMAT_MAP.get('elf')!;
    return {
      formatId: 'elf',
      extension: 'elf',
      description: def.description,
      family: def.family,
      mimeType: def.mimeType,
      matchedOffset: 0,
      matchedLength: 4,
      calculatedSize: buf.length,
      status: 'HEADER_ONLY',
      metadata: { details: `ELF ${elfClass} binary` },
    };
  }

  // 18. MZ / PE
  if (isEnabled('exe') && buf.length >= 64 && buf[0] === 0x4d && buf[1] === 0x5a) {
    const peOff = readUint32LE(buf, 60);
    if (peOff + 4 <= buf.length && readAscii(buf, peOff, 4) === 'PE\0\0') {
      const def = FORMAT_MAP.get('exe')!;
      return {
        formatId: 'exe',
        extension: 'exe',
        description: def.description,
        family: def.family,
        mimeType: def.mimeType,
        matchedOffset: 0,
        matchedLength: 2,
        calculatedSize: buf.length,
        status: 'HEADER_ONLY',
        metadata: { details: `PE/COFF header @ +0x${peOff.toString(16)}` },
      };
    }
  }

  // 19. Printable UTF-8 / JSON / XML
  if (isEnabled('txt') && buf.length >= 4) {
    const sampleLen = Math.min(buf.length, 512);
    let printable = 0;
    for (let i = 0; i < sampleLen; i++) {
      const b = buf[i];
      if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126) || b >= 0xc2) {
        printable++;
      }
    }
    if (printable / sampleLen > 0.94) {
      const head = readAscii(buf, 0, Math.min(buf.length, 128)).trimStart();
      let ext = 'txt';
      let desc = 'UTF-8 / ASCII Plain Text';
      let mime = 'text/plain';
      if (head.startsWith('<?xml') || head.startsWith('<svg')) {
        ext = head.startsWith('<svg') ? 'svg' : 'xml';
        desc = 'XML / SVG Markup Document';
        mime = ext === 'svg' ? 'image/svg+xml' : 'application/xml';
      } else if (/^<!doctype\s+(html|netscape-bookmark)/i.test(head) || /^<html/i.test(head)) {
        ext = 'html';
        desc = /netscape-bookmark/i.test(head) ? 'Browser Bookmarks Export (HTML)' : 'HTML Web Document';
        mime = 'text/html';
      } else if (/^(From:|Return-Path:|MIME-Version:|Message-ID:)/m.test(head) && /^Subject:/m.test(head)) {
        ext = 'eml';
        desc = 'RFC 822 Email Message (.eml)';
        mime = 'message/rfc822';
      } else if (head.startsWith('{') || head.startsWith('[')) {
        try {
          JSON.parse(new TextDecoder().decode(buf.subarray(0, Math.min(buf.length, 65536))));
          ext = 'json';
          desc = 'JSON Structured Data';
          mime = 'application/json';
        } catch {
          // keep txt
        }
      }
      return {
        formatId: 'txt',
        extension: ext,
        description: desc,
        family: 'Documents',
        mimeType: mime,
        matchedOffset: 0,
        matchedLength: 0,
        calculatedSize: buf.length,
        status: 'OK',
        metadata: { details: `${buf.length} bytes printable text` },
      };
    }
  }

  // 19b. Windows UTF-16LE Text / INI / REG / Log (adapted from apfs-excavate orphan_post.c)
  if (isEnabled('txt') && buf.length >= 8) {
    const hasUtf16Bom = buf[0] === 0xff && buf[1] === 0xfe;
    const samplePairs = Math.min(256, Math.floor(buf.length / 2));
    let asciiLePairs = 0;
    for (let p = hasUtf16Bom ? 1 : 0; p < samplePairs; p++) {
      const lo = buf[p * 2];
      const hi = buf[p * 2 + 1];
      if (hi === 0 && (lo === 9 || lo === 10 || lo === 13 || (lo >= 32 && lo <= 126))) {
        asciiLePairs++;
      }
    }
    const denom = hasUtf16Bom ? Math.max(1, samplePairs - 1) : samplePairs;
    if (denom >= 4 && asciiLePairs / denom >= 0.85) {
      return {
        formatId: 'txt',
        extension: 'txt',
        description: 'Windows UTF-16LE Unicode Text',
        family: 'Documents',
        mimeType: 'text/plain',
        matchedOffset: 0,
        matchedLength: hasUtf16Bom ? 2 : 0,
        calculatedSize: buf.length,
        status: 'OK',
        metadata: { details: `${buf.length} bytes UTF-16LE text` },
      };
    }
  }

  return null;
}

/**
 * PhotoRec-inspired sector-by-sector carver across a binary disk or partition range.
 */
export function carveDiskBuffer(
  diskBytes: Uint8Array,
  options: CarveOptions,
): CarvedFile[] {
  const results: CarvedFile[] = [];
  const start = Math.max(0, options.startByte);
  const end = Math.min(diskBytes.length, options.endByte);
  const step = Math.max(512, options.blockSize);
  let fileIndex = 1;
  let cursor = start;

  while (cursor + 16 <= end) {
    const b0 = diskBytes[cursor];
    const b1 = diskBytes[cursor + 1];
    const b2 = diskBytes[cursor + 2];
    const b4 = diskBytes[cursor + 4];

    // Fast signature pre-filter (like PhotoRec's file_check_list[buffer[offset]])
    const maybeMatch =
      (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) ||
      (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e) ||
      (b0 === 0x47 && b1 === 0x49 && b2 === 0x46) ||
      (b0 === 0x42 && b1 === 0x4d) ||
      (b0 === 0x52 && b1 === 0x49 && b2 === 0x46) ||
      (b0 === 0x25 && b1 === 0x50 && b2 === 0x44) ||
      (b0 === 0x50 && b1 === 0x4b && b2 === 0x03) ||
      (b0 === 0x37 && b1 === 0x7a && b2 === 0xbc) ||
      (b0 === 0x1f && b1 === 0x8b && b2 === 0x08) ||
      (b0 === 0x52 && b1 === 0x61 && b2 === 0x72) ||
      (b0 === 0x53 && b1 === 0x51 && b2 === 0x4c) ||
      (b4 === 0x66 && diskBytes[cursor + 5] === 0x74 && diskBytes[cursor + 6] === 0x79) ||
      (b0 === 0x49 && b1 === 0x44 && b2 === 0x33) ||
      (b0 === 0x66 && b1 === 0x4c && b2 === 0x61) ||
      (b0 === 0x4f && b1 === 0x67 && b2 === 0x67) ||
      (b0 === 0x7f && b1 === 0x45 && b2 === 0x4c) ||
      (b0 === 0x4d && b1 === 0x5a) ||
      (b0 === 0x00 && b1 === 0x00 && (b2 === 0x01 || b2 === 0x02) && diskBytes[cursor + 3] === 0x00);

    if (maybeMatch) {
      const slice = diskBytes.subarray(cursor, Math.min(end, cursor + 16 * MB));
      const match = identifyBuffer(slice, options.enabledFormats);
      if (match && match.calculatedSize && match.calculatedSize >= 16) {
        const isTruncated = match.status === 'OK_TRUNCATED';
        if (!isTruncated || !options.paranoid || options.keepCorrupted) {
          const clampedSize = Math.min(match.calculatedSize, end - cursor);
          const dirNum = Math.floor((fileIndex - 1) / 500) + 1;
          const recupDir = `recup_dir.${dirNum}`;
          const sector = Math.floor(cursor / 512);
          const padNum = String(fileIndex).padStart(4, '0');
          const carvedData = diskBytes.slice(cursor, cursor + clampedSize);

          results.push({
            id: `${cursor}-${match.extension}`,
            filename: `f${String(sector).padStart(7, '0')}_${padNum}.${match.extension}`,
            recupDir,
            formatId: match.formatId,
            extension: match.extension,
            description: match.description,
            family: match.family,
            mimeType: match.mimeType,
            offset: cursor,
            sector,
            size: clampedSize,
            calculatedSize: match.calculatedSize,
            status: isTruncated ? 'OK_TRUNCATED' : 'OK',
            metadata: match.metadata,
            data: carvedData,
          });

          fileIndex++;
          // Advance past the carved file aligned to blockSize (just like PhotoRec)
          const alignedAdvance = Math.max(step, Math.ceil(clampedSize / step) * step);
          cursor += alignedAdvance;
          continue;
        }
      }
    }

    cursor += step;
  }

  return results;
}

export interface AsyncCarveControls {
  isCancelled: () => boolean;
  isPaused: () => boolean;
}

/**
 * Chunked asynchronous carver that yields to the main thread and streams live sector progress.
 */
export async function carveDiskBufferAsync(
  diskBytes: Uint8Array,
  options: CarveOptions,
  onProgress: (progress: CarveProgress) => void,
  controls?: AsyncCarveControls,
): Promise<CarvedFile[]> {
  const results: CarvedFile[] = [];
  const start = Math.max(0, options.startByte);
  const end = Math.min(diskBytes.length, options.endByte);
  const step = Math.max(512, options.blockSize);
  const totalSectors = Math.max(1, Math.floor((end - start) / 512));
  let fileIndex = 1;
  let foundBytes = 0;
  let cursor = start;
  let stepsSinceYield = 0;

  while (cursor + 16 <= end) {
    if (controls?.isCancelled()) {
      break;
    }
    while (controls?.isPaused()) {
      if (controls.isCancelled()) break;
      await new Promise((r) => setTimeout(r, 80));
    }
    if (controls?.isCancelled()) {
      break;
    }

    const b0 = diskBytes[cursor];
    const b1 = diskBytes[cursor + 1];
    const b2 = diskBytes[cursor + 2];
    const b4 = diskBytes[cursor + 4];

    const maybeMatch =
      (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) ||
      (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e) ||
      (b0 === 0x47 && b1 === 0x49 && b2 === 0x46) ||
      (b0 === 0x42 && b1 === 0x4d) ||
      (b0 === 0x52 && b1 === 0x49 && b2 === 0x46) ||
      (b0 === 0x25 && b1 === 0x50 && b2 === 0x44) ||
      (b0 === 0x50 && b1 === 0x4b && b2 === 0x03) ||
      (b0 === 0x37 && b1 === 0x7a && b2 === 0xbc) ||
      (b0 === 0x1f && b1 === 0x8b && b2 === 0x08) ||
      (b0 === 0x52 && b1 === 0x61 && b2 === 0x72) ||
      (b0 === 0x53 && b1 === 0x51 && b2 === 0x4c) ||
      (b4 === 0x66 && diskBytes[cursor + 5] === 0x74 && diskBytes[cursor + 6] === 0x79) ||
      (b0 === 0x49 && b1 === 0x44 && b2 === 0x33) ||
      (b0 === 0x66 && b1 === 0x4c && b2 === 0x61) ||
      (b0 === 0x4f && b1 === 0x67 && b2 === 0x67) ||
      (b0 === 0x7f && b1 === 0x45 && b2 === 0x4c) ||
      (b0 === 0x4d && b1 === 0x5a) ||
      (b0 === 0x00 && b1 === 0x00 && (b2 === 0x01 || b2 === 0x02) && diskBytes[cursor + 3] === 0x00);

    if (maybeMatch) {
      const slice = diskBytes.subarray(cursor, Math.min(end, cursor + 16 * MB));
      const match = identifyBuffer(slice, options.enabledFormats);
      if (match && match.calculatedSize && match.calculatedSize >= 16) {
        const isTruncated = match.status === 'OK_TRUNCATED';
        if (!isTruncated || !options.paranoid || options.keepCorrupted) {
          const clampedSize = Math.min(match.calculatedSize, end - cursor);
          const dirNum = Math.floor((fileIndex - 1) / 500) + 1;
          const recupDir = `recup_dir.${dirNum}`;
          const sector = Math.floor(cursor / 512);
          const padNum = String(fileIndex).padStart(6, '0');
          const carvedData = diskBytes.slice(cursor, cursor + clampedSize);

          const carved: CarvedFile = {
            id: `${cursor}-${match.extension}`,
            filename: `${match.extension.toUpperCase()}_${padNum}.${match.extension}`,
            recupDir,
            formatId: match.formatId,
            extension: match.extension,
            description: match.description,
            family: match.family,
            mimeType: match.mimeType,
            offset: cursor,
            sector,
            size: clampedSize,
            calculatedSize: match.calculatedSize,
            status: isTruncated ? 'OK_TRUNCATED' : 'OK',
            metadata: match.metadata,
            data: carvedData,
          };

          results.push(carved);
          foundBytes += clampedSize;
          fileIndex++;

          const currentSector = Math.floor((cursor - start) / 512);
          onProgress({
            currentSector,
            totalSectors,
            percent: Math.min(99, Math.round((currentSector / totalSectors) * 100)),
            foundCount: results.length,
            foundBytes,
            latestFile: carved,
          });

          const alignedAdvance = Math.max(step, Math.ceil(clampedSize / step) * step);
          cursor += alignedAdvance;
          stepsSinceYield += 1;
          if (stepsSinceYield >= 400) {
            stepsSinceYield = 0;
            await new Promise((r) => setTimeout(r, 0));
          }
          continue;
        }
      }
    }

    cursor += step;
    stepsSinceYield++;
    if (stepsSinceYield >= 1200) {
      stepsSinceYield = 0;
      const currentSector = Math.floor((cursor - start) / 512);
      onProgress({
        currentSector,
        totalSectors,
        percent: Math.min(99, Math.round((currentSector / totalSectors) * 100)),
        foundCount: results.length,
        foundBytes,
      });
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  onProgress({
    currentSector: totalSectors,
    totalSectors,
    percent: 100,
    foundCount: results.length,
    foundBytes,
  });

  return results;
}

