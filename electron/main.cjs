let app = null;
let BrowserWindow = null;
let dialog = null;
let ipcMain = null;
try {
  ({ app, BrowserWindow, dialog, ipcMain } = require('electron'));
} catch {
  // Allows loading and unit-testing pure Node recovery functions outside Electron runtime
}
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const {
  normalizeSectorSize,
  detectSectorSizeSync,
  readAlignedSync,
  readAlignedResilientSync,
} = require('./alignedIoCjs.cjs');
const {
  getEngineCapabilitiesSync,
  checkWindowsIsAdmin,
  getCurrentUserWindowsSid,
  runMmlsPartitions,
  runTskFlsScan,
  extractTskInodeToFile,
  readTskInodeHead,
  identifyBufferHeadCjs,
  runFidentifyPaths,
  probeVideoFrameWithFfmpeg,
  ffmpegRepairVideoFile,
} = require('./enginesHelper.cjs');
const {
  repairMp4StreamingFileCjs,
  repairJpegBufferCjs,
  repairPngBufferCjs,
  repairAviBufferCjs,
  extractEmbeddedJpegCjs,
  stitchFragmentedVideosFromFdCjs,
} = require('./mediaRepairCjs.cjs');
const { repairNonMediaBufferCjs } = require('./documentRepairCjs.cjs');
const {
  buildNtfsVolumeScanPlanCjs,
  filterAndTagEmptiedRecycleEntriesCjs,
  isRecycleBinEntryName,
  rePairDeletedRecycleRecordsCjs,
} = require('./recycleBinCjs.cjs');

const activeScans = new Map();
const WINDOWS_EPOCH_DIFF_MS = 11644473600000;
const NTFS_BITMAP_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_MFT_RECORDS = 1000000;
const DEFAULT_MAX_HUNT_RECORDS = 500000;

const CRC32_TABLE_CJS = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE_CJS[n] = c >>> 0;
}

function computeCrc32Cjs(buf, len = 65536) {
  if (!buf || buf.length === 0) return 0;
  let crc = 0xffffffff;
  const end = Math.min(buf.length, len);
  for (let i = 0; i < end; i++) {
    crc = CRC32_TABLE_CJS[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const ZIP_CONTAINER_EXTS_CJS = new Set([
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
  'xps',
  'zip',
]);
const OLE2_CONTAINER_EXTS_CJS = new Set(['doc', 'xls', 'ppt', 'msi', 'msg', 'pub']);
const NON_MEDIA_REPAIR_EXTS_CJS = new Set([
  'zip', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'epub', 'apk', 'jar', 'kra', 'ora', 'kmz',
  'aep', 'sqlite', 'db', 'sqlite3', 'psd', 'psb', 'pdf',
  'doc', 'xls', 'ppt', 'msg', 'msi', 'pst', 'ost', 'rpa',
  'aepx', 'xml', 'svg', 'html', 'htm', 'json', 'rpy', 'txt', 'py', 'ini', 'csv', 'sql', 'eml', 'rtf',
  'tar', 'gz', 'mp3', 'flac',
]);

function detectMagicExtFromHeadCjs(buf) {
  return identifyBufferHeadCjs(buf);
}

function resolvePreferredFilenameCjs(filename, detectedExt) {
  const cleanDetected = String(detectedExt || '').trim().toLowerCase().replace(/^\./, '');
  if (!cleanDetected || cleanDetected === 'unknown' || cleanDetected === 'bin') return filename;
  const lastDot = filename.lastIndexOf('.');
  const curExt = lastDot > 0 ? filename.slice(lastDot + 1).toLowerCase() : '';
  const stem = lastDot > 0 ? filename.slice(0, lastDot) : filename;
  if (!curExt || curExt === 'bin' || curExt === 'unknown' || curExt === 'tmp') {
    return `${stem}.${cleanDetected}`;
  }
  if (curExt === cleanDetected) return filename;
  if ((curExt === 'jpeg' && cleanDetected === 'jpg') || (curExt === 'jpg' && cleanDetected === 'jpeg')) return filename;
  if ((curExt === 'tiff' && cleanDetected === 'tif') || (curExt === 'tif' && cleanDetected === 'tiff')) return filename;
  if ((curExt === 'ost' && cleanDetected === 'pst') || (curExt === 'pst' && cleanDetected === 'ost')) return filename;
  if (cleanDetected === 'sqlite' && (curExt === 'db' || curExt === 'sqlite3')) return filename;
  if (cleanDetected === 'xml' && ['svg', 'aepx', 'html', 'htm'].includes(curExt)) return filename;
  if (cleanDetected === 'zip' && ZIP_CONTAINER_EXTS_CJS.has(curExt)) return filename;
  if (cleanDetected === 'doc' && OLE2_CONTAINER_EXTS_CJS.has(curExt)) return filename;
  return `${stem}.${cleanDetected}`;
}

function runPowerShellJson(script) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout || !stdout.trim()) {
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch {
          resolve([]);
        }
      },
    );
  });
}

function sanitizeWinFilename(rawName) {
  let name = String(rawName || 'recovered_file')
    .slice(0, 240)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '');
  if (!name) name = 'recovered_file';
  const stem = name.split('.')[0].toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
    name = `_${name}`;
  }
  return name;
}

function readHeaderSample(filePath, maxBytes = 65536) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const len = Math.min(stat.size, maxBytes);
    const buf = Buffer.allocUnsafe(len);
    const bytesRead = fs.readSync(fd, buf, 0, len, 0);
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      sample: new Uint8Array(buf.buffer, buf.byteOffset, bytesRead),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function parseRecycleIFileBuffer(buf) {
  if (!buf || buf.length < 28) return null;
  const verLo = buf.readUInt32LE(0);
  const verHi = buf.readUInt32LE(4);
  if (verHi !== 0 || (verLo !== 1 && verLo !== 2)) return null;

  const sizeLo = buf.readUInt32LE(8);
  const sizeHi = buf.readUInt32LE(12);
  const originalSize = sizeHi * 4294967296 + sizeLo;

  const ftLo = buf.readUInt32LE(16);
  const ftHi = buf.readUInt32LE(20);
  const ticks = ftHi * 4294967296 + ftLo;
  const deletedAtMs = ticks > 0 ? Math.floor(ticks / 10000 - WINDOWS_EPOCH_DIFF_MS) : undefined;

  let originalPath = '';
  if (verLo === 1) {
    originalPath = buf.toString('utf16le', 24, Math.min(buf.length, 544)).split('\0')[0];
  } else {
    const charCount = buf.readUInt32LE(24);
    const end = Math.min(buf.length, 28 + charCount * 2);
    originalPath = buf.toString('utf16le', 28, end).split('\0')[0];
  }
  if (!originalPath) return null;
  return {
    originalSize,
    deletedAtMs,
    originalPath,
    originalName: path.basename(originalPath),
  };
}

function walkFolderEntries(dirPath, outList, maxFiles = 5000, recycleMeta = null, relPrefix = '') {
  if (outList.length >= maxFiles) return;
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (outList.length >= maxFiles) break;
    const full = path.join(dirPath, entry.name);
    const childRel = relPrefix ? path.join(relPrefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      walkFolderEntries(full, outList, maxFiles, recycleMeta, childRel);
    } else if (entry.isFile()) {
      try {
        const info = readHeaderSample(full, 65536);
        const ext = path.extname(entry.name).replace(/^\./, '').toLowerCase();
        const isRecycledChild = Boolean(recycleMeta);
        const origPath = isRecycledChild
          ? path.join(recycleMeta.originalPath, childRel)
          : relPrefix
            ? path.join(relPrefix, entry.name)
            : full;
        outList.push({
          id: `${isRecycledChild ? 'recycle' : 'folder'}-${full}`,
          filename: entry.name,
          originalPath: origPath,
          relPath: childRel,
          extensionHint: ext,
          size: info.size,
          modifiedAt: recycleMeta ? recycleMeta.deletedAtMs : info.mtimeMs,
          sourceKind: isRecycledChild ? 'recycle-bin' : 'folder',
          isDeleted: isRecycledChild,
          scanPhase: 'quick',
          offset: 0,
          sector: 0,
          devicePath: full,
          discoveryCrc32: computeCrc32Cjs(info.sample, info.sample.length),
          headerSample: info.sample,
        });
      } catch {
        // skip unreadable/locked system files
      }
    }
  }
}

function scanRecycleDir(recycleRoot, outList, maxFiles = 5000, preferredSid = null) {
  if (!fs.existsSync(recycleRoot) || outList.length >= maxFiles) return;
  let sidDirs;
  try {
    sidDirs = fs.readdirSync(recycleRoot, { withFileTypes: true });
  } catch {
    return;
  }

  // Prioritize active user's SID folder first (Digger per-user SID scoping), then orphaned SIDs
  if (preferredSid) {
    sidDirs.sort((a, b) => {
      const aMatch = a.name.toUpperCase() === preferredSid.toUpperCase() ? 0 : 1;
      const bMatch = b.name.toUpperCase() === preferredSid.toUpperCase() ? 0 : 1;
      return aMatch - bMatch;
    });
  }

  for (const sid of sidDirs) {
    if (!sid.isDirectory()) continue;
    const sidPath = path.join(recycleRoot, sid.name);
    let files;
    try {
      files = fs.readdirSync(sidPath, { withFileTypes: true });
    } catch {
      continue;
    }

    const iMetaMap = new Map();
    for (const f of files) {
      if (f.isFile() && f.name.startsWith('$I')) {
        try {
          const iBuf = fs.readFileSync(path.join(sidPath, f.name));
          const meta = parseRecycleIFileBuffer(iBuf);
          if (meta) {
            iMetaMap.set(f.name.slice(2).toLowerCase(), meta);
          }
        } catch {
          // ignore unreadable $I
        }
      }
    }

    for (const f of files) {
      if (outList.length >= maxFiles) break;
      if (!f.name.startsWith('$R')) continue;
      const fullR = path.join(sidPath, f.name);
      const key = f.name.slice(2).toLowerCase();
      const meta = iMetaMap.get(key) || null;

      if (f.isDirectory()) {
        // WinDirStat ResolveRecyclePaths style: propagate parent $I path & timestamp to nested children
        walkFolderEntries(fullR, outList, maxFiles, meta, '');
        continue;
      }
      try {
        const info = readHeaderSample(fullR, 65536);
        const name = meta?.originalName || f.name;
        const ext = path.extname(name).replace(/^\./, '').toLowerCase();
        outList.push({
          id: `recycle-${fullR}`,
          filename: name,
          originalPath: meta?.originalPath || fullR,
          extensionHint: ext,
          size: info.size,
          modifiedAt: meta?.deletedAtMs || info.mtimeMs,
          sourceKind: 'recycle-bin',
          isDeleted: true,
          scanPhase: 'quick',
          offset: 0,
          sector: 0,
          devicePath: fullR,
          discoveryCrc32: computeCrc32Cjs(info.sample, info.sample.length),
          headerSample: info.sample,
        });
      } catch {
        // skip locked $R
      }
    }
  }
}

// Fast MP4/MOV/HEIC atom walker on open fd (tracks ftyp/moov/mdat & 64-bit largesize boxes)
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

// Digler-inspired JPEG marker-segment walker on open fd:
// Jumps APP0/APP1(EXIF thumbnails)/DQT/DHT/SOF cleanly by exact 16-bit segment lengths until SOS (0xDA),
// then scans entropy stream honoring 0xFF 0x00 stuffing & RSTn markers for the real 0xFFD9 EOI.
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
    if (marker === 0xd9) {
      return { size: pos - startOffset, truncated: false };
    }
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd8)) {
      continue;
    }
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
        if (b === 0xd9) {
          return { size: pos + i + 1 - startOffset, truncated: false };
        }
        prevFf = b === 0xff;
        continue;
      }
      if (b === 0xff) {
        prevFf = true;
      }
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
    if (hitIdx !== -1) {
      return pos + hitIdx;
    }
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
  if (hit !== -1) {
    return { size: hit + 2 - startOffset, truncated: false };
  }
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

// Discover MBR + GPT partitions and probe NTFS / FAT32 / exFAT / BitLocker boot sectors
function detectVolumesFromDisk(fd, limitBytes, sectorSizeHint) {
  const volumes = [];
  const seenStarts = new Set();
  const sectorSize = sectorSizeHint
    ? normalizeSectorSize(sectorSizeHint)
    : detectSectorSizeSync(fd);

  const inspectBoot = (startByte, totalBytesFromTable, detectedSecSize = sectorSize) => {
    if (seenStarts.has(startByte) || startByte < 0 || startByte + 512 > limitBytes) return;
    const boot = Buffer.allocUnsafe(512);
    try {
      if (readAlignedSync(fd, boot, 0, 512, startByte, detectedSecSize) < 512) return;
    } catch {
      return;
    }
    if (boot[510] !== 0x55 || boot[511] !== 0xaa) return;

    const oem = boot.toString('ascii', 3, 11);
    if (oem === '-FVE-FS-') {
      seenStarts.add(startByte);
      volumes.push({
        fsType: 'bitlocker',
        volStart: startByte,
        volEnd: Math.min(limitBytes, startByte + totalBytesFromTable),
        clusterBytes: 4096,
        sectorSize: detectedSecSize,
      });
      return;
    }

    if (oem === 'NTFS    ') {
      const bps = boot.readUInt16LE(11);
      const validBps = [512, 1024, 2048, 4096].includes(bps) ? bps : detectedSecSize;
      const spc = boot[13] || 8;
      const clusterBytes = Math.max(512, validBps * spc);
      const rawMft = boot.readInt8(64);
      const mftRecSize =
        rawMft < 0
          ? 1 << Math.min(12, Math.max(9, -rawMft))
          : Math.max(512, Math.min(4096, (rawMft || 1) * clusterBytes));
      const totalSectors = Number(boot.readBigUInt64LE(40));
      const ntfsTotalBytes =
        Number.isFinite(totalSectors) && totalSectors > 0 ? totalSectors * validBps : totalBytesFromTable;
      seenStarts.add(startByte);
      volumes.push({
        fsType: 'ntfs',
        volStart: startByte,
        volEnd: Math.min(limitBytes, startByte + Math.max(totalBytesFromTable || 0, ntfsTotalBytes || 0)),
        clusterBytes,
        sectorSize: Math.max(detectedSecSize, validBps),
        bps: validBps,
        mftRecSize,
      });
      return;
    }

    if (oem === 'EXFAT   ') {
      const bps = 1 << Math.min(12, Math.max(9, boot[108] || 9));
      const spc = 1 << Math.min(25, boot[109] || 3);
      seenStarts.add(startByte);
      volumes.push({
        fsType: 'exfat',
        volStart: startByte,
        volEnd: Math.min(limitBytes, startByte + totalBytesFromTable),
        clusterBytes: bps * spc,
        sectorSize: Math.max(detectedSecSize, bps),
        bootBuf: boot,
      });
      return;
    }

    const bps = boot.readUInt16LE(11);
    const spc = boot[13];
    const fatSz16 = boot.readUInt16LE(22);
    const sig32 = boot.toString('ascii', 82, 90).trim();
    if ([512, 1024, 2048, 4096].includes(bps) && spc > 0 && fatSz16 === 0 && sig32.startsWith('FAT32')) {
      seenStarts.add(startByte);
      volumes.push({
        fsType: 'fat32',
        volStart: startByte,
        volEnd: Math.min(limitBytes, startByte + totalBytesFromTable),
        clusterBytes: bps * spc,
        sectorSize: Math.max(detectedSecSize, bps),
        bootBuf: boot,
      });
    }
  };

  try {
    // Also detect partitionless logical volume handles (e.g. \\.\C:, \\.\D:, or raw partition .img)
    inspectBoot(0, limitBytes, sectorSize);

    const mbr = Buffer.allocUnsafe(512);
    if (readAlignedSync(fd, mbr, 0, 512, 0, sectorSize) === 512 && mbr[510] === 0x55 && mbr[511] === 0xaa) {
      let hasGptPmbr = false;
      for (let i = 0; i < 4; i++) {
        const off = 0x1be + i * 16;
        const sysInd = mbr[off + 4];
        const startLba = mbr.readUInt32LE(off + 8);
        const secCount = mbr.readUInt32LE(off + 12);
        if (sysInd === 0xee) hasGptPmbr = true;
        if (sysInd !== 0 && sysInd !== 0xee && startLba > 0 && secCount > 0) {
          inspectBoot(startLba * sectorSize, secCount * sectorSize, sectorSize);
        }
      }

      if (hasGptPmbr && limitBytes >= sectorSize * 2) {
        const gptHdr = Buffer.allocUnsafe(512);
        let lbaUnit = sectorSize;
        let hasGpt =
          readAlignedSync(fd, gptHdr, 0, 512, lbaUnit, sectorSize) === 512 &&
          gptHdr.toString('ascii', 0, 8) === 'EFI PART';
        if (!hasGpt && sectorSize !== 512 && limitBytes >= 1024) {
          lbaUnit = 512;
          hasGpt =
            readAlignedSync(fd, gptHdr, 0, 512, 512, sectorSize) === 512 &&
            gptHdr.toString('ascii', 0, 8) === 'EFI PART';
        }
        if (hasGpt) {
          const partLbaLo = gptHdr.readUInt32LE(72);
          const partLbaHi = gptHdr.readUInt32LE(76);
          const numEntries = Math.min(128, gptHdr.readUInt32LE(80));
          const entrySize = gptHdr.readUInt32LE(84) || 128;
          const tableOff = (partLbaHi * 4294967296 + partLbaLo) * lbaUnit;
          const tableBytes = numEntries * entrySize;
          if (tableOff + tableBytes <= limitBytes) {
            const tbl = Buffer.allocUnsafe(tableBytes);
            if (readAlignedSync(fd, tbl, 0, tableBytes, tableOff, sectorSize) === tableBytes) {
              for (let i = 0; i < numEntries; i++) {
                const eOff = i * entrySize;
                let nonZero = false;
                for (let j = 0; j < 16; j++) {
                  if (tbl[eOff + j] !== 0) {
                    nonZero = true;
                    break;
                  }
                }
                if (!nonZero) continue;
                const sLba = tbl.readUInt32LE(eOff + 32) + tbl.readUInt32LE(eOff + 36) * 4294967296;
                const eLba = tbl.readUInt32LE(eOff + 40) + tbl.readUInt32LE(eOff + 44) * 4294967296;
                if (eLba >= sLba && sLba > 0) {
                  inspectBoot(sLba * lbaUnit, (eLba - sLba + 1) * lbaUnit, sectorSize);
                }
              }
            }
          }
        }
      }
    }
  } catch {
    // ignore partition detection errors on unpartitioned raw images
  }

  return volumes;
}

/**
 * Full-disk / streaming-image lost partition boot-sector hunter (#24).
 * Probes common MBR/GPT sector alignments (LBA 63, 128, 2048, 4096, etc.) and MiB boundaries
 * across the entire disk so unlisted partitions past 1 MiB (e.g. LBA 2048 on 512B/4K disks) are found.
 */
