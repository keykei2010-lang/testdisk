'use strict';

const { extractEmbeddedJpegCjs } = require('./mediaRepairCjs.cjs');

const CRC32_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[n] = c >>> 0;
}

function crc32Cjs(buf, start = 0, len = buf.length - start) {
  let crc = 0xffffffff;
  const end = Math.min(buf.length, start + len);
  for (let i = start; i < end; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function closeTruncatedXmlOrHtmlCjs(rawText, isHtml = false) {
  let text = rawText.replace(/\0+$/g, '');
  const lastLt = text.lastIndexOf('<');
  const lastGt = text.lastIndexOf('>');
  if (lastLt > lastGt && lastLt !== -1) text = text.slice(0, lastLt);
  const voidTags = isHtml
    ? new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
    : new Set();
  const stack = [];
  const tagRe = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/?\s*([A-Za-z_][\w:.-]*)([^>]*)>/g;
  let m;
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
  if (stack.length === 0) return { text, closedCount: 0 };
  const closing = stack.reverse().map((t) => `</${t}>`).join('');
  return { text: `${text}${closing}`, closedCount: stack.length };
}

function repairZipContainerCjs(raw, ext = 'zip') {
  if (!raw || raw.length < 30 || raw[0] !== 0x50 || raw[1] !== 0x4b || raw[2] !== 0x03 || raw[3] !== 0x04) {
    return null;
  }
  const eocdSearchStart = Math.max(0, raw.length - 65558);
  for (let p = raw.length - 22; p >= eocdSearchStart; p--) {
    if (raw[p] === 0x50 && raw[p + 1] === 0x4b && raw[p + 2] === 0x05 && raw[p + 3] === 0x06) {
      const cdOff = raw.readUInt32LE(p + 16);
      const commentLen = raw.readUInt16LE(p + 20);
      if (
        cdOff + 4 <= p &&
        raw[cdOff] === 0x50 &&
        raw[cdOff + 1] === 0x4b &&
        raw[cdOff + 2] === 0x01 &&
        raw[cdOff + 3] === 0x02 &&
        p + 22 + commentLen === raw.length
      ) {
        return null;
      }
    }
  }

  const outChunks = [];
  const entries = [];
  let cursor = 0;
  let outOffset = 0;
  let clamped = 0;
  const sigLocal = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const sigCd = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const sigDesc = Buffer.from([0x50, 0x4b, 0x07, 0x08]);

  while (cursor + 30 <= raw.length) {
    if (raw[cursor] !== 0x50 || raw[cursor + 1] !== 0x4b || raw[cursor + 2] !== 0x03 || raw[cursor + 3] !== 0x04) {
      const next = raw.indexOf(sigLocal, cursor + 1);
      if (next === -1) break;
      cursor = next;
      continue;
    }
    const verNeed = raw.readUInt16LE(cursor + 4) || 20;
    const flags = raw.readUInt16LE(cursor + 6);
    const method = raw.readUInt16LE(cursor + 8);
    const modTime = raw.readUInt16LE(cursor + 10);
    const modDate = raw.readUInt16LE(cursor + 12);
    let crc = raw.readUInt32LE(cursor + 14);
    let compSize = raw.readUInt32LE(cursor + 18);
    let uncompSize = raw.readUInt32LE(cursor + 22);
    const nameLen = raw.readUInt16LE(cursor + 26);
    const extraLen = raw.readUInt16LE(cursor + 28);
    const dataStart = cursor + 30 + nameLen + extraLen;
    if (nameLen === 0 || nameLen > 512 || dataStart > raw.length) break;

    const nameBuf = raw.subarray(cursor + 30, cursor + 30 + nameLen);
    const extraBuf = raw.subarray(cursor + 30 + nameLen, dataStart);
    const entryName = nameBuf.toString('utf8');

    let dataEnd = dataStart + compSize;
    let descriptorNextPos = -1;
    if ((flags & 0x08) !== 0 && compSize === 0) {
      const nLoc = raw.indexOf(sigLocal, dataStart);
      const nCd = raw.indexOf(sigCd, dataStart);
      const bound = Math.min(nLoc === -1 ? raw.length : nLoc, nCd === -1 ? raw.length : nCd);
      const dPos = raw.indexOf(sigDesc, dataStart);
      if (dPos !== -1 && dPos + 16 <= bound) {
        crc = raw.readUInt32LE(dPos + 4);
        compSize = raw.readUInt32LE(dPos + 8);
        uncompSize = raw.readUInt32LE(dPos + 12);
        dataEnd = Math.min(bound, dataStart + compSize);
        descriptorNextPos = Math.max(dPos + 16, dataEnd);
      } else {
        dataEnd = bound;
        compSize = Math.max(0, dataEnd - dataStart);
        uncompSize = compSize;
        clamped++;
      }
    }

    if (dataEnd > raw.length) {
      dataEnd = raw.length;
      while (dataEnd > dataStart + 16 && raw[dataEnd - 1] === 0x00) dataEnd--;
      compSize = Math.max(0, dataEnd - dataStart);
      if (method === 0) uncompSize = compSize;
      clamped++;
    }

    let payload = raw.subarray(dataStart, dataEnd);
    if (method === 0 && (entryName.endsWith('.xml') || entryName.endsWith('.rels')) && payload.length > 0) {
      const fixedXml = closeTruncatedXmlOrHtmlCjs(payload.toString('utf8'), false);
      if (fixedXml.closedCount > 0) {
        payload = Buffer.from(fixedXml.text, 'utf8');
        compSize = payload.length;
        uncompSize = payload.length;
        crc = crc32Cjs(payload, 0, payload.length);
      }
    }
    if (method === 0 && payload.length > 0 && crc === 0) {
      crc = crc32Cjs(payload, 0, payload.length);
      compSize = payload.length;
      uncompSize = payload.length;
    }

    const localHdr = Buffer.from(raw.subarray(cursor, dataStart));
    localHdr.writeUInt16LE(flags & ~0x08, 6);
    localHdr.writeUInt32LE(crc >>> 0, 14);
    localHdr.writeUInt32LE(payload.length >>> 0, 18);
    localHdr.writeUInt32LE((method === 0 ? payload.length : uncompSize) >>> 0, 22);

    outChunks.push(localHdr, payload);
    entries.push({
      headerOff: outOffset,
      verNeed,
      flags: flags & ~0x08,
      method,
      modTime,
      modDate,
      crc,
      compSize: payload.length,
      uncompSize: method === 0 ? payload.length : uncompSize,
      nameBuf,
      extraBuf,
    });
    outOffset += localHdr.length + payload.length;
    cursor = descriptorNextPos !== -1 ? descriptorNextPos : dataEnd;
  }

  if (entries.length === 0) return null;
  const cdStart = outOffset;
  const cdChunks = [];
  for (const e of entries) {
    const cd = Buffer.alloc(46 + e.nameBuf.length + e.extraBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(e.verNeed, 4);
    cd.writeUInt16LE(e.verNeed, 6);
    cd.writeUInt16LE(e.flags, 8);
    cd.writeUInt16LE(e.method, 10);
    cd.writeUInt16LE(e.modTime, 12);
    cd.writeUInt16LE(e.modDate, 14);
    cd.writeUInt32LE(e.crc >>> 0, 16);
    cd.writeUInt32LE(e.compSize >>> 0, 20);
    cd.writeUInt32LE(e.uncompSize >>> 0, 24);
    cd.writeUInt16LE(e.nameBuf.length, 28);
    cd.writeUInt16LE(e.extraBuf.length, 30);
    cd.writeUInt32LE(e.headerOff >>> 0, 42);
    e.nameBuf.copy(cd, 46);
    e.extraBuf.copy(cd, 46 + e.nameBuf.length);
    cdChunks.push(cd);
  }
  const cdBuf = Buffer.concat(cdChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length >>> 0, 12);
  eocd.writeUInt32LE(cdStart >>> 0, 16);

  return {
    data: Buffer.concat([...outChunks, cdBuf, eocd]),
    note: `Rebuilt ${ext.toUpperCase()} ZIP Central Directory + EOCD (${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}${clamped > 0 ? `, clamped ${clamped}` : ''}).`,
  };
}

function repairAepCjs(raw) {
  if (!raw || raw.length < 16 || raw.toString('ascii', 0, 4) !== 'RIFX') return null;
  const formType = raw.toString('ascii', 8, 12);
  const declared = raw.readUInt32BE(4) + 8;
  let pos = 12;
  let lastValid = 12;
  let chunks = 0;
  while (pos + 8 <= raw.length) {
    const id = raw.toString('ascii', pos, pos + 4);
    const sz = raw.readUInt32BE(pos + 4);
    if (!/^[\x20-\x7e]{4}$/.test(id) || sz > raw.length) break;
    const next = pos + 8 + sz + (sz & 1);
    if (next > raw.length) break;
    lastValid = next;
    chunks++;
    pos = next;
  }
  const trimmed = lastValid > 12 && lastValid < raw.length ? Buffer.from(raw.subarray(0, lastValid)) : Buffer.from(raw);
  if (declared === trimmed.length && trimmed.length === raw.length) return null;
  trimmed.writeUInt32BE(Math.max(4, trimmed.length - 8) >>> 0, 4);
  return {
    data: trimmed,
    note: `Repaired After Effects .AEP (${formType}): verified ${chunks} chunks & patched RIFX container header.`,
  };
}

function repairSqliteCjs(raw) {
  if (!raw || raw.length < 100 || raw.toString('ascii', 0, 15) !== 'SQLite format 3' || raw[15] !== 0) return null;
  let pageSize = raw.readUInt16BE(16);
  if (pageSize === 1) pageSize = 65536;
  if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) return null;
  const declaredPages = raw.readUInt32BE(28);
  let actualPages = Math.floor(raw.length / pageSize);
  if (actualPages < 1) return null;

  const minPages = declaredPages > 0 && declaredPages <= actualPages ? declaredPages : 1;
  while (actualPages > minPages) {
    const pStart = (actualPages - 1) * pageSize;
    let allZero = true;
    for (let i = 0; i < pageSize; i++) {
      if (raw[pStart + i] !== 0) { allZero = false; break; }
    }
    if (!allZero) break;
    actualPages--;
  }

  const aligned = actualPages * pageSize;
  const hasWal = raw[18] === 2 || raw[19] === 2;
  if (aligned === raw.length && declaredPages === actualPages && !hasWal) return null;
  const out = Buffer.from(raw.subarray(0, aligned));
  out.writeUInt32BE(actualPages >>> 0, 28);
  if (hasWal) { out[18] = 1; out[19] = 1; }
  return {
    data: out,
    note: `Repaired SQLite DB: aligned to ${actualPages} x ${pageSize}B pages${hasWal ? ', reset orphan WAL mode' : ''}.`,
  };
}

function repairPsdCjs(raw) {
  if (!raw || raw.length < 30 || raw.toString('ascii', 0, 4) !== '8BPS') return null;
  const version = raw.readUInt16BE(4);
  if (version !== 1 && version !== 2) return null;
  const salvagedPreview = extractEmbeddedJpegCjs(raw, false);
  const out = Buffer.from(raw);
  let fixed = 0;
  let pos = 26;
  if (pos + 4 <= out.length) {
    const cl = out.readUInt32BE(pos);
    const av = Math.max(0, out.length - (pos + 4));
    if (cl > av) { out.writeUInt32BE(av >>> 0, pos); fixed++; pos = out.length; } else pos += 4 + cl;
  }
  if (pos + 4 <= out.length) {
    const rl = out.readUInt32BE(pos);
    const av = Math.max(0, out.length - (pos + 4));
    if (rl > av) { out.writeUInt32BE(av >>> 0, pos); fixed++; pos = out.length; } else pos += 4 + rl;
  }
  const lSz = version === 2 ? 8 : 4;
  if (pos + lSz <= out.length) {
    const ll = version === 2 ? out.readUInt32BE(pos + 4) : out.readUInt32BE(pos);
    const av = Math.max(0, out.length - (pos + lSz));
    if (ll > av) {
      if (version === 2) out.writeUInt32BE(av >>> 0, pos + 4);
      else out.writeUInt32BE(av >>> 0, pos);
      fixed++;
    }
  }
  if (fixed === 0 && !salvagedPreview) return null;
  return {
    data: fixed > 0 ? out : null,
    salvagedPreview,
    note: [fixed > 0 ? `clamped ${fixed} truncated PSD section(s)` : '', salvagedPreview ? `extracted ${salvagedPreview.length} B thumbnail` : ''].filter(Boolean).join('; '),
  };
}

function repairPdfCjs(raw) {
  if (!raw || raw.length < 8 || raw.toString('ascii', 0, 5) !== '%PDF-') return null;
  const fullText = raw.toString('latin1');
  if (/startxref\s+\d+\s+%%EOF/m.test(fullText.slice(Math.max(0, fullText.length - 512))) && fullText.trimEnd().endsWith('%%EOF')) {
    return null;
  }
  let trimLen = raw.length;
  const anchor = Math.max(
    fullText.lastIndexOf('endobj') >= 0 ? fullText.lastIndexOf('endobj') + 6 : -1,
    fullText.lastIndexOf('endstream') >= 0 ? fullText.lastIndexOf('endstream') + 9 : -1,
  );
  if (anchor > 0 && fullText.lastIndexOf('xref') < anchor) {
    let c = anchor;
    while (c < raw.length && (raw[c] === 0x0d || raw[c] === 0x0a || raw[c] === 0x20)) c++;
    if (c < raw.length) trimLen = c;
  }
  const trimmed = raw.subarray(0, trimLen);
  const body = trimmed.toString('latin1');
  const objs = new Map();
  let maxObj = 0;
  let rootRef = '1 0 R';
  let infoRef = null;
  const re = /(?:^|[\r\n])\s*(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const num = Number(m[1]);
    const gen = Number(m[2]);
    const rel = m[0].search(/\d/);
    const off = m.index + (rel >= 0 ? rel : 0);
    if (num > 0 && num < 5000000) {
      objs.set(num, { gen, off });
      if (num > maxObj) maxObj = num;
      const snip = body.slice(off, Math.min(body.length, off + 512));
      if (/\/Type\s*\/Catalog\b/.test(snip)) rootRef = `${num} ${gen} R`;
      else if (/\/(Title|Producer|Author|Creator)\b/.test(snip) && !infoRef) infoRef = `${num} ${gen} R`;
    }
  }
  if (objs.size === 0) {
    return { data: Buffer.concat([trimmed, Buffer.from('\n%%EOF\n', 'ascii')]), note: 'Appended %%EOF trailer to PDF.' };
  }
  const xrefOff = trimmed.length + 1;
  const lines = ['', 'xref', `0 ${maxObj + 1}`, '0000000000 65535 f '];
  for (let i = 1; i <= maxObj; i++) {
    const r = objs.get(i);
    lines.push(r ? `${String(r.off).padStart(10, '0')} ${String(r.gen).padStart(5, '0')} n ` : '0000000000 65535 f ');
  }
  const tr = [`/Size ${maxObj + 1}`, `/Root ${rootRef}`];
  if (infoRef) tr.push(`/Info ${infoRef}`);
  lines.push('trailer', `<< ${tr.join(' ')} >>`, 'startxref', String(xrefOff), '%%EOF', '');
  return {
    data: Buffer.concat([trimmed, Buffer.from(lines.join('\n'), 'ascii')]),
    note: `Rebuilt PDF xref table (${objs.size} objects, Root ${rootRef}) + startxref + %%EOF.`,
  };
}

function repairOle2Cjs(raw, ext = 'doc') {
  if (!raw || raw.length < 512 || raw[0] !== 0xd0 || raw[1] !== 0xcf || raw[2] !== 0x11 || raw[3] !== 0xe0) return null;
  const sectorSize = raw.readUInt16LE(30) === 12 ? 4096 : 512;
  const rem = raw.length % sectorSize;
  const salvagedPreview = extractEmbeddedJpegCjs(raw, false);
  const pad = rem === 0 ? 0 : sectorSize - rem;
  const out = pad > 0 ? Buffer.concat([raw, Buffer.alloc(pad)]) : Buffer.from(raw);
  const maxSec = Math.max(0, Math.floor((out.length - sectorSize) / sectorSize));
  const totalFat = out.readUInt32LE(44);
  let clampedFat = false;
  if (totalFat > maxSec && maxSec > 0) {
    out.writeUInt32LE(Math.max(1, Math.min(totalFat, maxSec)) >>> 0, 44);
    clampedFat = true;
  }
  if (pad === 0 && !clampedFat && !salvagedPreview) return null;
  return {
    data: (pad > 0 || clampedFat) ? out : null,
    salvagedPreview,
    note: [pad > 0 ? `padded OLE2 sector (+${pad} B)` : '', clampedFat ? 'clamped FAT count' : '', salvagedPreview ? `extracted ${salvagedPreview.length} B thumbnail` : ''].filter(Boolean).join('; '),
  };
}

function repairPstCjs(raw, ext = 'pst') {
  if (!raw || raw.length < 512 || raw.toString('ascii', 0, 4) !== '!BDN') return null;
  const wVer = raw.readUInt16LE(10);
  const out = Buffer.from(raw);
  if (wVer >= 23 && raw.length >= 0xc0) {
    const lo = out.readUInt32LE(0xb8);
    const hi = out.readUInt32LE(0xbc);
    const dec = hi * 4294967296 + lo;
    if (dec !== out.length) {
      out.writeUInt32LE(out.length >>> 0, 0xb8);
      out.writeUInt32LE(Math.floor(out.length / 4294967296) >>> 0, 0xbc);
      return { data: out, note: `Synchronized Unicode .${ext.toUpperCase()} NDB ibFileEof (${dec} -> ${out.length} B).` };
    }
  } else if (raw.length >= 0xac) {
    const dec = out.readUInt32LE(0xa8);
    if (dec !== out.length) {
      out.writeUInt32LE(out.length >>> 0, 0xa8);
      return { data: out, note: `Synchronized ANSI .${ext.toUpperCase()} NDB ibFileEof (${dec} -> ${out.length} B).` };
    }
  }
  return null;
}

function repairRpaCjs(raw) {
  if (!raw || raw.length < 24) return null;
  const head = raw.subarray(0, Math.min(raw.length, 64)).toString('ascii');
  const m = head.match(/^RPA-(?:3\.0|2\.0) ([0-9a-fA-F]{16})/);
  if (!m) return null;
  const idxOffset = parseInt(m[1], 16);
  if (!Number.isFinite(idxOffset) || idxOffset <= 0 || idxOffset >= raw.length) return null;
  let end = raw.length;
  while (end > idxOffset + 8 && raw[end - 1] === 0x00) end--;
  if (raw.length - end < 16) return null;
  return {
    data: Buffer.from(raw.subarray(0, end)),
    note: `Validated RPA archive index @ 0x${idxOffset.toString(16)} and trimmed ${raw.length - end} B cluster slack.`,
  };
}

function repairStructuredTextCjs(raw, ext) {
  let end = raw.length;
  while (end > 0 && raw[end - 1] === 0x00) end--;
  const decoded = raw.subarray(0, end).toString('utf8');
  const text = decoded.replace(/[\uFFFD\x00-\x08\x0B\x0C\x0E-\x1F]+$/g, '');
  const trimmedSlack = end < raw.length || text.length < decoded.length;

  if (ext === 'json') {
    try {
      JSON.parse(text);
      if (!trimmedSlack) return null;
      return { data: Buffer.from(text, 'utf8'), note: 'Trimmed trailing binary slack from JSON.' };
    } catch {
      const stack = [];
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
          else if ((ch === '}' || ch === ']') && stack.length > 0 && stack[stack.length - 1] === ch) stack.pop();
        }
      }
      let rep = esc ? text.slice(0, -1) : text;
      if (inStr) rep += '"';
      rep = rep.replace(/,\s*$/, '');
      if (stack.length > 0) rep = rep.replace(/,?\s*"[^"]*"\s*:\s*$/, '') + stack.reverse().join('');
      try {
        JSON.parse(rep);
        return {
          data: Buffer.from(rep, 'utf8'),
          note: stack.length > 0 ? `Closed ${stack.length} unclosed JSON container(s).` : 'Repaired truncated JSON string or trailing comma.',
        };
      } catch {
        // continue
      }
    }
  }

  if (['xml', 'aepx', 'svg', 'html', 'htm'].includes(ext)) {
    const fixed = closeTruncatedXmlOrHtmlCjs(text, ext === 'html' || ext === 'htm');
    if (fixed.closedCount > 0 || trimmedSlack) {
      return {
        data: Buffer.from(fixed.text, 'utf8'),
        note: fixed.closedCount > 0 ? `Closed ${fixed.closedCount} unclosed .${ext.toUpperCase()} tag(s).` : `Trimmed ${raw.length - end} B slack from .${ext.toUpperCase()}.`,
      };
    }
    return null;
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
        data: Buffer.from(closed, 'utf8'),
        note: depth > 0 ? `Closed ${depth} unclosed .RTF group(s) and trimmed slack.` : 'Trimmed trailing binary slack from .RTF.',
      };
    }
    return null;
  }

  if (trimmedSlack) {
    return { data: Buffer.from(text, 'utf8'), note: `Cleaned trailing binary/null cluster slack from .${ext.toUpperCase()}.` };
  }
  return null;
}

