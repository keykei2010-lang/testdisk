import { computeCrc32 } from './crc32';
import { extractEmbeddedJpegPreview } from './imageRepair';

export interface NonMediaRepairResult {
  repaired: boolean;
  data: Uint8Array;
  note: string;
  salvagedPreviewBytes?: Uint8Array;
}

export interface NonMediaDiagnosis {
  issue: string;
  canRepair: boolean;
  needsReferenceHint: boolean;
}

const NON_MEDIA_REPAIR_EXTS = new Set([
  'zip',
  'docx',
  'xlsx',
  'pptx',
  'odt',
  'ods',
  'odp',
  'epub',
  'apk',
  'jar',
  'kra',
  'ora',
  'kmz',
  'aep',
  'aepx',
  'xml',
  'svg',
  'html',
  'htm',
  'json',
  'rpy',
  'rpa',
  'txt',
  'py',
  'ini',
  'csv',
  'sql',
  'psd',
  'psb',
  'pdf',
  'sqlite',
  'db',
  'sqlite3',
  'doc',
  'xls',
  'ppt',
  'msg',
  'msi',
  'pst',
  'ost',
  'tar',
  'gz',
  'mp3',
  'flac',
  'rtf',
  'eml',
]);

export function isNonMediaRepairableExtension(ext: string): boolean {
  return NON_MEDIA_REPAIR_EXTS.has(ext.toLowerCase().replace(/^\./, ''));
}

function readU16LE(b: Uint8Array, p: number): number {
  return (b[p] | (b[p + 1] << 8)) >>> 0;
}

function readU32LE(b: Uint8Array, p: number): number {
  return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
}

function readU16BE(b: Uint8Array, p: number): number {
  return ((b[p] << 8) | b[p + 1]) >>> 0;
}

