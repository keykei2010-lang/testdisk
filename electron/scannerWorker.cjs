const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');

const {
  devicePath,
  rangeStart,
  rangeEnd,
  totalLimitBytes,
  step = 512,
  workerIndex = 0,
  ctrlBuffer,
  unallocatedOnly = false,
  allocatedBitmaps = [],
} = workerData;

const ctrl = ctrlBuffer ? new Int32Array(ctrlBuffer) : null;

const CRC32_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[n] = c >>> 0;
}

function computeCrc32Buf(buf, len) {
  let crc = 0xffffffff;
  const end = Math.min(buf.length, len);
  for (let i = 0; i < end; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isOffsetAllocated(absOffset) {
  if (!unallocatedOnly || !allocatedBitmaps || allocatedBitmaps.length === 0) return false;
  for (const bmInfo of allocatedBitmaps) {
    if (absOffset >= bmInfo.volStart && absOffset < bmInfo.volEnd) {
      const lcn = Math.floor((absOffset - bmInfo.volStart) / bmInfo.clusterBytes);
      const bIdx = lcn >>> 3;
      if (bIdx < bmInfo.bitmap.length) {
        return (bmInfo.bitmap[bIdx] & (1 << (lcn & 7))) !== 0;
      }
      return false;
    }
  }
  return false;
}

function isSectorAllZero(buf, offset) {
  // Fast 64-bit check: bail out immediately on first non-zero 8-byte lane
  const end = Math.min(buf.length, offset + 512);
  for (let i = offset; i + 8 <= end; i += 8) {
    if (buf.readBigUInt64LE(i) !== 0n) return false;
  }
  return true;
}

function measureMp4FromFd(fd, startOffset, maxEnd) {
  let pos = startOffset;
  const hdr = Buffer.allocUnsafe(16);
  let sawMoov = false;
  let sawMdat = false;
  let lastValidEnd = startOffset;

  for (let boxes = 0; boxes < 128 && pos + 8 <= maxEnd; boxes++) {
    const n = fs.readSync(fd, hdr, 0, 16, pos);
    if (n < 8) break;
    let boxSize = hdr.readUInt32BE(0);
    const boxType = hdr.toString('ascii', 4, 8);
    if (boxSize === 1 && n >= 16) {
      const hi = hdr.readUInt32BE(8);
      const lo = hdr.readUInt32BE(12);
      boxSize = hi * 4294967296 + lo;
    } else if (boxSize === 0) {
      boxSize = maxEnd - pos;
    }
    if (boxSize < 8 || pos + boxSize > maxEnd) break;
    if (!/^[\x20-\x7e]{4}$/.test(boxType)) break;
    if (boxType === 'moov') sawMoov = true;
    if (boxType === 'mdat') sawMdat = true;
    pos += boxSize;
    lastValidEnd = pos;
  }

  if (!sawMoov && !sawMdat) return null;
  return {
    size: lastValidEnd - startOffset,
    truncated: sawMdat && !sawMoov,
  };
}

function measureJpgFromFd(fd, startOffset, maxEnd) {
  const maxJpg = Math.min(maxEnd, startOffset + 48 * 1024 * 1024);
  const segHdr = Buffer.allocUnsafe(4);
  let pos = startOffset + 2;
  let sawSos = false;

  for (let segs = 0; segs < 256 && pos + 2 <= maxJpg; segs++) {
    const n = fs.readSync(fd, segHdr, 0, 4, pos);
    if (n < 2) break;
    if (segHdr[0] !== 0xff) {
      if (sawSos) break;
      return null;
    }
    let mIdx = 1;
    while (mIdx < n && segHdr[mIdx] === 0xff) {
      pos++;
      mIdx++;
    }
    const marker = segHdr[mIdx];
    pos += 2;
    if (marker === 0xd9) return { size: pos - startOffset, truncated: false };
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (n < mIdx + 3) {
      const lenBuf = Buffer.allocUnsafe(2);
      if (fs.readSync(fd, lenBuf, 0, 2, pos) < 2) break;
      const segLen = lenBuf.readUInt16BE(0);
      if (segLen < 2) break;
      pos += segLen;
    } else {
      const segLen = segHdr.readUInt16BE(mIdx + 1);
      if (segLen < 2) break;
      pos += segLen;
    }
    if (marker === 0xda) {
      sawSos = true;
      break;
    }
  }

  if (!sawSos) return null;

  const chunk = Buffer.allocUnsafe(262144);
  let prevFf = false;
  while (pos < maxJpg) {
    const toRead = Math.min(chunk.length, maxJpg - pos);
    const n = fs.readSync(fd, chunk, 0, toRead, pos);
    if (n <= 0) break;
    for (let i = 0; i < n; i++) {
      const b = chunk[i];
      if (prevFf) {
        if (b === 0xd9) return { size: pos + i + 1 - startOffset, truncated: false };
        prevFf = b === 0xff;
        continue;
      }
      if (b === 0xff) prevFf = true;
    }
    pos += n;
  }
  return { size: Math.min(maxJpg - startOffset, 2 * 1024 * 1024), truncated: true };
}

function measurePngFromFd(fd, startOffset, maxEnd) {
  const hdr = Buffer.allocUnsafe(12);
  let pos = startOffset + 8;
  for (let i = 0; i < 256 && pos + 12 <= maxEnd; i++) {
    const n = fs.readSync(fd, hdr, 0, 12, pos);
    if (n < 12) break;
    const len = hdr.readUInt32BE(0);
    const type = hdr.toString('ascii', 4, 8);
    if (len > 32 * 1024 * 1024) return null;
    const nextPos = pos + 12 + len;
    if (nextPos > maxEnd) return { size: maxEnd - startOffset, truncated: true };
    pos = nextPos;
    if (type === 'IEND') return { size: pos - startOffset, truncated: false };
  }
  return null;
}

function findMarkerInStream(fd, startOffset, maxScanLen, maxEnd, patternBuf) {
  const limit = Math.min(maxEnd, startOffset + maxScanLen);
  const scanChunk = Buffer.allocUnsafe(131072);
  let pos = startOffset;
  const overlap = Math.max(1, patternBuf.length - 1);

  while (pos < limit) {
    const toRead = Math.min(scanChunk.length, limit - pos);
    const n = fs.readSync(fd, scanChunk, 0, toRead, pos);
    if (n < patternBuf.length) break;
    const hitIdx = scanChunk.subarray(0, n).indexOf(patternBuf);
    if (hitIdx !== -1) return pos + hitIdx;
    if (pos + n >= limit) break;
    pos += n - overlap;
  }
  return -1;
}

function measurePdfFromFd(fd, startOffset, maxEnd) {
  const eofMarker = Buffer.from('%%EOF', 'ascii');
  const hit = findMarkerInStream(fd, startOffset, 64 * 1024 * 1024, maxEnd, eofMarker);
  if (hit !== -1) {
    let end = hit + 5;
    const tail = Buffer.allocUnsafe(4);
    const tn = fs.readSync(fd, tail, 0, Math.min(4, maxEnd - end), end);
    for (let i = 0; i < tn; i++) {
      if (tail[i] === 0x0d || tail[i] === 0x0a) end++;
      else break;
    }
    return { size: end - startOffset, truncated: false };
  }
  return { size: Math.min(4 * 1024 * 1024, maxEnd - startOffset), truncated: true };
}

function measureZipFromFd(fd, startOffset, maxEnd) {
  const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const hit = findMarkerInStream(fd, startOffset, 128 * 1024 * 1024, maxEnd, eocdSig);
  if (hit !== -1 && hit + 22 <= maxEnd) {
    const eocdBuf = Buffer.allocUnsafe(22);
    if (fs.readSync(fd, eocdBuf, 0, 22, hit) === 22) {
      const commentLen = eocdBuf.readUInt16LE(20);
      const total = Math.min(maxEnd - startOffset, hit + 22 + commentLen - startOffset);
      return { size: total, truncated: false };
    }
  }
  return { size: Math.min(8 * 1024 * 1024, maxEnd - startOffset), truncated: true };
}

function measureGifFromFd(fd, startOffset, maxEnd) {
  const hdr = Buffer.allocUnsafe(16);
  if (fs.readSync(fd, hdr, 0, 13, startOffset) < 13) return null;
  const ver = hdr.toString('ascii', 0, 6);
  if (ver !== 'GIF87a' && ver !== 'GIF89a') return null;
  const maxGif = Math.min(maxEnd, startOffset + 25 * 1024 * 1024);
  const trailer = Buffer.from([0x00, 0x3b]);
  const hit = findMarkerInStream(fd, startOffset + 13, maxGif - (startOffset + 13), maxGif, trailer);
  if (hit !== -1) return { size: hit + 2 - startOffset, truncated: false };
  return { size: Math.min(2 * 1024 * 1024, maxGif - startOffset), truncated: true };
}

function measureSqliteFromFd(fd, startOffset, maxEnd) {
  const hdr = Buffer.allocUnsafe(36);
  if (fs.readSync(fd, hdr, 0, 36, startOffset) < 36) return null;
  let pageSize = hdr.readUInt16BE(16);
  if (pageSize === 1) pageSize = 65536;
  const pageCount = hdr.readUInt32BE(28);
  if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0 || pageCount === 0) return null;
  const decl = pageSize * pageCount;
  const avail = maxEnd - startOffset;
  return { size: Math.min(decl, avail), truncated: decl > avail };
}

function detectZipFlavorFromFd(fd, startOffset, maxEnd) {
  const probeLen = Math.min(32768, Math.max(0, maxEnd - startOffset));
  if (probeLen < 30) return 'zip';
  const buf = Buffer.allocUnsafe(probeLen);
  const n = fs.readSync(fd, buf, 0, probeLen, startOffset);
  const ascii = buf.toString('latin1', 0, n);
  if (ascii.includes('word/')) return 'docx';
  if (ascii.includes('xl/')) return 'xlsx';
  if (ascii.includes('ppt/')) return 'pptx';
  if (ascii.includes('AndroidManifest.xml') || ascii.includes('classes.dex')) return 'apk';
  if (ascii.includes('META-INF/MANIFEST.MF')) return 'jar';
  if (ascii.includes('application/epub+zip') || ascii.includes('OEBPS/')) return 'epub';
  if (ascii.includes('application/vnd.oasis.opendocument.text')) return 'odt';
  if (ascii.includes('application/vnd.oasis.opendocument.spreadsheet')) return 'ods';
  if (ascii.includes('application/vnd.oasis.opendocument.presentation')) return 'odp';
  if (ascii.includes('application/x-krita')) return 'kra';
  if (ascii.includes('image/openraster')) return 'ora';
  if (ascii.includes('doc.kml')) return 'kmz';
  if (ascii.includes('FixedDocumentSequence.fdseq')) return 'xps';
  if (ascii.includes('[Content_Types].xml')) return 'docx';
  return 'zip';
}

function detectOle2FlavorFromFd(fd, startOffset, maxEnd) {
  const probeLen = Math.min(65536, Math.max(0, maxEnd - startOffset));
  if (probeLen < 512) return 'doc';
  const buf = Buffer.allocUnsafe(probeLen);
  const n = fs.readSync(fd, buf, 0, probeLen, startOffset);
  const text16 = buf.toString('utf16le', 0, n);
  if (text16.includes('__substg1.0') || text16.includes('__properties_version1.0')) return 'msg';
  if (text16.includes('WordDocument')) return 'doc';
  if (text16.includes('Workbook') || text16.includes('Book')) return 'xls';
  if (text16.includes('PowerPoint Document') || text16.includes('Current User')) return 'ppt';
  if (text16.includes('Quill')) return 'pub';
  if (text16.includes('SummaryInformation') && buf.toString('latin1', 0, n).includes('Windows Installer')) return 'msi';
  return 'doc';
}

function measureRifxFromFd(fd, startOffset, maxEnd) {
  const hdr = Buffer.allocUnsafe(16);
  if (fs.readSync(fd, hdr, 0, 12, startOffset) < 12) return null;
  const declared = hdr.readUInt32BE(4) + 8;
  const avail = maxEnd - startOffset;
  if (declared < 16) return null;
  return {
    size: Math.min(declared, avail, 128 * 1024 * 1024),
    truncated: declared > avail,
  };
}

function measurePsdFromFd(fd, startOffset, maxEnd) {
  const hdr = Buffer.allocUnsafe(30);
  if (fs.readSync(fd, hdr, 0, 30, startOffset) < 30) return null;
  const ver = hdr.readUInt16BE(4);
  if (ver !== 1 && ver !== 2) return null;
  const ext = ver === 2 ? 'psb' : 'psd';
  let pos = 26;
  const lenBuf = Buffer.allocUnsafe(8);
  for (let sec = 0; sec < 3; sec++) {
    const is8 = ver === 2 && sec === 2;
    const need = is8 ? 8 : 4;
    if (startOffset + pos + need > maxEnd) {
      return { ext, size: maxEnd - startOffset, truncated: true };
    }
    if (fs.readSync(fd, lenBuf, 0, need, startOffset + pos) < need) {
      return { ext, size: pos, truncated: true };
    }
    const secLen = is8
      ? lenBuf.readUInt32BE(0) * 4294967296 + lenBuf.readUInt32BE(4)
      : lenBuf.readUInt32BE(0);
    pos += need + secLen;
    if (startOffset + pos > maxEnd) {
      return { ext, size: maxEnd - startOffset, truncated: true };
    }
  }
  const chans = hdr.readUInt16BE(12);
  const h = hdr.readUInt32BE(14);
  const w = hdr.readUInt32BE(18);
  const depth = hdr.readUInt16BE(22);
  const estImageData = Math.min(64 * 1024 * 1024, Math.max(4096, Math.floor((w * h * chans * Math.max(1, depth / 8)) / 3)));
  const total = Math.min(maxEnd - startOffset, pos + 2 + estImageData);
  return { ext, size: total, truncated: false };
}

function measureTarFromFd(fd, startOffset, maxEnd) {
  const avail = Math.min(maxEnd - startOffset, 64 * 1024 * 1024);
  const hdr = Buffer.allocUnsafe(512);
  let pos = 0;
  let zeroBlocks = 0;
  while (pos + 512 <= avail) {
    if (fs.readSync(fd, hdr, 0, 512, startOffset + pos) < 512) break;
    if (isSectorAllZero(hdr, 0)) {
      zeroBlocks++;
      pos += 512;
      if (zeroBlocks >= 2) return { size: pos, truncated: false };
      continue;
    }
    zeroBlocks = 0;
    const magic = hdr.toString('ascii', 257, 262);
    if (magic !== 'ustar') {
      return pos >= 512 ? { size: pos, truncated: true } : null;
    }
    const sizeOct = hdr.toString('ascii', 124, 136).replace(/\0.*$/, '').trim();
    const entryBytes = parseInt(sizeOct || '0', 8) || 0;
    const dataBlocks = Math.ceil(entryBytes / 512) * 512;
    pos += 512 + dataBlocks;
  }
  return pos >= 512 ? { size: Math.min(avail, pos), truncated: true } : null;
}

function detectTiffRawFlavor(buf, offset, availLen) {
  if (availLen < 16) return 'tif';
  const le = buf[offset] === 0x49 && buf[offset + 1] === 0x49;
  const ver = le ? buf.readUInt16LE(offset + 2) : buf.readUInt16BE(offset + 2);
  if (ver === 0x4f52 || ver === 0x5352) return 'orf';
  if (ver === 0x0055) return 'rw2';
  if (ver !== 42) return null;

  if (le && buf[offset + 8] === 0x43 && buf[offset + 9] === 0x52 && buf[offset + 10] === 0x02) {
    return 'cr2';
  }

  const ifdOff = le ? buf.readUInt32LE(offset + 4) : buf.readUInt32BE(offset + 4);
  if (ifdOff >= 8 && ifdOff + 2 <= availLen) {
    const count = le ? buf.readUInt16LE(offset + ifdOff) : buf.readUInt16BE(offset + ifdOff);
    const maxEntries = Math.min(64, count);
    let make = '';
    for (let i = 0; i < maxEntries; i++) {
      const eOff = offset + ifdOff + 2 + i * 12;
      if (eOff + 12 > offset + availLen) break;
      const tag = le ? buf.readUInt16LE(eOff) : buf.readUInt16BE(eOff);
      if (tag === 0xc612) return 'dng';
      if (tag === 0x010f) {
        const valOff = le ? buf.readUInt32LE(eOff + 8) : buf.readUInt32BE(eOff + 8);
        if (valOff > 0 && valOff + 12 <= availLen) {
          const sliceEnd = Math.min(offset + valOff + 16, offset + availLen);
          make = buf.toString('ascii', offset + valOff, sliceEnd).toUpperCase();
        }
      }
    }
    if (make.includes('NIKON')) return 'nef';
    if (make.includes('SONY')) return 'arw';
    if (make.includes('CANON')) return 'cr2';
    if (make.includes('PENTAX')) return 'pef';
  }
  return 'tif';
}

async function runWorker() {
  let fd;
  try {
    fd = fs.openSync(devicePath, 'r');
  } catch (err) {
    parentPort.postMessage({ type: 'error', message: err?.message || 'openSync failed' });
    return;
  }

  const chunkSize = 4 * 1024 * 1024;
  const chunkBuf = Buffer.allocUnsafe(chunkSize);
  let cursor = Math.max(0, Math.floor(rangeStart / 512) * 512);
  let fileSeq = 1;

  try {
    while (cursor + 512 <= rangeEnd) {
      if (ctrl) {
        const st = Atomics.load(ctrl, 0);
        if (st === 2) break;
        while (Atomics.load(ctrl, 0) === 1) {
          await new Promise((r) => setTimeout(r, 80));
        }
        if (Atomics.load(ctrl, 0) === 2) break;
      }

      const windowLen = Math.min(chunkSize, Math.floor((rangeEnd - cursor) / 512) * 512);
      if (windowLen < 512) break;

      let n = 0;
      try {
        n = fs.readSync(fd, chunkBuf, 0, windowLen, cursor);
      } catch {
        break;
      }
      if (n < 512) break;

      let local = 0;
      const batch = [];

      while (local + 16 <= n) {
        if (ctrl && Atomics.load(ctrl, 0) === 2) break;
        const absOffset = cursor + local;

        if (unallocatedOnly && isOffsetAllocated(absOffset)) {
          local += step;
          continue;
        }

        // 64-bit zero-sector skip for multi-TB throughput
        if (step >= 512 && local + 512 <= n && isSectorAllZero(chunkBuf, local)) {
          local += step;
          continue;
        }

        const b0 = chunkBuf[local];
        const b1 = chunkBuf[local + 1];
        const b2 = chunkBuf[local + 2];
        const b3 = chunkBuf[local + 3];
        const b4 = chunkBuf[local + 4];

        let matchedExt = null;
        let measured = null;

        if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff && [0xe0, 0xe1, 0xe2, 0xdb, 0xee, 0xc0, 0xc2].includes(b3)) {
          matchedExt = 'jpg';
          measured = measureJpgFromFd(fd, absOffset, totalLimitBytes);
        } else if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47 && b4 === 0x0d) {
          matchedExt = 'png';
          measured = measurePngFromFd(fd, absOffset, totalLimitBytes);
        } else if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46 && b3 === 0x38) {
          matchedExt = 'gif';
          measured = measureGifFromFd(fd, absOffset, totalLimitBytes);
        } else if (b0 === 0x42 && b1 === 0x4d && local + 18 <= n) {
          const bfSize = chunkBuf.readUInt32LE(local + 2);
          const dibSize = chunkBuf.readUInt32LE(local + 14);
          if (bfSize > 54 && bfSize < 100 * 1024 * 1024 && [12, 40, 52, 56, 108, 124].includes(dibSize)) {
            matchedExt = 'bmp';
            measured = { size: Math.min(bfSize, totalLimitBytes - absOffset), truncated: bfSize > totalLimitBytes - absOffset };
          }
        } else if (b0 === 0x38 && b1 === 0x42 && b2 === 0x50 && b3 === 0x53) {
          const pRes = measurePsdFromFd(fd, absOffset, totalLimitBytes);
          if (pRes) {
            matchedExt = pRes.ext;
            measured = { size: pRes.size, truncated: pRes.truncated };
          }
        } else if (b0 === 0x76 && b1 === 0x2f && b2 === 0x31 && b3 === 0x01) {
          matchedExt = 'exr';
          measured = { size: Math.min(24 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x44 && b1 === 0x44 && b2 === 0x53 && b3 === 0x20) {
          matchedExt = 'dds';
          measured = { size: Math.min(8 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b4 === 0x66 && chunkBuf[local + 5] === 0x74 && chunkBuf[local + 6] === 0x79 && chunkBuf[local + 7] === 0x70) {
          const brand = local + 12 <= n ? chunkBuf.toString('ascii', local + 8, local + 12) : '';
          if (brand === 'crx ') matchedExt = 'cr3';
          else if (brand.toLowerCase().startsWith('qt')) matchedExt = 'mov';
          else if (brand === 'M4A ') matchedExt = 'm4a';
          else if (brand === 'M4B ') matchedExt = 'm4b';
          else if (brand === 'M4V ') matchedExt = 'm4v';
          else if (brand.startsWith('3gp')) matchedExt = '3gp';
          else if (brand.startsWith('3g2')) matchedExt = '3g2';
          else if (brand === 'avif' || brand === 'avis') matchedExt = 'avif';
          else if (brand === 'heic' || brand === 'mif1' || brand === 'heix') matchedExt = 'heic';
          else matchedExt = 'mp4';
          measured = measureMp4FromFd(fd, absOffset, totalLimitBytes);
          if (measured && measured.truncated && measured.size > step && ['mp4', 'mov', 'm4v', '3gp'].includes(matchedExt)) {
            const pBuf = Buffer.allocUnsafe(12);
            const maxScanEnd = Math.min(totalLimitBytes, absOffset + measured.size);
            for (let probe = absOffset + step; probe + 12 <= maxScanEnd; probe += step) {
              let p0, p1, p2, p3, p4, p5, p6, p7;
              if (probe >= cursor && probe + 12 <= cursor + n) {
                const rel = probe - cursor;
                p0 = chunkBuf[rel]; p1 = chunkBuf[rel + 1]; p2 = chunkBuf[rel + 2]; p3 = chunkBuf[rel + 3];
                p4 = chunkBuf[rel + 4]; p5 = chunkBuf[rel + 5]; p6 = chunkBuf[rel + 6]; p7 = chunkBuf[rel + 7];
              } else {
                if (fs.readSync(fd, pBuf, 0, 12, probe) < 12) break;
                p0 = pBuf[0]; p1 = pBuf[1]; p2 = pBuf[2]; p3 = pBuf[3];
                p4 = pBuf[4]; p5 = pBuf[5]; p6 = pBuf[6]; p7 = pBuf[7];
              }
              const isForeign =
                (p0 === 0xff && p1 === 0xd8 && p2 === 0xff) ||
                (p0 === 0x89 && p1 === 0x50 && p2 === 0x4e && p3 === 0x47) ||
                (p0 === 0x47 && p1 === 0x49 && p2 === 0x46 && p3 === 0x38) ||
                (p0 === 0x25 && p1 === 0x50 && p2 === 0x44 && p3 === 0x46) ||
                (p0 === 0x50 && p1 === 0x4b && p2 === 0x03 && p3 === 0x04) ||
                (p0 === 0xd0 && p1 === 0xcf && p2 === 0x11 && p3 === 0xe0) ||
                (p4 === 0x66 && p5 === 0x74 && p6 === 0x79 && p7 === 0x70);
              if (isForeign) {
                measured = { size: probe - absOffset, truncated: true };
                break;
              }
            }
          }
        } else if (
          b0 === 0x46 &&
          b1 === 0x55 &&
          b2 === 0x4a &&
          b3 === 0x49 &&
          local + 16 <= n &&
          chunkBuf.toString('ascii', local, local + 16) === 'FUJIFILMCCD-RAW '
        ) {
          matchedExt = 'raf';
          measured = { size: Math.min(48 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (
          (b0 === 0x49 && b1 === 0x49 && ((b2 === 0x2a && b3 === 0x00) || (b2 === 0x52 && b3 === 0x4f) || (b2 === 0x55 && b3 === 0x00))) ||
          (b0 === 0x4d && b1 === 0x4d && b2 === 0x00 && b3 === 0x2a)
        ) {
          const flavor = detectTiffRawFlavor(chunkBuf, local, Math.min(4096, n - local));
          if (flavor) {
            matchedExt = flavor;
            const defaultSize = flavor === 'tif' ? 16 * 1024 * 1024 : 36 * 1024 * 1024;
            measured = { size: Math.min(defaultSize, totalLimitBytes - absOffset), truncated: false };
          }
        } else if (b0 === 0x1a && b1 === 0x45 && b2 === 0xdf && b3 === 0xa3) {
          matchedExt = chunkBuf.toString('latin1', local, Math.min(n, local + 64)).includes('webm') ? 'webm' : 'mkv';
          measured = { size: Math.min(16 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x58) {
          const fourcc = chunkBuf.toString('ascii', local + 8, local + 12);
          if (fourcc === 'Egg!') {
            matchedExt = 'aep';
            measured = measureRifxFromFd(fd, absOffset, totalLimitBytes);
          }
        } else if (b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x46) {
          const fourcc = chunkBuf.toString('ascii', local + 8, local + 12);
          if (fourcc === 'WAVE' || fourcc === 'AVI ' || fourcc === 'WEBP' || fourcc === 'ACON' || fourcc.startsWith('CDR')) {
            matchedExt = fourcc === 'WAVE' ? 'wav' : fourcc === 'AVI ' ? 'avi' : fourcc === 'WEBP' ? 'webp' : fourcc === 'ACON' ? 'ani' : 'cdr';
            const riffSize = chunkBuf.readUInt32LE(local + 4) + 8;
            measured = {
              size: Math.min(riffSize, totalLimitBytes - absOffset),
              truncated: riffSize > totalLimitBytes - absOffset,
            };
          }
        } else if (b0 === 0x46 && b1 === 0x4f && b2 === 0x52 && b3 === 0x4d && local + 12 <= n) {
          const fc = chunkBuf.toString('ascii', local + 8, local + 12);
          if (fc === 'AIFF' || fc === 'AIFC') {
            matchedExt = 'aiff';
            const sz = chunkBuf.readUInt32BE(local + 4) + 8;
            measured = { size: Math.min(sz, totalLimitBytes - absOffset), truncated: sz > totalLimitBytes - absOffset };
          }
        } else if (b0 === 0x30 && b1 === 0x26 && b2 === 0xb2 && b3 === 0x75) {
          matchedExt = 'wmv';
          measured = { size: Math.min(16 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x46 && b1 === 0x4c && b2 === 0x56 && b3 === 0x01) {
          matchedExt = 'flv';
          measured = { size: Math.min(16 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x06 && b1 === 0x0e && b2 === 0x2b && b3 === 0x34) {
          matchedExt = 'mxf';
          measured = { size: Math.min(32 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x25 && b1 === 0x50 && b2 === 0x44 && b3 === 0x46 && b4 === 0x2d) {
          matchedExt = 'pdf';
          measured = measurePdfFromFd(fd, absOffset, totalLimitBytes);
        } else if (b0 === 0x50 && b1 === 0x4b && b2 === 0x03 && b3 === 0x04) {
          matchedExt = detectZipFlavorFromFd(fd, absOffset, totalLimitBytes);
          measured = measureZipFromFd(fd, absOffset, totalLimitBytes);
        } else if (b0 === 0xd0 && b1 === 0xcf && b2 === 0x11 && b3 === 0xe0) {
          matchedExt = detectOle2FlavorFromFd(fd, absOffset, totalLimitBytes);
          measured = { size: Math.min(4 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x21 && b1 === 0x42 && b2 === 0x44 && b3 === 0x4e && local + 12 <= n) {
          const magic2 = chunkBuf.toString('ascii', local + 8, local + 10);
          if (magic2 === 'SM' || magic2 === 'SO') {
            matchedExt = magic2 === 'SO' ? 'ost' : 'pst';
            measured = { size: Math.min(64 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
          }
        } else if (b0 === 0x7b && b1 === 0x5c && b2 === 0x72 && b3 === 0x74 && b4 === 0x66) {
          matchedExt = 'rtf';
          measured = { size: Math.min(2 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x53 && b1 === 0x51 && b2 === 0x4c && b3 === 0x69 && local + 15 <= n && chunkBuf.toString('ascii', local, local + 15) === 'SQLite format 3') {
          matchedExt = 'sqlite';
          measured = measureSqliteFromFd(fd, absOffset, totalLimitBytes);
        } else if (b0 === 0x49 && b1 === 0x44 && b2 === 0x33 && local + 10 <= n) {
          const tagSz =
            ((chunkBuf[local + 6] & 0x7f) << 21) |
            ((chunkBuf[local + 7] & 0x7f) << 14) |
            ((chunkBuf[local + 8] & 0x7f) << 7) |
            (chunkBuf[local + 9] & 0x7f);
          if (tagSz > 0) {
            matchedExt = 'mp3';
            measured = { size: Math.min(tagSz + 4 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
          }
        } else if (b0 === 0x66 && b1 === 0x4c && b2 === 0x61 && b3 === 0x43) {
          matchedExt = 'flac';
          measured = { size: Math.min(16 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x4f && b1 === 0x67 && b2 === 0x67 && b3 === 0x53) {
          matchedExt = chunkBuf.toString('latin1', local, Math.min(n, local + 64)).includes('OpusHead') ? 'opus' : 'ogg';
          measured = { size: Math.min(8 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x4d && b1 === 0x54 && b2 === 0x68 && b3 === 0x64) {
          matchedExt = 'mid';
          measured = { size: Math.min(256 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x52 && b1 === 0x61 && b2 === 0x72 && b3 === 0x21) {
          matchedExt = 'rar';
          measured = { size: Math.min(16 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x37 && b1 === 0x7a && b2 === 0xbc && b3 === 0xaf && b4 === 0x27) {
          matchedExt = '7z';
          measured = { size: Math.min(16 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x1f && b1 === 0x8b && b2 === 0x08) {
          matchedExt = 'gz';
          measured = { size: Math.min(8 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x42 && b1 === 0x5a && b2 === 0x68 && chunkBuf[local + 3] >= 0x31 && chunkBuf[local + 3] <= 0x39) {
          matchedExt = 'bz2';
          measured = { size: Math.min(8 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0xfd && b1 === 0x37 && b2 === 0x7a && b3 === 0x58 && b4 === 0x5a && chunkBuf[local + 5] === 0x00) {
          matchedExt = 'xz';
          measured = { size: Math.min(8 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x28 && b1 === 0xb5 && b2 === 0x2f && b3 === 0xfd) {
          matchedExt = 'zst';
          measured = { size: Math.min(8 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x04 && b1 === 0x22 && b2 === 0x4d && b3 === 0x18) {
          matchedExt = 'lz4';
          measured = { size: Math.min(8 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x4d && b1 === 0x53 && b2 === 0x43 && b3 === 0x46 && local + 12 <= n) {
          const cabLen = chunkBuf.readUInt32LE(local + 8);
          if (cabLen > 32 && cabLen < 256 * 1024 * 1024) {
            matchedExt = 'cab';
            measured = { size: Math.min(cabLen, totalLimitBytes - absOffset), truncated: cabLen > totalLimitBytes - absOffset };
          }
        } else if (local + 265 <= n && chunkBuf[local + 257] === 0x75 && chunkBuf.toString('ascii', local + 257, local + 262) === 'ustar') {
          matchedExt = 'tar';
          measured = measureTarFromFd(fd, absOffset, totalLimitBytes);
        } else if (b0 === 0x42 && b1 === 0x4c && b2 === 0x45 && b3 === 0x4e && local + 12 <= n && chunkBuf.toString('ascii', local, local + 7) === 'BLENDER') {
          matchedExt = 'blend';
          measured = { size: Math.min(32 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x67 && b1 === 0x6c && b2 === 0x54 && b3 === 0x46 && local + 12 <= n) {
          const glbLen = chunkBuf.readUInt32LE(local + 8);
          if (glbLen >= 20 && glbLen < 256 * 1024 * 1024) {
            matchedExt = 'glb';
            measured = { size: Math.min(glbLen, totalLimitBytes - absOffset), truncated: glbLen > totalLimitBytes - absOffset };
          }
        } else if (b0 === 0x41 && b1 === 0x43 && b2 === 0x31 && b3 === 0x30 && local + 6 <= n && /^AC10\d\d$/.test(chunkBuf.toString('ascii', local, local + 6))) {
          matchedExt = 'dwg';
          measured = { size: Math.min(16 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x52 && b1 === 0x50 && b2 === 0x41 && b3 === 0x2d && local + 8 <= n) {
          const hdrStr = chunkBuf.toString('ascii', local, local + 7);
          if (hdrStr === 'RPA-3.0' || hdrStr === 'RPA-2.0') {
            matchedExt = 'rpa';
            measured = { size: Math.min(64 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
          }
        } else if (b0 === 0x52 && b1 === 0x45 && b2 === 0x4e && b3 === 0x50 && local + 10 <= n && chunkBuf.toString('ascii', local, local + 10) === 'RENPY RPC2') {
          matchedExt = 'rpyc';
          measured = { size: Math.min(512 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x45 && b1 === 0x6c && b2 === 0x66 && b3 === 0x46 && local + 8 <= n && chunkBuf.toString('ascii', local, local + 8) === 'ElfFile\0') {
          matchedExt = 'evtx';
          measured = { size: Math.min(20 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x4c && b1 === 0x00 && b2 === 0x00 && b3 === 0x00 && local + 20 <= n && b4 === 0x01 && chunkBuf[local + 5] === 0x14) {
          matchedExt = 'lnk';
          measured = { size: Math.min(16384, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x0a && b1 === 0x0d && b2 === 0x0d && b3 === 0x0a && local + 16 <= n) {
          matchedExt = 'pcapng';
          measured = { size: Math.min(16 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if ((b0 === 0xd4 && b1 === 0xc3 && b2 === 0xb2 && b3 === 0xa1) || (b0 === 0xa1 && b1 === 0xb2 && b2 === 0xc3 && b3 === 0xd4)) {
          matchedExt = 'pcap';
          measured = { size: Math.min(16 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x03 && b1 === 0xd9 && b2 === 0xa2 && b3 === 0x9a) {
          matchedExt = 'kdbx';
          measured = { size: Math.min(4 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x00 && b1 === 0x61 && b2 === 0x73 && b3 === 0x6d && local + 8 <= n) {
          matchedExt = 'wasm';
          measured = { size: Math.min(8 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x4f && b1 === 0x54 && b2 === 0x54 && b3 === 0x4f) {
          matchedExt = 'otf';
          measured = { size: Math.min(2 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x77 && b1 === 0x4f && b2 === 0x46 && (b3 === 0x46 || b3 === 0x32)) {
          matchedExt = b3 === 0x32 ? 'woff2' : 'woff';
          const wLen = local + 12 <= n ? chunkBuf.readUInt32BE(local + 8) : 512 * 1024;
          measured = { size: Math.min(Math.max(1024, wLen), totalLimitBytes - absOffset), truncated: false };
        }

        if (matchedExt && measured && measured.size >= 32) {
          const pad = String(fileSeq).padStart(5, '0');
          const filename = `${matchedExt.toUpperCase()}_W${workerIndex}_${pad}.${matchedExt}`;
          const headerLen = Math.min(65536, measured.size);
          const hdrSample = Buffer.allocUnsafe(headerLen);
          const hRead = fs.readSync(fd, hdrSample, 0, headerLen, absOffset);
          const discoveryCrc32 = computeCrc32Buf(hdrSample, hRead);

          batch.push({
            id: `drv-${absOffset}-${matchedExt}`,
            filename,
            originalPath: `${devicePath} @ sector ${Math.floor(absOffset / 512)}`,
            extensionHint: matchedExt,
            size: measured.size,
            calculatedSize: measured.size,
            truncated: measured.truncated,
            modifiedAt: Date.now(),
            sourceKind: 'carved',
            isDeleted: true,
            scanPhase: 'deep',
            offset: absOffset,
            sector: Math.floor(absOffset / 512),
            devicePath,
            discoveryCrc32,
            headerSample: new Uint8Array(hdrSample.buffer, hdrSample.byteOffset, hRead),
          });
          fileSeq++;
          const alignedSkip = Math.max(step, Math.ceil(measured.size / step) * step);
          local += alignedSkip;
          continue;
        }

        local += step;
      }

      if (batch.length > 0) {
        parentPort.postMessage({ type: 'batch', entries: batch });
      }
      cursor += n;
      parentPort.postMessage({
        type: 'progress',
        workerIndex,
        deltaBytes: n,
        currentOffset: cursor,
        latestName: batch.length > 0 ? batch[batch.length - 1].filename : undefined,
      });

      await new Promise((r) => setTimeout(r, 0));
    }

    parentPort.postMessage({ type: 'done', workerIndex });
  } finally {
    fs.closeSync(fd);
  }
}

runWorker().catch((err) => {
  parentPort.postMessage({ type: 'error', message: err?.message || 'worker error' });
});
