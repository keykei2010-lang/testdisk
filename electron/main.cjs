const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
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
  const deletedAtMs = ticks > 0 ? Math.floor(ticks / 10000 - WINDOWS_EPOCH_DIFF_MS) : Date.now();

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
          : full;
        outList.push({
          id: `${isRecycledChild ? 'recycle' : 'folder'}-${full}`,
          filename: entry.name,
          originalPath: origPath,
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
function detectVolumesFromDisk(fd, limitBytes) {
  const volumes = [];
  const seenStarts = new Set();

  const inspectBoot = (startByte, totalBytesFromTable) => {
    if (seenStarts.has(startByte) || startByte + 512 > limitBytes) return;
    const boot = Buffer.allocUnsafe(512);
    if (fs.readSync(fd, boot, 0, 512, startByte) < 512) return;
    if (boot[510] !== 0x55 || boot[511] !== 0xaa) return;

    const oem = boot.toString('ascii', 3, 11);
    if (oem === '-FVE-FS-') {
      seenStarts.add(startByte);
      volumes.push({
        fsType: 'bitlocker',
        volStart: startByte,
        volEnd: Math.min(limitBytes, startByte + totalBytesFromTable),
        clusterBytes: 4096,
      });
      return;
    }

    if (oem === 'NTFS    ') {
      const bps = boot.readUInt16LE(11) || 512;
      const spc = boot[13] || 8;
      seenStarts.add(startByte);
      volumes.push({
        fsType: 'ntfs',
        volStart: startByte,
        volEnd: Math.min(limitBytes, startByte + totalBytesFromTable),
        clusterBytes: Math.max(512, bps * spc),
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
        bootBuf: boot,
      });
    }
  };

  try {
    // Also detect partitionless logical volume handles (e.g. \\.\C:, \\.\D:, or raw partition .img)
    inspectBoot(0, limitBytes);

    const mbr = Buffer.allocUnsafe(512);
    if (fs.readSync(fd, mbr, 0, 512, 0) === 512 && mbr[510] === 0x55 && mbr[511] === 0xaa) {
      let hasGptPmbr = false;
      for (let i = 0; i < 4; i++) {
        const off = 0x1be + i * 16;
        const sysInd = mbr[off + 4];
        const startLba = mbr.readUInt32LE(off + 8);
        const secCount = mbr.readUInt32LE(off + 12);
        if (sysInd === 0xee) hasGptPmbr = true;
        if (sysInd !== 0 && sysInd !== 0xee && startLba > 0 && secCount > 0) {
          inspectBoot(startLba * 512, secCount * 512);
        }
      }

      if (hasGptPmbr && limitBytes >= 1024) {
        const gptHdr = Buffer.allocUnsafe(512);
        if (fs.readSync(fd, gptHdr, 0, 512, 512) === 512 && gptHdr.toString('ascii', 0, 8) === 'EFI PART') {
          const partLbaLo = gptHdr.readUInt32LE(72);
          const partLbaHi = gptHdr.readUInt32LE(76);
          const numEntries = Math.min(128, gptHdr.readUInt32LE(80));
          const entrySize = gptHdr.readUInt32LE(84) || 128;
          const tableOff = (partLbaHi * 4294967296 + partLbaLo) * 512;
          const tableBytes = numEntries * entrySize;
          if (tableOff + tableBytes <= limitBytes) {
            const tbl = Buffer.allocUnsafe(tableBytes);
            if (fs.readSync(fd, tbl, 0, tableBytes, tableOff) === tableBytes) {
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
                  inspectBoot(sLba * 512, (eLba - sLba + 1) * 512);
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

function dosDateTimeToMs(dateVal, timeVal) {
  if (!dateVal) return Date.now();
  const year = 1980 + ((dateVal >> 9) & 0x7f);
  const month = Math.max(1, (dateVal >> 5) & 0x0f);
  const day = Math.max(1, dateVal & 0x1f);
  const hour = (timeVal >> 11) & 0x1f;
  const min = (timeVal >> 5) & 0x3f;
  const sec = (timeVal & 0x1f) * 2;
  const ms = Date.UTC(year, month - 1, day, hour, min, sec);
  return Number.isFinite(ms) ? ms : Date.now();
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

// Stream FAT32 directory clusters via fs.readSync to recover deleted + existing LFN files
function scanFat32VolumeFromFd(fd, devicePath, vol, limitBytes, includeExisting = false) {
  const out = [];
  const boot = vol.bootBuf;
  if (!boot) return out;

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

  const readFat = (cluster) => {
    const off = fatStart + cluster * 4;
    if (off + 4 > limitBytes) return 0;
    const b = Buffer.allocUnsafe(4);
    if (fs.readSync(fd, b, 0, 4, off) < 4) return 0;
    return b.readUInt32LE(0) & 0x0fffffff;
  };

  const clusterBuf = Buffer.allocUnsafe(clusterBytes);
  const visited = new Set();
  const queue = [{ cluster: rootCluster, prefix: '', depth: 0, parentDeleted: false }];

  while (queue.length > 0 && visited.size < 2048 && out.length < 3000) {
    const { cluster: startCluster, prefix, depth, parentDeleted } = queue.shift();
    let cur = startCluster;
    let chain = 0;

    while (cur >= 2 && cur < 0x0ffffff0 && !visited.has(cur) && chain < 128) {
      visited.add(cur);
      const offByte = dataStart + (cur - 2) * clusterBytes;
      if (offByte < 0 || offByte + clusterBytes > limitBytes) break;
      const nRead = fs.readSync(fd, clusterBuf, 0, clusterBytes, offByte);
      if (nRead < 32) break;

      let lfnParts = [];
      let eod = false;
      for (let off = 0; off + 32 <= nRead; off += 32) {
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
          if (firstCluster >= 2 && depth < 8 && !visited.has(firstCluster)) {
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
        const hRead = fs.readSync(fd, hBuf, 0, sLen, extents[0].offset);

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
          sector: Math.floor(extents[0].offset / 512),
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
  return out;
}

// Stream exFAT directory clusters via fs.readSync to recover deleted 0x05 + existing 0x85 entries
function scanExfatVolumeFromFd(fd, devicePath, vol, limitBytes, includeExisting = false) {
  const out = [];
  const boot = vol.bootBuf;
  if (!boot) return out;

  const bps = 1 << Math.min(12, Math.max(9, boot[108] || 9));
  const spc = 1 << Math.min(25, boot[109] || 3);
  const clusterBytes = bps * spc;
  const fatStart = vol.volStart + boot.readUInt32LE(80) * bps;
  const heapStart = vol.volStart + boot.readUInt32LE(88) * bps;
  const rootCluster = boot.readUInt32LE(96) || 4;

  const readFat = (cluster) => {
    const off = fatStart + cluster * 4;
    if (off + 4 > limitBytes) return 0;
    const b = Buffer.allocUnsafe(4);
    if (fs.readSync(fd, b, 0, 4, off) < 4) return 0;
    return b.readUInt32LE(0);
  };

  let bitmap = null;
  const rootOff = heapStart + (rootCluster - 2) * clusterBytes;
  if (rootCluster >= 2 && rootOff + clusterBytes <= limitBytes) {
    const rBuf = Buffer.allocUnsafe(clusterBytes);
    fs.readSync(fd, rBuf, 0, clusterBytes, rootOff);
    for (let off = 0; off + 32 <= clusterBytes; off += 32) {
      if (rBuf[off] === 0x81) {
        const bmCluster = rBuf.readUInt32LE(off + 20);
        const bmLen = Math.min(rBuf.readUInt32LE(off + 24), 4 * 1024 * 1024);
        const bmOff = heapStart + (bmCluster - 2) * clusterBytes;
        if (bmCluster >= 2 && bmOff + bmLen <= limitBytes) {
          bitmap = Buffer.allocUnsafe(bmLen);
          fs.readSync(fd, bitmap, 0, bmLen, bmOff);
        }
        break;
      }
    }
  }

  const isAllocated = (c) => {
    if (!bitmap || c < 2) return false;
    const idx = c - 2;
    const bIdx = idx >>> 3;
    return bIdx < bitmap.length && (bitmap[bIdx] & (1 << (idx & 7))) !== 0;
  };

  const cBuf = Buffer.allocUnsafe(clusterBytes);
  const visited = new Set();
  const queue = [{ cluster: rootCluster, prefix: '', depth: 0, parentDeleted: false }];

  while (queue.length > 0 && visited.size < 2048 && out.length < 3000) {
    const { cluster: startCluster, prefix, depth, parentDeleted } = queue.shift();
    let cur = startCluster;
    let chain = 0;

    while (cur >= 2 && cur < 0xfffffff0 && !visited.has(cur) && chain < 128) {
      visited.add(cur);
      const offByte = heapStart + (cur - 2) * clusterBytes;
      if (offByte < 0 || offByte + clusterBytes > limitBytes) break;
      const nRead = fs.readSync(fd, cBuf, 0, clusterBytes, offByte);

      for (let off = 0; off + 32 <= nRead; ) {
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
          if (firstCluster >= 2 && depth < 8 && !visited.has(firstCluster)) {
            queue.push({ cluster: firstCluster, prefix: fullPath, depth: depth + 1, parentDeleted: isDeleted });
          }
          continue;
        }
        if ((!isDeleted && !includeExisting) || dataLength === 0 || firstCluster < 2) continue;

        const needed = Math.max(1, Math.ceil(dataLength / clusterBytes));
        const extents = [];
        let overwritten = false;
        let rem = dataLength;

        if (noFatChain || readFat(firstCluster) === 0) {
          for (let ci = 0; ci < needed && rem > 0 && extents.length < 4096; ci++) {
            const c = firstCluster + ci;
            if (bitmap && isAllocated(c)) overwritten = true;
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
            if (bitmap && isAllocated(c)) overwritten = true;
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
        const hRead = fs.readSync(fd, hBuf, 0, sLen, extents[0].offset);

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
          sector: Math.floor(extents[0].offset / 512),
          devicePath,
          runs: extents,
          mftResident: false,
          mftOverwritten: isDeleted ? overwritten : false,
          mftBitmapIntact: isDeleted ? (bitmap !== null && !overwritten) : true,
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
          const modifiedAt = ticks > 0 ? Math.floor(ticks / 10000 - WINDOWS_EPOCH_DIFF_MS) : Date.now();
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

function parseMftRecordBuffer(work, absOffset, ntfsParts, fd, limitBytes, dirMap, bitmapByVol, includeExisting = false) {
  if (!work || work.length < 1024) return null;
  if (work[0] !== 0x46 || work[1] !== 0x49 || work[2] !== 0x4c || work[3] !== 0x45) return null;
  const rec = Buffer.from(work.subarray(0, 1024));
  const usaOffset = rec.readUInt16LE(4);
  const usaCount = rec.readUInt16LE(6);
  const firstAttrOffset = rec.readUInt16LE(20);
  const flags = rec.readUInt16LE(22);
  const usedBytes = rec.readUInt32LE(24);
  const recordNumber = rec.readUInt32LE(44);

  if (
    usaOffset < 42 ||
    usaCount < 2 ||
    usaOffset + usaCount * 2 > 1024 ||
    firstAttrOffset < 42 ||
    usedBytes < firstAttrOffset ||
    usedBytes > 1024
  ) {
    return null;
  }

  const usn = rec.readUInt16LE(usaOffset);
  for (let s = 1; s < usaCount && s * 512 <= 1024; s++) {
    const sectorEnd = s * 512 - 2;
    if (rec.readUInt16LE(sectorEnd) !== usn) return null;
    rec[sectorEnd] = rec[usaOffset + s * 2];
    rec[sectorEnd + 1] = rec[usaOffset + s * 2 + 1];
  }

  const inUse = (flags & 0x0001) !== 0;
  const isDirectory = (flags & 0x0002) !== 0;

  let pos = firstAttrOffset;
  let filename = '';
  let nameScore = -1;
  let parentRecord = 5;
  let modifiedAt = Date.now();
  let fileSize = 0;
  let residentPayload = null;
  let rawRuns = [];
  let usnRuns = [];
  let usnSize = 0;

  while (pos + 16 <= usedBytes) {
    const attrType = rec.readUInt32LE(pos);
    if (attrType === 0xffffffff) break;
    const attrLen = rec.readUInt32LE(pos + 4);
    if (attrLen < 16 || pos + attrLen > usedBytes) break;
    const form = rec[pos + 8];
    const nameLen = rec[pos + 9];
    const nameOff = rec.readUInt16LE(pos + 10);
    const attrName =
      nameLen > 0 && pos + nameOff + nameLen * 2 <= pos + attrLen
        ? rec.toString('utf16le', pos + nameOff, pos + nameOff + nameLen * 2)
        : '';

    if (attrType === 0x10 && form === 0 && pos + 24 <= usedBytes) {
      const vo = rec.readUInt16LE(pos + 20);
      const vl = rec.readUInt32LE(pos + 16);
      if (vl >= 32 && pos + vo + 32 <= pos + attrLen) {
        const lo = rec.readUInt32LE(pos + vo + 8);
        const hi = rec.readUInt32LE(pos + vo + 12);
        const ticks = hi * 4294967296 + lo;
        if (ticks > 0) modifiedAt = Math.floor(ticks / 10000 - WINDOWS_EPOCH_DIFF_MS);
      }
    } else if (attrType === 0x30 && form === 0 && pos + 24 <= usedBytes) {
      const vo = rec.readUInt16LE(pos + 20);
      const vl = rec.readUInt32LE(pos + 16);
      const fb = pos + vo;
      if (vl >= 66 && fb + 66 <= pos + attrLen) {
        const fnLen = rec[fb + 64];
        const fnSpace = rec[fb + 65];
        const cand = rec.toString('utf16le', fb + 66, Math.min(pos + attrLen, fb + 66 + fnLen * 2)).split('\0')[0];
        const rank = fnSpace === 1 || fnSpace === 3 ? 2 : fnSpace === 0 ? 1 : 0;
        if (cand && rank >= nameScore) {
          nameScore = rank;
          filename = cand;
          parentRecord = rec.readUInt32LE(fb);
          const fnSize = rec.readUInt32LE(fb + 48) + rec.readUInt32LE(fb + 52) * 4294967296;
          if (fileSize === 0 && fnSize > 0) fileSize = fnSize;
        }
      }
    } else if (attrType === 0x80 && attrName === '$J' && form === 1 && pos + 64 <= pos + attrLen) {
      const loVcn = rec.readUInt32LE(pos + 16) + rec.readUInt32LE(pos + 20) * 4294967296;
      const hiVcn = rec.readUInt32LE(pos + 24) + rec.readUInt32LE(pos + 28) * 4294967296;
      const mpOff = rec.readUInt16LE(pos + 32);
      usnSize = rec.readUInt32LE(pos + 48) + rec.readUInt32LE(pos + 52) * 4294967296;
      if (pos + mpOff < pos + attrLen) {
        usnRuns = decodeNtfsRunlistCjs(rec, pos + mpOff, pos + attrLen, loVcn, hiVcn);
      }
    } else if (attrType === 0x80 && nameLen === 0) {
      if (form === 0 && pos + 24 <= usedBytes) {
        const vl = rec.readUInt32LE(pos + 16);
        const vo = rec.readUInt16LE(pos + 20);
        if (pos + vo + vl <= pos + attrLen) {
          fileSize = vl;
          residentPayload = Buffer.from(rec.subarray(pos + vo, pos + vo + vl));
        }
      } else if (form === 1 && pos + 64 <= pos + attrLen) {
        const loVcn = rec.readUInt32LE(pos + 16) + rec.readUInt32LE(pos + 20) * 4294967296;
        const hiVcn = rec.readUInt32LE(pos + 24) + rec.readUInt32LE(pos + 28) * 4294967296;
        const mpOff = rec.readUInt16LE(pos + 32);
        fileSize = rec.readUInt32LE(pos + 48) + rec.readUInt32LE(pos + 52) * 4294967296;
        if (pos + mpOff < pos + attrLen) {
          rawRuns = decodeNtfsRunlistCjs(rec, pos + mpOff, pos + attrLen, loVcn, hiVcn);
        }
      }
    }
    pos += attrLen;
  }

  if (!filename) return null;
  const part = ntfsParts.find((p) => absOffset >= p.volStart && absOffset < p.volEnd) || ntfsParts[0] || { volStart: 0, clusterBytes: 4096 };
  const volKey = part.volStart;

  if (isDirectory && recordNumber >= 5) {
    dirMap.set(`${volKey}:${recordNumber}`, { parentRecord, name: filename });
    return { consumed: true };
  }

  if (recordNumber === 6 && filename === '$Bitmap') {
    if (residentPayload && residentPayload.length > 0) {
      bitmapByVol.set(volKey, residentPayload);
    } else if (rawRuns.length > 0 && fileSize > 0) {
      const bmSize = Math.min(fileSize, 8 * 1024 * 1024);
      const bm = Buffer.allocUnsafe(bmSize);
      let bmCursor = 0;
      for (const r of rawRuns) {
        if (bmCursor >= bmSize) break;
        const take = Math.min(r.clusterCount * part.clusterBytes, bmSize - bmCursor);
        if (r.lcn >= 0) {
          const bOff = part.volStart + r.lcn * part.clusterBytes;
          if (bOff + take <= limitBytes) fs.readSync(fd, bm, bmCursor, take, bOff);
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
        sector: Math.floor(absOffset / 512),
        devicePath: '',
        mftResident: true,
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
      fs.readSync(fd, hdrBuf, hdrCursor, take, extRun.offset);
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
      sector: Math.floor(absOffset / 512),
      devicePath: '',
      runs: extents,
      mftResident: false,
      discoveryCrc32: computeCrc32Cjs(hdrBuf, hdrCursor),
      headerSample: new Uint8Array(hdrBuf.buffer, hdrBuf.byteOffset, hdrCursor),
    },
  };
}

// Fast Contiguous NTFS $MFT + $UsnJrnl:$J Streamer (seconds instead of scanning whole multi-TB platters)
function scanNtfsMftContiguous(fd, devicePath, ntfsParts, limitBytes, includeExisting = false, maxRecords = 250000) {
  const candidates = [];
  const dirMap = new Map();
  const bitmapByVol = new Map();
  const usnSources = [];
  const entries = [];
  let recordCount = 0;

  for (const part of ntfsParts) {
    const boot = Buffer.allocUnsafe(512);
    if (fs.readSync(fd, boot, 0, 512, part.volStart) < 512) continue;
    const mftStartLcn = Number(boot.readBigUInt64LE(48));
    if (!Number.isFinite(mftStartLcn) || mftStartLcn <= 0) continue;

    const mftOffset0 = part.volStart + mftStartLcn * part.clusterBytes;
    if (mftOffset0 + 1024 > limitBytes) continue;

    const rec0 = Buffer.allocUnsafe(1024);
    if (fs.readSync(fd, rec0, 0, 1024, mftOffset0) < 1024) continue;
    if (rec0.toString('ascii', 0, 4) !== 'FILE') continue;

    // Extract $MFT Record #0's unnamed $DATA runlist so we stream all $MFT extents contiguously
    const usaOffset = rec0.readUInt16LE(4);
    const usaCount = rec0.readUInt16LE(6);
    const firstAttr = rec0.readUInt16LE(20);
    const usedBytes = rec0.readUInt32LE(24);
    if (usaOffset >= 42 && usaCount >= 2 && usaOffset + usaCount * 2 <= 1024) {
      const usn = rec0.readUInt16LE(usaOffset);
      for (let s = 1; s < usaCount && s * 512 <= 1024; s++) {
        const se = s * 512 - 2;
        if (rec0.readUInt16LE(se) === usn) {
          rec0[se] = rec0[usaOffset + s * 2];
          rec0[se + 1] = rec0[usaOffset + s * 2 + 1];
        }
      }
    }

    let mftRuns = [{ lcn: mftStartLcn, clusterCount: 64 }];
    let pos = firstAttr;
    while (pos + 16 <= usedBytes && pos + 16 <= 1024) {
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

    const chunkSize = 4 * 1024 * 1024;
    const chunkBuf = Buffer.allocUnsafe(chunkSize);

    for (const run of mftRuns) {
      if (run.lcn < 0 || recordCount >= maxRecords) continue;
      let runByteStart = part.volStart + run.lcn * part.clusterBytes;
      let remBytes = run.clusterCount * part.clusterBytes;
      while (remBytes >= 1024 && runByteStart + 1024 <= limitBytes && recordCount < maxRecords) {
        const toRead = Math.min(chunkSize, remBytes, limitBytes - runByteStart);
        const alignedRead = Math.floor(toRead / 1024) * 1024;
        if (alignedRead < 1024) break;
        const n = fs.readSync(fd, chunkBuf, 0, alignedRead, runByteStart);
        if (n < 1024) break;

        for (let off = 0; off + 1024 <= n && recordCount < maxRecords; off += 1024) {
          recordCount++;
          const mftRes = parseMftRecordBuffer(
            chunkBuf.subarray(off, off + 1024),
            runByteStart + off,
            ntfsParts,
            fd,
            limitBytes,
            dirMap,
            bitmapByVol,
            includeExisting,
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

  finalizeNtfsMftMetadata(candidates, dirMap, bitmapByVol);
  const pairedCandidates = rePairDeletedRecycleRecordsCjs(candidates);
  entries.length = 0;
  for (const c of pairedCandidates) {
    if (c?.entry) entries.push(c.entry);
  }

  // Parse recent $UsnJrnl:$J deleted entries
  for (const src of usnSources) {
    const part = src.usnVol;
    const tailRuns = src.usnRuns.slice(-4);
    for (const r of tailRuns) {
      if (r.lcn < 0) continue;
      const off = part.volStart + r.lcn * part.clusterBytes;
      const len = Math.min(4 * 1024 * 1024, r.clusterCount * part.clusterBytes, limitBytes - off);
      if (len < 128) continue;
      const uBuf = Buffer.allocUnsafe(len);
      try {
        const n = fs.readSync(fd, uBuf, 0, len, off);
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

  return { entries, dirMap, bitmapByVol };
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
      for (const r of rec.rawRuns) {
        if (r.lcn < 0) continue;
        for (let ci = 0; ci < r.clusterCount; ci++) {
          const lcn = r.lcn + ci;
          const bIdx = lcn >>> 3;
          if (bIdx < bm.length && (bm[bIdx] & (1 << (lcn & 7))) !== 0) {
            overwritten = true;
            break;
          }
        }
        if (overwritten) break;
      }
      rec.entry.mftOverwritten = overwritten;
      rec.entry.mftBitmapIntact = !overwritten;
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

  for (const sh of shadows.slice(-3)) {
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
      const origNorm = String(item.originalPath || item.filename).toLowerCase();
      const normKey = options.isRecycleBin
        ? `${origNorm}|${item.size}`
        : `${relPrefix ? relPrefix.toLowerCase() + '\\' : ''}${item.filename.toLowerCase()}`;
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
        item.originalPath = relPrefix ? `\\${relPrefix}\\${item.filename}` : `\\${item.filename}`;
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
  for (const spec of candidatesToOpen) {
    try {
      fd = fs.openSync(spec.path, 'r');
      openedSpec = spec;
      break;
    } catch {
      // try fallback handle
    }
  }
  if (fd === null || !openedSpec) {
    return { status: 'needs-admin', entries: [] };
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

    const volumes = detectVolumesFromDisk(fd, limitBytes);
    const ntfsParts = scopeNtfsPartsForTarget(volumes, backing, openedSpec.isVol);

    const candidates = [];
    if (ntfsParts.length > 0) {
      const mftRes = scanNtfsMftContiguous(fd, openedSpec.path, ntfsParts, limitBytes, false, 180000);
      candidates.push(...mftRes.entries);
    }
    if (!isRecycleBin) {
      for (const vol of volumes) {
        if (vol.fsType === 'fat32') {
          candidates.push(...scanFat32VolumeFromFd(fd, openedSpec.path, vol, limitBytes, false));
        } else if (vol.fsType === 'exfat') {
          candidates.push(...scanExfatVolumeFromFd(fd, openedSpec.path, vol, limitBytes, false));
        }
      }
    }

    if (isRecycleBin) {
      const filtered = filterAndTagEmptiedRecycleEntriesCjs(candidates, {
        driveLetter: backing.driveLetter || '',
      }).slice(0, maxEntries);
      return { status: 'scanned', entries: filtered };
    }

    const normPrefix = (backing.relPrefix || '').toLowerCase().replace(/^\\+|\\+$/g, '');
    const filtered = [];
    for (const item of candidates) {
      if (filtered.length >= maxEntries) break;
      const itemPath = String(item.originalPath || '').toLowerCase();
      if (normPrefix) {
        if (itemPath.includes(normPrefix)) {
          filtered.push(item);
        }
      } else {
        filtered.push(item);
      }
    }
    return { status: 'scanned', entries: filtered };
  } finally {
    fs.closeSync(fd);
  }
}

// Structural media repair functions live in ./mediaRepairCjs.cjs for multi-GB streaming support.

function createWindow() {
  const win = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#11151C',
    title: 'TestDisk & PhotoRec Recovery Suite',
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

    let workPath = tmpSrc;
    try {
      // Materialize source file into tmpSrc (or read directly from native filePath when not overwritten)
      if (params.buffer && params.buffer.length > 0) {
        fs.writeFileSync(tmpSrc, Buffer.from(params.buffer));
      } else if (params.filePath && fs.existsSync(params.filePath)) {
        workPath = params.filePath;
      } else if (params.sourceKind === 'native-tsk' && params.devicePath && params.tskInode) {
        const tskRes = await extractTskInodeToFile(params.devicePath, params.tskOffset || 0, params.tskInode, tmpSrc);
        if (!tskRes.ok) return { ok: false, tier: 'none', repairedSize: 0, note: tskRes.error || 'TSK extraction failed' };
      } else if (params.devicePath) {
        const srcFd = fs.openSync(params.devicePath, 'r');
        const dstFd = fs.openSync(tmpSrc, 'w');
        const copyChunk = Buffer.allocUnsafe(4 * 1024 * 1024);
        const zeroChunk = Buffer.alloc(1024 * 1024);
        const rawRanges =
          Array.isArray(params.runs) && params.runs.length > 0
            ? params.runs
            : [{ offset: params.offset || 0, length: params.size || 0 }];
        try {
          for (const run of rawRanges) {
            const runLen = Number.isFinite(Number(run?.length)) ? Math.max(0, Math.floor(Number(run.length))) : 0;
            const runOffset = Number.isFinite(Number(run?.offset)) ? Math.floor(Number(run.offset)) : -1;
            if (runLen <= 0) continue;
            let rem = runLen;
            if (runOffset < 0) {
              while (rem > 0) {
                const zLen = Math.min(zeroChunk.length, rem);
                fs.writeSync(dstFd, zeroChunk, 0, zLen);
                rem -= zLen;
              }
              continue;
            }
            let rPos = runOffset;
            while (rem > 0) {
              const alignedStart = Math.floor(rPos / 512) * 512;
              const trim = rPos - alignedStart;
              const need = Math.min(copyChunk.length - 512, rem);
              const alignedRead = Math.ceil((trim + need) / 512) * 512;
              const n = fs.readSync(srcFd, copyChunk, 0, Math.min(copyChunk.length, alignedRead), alignedStart);
              if (n <= trim) break;
              const take = Math.min(rem, n - trim);
              fs.writeSync(dstFd, copyChunk, trim, take);
              rPos += take;
              rem -= take;
            }
          }
        } finally {
          fs.closeSync(srcFd);
          fs.closeSync(dstFd);
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

      // Phase 1A: Multi-GB Streaming ISO BMFF MP4/MOV/M4V/3GP Structural Rebuild (Zero RAM limit!)
      if (['mp4', 'mov', 'm4v', '3gp'].includes(ext)) {
        const mp4Res = repairMp4StreamingFileCjs(workPath, tmpStruct, refBuf);
        if (mp4Res && mp4Res.ok && fs.existsSync(tmpStruct)) {
          stagePath = tmpStruct;
          structuralTier = mp4Res.tier || 'structural-moov';
          structuralNote = mp4Res.note;
        }
      } else if (srcSize <= 256 * 1024 * 1024) {
        // Phase 1B: Deep Image, JPEG Bitstream, PNG CRC/IDAT, AVI idx1, MKV & RAW Preview Structural Repair
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

      // Phase 2: Multi-tier FFmpeg escalation when FFmpeg is bundled (skip non-media docs/archives & >1 GiB remuxes)
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

      // Visual verification thumbnail via FFmpeg (video) or data URL (small image / RAW preview)
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
          Math.min(safeMax, 16 * 1024 * 1024),
        );
        return head ? new Uint8Array(head.buffer, head.byteOffset, head.byteLength) : new Uint8Array(0);
      }

      const alignedStart = Math.floor(safeStart / 512) * 512;
      const alignedLen = Math.max(512, Math.floor(safeMax / 512) * 512);
      const fd = fs.openSync(devicePath, 'r');
      try {
        const chunkSize = 1024 * 1024;
        const buffers = [];
        let totalRead = 0;

        while (totalRead < alignedLen) {
          const toRead = Math.min(chunkSize, alignedLen - totalRead);
          const buf = Buffer.allocUnsafe(toRead);
          const bytesRead = fs.readSync(fd, buf, 0, toRead, alignedStart + totalRead);
          if (bytesRead <= 0) break;
          buffers.push(bytesRead === toRead ? buf : buf.subarray(0, bytesRead));
          totalRead += bytesRead;
          if (bytesRead < toRead) break;
        }

        const combined = Buffer.concat(buffers, totalRead);
        return new Uint8Array(combined.buffer, combined.byteOffset, combined.byteLength);
      } finally {
        fs.closeSync(fd);
      }
    },
  );

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

  ipcMain.handle('win:unlock-bitlocker', async (_event, { driveLetter, recoveryKey, password }) => {
    if (process.platform !== 'win32') return { ok: false, error: 'Only supported on Windows.' };
    const cleanLetter = String(driveLetter || '').trim().replace(/:$/, '');
    if (!/^[A-Za-z]$/.test(cleanLetter)) return { ok: false, error: 'Invalid drive letter.' };
    const args = ['-unlock', `${cleanLetter}:`];
    if (recoveryKey && String(recoveryKey).trim()) {
      args.push('-RecoveryPassword', String(recoveryKey).trim());
    } else if (password && String(password).trim()) {
      args.push('-Password', String(password).trim());
    } else {
      return { ok: false, error: 'Enter a 48-digit BitLocker recovery password or user password.' };
    }
    return await new Promise((resolve) => {
      execFile('manage-bde.exe', args, { windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: (stderr || stdout || err.message || 'Unlock failed').trim() });
          return;
        }
        resolve({ ok: true, message: (stdout || `Unlocked ${cleanLetter}:`).trim() });
      });
    });
  });

  async function scanLocationAndDeleted(targetPath) {
    const out = [];
    const existingSet = new Set();

    if (targetPath) {
      walkFolderEntries(targetPath, out, 5000);
      for (const item of out) {
        existingSet.add(item.filename.toLowerCase());
      }
    }

    let deletedLookupStatus = 'unsupported';
    let backingDrive;
    if (process.platform === 'win32') {
      const probePath = targetPath || `${process.env.SystemDrive || 'C:'}\\`;
      const backing = await resolveBackingPhysicalDrive(probePath);
      if (backing) {
        backingDrive = backing.devicePath;
        await scanVssSnapshotsForPrefix(backing.relPrefix, existingSet, out, 1500);
        const delRes = await huntDeletedInBackingDrive(backing, false, 2000);
        deletedLookupStatus = delRes.status;
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
    };
  }

  /**
   * Dedicated Windows Recycle Bin + Emptied NTFS Lookup:
   * 1. Scans live $Recycle.Bin across ALL filesystem drives (resolving active-SID $I+$R metadata)
   * 2. Checks VSS Shadow Copies for prior $Recycle.Bin states
   * 3. Enumerates ALL readable NTFS volumes (logical \\.\X: first, fallback PhysicalDriveN partition)
   *    to locate emptied $MFT & $UsnJrnl:$J Recycle Bin records and re-pair deleted $I+$R stubs.
   */
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

    // 1. Scan live $Recycle.Bin folders across all drives
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
      scanRecycleDir(path.join(rootDir, '$Recycle.Bin'), out, 5000, currentSid);
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

    // 2. Scan VSS Shadow Copies for $Recycle.Bin
    await scanVssSnapshotsForPrefix('$Recycle.Bin', existingLiveOrVssKeys, out, 2500, {
      isRecycleBin: true,
      preferredSid: currentSid,
      volLetterByGuid,
    });
    const vssCount = out.length - liveCount;

    // 3. Scan ALL readable NTFS volumes for emptied $MFT / $UsnJrnl Recycle Bin records
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
    const seenEmptiedKeys = new Set();
    let emptiedCount = 0;

    for (const vol of ntfsPlan) {
      if (emptiedCount >= 4000) break;
      const res = await huntDeletedInBackingDrive(
        {
          driveLetter: vol.driveLetter,
          volumeDevicePath: vol.volumeDevicePath,
          devicePath: vol.physicalDevicePath,
          partOffset: vol.partOffset,
          partSize: vol.partSize,
        },
        true,
        Math.max(200, 4000 - emptiedCount),
      );

      if (res.status === 'needs-admin') {
        needsAdminVolumes.push(vol.driveLetter);
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
    if (scannedVolumes.length > 0 && needsAdminVolumes.length === 0) {
      deletedLookupStatus = 'scanned';
    } else if (scannedVolumes.length > 0 && needsAdminVolumes.length > 0) {
      deletedLookupStatus = 'partial';
    } else if (needsAdminVolumes.length > 0) {
      deletedLookupStatus = 'needs-admin';
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
      if (state.ctrl) Atomics.store(state.ctrl, 0, 1);
    }
  });

  ipcMain.handle('win:resume-drive-scan', async (_event, scanId) => {
    const state = activeScans.get(scanId);
    if (state) {
      state.paused = false;
      if (state.ctrl) Atomics.store(state.ctrl, 0, 0);
    }
  });

  ipcMain.handle('win:cancel-drive-scan', async (_event, scanId) => {
    const state = activeScans.get(scanId);
    if (state) {
      state.cancelled = true;
      if (state.ctrl) Atomics.store(state.ctrl, 0, 2);
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

      const step = Math.max(512, Math.floor(blockSize / 512) * 512);
      const results = [];
      const seenOffsets = new Set();
      let allocatedBitmaps = [];
      let foundBytes = 0;

      const fd = fs.openSync(devicePath, 'r');
      let limitBytes = 0;
      let volumes = [];
      try {
        limitBytes = totalBytes > 0 ? totalBytes : fs.fstatSync(fd).size;
        volumes = detectVolumesFromDisk(fd, limitBytes);

        // Stage 1: Fast Filesystem Metadata Scan (Contiguous NTFS $MFT + $UsnJrnl:$J + FAT32 + exFAT + Sleuth Kit ext/HFS+ fallback)
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
            const ntfsQuick = scanNtfsMftContiguous(fd, devicePath, ntfsParts, limitBytes, includeExisting);
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
            const fsList =
              vol.fsType === 'fat32'
                ? scanFat32VolumeFromFd(fd, devicePath, vol, limitBytes, includeExisting)
                : vol.fsType === 'exfat'
                  ? scanExfatVolumeFromFd(fd, devicePath, vol, limitBytes, includeExisting)
                  : [];
            for (const item of fsList) {
              results.push(item);
              quickBatch.push(item);
              foundBytes += item.size;
              if (item.offset > 0) seenOffsets.add(item.offset);
            }
          }

          // Sleuth Kit (`mmls` + `fls`) enrichment for Linux ext2/3/4, HFS+, or fallback partitions
          if (!state.cancelled && getEngineCapabilitiesSync().sleuthkit) {
            const tskSeenKeys = new Set(
              results.map((r) => `${String(r.originalPath || '').toLowerCase()}:${r.size}`),
            );
            const mmlsParts = await runMmlsPartitions(devicePath, 512);
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

            for (const target of targetOffsets.slice(0, 6)) {
              if (state.cancelled) break;
              const tskRows = await runTskFlsScan(
                devicePath,
                target.startByte,
                target.label,
                includeExisting,
                4000,
              );
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
                  sector: Math.floor((row.offset || 0) / 512),
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
        }
      } finally {
        fs.closeSync(fd);
      }

      if (scanMode === 'quick' || state.cancelled) {
        event.sender.send('win:drive-scan-progress', {
          scanId,
          currentBytes: limitBytes,
          totalBytes: limitBytes,
          percent: 100,
          foundCount: results.length,
          foundBytes,
          phase: 'quick',
        });
        activeScans.delete(scanId);
        return results;
      }

      // Stage 2: Parallel Deep Sector Carving across Node worker_threads (with 64-bit zero skip & optional NTFS $Bitmap unallocated-only mask)
      const cursorStart = Math.max(0, Math.floor(resumeOffset / 512) * 512);
      const remainingBytes = Math.max(0, limitBytes - cursorStart);
      const workerCount =
        remainingBytes >= 4 * 1024 * 1024
          ? Math.min(4, Math.max(1, os.cpus().length - 1))
          : 1;
      const sliceBytes = Math.ceil(remainingBytes / workerCount / 512) * 512;

      let totalBytesRead = cursorStart;
      let latestName;

      await new Promise((resolveAll) => {
        let finished = 0;
        if (remainingBytes < 512) {
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
              workerIndex: w,
              ctrlBuffer: ctrlSab,
              unallocatedOnly: Boolean(unallocatedOnly),
              allocatedBitmaps,
            },
          });

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
              });
            }
          });

          const onWorkerDone = () => {
            finished++;
            if (finished >= workerCount) resolveAll();
          };
          worker.on('exit', onWorkerDone);
          worker.on('error', onWorkerDone);
        }
      });

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

      event.sender.send('win:drive-scan-progress', {
        scanId,
        currentBytes: state.cancelled ? totalBytesRead : limitBytes,
        totalBytes: limitBytes,
        percent: state.cancelled ? Math.round((totalBytesRead / Math.max(1, limitBytes)) * 100) : 100,
        foundCount: results.length,
        foundBytes,
        phase: 'deep',
      });

      activeScans.delete(scanId);
      return results;
    },
  );

  ipcMain.handle('win:recover-files', async (_event, { destinationDir, items, scannedDevicePath }) => {
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

    // Source-drive self-overwrite pre-flight guard for raw physical drives or logical volume handles
    const rawSourcePath = scannedDevicePath || items.find((i) => i.devicePath && i.devicePath.startsWith('\\\\.\\'))?.devicePath;
    if (process.platform === 'win32' && rawSourcePath && rawSourcePath.startsWith('\\\\.\\')) {
      if (/^\\\\\.\\[A-Za-z]:$/i.test(rawSourcePath)) {
        const srcVolPrefix = rawSourcePath.slice(4, 6).toUpperCase();
        if (targetRoot.toUpperCase().startsWith(srcVolPrefix)) {
          return {
            canceled: false,
            savedCount: 0,
            verifiedCount: 0,
            destinationDir: targetRoot,
            repairedCount: 0,
            error: `Safety block: "${targetRoot}" resides on the same NTFS volume (${srcVolPrefix}) being recovered. Choose a different drive to prevent overwriting deleted clusters.`,
          };
        }
      } else if (rawSourcePath.startsWith('\\\\.\\PhysicalDrive')) {
        try {
          const destBacking = await resolveBackingPhysicalDrive(targetRoot);
          if (destBacking && destBacking.devicePath.toLowerCase() === rawSourcePath.toLowerCase()) {
            return {
              canceled: false,
              savedCount: 0,
              verifiedCount: 0,
              destinationDir: targetRoot,
              repairedCount: 0,
              error: `Safety block: "${targetRoot}" resides on the same physical disk (${rawSourcePath}) being recovered. Choose a different drive to prevent overwriting deleted clusters.`,
            };
          }
        } catch {
          // continue if drive resolution is unavailable
        }
      }
    }

    // Free space pre-flight guard
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

    const copyBuf = Buffer.allocUnsafe(4 * 1024 * 1024); // 4 MiB streaming copy buffer
    const zeroBuf = Buffer.alloc(1024 * 1024); // 1 MiB zero buffer for sparse NTFS runs
    let savedCount = 0;
    let verifiedCount = 0;
    let repairedCount = 0;
    const failures = [];
    const reportLines = [];
    const createdDirs = new Set();
    const resolvedRoot = path.resolve(targetRoot);

    const streamExtent = (srcFd, dstFd, offset, length, isRawDev, lastTwoRef, headChunks) => {
      let remaining = Number.isFinite(Number(length)) ? Math.max(0, Math.floor(Number(length))) : 0;
      if (remaining <= 0) return;
      let headCaptured = headChunks.reduce((sum, c) => sum + c.length, 0);

      if (offset < 0) {
        while (remaining > 0) {
          const zLen = Math.min(zeroBuf.length, remaining);
          fs.writeSync(dstFd, zeroBuf, 0, zLen);
          if (headCaptured < 65536) {
            const take = Math.min(zLen, 65536 - headCaptured);
            headChunks.push(Buffer.alloc(take));
            headCaptured += take;
          }
          if (zLen >= 2) {
            lastTwoRef[0] = 0;
            lastTwoRef[1] = 0;
          } else if (zLen === 1) {
            lastTwoRef[0] = lastTwoRef[1];
            lastTwoRef[1] = 0;
          }
          remaining -= zLen;
        }
        return;
      }

      let readPos = offset;
      while (remaining > 0) {
        if (isRawDev) {
          const alignedStart = Math.floor(readPos / 512) * 512;
          const headTrim = readPos - alignedStart;
          const rawNeed = Math.min(copyBuf.length - 512, remaining);
          const alignedRead = Math.ceil((headTrim + rawNeed) / 512) * 512;
          const n = fs.readSync(srcFd, copyBuf, 0, Math.min(copyBuf.length, alignedRead), alignedStart);
          if (n <= headTrim) break;
          const validLen = Math.min(remaining, n - headTrim);
          fs.writeSync(dstFd, copyBuf, headTrim, validLen);
          if (headCaptured < 65536) {
            const take = Math.min(validLen, 65536 - headCaptured);
            headChunks.push(Buffer.from(copyBuf.subarray(headTrim, headTrim + take)));
            headCaptured += take;
          }
          if (validLen >= 2) {
            lastTwoRef[0] = copyBuf[headTrim + validLen - 2];
            lastTwoRef[1] = copyBuf[headTrim + validLen - 1];
          }
          readPos += validLen;
          remaining -= validLen;
        } else {
          const toRead = Math.min(copyBuf.length, remaining);
          const n = fs.readSync(srcFd, copyBuf, 0, toRead, readPos);
          if (n <= 0) break;
          fs.writeSync(dstFd, copyBuf, 0, n);
          if (headCaptured < 65536) {
            const take = Math.min(n, 65536 - headCaptured);
            headChunks.push(Buffer.from(copyBuf.subarray(0, take)));
            headCaptured += take;
          }
          if (n >= 2) {
            lastTwoRef[0] = copyBuf[n - 2];
            lastTwoRef[1] = copyBuf[n - 1];
          }
          readPos += n;
          remaining -= n;
        }
      }
    };

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

      // Guard against overwriting an active source file in-place
      if (item.devicePath && path.resolve(item.devicePath).toLowerCase() === path.resolve(destPath).toLowerCase()) {
        failures.push({ filename: item.filename, reason: 'Skipped to prevent overwriting active source file.' });
        continue;
      }

      const partialPath = `${destPath}.partial`;

      if (item.sourceKind === 'memory' && item.memoryBytes) {
        try {
          const memBuf = Buffer.from(item.memoryBytes);
          const magicExt = detectMagicExtFromHeadCjs(memBuf);
          if (magicExt) {
            correctedName = resolvePreferredFilenameCjs(correctedName, magicExt);
            destPath = resolveUniqueDestPath(destDir, correctedName);
          }
          fs.writeFileSync(partialPath, memBuf);
          if (item.modifiedAtMs) {
            const dt = new Date(item.modifiedAtMs);
            try {
              fs.utimesSync(partialPath, dt, dt);
            } catch {
              // ignore timestamp error
            }
          }
          fs.renameSync(partialPath, destPath);
          savedCount++;
          verifiedCount++;
          reportLines.push(`OK\t${memBuf.length}\tMEM\t${correctedName}\t${destPath}`);
        } catch (err) {
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
          const tskRes = await extractTskInodeToFile(item.devicePath, item.tskOffset || 0, item.tskInode, partialPath);
          if (!tskRes.ok) {
            try {
              if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
            } catch {
              // ignore cleanup
            }
            failures.push({ filename: item.filename, reason: tskRes.error || 'Sleuth Kit icat returned 0 bytes' });
            continue;
          }
          const headFd = fs.openSync(partialPath, 'r');
          try {
            const headBuf = Buffer.allocUnsafe(Math.min(65536, tskRes.bytesWritten));
            const hRead = fs.readSync(headFd, headBuf, 0, headBuf.length, 0);
            const magicExt = detectMagicExtFromHeadCjs(headBuf.subarray(0, hRead));
            if (magicExt) {
              correctedName = resolvePreferredFilenameCjs(correctedName, magicExt);
              destPath = resolveUniqueDestPath(destDir, correctedName);
            }
          } finally {
            fs.closeSync(headFd);
          }
          if (item.modifiedAtMs) {
            const dt = new Date(item.modifiedAtMs);
            try {
              fs.utimesSync(partialPath, dt, dt);
            } catch {
              // ignore timestamp error
            }
          }
          fs.renameSync(partialPath, destPath);
          savedCount++;
          verifiedCount++;
          reportLines.push(`OK(TSK)\t${tskRes.bytesWritten}\tINODE:${item.tskInode}\t${correctedName}\t${destPath}`);
        } catch (err) {
          failures.push({ filename: item.filename, reason: err?.message || 'TSK extraction failed' });
        }
        continue;
      }

      let srcFd;
      let dstFd;
      let committed = false;
      try {
        srcFd = fs.openSync(item.devicePath, 'r');
        dstFd = fs.openSync(partialPath, 'w');
        const lastTwo = [0, 0];
        const headChunks = [];
        if (Array.isArray(item.runs) && item.runs.length > 0) {
          const isRawDev = Boolean(item.devicePath && item.devicePath.startsWith('\\\\.\\')) || item.sourceKind === 'native-runs' || item.sourceKind === 'native-device';
          for (const run of item.runs) {
            streamExtent(srcFd, dstFd, run.offset, run.length, isRawDev, lastTwo, headChunks);
          }
        } else {
          streamExtent(
            srcFd,
            dstFd,
            item.offset || 0,
            item.size || 0,
            item.sourceKind === 'native-device',
            lastTwo,
            headChunks,
          );
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

        let crcStatus = 'N/A';
        if (item.discoveryCrc32 && headMerged.length > 0) {
          const liveCrc = computeCrc32Cjs(headMerged, 65536);
          if (liveCrc === item.discoveryCrc32) {
            verifiedCount++;
            crcStatus = `MATCH:${liveCrc.toString(16).padStart(8, '0')}`;
          } else {
            crcStatus = `MISMATCH:${liveCrc.toString(16).padStart(8, '0')}`;
            failures.push({
              filename: correctedName,
              reason: 'Discovery CRC-32 mismatch (source sectors changed between scan and recovery).',
            });
          }
        } else {
          verifiedCount++;
        }

        const effectiveExt = path.extname(correctedName).replace(/^\./, '').toLowerCase() || String(item.extension || '').toLowerCase();
        if (item.repairIfTruncated && (effectiveExt === 'jpg' || effectiveExt === 'jpeg')) {
          if (fs.statSync(partialPath).size <= 64 * 1024 * 1024) {
            fs.closeSync(dstFd);
            const jRes = repairJpegBufferCjs(fs.readFileSync(partialPath));
            if (jRes && jRes.data) {
              fs.writeFileSync(partialPath, jRes.data);
              repairedCount++;
            }
            dstFd = fs.openSync(partialPath, 'r+');
          } else if (lastTwo[0] !== 0xff || lastTwo[1] !== 0xd9) {
            fs.writeSync(dstFd, Buffer.from([0xff, 0xd9]));
            repairedCount++;
          }
        } else if (item.repairIfTruncated && effectiveExt === 'png' && fs.statSync(partialPath).size <= 64 * 1024 * 1024) {
          fs.closeSync(dstFd);
          const pRes = repairPngBufferCjs(fs.readFileSync(partialPath));
          if (pRes && pRes.data) {
            fs.writeFileSync(partialPath, pRes.data);
            repairedCount++;
          }
          dstFd = fs.openSync(partialPath, 'r+');
        } else if (
          item.repairIfTruncated &&
          ['mp4', 'mov', 'm4v', '3gp', 'mkv', 'avi'].includes(effectiveExt)
        ) {
          fs.closeSync(dstFd);
          let didRepair = false;
          if (['mp4', 'mov', 'm4v', '3gp'].includes(effectiveExt)) {
            const streamTmp = `${partialPath}.moov.${effectiveExt}`;
            const sRes = repairMp4StreamingFileCjs(partialPath, streamTmp);
            if (sRes && sRes.ok && fs.existsSync(streamTmp)) {
              try {
                fs.unlinkSync(partialPath);
              } catch {
                // ignore
              }
              fs.renameSync(streamTmp, partialPath);
              repairedCount++;
              didRepair = true;
            } else if (fs.existsSync(streamTmp)) {
              try { fs.unlinkSync(streamTmp); } catch { /* ignore */ }
            }
          } else if (effectiveExt === 'avi' && fs.statSync(partialPath).size <= 192 * 1024 * 1024) {
            const aRes = repairAviBufferCjs(fs.readFileSync(partialPath));
            if (aRes && aRes.data) {
              fs.writeFileSync(partialPath, aRes.data);
              repairedCount++;
              didRepair = true;
            }
          }
          if (!didRepair && getEngineCapabilitiesSync().ffmpeg) {
            const remuxTmp = `${partialPath}.remux.${effectiveExt}`;
            const ffRes = await ffmpegRepairVideoFile(partialPath, remuxTmp, {
              extension: effectiveExt,
              allowTranscode: true,
            });
            if (ffRes && ffRes.ok) {
              try {
                fs.unlinkSync(partialPath);
              } catch {
                // ignore
              }
              fs.renameSync(remuxTmp, partialPath);
              repairedCount++;
            } else if (fs.existsSync(remuxTmp)) {
              try {
                fs.unlinkSync(remuxTmp);
              } catch {
                // ignore
              }
            }
          }
          if (item.modifiedAtMs) {
            const dt = new Date(item.modifiedAtMs);
            try {
              fs.utimesSync(partialPath, dt, dt);
            } catch {
              // ignore timestamp error
            }
          }
          fs.renameSync(partialPath, destPath);
          committed = true;
          savedCount++;
          reportLines.push(`OK\t${item.size}\t${crcStatus}\t${correctedName}\t${destPath}`);
          continue;
        } else if (
          item.repairIfTruncated &&
          NON_MEDIA_REPAIR_EXTS_CJS.has(effectiveExt) &&
          fs.statSync(partialPath).size <= 128 * 1024 * 1024
        ) {
          fs.closeSync(dstFd);
          const docRes = repairNonMediaBufferCjs(effectiveExt, fs.readFileSync(partialPath));
          if (docRes && docRes.data) {
            fs.writeFileSync(partialPath, docRes.data);
            repairedCount++;
          }
          dstFd = fs.openSync(partialPath, 'r+');
        }

        if (item.modifiedAtMs) {
          const sec = item.modifiedAtMs / 1000;
          try {
            fs.futimesSync(dstFd, sec, sec);
          } catch {
            // ignore futimes failure
          }
        }

        fs.closeSync(dstFd);
        fs.renameSync(partialPath, destPath);
        committed = true;
        savedCount++;
        reportLines.push(`OK\t${item.size}\t${crcStatus}\t${correctedName}\t${destPath}`);
      } catch (err) {
        failures.push({ filename: item.filename, reason: err?.message || 'Read/write failure' });
      } finally {
        if (srcFd !== undefined) {
          try {
            fs.closeSync(srcFd);
          } catch {
            // ignore
          }
        }
        if (!committed) {
          if (dstFd !== undefined) {
            try {
              fs.closeSync(dstFd);
            } catch {
              // already closed
            }
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
    if (savedCount > 0) {
      reportPath = path.join(targetRoot, 'TestDisk-Recovery-Report.txt');
      const header = [
        'TestDisk & PhotoRec Recovery Suite — Audit Report',
        `Generated: ${new Date().toISOString()}`,
        `Destination: ${targetRoot}`,
        `Saved: ${savedCount} | Verified: ${verifiedCount} | Repaired: ${repairedCount} | Warnings/Failures: ${failures.length}`,
        '',
        'STATUS\tSIZE_BYTES\tVERIFICATION\tFILENAME\tSAVED_PATH',
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
      // Zero-byte / failed recovery cleanup: remove any empty directories we created
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
      reportPath,
      failures,
    };
  });

  ipcMain.handle('win:save-text-report', async (_event, { defaultName, title, filters, content }) => {
    const res = await dialog.showSaveDialog({
      title: title || 'Save Forensic Report',
      defaultPath: defaultName,
      filters: filters || [{ name: 'All Files', extensions: ['*'] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
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