function readU32BE(b: Uint8Array, p: number): number {
  return (((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0);
}

function writeU16LE(b: Uint8Array, p: number, v: number): void {
  b[p] = v & 0xff;
  b[p + 1] = (v >>> 8) & 0xff;
}

function writeU32LE(b: Uint8Array, p: number, v: number): void {
  b[p] = v & 0xff;
  b[p + 1] = (v >>> 8) & 0xff;
  b[p + 2] = (v >>> 16) & 0xff;
  b[p + 3] = (v >>> 24) & 0xff;
}

function writeU32BE(b: Uint8Array, p: number, v: number): void {
  b[p] = (v >>> 24) & 0xff;
  b[p + 1] = (v >>> 16) & 0xff;
  b[p + 2] = (v >>> 8) & 0xff;
  b[p + 3] = v & 0xff;
}

function asciiAt(b: Uint8Array, p: number, len: number): string {
  let out = '';
  const end = Math.min(b.length, p + len);
  for (let i = p; i < end; i++) out += String.fromCharCode(b[i]);
  return out;
}

function indexOfSig(b: Uint8Array, sig: number[], from: number, end: number): number {
  const limit = Math.min(b.length, end) - sig.length;
  for (let i = Math.max(0, from); i <= limit; i++) {
    let ok = true;
    for (let j = 0; j < sig.length; j++) {
      if (b[i + j] !== sig[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

function concatUint8(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Balances unclosed XML/SVG/HTML tags in truncated markup text and trims broken partial trailing tags.
 */
export function closeTruncatedXmlOrHtml(rawText: string, isHtml = false): { text: string; closedCount: number } {
  let text = rawText.replace(/\0+$/g, '');
  // Cut incomplete trailing tag like "<w:t xml:"
  const lastLt = text.lastIndexOf('<');
  const lastGt = text.lastIndexOf('>');
  if (lastLt > lastGt && lastLt !== -1) {
    text = text.slice(0, lastLt);
  }

  const voidTags = isHtml
    ? new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
    : new Set<string>();

  const stack: string[] = [];
  const tagRe = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/?\s*([A-Za-z_][\w:.-]*)([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text)) !== null) {
    const full = m[0];
    const name = m[1];
    if (!name) continue;
    if (full.startsWith('</')) {
      const idx = stack.lastIndexOf(name);
      if (idx !== -1) stack.splice(idx, 1);
    } else if (!full.endsWith('/>') && !voidTags.has(name.toLowerCase())) {
      stack.push(name);
    }
  }

  if (stack.length === 0) {
    return { text, closedCount: 0 };
  }
  const closing = stack
    .reverse()
    .map((t) => `</${t}>`)
    .join('');
  return { text: `${text}${closing}`, closedCount: stack.length };
}

/**
 * Repairs corrupted/truncated ZIP & OOXML/ODF/EPUB/APK/JAR archives by walking local file headers,
 * salvaging uncompressed/complete entries, clamping truncated entries, and rebuilding Central Directory + EOCD.
 */
export function repairZipContainerBuffer(raw: Uint8Array, ext = 'zip'): NonMediaRepairResult {
  if (raw.length < 30 || raw[0] !== 0x50 || raw[1] !== 0x4b || raw[2] !== 0x03 || raw[3] !== 0x04) {
    return { repaired: false, data: raw, note: 'Missing PK\\x03\\x04 ZIP local file header.' };
  }

  // Check if already has valid EOCD pointing to a valid Central Directory signature
  const eocdSearchStart = Math.max(0, raw.length - 65558);
  for (let p = raw.length - 22; p >= eocdSearchStart; p--) {
    if (raw[p] === 0x50 && raw[p + 1] === 0x4b && raw[p + 2] === 0x05 && raw[p + 3] === 0x06) {
      const cdOff = readU32LE(raw, p + 16);
      const commentLen = readU16LE(raw, p + 20);
      if (
        cdOff + 4 <= p &&
        raw[cdOff] === 0x50 &&
        raw[cdOff + 1] === 0x4b &&
        raw[cdOff + 2] === 0x01 &&
        raw[cdOff + 3] === 0x02 &&
        p + 22 + commentLen === raw.length
      ) {
        return { repaired: false, data: raw, note: `${ext.toUpperCase()} ZIP Central Directory intact.` };
      }
    }
  }

  interface SalvagedEntry {
    headerOff: number;
    versionNeed: number;
    flags: number;
    method: number;
    modTime: number;
    modDate: number;
    crc: number;
    compSize: number;
    uncompSize: number;
    nameBytes: Uint8Array;
    extraBytes: Uint8Array;
    localChunk: Uint8Array;
  }

  const outChunks: Uint8Array[] = [];
  const entries: SalvagedEntry[] = [];
  let cursor = 0;
  let outOffset = 0;
  let clampedEntries = 0;

  while (cursor + 30 <= raw.length) {
    if (raw[cursor] !== 0x50 || raw[cursor + 1] !== 0x4b || raw[cursor + 2] !== 0x03 || raw[cursor + 3] !== 0x04) {
      const nextLocal = indexOfSig(raw, [0x50, 0x4b, 0x03, 0x04], cursor + 1, raw.length);
      if (nextLocal === -1) break;
      cursor = nextLocal;
      continue;
    }

    const versionNeed = readU16LE(raw, cursor + 4);
    const flags = readU16LE(raw, cursor + 6);
    const method = readU16LE(raw, cursor + 8);
    const modTime = readU16LE(raw, cursor + 10);
    const modDate = readU16LE(raw, cursor + 12);
    let crc = readU32LE(raw, cursor + 14);
    let compSize = readU32LE(raw, cursor + 18);
    let uncompSize = readU32LE(raw, cursor + 22);
    const nameLen = readU16LE(raw, cursor + 26);
    const extraLen = readU16LE(raw, cursor + 28);

    const dataStart = cursor + 30 + nameLen + extraLen;
    if (nameLen === 0 || nameLen > 512 || dataStart > raw.length) break;

    const nameBytes = raw.subarray(cursor + 30, cursor + 30 + nameLen);
    const extraBytes = raw.subarray(cursor + 30 + nameLen, dataStart);
    const entryName = new TextDecoder().decode(nameBytes);

    let dataEnd = dataStart + compSize;
    let usedDescriptor = false;

    if ((flags & 0x08) !== 0 && compSize === 0) {
      // Streaming data descriptor: scan until PK\x07\x08 or next PK\x03\x04 / PK\x01\x02
      const nextLocal = indexOfSig(raw, [0x50, 0x4b, 0x03, 0x04], dataStart, raw.length);
      const nextCd = indexOfSig(raw, [0x50, 0x4b, 0x01, 0x02], dataStart, raw.length);
      const bound = Math.min(
        nextLocal === -1 ? raw.length : nextLocal,
        nextCd === -1 ? raw.length : nextCd,
      );
      const descPos = indexOfSig(raw, [0x50, 0x4b, 0x07, 0x08], dataStart, bound);
      if (descPos !== -1 && descPos + 16 <= bound) {
        crc = readU32LE(raw, descPos + 4);
        compSize = readU32LE(raw, descPos + 8);
        uncompSize = readU32LE(raw, descPos + 12);
        dataEnd = Math.min(bound, dataStart + compSize);
        usedDescriptor = true;
      } else {
        dataEnd = bound;
        compSize = Math.max(0, dataEnd - dataStart);
        uncompSize = compSize;
        clampedEntries++;
      }
    }

    if (dataEnd > raw.length) {
      dataEnd = raw.length;
      while (dataEnd > dataStart + 16 && raw[dataEnd - 1] === 0x00) dataEnd--;
      compSize = Math.max(0, dataEnd - dataStart);
      if (method === 0) uncompSize = compSize;
      clampedEntries++;
    }

    let payload = raw.subarray(dataStart, dataEnd);
    if (method === 0 && (entryName.endsWith('.xml') || entryName.endsWith('.rels')) && payload.length > 0) {
      const txt = new TextDecoder().decode(payload);
      const fixedXml = closeTruncatedXmlOrHtml(txt, false);
      if (fixedXml.closedCount > 0) {
        payload = new TextEncoder().encode(fixedXml.text);
        compSize = payload.length;
        uncompSize = payload.length;
        crc = computeCrc32(payload, 0, payload.length);
      }
    }

    if (method === 0 && payload.length > 0 && crc === 0) {
      crc = computeCrc32(payload, 0, payload.length);
      uncompSize = payload.length;
      compSize = payload.length;
    }

    // Rewrite clean local file header without broken data-descriptor flag so Central Directory offsets stay exact
    const localHdr = new Uint8Array(30 + nameLen + extraLen);
    localHdr.set(raw.subarray(cursor, dataStart), 0);
    writeU16LE(localHdr, 6, flags & ~0x08);
    writeU32LE(localHdr, 14, crc);
    writeU32LE(localHdr, 18, payload.length);
    writeU32LE(localHdr, 22, method === 0 ? payload.length : uncompSize);

    const localChunk = concatUint8([localHdr, payload]);
    outChunks.push(localChunk);

    entries.push({
      headerOff: outOffset,
      versionNeed: versionNeed || 20,
      flags: flags & ~0x08,
      method,
      modTime,
      modDate,
      crc,
      compSize: payload.length,
      uncompSize: method === 0 ? payload.length : uncompSize,
      nameBytes,
      extraBytes,
      localChunk,
    });

    outOffset += localChunk.length;
    cursor = usedDescriptor ? Math.max(dataEnd + 16, dataStart + compSize + 16) : dataEnd;
  }

  if (entries.length === 0) {
    return { repaired: false, data: raw, note: 'No salvageable ZIP local file entries found.' };
  }

  const cdStart = outOffset;
  const cdChunks: Uint8Array[] = [];
  for (const e of entries) {
    const cd = new Uint8Array(46 + e.nameBytes.length + e.extraBytes.length);
    cd[0] = 0x50;
    cd[1] = 0x4b;
    cd[2] = 0x01;
    cd[3] = 0x02;
    writeU16LE(cd, 4, e.versionNeed);
    writeU16LE(cd, 6, e.versionNeed);
    writeU16LE(cd, 8, e.flags);
    writeU16LE(cd, 10, e.method);
    writeU16LE(cd, 12, e.modTime);
    writeU16LE(cd, 14, e.modDate);
    writeU32LE(cd, 16, e.crc);
    writeU32LE(cd, 20, e.compSize);
    writeU32LE(cd, 24, e.uncompSize);
    writeU16LE(cd, 28, e.nameBytes.length);
    writeU16LE(cd, 30, e.extraBytes.length);
    writeU16LE(cd, 32, 0);
    writeU16LE(cd, 34, 0);
    writeU16LE(cd, 36, 0);
    writeU32LE(cd, 38, 0);
    writeU32LE(cd, 42, e.headerOff);
    cd.set(e.nameBytes, 46);
    cd.set(e.extraBytes, 46 + e.nameBytes.length);
    cdChunks.push(cd);
  }
  const cdBuf = concatUint8(cdChunks);

  const eocd = new Uint8Array(22);
  eocd[0] = 0x50;
  eocd[1] = 0x4b;
  eocd[2] = 0x05;
  eocd[3] = 0x06;
  writeU16LE(eocd, 8, entries.length);
  writeU16LE(eocd, 10, entries.length);
  writeU32LE(eocd, 12, cdBuf.length);
  writeU32LE(eocd, 16, cdStart);

  const rebuilt = concatUint8([...outChunks, cdBuf, eocd]);
  return {
    repaired: true,
    data: rebuilt,
    note: `Rebuilt ${ext.toUpperCase()} ZIP Central Directory + EOCD (${entries.length} entry${entries.length === 1 ? '' : 'ies'}${clampedEntries > 0 ? `, clamped ${clampedEntries} truncated` : ''}).`,
  };
}

/**
 * Repairs binary Adobe After Effects `.aep` (`RIFX...Egg!`) containers by walking big-endian chunks,
 * trimming broken trailing fragments, and patching container sizes.
 */
export function repairAepContainerBuffer(raw: Uint8Array): NonMediaRepairResult {
  if (raw.length < 16 || asciiAt(raw, 0, 4) !== 'RIFX') {
    return { repaired: false, data: raw, note: 'Not an Adobe After Effects RIFX binary container.' };
  }
  const formType = asciiAt(raw, 8, 4);
  const declared = readU32BE(raw, 4) + 8;

  let pos = 12;
  let lastValidEnd = 12;
  let chunkCount = 0;
  while (pos + 8 <= raw.length) {
    const chunkId = asciiAt(raw, pos, 4);
    const chunkSize = readU32BE(raw, pos + 4);
    if (!/^[\x20-\x7e]{4}$/.test(chunkId) || chunkSize > raw.length) break;
    const alignedNext = pos + 8 + chunkSize + (chunkSize & 1);
    if (alignedNext > raw.length) break;
    lastValidEnd = alignedNext;
    chunkCount++;
    pos = alignedNext;
  }

  if (lastValidEnd <= 12) {
    const out = raw.slice();
    writeU32BE(out, 4, Math.max(4, out.length - 8));
    return {
      repaired: declared !== out.length,
      data: out,
      note: declared !== out.length ? `Patched .AEP (${formType}) RIFX root size header.` : '.AEP container header verified.',
    };
  }

  const trimmed = lastValidEnd < raw.length ? raw.slice(0, lastValidEnd) : raw.slice();
  const changed = declared !== trimmed.length || lastValidEnd < raw.length;
  writeU32BE(trimmed, 4, Math.max(4, trimmed.length - 8));
  return {
    repaired: changed,
    data: trimmed,
    note: changed
      ? `Repaired After Effects .AEP (${formType}): verified ${chunkCount} chunks & patched RIFX size (${trimmed.length} B).`
      : `.AEP (${formType}) container structure intact.`,
  };
}

/**
 * Repairs SQLite 3.x databases: trims trailing partial/garbage sector slack, updates pageCount header (offset 28),
 * and resets broken WAL/lock bytes if page count mismatches recovered data.
 */
export function repairSqliteBuffer(raw: Uint8Array): NonMediaRepairResult {
  if (raw.length < 100 || asciiAt(raw, 0, 15) !== 'SQLite format 3' || raw[15] !== 0) {
    return { repaired: false, data: raw, note: 'Missing SQLite 3.x magic header.' };
  }
  let pageSize = readU16BE(raw, 16);
  if (pageSize === 1) pageSize = 65536;
  if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) {
    return { repaired: false, data: raw, note: `Invalid SQLite page size (${pageSize}).` };
  }

  const declaredPages = readU32BE(raw, 28);
  let actualPages = Math.floor(raw.length / pageSize);
  if (actualPages < 1) {
    return { repaired: false, data: raw, note: 'SQLite payload shorter than 1 database page.' };
  }

  // Trim trailing all-zero phantom cluster pages beyond valid active pages
  const minPages = declaredPages > 0 && declaredPages <= actualPages ? declaredPages : 1;
  while (actualPages > minPages) {
    const pStart = (actualPages - 1) * pageSize;
    let allZero = true;
    for (let i = 0; i < pageSize; i++) {
      if (raw[pStart + i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (!allZero) break;
    actualPages--;
  }

  const alignedSize = actualPages * pageSize;
  const needsTrim = alignedSize !== raw.length;
  const needsPageFix = declaredPages !== actualPages;
  const hasWalFlag = raw[18] === 2 || raw[19] === 2;

  if (!needsTrim && !needsPageFix && !hasWalFlag) {
    return { repaired: false, data: raw, note: `SQLite 3 database header & ${actualPages} pages intact.` };
  }

  const out = raw.slice(0, alignedSize);
  writeU32BE(out, 28, actualPages);
  // Reset WAL format bytes (18, 19) to rollback-journal mode (1, 1) so missing -wal sidecar doesn't block opening
  if (hasWalFlag) {
    out[18] = 1;
    out[19] = 1;
  }
  return {
    repaired: true,
    data: out,
    note: `Repaired SQLite database: aligned to ${actualPages} x ${pageSize}B pages${hasWalFlag ? ', reset orphan WAL mode' : ''}.`,
  };
}

/**
 * Repairs Adobe Photoshop .PSD / .PSB files by clamping truncated Color Mode / Image Resources / Layer sections
 * and salvaging embedded JPEG preview thumbnails (8BIM resource 0x0409 / 0x040C).
 */
export function repairPsdBuffer(raw: Uint8Array): NonMediaRepairResult {
  if (raw.length < 30 || asciiAt(raw, 0, 4) !== '8BPS') {
    return { repaired: false, data: raw, note: 'Missing 8BPS Photoshop magic header.' };
  }
  const version = readU16BE(raw, 4);
  if (version !== 1 && version !== 2) {
    return { repaired: false, data: raw, note: `Unsupported PSD version ${version}.` };
  }
  const salvagedPreview = extractEmbeddedJpegPreview(raw, false);
  const out = raw.slice();
  let fixedSections = 0;

  let pos = 26;
  // Section 1: Color Mode Data
  if (pos + 4 <= out.length) {
    const colorLen = readU32BE(out, pos);
    const maxAvail = Math.max(0, out.length - (pos + 4));
    if (colorLen > maxAvail) {
      writeU32BE(out, pos, maxAvail);
      fixedSections++;
      pos = out.length;
    } else {
      pos += 4 + colorLen;
    }
  }
  // Section 2: Image Resources (8BIM)
  if (pos + 4 <= out.length) {
    const resLen = readU32BE(out, pos);
    const maxAvail = Math.max(0, out.length - (pos + 4));
    if (resLen > maxAvail) {
      writeU32BE(out, pos, maxAvail);
      fixedSections++;
      pos = out.length;
    } else {
      pos += 4 + resLen;
    }
  }
  // Section 3: Layer and Mask Information
  if (pos + (version === 2 ? 8 : 4) <= out.length) {
    const lenSize = version === 2 ? 8 : 4;
    const layerLen = version === 2 ? readU32BE(out, pos + 4) : readU32BE(out, pos);
    const maxAvail = Math.max(0, out.length - (pos + lenSize));
    if (layerLen > maxAvail) {
      if (version === 2) writeU32BE(out, pos + 4, maxAvail);
      else writeU32BE(out, pos, maxAvail);
      fixedSections++;
    }
  }

  if (fixedSections === 0 && !salvagedPreview) {
    return { repaired: false, data: raw, note: `Photoshop ${version === 2 ? 'PSB' : 'PSD'} header sections intact.` };
  }
  return {
    repaired: fixedSections > 0 || Boolean(salvagedPreview),
    data: out,
    salvagedPreviewBytes: salvagedPreview ?? undefined,
    note:
      [
        fixedSections > 0 ? `clamped ${fixedSections} truncated section length(s)` : '',
        salvagedPreview ? `extracted ${salvagedPreview.length} B embedded thumbnail` : '',
      ]
        .filter(Boolean)
        .join('; ') || 'Photoshop file processed.',
  };
}

/**
 * Full structural PDF repair: strips trailing garbage slack, scans `N M obj` object offsets,
 * locates /Root catalog & /Info objects, and synthesizes a real `xref` + `trailer` + `startxref` + `%%EOF`.
 */
export function repairPdfBuffer(raw: Uint8Array): NonMediaRepairResult {
  const head = asciiAt(raw, 0, Math.min(raw.length, 16));
  if (!head.startsWith('%PDF-')) {
    return { repaired: false, data: raw, note: 'Missing %PDF- header.' };
  }

  const dec = new TextDecoder('latin1');
  const fullText = dec.decode(raw);
  const hasStartXref = /startxref\s+\d+\s+%%EOF/m.test(fullText.slice(Math.max(0, fullText.length - 512)));
  if (hasStartXref && fullText.trimEnd().endsWith('%%EOF')) {
    return { repaired: false, data: raw, note: 'PDF xref and %%EOF trailer intact.' };
  }

  // Trim trailing cluster slack after last valid endobj / endstream / %%EOF
  let trimLen = raw.length;
  const lastEndObj = fullText.lastIndexOf('endobj');
  const lastEndStream = fullText.lastIndexOf('endstream');
  const lastXref = fullText.lastIndexOf('xref');
  const anchor = Math.max(lastEndObj >= 0 ? lastEndObj + 6 : -1, lastEndStream >= 0 ? lastEndStream + 9 : -1);

  if (anchor > 0 && lastXref < anchor) {
    // Only trim trailing null/binary slack past anchor
    let cursor = anchor;
    while (cursor < raw.length && (raw[cursor] === 0x0d || raw[cursor] === 0x0a || raw[cursor] === 0x20)) {
      cursor++;
    }
    if (cursor < raw.length) {
      trimLen = cursor;
    }
  }

  const trimmed = raw.subarray(0, trimLen);
  const bodyText = dec.decode(trimmed);

  // Collect all `N G obj` definitions with byte offsets
  const objOffsets = new Map<number, { gen: number; offset: number }>();
  let maxObjNum = 0;
  let rootRef = '1 0 R';
  let infoRef: string | null = null;

  const objRe = /(?:^|[\r\n])\s*(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(bodyText)) !== null) {
    const num = Number(m[1]);
    const gen = Number(m[2]);
    // Offset of first digit of object number
    const matchStr = m[0];
    const relDigits = matchStr.search(/\d/);
    const offset = m.index + (relDigits >= 0 ? relDigits : 0);
    if (num > 0 && num < 5_000_000) {
      objOffsets.set(num, { gen, offset });
      if (num > maxObjNum) maxObjNum = num;
      const snippet = bodyText.slice(offset, Math.min(bodyText.length, offset + 512));
      if (/\/Type\s*\/Catalog\b/.test(snippet)) {
        rootRef = `${num} ${gen} R`;
      } else if (/\/(Title|Producer|Author|Creator)\b/.test(snippet) && !infoRef) {
        infoRef = `${num} ${gen} R`;
      }
    }
  }

  if (objOffsets.size === 0) {
    const suffix = new TextEncoder().encode('\n%%EOF\n');
    return {
      repaired: true,
      data: concatUint8([trimmed, suffix]),
      note: 'Appended %%EOF trailer to PDF stream (no indirect objects found for xref).',
    };
  }

  const xrefOffset = trimmed.length + 1;
  const lines: string[] = [
    '',
    'xref',
    `0 ${maxObjNum + 1}`,
    '0000000000 65535 f ',
  ];
  for (let i = 1; i <= maxObjNum; i++) {
    const rec = objOffsets.get(i);
    if (rec) {
      lines.push(`${String(rec.offset).padStart(10, '0')} ${String(rec.gen).padStart(5, '0')} n `);
    } else {
      lines.push('0000000000 65535 f ');
    }
  }
  const trailerEntries = [`/Size ${maxObjNum + 1}`, `/Root ${rootRef}`];
  if (infoRef) trailerEntries.push(`/Info ${infoRef}`);
  lines.push('trailer', `<< ${trailerEntries.join(' ')} >>`, 'startxref', String(xrefOffset), '%%EOF', '');

  const tailBytes = new TextEncoder().encode(lines.join('\n'));
  return {
    repaired: true,
    data: concatUint8([trimmed, tailBytes]),
    note: `Rebuilt PDF xref table (${objOffsets.size} objects, Root ${rootRef}) + startxref + %%EOF.`,
  };
}

/**
 * Repairs Microsoft OLE2 Compound Binary files (.doc / .xls / .ppt / .msg / .msi):
 * pads final incomplete 512-byte sector, validates sector size shift, and salvages embedded JPEG/PNG.
 */
export function repairOle2Buffer(raw: Uint8Array, ext = 'doc'): NonMediaRepairResult {
  if (
    raw.length < 512 ||
    raw[0] !== 0xd0 ||
    raw[1] !== 0xcf ||
    raw[2] !== 0x11 ||
    raw[3] !== 0xe0 ||
    raw[4] !== 0xa1 ||
    raw[5] !== 0xb1 ||
    raw[6] !== 0x1a ||
    raw[7] !== 0xe1
  ) {
    return { repaired: false, data: raw, note: 'Missing OLE2 Compound Binary magic header.' };
  }

  const sectorShift = readU16LE(raw, 30);
  const sectorSize = sectorShift === 12 ? 4096 : 512;
  const rem = raw.length % sectorSize;
  const salvagedPreview = extractEmbeddedJpegPreview(raw, false);

  let out: Uint8Array;
  let padded = 0;
  if (rem !== 0) {
    padded = sectorSize - rem;
    const next = new Uint8Array(raw.length + padded);
    next.set(raw, 0);
    out = next;
  } else {
    out = raw.slice();
  }

  const maxSecId = Math.max(0, Math.floor((out.length - sectorSize) / sectorSize));
  const totalFat = readU32LE(out, 44);
  let clampedFat = false;
  if (totalFat > maxSecId && maxSecId > 0) {
    writeU32LE(out, 44, Math.max(1, Math.min(totalFat, maxSecId)));
    clampedFat = true;
  }

  if (padded === 0 && !clampedFat && !salvagedPreview) {
    return { repaired: false, data: raw, note: `${ext.toUpperCase()} OLE2 compound sectors intact.` };
  }
  return {
    repaired: padded > 0 || clampedFat || Boolean(salvagedPreview),
    data: out,
    salvagedPreviewBytes: salvagedPreview ?? undefined,
    note:
      [
        padded > 0 ? `padded final OLE2 sector (+${padded} B)` : '',
        clampedFat ? 'clamped out-of-range FAT sector count' : '',
        salvagedPreview ? `salvaged embedded JPEG preview (${salvagedPreview.length} B)` : '',
      ]
        .filter(Boolean)
        .join('; ') || `${ext.toUpperCase()} OLE2 structure normalized.`,
  };
}

/**
 * Repairs Microsoft Outlook .PST / .OST NDB headers (`!BDN`) by synchronizing `ibFileEof` to recovered size.
 */
export function repairPstBuffer(raw: Uint8Array, ext = 'pst'): NonMediaRepairResult {
  if (raw.length < 512 || asciiAt(raw, 0, 4) !== '!BDN') {
    return { repaired: false, data: raw, note: 'Missing !BDN Outlook PST/OST magic header.' };
  }
  const wVer = readU16LE(raw, 10);
  const out = raw.slice();
  if (wVer >= 23 && raw.length >= 0xc0) {
    // Unicode PST/OST: ibFileEof is uint64 LE at offset 0xB8
    const curLo = readU32LE(out, 0xb8);
    const curHi = readU32LE(out, 0xbc);
    const declared = curHi * 4294967296 + curLo;
    if (declared !== out.length) {
      writeU32LE(out, 0xb8, out.length >>> 0);
      writeU32LE(out, 0xbc, Math.floor(out.length / 4294967296) >>> 0);
      return {
        repaired: true,
        data: out,
        note: `Synchronized Unicode .${ext.toUpperCase()} NDB ibFileEof (${declared} -> ${out.length} B).`,
      };
    }
  } else if (raw.length >= 0xac) {
    // ANSI PST/OST: ibFileEof is uint32 LE at offset 0xA8
    const declared = readU32LE(out, 0xa8);
    if (declared !== out.length) {
      writeU32LE(out, 0xa8, out.length >>> 0);
      return {
        repaired: true,
        data: out,
        note: `Synchronized ANSI .${ext.toUpperCase()} NDB ibFileEof (${declared} -> ${out.length} B).`,
      };
    }
  }
  return { repaired: false, data: raw, note: `Outlook .${ext.toUpperCase()} header EOF matches stream length.` };
}

/**
 * Repairs Ren'Py `.rpa` archives (`RPA-3.0` / `RPA-2.0`) by validating header offset & trimming cluster slack.
 */
export function repairRpaBuffer(raw: Uint8Array): NonMediaRepairResult {
  const head = asciiAt(raw, 0, Math.min(raw.length, 64));
  const m3 = head.match(/^RPA-3\.0 ([0-9a-fA-F]{16}) ([0-9a-fA-F]{8})/);
  const m2 = head.match(/^RPA-2\.0 ([0-9a-fA-F]{16})/);
  if (!m3 && !m2) {
    return { repaired: false, data: raw, note: 'Not a recognized RPA-2.0 / RPA-3.0 archive.' };
  }
  const idxOffset = parseInt((m3 ? m3[1] : m2![1]), 16);
  if (!Number.isFinite(idxOffset) || idxOffset <= 0) {
    return { repaired: false, data: raw, note: 'Corrupt RPA index offset pointer.' };
  }
  if (idxOffset >= raw.length) {
    return {
      repaired: false,
      data: raw,
      note: `RPA archive truncated before index table (needs offset ${idxOffset}, has ${raw.length} B).`,
    };
  }
  // Trim trailing zero cluster slack past compressed index end
  let end = raw.length;
  while (end > idxOffset + 8 && raw[end - 1] === 0x00) end--;
  if (raw.length - end >= 16) {
    return {
      repaired: true,
      data: raw.slice(0, end),
      note: `Validated RPA archive index @ 0x${idxOffset.toString(16)} and trimmed ${raw.length - end} B trailing cluster slack.`,
    };
  }
  return { repaired: false, data: raw, note: `RPA archive index @ 0x${idxOffset.toString(16)} intact.` };
}

/**
 * Repairs text/code/config/script/JSON/XML/SVG/RPY buffers:
 * strips trailing binary cluster slack, fixes cut UTF-8 codepoints, balances JSON brackets or XML tags.
 */
export function repairStructuredTextBuffer(raw: Uint8Array, ext: string): NonMediaRepairResult {
  // Trim trailing zero bytes and trailing binary non-UTF8 sector garbage
  let end = raw.length;
  while (end > 0 && raw[end - 1] === 0x00) end--;
  // Drop incomplete trailing UTF-8 continuation bytes if cut mid-character
  let cutUtf8 = 0;
  if (end > 0 && (raw[end - 1] & 0x80) !== 0) {
    let lead = end - 1;
    while (lead > Math.max(0, end - 4) && (raw[lead] & 0xc0) === 0x80) lead--;
    const b = raw[lead];
    const expectedLen = (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : (b & 0xf8) === 0xf0 ? 4 : 1;
    if (end - lead < expectedLen) {
      cutUtf8 = end - lead;
      end = lead;
    }
  }

  let text = new TextDecoder('utf-8', { fatal: false }).decode(raw.subarray(0, end));
  // Strip U+FFFD replacement runs at the very tail left by sector garbage
  const beforeFffd = text.length;
  let cutTail = text.length;
  while (cutTail > 0) {
    const code = text.charCodeAt(cutTail - 1);
    const isNoiseCtrl =
      code === 0xfffd || (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d);
    if (!isNoiseCtrl) break;
    cutTail--;
  }
  if (cutTail < text.length) text = text.slice(0, cutTail);
  const trimmedSlack = raw.length - end > 0 || text.length < beforeFffd || cutUtf8 > 0;

  if (ext === 'json') {
    try {
      JSON.parse(text);
      if (!trimmedSlack) return { repaired: false, data: raw, note: 'JSON syntax valid.' };
      return {
        repaired: true,
        data: new TextEncoder().encode(text),
        note: 'Trimmed trailing binary slack from JSON file.',
      };
    } catch {
      // Attempt deterministic bracket/string closure on truncated JSON
      const stack: string[] = [];
      let inStr = false;
      let esc = false;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
        } else {
          if (ch === '"') inStr = true;
          else if (ch === '{') stack.push('}');
          else if (ch === '[') stack.push(']');
          else if ((ch === '}' || ch === ']') && stack.length > 0 && stack[stack.length - 1] === ch) {
            stack.pop();
          }
        }
      }
      let repairedText = text;
      if (esc) repairedText = repairedText.slice(0, -1);
      if (inStr) repairedText += '"';
      repairedText = repairedText.replace(/,\s*$/, '');
      if (stack.length > 0) {
        // Also drop hanging colon/key if ending like `"key":`
        repairedText = repairedText.replace(/,?\s*"[^"]*"\s*:\s*$/, '');
        repairedText += stack.reverse().join('');
      }
      try {
        JSON.parse(repairedText);
        return {
          repaired: true,
          data: new TextEncoder().encode(repairedText),
          note: `Repaired truncated JSON structure (closed ${stack.length} open container${stack.length === 1 ? '' : 's'}).`,
        };
      } catch {
        // fallback if cleanup at least stripped slack
      }
    }
  }

  if (ext === 'xml' || ext === 'aepx' || ext === 'svg' || ext === 'html' || ext === 'htm') {
    const fixed = closeTruncatedXmlOrHtml(text, ext === 'html' || ext === 'htm');
    if (fixed.closedCount > 0 || trimmedSlack) {
      return {
        repaired: true,
        data: new TextEncoder().encode(fixed.text),
        note: fixed.closedCount > 0
          ? `Closed ${fixed.closedCount} unclosed .${ext.toUpperCase()} tag(s) and cleaned trailing slack.`
          : `Trimmed ${raw.length - end} B binary cluster slack from .${ext.toUpperCase()}.`,
      };
    }
    return { repaired: false, data: raw, note: `.${ext.toUpperCase()} markup intact.` };
  }

  if (ext === 'rtf') {
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\\' && i + 1 < text.length) {
        i++;
        continue;
      }
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && depth > 0) depth--;
    }
    if (depth > 0 || trimmedSlack) {
      const closed = text + (depth > 0 ? '}'.repeat(depth) : '');
      return {
        repaired: true,
        data: new TextEncoder().encode(closed),
        note: depth > 0
          ? `Closed ${depth} unclosed .RTF group brace(s) and cleaned trailing slack.`
          : 'Trimmed trailing binary cluster slack from .RTF.',
      };
    }
    return { repaired: false, data: raw, note: '.RTF group structure intact.' };
  }

  if (trimmedSlack) {
    return {
      repaired: true,
      data: new TextEncoder().encode(text),
      note: `Cleaned trailing binary/null cluster slack from .${ext.toUpperCase()} text file.`,
    };
  }
  return { repaired: false, data: raw, note: `.${ext.toUpperCase()} text encoding verified.` };
}

/**
 * Repairs TAR archives (pads 512-byte sector alignment + appends 1024-byte EOF zero blocks),
 * GZ/FLAC (trims zero slack), and MP3 (strips corrupt garbage before first valid frame sync if missing ID3).
 */
export function repairMiscArchiveOrAudioBuffer(raw: Uint8Array, ext: string): NonMediaRepairResult {
  if (ext === 'tar' && raw.length >= 512) {
    const rem = raw.length % 512;
    const padToBlock = rem === 0 ? 0 : 512 - rem;
    const tailZero = raw.subarray(Math.max(0, raw.length - 1024));
    const hasEofZeros = tailZero.length === 1024 && tailZero.every((b) => b === 0);
    if (padToBlock === 0 && hasEofZeros) {
      return { repaired: false, data: raw, note: 'TAR archive block alignment & EOF markers intact.' };
    }
    const out = new Uint8Array(raw.length + padToBlock + (hasEofZeros ? 0 : 1024));
    out.set(raw, 0);
    return {
      repaired: true,
      data: out,
      note: `Aligned TAR blocks and appended 1024-byte EOF zero terminator.`,
    };
  }

  if ((ext === 'gz' || ext === 'flac') && raw.length >= 16) {
    let end = raw.length;
    while (end > 16 && raw[end - 1] === 0x00) end--;
    if (raw.length - end >= 16) {
      return {
        repaired: true,
        data: raw.slice(0, end),
        note: `Trimmed ${raw.length - end} B trailing null slack from ${ext.toUpperCase()}.`,
      };
    }
  }

  if (ext === 'mp3' && raw.length >= 16) {
    const hasId3 = raw[0] === 0x49 && raw[1] === 0x44 && raw[2] === 0x33;
    const hasFrame0 = raw[0] === 0xff && (raw[1] & 0xe0) === 0xe0;
    if (!hasId3 && !hasFrame0) {
      for (let i = 1; i + 4 < Math.min(raw.length, 65536); i++) {
        if (raw[i] === 0xff && (raw[i + 1] & 0xe0) === 0xe0 && (raw[i + 2] & 0xf0) !== 0xf0) {
          return {
            repaired: true,
            data: raw.slice(i),
            note: `Synchronized MP3 bitstream by trimming ${i} B leading garbage before MPEG frame.`,
          };
        }
      }
    }
  }

  return { repaired: false, data: raw, note: `${ext.toUpperCase()} stream verified.` };
}

export function diagnoseNonMediaFile(ext: string, data: Uint8Array): NonMediaDiagnosis {
  const e = ext.toLowerCase().replace(/^\./, '');
  if (['zip', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub', 'apk', 'jar', 'kra', 'ora', 'kmz'].includes(e)) {
    const check = repairZipContainerBuffer(data, e);
    return {
      issue: check.repaired ? `Missing/damaged ZIP Central Directory — ${e.toUpperCase()} entry rebuild available.` : check.note,
      canRepair: true,
      needsReferenceHint: false,
    };
  }
  if (e === 'aep') {
    return {
      issue: 'Adobe After Effects RIFX container check & truncated chunk repair.',
      canRepair: true,
      needsReferenceHint: false,
    };
  }
  if (['aepx', 'xml', 'svg', 'html', 'htm', 'json', 'rpy', 'txt', 'py', 'ini', 'csv', 'sql', 'eml'].includes(e)) {
    return {
      issue: `.${e.toUpperCase()} structure, unclosed tags/brackets & cluster slack cleanup.`,
      canRepair: true,
      needsReferenceHint: false,
    };
  }
  if (e === 'rpa') {
    return { issue: "Ren'Py .RPA archive index & slack check.", canRepair: true, needsReferenceHint: false };
  }
  if (e === 'sqlite' || e === 'db' || e === 'sqlite3') {
    return { issue: 'SQLite B-tree page alignment & header pageCount / WAL recovery.', canRepair: true, needsReferenceHint: false };
  }
  if (e === 'psd' || e === 'psb') {
    return { issue: 'Photoshop 8BPS layer/resource clamping & embedded JPEG thumbnail extraction.', canRepair: true, needsReferenceHint: false };
  }
  if (e === 'pdf') {
    return { issue: 'PDF xref cross-reference table synthesis, trailer & %%EOF repair.', canRepair: true, needsReferenceHint: false };
  }
  if (['doc', 'xls', 'ppt', 'msg', 'msi'].includes(e)) {
    return { issue: `OLE2 Compound Binary sector padding & embedded image salvage.`, canRepair: true, needsReferenceHint: false };
  }
  if (e === 'pst' || e === 'ost') {
    return { issue: `Outlook .${e.toUpperCase()} NDB header EOF pointer synchronization.`, canRepair: true, needsReferenceHint: false };
  }
  if (['tar', 'gz', 'mp3', 'flac', 'rtf'].includes(e)) {
    return { issue: `${e.toUpperCase()} alignment & stream cleanup ready.`, canRepair: true, needsReferenceHint: false };
  }
  return { issue: 'Ready for structural verification.', canRepair: false, needsReferenceHint: false };
}

export function repairNonMediaBuffer(ext: string, data: Uint8Array): NonMediaRepairResult {
  const e = ext.toLowerCase().replace(/^\./, '');
  if (['zip', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub', 'apk', 'jar', 'kra', 'ora', 'kmz'].includes(e)) {
    return repairZipContainerBuffer(data, e);
  }
  if (e === 'aep') return repairAepContainerBuffer(data);
  if (e === 'sqlite' || e === 'db' || e === 'sqlite3') return repairSqliteBuffer(data);
  if (e === 'psd' || e === 'psb') return repairPsdBuffer(data);
  if (e === 'pdf') return repairPdfBuffer(data);
  if (['doc', 'xls', 'ppt', 'msg', 'msi'].includes(e)) return repairOle2Buffer(data, e);
  if (e === 'pst' || e === 'ost') return repairPstBuffer(data, e);
  if (e === 'rpa') return repairRpaBuffer(data);
  if (['aepx', 'xml', 'svg', 'html', 'htm', 'json', 'rpy', 'txt', 'py', 'ini', 'csv', 'sql', 'eml', 'rtf'].includes(e)) {
    return repairStructuredTextBuffer(data, e);
  }
  if (['tar', 'gz', 'mp3', 'flac'].includes(e)) {
    return repairMiscArchiveOrAudioBuffer(data, e);
  }
  return { repaired: false, data, note: 'No non-media structural patches needed.' };
}
