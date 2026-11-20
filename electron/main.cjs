const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const activeScans = new Map();
const WINDOWS_EPOCH_DIFF_MS = 11644473600000;

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
          offset: 0,
          sector: 0,
          devicePath: full,
          headerSample: info.sample,
        });
      } catch {
        // skip unreadable/locked system files
      }
    }
  }
}

function scanRecycleDir(recycleRoot, outList, maxFiles = 5000) {
  if (!fs.existsSync(recycleRoot) || outList.length >= maxFiles) return;
  let sidDirs;
  try {
    sidDirs = fs.readdirSync(recycleRoot, { withFileTypes: true });
  } catch {
    return;
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
          offset: 0,
          sector: 0,
          devicePath: fullR,
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

// Stream FAT32 directory clusters via fs.readSync to recover deleted LFN files + subdirectories + extents
function scanFat32VolumeFromFd(fd, devicePath, vol, limitBytes) {
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
        if (!isDeleted || fileSize === 0 || firstCluster < 2) continue;

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
          offset: extents[0].offset,
          sector: Math.floor(extents[0].offset / 512),
          devicePath,
          runs: extents,
          mftResident: false,
          mftOverwritten: overwritten,
          mftBitmapIntact: !overwritten,
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

// Stream exFAT directory clusters via fs.readSync to recover deleted 0x05 entries + Allocation Bitmap checks
function scanExfatVolumeFromFd(fd, devicePath, vol, limitBytes) {
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
        if (!isDeleted || dataLength === 0 || firstCluster < 2) continue;

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
          offset: extents[0].offset,
          sector: Math.floor(extents[0].offset / 512),
          devicePath,
          runs: extents,
          mftResident: false,
          mftOverwritten: overwritten,
          mftBitmapIntact: bitmap !== null && !overwritten,
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

function parseMftRecordRaw(fd, absOffset, ntfsParts, limitBytes, dirMap, bitmapByVol) {
  const work = Buffer.allocUnsafe(1024);
  if (fs.readSync(fd, work, 0, 1024, absOffset) < 1024) return null;
  const usaOffset = work.readUInt16LE(4);
  const usaCount = work.readUInt16LE(6);
  const firstAttrOffset = work.readUInt16LE(20);
  const flags = work.readUInt16LE(22);
  const usedBytes = work.readUInt32LE(24);
  const recordNumber = work.readUInt32LE(44);

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

  const usn = work.readUInt16LE(usaOffset);
  for (let s = 1; s < usaCount && s * 512 <= 1024; s++) {
    const sectorEnd = s * 512 - 2;
    if (work.readUInt16LE(sectorEnd) !== usn) return null;
    work[sectorEnd] = work[usaOffset + s * 2];
    work[sectorEnd + 1] = work[usaOffset + s * 2 + 1];
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

  while (pos + 16 <= usedBytes) {
    const attrType = work.readUInt32LE(pos);
    if (attrType === 0xffffffff) break;
    const attrLen = work.readUInt32LE(pos + 4);
    if (attrLen < 16 || pos + attrLen > usedBytes) break;
    const form = work[pos + 8];
    const nameLen = work[pos + 9];

    if (attrType === 0x10 && form === 0 && pos + 24 <= usedBytes) {
      const vo = work.readUInt16LE(pos + 20);
      const vl = work.readUInt32LE(pos + 16);
      if (vl >= 32 && pos + vo + 32 <= pos + attrLen) {
        const lo = work.readUInt32LE(pos + vo + 8);
        const hi = work.readUInt32LE(pos + vo + 12);
        const ticks = hi * 4294967296 + lo;
        if (ticks > 0) modifiedAt = Math.floor(ticks / 10000 - WINDOWS_EPOCH_DIFF_MS);
      }
    } else if (attrType === 0x30 && form === 0 && pos + 24 <= usedBytes) {
      const vo = work.readUInt16LE(pos + 20);
      const vl = work.readUInt32LE(pos + 16);
      const fb = pos + vo;
      if (vl >= 66 && fb + 66 <= pos + attrLen) {
        const fnLen = work[fb + 64];
        const fnSpace = work[fb + 65];
        const cand = work.toString('utf16le', fb + 66, Math.min(pos + attrLen, fb + 66 + fnLen * 2)).split('\0')[0];
        const rank = fnSpace === 1 || fnSpace === 3 ? 2 : fnSpace === 0 ? 1 : 0;
        if (cand && rank >= nameScore) {
          nameScore = rank;
          filename = cand;
          parentRecord = work.readUInt32LE(fb);
          const fnSize = work.readUInt32LE(fb + 48) + work.readUInt32LE(fb + 52) * 4294967296;
          if (fileSize === 0 && fnSize > 0) fileSize = fnSize;
        }
      }
    } else if (attrType === 0x80 && nameLen === 0) {
      if (form === 0 && pos + 24 <= usedBytes) {
        const vl = work.readUInt32LE(pos + 16);
        const vo = work.readUInt16LE(pos + 20);
        if (pos + vo + vl <= pos + attrLen) {
          fileSize = vl;
          residentPayload = Buffer.from(work.subarray(pos + vo, pos + vo + vl));
        }
      } else if (form === 1 && pos + 64 <= pos + attrLen) {
        const loVcn = work.readUInt32LE(pos + 16) + work.readUInt32LE(pos + 20) * 4294967296;
        const hiVcn = work.readUInt32LE(pos + 24) + work.readUInt32LE(pos + 28) * 4294967296;
        const mpOff = work.readUInt16LE(pos + 32);
        fileSize = work.readUInt32LE(pos + 48) + work.readUInt32LE(pos + 52) * 4294967296;
        if (pos + mpOff < pos + attrLen) {
          rawRuns = decodeNtfsRunlistCjs(work, pos + mpOff, pos + attrLen, loVcn, hiVcn);
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

  // Capture NTFS $Bitmap (#6) allocation bitmap for cluster overwrite checks
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
          if (bOff + take <= limitBytes) {
            fs.readSync(fd, bm, bmCursor, take, bOff);
          }
        }
        bmCursor += take;
      }
      bitmapByVol.set(volKey, bm);
    }
    return { consumed: true };
  }

  if (inUse || filename.startsWith('$') || fileSize === 0) return null;
  const ext = path.extname(filename).replace(/^\./, '').toLowerCase();

  if (residentPayload) {
    return {
      consumed: true,
      volKey,
      parentRecord,
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
        offset: absOffset,
        sector: Math.floor(absOffset / 512),
        devicePath: '',
        mftResident: true,
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
    }
    rem -= runBytes;
  }
  if (extents.length === 0) return null;

  const sampleLen = Math.min(65536, extents[0].length);
  const hdrBuf = Buffer.allocUnsafe(sampleLen);
  const hRead = fs.readSync(fd, hdrBuf, 0, sampleLen, extents[0].offset);

  return {
    consumed: true,
    volKey,
    parentRecord,
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
      offset: extents[0].offset,
      sector: Math.floor(absOffset / 512),
      devicePath: '',
      runs: extents,
      mftResident: false,
      headerSample: new Uint8Array(hdrBuf.buffer, hdrBuf.byteOffset, hRead),
    },
  };
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
    if (bm && rec.rawRuns.length > 0) {
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

  ipcMain.handle('win:read-disk-bytes', async (_event, { devicePath, startByte = 0, maxBytes = 64 * 1024 * 1024 }) => {
    const alignedStart = Math.floor(startByte / 512) * 512;
    const alignedLen = Math.max(512, Math.floor(maxBytes / 512) * 512);
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

  ipcMain.handle('win:scan-folder', async (_event, folderPath) => {
    const out = [];
    walkFolderEntries(folderPath, out, 5000);
    return out;
  });

  ipcMain.handle('win:scan-recycle-bin', async () => {
    const out = [];
    if (process.platform === 'win32') {
      const roots = await runPowerShellJson(
        'Get-PSDrive -PSProvider FileSystem | Select-Object Root | ConvertTo-Json -Compress',
      );
      for (const r of roots) {
        if (r && r.Root) {
          scanRecycleDir(path.join(String(r.Root), '$Recycle.Bin'), out, 5000);
        }
      }
    }
    return out;
  });

  ipcMain.handle('win:scan-desktop', async () => {
    const desktopPath = app.getPath('desktop');
    const out = [];
    walkFolderEntries(desktopPath, out, 5000);
    return { path: desktopPath, entries: out };
  });

  ipcMain.handle('win:pause-drive-scan', async (_event, scanId) => {
    const state = activeScans.get(scanId);
    if (state) state.paused = true;
  });

  ipcMain.handle('win:resume-drive-scan', async (_event, scanId) => {
    const state = activeScans.get(scanId);
    if (state) state.paused = false;
  });

  ipcMain.handle('win:cancel-drive-scan', async (_event, scanId) => {
    const state = activeScans.get(scanId);
    if (state) state.cancelled = true;
  });

  ipcMain.handle('win:start-drive-scan', async (event, { scanId, devicePath, totalBytes, blockSize = 512, resumeOffset = 0 }) => {
    const state = { cancelled: false, paused: false };
    activeScans.set(scanId, state);

    const step = Math.max(512, Math.floor(blockSize / 512) * 512);
    const chunkSize = 4 * 1024 * 1024; // 4 MiB sector-aligned read chunks
    const chunkBuf = Buffer.allocUnsafe(chunkSize);
    const results = [];
    const ntfsCandidates = [];
    const mftDirMap = new Map();
    const ntfsBitmapByVol = new Map();
    let foundBytes = 0;
    let fileIndex = 1;
    let cursor = Math.max(0, Math.floor(resumeOffset / 512) * 512);

    const fd = fs.openSync(devicePath, 'r');
    try {
      const limitBytes = totalBytes > 0 ? totalBytes : fs.fstatSync(fd).size;
      const volumes = detectVolumesFromDisk(fd, limitBytes);
      const ntfsParts = volumes.filter((v) => v.fsType === 'ntfs');

      // Pass 1 (Metadata): Scan FAT32 and exFAT deleted directory entries first
      if (cursor === 0) {
        const pass1Batch = [];
        for (const vol of volumes) {
          if (state.cancelled) break;
          if (vol.fsType === 'fat32') {
            const fatItems = scanFat32VolumeFromFd(fd, devicePath, vol, limitBytes);
            for (const item of fatItems) {
              results.push(item);
              pass1Batch.push(item);
              foundBytes += item.size;
            }
          } else if (vol.fsType === 'exfat') {
            const exItems = scanExfatVolumeFromFd(fd, devicePath, vol, limitBytes);
            for (const item of exItems) {
              results.push(item);
              pass1Batch.push(item);
              foundBytes += item.size;
            }
          }
        }
        if (pass1Batch.length > 0) {
          event.sender.send('win:drive-scan-batch', { scanId, entries: pass1Batch });
        }
      }

      // Pass 2 (Deep Sector Carving + NTFS $MFT Record Harvesting)
      while (cursor + 512 <= limitBytes && !state.cancelled) {
        while (state.paused && !state.cancelled) {
          await new Promise((r) => setTimeout(r, 80));
        }
        if (state.cancelled) break;

        const windowLen = Math.min(chunkSize, Math.floor((limitBytes - cursor) / 512) * 512);
        if (windowLen < 512) break;

        let n = 0;
        try {
          n = fs.readSync(fd, chunkBuf, 0, windowLen, cursor);
        } catch {
          break;
        }
        if (n < 512) break;

        let local = 0;
        const chunkBatch = [];
        while (local + 16 <= n && !state.cancelled) {
          const b0 = chunkBuf[local];
          const b1 = chunkBuf[local + 1];
          const b2 = chunkBuf[local + 2];
          const b3 = chunkBuf[local + 3];
          const b4 = chunkBuf[local + 4];
          const absOffset = cursor + local;

          // NTFS MFT FILE record check (captures dirs, $Bitmap #6, and deleted files)
          if (b0 === 0x46 && b1 === 0x49 && b2 === 0x4c && b3 === 0x45 && absOffset + 1024 <= limitBytes) {
            const mftRes = parseMftRecordRaw(fd, absOffset, ntfsParts, limitBytes, mftDirMap, ntfsBitmapByVol);
            if (mftRes) {
              if (mftRes.entry) {
                mftRes.entry.devicePath = devicePath;
                ntfsCandidates.push(mftRes);
                results.push(mftRes.entry);
                chunkBatch.push(mftRes.entry);
                foundBytes += mftRes.entry.size;
              }
              local += 1024;
              continue;
            }
          }

          let matchedExt = null;
          let measured = null;

          if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff && [0xe0, 0xe1, 0xe2, 0xdb, 0xee, 0xc0, 0xc2].includes(b3)) {
            matchedExt = 'jpg';
            measured = measureJpgFromFd(fd, absOffset, limitBytes);
          } else if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47 && chunkBuf[local + 4] === 0x0d) {
            matchedExt = 'png';
            measured = measurePngFromFd(fd, absOffset, limitBytes);
          } else if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46 && b3 === 0x38) {
            matchedExt = 'gif';
            measured = measureGifFromFd(fd, absOffset, limitBytes);
          } else if (b0 === 0x42 && b1 === 0x4d && local + 18 <= n) {
            const bfSize = chunkBuf.readUInt32LE(local + 2);
            const dibSize = chunkBuf.readUInt32LE(local + 14);
            if (bfSize > 54 && bfSize < 100 * 1024 * 1024 && [12, 40, 52, 56, 108, 124].includes(dibSize)) {
              matchedExt = 'bmp';
              measured = { size: Math.min(bfSize, limitBytes - absOffset), truncated: bfSize > limitBytes - absOffset };
            }
          } else if (b4 === 0x66 && chunkBuf[local + 5] === 0x74 && chunkBuf[local + 6] === 0x79 && chunkBuf[local + 7] === 0x70) {
            matchedExt = 'mp4';
            measured = measureMp4FromFd(fd, absOffset, limitBytes);
          } else if (b0 === 0x1a && b1 === 0x45 && b2 === 0xdf && b3 === 0xa3) {
            matchedExt = 'mkv';
            measured = { size: Math.min(16 * 1024 * 1024, limitBytes - absOffset), truncated: false };
          } else if (b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x46) {
            const fourcc = chunkBuf.toString('ascii', local + 8, local + 12);
            if (fourcc === 'WAVE' || fourcc === 'AVI ' || fourcc === 'WEBP') {
              matchedExt = fourcc === 'WAVE' ? 'wav' : fourcc === 'AVI ' ? 'avi' : 'webp';
              const riffSize = chunkBuf.readUInt32LE(local + 4) + 8;
              measured = {
                size: Math.min(riffSize, limitBytes - absOffset),
                truncated: riffSize > limitBytes - absOffset,
              };
            }
          } else if (b0 === 0x30 && b1 === 0x26 && b2 === 0xb2 && b3 === 0x75) {
            matchedExt = 'wmv';
            measured = { size: Math.min(16 * 1024 * 1024, limitBytes - absOffset), truncated: false };
          } else if (b0 === 0x46 && b1 === 0x4c && b2 === 0x56 && b3 === 0x01) {
            matchedExt = 'flv';
            measured = { size: Math.min(16 * 1024 * 1024, limitBytes - absOffset), truncated: false };
          } else if (b0 === 0x25 && b1 === 0x50 && b2 === 0x44 && b3 === 0x46 && b4 === 0x2d) {
            matchedExt = 'pdf';
            measured = measurePdfFromFd(fd, absOffset, limitBytes);
          } else if (b0 === 0x50 && b1 === 0x4b && b2 === 0x03 && b3 === 0x04) {
            matchedExt = 'zip';
            measured = measureZipFromFd(fd, absOffset, limitBytes);
          } else if (b0 === 0xd0 && b1 === 0xcf && b2 === 0x11 && b3 === 0xe0) {
            matchedExt = 'doc';
            measured = { size: Math.min(4 * 1024 * 1024, limitBytes - absOffset), truncated: false };
          } else if (b0 === 0x7b && b1 === 0x5c && b2 === 0x72 && b3 === 0x74 && b4 === 0x66) {
            matchedExt = 'rtf';
            measured = { size: Math.min(2 * 1024 * 1024, limitBytes - absOffset), truncated: false };
          } else if (b0 === 0x53 && b1 === 0x51 && b2 === 0x4c && b3 === 0x69 && chunkBuf.toString('ascii', local, local + 15) === 'SQLite format 3') {
            matchedExt = 'sqlite';
            measured = measureSqliteFromFd(fd, absOffset, limitBytes);
          } else if (b0 === 0x49 && b1 === 0x44 && b2 === 0x33 && local + 10 <= n) {
            const tagSz =
              ((chunkBuf[local + 6] & 0x7f) << 21) |
              ((chunkBuf[local + 7] & 0x7f) << 14) |
              ((chunkBuf[local + 8] & 0x7f) << 7) |
              (chunkBuf[local + 9] & 0x7f);
            if (tagSz > 0) {
              matchedExt = 'mp3';
              measured = { size: Math.min(tagSz + 4 * 1024 * 1024, limitBytes - absOffset), truncated: false };
            }
          } else if (b0 === 0x66 && b1 === 0x4c && b2 === 0x61 && b3 === 0x43) {
            matchedExt = 'flac';
            measured = { size: Math.min(16 * 1024 * 1024, limitBytes - absOffset), truncated: false };
          } else if (b0 === 0x4f && b1 === 0x67 && b2 === 0x67 && b3 === 0x53) {
            matchedExt = 'ogg';
            measured = { size: Math.min(8 * 1024 * 1024, limitBytes - absOffset), truncated: false };
          } else if (b0 === 0x52 && b1 === 0x61 && b2 === 0x72 && b3 === 0x21) {
            matchedExt = 'rar';
            measured = { size: Math.min(16 * 1024 * 1024, limitBytes - absOffset), truncated: false };
          } else if (b0 === 0x37 && b1 === 0x7a && b2 === 0xbc && b3 === 0xaf && b4 === 0x27) {
            matchedExt = '7z';
            measured = { size: Math.min(16 * 1024 * 1024, limitBytes - absOffset), truncated: false };
          } else if (b0 === 0x1f && b1 === 0x8b && b2 === 0x08) {
            matchedExt = 'gz';
            measured = { size: Math.min(8 * 1024 * 1024, limitBytes - absOffset), truncated: false };
          } else if ((b0 === 0x49 && b1 === 0x49 && b2 === 0x2a && b3 === 0x00) || (b0 === 0x4d && b1 === 0x4d && b2 === 0x00 && b3 === 0x2a)) {
            matchedExt = 'tif';
            measured = { size: Math.min(16 * 1024 * 1024, limitBytes - absOffset), truncated: false };
          } else if (b0 === 0x38 && b1 === 0x42 && b2 === 0x50 && b3 === 0x53) {
            matchedExt = 'psd';
            measured = { size: Math.min(24 * 1024 * 1024, limitBytes - absOffset), truncated: false };
          }

          if (matchedExt && measured && measured.size >= 32) {
            const pad = String(fileIndex).padStart(6, '0');
            const filename = `${matchedExt.toUpperCase()}_${pad}.${matchedExt}`;
            const headerLen = Math.min(65536, measured.size);
            const hdrSample = Buffer.allocUnsafe(headerLen);
            const hRead = fs.readSync(fd, hdrSample, 0, headerLen, absOffset);

            const carvedEntry = {
              id: `drv-${absOffset}-${matchedExt}`,
              filename,
              originalPath: `${devicePath} @ sector ${Math.floor(absOffset / 512)}`,
              extensionHint: matchedExt,
              size: measured.size,
              calculatedSize: measured.size,
              truncated: measured.truncated,
              modifiedAt: Date.now(),
              sourceKind: 'carved',
              offset: absOffset,
              sector: Math.floor(absOffset / 512),
              devicePath,
              headerSample: new Uint8Array(hdrSample.buffer, hdrSample.byteOffset, hRead),
            };
            results.push(carvedEntry);
            chunkBatch.push(carvedEntry);

            foundBytes += measured.size;
            fileIndex++;

            const alignedSkip = Math.max(step, Math.ceil(measured.size / step) * step);
            local += alignedSkip;
            continue;
          }

          local += step;
        }

        if (chunkBatch.length > 0) {
          event.sender.send('win:drive-scan-batch', { scanId, entries: chunkBatch });
        }

        cursor += n;
        event.sender.send('win:drive-scan-progress', {
          scanId,
          currentBytes: cursor,
          totalBytes: limitBytes,
          percent: Math.min(99, Math.round((cursor / limitBytes) * 100)),
          foundCount: results.length,
          foundBytes,
          latestName: results.length > 0 ? results[results.length - 1].filename : undefined,
        });
        await new Promise((r) => setTimeout(r, 0));
      }

      finalizeNtfsMftMetadata(ntfsCandidates, mftDirMap, ntfsBitmapByVol);

      event.sender.send('win:drive-scan-progress', {
        scanId,
        currentBytes: cursor,
        totalBytes: limitBytes,
        percent: state.cancelled ? Math.round((cursor / limitBytes) * 100) : 100,
        foundCount: results.length,
        foundBytes,
      });

      return results;
    } finally {
      activeScans.delete(scanId);
      fs.closeSync(fd);
    }
  });

  ipcMain.handle('win:recover-files', async (_event, { destinationDir, items }) => {
    let targetRoot = destinationDir;
    if (!targetRoot) {
      const pick = await dialog.showOpenDialog({
        title: 'Choose Destination Folder for Recovered Files (Use a Different Drive)',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (pick.canceled || pick.filePaths.length === 0) {
        return { canceled: true, savedCount: 0, destinationDir: '', repairedCount: 0 };
      }
      targetRoot = pick.filePaths[0];
    }

    // Source-drive self-overwrite & free space pre-flight guard (WinDirStat ValidateDestination)
    const totalRequested = items.reduce((s, i) => s + (i.size || 0), 0);
    if (typeof fs.statfsSync === 'function') {
      try {
        const stats = fs.statfsSync(targetRoot);
        const freeBytes = Number(stats.bavail) * Number(stats.bsize);
        if (freeBytes > 0 && freeBytes < totalRequested) {
          return {
            canceled: false,
            savedCount: 0,
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
    let savedCount = 0;
    let repairedCount = 0;

    const streamExtent = (srcFd, dstFd, offset, length, isRawDev, lastTwoRef) => {
      let remaining = length;
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
          if (n >= 2) {
            lastTwoRef[0] = copyBuf[n - 2];
            lastTwoRef[1] = copyBuf[n - 1];
          }
          readPos += n;
          remaining -= n;
        }
      }
    };

    for (const item of items) {
      const safeFolder = String(item.folder || 'Recovered')
        .split(/[\\/]/)
        .filter(Boolean)
        .map(sanitizeWinFilename)
        .join(path.sep);
      const destDir = path.join(targetRoot, safeFolder);
      fs.mkdirSync(destDir, { recursive: true });

      const cleanName = sanitizeWinFilename(item.filename);
      const destPath = path.join(destDir, cleanName);

      // Guard against overwriting an active source file in-place
      if (item.devicePath && path.resolve(item.devicePath).toLowerCase() === path.resolve(destPath).toLowerCase()) {
        continue;
      }

      const partialPath = `${destPath}.partial`;

      if (item.sourceKind === 'memory' && item.memoryBytes) {
        fs.writeFileSync(partialPath, Buffer.from(item.memoryBytes));
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
        continue;
      }

      if (!item.devicePath) continue;
      const srcFd = fs.openSync(item.devicePath, 'r');
      const dstFd = fs.openSync(partialPath, 'w');
      let committed = false;
      try {
        const lastTwo = [0, 0];
        if (item.sourceKind === 'native-runs' && Array.isArray(item.runs) && item.runs.length > 0) {
          for (const run of item.runs) {
            streamExtent(srcFd, dstFd, run.offset, run.length, true, lastTwo);
          }
        } else {
          streamExtent(srcFd, dstFd, item.offset || 0, item.size || 0, item.sourceKind === 'native-device', lastTwo);
        }

        if (item.repairIfTruncated && (item.extension === 'jpg' || item.extension === 'jpeg')) {
          if (lastTwo[0] !== 0xff || lastTwo[1] !== 0xd9) {
            fs.writeSync(dstFd, Buffer.from([0xff, 0xd9]));
            repairedCount++;
          }
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
      } finally {
        fs.closeSync(srcFd);
        if (!committed) {
          try {
            fs.closeSync(dstFd);
          } catch {
            // already closed
          }
          try {
            if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
          } catch {
            // ignore cleanup failure
          }
        }
      }
    }

    return { canceled: false, savedCount, destinationDir: targetRoot, repairedCount };
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