function repairNonMediaBufferCjs(ext, raw) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  if (!raw || raw.length === 0) return null;
  if (['zip', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub', 'apk', 'jar', 'kra', 'ora', 'kmz'].includes(e)) {
    return repairZipContainerCjs(raw, e);
  }
  if (e === 'aep') return repairAepCjs(raw);
  if (e === 'sqlite' || e === 'db' || e === 'sqlite3') return repairSqliteCjs(raw);
  if (e === 'psd' || e === 'psb') return repairPsdCjs(raw);
  if (e === 'pdf') return repairPdfCjs(raw);
  if (['doc', 'xls', 'ppt', 'msg', 'msi'].includes(e)) return repairOle2Cjs(raw, e);
  if (e === 'pst' || e === 'ost') return repairPstCjs(raw, e);
  if (e === 'rpa') return repairRpaCjs(raw);
  if (['aepx', 'xml', 'svg', 'html', 'htm', 'json', 'rpy', 'txt', 'py', 'ini', 'csv', 'sql', 'eml', 'rtf'].includes(e)) {
    return repairStructuredTextCjs(raw, e);
  }
  if (e === 'tar' && raw.length >= 512) {
    const rem = raw.length % 512;
    const pad = rem === 0 ? 0 : 512 - rem;
    const tail = raw.subarray(Math.max(0, raw.length - 1024));
    const hasZeros = tail.length === 1024 && tail.every((b) => b === 0);
    if (pad > 0 || !hasZeros) {
      return {
        data: Buffer.concat([raw, Buffer.alloc(pad + (hasZeros ? 0 : 1024))]),
        note: 'Aligned TAR blocks and appended 1024-byte EOF terminator.',
      };
    }
  }
  if ((e === 'gz' || e === 'flac') && raw.length >= 16) {
    let end = raw.length;
    while (end > 16 && raw[end - 1] === 0x00) end--;
    if (raw.length - end >= 16) {
      return { data: Buffer.from(raw.subarray(0, end)), note: `Trimmed ${raw.length - end} B null slack from ${e.toUpperCase()}.` };
    }
  }
  if (e === 'mp3' && raw.length >= 16 && !(raw[0] === 0x49 && raw[1] === 0x44 && raw[2] === 0x33) && !(raw[0] === 0xff && (raw[1] & 0xe0) === 0xe0)) {
    for (let i = 1; i + 4 < Math.min(raw.length, 65536); i++) {
      if (raw[i] === 0xff && (raw[i + 1] & 0xe0) === 0xe0 && (raw[i + 2] & 0xf0) !== 0xf0) {
        return { data: Buffer.from(raw.subarray(i)), note: `Trimmed ${i} B leading garbage before MP3 frame sync.` };
      }
    }
  }
  return null;
}

module.exports = {
  repairZipContainerCjs,
  repairAepCjs,
  repairSqliteCjs,
  repairPsdCjs,
  repairPdfCjs,
  repairOle2Cjs,
  repairPstCjs,
  repairRpaCjs,
  repairStructuredTextCjs,
  repairNonMediaBufferCjs,
};
