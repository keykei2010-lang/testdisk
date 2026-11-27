const fs = require('node:fs');

const DEFAULT_MAX_ALIGNED_CHUNK = 4 * 1024 * 1024;

/**
 * Aligns a byte size to a safe power-of-two sector size (default 512, minimum 512).
 */
function normalizeSectorSize(sectorSize) {
  const n = Number(sectorSize);
  if (!Number.isFinite(n) || n < 512) return 512;
  if (n >= 4096) return 4096;
  if (n >= 2048) return 2048;
  if (n >= 1024) return 1024;
  return 512;
}

/**
 * Probes an open file descriptor to find a sector size accepted by the OS/device handle.
 * On Windows 4Kn physical/volume handles, unaligned 512-byte reads can fail with EINVAL
 * whereas 4096-byte aligned reads succeed.
 */
function detectSectorSizeSync(fd, preferredSectorSize) {
  if (preferredSectorSize && Number(preferredSectorSize) >= 512) {
    const candidate = normalizeSectorSize(preferredSectorSize);
    try {
      const probe = Buffer.allocUnsafe(candidate);
      fs.readSync(fd, probe, 0, candidate, 0);
      return candidate;
    } catch (err) {
      if (err && err.code !== 'EINVAL' && candidate === 512) {
        return 512;
      }
    }
  }
  for (const cand of [512, 4096]) {
    try {
      const probe = Buffer.allocUnsafe(cand);
      fs.readSync(fd, probe, 0, cand, 0);
      return cand;
    } catch (err) {
      if (err && err.code !== 'EINVAL' && cand === 512) {
        return 512;
      }
    }
  }
  return 4096;
}

/**
 * Reads `len` bytes from `filePos` into `dstBuf` at `dstOff` using sector-aligned OS reads.
 * Any unaligned prefix or tail is trimmed in memory from an aligned scratch buffer.
 */
function readAlignedSync(fd, dstBuf, dstOff, len, filePos, sectorSize = 512) {
  if (!dstBuf || len <= 0 || filePos < 0) return 0;
  const sec = normalizeSectorSize(sectorSize);
  const targetLen = Math.min(len, Math.max(0, dstBuf.length - dstOff));
  if (targetLen <= 0) return 0;

  const alignedStart = Math.floor(filePos / sec) * sec;
  const headTrim = filePos - alignedStart;
  const alignedEnd = Math.ceil((filePos + targetLen) / sec) * sec;
  const totalAligned = alignedEnd - alignedStart;

  // Fast path when caller already passes a sector-aligned offset, offset 0, and sector-multiple length
  if (headTrim === 0 && (targetLen % sec === 0) && dstOff + totalAligned <= dstBuf.length) {
    let copied = 0;
    while (copied < targetLen) {
      const step = Math.min(DEFAULT_MAX_ALIGNED_CHUNK, targetLen - copied);
      const n = fs.readSync(fd, dstBuf, dstOff + copied, step, filePos + copied);
      if (n <= 0) break;
      copied += n;
      if (n < step) break;
    }
    return copied;
  }

  const maxScratch = Math.max(sec, Math.floor(DEFAULT_MAX_ALIGNED_CHUNK / sec) * sec);
  const scratchSize = Math.min(totalAligned, maxScratch);
  const scratch = Buffer.allocUnsafe(scratchSize);

  let diskPos = alignedStart;
  let remaining = totalAligned;
  let outCursor = 0;

  while (remaining > 0 && outCursor < targetLen) {
    const chunkReq = Math.min(scratchSize, remaining);
    const alignedReq = Math.ceil(chunkReq / sec) * sec;
    const n = fs.readSync(fd, scratch, 0, Math.min(scratchSize, alignedReq), diskPos);
    if (n <= 0) break;

    const chunkStartAbs = diskPos;
    const chunkEndAbs = diskPos + n;
    const reqStartAbs = filePos + outCursor;
    const reqEndAbs = filePos + targetLen;

    const copyStartAbs = Math.max(chunkStartAbs, reqStartAbs);
    const copyEndAbs = Math.min(chunkEndAbs, reqEndAbs);

    if (copyEndAbs > copyStartAbs) {
      const take = copyEndAbs - copyStartAbs;
      const srcStart = copyStartAbs - chunkStartAbs;
      scratch.copy(dstBuf, dstOff + outCursor, srcStart, srcStart + take);
      outCursor += take;
    }

    if (n < chunkReq) break;
    diskPos += n;
    remaining -= n;
  }

  return outCursor;
}