function scanLostPartitionsFromFd(fd, limitBytes, sectorSizeHint, maxScanBytes = 256 * 1024 * 1024 * 1024) {
  const sectorSize = sectorSizeHint ? normalizeSectorSize(sectorSizeHint) : detectSectorSizeSync(fd);
  const cap = Math.min(limitBytes, maxScanBytes);
  const found = [];
  const seenOffsets = new Set();
  const boot = Buffer.allocUnsafe(512);

  const inspectCandidate = (off, originLabel) => {
    if (seenOffsets.has(off) || off < 0 || off + 512 > cap) return;
    let n = 0;
    try {
      n = readAlignedSync(fd, boot, 0, 512, off, sectorSize);
    } catch {
      return;
    }
    if (n < 512 || boot[510] !== 0x55 || boot[511] !== 0xaa) return;

    const oem = boot.toString('ascii', 3, 11);
    const lbaStart = Math.floor(off / sectorSize);
    if (oem === 'NTFS    ') {
      const bps = boot.readUInt16LE(11);
      if (![512, 1024, 2048, 4096].includes(bps)) return;
      const totalSecs = Number(boot.readBigUInt64LE(40));
      if (!Number.isFinite(totalSecs) || totalSecs < 64) return;
      const sizeBytes = totalSecs * bps;
      seenOffsets.add(off);
      found.push({
        id: `lost-ntfs-${off}`,
        name: `NTFS Partition (${originLabel})`,
        fsType: 'NTFS',
        sysTypeByte: 0x07,
        startLba: lbaStart,
        endLba: lbaStart + Math.max(1, Math.floor(sizeBytes / sectorSize)) - 1,
        sectorSize,
        startOffset: off,
        sizeBytes,
        status: 'Lost (Found)',
        bootable: false,
      });
    } else if (oem === 'EXFAT   ') {
      const bps = 1 << Math.min(12, Math.max(9, boot[108] || 9));
      const volLen = Number(boot.readBigUInt64LE(72));
      if (!Number.isFinite(volLen) || volLen < 64) return;
      const sizeBytes = volLen * bps;
      seenOffsets.add(off);
      found.push({
        id: `lost-exfat-${off}`,
        name: `exFAT Partition (${originLabel})`,
        fsType: 'exFAT',
        sysTypeByte: 0x07,
        startLba: lbaStart,
        endLba: lbaStart + Math.max(1, Math.floor(sizeBytes / sectorSize)) - 1,
        sectorSize,
        startOffset: off,
        sizeBytes,
        status: 'Lost (Found)',
        bootable: false,
      });
    } else if (oem === '-FVE-FS-') {
      seenOffsets.add(off);
      found.push({
        id: `lost-fve-${off}`,
        name: `BitLocker Volume (${originLabel})`,
        fsType: 'BitLocker',
        sysTypeByte: 0x07,
        startLba: lbaStart,
        endLba: lbaStart + Math.max(1, Math.floor((cap - off) / sectorSize)) - 1,
        sectorSize,
        startOffset: off,
        sizeBytes: Math.max(sectorSize, cap - off),
        status: 'Lost (Found)',
        bootable: false,
      });
    } else {
      const bps = boot.readUInt16LE(11);
      const spc = boot[13];
      const fatSz16 = boot.readUInt16LE(22);
      const total32 = boot.readUInt32LE(32);
      const sig32 = boot.toString('ascii', 82, 90).trim();
      if ([512, 1024, 2048, 4096].includes(bps) && spc > 0 && fatSz16 === 0 && sig32.startsWith('FAT32') && total32 > 64) {
        const sizeBytes = total32 * bps;
        seenOffsets.add(off);
        found.push({
          id: `lost-fat32-${off}`,
          name: `FAT32 Partition (${originLabel})`,
          fsType: 'FAT32',
          sysTypeByte: 0x0c,
          startLba: lbaStart,
          endLba: lbaStart + Math.max(1, Math.floor(sizeBytes / sectorSize)) - 1,
          sectorSize,
          startOffset: off,
          sizeBytes,
          status: 'Lost (Found)',
          bootable: false,
        });
      }
    }
  };

  // Seed already known MBR/GPT table partitions
  for (const v of detectVolumesFromDisk(fd, cap, sectorSize)) {
    inspectCandidate(v.volStart, v.volStart === 0 ? 'Volume Root' : 'Partition Table');
  }

  // Probe well-known alignment LBAs across 512B and native sector sizes (LBA 63, 128, 2048, etc.)
  const commonLbas = [63, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
  for (const unit of sectorSize === 512 ? [512] : [512, sectorSize]) {
    for (const lba of commonLbas) {
      inspectCandidate(lba * unit, `LBA ${lba}`);
    }
  }

  // Probe MiB-aligned offsets across disk (up to 4096 MiB stride checks or adaptive stride on multi-TB drives)
  const mib = 1024 * 1024;
  const totalMibs = Math.floor(cap / mib);
  const strideMib = totalMibs <= 2048 ? 1 : Math.max(1, Math.floor(totalMibs / 2048));
  for (let m = 1; m <= totalMibs; m += strideMib) {
    inspectCandidate(m * mib, `MiB ${m}`);
  }

  return found;
}

function dosDateTimeToMs(dateVal, timeVal) {
  if (!dateVal) return undefined;
  const year = 1980 + ((dateVal >> 9) & 0x7f);
  const month = Math.max(1, (dateVal >> 5) & 0x0f);
  const day = Math.max(1, dateVal & 0x1f);
  const hour = (timeVal >> 11) & 0x1f;
  const min = (timeVal >> 5) & 0x3f;
  const sec = (timeVal & 0x1f) * 2;
  const ms = Date.UTC(year, month - 1, day, hour, min, sec);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

function extractLfnCharsCjs(entry) {
  const offsets = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
  let out = '';
  for (const o of offsets) {
    const code = entry[o] | (entry[o + 1] << 8);
    if (code === 0x0000 || code === 0xffff) break;
    out += String.fromCharCode(code);
  }
  return out;
}

// Stream FAT32 directory clusters via sector-aligned reads to recover deleted + existing LFN files
function scanFat32VolumeFromFd(fd, devicePath, vol, limitBytes, includeExisting = false, maxEntries = 25000) {
  const out = [];
  const warnings = [];
  Object.defineProperties(out, {
    warnings: { value: warnings, enumerable: false },
  });
  const boot = vol.bootBuf;
  if (!boot) return out;

  const sectorSize = vol.sectorSize || 512;
  const bps = boot.readUInt16LE(11) || 512;
  const spc = boot[13] || 8;
  const reserved = boot.readUInt16LE(14);
  const numFats = boot[16] || 2;
  const fatSz32 = boot.readUInt32LE(36);
  const rootCluster = boot.readUInt32LE(44) || 2;
  if (fatSz32 === 0) return out;

  const clusterBytes = bps * spc;
  const fatStart = vol.volStart + reserved * bps;
  const dataStart = fatStart + numFats * fatSz32 * bps;

  // Cache FAT sectors aligned to avoid single 4-byte unaligned reads
  let cachedFatSecOff = -1;
  const fatSecBuf = Buffer.allocUnsafe(sectorSize);
  const readFat = (cluster) => {
    const off = fatStart + cluster * 4;
    if (off + 4 > limitBytes) return 0;
    const secOff = Math.floor(off / sectorSize) * sectorSize;
    if (secOff !== cachedFatSecOff) {
      try {
        if (readAlignedSync(fd, fatSecBuf, 0, sectorSize, secOff, sectorSize) < sectorSize) {
          cachedFatSecOff = -1;
          return 0;
        }
        cachedFatSecOff = secOff;
      } catch {
        cachedFatSecOff = -1;
        return 0;
      }
    }
    return fatSecBuf.readUInt32LE(off - secOff) & 0x0fffffff;
  };

  const clusterBuf = Buffer.allocUnsafe(clusterBytes);
  const visited = new Set();
  const queue = [{ cluster: rootCluster, prefix: '', depth: 0, parentDeleted: false }];
  const maxClusters = 16384;
  let badReads = 0;

  while (queue.length > 0 && visited.size < maxClusters && out.length < maxEntries) {
    const { cluster: startCluster, prefix, depth, parentDeleted } = queue.shift();
    let cur = startCluster;
    let chain = 0;

    while (cur >= 2 && cur < 0x0ffffff0 && !visited.has(cur) && chain < 512) {
      visited.add(cur);
      const offByte = dataStart + (cur - 2) * clusterBytes;
      if (offByte < 0 || offByte + clusterBytes > limitBytes) break;
      let nRead = 0;
      try {
        nRead = readAlignedSync(fd, clusterBuf, 0, clusterBytes, offByte, sectorSize);
      } catch {
        badReads++;
        break;
      }
      if (nRead < 32) break;

      let lfnParts = [];
      let eod = false;
      for (let off = 0; off + 32 <= nRead && out.length < maxEntries; off += 32) {
        const entry = clusterBuf.subarray(off, off + 32);
        const firstByte = entry[0];
        if (firstByte === 0x00) {
          eod = true;
          break;
        }
        const attr = entry[11];
        if (attr === 0x0f) {
          lfnParts.push({ seq: firstByte === 0xe5 ? 0 : firstByte & 0x1f, text: extractLfnCharsCjs(entry) });
          continue;
        }
        if ((attr & 0x08) !== 0) {
          lfnParts = [];
          continue;
        }
        const isDeleted = firstByte === 0xe5 || parentDeleted;
        const nameOk = (firstByte === 0xe5 || (firstByte >= 0x20 && firstByte <= 0x7e)) && entry[8] >= 0x20 && entry[8] <= 0x7e;
        if (!nameOk) {
          lfnParts = [];
          continue;
        }

        const rawShort = Buffer.from(entry.subarray(0, 11));
        if (firstByte === 0xe5) rawShort[0] = 0x5f;
        const base = rawShort.toString('ascii', 0, 8).trimEnd();
        const ext83 = rawShort.toString('ascii', 8, 11).trimEnd();
        const shortName = ext83 ? `${base}.${ext83}` : base;
        if (shortName === '.' || shortName === '..') {
          lfnParts = [];
          continue;
        }

        let fullName = shortName;
        if (lfnParts.length > 0) {
          const ordered =
            firstByte === 0xe5
              ? [...lfnParts].reverse().map((p) => p.text).join('')
              : [...lfnParts].sort((a, b) => a.seq - b.seq).map((p) => p.text).join('');
          if (ordered.trim()) fullName = ordered.trim();
        }
        lfnParts = [];

        const firstCluster = (entry.readUInt16LE(20) << 16) | entry.readUInt16LE(26);
        const fileSize = entry.readUInt32LE(28);
        const modifiedAt = dosDateTimeToMs(entry.readUInt16LE(24), entry.readUInt16LE(22));
        const isDir = (attr & 0x10) !== 0;
        const fullPath = `${prefix}\\${fullName}`;

        if (isDir) {
          if (firstCluster >= 2 && depth < 12 && !visited.has(firstCluster)) {
            queue.push({ cluster: firstCluster, prefix: fullPath, depth: depth + 1, parentDeleted: isDeleted });
          }
          continue;
        }
        if ((!isDeleted && !includeExisting) || fileSize === 0 || firstCluster < 2) continue;

        const needed = Math.max(1, Math.ceil(fileSize / clusterBytes));
        const extents = [];
        let overwritten = false;
        const firstFat = readFat(firstCluster);
        if (firstFat !== 0) {
          let c = firstCluster;
          let rem = fileSize;
          const seen = new Set();
          while (c >= 2 && c < 0x0ffffff0 && rem > 0 && !seen.has(c) && extents.length < 4096) {
            seen.add(c);
            const bOff = dataStart + (c - 2) * clusterBytes;
            const take = Math.min(rem, clusterBytes);
            if (bOff + take <= limitBytes) extents.push({ offset: bOff, length: take });
            rem -= take;
            const next = readFat(c);
            if (next === 0 || next >= 0x0ffffff8) break;
            c = next;
          }
          if (extents.reduce((s, e) => s + e.length, 0) < fileSize) overwritten = true;
        } else {
          let rem = fileSize;
          for (let ci = 0; ci < needed && rem > 0 && extents.length < 4096; ci++) {
            const c = firstCluster + ci;
            if (ci > 0 && readFat(c) !== 0) overwritten = true;
            const bOff = dataStart + (c - 2) * clusterBytes;
            const take = Math.min(rem, clusterBytes);
            if (bOff + take <= limitBytes) extents.push({ offset: bOff, length: take });
            rem -= take;
          }
        }
        if (extents.length === 0) continue;

        const sLen = Math.min(65536, extents[0].length);
        const hBuf = Buffer.allocUnsafe(sLen);
        let hRead = 0;
        try {
          hRead = readAlignedSync(fd, hBuf, 0, sLen, extents[0].offset, sectorSize);
        } catch {
          hRead = 0;
        }

        out.push({
          id: `fat32-${vol.volStart}-${cur}-${off}`,
          filename: fullName,
          originalPath: `FAT32 ${fullPath}`,
          extensionHint: path.extname(fullName).replace(/^\./, '').toLowerCase(),
          size: fileSize,
          calculatedSize: fileSize,
          modifiedAt,
          sourceKind: 'ntfs-mft',
          isDeleted,
          scanPhase: 'quick',
          offset: extents[0].offset,
          sector: Math.floor(extents[0].offset / sectorSize),
          devicePath,
          runs: extents,
          mftResident: false,
          mftOverwritten: isDeleted ? overwritten : false,
          mftBitmapIntact: isDeleted ? !overwritten : true,
          discoveryCrc32: computeCrc32Cjs(hBuf, hRead),
          headerSample: new Uint8Array(hBuf.buffer, hBuf.byteOffset, hRead),
        });
      }

      if (eod) break;
      const nextDir = readFat(cur);
      if (nextDir < 2 || nextDir >= 0x0ffffff8) break;
      cur = nextDir;
      chain++;
    }
  }
  if (out.length >= maxEntries || visited.size >= maxClusters) {
    warnings.push(`FAT32 scan reached directory/entry limit (${out.length.toLocaleString()} items) on volume @ ${vol.volStart}.`);
  }
  if (badReads > 0) {
    warnings.push(`FAT32 scan skipped ${badReads} unreadable cluster read(s) on volume @ ${vol.volStart}.`);
  }
  return out;
}

// Stream exFAT directory clusters via sector-aligned reads to recover deleted 0x05 + existing 0x85 entries
function scanExfatVolumeFromFd(fd, devicePath, vol, limitBytes, includeExisting = false, maxEntries = 25000) {
  const out = [];
  const warnings = [];
  Object.defineProperties(out, {
    warnings: { value: warnings, enumerable: false },
  });
  const boot = vol.bootBuf;
  if (!boot) return out;

  const sectorSize = vol.sectorSize || 512;
  const bps = 1 << Math.min(12, Math.max(9, boot[108] || 9));
  const spc = 1 << Math.min(25, boot[109] || 3);
  const clusterBytes = bps * spc;
  const fatStart = vol.volStart + boot.readUInt32LE(80) * bps;
  const heapStart = vol.volStart + boot.readUInt32LE(88) * bps;
  const rootCluster = boot.readUInt32LE(96) || 4;

  let cachedFatSecOff = -1;
  const fatSecBuf = Buffer.allocUnsafe(sectorSize);
  const readFat = (cluster) => {
    const off = fatStart + cluster * 4;
    if (off + 4 > limitBytes) return 0;
    const secOff = Math.floor(off / sectorSize) * sectorSize;
    if (secOff !== cachedFatSecOff) {
      try {
        if (readAlignedSync(fd, fatSecBuf, 0, sectorSize, secOff, sectorSize) < sectorSize) {
          cachedFatSecOff = -1;
          return 0;
        }
        cachedFatSecOff = secOff;
      } catch {
        cachedFatSecOff = -1;
        return 0;
      }
    }
    return fatSecBuf.readUInt32LE(off - secOff);
  };

  let bitmap = null;
  const rootOff = heapStart + (rootCluster - 2) * clusterBytes;
  if (rootCluster >= 2 && rootOff + clusterBytes <= limitBytes) {
    try {
      const rBuf = Buffer.allocUnsafe(clusterBytes);
      readAlignedSync(fd, rBuf, 0, clusterBytes, rootOff, sectorSize);
      for (let off = 0; off + 32 <= clusterBytes; off += 32) {
        if (rBuf[off] === 0x81) {
          const bmCluster = rBuf.readUInt32LE(off + 20);
          const bmLen = Math.min(rBuf.readUInt32LE(off + 24), NTFS_BITMAP_MAX_BYTES);
          const bmOff = heapStart + (bmCluster - 2) * clusterBytes;
          if (bmCluster >= 2 && bmOff + bmLen <= limitBytes) {
            bitmap = Buffer.allocUnsafe(bmLen);
            readAlignedSync(fd, bitmap, 0, bmLen, bmOff, sectorSize);
          }
          break;
        }
      }
    } catch {
      warnings.push(`exFAT bitmap read error on volume @ ${vol.volStart}; allocation status may be incomplete.`);
    }
  }
  Object.defineProperty(out, 'bitmap', { value: bitmap, enumerable: false });
  Object.defineProperty(out, 'heapStart', { value: heapStart, enumerable: false });

  const isAllocated = (c) => {
    if (!bitmap || c < 2) return null;
    const idx = c - 2;
    const bIdx = idx >>> 3;
    if (bIdx >= bitmap.length) return null;
    return (bitmap[bIdx] & (1 << (idx & 7))) !== 0;
  };

  const cBuf = Buffer.allocUnsafe(clusterBytes);
  const visited = new Set();
  const queue = [{ cluster: rootCluster, prefix: '', depth: 0, parentDeleted: false }];
  const maxClusters = 16384;
  let badReads = 0;

  while (queue.length > 0 && visited.size < maxClusters && out.length < maxEntries) {
    const { cluster: startCluster, prefix, depth, parentDeleted } = queue.shift();
    let cur = startCluster;
    let chain = 0;

    while (cur >= 2 && cur < 0xfffffff0 && !visited.has(cur) && chain < 512) {
      visited.add(cur);
      const offByte = heapStart + (cur - 2) * clusterBytes;
      if (offByte < 0 || offByte + clusterBytes > limitBytes) break;
      let nRead = 0;
      try {
        nRead = readAlignedSync(fd, cBuf, 0, clusterBytes, offByte, sectorSize);
      } catch {
        badReads++;
        break;
      }

      for (let off = 0; off + 32 <= nRead && out.length < maxEntries; ) {
        const entryType = cBuf[off];
        if (entryType === 0x00) break;
        if (entryType !== 0x85 && entryType !== 0x05) {
          off += 32;
          continue;
        }
        const isDeleted = entryType === 0x05 || parentDeleted;
        const secCount = cBuf[off + 1];
        if (secCount < 2 || off + (1 + secCount) * 32 > nRead) {
          off += 32;
          continue;
        }

        const fileAttrs = cBuf.readUInt16LE(off + 4);
        const modifiedAt = dosDateTimeToMs(cBuf.readUInt16LE(off + 14), cBuf.readUInt16LE(off + 12));
        const isDir = (fileAttrs & 0x10) !== 0;

        const streamOff = off + 32;
        if (cBuf[streamOff] !== 0xc0 && cBuf[streamOff] !== 0x40) {
          off += 32;
          continue;
        }
        const noFatChain = (cBuf[streamOff + 1] & 0x02) !== 0;
        const nameLen = cBuf[streamOff + 3];
        const firstCluster = cBuf.readUInt32LE(streamOff + 20);
        const dataLength = cBuf.readUInt32LE(streamOff + 24) + cBuf.readUInt32LE(streamOff + 28) * 4294967296;

        let fullName = '';
        for (let s = 2; s <= secCount; s++) {
          const nOff = off + s * 32;
          if (cBuf[nOff] !== 0xc1 && cBuf[nOff] !== 0x41) break;
          for (let j = 2; j + 1 < 32 && fullName.length < nameLen; j += 2) {
            const code = cBuf[nOff + j] | (cBuf[nOff + j + 1] << 8);
            if (code === 0) break;
            fullName += String.fromCharCode(code);
          }
        }
        off += (1 + secCount) * 32;
        if (!fullName) continue;
        const fullPath = `${prefix}\\${fullName}`;

        if (isDir) {
          if (firstCluster >= 2 && depth < 12 && !visited.has(firstCluster)) {
            queue.push({ cluster: firstCluster, prefix: fullPath, depth: depth + 1, parentDeleted: isDeleted });
          }
          continue;
        }
        if ((!isDeleted && !includeExisting) || dataLength === 0 || firstCluster < 2) continue;

        const needed = Math.max(1, Math.ceil(dataLength / clusterBytes));
        const extents = [];
        let overwritten = false;
        let allChecked = bitmap !== null;
        let rem = dataLength;

        if (noFatChain || readFat(firstCluster) === 0) {
          for (let ci = 0; ci < needed && rem > 0 && extents.length < 4096; ci++) {
            const c = firstCluster + ci;
            const alloc = isAllocated(c);
            if (alloc === true) overwritten = true;
            else if (alloc === null) allChecked = false;
            const bOff = heapStart + (c - 2) * clusterBytes;
            const take = Math.min(rem, clusterBytes);
            if (bOff + take <= limitBytes) extents.push({ offset: bOff, length: take });
            rem -= take;
          }
        } else {
          let c = firstCluster;
          const seen = new Set();
          while (c >= 2 && c < 0xfffffff0 && rem > 0 && !seen.has(c) && extents.length < 4096) {
            seen.add(c);
            const alloc = isAllocated(c);
            if (alloc === true) overwritten = true;
            else if (alloc === null) allChecked = false;
            const bOff = heapStart + (c - 2) * clusterBytes;
            const take = Math.min(rem, clusterBytes);
            if (bOff + take <= limitBytes) extents.push({ offset: bOff, length: take });
            rem -= take;
            const next = readFat(c);
            if (next === 0 || next >= 0xfffffff8) break;
            c = next;
          }
        }
        if (extents.length === 0) continue;

        const sLen = Math.min(65536, extents[0].length);
        const hBuf = Buffer.allocUnsafe(sLen);
        let hRead = 0;
        try {
          hRead = readAlignedSync(fd, hBuf, 0, sLen, extents[0].offset, sectorSize);
        } catch {
          hRead = 0;
        }

        out.push({
          id: `exfat-${vol.volStart}-${cur}-${off}`,
          filename: fullName,
          originalPath: `exFAT ${fullPath}`,
          extensionHint: path.extname(fullName).replace(/^\./, '').toLowerCase(),
          size: dataLength,
          calculatedSize: dataLength,
          modifiedAt,
          sourceKind: 'ntfs-mft',
          isDeleted,
          scanPhase: 'quick',
          offset: extents[0].offset,
          sector: Math.floor(extents[0].offset / sectorSize),
          devicePath,
          runs: extents,
          mftResident: false,
          mftOverwritten: isDeleted ? overwritten : false,
          mftBitmapIntact: isDeleted ? (overwritten ? false : allChecked ? true : undefined) : true,
          discoveryCrc32: computeCrc32Cjs(hBuf, hRead),
          headerSample: new Uint8Array(hBuf.buffer, hBuf.byteOffset, hRead),
        });
      }

      const nextC = readFat(cur);
      if (nextC < 2 || nextC >= 0xfffffff8) break;
      cur = nextC;
      chain++;
    }
  }
  if (out.length >= maxEntries || visited.size >= maxClusters) {
    warnings.push(`exFAT scan reached directory/entry limit (${out.length.toLocaleString()} items) on volume @ ${vol.volStart}.`);
  }
  if (badReads > 0) {
    warnings.push(`exFAT scan skipped ${badReads} unreadable cluster read(s) on volume @ ${vol.volStart}.`);
  }
  return out;
}

function decodeNtfsRunlistCjs(buf, start, maxEnd, lowestVcn, highestVcn) {
  const runs = [];
  let pos = start;
  let vcn = lowestVcn;
  let lcn = 0;

  while (pos < maxEnd) {
    const header = buf[pos++];
    if (header === 0) break;
    const lenBytes = header & 0x0f;
    const offBytes = (header >> 4) & 0x0f;
    if (lenBytes === 0 || lenBytes > 8 || offBytes > 8 || pos + lenBytes + offBytes > maxEnd) {
      return [];
    }
    let count = 0;
    for (let i = 0; i < lenBytes; i++) count += buf[pos + i] * Math.pow(256, i);
    pos += lenBytes;

    if (offBytes === 0) {
      runs.push({ lcn: -1, clusterCount: count });
    } else {
      let delta = 0;
      for (let i = 0; i < offBytes; i++) delta += buf[pos + i] * Math.pow(256, i);
      if ((buf[pos + offBytes - 1] & 0x80) !== 0) delta -= Math.pow(256, offBytes);
      pos += offBytes;
      lcn += delta;
      if (lcn < 0) return [];
      runs.push({ lcn, clusterCount: count });
    }
    vcn += count;
    if (runs.length > 4096 || vcn - 1 > highestVcn + count) break;
  }
  return runs;
}

function parseUsnJournalBufferCjs(buf, dirMap, volKey, maxEntries = 1000) {
  const out = [];
  const seen = new Set();
  let pos = 0;

  while (pos + 64 <= buf.length && out.length < maxEntries) {
    const recLen = buf.readUInt32LE(pos);
    if (recLen === 0) {
      const nextPage = Math.floor(pos / 4096) * 4096 + 4096;
      if (nextPage <= pos) break;
      pos = nextPage;
      continue;
    }
    if (recLen < 60 || pos + recLen > buf.length) break;

    const majorVer = buf.readUInt16LE(pos + 4);
    if (majorVer !== 2 && majorVer !== 3) {
      pos += recLen;
      continue;
    }

    const fileRefLow = buf.readUInt32LE(pos + 8);
    const parentRefLow = buf.readUInt32LE(pos + 16);
    const tsLo = buf.readUInt32LE(pos + 32);
    const tsHi = buf.readUInt32LE(pos + 36);
    const reason = buf.readUInt32LE(pos + 40);
    const fileAttrs = buf.readUInt32LE(pos + 52);

    let nameLenOff = 56;
    let nameOffOff = 58;
    if (majorVer === 3) {
      nameLenOff = 72;
      nameOffOff = 74;
    }
    const nameLen = buf.readUInt16LE(pos + nameLenOff);
    const nameOffset = buf.readUInt16LE(pos + nameOffOff);

    const isDelete = (reason & (0x00000200 | 0x00001000)) !== 0;
    const isDir = (fileAttrs & 0x10) !== 0;

    if (isDelete && !isDir && nameLen >= 2 && pos + nameOffset + nameLen <= pos + recLen) {
      const filename = buf.toString('utf16le', pos + nameOffset, pos + nameOffset + nameLen).split('\0')[0];
      if (filename && (!filename.startsWith('$') || isRecycleBinEntryName(filename))) {
        const parts = [filename];
        let cur = parentRefLow;
        const visited = new Set();
        let guard = 0;
        while (cur > 5 && !visited.has(cur) && guard < 24) {
          visited.add(cur);
          const node = dirMap.get(`${volKey}:${cur}`);
          if (!node || !node.name || node.name === '.') break;
          parts.unshift(node.name);
          if (node.parentRecord === cur) break;
          cur = node.parentRecord;
          guard++;
        }
        const reconstructedPath = `\\${parts.join('\\')}`;
        const key = `${fileRefLow}:${reconstructedPath}`;
        if (!seen.has(key)) {
          seen.add(key);
          const ticks = tsHi * 4294967296 + tsLo;
          const modifiedAt = ticks > 0 ? Math.floor(ticks / 10000 - WINDOWS_EPOCH_DIFF_MS) : undefined;
          out.push({
            id: `usn-${volKey}-${fileRefLow}-${pos}`,
            filename,
            originalPath: reconstructedPath,
            extensionHint: path.extname(filename).replace(/^\./, '').toLowerCase(),
            size: 0,
            calculatedSize: 0,
            modifiedAt,
            sourceKind: 'ntfs-mft',
            isDeleted: true,
            scanPhase: 'usn',
            offset: 0,
            sector: 0,
            devicePath: '',
            mftOverwritten: true,
            headerSample: new Uint8Array(0),
          });
        }
      }
    }

    pos += recLen;
  }

  return out;
}

function applyMftUsaFixup(rec, recSize) {
  if (!rec || rec.length < 48 || rec.length < recSize) return false;
  if (rec[0] !== 0x46 || rec[1] !== 0x49 || rec[2] !== 0x4c || rec[3] !== 0x45) return false;
  const usaOffset = rec.readUInt16LE(4);
  const usaCount = rec.readUInt16LE(6);
  const firstAttrOffset = rec.readUInt16LE(20);
  const usedBytes = rec.readUInt32LE(24);
  if (
    usaOffset < 42 ||
    usaCount < 2 ||
    usaOffset + usaCount * 2 > recSize ||
    firstAttrOffset < 42 ||
    usedBytes < firstAttrOffset ||
    usedBytes > recSize
  ) {
    return false;
  }
  const usn = rec.readUInt16LE(usaOffset);
  for (let s = 1; s < usaCount && s * 512 <= recSize; s++) {
    const sectorEnd = s * 512 - 2;
    if (rec.readUInt16LE(sectorEnd) !== usn) return false;
    rec[sectorEnd] = rec[usaOffset + s * 2];
    rec[sectorEnd + 1] = rec[usaOffset + s * 2 + 1];
  }
  return true;
}

function resolveMftRecordByteOffset(part, mftRuns, recNum, mftRecSize) {
  if (!part || !Array.isArray(mftRuns) || recNum < 0) return -1;
  let logicalOffset = recNum * mftRecSize;
  for (const r of mftRuns) {
    const runBytes = r.clusterCount * part.clusterBytes;
    if (logicalOffset < runBytes) {
      if (r.lcn < 0) return -1;
      return part.volStart + r.lcn * part.clusterBytes + logicalOffset;
    }
    logicalOffset -= runBytes;
  }
  return -1;
}

function parseAttrListBytes(buf, start, end) {
  const entries = [];
  let p = start;
  while (p + 26 <= end) {
    const type = buf.readUInt32LE(p);
    const recLen = buf.readUInt16LE(p + 4);
    if (recLen < 26 || p + recLen > end) break;
    const nameLen = buf[p + 6];
    const startVcn = buf.readUInt32LE(p + 8) + buf.readUInt32LE(p + 12) * 4294967296;
    const baseRefLow = buf.readUInt32LE(p + 16);
    const baseRefMid = buf.readUInt16LE(p + 20);
    const extRecNum = baseRefLow + baseRefMid * 4294967296;
    entries.push({ type, nameLen, startVcn, extRecNum });
    p += recLen;
  }
  return entries;
}

function parseMftRecordBuffer(
  work,
  absOffset,
  ntfsParts,
  fd,
  limitBytes,
  dirMap,
  bitmapByVol,
  includeExisting = false,
  mftContext = null,
) {
  const part = ntfsParts.find((p) => absOffset >= p.volStart && absOffset < p.volEnd) || ntfsParts[0] || { volStart: 0, clusterBytes: 4096, sectorSize: 512, mftRecSize: 1024 };
  const recSize = (mftContext && mftContext.mftRecSize) || part.mftRecSize || 1024;
  const sectorSize = (mftContext && mftContext.sectorSize) || part.sectorSize || 512;
  if (!work || work.length < recSize) return null;
  if (work[0] !== 0x46 || work[1] !== 0x49 || work[2] !== 0x4c || work[3] !== 0x45) return null;

  const rec = Buffer.from(work.subarray(0, recSize));
  if (!applyMftUsaFixup(rec, recSize)) return null;

  const firstAttrOffset = rec.readUInt16LE(20);
  const flags = rec.readUInt16LE(22);
  const usedBytes = rec.readUInt32LE(24);
  const recordNumber = rec.readUInt32LE(44);
  const baseFileRefLow = rec.readUInt32LE(32);
  const baseFileRefMid = rec.readUInt16LE(36);
  // Extension MFT records point back to a base record (non-zero baseFileRef) — skip in primary scan unless fetched via $ATTRIBUTE_LIST
  if (baseFileRefLow !== 0 || baseFileRefMid !== 0) {
    return null;
  }

  const inUse = (flags & 0x0001) !== 0;
  const isDirectory = (flags & 0x0002) !== 0;

  let pos = firstAttrOffset;
  let filename = '';
  let nameScore = -1;
  let parentRecord = 5;
  let modifiedAt;
  let fileSize = 0;
  let residentPayload = null;
  let rawRunSegments = [];
  let usnRuns = [];
  let usnSize = 0;
  let ntfsCompressed = false;
  let ntfsEncrypted = false;
  const extRecordsToInspect = new Set();

  const inspectRecordAttrs = (attrBuf, attrUsedBytes, isExtension) => {
    let ap = attrBuf.readUInt16LE(20);
    while (ap + 16 <= attrUsedBytes) {
      const attrType = attrBuf.readUInt32LE(ap);
      if (attrType === 0xffffffff) break;
      const attrLen = attrBuf.readUInt32LE(ap + 4);
      if (attrLen < 16 || ap + attrLen > attrUsedBytes) break;
      const form = attrBuf[ap + 8];
      const nameLen = attrBuf[ap + 9];
      const nameOff = attrBuf.readUInt16LE(ap + 10);
      const attrFlags = attrBuf.readUInt16LE(ap + 12);
      const attrName =
        nameLen > 0 && ap + nameOff + nameLen * 2 <= ap + attrLen
          ? attrBuf.toString('utf16le', ap + nameOff, ap + nameOff + nameLen * 2)
          : '';

      if (attrType === 0x10 && form === 0 && ap + 24 <= attrUsedBytes) {
        const vo = attrBuf.readUInt16LE(ap + 20);
        const vl = attrBuf.readUInt32LE(ap + 16);
        if (vl >= 32 && ap + vo + 32 <= ap + attrLen) {
          const lo = attrBuf.readUInt32LE(ap + vo + 8);
          const hi = attrBuf.readUInt32LE(ap + vo + 12);
          const ticks = hi * 4294967296 + lo;
          if (ticks > 0) modifiedAt = Math.floor(ticks / 10000 - WINDOWS_EPOCH_DIFF_MS);
          if (vl >= 36 && ap + vo + 36 <= ap + attrLen) {
            const filePerm = attrBuf.readUInt32LE(ap + vo + 32);
            if ((filePerm & 0x0800) !== 0) ntfsCompressed = true;
            if ((filePerm & 0x4000) !== 0) ntfsEncrypted = true;
          }
        }
      } else if (attrType === 0x20 && !isExtension) {
        let listBuf = null;
        if (form === 0 && ap + 24 <= attrUsedBytes) {
          const vl = attrBuf.readUInt32LE(ap + 16);
          const vo = attrBuf.readUInt16LE(ap + 20);
          if (ap + vo + vl <= ap + attrLen) {
            listBuf = attrBuf.subarray(ap + vo, ap + vo + vl);
          }
        } else if (form === 1 && ap + 64 <= ap + attrLen) {
          const loVcn = attrBuf.readUInt32LE(ap + 16) + attrBuf.readUInt32LE(ap + 20) * 4294967296;
          const hiVcn = attrBuf.readUInt32LE(ap + 24) + attrBuf.readUInt32LE(ap + 28) * 4294967296;
          const mpOff = attrBuf.readUInt16LE(ap + 32);
          const listSz = Math.min(256 * 1024, attrBuf.readUInt32LE(ap + 48));
          const listRuns = decodeNtfsRunlistCjs(attrBuf, ap + mpOff, ap + attrLen, loVcn, hiVcn);
          if (listRuns.length > 0 && listSz > 0) {
            listBuf = Buffer.alloc(listSz);
            let lc = 0;
            for (const lr of listRuns) {
              if (lc >= listSz) break;
              const take = Math.min(lr.clusterCount * part.clusterBytes, listSz - lc);
              if (lr.lcn >= 0) {
                const lOff = part.volStart + lr.lcn * part.clusterBytes;
                if (lOff + take <= limitBytes) {
                  try {
                    readAlignedSync(fd, listBuf, lc, take, lOff, sectorSize);
                  } catch {
                    // ignore partial attr list read
                  }
                }
              }
              lc += take;
            }
          }
        }
        if (listBuf && listBuf.length >= 26) {
          for (const alEntry of parseAttrListBytes(listBuf, 0, listBuf.length)) {
            if (
              alEntry.extRecNum !== recordNumber &&
              alEntry.nameLen === 0 &&
              (alEntry.type === 0x30 || alEntry.type === 0x80 || alEntry.type === 0x10)
            ) {
              extRecordsToInspect.add(alEntry.extRecNum);
            }
          }
        }
      } else if (attrType === 0x30 && form === 0 && ap + 24 <= attrUsedBytes) {
        const vo = attrBuf.readUInt16LE(ap + 20);
        const vl = attrBuf.readUInt32LE(ap + 16);
        const fb = ap + vo;
        if (vl >= 66 && fb + 66 <= ap + attrLen) {
          const fnLen = attrBuf[fb + 64];
          const fnSpace = attrBuf[fb + 65];
          const cand = attrBuf.toString('utf16le', fb + 66, Math.min(ap + attrLen, fb + 66 + fnLen * 2)).split('\0')[0];
          const rank = fnSpace === 1 || fnSpace === 3 ? 2 : fnSpace === 0 ? 1 : 0;
          if (cand && rank >= nameScore) {
            nameScore = rank;
            filename = cand;
            parentRecord = attrBuf.readUInt32LE(fb);
            const fnSize = attrBuf.readUInt32LE(fb + 48) + attrBuf.readUInt32LE(fb + 52) * 4294967296;
            if (fileSize === 0 && fnSize > 0) fileSize = fnSize;
          }
        }
      } else if (attrType === 0x80 && attrName === '$J' && form === 1 && ap + 64 <= ap + attrLen) {
        const loVcn = attrBuf.readUInt32LE(ap + 16) + attrBuf.readUInt32LE(ap + 20) * 4294967296;
        const hiVcn = attrBuf.readUInt32LE(ap + 24) + attrBuf.readUInt32LE(ap + 28) * 4294967296;
        const mpOff = attrBuf.readUInt16LE(ap + 32);
        usnSize = attrBuf.readUInt32LE(ap + 48) + attrBuf.readUInt32LE(ap + 52) * 4294967296;
        if (ap + mpOff < ap + attrLen) {
          usnRuns = decodeNtfsRunlistCjs(attrBuf, ap + mpOff, ap + attrLen, loVcn, hiVcn);
        }
      } else if (attrType === 0x80 && nameLen === 0) {
        if ((attrFlags & 0x0001) !== 0) ntfsCompressed = true;
        if ((attrFlags & 0x4000) !== 0) ntfsEncrypted = true;
        if (form === 0 && ap + 24 <= attrUsedBytes) {
          const vl = attrBuf.readUInt32LE(ap + 16);
          const vo = attrBuf.readUInt16LE(ap + 20);
          if (ap + vo + vl <= ap + attrLen) {
            fileSize = vl;
            residentPayload = Buffer.from(attrBuf.subarray(ap + vo, ap + vo + vl));
          }
        } else if (form === 1 && ap + 64 <= ap + attrLen) {
          const loVcn = attrBuf.readUInt32LE(ap + 16) + attrBuf.readUInt32LE(ap + 20) * 4294967296;
          const hiVcn = attrBuf.readUInt32LE(ap + 24) + attrBuf.readUInt32LE(ap + 28) * 4294967296;
          const mpOff = attrBuf.readUInt16LE(ap + 32);
          if (loVcn === 0) {
            fileSize = attrBuf.readUInt32LE(ap + 48) + attrBuf.readUInt32LE(ap + 52) * 4294967296;
          }
          if (ap + mpOff < ap + attrLen) {
            const decoded = decodeNtfsRunlistCjs(attrBuf, ap + mpOff, ap + attrLen, loVcn, hiVcn);
            if (decoded.length > 0) {
              rawRunSegments.push({ loVcn, runs: decoded });
            }
          }
        }
      }
      ap += attrLen;
    }
  };

  inspectRecordAttrs(rec, usedBytes, false);

  // Follow NTFS $ATTRIBUTE_LIST (0x20) extension MFT records if present
  if (extRecordsToInspect.size > 0 && mftContext && Array.isArray(mftContext.mftRuns)) {
    const extBuf = Buffer.allocUnsafe(recSize);
    for (const extRecNum of extRecordsToInspect) {
      const extOff = resolveMftRecordByteOffset(part, mftContext.mftRuns, extRecNum, recSize);
      if (extOff < 0 || extOff + recSize > limitBytes) continue;
      try {
        if (readAlignedSync(fd, extBuf, 0, recSize, extOff, sectorSize) < recSize) continue;
      } catch {
        continue;
      }
      const extCopy = Buffer.from(extBuf);
      if (!applyMftUsaFixup(extCopy, recSize)) continue;
      const extUsed = extCopy.readUInt32LE(24);
      inspectRecordAttrs(extCopy, extUsed, true);
    }
  }

  rawRunSegments.sort((a, b) => a.loVcn - b.loVcn);
  const rawRuns = [];
  for (const seg of rawRunSegments) {
    rawRuns.push(...seg.runs);
  }

  if (!filename) return null;
  const volKey = part.volStart;

  if (isDirectory && recordNumber >= 5) {
    dirMap.set(`${volKey}:${recordNumber}`, { parentRecord, name: filename });
    return { consumed: true };
  }

  if (recordNumber === 6 && filename === '$Bitmap') {
    if (residentPayload && residentPayload.length > 0) {
      bitmapByVol.set(volKey, residentPayload);
    } else if (rawRuns.length > 0 && fileSize > 0) {
      const bmSize = Math.min(fileSize, NTFS_BITMAP_MAX_BYTES);
      const bm = Buffer.alloc(bmSize);
      let bmCursor = 0;
      for (const r of rawRuns) {
        if (bmCursor >= bmSize) break;
        const take = Math.min(r.clusterCount * part.clusterBytes, bmSize - bmCursor);
        if (r.lcn >= 0) {
          const bOff = part.volStart + r.lcn * part.clusterBytes;
          if (bOff + take <= limitBytes) {
            try {
              readAlignedSync(fd, bm, bmCursor, take, bOff, sectorSize);
            } catch {
              // keep partial bitmap coverage on unreadable sectors
            }
          }
        }
        bmCursor += take;
      }
      bitmapByVol.set(volKey, bm);
    }
    return { consumed: true };
  }

  if (filename === '$UsnJrnl' && usnRuns.length > 0) {
    return { consumed: true, usnVol: part, usnRuns, usnSize };
  }

  const isDeleted = !inUse;
  if (
    (!isDeleted && !includeExisting) ||
    (filename.startsWith('$') && !isRecycleBinEntryName(filename)) ||
    fileSize === 0
  ) {
    return null;
  }
  const ext = path.extname(filename).replace(/^\./, '').toLowerCase();

  const detailTags = [];
  if (ntfsEncrypted) detailTags.push('EFS-encrypted (requires Windows EFS certificate/key)');
  if (ntfsCompressed) detailTags.push('NTFS compressed stream');

  if (residentPayload) {
    return {
      consumed: true,
      volKey,
      parentRecord,
      isDeleted,
      rawRuns: [],
      entry: {
        id: `mft-${absOffset}-${recordNumber}`,
        filename,
        originalPath: filename,
        extensionHint: ext,
        size: residentPayload.length,
        calculatedSize: residentPayload.length,
        modifiedAt,
        sourceKind: 'ntfs-mft',
        isDeleted,
        scanPhase: 'quick',
        offset: absOffset,
        sector: Math.floor(absOffset / sectorSize),
        devicePath: '',
        mftResident: true,
        ntfsCompressed,
        ntfsEncrypted,
        details: detailTags.length > 0 ? detailTags.join(' · ') : undefined,
        discoveryCrc32: computeCrc32Cjs(residentPayload, residentPayload.length),
        headerSample: new Uint8Array(residentPayload),
      },
    };
  }

  if (rawRuns.length === 0) return null;
  const extents = [];
  let rem = fileSize;
  for (const r of rawRuns) {
    if (rem <= 0) break;
    const runBytes = Math.min(rem, r.clusterCount * part.clusterBytes);
    if (r.lcn >= 0) {
      const byteOff = part.volStart + r.lcn * part.clusterBytes;
      if (byteOff + runBytes <= limitBytes) {
        extents.push({ offset: byteOff, length: runBytes });
      }
    } else {
      extents.push({ offset: -1, length: runBytes });
    }
    rem -= runBytes;
  }
  const firstRealExtent = extents.find((e) => e.offset >= 0);
  if (!firstRealExtent) return null;

  const sampleTargetLen = Math.min(65536, fileSize || firstRealExtent.length);
  const hdrBuf = Buffer.alloc(sampleTargetLen);
  let hdrCursor = 0;
  for (const extRun of extents) {
    if (hdrCursor >= sampleTargetLen) break;
    const take = Math.min(extRun.length, sampleTargetLen - hdrCursor);
    if (extRun.offset >= 0) {
      try {
        readAlignedSync(fd, hdrBuf, hdrCursor, take, extRun.offset, sectorSize);
      } catch {
        // leave zero-filled tail in sample on unreadable sector
      }
    }
    hdrCursor += take;
  }

  return {
    consumed: true,
    volKey,
    parentRecord,
    isDeleted,
    rawRuns,
    entry: {
      id: `mft-${absOffset}-${recordNumber}`,
      filename,
      originalPath: filename,
      extensionHint: ext,
      size: fileSize,
      calculatedSize: fileSize,
      modifiedAt,
      sourceKind: 'ntfs-mft',
      isDeleted,
      scanPhase: 'quick',
      offset: firstRealExtent.offset,
      sector: Math.floor(absOffset / sectorSize),
      devicePath: '',
      runs: extents,
      mftResident: false,
      ntfsCompressed,
      ntfsEncrypted,
      details: detailTags.length > 0 ? detailTags.join(' · ') : undefined,
      discoveryCrc32: computeCrc32Cjs(hdrBuf, hdrCursor),
      headerSample: new Uint8Array(hdrBuf.buffer, hdrBuf.byteOffset, hdrCursor),
    },
  };
}

function readNtfsBootAndMftLayout(fd, part, limitBytes) {
  const sectorSize = part.sectorSize || 512;
  const boot = Buffer.allocUnsafe(512);
  try {
    if (readAlignedSync(fd, boot, 0, 512, part.volStart, sectorSize) < 512) return null;
  } catch {
    return null;
  }
  const mftStartLcn = Number(boot.readBigUInt64LE(48));
  if (!Number.isFinite(mftStartLcn) || mftStartLcn <= 0) return null;

  const bps = [512, 1024, 2048, 4096].includes(boot.readUInt16LE(11)) ? boot.readUInt16LE(11) : sectorSize;
  const spc = boot[13] || 8;
  const clusterBytes = Math.max(512, bps * spc);
  const rawMft = boot.readInt8(64);
  const mftRecSize =
    part.mftRecSize ||
    (rawMft < 0
      ? 1 << Math.min(12, Math.max(9, -rawMft))
      : Math.max(512, Math.min(4096, (rawMft || 1) * clusterBytes)));

  part.clusterBytes = clusterBytes;
  part.mftRecSize = mftRecSize;
  part.sectorSize = Math.max(sectorSize, bps);

  const mftOffset0 = part.volStart + mftStartLcn * clusterBytes;
  if (mftOffset0 + mftRecSize > limitBytes) return null;

  const rec0 = Buffer.allocUnsafe(mftRecSize);
  try {
    if (readAlignedSync(fd, rec0, 0, mftRecSize, mftOffset0, part.sectorSize) < mftRecSize) return null;
  } catch {
    return null;
  }
  if (!applyMftUsaFixup(rec0, mftRecSize)) return null;

  const firstAttr = rec0.readUInt16LE(20);
  const usedBytes = rec0.readUInt32LE(24);
  let mftRuns = [{ lcn: mftStartLcn, clusterCount: 64 }];
  let pos = firstAttr;
  while (pos + 16 <= usedBytes && pos + 16 <= mftRecSize) {
    const at = rec0.readUInt32LE(pos);
    if (at === 0xffffffff) break;
    const al = rec0.readUInt32LE(pos + 4);
    if (al < 16 || pos + al > usedBytes) break;
    if (at === 0x80 && rec0[pos + 8] === 1 && rec0[pos + 9] === 0 && pos + 64 <= pos + al) {
      const loVcn = rec0.readUInt32LE(pos + 16) + rec0.readUInt32LE(pos + 20) * 4294967296;
      const hiVcn = rec0.readUInt32LE(pos + 24) + rec0.readUInt32LE(pos + 28) * 4294967296;
      const mpOff = rec0.readUInt16LE(pos + 32);
      const decoded = decodeNtfsRunlistCjs(rec0, pos + mpOff, pos + al, loVcn, hiVcn);
      if (decoded.length > 0) mftRuns = decoded;
      break;
    }
    pos += al;
  }

  return { mftRuns, mftRecSize, sectorSize: part.sectorSize, mftStartLcn };
}

/**
 * Extracts only NTFS $Bitmap (Record #6) so unallocated-only Deep Scan mode always has
 * genuine allocation bitmaps even when starting directly at Phase 2.
 */
function loadNtfsBitmapsOnly(fd, ntfsParts, limitBytes) {
  const bitmapByVol = new Map();
  const warnings = [];
  for (const part of ntfsParts) {
    const layout = readNtfsBootAndMftLayout(fd, part, limitBytes);
    if (!layout) continue;
    const off6 = resolveMftRecordByteOffset(part, layout.mftRuns, 6, layout.mftRecSize);
    if (off6 < 0 || off6 + layout.mftRecSize > limitBytes) continue;
    const buf = Buffer.allocUnsafe(layout.mftRecSize);
    try {
      if (readAlignedSync(fd, buf, 0, layout.mftRecSize, off6, layout.sectorSize) < layout.mftRecSize) continue;
      parseMftRecordBuffer(buf, off6, [part], fd, limitBytes, new Map(), bitmapByVol, true, layout);
    } catch {
      warnings.push(`Could not read NTFS $Bitmap on volume @ ${part.volStart}; unallocated filter cannot verify this volume.`);
    }
  }
  return { bitmapByVol, warnings };
}

// Fast Contiguous NTFS $MFT + $UsnJrnl:$J Streamer (resilient to bad sectors, supports dynamic geometry & extension records)
function scanNtfsMftContiguous(fd, devicePath, ntfsParts, limitBytes, includeExisting = false, maxRecords = DEFAULT_MAX_MFT_RECORDS) {
  const candidates = [];
  const dirMap = new Map();
  const bitmapByVol = new Map();
  const usnSources = [];
  const entries = [];
  const warnings = [];
  let recordCount = 0;
  let skippedBadReads = 0;

  for (const part of ntfsParts) {
    const layout = readNtfsBootAndMftLayout(fd, part, limitBytes);
    if (!layout) {
      warnings.push(`Skipped NTFS volume @ ${part.volStart} (unreadable boot sector or $MFT record #0).`);
      continue;
    }
    const { mftRuns, mftRecSize, sectorSize } = layout;
    const chunkSize = 4 * 1024 * 1024;
    const chunkBuf = Buffer.allocUnsafe(chunkSize);

    for (const run of mftRuns) {
      if (run.lcn < 0 || recordCount >= maxRecords) continue;
      let runByteStart = part.volStart + run.lcn * part.clusterBytes;
      let remBytes = run.clusterCount * part.clusterBytes;
      while (remBytes >= mftRecSize && runByteStart + mftRecSize <= limitBytes && recordCount < maxRecords) {
        const toRead = Math.min(chunkSize, remBytes, limitBytes - runByteStart);
        const alignedRead = Math.floor(toRead / mftRecSize) * mftRecSize;
        if (alignedRead < mftRecSize) break;
        let readRes;
        try {
          readRes = readAlignedResilientSync(fd, chunkBuf, 0, alignedRead, runByteStart, sectorSize);
        } catch (err) {
          skippedBadReads++;
          warnings.push(`Aborted unreadable $MFT extent @ ${runByteStart}: ${err?.message || 'I/O error'}`);
          break;
        }
        if (readRes.skippedSectors > 0) skippedBadReads += readRes.skippedSectors;
        const n = readRes.bytesRead;
        if (n < mftRecSize) break;

        for (let off = 0; off + mftRecSize <= n && recordCount < maxRecords; off += mftRecSize) {
          recordCount++;
          const mftRes = parseMftRecordBuffer(
            chunkBuf.subarray(off, off + mftRecSize),
            runByteStart + off,
            ntfsParts,
            fd,
            limitBytes,
            dirMap,
            bitmapByVol,
            includeExisting,
            layout,
          );
          if (mftRes?.usnRuns) {
            usnSources.push(mftRes);
          } else if (mftRes?.entry) {
            mftRes.entry.devicePath = devicePath;
            candidates.push(mftRes);
            entries.push(mftRes.entry);
          }
        }
        runByteStart += n;
        remBytes -= n;
      }
    }
  }

  const truncatedByLimit = recordCount >= maxRecords;
  if (truncatedByLimit) {
    warnings.push(`NTFS Quick Scan reached the ${maxRecords.toLocaleString()} MFT record cap.`);
  }
  if (skippedBadReads > 0) {
    warnings.push(`NTFS Quick Scan skipped ${skippedBadReads} unreadable $MFT sector(s).`);
  }

  finalizeNtfsMftMetadata(candidates, dirMap, bitmapByVol);
  const pairedCandidates = rePairDeletedRecycleRecordsCjs(candidates);
  entries.length = 0;
  for (const c of pairedCandidates) {
    if (c?.entry) entries.push(c.entry);
  }

  // Parse recent $UsnJrnl:$J deleted entries
  for (const src of usnSources) {
    const part = src.usnVol;
    const secSize = part.sectorSize || 512;
    const tailRuns = src.usnRuns.slice(-4);
    for (const r of tailRuns) {
      if (r.lcn < 0) continue;
      const off = part.volStart + r.lcn * part.clusterBytes;
      const len = Math.min(4 * 1024 * 1024, r.clusterCount * part.clusterBytes, limitBytes - off);
      if (len < 128) continue;
      const uBuf = Buffer.allocUnsafe(len);
      try {
        const n = readAlignedSync(fd, uBuf, 0, len, off, secSize);
        const usnEntries = parseUsnJournalBufferCjs(uBuf.subarray(0, n), dirMap, part.volStart, 400);
        for (const u of usnEntries) {
          u.devicePath = devicePath;
          entries.push(u);
        }
      } catch {
        // skip unreadable USN slice
      }
    }
  }

  return { entries, dirMap, bitmapByVol, warnings, truncatedByLimit, skippedBadReads };
}

/**
 * Async yielding variant of `scanNtfsMftContiguous` used by IPC Quick Scan so pause & cancel
 * respond cleanly between MFT chunks without freezing Electron's main thread.
 */
async function scanNtfsMftContiguousAsync(
  fd,
  devicePath,
  ntfsParts,
  limitBytes,
  includeExisting = false,
  maxRecords = DEFAULT_MAX_MFT_RECORDS,
  scanState = null,
) {
  const candidates = [];
  const dirMap = new Map();
  const bitmapByVol = new Map();
  const usnSources = [];
  const entries = [];
  const warnings = [];
  let recordCount = 0;
  let skippedBadReads = 0;

  const waitIfPausedOrCancelled = async () => {
    if (!scanState) return false;
    while (scanState.paused && !scanState.cancelled) {
      await new Promise((r) => setTimeout(r, 80));
    }
    return Boolean(scanState.cancelled);
  };

  for (const part of ntfsParts) {
    if (await waitIfPausedOrCancelled()) break;
    const layout = readNtfsBootAndMftLayout(fd, part, limitBytes);
    if (!layout) {
      warnings.push(`Skipped NTFS volume @ ${part.volStart} (unreadable boot sector or $MFT record #0).`);
      continue;
    }
    const { mftRuns, mftRecSize, sectorSize } = layout;
    const chunkSize = 4 * 1024 * 1024;
    const chunkBuf = Buffer.allocUnsafe(chunkSize);

    for (const run of mftRuns) {
      if (run.lcn < 0 || recordCount >= maxRecords) continue;
      if (await waitIfPausedOrCancelled()) break;
      let runByteStart = part.volStart + run.lcn * part.clusterBytes;
      let remBytes = run.clusterCount * part.clusterBytes;
      while (remBytes >= mftRecSize && runByteStart + mftRecSize <= limitBytes && recordCount < maxRecords) {
        if (await waitIfPausedOrCancelled()) break;
        const toRead = Math.min(chunkSize, remBytes, limitBytes - runByteStart);
        const alignedRead = Math.floor(toRead / mftRecSize) * mftRecSize;
        if (alignedRead < mftRecSize) break;
        let readRes;
        try {
          readRes = readAlignedResilientSync(fd, chunkBuf, 0, alignedRead, runByteStart, sectorSize);
        } catch (err) {
          skippedBadReads++;
          warnings.push(`Aborted unreadable $MFT extent @ ${runByteStart}: ${err?.message || 'I/O error'}`);
          break;
        }
        if (readRes.skippedSectors > 0) skippedBadReads += readRes.skippedSectors;
        const n = readRes.bytesRead;
        if (n < mftRecSize) break;

        for (let off = 0; off + mftRecSize <= n && recordCount < maxRecords; off += mftRecSize) {
          recordCount++;
          const mftRes = parseMftRecordBuffer(
            chunkBuf.subarray(off, off + mftRecSize),
            runByteStart + off,
            ntfsParts,
            fd,
            limitBytes,
            dirMap,
            bitmapByVol,
            includeExisting,
            layout,
          );
          if (mftRes?.usnRuns) {
            usnSources.push(mftRes);
          } else if (mftRes?.entry) {
            mftRes.entry.devicePath = devicePath;
            candidates.push(mftRes);
            entries.push(mftRes.entry);
          }
        }
        runByteStart += n;
        remBytes -= n;
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }

  const truncatedByLimit = recordCount >= maxRecords;
  if (truncatedByLimit) {
    warnings.push(`NTFS Quick Scan reached the ${maxRecords.toLocaleString()} MFT record cap.`);
  }
  if (skippedBadReads > 0) {
    warnings.push(`NTFS Quick Scan skipped ${skippedBadReads} unreadable $MFT sector(s).`);
  }

  finalizeNtfsMftMetadata(candidates, dirMap, bitmapByVol);
  const pairedCandidates = rePairDeletedRecycleRecordsCjs(candidates);
  entries.length = 0;
  for (const c of pairedCandidates) {
    if (c?.entry) entries.push(c.entry);
  }

  if (!scanState?.cancelled) {
    for (const src of usnSources) {
      if (await waitIfPausedOrCancelled()) break;
      const part = src.usnVol;
      const secSize = part.sectorSize || 512;
      const tailRuns = src.usnRuns.slice(-4);
      for (const r of tailRuns) {
        if (r.lcn < 0) continue;
        const off = part.volStart + r.lcn * part.clusterBytes;
        const len = Math.min(4 * 1024 * 1024, r.clusterCount * part.clusterBytes, limitBytes - off);
        if (len < 128) continue;
        const uBuf = Buffer.allocUnsafe(len);
        try {
          const n = readAlignedSync(fd, uBuf, 0, len, off, secSize);
          const usnEntries = parseUsnJournalBufferCjs(uBuf.subarray(0, n), dirMap, part.volStart, 400);
          for (const u of usnEntries) {
            u.devicePath = devicePath;
            entries.push(u);
          }
        } catch {
          // skip unreadable USN slice
        }
      }
    }
  }

  return { entries, dirMap, bitmapByVol, warnings, truncatedByLimit, skippedBadReads };
}

function finalizeNtfsMftMetadata(mftRecords, dirMap, bitmapByVol) {
  for (const rec of mftRecords) {
    const parts = [rec.entry.filename];
    const visited = new Set();
    let cur = rec.parentRecord;
    let guard = 0;
    while (cur > 5 && !visited.has(cur) && guard < 32) {
      visited.add(cur);
      const node = dirMap.get(`${rec.volKey}:${cur}`);
      if (!node || !node.name || node.name === '.') break;
      parts.unshift(node.name);
      if (node.parentRecord === cur) break;
      cur = node.parentRecord;
      guard++;
    }
    rec.entry.originalPath = `\\${parts.join('\\')}`;

    const bm = bitmapByVol.get(rec.volKey);
    if (bm && rec.rawRuns.length > 0 && rec.isDeleted) {
      let overwritten = false;
      let checkedAllClusters = true;
      for (const r of rec.rawRuns) {
        if (r.lcn < 0) continue;
        for (let ci = 0; ci < r.clusterCount; ci++) {
          const lcn = r.lcn + ci;
          const bIdx = lcn >>> 3;
          if (bIdx >= bm.length) {
            checkedAllClusters = false;
            continue;
          }
          if ((bm[bIdx] & (1 << (lcn & 7))) !== 0) {
            overwritten = true;
            break;
          }
        }
        if (overwritten) break;
      }
      rec.entry.mftOverwritten = overwritten;
      // Never mark clusters outside bitmap coverage as intact
      rec.entry.mftBitmapIntact = overwritten ? false : checkedAllClusters ? true : undefined;
      if (!overwritten && !checkedAllClusters) {
        rec.entry.details = rec.entry.details
          ? `${rec.entry.details} · $Bitmap range exceeded`
          : 'Allocation check incomplete ($Bitmap range exceeded)';
      }
    }
  }
}

async function resolveBackingPhysicalDrive(winPath) {
  if (process.platform !== 'win32' || !winPath || !/^[A-Za-z]:/.test(winPath)) return null;
  const letter = winPath[0].toUpperCase();
  const rows = await runPowerShellJson(
    `Get-Partition -DriveLetter '${letter}' -ErrorAction SilentlyContinue | Select-Object DiskNumber,Offset,Size | ConvertTo-Json -Compress`,
  );
  if (!rows || rows.length === 0 || rows[0].DiskNumber === undefined) return null;
  return {
    driveLetter: `${letter}:`,
    devicePath: `\\\\.\\PhysicalDrive${Number(rows[0].DiskNumber)}`,
    volumeDevicePath: `\\\\.\\${letter}:`,
    partOffset: Number(rows[0].Offset || 0),
    partSize: Number(rows[0].Size || 0),
    relPrefix: winPath.slice(2).replace(/^\\+/, ''),
  };
}

async function scanVssSnapshotsForPrefix(relPrefix, existingPathsSet, outList, maxFiles = 1500, options = {}) {
  if (process.platform !== 'win32' || outList.length >= maxFiles) return;
  const shadows = await runPowerShellJson(
    'Get-CimInstance Win32_ShadowCopy -ErrorAction SilentlyContinue | Select-Object DeviceObject,VolumeName,InstallDate | ConvertTo-Json -Compress',
  );
  if (!shadows || shadows.length === 0) return;

  const volLetterByGuid = options.volLetterByGuid || new Map();
  const targetDriveLetter = options.driveLetter ? String(options.driveLetter).toUpperCase().replace(/:?$/, ':') : '';

  // Scope VSS snapshots to the requested volume BEFORE slicing recent snapshots (#14)
  const scopedShadows = targetDriveLetter
    ? shadows.filter((sh) => {
        const volKey = String(sh?.VolumeName || '').replace(/\\+$/, '').toLowerCase();
        const mapped = volLetterByGuid.get(volKey);
        return mapped && mapped.toUpperCase() === targetDriveLetter;
      })
    : shadows;

  for (const sh of scopedShadows.slice(-3)) {
    if (outList.length >= maxFiles || !sh?.DeviceObject) continue;
    const baseObj = String(sh.DeviceObject).replace(/\\+$/, '');
    const targetDir = relPrefix ? `${baseObj}\\${relPrefix}` : `${baseObj}\\`;
    const volKey = String(sh.VolumeName || '').replace(/\\+$/, '').toLowerCase();
    const resolvedLetter = volLetterByGuid.get(volKey) || options.driveLetter || '';
    const temp = [];
    if (options.isRecycleBin) {
      scanRecycleDir(targetDir, temp, Math.min(800, maxFiles - outList.length), options.preferredSid || null);
    } else {
      walkFolderEntries(targetDir, temp, Math.min(600, maxFiles - outList.length), null, '');
    }
    for (const item of temp) {
      if (item.filename && item.filename.toLowerCase() === 'desktop.ini') continue;
      const itemRel = String(item.relPath || item.filename).replace(/^\\+/, '');
      const fullNormRel = relPrefix ? `${relPrefix.replace(/\\+$/, '')}\\${itemRel}` : itemRel;
      const origNorm = String(item.originalPath || item.filename).toLowerCase();
      const normKey = options.isRecycleBin
        ? `${origNorm}|${item.size}`
        : fullNormRel.toLowerCase();
      if (existingPathsSet.has(normKey)) continue;
      existingPathsSet.add(normKey);
      item.id = `vss-${sh.DeviceObject}-${item.devicePath}`;
      item.isDeleted = true;
      item.scanPhase = 'vss';
      if (options.isRecycleBin) {
        item.sourceKind = 'recycle-bin';
        item.partitionName = resolvedLetter
          ? `Shadow Copy $Recycle.Bin (${resolvedLetter} · VSS)`
          : 'Shadow Copy $Recycle.Bin (VSS)';
        if (!item.originalPath || item.originalPath.startsWith('\\\\?\\GLOBALROOT')) {
          item.originalPath = `${resolvedLetter}\\$Recycle.Bin\\${item.filename}`;
        }
      } else {
        item.originalPath = `\\${fullNormRel}`;
      }
      outList.push(item);
    }
  }
}

function scopeNtfsPartsForTarget(volumes, target, isVolumeHandle) {
  let ntfsParts = volumes.filter((v) => v.fsType === 'ntfs');
  if (!isVolumeHandle && target.partOffset > 0 && target.partSize > 0) {
    const end = target.partOffset + target.partSize;
    const exact = ntfsParts.filter(
      (p) => Math.abs(p.volStart - target.partOffset) <= 1024 * 1024 || (p.volStart >= target.partOffset && p.volStart < end),
    );
    if (exact.length > 0) ntfsParts = exact;
  }
  return ntfsParts;
}

async function huntDeletedInBackingDrive(backing, isRecycleBin, maxEntries = 2000) {
  const candidatesToOpen = [];
  if (backing.volumeDevicePath) {
    candidatesToOpen.push({ path: backing.volumeDevicePath, isVol: true });
  }
  if (backing.devicePath) {
    candidatesToOpen.push({ path: backing.devicePath, isVol: false });
  }

  let fd = null;
  let openedSpec = null;
  let lastOpenErr = null;
  for (const spec of candidatesToOpen) {
    try {
      fd = fs.openSync(spec.path, 'r');
      openedSpec = spec;
      break;
    } catch (err) {
      lastOpenErr = err;
    }
  }
  if (fd === null || !openedSpec) {
    const code = lastOpenErr?.code || '';
    return {
      status: code === 'EACCES' || code === 'EPERM' ? 'needs-admin' : 'io-error',
      error: lastOpenErr?.message,
      entries: [],
      warnings: [],
    };
  }

  try {
    let limitBytes = backing.partSize > 0 && openedSpec.isVol ? backing.partSize : 0;
    if (!openedSpec.isVol) {
      const disks = await runPowerShellJson(
        `Get-Disk | Where-Object { $_.Number -eq ${Number(openedSpec.path.replace(/\D+/g, '') || 0)} } | Select-Object Size | ConvertTo-Json -Compress`,
      );
      const diskSize = Number(disks?.[0]?.Size || 0);
      if (diskSize > 0) limitBytes = diskSize;
    }
    if (limitBytes <= 0) limitBytes = 512 * 1024 * 1024 * 1024;

    const warnings = [];
    const sectorSize = detectSectorSizeSync(fd);
    const volumes = detectVolumesFromDisk(fd, limitBytes, sectorSize);
    const ntfsParts = scopeNtfsPartsForTarget(volumes, backing, openedSpec.isVol);

    const candidates = [];
    if (ntfsParts.length > 0) {
      const mftRes = scanNtfsMftContiguous(fd, openedSpec.path, ntfsParts, limitBytes, false, DEFAULT_MAX_HUNT_RECORDS);
      candidates.push(...mftRes.entries);
      if (mftRes.warnings?.length) warnings.push(...mftRes.warnings);
    }
    if (!isRecycleBin) {
      for (const vol of volumes) {
        if (vol.fsType === 'fat32') {
          const fList = scanFat32VolumeFromFd(fd, openedSpec.path, vol, limitBytes, false);
          candidates.push(...fList);
          if (fList.warnings?.length) warnings.push(...fList.warnings);
        } else if (vol.fsType === 'exfat') {
          const eList = scanExfatVolumeFromFd(fd, openedSpec.path, vol, limitBytes, false);
          candidates.push(...eList);
          if (eList.warnings?.length) warnings.push(...eList.warnings);
        }
      }
    }

    if (isRecycleBin) {
      const filtered = filterAndTagEmptiedRecycleEntriesCjs(candidates, {
        driveLetter: backing.driveLetter || '',
      }).slice(0, maxEntries);
      return { status: warnings.length > 0 ? 'partial' : 'scanned', entries: filtered, warnings };
    }

    const normPrefix = (backing.relPrefix || '').toLowerCase().replace(/^\\+|\\+$/g, '');
    const filtered = [];
    for (const item of candidates) {
      if (filtered.length >= maxEntries) break;
      const itemPath = String(item.originalPath || '').toLowerCase().replace(/^\\+|\\+$/g, '');
      if (normPrefix) {
        // Require strict directory boundary match instead of loose substring (#14)
        if (itemPath === normPrefix || itemPath.startsWith(`${normPrefix}\\`)) {
          filtered.push(item);
        }
      } else {
        filtered.push(item);
      }
    }
    return { status: warnings.length > 0 ? 'partial' : 'scanned', entries: filtered, warnings };
  } catch (err) {
    return {
      status: 'io-error',
      error: err?.message || 'Raw volume read failure',
      entries: [],
      warnings: [err?.message || 'Raw volume read failure'],
    };
  } finally {
    fs.closeSync(fd);
  }
}

// Structural media repair functions live in ./mediaRepairCjs.cjs for multi-GB streaming support.

function readDiskBytesFromFdSync(fd, startByte = 0, maxBytes = 64 * 1024 * 1024, sectorSizeHint = 0) {
  const safeStart = Number.isFinite(Number(startByte)) ? Math.max(0, Math.floor(Number(startByte))) : 0;
  const safeMax = Number.isFinite(Number(maxBytes))
    ? Math.max(0, Math.min(128 * 1024 * 1024, Math.floor(Number(maxBytes))))
    : 64 * 1024 * 1024;
  if (safeMax === 0) return Buffer.alloc(0);

  const sectorSize = sectorSizeHint > 0 ? normalizeSectorSize(sectorSizeHint) : detectSectorSizeSync(fd);
  const alignedStart = Math.floor(safeStart / sectorSize) * sectorSize;
  const headTrim = safeStart - alignedStart;
  const alignedTotal = Math.ceil((headTrim + safeMax) / sectorSize) * sectorSize;

  const chunkSize = Math.min(4 * 1024 * 1024, Math.max(sectorSize, alignedTotal));
  const out = Buffer.allocUnsafe(safeMax);
  const scratch = Buffer.allocUnsafe(chunkSize);
  let outCursor = 0;
  let diskCursor = alignedStart;
  let firstChunk = true;

  while (outCursor < safeMax) {
    const remainingTotal = alignedTotal - (diskCursor - alignedStart);
    if (remainingTotal <= 0) break;
    const toRead = Math.min(chunkSize, remainingTotal);
    const alignedToRead = Math.ceil(toRead / sectorSize) * sectorSize;
    const res = readAlignedResilientSync(fd, scratch, 0, Math.min(scratch.length, alignedToRead), diskCursor, sectorSize);
    const bytesRead = res.bytesRead;
    if (bytesRead <= 0) break;

    const srcOffset = firstChunk ? headTrim : 0;
    firstChunk = false;
    if (bytesRead <= srcOffset) break;

    const take = Math.min(safeMax - outCursor, bytesRead - srcOffset);
    if (take <= 0) break;
    scratch.copy(out, outCursor, srcOffset, srcOffset + take);
    outCursor += take;
    diskCursor += bytesRead;
    if (bytesRead < alignedToRead) break;
  }

  return outCursor === safeMax ? out : out.subarray(0, outCursor);
}

function buildBitLockerUnlockSpec({ driveLetter, recoveryKey, password } = {}) {
  const cleanLetter = String(driveLetter || '').trim().replace(/:$/, '');
  if (!/^[A-Za-z]$/.test(cleanLetter)) {
    return { ok: false, error: 'Invalid drive letter.' };
  }
  const cleanKey = recoveryKey ? String(recoveryKey).trim() : '';
  const cleanPass = password ? String(password).trim() : '';
  if (!cleanKey && !cleanPass) {
    return { ok: false, error: 'Enter a 48-digit BitLocker recovery password or user password.' };
  }

  if (cleanKey) {
    return {
      ok: true,
      file: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference = 'Stop'; Unlock-BitLocker -MountPoint ($env:TD_BL_LETTER + ':') -RecoveryPassword $env:TD_BL_KEY | Out-Null; Write-Output ('Unlocked ' + $env:TD_BL_LETTER + ':')",
      ],
      envPatch: {
        TD_BL_LETTER: cleanLetter.toUpperCase(),
        TD_BL_KEY: cleanKey,
      },
      cleanLetter: cleanLetter.toUpperCase(),
    };
  }

  return {
    ok: true,
    file: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$ErrorActionPreference = 'Stop'; $pw = ConvertTo-SecureString $env:TD_BL_PASS -AsPlainText -Force; Unlock-BitLocker -MountPoint ($env:TD_BL_LETTER + ':') -Password $pw | Out-Null; Write-Output ('Unlocked ' + $env:TD_BL_LETTER + ':')",
    ],
    envPatch: {
      TD_BL_LETTER: cleanLetter.toUpperCase(),
      TD_BL_PASS: cleanPass,
    },
    cleanLetter: cleanLetter.toUpperCase(),
  };
}

async function checkSameSourcePaths({
  targetPath,
  sourcePaths = [],
  resolveBackingDriveFn = resolveBackingPhysicalDrive,
  allowUnverifiedDestination = false,
  platform = process.platform,
} = {}) {
  if (!targetPath || !String(targetPath).trim()) {
    return { blocked: false };
  }
  const pathApi = platform === 'win32' ? path.win32 : path;
  const resolvedTarget = pathApi.resolve(String(targetPath));
  const resolvedTargetLower = resolvedTarget.toLowerCase();
  const targetDriveMatch = resolvedTarget.match(/^([A-Za-z]:)(?:\\|$)/);
  const targetDriveLetter = targetDriveMatch ? targetDriveMatch[1].toUpperCase() : null;

  const uniqueSources = [];
  const seenSrc = new Set();
  for (const s of sourcePaths) {
    if (typeof s !== 'string') continue;
    const trimmed = s.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seenSrc.has(key)) continue;
    seenSrc.add(key);
    uniqueSources.push(trimmed);
  }

  let resolvedBackingCache;
  let checkedBacking = false;
  const getDestBacking = async () => {
    if (checkedBacking) return resolvedBackingCache;
    checkedBacking = true;
    try {
      resolvedBackingCache = await resolveBackingDriveFn(resolvedTarget);
    } catch {
      resolvedBackingCache = null;
    }
    return resolvedBackingCache;
  };

  for (const src of uniqueSources) {
    if (/^\\\\\.\\[A-Za-z]:$/i.test(src)) {
      const srcVolPrefix = src.slice(4, 6).toUpperCase();
      if (targetDriveLetter === srcVolPrefix || resolvedTarget.toUpperCase().startsWith(srcVolPrefix)) {
        return {
          blocked: true,
          sourcePath: src,
          reason: `Safety block: "${targetPath}" resides on the same volume (${srcVolPrefix}) being recovered. Choose a different drive to prevent overwriting deleted clusters.`,
        };
      }
      continue;
    }

    if (/^\\\\\.\\PhysicalDrive\d+$/i.test(src)) {
      if (platform === 'win32') {
        const destBacking = await getDestBacking();
        if (destBacking && destBacking.devicePath && destBacking.devicePath.toLowerCase() === src.toLowerCase()) {
          return {
            blocked: true,
            sourcePath: src,
            reason: `Safety block: "${targetPath}" resides on the same physical disk (${src}) being recovered. Choose a different drive to prevent overwriting deleted clusters.`,
          };
        }
        if (!destBacking && !allowUnverifiedDestination) {
          return {
            blocked: true,
            unverified: true,
            sourcePath: src,
            reason: `Safety block: Could not verify whether "${targetPath}" is on a separate drive from ${src}. Pick a verified separate drive or explicitly confirm override if using a virtual/network volume.`,
          };
        }
      }
      continue;
    }

    // Standard file/image/folder path check
    try {
      const resolvedSrc = pathApi.resolve(src);
      const resolvedSrcLower = resolvedSrc.toLowerCase();
      if (resolvedTargetLower === resolvedSrcLower || resolvedTargetLower.startsWith(resolvedSrcLower + pathApi.sep)) {
        return {
          blocked: true,
          sourcePath: src,
          reason: `Safety block: "${targetPath}" matches or sits inside active source "${src}".`,
        };
      }
      if (targetDriveLetter && /^[A-Za-z]:/i.test(resolvedSrc)) {
        const srcLetter = resolvedSrc.slice(0, 2).toUpperCase();
        // If writing inside same folder as a disk image when recovering to parent dir, check same drive if requested?
        // For raw disk images (.img/.dd/.raw) block overwriting the image itself; for same-volume warning UI handles volume letter.
        void srcLetter;
      }
    } catch {
      // ignore unresolvable source strings
    }
  }

  return { blocked: false };
}

function streamExtentToFdSync(srcFd, dstFd, offset, length, sectorSize, copyBuf, zeroBuf, headChunks) {
  let remaining = Number.isFinite(Number(length)) ? Math.max(0, Math.floor(Number(length))) : 0;
  if (remaining <= 0) return { bytesWritten: 0, skippedSectors: 0, skippedBytes: 0 };

  let headCaptured = headChunks.reduce((sum, c) => sum + c.length, 0);
  let bytesWritten = 0;
  let skippedSectors = 0;
  let skippedBytes = 0;

  if (offset < 0) {
    while (remaining > 0) {
      const zLen = Math.min(zeroBuf.length, remaining);
      fs.writeSync(dstFd, zeroBuf, 0, zLen);
      bytesWritten += zLen;
      if (headCaptured < 65536) {
        const take = Math.min(zLen, 65536 - headCaptured);
        headChunks.push(Buffer.alloc(take));
        headCaptured += take;
      }
      remaining -= zLen;
    }
    return { bytesWritten, skippedSectors, skippedBytes };
  }

  const effSector = normalizeSectorSize(sectorSize);
  let readPos = offset;
  while (remaining > 0) {
    const alignedStart = Math.floor(readPos / effSector) * effSector;
    const headTrim = readPos - alignedStart;
    const rawNeed = Math.min(copyBuf.length - effSector, remaining);
    const alignedRead = Math.ceil((headTrim + rawNeed) / effSector) * effSector;
    const readRes = readAlignedResilientSync(
      srcFd,
      copyBuf,
      0,
      Math.min(copyBuf.length, alignedRead),
      alignedStart,
      effSector,
    );
    const n = readRes.bytesRead;
    skippedSectors += readRes.skippedSectors;
    skippedBytes += readRes.skippedBytes;
    if (n <= headTrim) break;
    const validLen = Math.min(remaining, n - headTrim);
    if (validLen <= 0) break;
    fs.writeSync(dstFd, copyBuf, headTrim, validLen);
    bytesWritten += validLen;
    if (headCaptured < 65536) {
      const take = Math.min(validLen, 65536 - headCaptured);
      headChunks.push(Buffer.from(copyBuf.subarray(headTrim, headTrim + take)));
      headCaptured += take;
    }
    readPos += validLen;
    remaining -= validLen;
  }

  return { bytesWritten, skippedSectors, skippedBytes };
}

function readExfatBitmapOnly(fd, exfatParts, limitBytes, sectorSizeHint = 0) {
  const result = [];
  const warnings = [];
  for (const part of exfatParts) {
    const secSize = part.sectorSize || normalizeSectorSize(sectorSizeHint);
    const clusterBytes = Math.max(512, part.clusterBytes || 4096);
    const heapOff = Number(part.heapOffset || 0);
    const rootOff = Number(part.rootDirOffset || 0);
    if (!heapOff || !rootOff || rootOff >= limitBytes) continue;

    try {
      const rootBuf = Buffer.allocUnsafe(clusterBytes);
      const rRead = readAlignedSync(fd, rootBuf, 0, clusterBytes, rootOff, secSize);
      for (let off = 0; off + 32 <= rRead; off += 32) {
        if (rootBuf[off] === 0x81) {
          const bmCluster = rootBuf.readUInt32LE(off + 20);
          const bmLen = Number(rootBuf.readBigUInt64LE(off + 24));
          if (bmCluster >= 2 && bmLen > 0) {
            const bmOff = heapOff + (bmCluster - 2) * clusterBytes;
            const cappedLen = Math.min(NTFS_BITMAP_MAX_BYTES, bmLen, Math.max(0, limitBytes - bmOff));
            if (cappedLen > 0) {
              const bmBuf = Buffer.allocUnsafe(cappedLen);
              const bRead = readAlignedSync(fd, bmBuf, 0, cappedLen, bmOff, secSize);
              result.push({
                volStart: heapOff,
                volEnd: part.volEnd,
                clusterBytes,
                bitmap: bRead < cappedLen ? bmBuf.subarray(0, bRead) : bmBuf,
              });
            }
          }
          break;
        }
      }
    } catch {
      warnings.push(`Could not read exFAT allocation bitmap on volume @ ${part.volStart}; unallocated filter cannot verify this volume.`);
    }
  }
  return { bitmaps: result, warnings };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#11151C',
    title: 'Disk & Partition Recovery Explorer',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

if (app && typeof app.whenReady === 'function') {
  app.whenReady().then(() => {
    ipcMain.handle('win:list-drives', async () => {
      if (process.platform !== 'win32') return [];
      const disks = await runPowerShellJson(
        'Get-Disk | Select-Object Number, FriendlyName, Size, BusType, PartitionStyle, OperationalStatus | ConvertTo-Json -Compress',
      );
      const parts = await runPowerShellJson(
        'Get-Partition | Select-Object DiskNumber, PartitionNumber, DriveLetter, Size, Type | ConvertTo-Json -Compress',
      );
      return disks.map((d) => ({
        number: Number(d.Number ?? 0),
        devicePath: `\\\\.\\PhysicalDrive${Number(d.Number ?? 0)}`,
        name: String(d.FriendlyName || `PhysicalDrive${d.Number ?? 0}`),
        sizeBytes: Number(d.Size || 0),
        busType: String(d.BusType || 'Unknown'),
        partitionStyle: String(d.PartitionStyle || 'MBR'),
        status: String(d.OperationalStatus || 'Online'),
        letters: parts
          .filter((p) => Number(p.DiskNumber) === Number(d.Number) && p.DriveLetter)
          .map((p) => `${String(p.DriveLetter).trim()}:`)
          .filter(Boolean),
      }));
    });

    ipcMain.handle('win:list-volumes', async () => {
      if (process.platform !== 'win32') return [];
      const vols = await runPowerShellJson(
        'Get-Volume | Where-Object { $_.DriveLetter -and $_.Size -gt 0 } | Select-Object DriveLetter,FileSystemLabel,FileSystem,SizeRemaining,Size | ConvertTo-Json -Compress',
      );
      return vols.map((v) => {
        const letter = `${String(v.DriveLetter).trim()}:`;
        return {
          driveLetter: letter,
          rootPath: `${letter}\\`,
          label: String(v.FileSystemLabel || 'Local Disk'),
          fileSystem: String(v.FileSystem || 'NTFS'),
          freeBytes: Number(v.SizeRemaining || 0),
          totalBytes: Number(v.Size || 0),
        };
      });
    });

    ipcMain.handle('win:get-engine-capabilities', async () => {
      const caps = getEngineCapabilitiesSync();
      const isAdmin = await checkWindowsIsAdmin();
      return { ...caps, isAdmin };
    });

    ipcMain.handle('win:relaunch-admin', async () => {
      if (process.platform !== 'win32') return { ok: false, error: 'Only supported on Windows.' };
      return await new Promise((resolve) => {
        const child = execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:TD_RELAUNCH_EXE -Verb RunAs'],
          {
            windowsHide: true,
            env: { ...process.env, TD_RELAUNCH_EXE: process.execPath },
          },
          (err, _stdout, stderr) => {
            if (err) {
              resolve({ ok: false, error: (stderr || err.message || 'UAC elevation was cancelled.').trim() });
              return;
            }
            resolve({ ok: true });
            setTimeout(() => app.quit(), 250);
          },
        );
        child.on('error', (err) => resolve({ ok: false, error: err.message }));
      });
    });

    ipcMain.handle('win:probe-video-preview', async (_event, params = {}) => {
      let source = { filePath: params.filePath, buffer: params.buffer };
      if (
        !source.filePath &&
        (!source.buffer || source.buffer.length === 0) &&
        params.tskInode &&
        params.devicePath
      ) {
        const head = await readTskInodeHead(
          params.devicePath,
          params.tskOffset || 0,
          params.tskInode,
          4 * 1024 * 1024,
        );
        if (head) source = { buffer: head };
      }
      return await probeVideoFrameWithFfmpeg(source);
    });

    ipcMain.handle('win:repair-media-file', async (_event, params = {}) => {
      const ext =
        String(params.extension || path.extname(params.filename || '') || 'mp4')
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '')
          .slice(0, 12) || 'bin';
      const tmpBase = path.join(os.tmpdir(), `td_med_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
      const tmpSrc = `${tmpBase}.src.${ext}`;
      const tmpStruct = `${tmpBase}.struct.${ext}`;
      const tmpOut = `${tmpBase}.out.${ext}`;
      const cleanup = (p) => {
        try {
          if (p && fs.existsSync(p)) fs.unlinkSync(p);
        } catch {
          // ignore cleanup
        }
      };

      // Guard temp directory & dialog saves against overwriting the same scanned source drive
      const sourceList = [params.devicePath, params.filePath].filter(Boolean);
      const tmpGuard = await checkSameSourcePaths({
        targetPath: tmpSrc,
        sourcePaths: sourceList,
        allowUnverifiedDestination: true,
      });
      if (tmpGuard.blocked) {
        return { ok: false, tier: 'none', repairedSize: 0, note: tmpGuard.reason, error: tmpGuard.reason };
      }

      let workPath = tmpSrc;
      try {
        if (params.buffer && params.buffer.length > 0) {
          fs.writeFileSync(tmpSrc, Buffer.from(params.buffer));
        } else if (params.filePath && fs.existsSync(params.filePath)) {
          workPath = params.filePath;
        } else if (params.sourceKind === 'native-tsk' && params.devicePath && params.tskInode) {
          const tskRes = await extractTskInodeToFile(
            params.devicePath,
            params.tskOffset || 0,
            params.tskInode,
            tmpSrc,
            Number(params.size || 0),
          );
          if (!tskRes.ok) return { ok: false, tier: 'none', repairedSize: 0, note: tskRes.error || 'TSK extraction failed' };
        } else if (params.devicePath) {
          const srcFd = fs.openSync(params.devicePath, 'r');
          const dstFd = fs.openSync(tmpSrc, 'w');
          const sectorSize = detectSectorSizeSync(srcFd);
          const copyChunk = Buffer.allocUnsafe(4 * 1024 * 1024);
          const zeroChunk = Buffer.alloc(1024 * 1024);
          const rawRanges =
            Array.isArray(params.runs) && params.runs.length > 0
              ? params.runs
              : [{ offset: params.offset || 0, length: params.size || 0 }];
          const expectedTotal = rawRanges.reduce(
            (s, r) => s + (Number.isFinite(Number(r?.length)) ? Math.max(0, Math.floor(Number(r.length))) : 0),
            0,
          );
          let totalCopied = 0;
          try {
            const dummyHead = [];
            for (const run of rawRanges) {
              const extRes = streamExtentToFdSync(
                srcFd,
                dstFd,
                Number(run?.offset ?? -1),
                Number(run?.length ?? 0),
                sectorSize,
                copyChunk,
                zeroChunk,
                dummyHead,
              );
              totalCopied += extRes.bytesWritten;
              if (dummyHead.length > 1) dummyHead.length = 1;
            }
          } finally {
            fs.closeSync(srcFd);
            fs.closeSync(dstFd);
          }
          if (expectedTotal > 0 && totalCopied < expectedTotal) {
            return {
              ok: false,
              tier: 'none',
              repairedSize: totalCopied,
              note: `Short read while staging repair input (${totalCopied} of ${expectedTotal} B).`,
            };
          }
        } else {
          return { ok: false, tier: 'none', repairedSize: 0, note: 'No readable media source supplied.' };
        }

        const srcSize = fs.statSync(workPath).size;
        const refBuf = params.referenceBuffer ? Buffer.from(params.referenceBuffer) : null;
        let structuralTier = '';
        let structuralNote = '';
        let salvagedPreviewBuf = null;
        let stagePath = workPath;

        if (['mp4', 'mov', 'm4v', '3gp'].includes(ext)) {
          const mp4Res = repairMp4StreamingFileCjs(workPath, tmpStruct, refBuf);
          if (mp4Res && mp4Res.ok && fs.existsSync(tmpStruct)) {
            stagePath = tmpStruct;
            structuralTier = mp4Res.tier || 'structural-moov';
            structuralNote = mp4Res.note;
          }
        } else if (srcSize <= 256 * 1024 * 1024) {
          const rawBuf = fs.readFileSync(workPath);
          if (ext === 'jpg' || ext === 'jpeg') {
            const jpgRes = repairJpegBufferCjs(rawBuf, refBuf);
            if (jpgRes) {
              if (jpgRes.salvagedPreview) salvagedPreviewBuf = jpgRes.salvagedPreview;
              if (jpgRes.data) {
                fs.writeFileSync(tmpStruct, jpgRes.data);
                stagePath = tmpStruct;
                structuralTier = 'structural-jpeg';
                structuralNote = jpgRes.note;
              }
            }
          } else if (ext === 'png') {
            const pngRes = repairPngBufferCjs(rawBuf);
            if (pngRes && pngRes.data) {
              fs.writeFileSync(tmpStruct, pngRes.data);
              stagePath = tmpStruct;
              structuralTier = 'structural-png';
              structuralNote = pngRes.note;
            }
          } else if (ext === 'avi') {
            const aviRes = repairAviBufferCjs(rawBuf);
            if (aviRes && aviRes.data) {
              fs.writeFileSync(tmpStruct, aviRes.data);
              stagePath = tmpStruct;
              structuralTier = 'structural-avi';
              structuralNote = aviRes.note;
            }
          } else if (['cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'rw2', 'tif', 'tiff'].includes(ext)) {
            const emb = extractEmbeddedJpegCjs(rawBuf, false);
            if (emb) {
              salvagedPreviewBuf = emb;
              structuralTier = 'raw-preview';
              structuralNote = `Extracted intact embedded JPEG preview (${emb.length} B) from ${ext.toUpperCase()} Camera RAW.`;
            }
          } else if ((ext === 'mkv' || ext === 'webm') && rawBuf.length >= 64) {
            let trimEnd = rawBuf.length;
            while (trimEnd > 64 && rawBuf[trimEnd - 1] === 0x00) trimEnd--;
            if (rawBuf.length - trimEnd >= 16) {
              fs.writeFileSync(tmpStruct, rawBuf.subarray(0, trimEnd));
              stagePath = tmpStruct;
              structuralTier = 'structural-ebml';
              structuralNote = `Trimmed ${rawBuf.length - trimEnd} B trailing null slack from ${ext.toUpperCase()}.`;
            }
          } else if ((ext === 'wav' || ext === 'webp') && rawBuf.length >= 12) {
            const copy = Buffer.from(rawBuf);
            copy.writeUInt32LE(Math.max(4, copy.length - 8) >>> 0, 4);
            if (ext === 'wav' && copy.length >= 44) copy.writeUInt32LE(Math.max(0, copy.length - 44) >>> 0, 40);
            fs.writeFileSync(tmpStruct, copy);
            stagePath = tmpStruct;
            structuralTier = 'structural-riff';
            structuralNote = `Recalculated ${ext.toUpperCase()} RIFF payload length.`;
          } else if (ext === 'gif' && rawBuf.length >= 14 && rawBuf[rawBuf.length - 1] !== 0x3b) {
            fs.writeFileSync(tmpStruct, Buffer.concat([rawBuf, Buffer.from([0x3b])]));
            stagePath = tmpStruct;
            structuralTier = 'structural-gif';
            structuralNote = 'Appended missing GIF89a/87a trailer (0x3B).';
          } else if (NON_MEDIA_REPAIR_EXTS_CJS.has(ext)) {
            const docRes = repairNonMediaBufferCjs(ext, rawBuf);
            if (docRes) {
              if (docRes.salvagedPreview) salvagedPreviewBuf = docRes.salvagedPreview;
              if (docRes.data) {
                fs.writeFileSync(tmpStruct, docRes.data);
                stagePath = tmpStruct;
                structuralTier = `structural-${ext}`;
                structuralNote = docRes.note;
              }
            }
          }
        }

        let finalPath = stagePath;
        let finalTier = structuralTier || 'none';
        let finalNote = structuralNote;

        const stageSize = fs.statSync(stagePath).size;
        const skipFfmpegForDoc = NON_MEDIA_REPAIR_EXTS_CJS.has(ext) && ext !== 'mp3' && ext !== 'flac';
        const skipRedundantFfmpegCopy = Boolean(structuralTier === 'structural-moov' && stageSize > 1024 * 1024 * 1024);

        if (!skipFfmpegForDoc && getEngineCapabilitiesSync().ffmpeg && !skipRedundantFfmpegCopy) {
          const ffRes = await ffmpegRepairVideoFile(stagePath, tmpOut, {
            extension: ext,
            allowTranscode: Boolean(params.allowTranscodeFallback),
          });
          if (ffRes.ok) {
            finalPath = tmpOut;
            finalTier = structuralTier ? `${structuralTier}+${ffRes.tier}` : ffRes.tier;
            finalNote = structuralNote ? `${structuralNote} ${ffRes.note}` : ffRes.note;
          }
        }

        if (finalTier === 'none') {
          const isDocOrArchive = NON_MEDIA_REPAIR_EXTS_CJS.has(ext) && ext !== 'mp3' && ext !== 'flac';
          return {
            ok: false,
            tier: 'none',
            repairedSize: srcSize,
            salvagedPreviewBytes: salvagedPreviewBuf ? new Uint8Array(salvagedPreviewBuf) : undefined,
            note: isDocOrArchive
              ? `No structural patches needed or .${ext.toUpperCase()} stream cannot be rebuilt automatically (${Math.round(srcSize / 1024)} KiB).`
              : 'Container could not be repaired automatically. Enable salvage re-encode or supply a healthy reference clip/photo.',
          };
        }

        let previewDataUrl;
        if (['mp4', 'mov', 'm4v', '3gp', 'mkv', 'avi'].includes(ext)) {
          const probe = await probeVideoFrameWithFfmpeg({ filePath: finalPath });
          previewDataUrl = probe?.thumbnailDataUrl;
        } else if (salvagedPreviewBuf) {
          previewDataUrl = `data:image/jpeg;base64,${salvagedPreviewBuf.toString('base64')}`;
        } else if (['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'].includes(ext) && fs.statSync(finalPath).size <= 16 * 1024 * 1024) {
          const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'bmp' ? 'image/bmp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
          previewDataUrl = `data:${mime};base64,${fs.readFileSync(finalPath).toString('base64')}`;
        }

        const finalSize = fs.statSync(finalPath).size;
        let outputPath;
        if (params.saveWithDialog) {
          const cleanName = sanitizeWinFilename(params.filename || `repaired.${ext}`).replace(/(\.[^.]+)?$/, `_repaired.${ext}`);
          const res = await dialog.showSaveDialog({
            title: 'Save Repaired Media File',
            defaultPath: cleanName,
            filters: [{ name: `${ext.toUpperCase()} File`, extensions: [ext] }, { name: 'All Files', extensions: ['*'] }],
          });
          if (res.canceled || !res.filePath) {
            return { ok: true, canceled: true, tier: finalTier, repairedSize: finalSize, note: finalNote, previewDataUrl };
          }
          const saveGuard = await checkSameSourcePaths({
            targetPath: res.filePath,
            sourcePaths: sourceList,
          });
          if (saveGuard.blocked) {
            return { ok: false, tier: finalTier, repairedSize: finalSize, note: saveGuard.reason, error: saveGuard.reason };
          }
          fs.copyFileSync(finalPath, res.filePath);
          outputPath = res.filePath;
        }

        const repairedBytes =
          !params.saveWithDialog && finalSize <= 128 * 1024 * 1024
            ? new Uint8Array(fs.readFileSync(finalPath))
            : undefined;

        return {
          ok: true,
          tier: finalTier,
          repairedSize: finalSize,
          note: finalNote,
          previewDataUrl,
          outputPath,
          repairedBytes,
          salvagedPreviewBytes: salvagedPreviewBuf ? new Uint8Array(salvagedPreviewBuf) : undefined,
        };
      } catch (err) {
        return { ok: false, tier: 'none', repairedSize: 0, note: 'Repair error', error: err?.message || 'Unknown error' };
      } finally {
        if (workPath === tmpSrc) cleanup(tmpSrc);
        cleanup(tmpStruct);
        cleanup(tmpOut);
      }
    });

    ipcMain.handle('win:identify-files', async (_event, filePaths) => {
      return await runFidentifyPaths(filePaths);
    });

    ipcMain.handle(
      'win:read-disk-bytes',
      async (_event, { devicePath, startByte = 0, maxBytes = 64 * 1024 * 1024, tskInode, tskOffset = 0 } = {}) => {
        if (typeof devicePath !== 'string' || !devicePath.trim()) {
          return new Uint8Array(0);
        }
        const safeStart = Number.isFinite(Number(startByte)) ? Math.max(0, Math.floor(Number(startByte))) : 0;
        const safeMax = Number.isFinite(Number(maxBytes))
          ? Math.max(0, Math.min(128 * 1024 * 1024, Math.floor(Number(maxBytes))))
          : 64 * 1024 * 1024;
        if (safeMax === 0) return new Uint8Array(0);

        if (tskInode) {
          const head = await readTskInodeHead(
            devicePath,
            tskOffset || 0,
            tskInode,
            Math.min(safeMax, 64 * 1024 * 1024),
          );
          return head ? new Uint8Array(head.buffer, head.byteOffset, head.byteLength) : new Uint8Array(0);
        }

        const fd = fs.openSync(devicePath, 'r');
        try {
          const combined = readDiskBytesFromFdSync(fd, safeStart, safeMax);
          return new Uint8Array(combined.buffer, combined.byteOffset, combined.byteLength);
        } finally {
          fs.closeSync(fd);
        }
      },
    );

    ipcMain.handle('win:scan-lost-partitions', async (_event, { devicePath, totalBytes = 0 } = {}) => {
      if (typeof devicePath !== 'string' || !devicePath.trim()) {
        return { partitions: [], sectorSize: 512, limitBytes: 0, warnings: [] };
      }
      const fd = fs.openSync(devicePath, 'r');
      try {
        const limitBytes = totalBytes > 0 ? totalBytes : fs.fstatSync(fd).size;
        const sectorSize = detectSectorSizeSync(fd);
        const found = scanLostPartitionsFromFd(fd, limitBytes, sectorSize);
        const warnings = [...(found.warnings || [])];
        if (getEngineCapabilitiesSync().mmls) {
          const mmlsParts = await runMmlsPartitions(devicePath, sectorSize);
          const knownStarts = new Set(found.partitions.map((p) => p.startOffset));
          for (const mp of mmlsParts) {
            if (!knownStarts.has(mp.startByte)) {
              found.partitions.push({
                id: `lost-${Math.floor(mp.startByte / sectorSize)}`,
                startLba: Math.floor(mp.startByte / sectorSize),
                endLba: Math.floor((mp.startByte + mp.lengthBytes) / sectorSize) - 1,
                sectors: Math.floor(mp.lengthBytes / sectorSize),
                sizeBytes: mp.lengthBytes,
                startOffset: mp.startByte,
                status: 'Deleted / Lost',
                typeCode: '0x83',
                typeName: mp.description || 'Volume',
                name: mp.description || 'Volume',
              });
            }
          }
        }
        return { partitions: found.partitions, sectorSize: found.sectorSize || sectorSize, limitBytes, warnings };
      } finally {
        fs.closeSync(fd);
      }
    });

    ipcMain.handle('win:pick-disk-image', async () => {
      const res = await dialog.showOpenDialog({
        title: 'Open Raw Disk or Partition Image',
        properties: ['openFile'],
        filters: [
          { name: 'Disk Images', extensions: ['img', 'dd', 'raw', 'iso', 'bin', 'vhd'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      if (res.canceled || res.filePaths.length === 0) return null;
      const filePath = res.filePaths[0];
      const stat = fs.statSync(filePath);
      return {
        path: filePath,
        name: path.basename(filePath),
        sizeBytes: stat.size,
      };
    });

    ipcMain.handle('win:pick-folder', async () => {
      const res = await dialog.showOpenDialog({
        title: 'Select Windows Folder to Scan',
        properties: ['openDirectory'],
      });
      if (res.canceled || res.filePaths.length === 0) return null;
      return res.filePaths[0];
    });

    ipcMain.handle('win:list-bitlocker', async () => {
      if (process.platform !== 'win32') return [];
      const vols = await runPowerShellJson(
        'Get-BitLockerVolume -ErrorAction SilentlyContinue | Select-Object MountPoint,LockStatus,EncryptionPercentage,VolumeStatus,ProtectionStatus | ConvertTo-Json -Compress',
      );
      return vols.map((v) => ({
        mountPoint: String(v.MountPoint || ''),
        lockStatus: String(v.LockStatus || 'Unknown'),
        encryptionPercent: Number(v.EncryptionPercentage || 0),
        volumeStatus: String(v.VolumeStatus || ''),
      }));
    });

    ipcMain.handle('win:unlock-bitlocker', async (_event, params = {}) => {
      if (process.platform !== 'win32') return { ok: false, error: 'Only supported on Windows.' };
      const spec = buildBitLockerUnlockSpec(params);
      if (!spec.ok) return { ok: false, error: spec.error };
      return await new Promise((resolve) => {
        execFile(
          spec.file,
          spec.args,
          {
            windowsHide: true,
            env: { ...process.env, ...spec.envPatch },
          },
          (err, stdout, stderr) => {
            if (err) {
              resolve({ ok: false, error: (stderr || stdout || err.message || 'Unlock failed').trim() });
              return;
            }
            resolve({ ok: true, message: (stdout || `Unlocked ${spec.cleanLetter}:`).trim() });
          },
        );
      });
    });

    async function scanLocationAndDeleted(targetPath) {
      const out = [];
      const existingSet = new Set();

      if (targetPath) {
        walkFolderEntries(targetPath, out, 25000);
        for (const item of out) {
          existingSet.add(String(item.relPath || item.filename).toLowerCase());
        }
      }

      let deletedLookupStatus = 'unsupported';
      let backingDrive;
      const warnings = [];
      if (process.platform === 'win32') {
        const probePath = targetPath || `${process.env.SystemDrive || 'C:'}\\`;
        const backing = await resolveBackingPhysicalDrive(probePath);
        if (backing) {
          backingDrive = backing.devicePath;
          await scanVssSnapshotsForPrefix(backing.relPrefix, existingSet, out, 5000, {
            driveLetter: backing.driveLetter,
          });
          const delRes = await huntDeletedInBackingDrive(backing, false, 10000);
          deletedLookupStatus = delRes.status;
          if (delRes.warnings?.length) warnings.push(...delRes.warnings);
          if (delRes.entries.length > 0) {
            out.push(...delRes.entries);
          }
        }
      }

      return {
        entries: out,
        path: targetPath,
        deletedLookupStatus,
        backingDrive,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    }

    async function scanAllRecycleBinsAndEmptiedNtfs() {
      const out = [];
      const existingLiveOrVssKeys = new Set();

      if (process.platform !== 'win32') {
        return {
          entries: out,
          path: 'Windows $Recycle.Bin',
          deletedLookupStatus: 'unsupported',
          liveCount: 0,
          vssCount: 0,
          emptiedCount: 0,
          scannedVolumes: [],
          needsAdminVolumes: [],
        };
      }

      const [volsPs, partsPs, rootsPs, currentSid] = await Promise.all([
        runPowerShellJson(
          'Get-Volume | Where-Object { $_.DriveLetter -and $_.Size -gt 0 } | Select-Object DriveLetter,FileSystem,FileSystemLabel,Size | ConvertTo-Json -Compress',
        ),
        runPowerShellJson(
          'Get-Partition | Where-Object { $_.DriveLetter } | Select-Object DriveLetter,DiskNumber,Offset,Size | ConvertTo-Json -Compress',
        ),
        runPowerShellJson('Get-PSDrive -PSProvider FileSystem | Select-Object Root | ConvertTo-Json -Compress'),
        getCurrentUserWindowsSid(),
      ]);

      const rootSet = new Set();
      for (const v of volsPs) {
        if (v && v.DriveLetter) rootSet.add(`${String(v.DriveLetter).trim().toUpperCase()}:\\`);
      }
      for (const r of rootsPs) {
        if (r && r.Root) rootSet.add(String(r.Root));
      }
      if (rootSet.size === 0) {
        rootSet.add(`${(process.env.SystemDrive || 'C:').replace(/:$/, '')}:\\`);
      }

      for (const rootDir of rootSet) {
        scanRecycleDir(path.join(rootDir, '$Recycle.Bin'), out, 25000, currentSid);
      }
      for (const item of out) {
        existingLiveOrVssKeys.add(`${String(item.originalPath || item.filename).toLowerCase()}|${item.size}`);
      }
      const liveCount = out.length;

      const winVolumes = await runPowerShellJson(
        'Get-CimInstance Win32_Volume -ErrorAction SilentlyContinue | Select-Object DeviceID,DriveLetter | ConvertTo-Json -Compress',
      );
      const volLetterByGuid = new Map();
      for (const wv of winVolumes) {
        if (wv && wv.DeviceID && wv.DriveLetter) {
          const key = String(wv.DeviceID).replace(/\\+$/, '').toLowerCase();
          const letter = String(wv.DriveLetter).trim().replace(/:$/, '').toUpperCase();
          if (/^[A-Z]$/.test(letter)) volLetterByGuid.set(key, `${letter}:`);
        }
      }

      await scanVssSnapshotsForPrefix('$Recycle.Bin', existingLiveOrVssKeys, out, 5000, {
        isRecycleBin: true,
        preferredSid: currentSid,
        volLetterByGuid,
      });
      const vssCount = out.length - liveCount;

      let ntfsPlan = buildNtfsVolumeScanPlanCjs(volsPs, partsPs);
      if (ntfsPlan.length === 0) {
        const sysLetter = (process.env.SystemDrive || 'C:').replace(/:$/, '').toUpperCase();
        ntfsPlan = buildNtfsVolumeScanPlanCjs(
          [{ DriveLetter: sysLetter, FileSystem: 'NTFS', FileSystemLabel: 'System', Size: 0 }],
          [],
        );
      }

      const scannedVolumes = [];
      const needsAdminVolumes = [];
      const warnings = [];
      const seenEmptiedKeys = new Set();
      let emptiedCount = 0;

      for (const vol of ntfsPlan) {
        if (emptiedCount >= 10000) break;
        const res = await huntDeletedInBackingDrive(
          {
            driveLetter: vol.driveLetter,
            volumeDevicePath: vol.volumeDevicePath,
            devicePath: vol.physicalDevicePath,
            partOffset: vol.partOffset,
            partSize: vol.partSize,
          },
          true,
          Math.max(200, 10000 - emptiedCount),
        );

        if (res.warnings?.length) warnings.push(...res.warnings);
        if (res.status === 'needs-admin') {
          needsAdminVolumes.push(vol.driveLetter);
          continue;
        }
        if (res.status === 'io-error') {
          warnings.push(res.error || `I/O failure while reading ${vol.driveLetter}.`);
          continue;
        }

        scannedVolumes.push(vol.driveLetter);
        const deduped = filterAndTagEmptiedRecycleEntriesCjs(res.entries, {
          driveLetter: vol.driveLetter,
          seenKeys: seenEmptiedKeys,
        });
        for (const item of deduped) {
          const liveKey = `${String(item.originalPath || item.filename).toLowerCase()}|${item.size}`;
          if (existingLiveOrVssKeys.has(liveKey)) continue;
          existingLiveOrVssKeys.add(liveKey);
          out.push(item);
          emptiedCount++;
        }
      }

      let deletedLookupStatus = 'unsupported';
      if (scannedVolumes.length > 0 && needsAdminVolumes.length === 0 && warnings.length === 0) {
        deletedLookupStatus = 'scanned';
      } else if (scannedVolumes.length > 0) {
        deletedLookupStatus = 'partial';
      } else if (needsAdminVolumes.length > 0) {
        deletedLookupStatus = 'needs-admin';
      } else if (warnings.length > 0) {
        deletedLookupStatus = 'io-error';
      }

      return {
        entries: out,
        path:
          scannedVolumes.length > 0
            ? `$Recycle.Bin + NTFS MFT (${scannedVolumes.join(', ')})`
            : 'Windows $Recycle.Bin',
        deletedLookupStatus,
        backingDrive:
          scannedVolumes.length > 0
            ? scannedVolumes.join(', ')
            : needsAdminVolumes.join(', ') || undefined,
        scannedVolumes,
        needsAdminVolumes,
        liveCount,
        vssCount,
        emptiedCount,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    }

    ipcMain.handle('win:scan-folder', async (_event, folderPath) => {
      return await scanLocationAndDeleted(folderPath);
    });

    ipcMain.handle('win:scan-recycle-bin', async () => {
      return await scanAllRecycleBinsAndEmptiedNtfs();
    });

    ipcMain.handle('win:scan-desktop', async () => {
      const desktopPath = app.getPath('desktop');
      return await scanLocationAndDeleted(desktopPath);
    });

    ipcMain.handle('win:pause-drive-scan', async (_event, scanId) => {
      const state = activeScans.get(scanId);
      if (state) {
        state.paused = true;
        if (state.ctrl) {
          Atomics.store(state.ctrl, 0, 1);
          Atomics.notify(state.ctrl, 0);
        }
      }
    });

    ipcMain.handle('win:resume-drive-scan', async (_event, scanId) => {
      const state = activeScans.get(scanId);
      if (state) {
        state.paused = false;
        if (state.ctrl) {
          Atomics.store(state.ctrl, 0, 0);
          Atomics.notify(state.ctrl, 0);
        }
      }
    });

    ipcMain.handle('win:cancel-drive-scan', async (_event, scanId) => {
      const state = activeScans.get(scanId);
      if (state) {
        state.cancelled = true;
        if (state.ctrl) {
          Atomics.store(state.ctrl, 0, 2);
          Atomics.notify(state.ctrl, 0);
        }
      }
    });

    ipcMain.handle(
      'win:start-drive-scan',
      async (
        event,
        {
          scanId,
          devicePath,
          totalBytes,
          blockSize = 512,
          resumeOffset = 0,
          scanMode = 'full',
          startPhase = 'quick',
          unallocatedOnly = false,
          includeExisting = true,
        },
      ) => {
        const ctrlSab = typeof SharedArrayBuffer !== 'undefined' ? new SharedArrayBuffer(4) : null;
        const ctrl = ctrlSab ? new Int32Array(ctrlSab) : null;
        const state = { cancelled: false, paused: false, ctrl };
        activeScans.set(scanId, state);

        const results = [];
        const seenOffsets = new Set();
        const allocatedBitmaps = [];
        const scanWarnings = [];
        let foundBytes = 0;

        const fd = fs.openSync(devicePath, 'r');
        let limitBytes = 0;
        let sectorSize = 512;
        let step = 512;
        let volumes = [];
        try {
          limitBytes = totalBytes > 0 ? totalBytes : fs.fstatSync(fd).size;
          sectorSize = detectSectorSizeSync(fd);
          step = Math.max(sectorSize, Math.floor(blockSize / sectorSize) * sectorSize);
          volumes = detectVolumesFromDisk(fd, limitBytes, sectorSize);

          // Stage 1: Async Yielding Filesystem Metadata Scan
          if (startPhase !== 'deep' && resumeOffset === 0 && !state.cancelled) {
            event.sender.send('win:drive-scan-progress', {
              scanId,
              currentBytes: 0,
              totalBytes: limitBytes,
              percent: 2,
              foundCount: 0,
              foundBytes: 0,
              phase: 'quick',
            });

            const quickBatch = [];
            const ntfsParts = volumes.filter((v) => v.fsType === 'ntfs');
            if (ntfsParts.length > 0) {
              const ntfsQuick = await scanNtfsMftContiguousAsync(
                fd,
                devicePath,
                ntfsParts,
                limitBytes,
                includeExisting,
                DEFAULT_MAX_MFT_RECORDS,
                state,
              );
              if (ntfsQuick.warnings?.length) scanWarnings.push(...ntfsQuick.warnings);
              for (const part of ntfsParts) {
                const bm = ntfsQuick.bitmapByVol.get(part.volStart);
                if (bm && bm.length > 0) {
                  allocatedBitmaps.push({
                    volStart: part.volStart,
                    volEnd: part.volEnd,
                    clusterBytes: part.clusterBytes,
                    bitmap: bm,
                  });
                }
              }
              for (const item of ntfsQuick.entries) {
                results.push(item);
                quickBatch.push(item);
                foundBytes += item.size;
                if (item.offset > 0) seenOffsets.add(item.offset);
              }
            }

            for (const vol of volumes) {
              if (state.cancelled) break;
              while (state.paused && !state.cancelled) {
                await new Promise((r) => setTimeout(r, 80));
              }
              if (state.cancelled) break;

              const fsList =
                vol.fsType === 'fat32'
                  ? scanFat32VolumeFromFd(fd, devicePath, vol, limitBytes, includeExisting)
                  : vol.fsType === 'exfat'
                    ? scanExfatVolumeFromFd(fd, devicePath, vol, limitBytes, includeExisting)
                    : [];
              if (fsList.warnings?.length) scanWarnings.push(...fsList.warnings);
              if (vol.fsType === 'exfat' && vol.allocBitmap && vol.allocBitmap.length > 0) {
                allocatedBitmaps.push({
                  volStart: vol.heapOffset,
                  volEnd: vol.volEnd,
                  clusterBytes: vol.clusterBytes,
                  bitmap: vol.allocBitmap,
                });
              }
              for (const item of fsList) {
                results.push(item);
                quickBatch.push(item);
                foundBytes += item.size;
                if (item.offset > 0) seenOffsets.add(item.offset);
              }
            }

            if (!state.cancelled && getEngineCapabilitiesSync().sleuthkit) {
              const tskSeenKeys = new Set(
                results.map((r) => `${String(r.originalPath || '').toLowerCase()}:${r.size}`),
              );
              const mmlsParts = await runMmlsPartitions(devicePath, sectorSize);
              const knownStarts = new Set(volumes.map((v) => v.volStart));
              const targetOffsets = [];

              for (const mp of mmlsParts) {
                if (!knownStarts.has(mp.startByte) || results.length === 0) {
                  targetOffsets.push({ startByte: mp.startByte, label: mp.description || 'Volume' });
                }
              }
              if (mmlsParts.length === 0 && results.length === 0) {
                targetOffsets.push({ startByte: 0, label: 'Auto' });
              }

              if (targetOffsets.length > 24) {
                scanWarnings.push(`Sleuth Kit scanned first 24 of ${targetOffsets.length} partitions.`);
              }

              for (const target of targetOffsets.slice(0, 24)) {
                if (state.cancelled) break;
                const tskRows = await runTskFlsScan(
                  devicePath,
                  target.startByte,
                  target.label,
                  includeExisting,
                  25000,
                  sectorSize,
                );
                if (tskRows.warnings?.length) scanWarnings.push(...tskRows.warnings);
                for (const row of tskRows) {
                  const key = `${String(row.originalPath || '').toLowerCase()}:${row.size}`;
                  if (tskSeenKeys.has(key)) continue;
                  tskSeenKeys.add(key);
                  const mapped = {
                    id: row.id,
                    filename: row.filename,
                    originalPath: row.originalPath,
                    extensionHint: row.extension,
                    size: row.size,
                    calculatedSize: row.size,
                    modifiedAt: row.modifiedAtMs,
                    sourceKind: 'ntfs-mft',
                    isDeleted: row.isDeleted,
                    scanPhase: 'quick',
                    offset: row.offset,
                    sector: Math.floor((row.offset || 0) / sectorSize),
                    devicePath,
                    tskInode: row.tskInode,
                    tskOffset: row.tskOffset,
                    partitionName: row.partitionName,
                    details: row.details,
                    headerSample: new Uint8Array(0),
                  };
                  results.push(mapped);
                  quickBatch.push(mapped);
                  foundBytes += mapped.size;
                }
              }
            }

            if (quickBatch.length > 0) {
              for (let i = 0; i < quickBatch.length; i += 250) {
                event.sender.send('win:drive-scan-batch', {
                  scanId,
                  entries: quickBatch.slice(i, i + 250),
                });
              }
            }
          } else if (unallocatedOnly && !state.cancelled) {
            // Load NTFS + exFAT allocation bitmaps when deep-only scan starts directly (#6)
            const ntfsParts = volumes.filter((v) => v.fsType === 'ntfs');
            if (ntfsParts.length > 0) {
              const bmRes = loadNtfsBitmapsOnly(fd, ntfsParts, limitBytes);
              if (bmRes.warnings?.length) scanWarnings.push(...bmRes.warnings);
              for (const part of ntfsParts) {
                const bm = bmRes.bitmapByVol.get(part.volStart);
                if (bm && bm.length > 0) {
                  allocatedBitmaps.push({
                    volStart: part.volStart,
                    volEnd: part.volEnd,
                    clusterBytes: part.clusterBytes,
                    bitmap: bm,
                  });
                }
              }
            }
            const exfatParts = volumes.filter((v) => v.fsType === 'exfat');
            if (exfatParts.length > 0) {
              const exBm = readExfatBitmapOnly(fd, exfatParts, limitBytes, sectorSize);
              if (exBm.warnings?.length) scanWarnings.push(...exBm.warnings);
              allocatedBitmaps.push(...exBm.bitmaps);
            }
          }
        } finally {
          fs.closeSync(fd);
        }

        if (scanMode === 'quick' || state.cancelled) {
          event.sender.send('win:drive-scan-progress', {
            scanId,
            currentBytes: limitBytes,
            totalBytes: limitBytes,
            percent: state.cancelled ? Math.min(99, 2) : 100,
            foundCount: results.length,
            foundBytes,
            phase: 'quick',
            incomplete: Boolean(state.cancelled),
            warnings: scanWarnings,
          });
          activeScans.delete(scanId);
          return {
            entries: results,
            warnings: scanWarnings,
            incomplete: Boolean(state.cancelled),
            skippedSectors: 0,
            skippedBytes: 0,
          };
        }

        if (unallocatedOnly && allocatedBitmaps.length === 0) {
          scanWarnings.push('No readable allocation bitmap found for this target; scanning sectors conservatively without skipping unverified clusters.');
        }

        // Stage 2: Parallel Deep Sector Carving
        const cursorStart = Math.max(0, Math.floor(resumeOffset / sectorSize) * sectorSize);
        const remainingBytes = Math.max(0, limitBytes - cursorStart);
        const workerCount =
          remainingBytes >= 4 * 1024 * 1024
            ? Math.min(4, Math.max(1, os.cpus().length - 1))
            : 1;
        const sliceBytes = Math.ceil(remainingBytes / workerCount / sectorSize) * sectorSize;

        let totalBytesRead = cursorStart;
        let latestName;
        const workerErrors = [];
        let skippedSectors = 0;
        let skippedBytes = 0;
        let unverifiedWorkerCoverage = false;

        await new Promise((resolveAll) => {
          let finished = 0;
          if (remainingBytes < sectorSize) {
            resolveAll();
            return;
          }
          for (let w = 0; w < workerCount; w++) {
            const rStart = cursorStart + w * sliceBytes;
            const rEnd = w === workerCount - 1 ? limitBytes : Math.min(limitBytes, rStart + sliceBytes);
            if (rStart >= rEnd) {
              finished++;
              if (finished >= workerCount) resolveAll();
              continue;
            }

            const worker = new Worker(path.join(__dirname, 'scannerWorker.cjs'), {
              workerData: {
                devicePath,
                rangeStart: rStart,
                rangeEnd: rEnd,
                totalLimitBytes: limitBytes,
                step,
                sectorSize,
                workerIndex: w,
                ctrlBuffer: ctrlSab,
                unallocatedOnly: Boolean(unallocatedOnly),
                allocatedBitmaps,
              },
            });

            let settled = false;
            const settleOnce = () => {
              if (settled) return;
              settled = true;
              finished++;
              if (finished >= workerCount) resolveAll();
            };

            worker.on('message', (msg) => {
              if (!msg) return;
              if (msg.type === 'batch' && Array.isArray(msg.entries)) {
                const fresh = [];
                for (const entry of msg.entries) {
                  if (seenOffsets.has(entry.offset)) continue;
                  seenOffsets.add(entry.offset);
                  results.push(entry);
                  fresh.push(entry);
                  foundBytes += entry.size;
                }
                if (fresh.length > 0) {
                  event.sender.send('win:drive-scan-batch', { scanId, entries: fresh });
                }
              } else if (msg.type === 'progress') {
                totalBytesRead = Math.min(limitBytes, totalBytesRead + (msg.deltaBytes || 0));
                if (msg.latestName) latestName = msg.latestName;
                event.sender.send('win:drive-scan-progress', {
                  scanId,
                  currentBytes: totalBytesRead,
                  totalBytes: limitBytes,
                  percent: Math.min(99, Math.round((totalBytesRead / Math.max(1, limitBytes)) * 100)),
                  foundCount: results.length,
                  foundBytes,
                  latestName,
                  phase: 'deep',
                  skippedSectors,
                  skippedBytes,
                });
              } else if (msg.type === 'bad-sectors') {
                skippedSectors += Number(msg.skippedSectors || 0);
                skippedBytes += Number(msg.skippedBytes || 0);
              } else if (msg.type === 'error') {
                workerErrors.push(msg.error || `Worker ${w} failed during sector carving.`);
              } else if (msg.type === 'done') {
                if (msg.unverifiedCoverage) unverifiedWorkerCoverage = true;
              }
            });

            worker.on('error', (err) => {
              workerErrors.push(err?.message || `Worker ${w} crashed.`);
              settleOnce();
            });
            worker.on('exit', (code) => {
              if (code !== 0 && !state.cancelled) {
                workerErrors.push(`Scanner worker ${w} exited with code ${code}.`);
              }
              settleOnce();
            });
          }
        });

        if (skippedSectors > 0) {
          scanWarnings.push(
            `Skipped ${skippedSectors} unreadable sector(s) (${Math.round(skippedBytes / 1024)} KiB zero-filled in reads) during deep scan.`,
          );
        }
        if (workerErrors.length > 0) {
          scanWarnings.push(...workerErrors);
        }
        if (unverifiedWorkerCoverage) {
          scanWarnings.push('Unallocated filter ran without full cluster-bitmap verification on part of the disk.');
        }

        // Stage 2B: Non-contiguous / interleaved video frame reassembly across unallocated clusters
        if (!state.cancelled && results.length > 0) {
          const stitched = stitchFragmentedVideosFromFdCjs(
            devicePath,
            results,
            limitBytes,
            Math.max(step, 4096),
          );
          if (stitched.length > 0) {
            foundBytes = results.reduce((s, r) => s + (r.size || 0), 0);
            event.sender.send('win:drive-scan-batch', { scanId, entries: stitched });
          }
        }

        const incomplete = Boolean(state.cancelled || workerErrors.length > 0);
        const finalPercent = incomplete
          ? Math.min(99, Math.round((totalBytesRead / Math.max(1, limitBytes)) * 100))
          : 100;

        event.sender.send('win:drive-scan-progress', {
          scanId,
          currentBytes: incomplete ? totalBytesRead : limitBytes,
          totalBytes: limitBytes,
          percent: finalPercent,
          foundCount: results.length,
          foundBytes,
          phase: 'deep',
          incomplete,
          skippedSectors,
          skippedBytes,
          warnings: scanWarnings,
        });

        activeScans.delete(scanId);
        return {
          entries: results,
          warnings: scanWarnings,
          incomplete,
          skippedSectors,
          skippedBytes,
        };
      },
    );

    ipcMain.handle('win:recover-files', async (_event, params = {}) => {
      const {
        destinationDir,
        items = [],
        scannedDevicePath,
        keepOriginalOnRepair = true,
        allowUnverifiedDestination = false,
      } = params;
      let targetRoot = destinationDir;
      if (!targetRoot) {
        const pick = await dialog.showOpenDialog({
          title: 'Choose Destination Folder for Recovered Files (Use a Different Drive)',
          properties: ['openDirectory', 'createDirectory'],
        });
        if (pick.canceled || pick.filePaths.length === 0) {
          return { canceled: true, savedCount: 0, verifiedCount: 0, destinationDir: '', repairedCount: 0 };
        }
        targetRoot = pick.filePaths[0];
      }

      // Multi-source self-overwrite pre-flight guard (checks scannedDevicePath + EVERY item source!)
      const allSourcePaths = [scannedDevicePath, ...items.map((i) => i.devicePath)].filter(Boolean);
      const guard = await checkSameSourcePaths({
        targetPath: targetRoot,
        sourcePaths: allSourcePaths,
        allowUnverifiedDestination: Boolean(allowUnverifiedDestination),
      });
      if (guard.blocked) {
        return {
          canceled: false,
          savedCount: 0,
          verifiedCount: 0,
          destinationDir: targetRoot,
          repairedCount: 0,
          unverifiedDestination: Boolean(guard.unverified),
          error: guard.reason,
        };
      }

      return await recoverFilesImpl({
        targetRoot,
        items,
        keepOriginalOnRepair: Boolean(keepOriginalOnRepair),
      });
    });

    ipcMain.handle('win:save-text-report', async (_event, params = {}) => {
      const { defaultName, title, filters, content, scannedDevicePath, allowUnverifiedDestination } = params;
      const res = await dialog.showSaveDialog({
        title: title || 'Save Forensic Report',
        defaultPath: defaultName,
        filters: filters || [{ name: 'All Files', extensions: ['*'] }],
      });
      if (res.canceled || !res.filePath) return { canceled: true };
      const guard = await checkSameSourcePaths({
        targetPath: res.filePath,
        sourcePaths: scannedDevicePath ? [scannedDevicePath] : [],
        allowUnverifiedDestination: Boolean(allowUnverifiedDestination),
      });
      if (guard.blocked) {
        return { canceled: false, error: guard.reason, unverifiedDestination: Boolean(guard.unverified) };
      }
      fs.writeFileSync(res.filePath, content, 'utf8');
      return { canceled: false, filePath: res.filePath };
    });

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

async function recoverFilesImpl({ targetRoot, items, keepOriginalOnRepair = true }) {
  const totalRequested = items.reduce((s, i) => s + (i.size || 0), 0);
  if (typeof fs.statfsSync === 'function') {
    try {
      const stats = fs.statfsSync(targetRoot);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      if (freeBytes > 0 && freeBytes < totalRequested) {
        return {
          canceled: false,
          savedCount: 0,
          verifiedCount: 0,
          destinationDir: targetRoot,
          repairedCount: 0,
          error: `Insufficient free space on destination drive (${Math.round(freeBytes / (1024 * 1024))} MiB free).`,
        };
      }
    } catch {
      // ignore if statfs unsupported on virtual target
    }
  }

  const copyBuf = Buffer.allocUnsafe(4 * 1024 * 1024);
  const zeroBuf = Buffer.alloc(1024 * 1024);
  let savedCount = 0;
  let verifiedCount = 0;
  let repairedCount = 0;
  let originalKeptCount = 0;
  const failures = [];
  const reportLines = [];
  const createdDirs = new Set();
  const resolvedRoot = path.resolve(targetRoot);

  const resolveUniqueDestPath = (dir, rawFilename) => {
    let candidate = path.join(dir, rawFilename);
    if (!fs.existsSync(candidate)) return candidate;
    const ext = path.extname(rawFilename);
    const stem = ext ? rawFilename.slice(0, -ext.length) : rawFilename;
    let idx = 2;
    while (fs.existsSync(candidate) && idx < 10000) {
      candidate = path.join(dir, `${stem}_${idx}${ext}`);
      idx++;
    }
    return candidate;
  };

  const applyValidMtime = (targetPath, modifiedAtMs) => {
    if (typeof modifiedAtMs === 'number' && Number.isFinite(modifiedAtMs) && modifiedAtMs > 0) {
      const dt = new Date(modifiedAtMs);
      try {
        fs.utimesSync(targetPath, dt, dt);
      } catch {
        // ignore timestamp error
      }
    }
  };

  const backupUntouchedBeforeRepair = (partialPath, destDir, correctedName) => {
    if (!keepOriginalOnRepair || !fs.existsSync(partialPath)) return null;
    const ext = path.extname(correctedName);
    const stem = ext ? correctedName.slice(0, -ext.length) : correctedName;
    const origDest = resolveUniqueDestPath(destDir, `${stem}_original${ext}`);
    fs.copyFileSync(partialPath, origDest);
    return origDest;
  };

  for (const item of items) {
    const folderSegs = String(item.folder || 'Recovered')
      .split(/[\\/]/)
      .map((seg) => seg.trim())
      .filter((seg) => seg && seg !== '.' && seg !== '..')
      .map(sanitizeWinFilename);
    const safeFolder = folderSegs.length > 0 ? folderSegs.join(path.sep) : 'Recovered';
    const destDir = path.resolve(resolvedRoot, safeFolder);
    if (destDir !== resolvedRoot && !destDir.startsWith(resolvedRoot + path.sep)) {
      failures.push({ filename: item.filename, reason: 'Blocked invalid destination folder path.' });
      continue;
    }
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
      createdDirs.add(destDir);
    }

    const rawCleanName = sanitizeWinFilename(item.filename);
    let correctedName = resolvePreferredFilenameCjs(rawCleanName, item.extension);
    let destPath = resolveUniqueDestPath(destDir, correctedName);
    if (!path.resolve(destPath).startsWith(destDir + path.sep)) {
      failures.push({ filename: item.filename, reason: 'Blocked invalid destination filename.' });
      continue;
    }

    if (item.devicePath && path.resolve(item.devicePath).toLowerCase() === path.resolve(destPath).toLowerCase()) {
      failures.push({ filename: item.filename, reason: 'Skipped to prevent overwriting active source file.' });
      continue;
    }

    const partialPath = `${destPath}.partial`;

    if (item.sourceKind === 'memory' && item.memoryBytes) {
      try {
        const memBuf = Buffer.from(item.memoryBytes);
        if (memBuf.length === 0) {
          failures.push({ filename: item.filename, reason: 'Empty memory payload (0 bytes).' });
          continue;
        }
        const magicExt = detectMagicExtFromHeadCjs(memBuf);
        if (magicExt) {
          correctedName = resolvePreferredFilenameCjs(correctedName, magicExt);
          destPath = resolveUniqueDestPath(destDir, correctedName);
        }
        let crcStatus = 'SIZE_OK_NO_CRC';
        if (item.discoveryCrc32) {
          const liveCrc = computeCrc32Cjs(memBuf, 65536);
          if (liveCrc !== item.discoveryCrc32) {
            failures.push({
              filename: correctedName,
              reason: `Discovery 64 KiB header CRC-32 mismatch (expected ${item.discoveryCrc32.toString(16).padStart(8, '0')}, got ${liveCrc.toString(16).padStart(8, '0')}).`,
            });
            reportLines.push(`FAIL_CRC\t${memBuf.length}\tMISMATCH\t${correctedName}\t-`);
            continue;
          }
          verifiedCount++;
          crcStatus = `HEAD64K_CRC_MATCH:${liveCrc.toString(16).padStart(8, '0')}`;
        }
        fs.writeFileSync(partialPath, memBuf);
        applyValidMtime(partialPath, item.modifiedAtMs);
        fs.renameSync(partialPath, destPath);
        savedCount++;
        reportLines.push(`OK\t${memBuf.length}\t${crcStatus}\t${correctedName}\t${destPath}`);
      } catch (err) {
        try { if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath); } catch { /* ignore */ }
        failures.push({ filename: item.filename, reason: err?.message || 'Memory write failed' });
      }
      continue;
    }

    if (!item.devicePath) {
      failures.push({ filename: item.filename, reason: 'Missing source device path.' });
      continue;
    }

    if (item.sourceKind === 'native-tsk' && item.tskInode) {
      try {
        const expectedSize = Number.isFinite(Number(item.size)) ? Math.max(0, Math.floor(Number(item.size))) : 0;
        const tskRes = await extractTskInodeToFile(
          item.devicePath,
          item.tskOffset || 0,
          item.tskInode,
          partialPath,
          expectedSize,
        );
        if (!tskRes.ok || tskRes.bytesWritten <= 0) {
          try {
            if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
          } catch {
            // ignore cleanup
          }
          failures.push({ filename: item.filename, reason: tskRes.error || 'Sleuth Kit icat returned 0 bytes' });
          continue;
        }
        let crcStatus = 'SIZE_OK_NO_CRC';
        const headFd = fs.openSync(partialPath, 'r');
        try {
          const headBuf = Buffer.allocUnsafe(Math.min(65536, tskRes.bytesWritten));
          const hRead = fs.readSync(headFd, headBuf, 0, headBuf.length, 0);
          const headSlice = headBuf.subarray(0, hRead);
          if (item.discoveryCrc32) {
            const liveCrc = computeCrc32Cjs(headSlice, 65536);
            if (liveCrc !== item.discoveryCrc32) {
              try { if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath); } catch { /* ignore */ }
              failures.push({
                filename: correctedName,
                reason: 'Discovery 64 KiB header CRC-32 mismatch during Sleuth Kit extraction.',
              });
              continue;
            }
            verifiedCount++;
            crcStatus = `HEAD64K_CRC_MATCH:${liveCrc.toString(16).padStart(8, '0')}`;
          }
          const magicExt = detectMagicExtFromHeadCjs(headSlice);
          if (magicExt) {
            correctedName = resolvePreferredFilenameCjs(correctedName, magicExt);
            destPath = resolveUniqueDestPath(destDir, correctedName);
          }
        } finally {
          fs.closeSync(headFd);
        }
        applyValidMtime(partialPath, item.modifiedAtMs);
        fs.renameSync(partialPath, destPath);
        savedCount++;
        reportLines.push(`OK(TSK)\t${tskRes.bytesWritten}\t${crcStatus};INODE:${item.tskInode}\t${correctedName}\t${destPath}`);
      } catch (err) {
        try { if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath); } catch { /* ignore */ }
        failures.push({ filename: item.filename, reason: err?.message || 'TSK extraction failed' });
      }
      continue;
    }

    let srcFd;
    let dstFd;
    let committed = false;
    let pendingOrigBackup = null;
    try {
      srcFd = fs.openSync(item.devicePath, 'r');
      dstFd = fs.openSync(partialPath, 'w');
      const sectorSize = detectSectorSizeSync(srcFd);
      const headChunks = [];
      let totalWritten = 0;
      let badSectors = 0;
      const expectedTotal =
        Array.isArray(item.runs) && item.runs.length > 0
          ? item.runs.reduce(
              (s, r) => s + (Number.isFinite(Number(r?.length)) ? Math.max(0, Math.floor(Number(r.length))) : 0),
              0,
            )
          : Number.isFinite(Number(item.size))
            ? Math.max(0, Math.floor(Number(item.size)))
            : 0;

      if (Array.isArray(item.runs) && item.runs.length > 0) {
        for (const run of item.runs) {
          const r = streamExtentToFdSync(srcFd, dstFd, run.offset, run.length, sectorSize, copyBuf, zeroBuf, headChunks);
          totalWritten += r.bytesWritten;
          badSectors += r.skippedSectors;
        }
      } else {
        const r = streamExtentToFdSync(
          srcFd,
          dstFd,
          item.offset || 0,
          expectedTotal,
          sectorSize,
          copyBuf,
          zeroBuf,
          headChunks,
        );
        totalWritten += r.bytesWritten;
        badSectors += r.skippedSectors;
      }

      if (totalWritten === 0 || (expectedTotal > 0 && totalWritten < expectedTotal)) {
        const shortMsg =
          totalWritten === 0
            ? `Export produced 0 bytes (expected ${expectedTotal} B).`
            : `Short read: exported ${totalWritten} of ${expectedTotal} expected bytes.`;
        failures.push({ filename: correctedName, reason: shortMsg });
        reportLines.push(`FAIL_SHORT\t${totalWritten}\tEXPECTED:${expectedTotal}\t${correctedName}\t-`);
        continue;
      }

      const headMerged = headChunks.length > 0 ? Buffer.concat(headChunks) : Buffer.alloc(0);
      const magicExt = detectMagicExtFromHeadCjs(headMerged);
      if (magicExt) {
        const nextName = resolvePreferredFilenameCjs(correctedName, magicExt);
        if (nextName !== correctedName) {
          correctedName = nextName;
          destPath = resolveUniqueDestPath(destDir, correctedName);
        }
      }

      // Enforce 64 KiB Discovery Header CRC check strictly before committing output (#17)
      let crcStatus = 'SIZE_OK_NO_CRC';
      if (item.discoveryCrc32) {
        if (headMerged.length === 0) {
          failures.push({ filename: correctedName, reason: 'Could not read header bytes for Discovery CRC-32 check.' });
          continue;
        }
        const liveCrc = computeCrc32Cjs(headMerged, 65536);
        if (liveCrc !== item.discoveryCrc32) {
          crcStatus = `MISMATCH:${liveCrc.toString(16).padStart(8, '0')}`;
          failures.push({
            filename: correctedName,
            reason: `Discovery 64 KiB header CRC-32 mismatch (expected ${item.discoveryCrc32.toString(16).padStart(8, '0')}, got ${liveCrc.toString(16).padStart(8, '0')}).`,
          });
          reportLines.push(`FAIL_CRC\t${totalWritten}\t${crcStatus}\t${correctedName}\t-`);
          continue;
        }
        verifiedCount++;
        crcStatus = `HEAD64K_CRC_MATCH:${liveCrc.toString(16).padStart(8, '0')}`;
      }

      if (badSectors > 0) {
        failures.push({
          filename: correctedName,
          reason: `${badSectors} unreadable sector(s) zero-filled inside exported file.`,
        });
      }

      fs.closeSync(dstFd);
      dstFd = undefined;

      let didRepair = false;
      const effectiveExt = path.extname(correctedName).replace(/^\./, '').toLowerCase() || String(item.extension || '').toLowerCase();
      if (item.repairIfTruncated && (effectiveExt === 'jpg' || effectiveExt === 'jpeg')) {
        if (fs.statSync(partialPath).size <= 64 * 1024 * 1024) {
          const jRes = repairJpegBufferCjs(fs.readFileSync(partialPath));
          if (jRes && jRes.data) {
            pendingOrigBackup = backupUntouchedBeforeRepair(partialPath, destDir, correctedName);
            fs.writeFileSync(partialPath, jRes.data);
            didRepair = true;
          }
        }
      } else if (item.repairIfTruncated && effectiveExt === 'png' && fs.statSync(partialPath).size <= 64 * 1024 * 1024) {
        const pRes = repairPngBufferCjs(fs.readFileSync(partialPath));
        if (pRes && pRes.data) {
          pendingOrigBackup = backupUntouchedBeforeRepair(partialPath, destDir, correctedName);
          fs.writeFileSync(partialPath, pRes.data);
          didRepair = true;
        }
      } else if (
        item.repairIfTruncated &&
        ['mp4', 'mov', 'm4v', '3gp', 'mkv', 'avi'].includes(effectiveExt)
      ) {
        if (['mp4', 'mov', 'm4v', '3gp'].includes(effectiveExt)) {
          const streamTmp = `${partialPath}.moov.${effectiveExt}`;
          const sRes = repairMp4StreamingFileCjs(partialPath, streamTmp);
          if (sRes && sRes.ok && fs.existsSync(streamTmp)) {
            pendingOrigBackup = backupUntouchedBeforeRepair(partialPath, destDir, correctedName);
            try { fs.unlinkSync(partialPath); } catch { /* ignore */ }
            fs.renameSync(streamTmp, partialPath);
            didRepair = true;
          } else if (fs.existsSync(streamTmp)) {
            try { fs.unlinkSync(streamTmp); } catch { /* ignore */ }
          }
        } else if (effectiveExt === 'avi' && fs.statSync(partialPath).size <= 192 * 1024 * 1024) {
          const aRes = repairAviBufferCjs(fs.readFileSync(partialPath));
          if (aRes && aRes.data) {
            pendingOrigBackup = backupUntouchedBeforeRepair(partialPath, destDir, correctedName);
            fs.writeFileSync(partialPath, aRes.data);
            didRepair = true;
          }
        }
        if (!didRepair && getEngineCapabilitiesSync().ffmpeg) {
          const remuxTmp = `${partialPath}.remux.${effectiveExt}`;
          const ffRes = await ffmpegRepairVideoFile(partialPath, remuxTmp, {
            extension: effectiveExt,
            allowTranscode: true,
          });
          if (ffRes && ffRes.ok && fs.existsSync(remuxTmp)) {
            pendingOrigBackup = backupUntouchedBeforeRepair(partialPath, destDir, correctedName);
            try { fs.unlinkSync(partialPath); } catch { /* ignore */ }
            fs.renameSync(remuxTmp, partialPath);
            didRepair = true;
          } else if (fs.existsSync(remuxTmp)) {
            try { fs.unlinkSync(remuxTmp); } catch { /* ignore */ }
          }
        }
      } else if (
        item.repairIfTruncated &&
        NON_MEDIA_REPAIR_EXTS_CJS.has(effectiveExt) &&
        fs.statSync(partialPath).size <= 128 * 1024 * 1024
      ) {
        const docRes = repairNonMediaBufferCjs(effectiveExt, fs.readFileSync(partialPath));
        if (docRes && docRes.data) {
          pendingOrigBackup = backupUntouchedBeforeRepair(partialPath, destDir, correctedName);
          fs.writeFileSync(partialPath, docRes.data);
          didRepair = true;
        }
      }

      if (didRepair) {
        repairedCount++;
        if (pendingOrigBackup) {
          applyValidMtime(pendingOrigBackup, item.modifiedAtMs);
          originalKeptCount++;
        }
      }

      applyValidMtime(partialPath, item.modifiedAtMs);
      fs.renameSync(partialPath, destPath);
      committed = true;
      savedCount++;
      const finalSize = fs.statSync(destPath).size;
      reportLines.push(
        `OK\t${finalSize}\t${crcStatus}${didRepair ? ';REPAIRED' : ''}\t${correctedName}\t${destPath}`,
      );
    } catch (err) {
      if (pendingOrigBackup) {
        try { if (fs.existsSync(pendingOrigBackup)) fs.unlinkSync(pendingOrigBackup); } catch { /* ignore */ }
      }
      failures.push({ filename: item.filename, reason: err?.message || 'Read/write failure' });
    } finally {
      if (srcFd !== undefined) {
        try { fs.closeSync(srcFd); } catch { /* ignore */ }
      }
      if (!committed) {
        if (dstFd !== undefined) {
          try { fs.closeSync(dstFd); } catch { /* ignore */ }
        }
        try {
          if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
        } catch {
          // ignore cleanup failure
        }
      }
    }
  }

  let reportPath;
  if (savedCount > 0 || failures.length > 0) {
    reportPath = path.join(targetRoot, 'Recovery-Audit-Report.txt');
    const header = [
      'Disk & Partition Recovery Explorer — Audit Report',
      `Generated: ${new Date().toISOString()}`,
      `Destination: ${targetRoot}`,
      `Saved: ${savedCount} | 64 KiB Header CRC-Verified: ${verifiedCount} | Repaired: ${repairedCount}${originalKeptCount > 0 ? ` (Originals Kept: ${originalKeptCount})` : ''} | Warnings/Failures: ${failures.length}`,
      '',
      'STATUS\tSIZE_BYTES\t64K_HEAD_CRC_VERIFICATION\tFILENAME\tSAVED_PATH',
      ...reportLines,
    ];
    if (failures.length > 0) {
      header.push('', 'WARNINGS / FAILURES:');
      for (const f of failures) header.push(`- ${f.filename}: ${f.reason}`);
    }
    try {
      fs.writeFileSync(reportPath, header.join(os.EOL), 'utf8');
    } catch {
      reportPath = undefined;
    }
  } else {
    const sortedDirs = [...createdDirs].sort((a, b) => b.length - a.length);
    for (const dir of sortedDirs) {
      try {
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
          fs.rmdirSync(dir);
        }
      } catch {
        // ignore cleanup errors
      }
    }
  }

  return {
    canceled: false,
    savedCount,
    verifiedCount,
    destinationDir: targetRoot,
    repairedCount,
    originalKeptCount,
    reportPath,
    failures,
  };
}

module.exports = {
  detectVolumesFromDisk,
  scanLostPartitionsFromFd,
  scanFat32VolumeFromFd,
  scanExfatVolumeFromFd,
  scanNtfsMftContiguous,
  scanNtfsMftContiguousAsync,
  parseMftRecordBuffer,
  applyMftUsaFixup,
  readNtfsBootAndMftLayout,
  resolveMftRecordByteOffset,
  parseAttrListBytes,
  loadNtfsBitmapsOnly,
  readExfatBitmapOnly,
  huntDeletedInBackingDrive,
  scanVssSnapshotsForPrefix,
  walkFolderEntries,
  parseRecycleIFileBuffer,
  buildBitLockerUnlockSpec,
  checkSameSourcePaths,
  readDiskBytesFromFdSync,
  streamExtentToFdSync,
  recoverFilesImpl,
  DEFAULT_MAX_MFT_RECORDS,
  NTFS_BITMAP_MAX_BYTES,
};
