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

// Fast MP4/MOV atom walker on open fd (measures multi-GB MP4 using ~16 bytes of RAM)
function measureMp4FromFd(fd, startOffset, maxEnd) {
  let pos = startOffset;
  const hdr = Buffer.allocUnsafe(16);
  let sawMoovOrMdat = false;
  let lastValidEnd = startOffset;

  for (let boxes = 0; boxes < 64 && pos + 8 <= maxEnd; boxes++) {
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
    if (boxType === 'moov' || boxType === 'mdat') sawMoovOrMdat = true;
    pos += boxSize;
    lastValidEnd = pos;
  }

  if (!sawMoovOrMdat) return null;
  return { size: lastValidEnd - startOffset, truncated: false };
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

// NTFS MFT Boot/Partition geometry + FILE record USA fixup + non-resident runlist decoder
function detectNtfsPartitionsFromMbr(fd, limitBytes) {
  const res = [];
  try {
    const mbr = Buffer.allocUnsafe(512);
    if (fs.readSync(fd, mbr, 0, 512, 0) < 512) return res;
    if (mbr[510] !== 0x55 || mbr[511] !== 0xaa) return res;

    for (let i = 0; i < 4; i++) {
      const off = 0x1be + i * 16;
      const startLba = mbr.readUInt32LE(off + 8);
      const secCount = mbr.readUInt32LE(off + 12);
      if (startLba === 0 || secCount === 0) continue;
      const startByte = startLba * 512;
      if (startByte + 512 > limitBytes) continue;
      const boot = Buffer.allocUnsafe(512);
      if (fs.readSync(fd, boot, 0, 512, startByte) < 512) continue;
      if (boot.toString('ascii', 3, 7) === 'NTFS') {
        const bytesPerSec = boot.readUInt16LE(11) || 512;
        const secPerCluster = boot[13] || 8;
        res.push({
          volStart: startByte,
          volEnd: Math.min(limitBytes, startByte + secCount * 512),
          clusterBytes: Math.max(512, bytesPerSec * secPerCluster),
        });
      }
    }
  } catch {
    // ignore partition detection errors on unpartitioned raw images
  }
  return res;
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

function tryParseDeletedMftEntry(fd, absOffset, ntfsParts, limitBytes) {
  const work = Buffer.allocUnsafe(1024);
  if (fs.readSync(fd, work, 0, 1024, absOffset) < 1024) return null;
  const usaOffset = work.readUInt16LE(4);
  const usaCount = work.readUInt16LE(6);
  const firstAttrOffset = work.readUInt16LE(20);
  const flags = work.readUInt16LE(22);
  const usedBytes = work.readUInt32LE(24);
  const recordNumber = work.readUInt32LE(44);

  if ((flags & 0x0001) !== 0 || (flags & 0x0002) !== 0) return null; // only deleted regular files
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

  let pos = firstAttrOffset;
  let filename = '';
  let nameScore = -1;
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

  if (!filename || filename.startsWith('$') || fileSize === 0) return null;
  const part = ntfsParts.find((p) => absOffset >= p.volStart && absOffset < p.volEnd) || ntfsParts[0] || { volStart: 0, clusterBytes: 4096 };
  const ext = path.extname(filename).replace(/^\./, '').toLowerCase();

  if (residentPayload) {
    return {
      id: `mft-${absOffset}-${recordNumber}`,
      filename,
      originalPath: `NTFS $MFT #${recordNumber} \\ ${filename}`,
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
    id: `mft-${absOffset}-${recordNumber}`,
    filename,
    originalPath: `NTFS $MFT #${recordNumber} (${extents.length} extent${extents.length > 1 ? 's' : ''}) \\ ${filename}`,
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
  };
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
    let foundBytes = 0;
    let fileIndex = 1;
    let cursor = Math.max(0, Math.floor(resumeOffset / 512) * 512);

    const fd = fs.openSync(devicePath, 'r');
    try {
      const limitBytes = totalBytes > 0 ? totalBytes : fs.fstatSync(fd).size;
      const ntfsParts = detectNtfsPartitionsFromMbr(fd, limitBytes);

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
        while (local + 16 <= n && !state.cancelled) {
          const b0 = chunkBuf[local];
          const b1 = chunkBuf[local + 1];
          const b2 = chunkBuf[local + 2];
          const b3 = chunkBuf[local + 3];
          const b4 = chunkBuf[local + 4];
          const absOffset = cursor + local;

          // Check deleted NTFS MFT FILE record first (WinDirStat / bulk_extractor pattern)
          if (b0 === 0x46 && b1 === 0x49 && b2 === 0x4c && b3 === 0x45 && absOffset + 1024 <= limitBytes) {
            const mftEntry = tryParseDeletedMftEntry(fd, absOffset, ntfsParts, limitBytes);
            if (mftEntry) {
              mftEntry.devicePath = devicePath;
              results.push(mftEntry);
              foundBytes += mftEntry.size;
              local += 1024;
              continue;
            }
          }

          let matchedExt = null;
          let measured = null;

          if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff && [0xe0, 0xe1, 0xe2, 0xdb, 0xee, 0xc0, 0xc2].includes(b3)) {
            matchedExt = 'jpg';
            measured = measureJpgFromFd(fd, absOffset, limitBytes);
          } else if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) {
            matchedExt = 'png';
            measured = measurePngFromFd(fd, absOffset, limitBytes);
          } else if (b4 === 0x66 && chunkBuf[local + 5] === 0x74 && chunkBuf[local + 6] === 0x79 && chunkBuf[local + 7] === 0x70) {
            matchedExt = 'mp4';
            measured = measureMp4FromFd(fd, absOffset, limitBytes);
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
          } else if (b0 === 0x25 && b1 === 0x50 && b2 === 0x44 && b3 === 0x46) {
            matchedExt = 'pdf';
            measured = { size: Math.min(2 * 1024 * 1024, limitBytes - absOffset), truncated: false };
          }

          if (matchedExt && measured && measured.size >= 32) {
            const pad = String(fileIndex).padStart(6, '0');
            const filename = `${matchedExt.toUpperCase()}_${pad}.${matchedExt}`;
            const headerLen = Math.min(65536, measured.size);
            const hdrSample = Buffer.allocUnsafe(headerLen);
            const hRead = fs.readSync(fd, hdrSample, 0, headerLen, absOffset);

            results.push({
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
            });

            foundBytes += measured.size;
            fileIndex++;

            const alignedSkip = Math.max(step, Math.ceil(measured.size / step) * step);
            local += alignedSkip;
            continue;
          }

          local += step;
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