/**
 * Sector-aligned read with bad-sector resilience: if a large read throws (e.g., EIO/CRC error),
 * retries one sector at a time, zero-filling unreadable sectors and recording skipped ranges
 * so deep carving / metadata recovery never aborts the entire drive or worker range.
 */
const FATAL_IO_ERRNOS = new Set([
  'EBADF',
  'EACCES',
  'EPERM',
  'ENXIO',
  'ENODEV',
  'ENOENT',
  'ESHUTDOWN',
]);

function readAlignedResilientSync(fd, dstBuf, dstOff, len, filePos, sectorSize = 512) {
  const sec = normalizeSectorSize(sectorSize);
  const targetLen = Math.min(len, Math.max(0, dstBuf.length - dstOff));
  if (targetLen <= 0 || filePos < 0) {
    return { bytesRead: 0, skippedSectors: 0, skippedBytes: 0, skippedRanges: [] };
  }

  try {
    const bytesRead = readAlignedSync(fd, dstBuf, dstOff, targetLen, filePos, sec);
    return { bytesRead, skippedSectors: 0, skippedBytes: 0, skippedRanges: [] };
  } catch (bulkErr) {
    if (bulkErr && FATAL_IO_ERRNOS.has(bulkErr.code)) {
      throw bulkErr;
    }
  }

  const alignedStart = Math.floor(filePos / sec) * sec;
  const alignedEnd = Math.ceil((filePos + targetLen) / sec) * sec;
  const secScratch = Buffer.allocUnsafe(sec);

  let maxReach = 0;
  let skippedSectors = 0;
  let skippedBytes = 0;
  const skippedRanges = [];

  for (let sPos = alignedStart; sPos < alignedEnd; sPos += sec) {
    let n = 0;
    let sectorFailed = false;
    try {
      n = fs.readSync(fd, secScratch, 0, sec, sPos);
      if (n < sec && n > 0) {
        secScratch.fill(0, n, sec);
      }
    } catch (secErr) {
      if (secErr && FATAL_IO_ERRNOS.has(secErr.code)) {
        throw secErr;
      }
      sectorFailed = true;
      n = sec;
      secScratch.fill(0);
    }

    if (sectorFailed) {
      skippedSectors++;
      const copyStartAbs = Math.max(sPos, filePos);
      const copyEndAbs = Math.min(sPos + sec, filePos + targetLen);
      const lostLen = Math.max(0, copyEndAbs - copyStartAbs);
      skippedBytes += lostLen;
      if (lostLen > 0) {
        const last = skippedRanges[skippedRanges.length - 1];
        if (last && last.offset + last.length === copyStartAbs) {
          last.length += lostLen;
        } else {
          skippedRanges.push({ offset: copyStartAbs, length: lostLen });
        }
      }
    }

    if (n <= 0) break;

    const copyStartAbs = Math.max(sPos, filePos);
    const copyEndAbs = Math.min(sPos + n, filePos + targetLen);
    if (copyEndAbs > copyStartAbs) {
      const take = copyEndAbs - copyStartAbs;
      const dstPos = dstOff + (copyStartAbs - filePos);
      const srcPos = copyStartAbs - sPos;
      secScratch.copy(dstBuf, dstPos, srcPos, srcPos + take);
      maxReach = Math.max(maxReach, copyEndAbs - filePos);
    }

    if (!sectorFailed && n < sec) break;
  }

  return {
    bytesRead: maxReach,
    skippedSectors,
    skippedBytes,
    skippedRanges,
  };
}

module.exports = {
  FATAL_IO_ERRNOS,
  normalizeSectorSize,
  detectSectorSizeSync,
  readAlignedSync,
  readAlignedResilientSync,
};
