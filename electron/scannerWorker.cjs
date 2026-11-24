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
          make = buf.toString('ascii', offset + valOff, offset + valOff + 16).toUpperCase();
        }
      }
    }
    if (make.includes('NIKON')) return 'nef';
    if (make.includes('SONY')) return 'arw';
    if (make.includes('CANON')) return 'cr2';
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
        } else if (b4 === 0x66 && chunkBuf[local + 5] === 0x74 && chunkBuf[local + 6] === 0x79 && chunkBuf[local + 7] === 0x70) {
          const brand = local + 12 <= n ? chunkBuf.toString('ascii', local + 8, local + 12) : '';
          matchedExt = brand === 'crx ' ? 'cr3' : brand.toLowerCase().startsWith('qt') ? 'mov' : 'mp4';
          measured = measureMp4FromFd(fd, absOffset, totalLimitBytes);
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
          matchedExt = 'mkv';
          measured = { size: Math.min(16 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x46) {
          const fourcc = chunkBuf.toString('ascii', local + 8, local + 12);
          if (fourcc === 'WAVE' || fourcc === 'AVI ' || fourcc === 'WEBP') {
            matchedExt = fourcc === 'WAVE' ? 'wav' : fourcc === 'AVI ' ? 'avi' : 'webp';
            const riffSize = chunkBuf.readUInt32LE(local + 4) + 8;
            measured = {
              size: Math.min(riffSize, totalLimitBytes - absOffset),
              truncated: riffSize > totalLimitBytes - absOffset,
            };
          }
        } else if (b0 === 0x30 && b1 === 0x26 && b2 === 0xb2 && b3 === 0x75) {
          matchedExt = 'wmv';
          measured = { size: Math.min(16 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x46 && b1 === 0x4c && b2 === 0x56 && b3 === 0x01) {
          matchedExt = 'flv';
          measured = { size: Math.min(16 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x25 && b1 === 0x50 && b2 === 0x44 && b3 === 0x46 && b4 === 0x2d) {
          matchedExt = 'pdf';
          measured = measurePdfFromFd(fd, absOffset, totalLimitBytes);
        } else if (b0 === 0x50 && b1 === 0x4b && b2 === 0x03 && b3 === 0x04) {
          matchedExt = 'zip';
          measured = measureZipFromFd(fd, absOffset, totalLimitBytes);
        } else if (b0 === 0xd0 && b1 === 0xcf && b2 === 0x11 && b3 === 0xe0) {
          matchedExt = 'doc';
          measured = { size: Math.min(4 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
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
          matchedExt = 'ogg';
          measured = { size: Math.min(8 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x52 && b1 === 0x61 && b2 === 0x72 && b3 === 0x21) {
          matchedExt = 'rar';
          measured = { size: Math.min(16 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x37 && b1 === 0x7a && b2 === 0xbc && b3 === 0xaf && b4 === 0x27) {
          matchedExt = '7z';
          measured = { size: Math.min(16 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x1f && b1 === 0x8b && b2 === 0x08) {
          matchedExt = 'gz';
          measured = { size: Math.min(8 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
        } else if (b0 === 0x38 && b1 === 0x42 && b2 === 0x50 && b3 === 0x53) {
          matchedExt = 'psd';
          measured = { size: Math.min(24 * 1024 * 1024, totalLimitBytes - absOffset), truncated: false };
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
