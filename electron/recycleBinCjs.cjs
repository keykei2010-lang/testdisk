const path = require('node:path');

const WINDOWS_EPOCH_DIFF_MS = 11644473600000;

/**
 * Matches Windows Recycle Bin payload ($Rxxxxxx.*) and metadata ($Ixxxxxx.*) names
 * while excluding NTFS metafiles such as $MFT, $LogFile, $Bitmap, $UsnJrnl, $Reparse, etc.
 */
function isRecycleBinEntryName(filename) {
  if (!filename || typeof filename !== 'string') return false;
  return /^\$[RI][A-Za-z0-9]{4,}/i.test(filename);
}

/**
 * Parses a Windows Vista/7/10/11 $Recycle.Bin $Ixxxxxx metadata buffer
 * into originalSize, deletedAtMs, originalPath, and originalName.
 */
function parseRecycleIFileBufferCjs(buf) {
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
  const parsedMs = ticks > 0 ? Math.floor(ticks / 10000 - WINDOWS_EPOCH_DIFF_MS) : undefined;
  const deletedAtMs = parsedMs && parsedMs > 0 ? parsedMs : undefined;

  let rawPath = '';
  if (verLo === 1) {
    rawPath = buf.toString('utf16le', 24, Math.min(buf.length, 544)).split('\0')[0];
  } else {
    const pathChars = Math.min(1024, buf.readUInt32LE(24));
    rawPath = buf.toString('utf16le', 28, Math.min(buf.length, 28 + pathChars * 2)).split('\0')[0];
  }
  if (!rawPath) return null;
  const parts = rawPath.split(/[\\/]/);
  return {
    version: verLo,
    originalSize,
    deletedAtMs,
    originalPath: rawPath,
    originalName: parts[parts.length - 1] || rawPath,
  };
}

function getRecycleSuffix(filename) {
  if (!filename || filename.length <= 2) return '';
  return filename.slice(2).toLowerCase();
}

/**
 * Re-pairs deleted NTFS $MFT Recycle Bin $Ixxxxxx metadata stubs with their matching
 * deleted $Rxxxxxx data records so emptied Recycle Bin items recover their real filenames,
 * original Windows paths, and deletion timestamps.
 *
 * Modifies/returns a filtered list of candidate objects (dropping parsed $I stubs once paired/consumed).
 */
function rePairDeletedRecycleRecordsCjs(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return candidates;

  const byParentSuffix = new Map();
  const byVolSuffix = new Map();
  const consumedIIds = new Set();

  for (const rec of candidates) {
    const entry = rec?.entry;
    if (!entry || !entry.filename || !/^\$I[A-Za-z0-9]{4,}/i.test(entry.filename)) continue;
    if (!entry.headerSample || entry.headerSample.length < 28) continue;

    const meta = parseRecycleIFileBufferCjs(Buffer.from(entry.headerSample));
    if (!meta) continue;

    const suffix = getRecycleSuffix(entry.filename);
    const volKey = rec.volKey ?? 0;
    const parentRec = rec.parentRecord ?? 0;
    byParentSuffix.set(`${volKey}:${parentRec}:${suffix}`, meta);
    if (!byVolSuffix.has(`${volKey}:${suffix}`)) {
      byVolSuffix.set(`${volKey}:${suffix}`, meta);
    }
    // Suppress the tiny ~544 B $I metadata stub itself
    consumedIIds.add(entry.id);
  }

  if (consumedIIds.size === 0 && !candidates.some((r) => /^\$R[A-Za-z0-9]{4,}/i.test(r?.entry?.filename || ''))) {
    return candidates;
  }

  const out = [];
  for (const rec of candidates) {
    const entry = rec?.entry;
    if (!entry) continue;
    if (consumedIIds.has(entry.id)) continue;

    if (/^\$R[A-Za-z0-9]{4,}/i.test(entry.filename)) {
      const suffix = getRecycleSuffix(entry.filename);
      const volKey = rec.volKey ?? 0;
      const parentRec = rec.parentRecord ?? 0;
      const meta =
        byParentSuffix.get(`${volKey}:${parentRec}:${suffix}`) ||
        byVolSuffix.get(`${volKey}:${suffix}`) ||
        null;

      if (meta) {
        entry.recycleTempPath = entry.originalPath;
        entry.isRecycleBinEmptied = true;
        entry.filename = meta.originalName;
        entry.originalPath = meta.originalPath;
        entry.extensionHint = path.extname(meta.originalName).replace(/^\./, '').toLowerCase();
        if (meta.deletedAtMs > 0) entry.modifiedAt = meta.deletedAtMs;
        if (meta.originalSize > 0 && entry.size === 0) {
          entry.size = meta.originalSize;
          entry.calculatedSize = meta.originalSize;
        }
        entry.details = `Emptied Recycle Bin payload re-paired with $I${suffix} ($MFT metadata)`;
      } else {
        entry.isRecycleBinEmptied = true;
      }
    }
    out.push(rec);
  }
  return out;
}

/**
 * Filters NTFS $MFT and $UsnJrnl:$J candidates down to emptied Recycle Bin entries
 * (living inside \$Recycle.Bin\... or matching $Rxxxxxx names) and tags them for the Recycle Bin view.
 */
function filterAndTagEmptiedRecycleEntriesCjs(entries, { driveLetter = '', seenKeys = new Set() } = {}) {
  const cleanDrive = driveLetter ? `${String(driveLetter).replace(/:$/, '').toUpperCase()}:` : '';
  const results = [];

  for (const item of entries) {
    if (!item || !item.filename) continue;
    const lowerName = item.filename.toLowerCase();
    // Skip desktop.ini and raw $I stubs that lacked data payloads
    if (lowerName === 'desktop.ini' || /^\$I[A-Za-z0-9]{4,}/i.test(item.filename)) continue;

    const itemPathLower = String(item.originalPath || '').toLowerCase();
    const inRecycleFolder = itemPathLower.includes('$recycle.bin');
    const isRecycleRName = /^\$R[A-Za-z0-9]{4,}/i.test(item.filename);
    const isPairedRecycle = Boolean(item.isRecycleBinEmptied);

    // Must be inside $Recycle.Bin, be an unpaired $Rxxxxxx payload, or be a re-paired $I+$R entry
    if (!inRecycleFolder && !isRecycleRName && !isPairedRecycle) continue;

    const srcTag = item.scanPhase === 'usn' ? '$UsnJrnl:$J' : '$MFT';
    const origPathRaw = String(item.originalPath || '');
    const prefixedPath =
      cleanDrive && origPathRaw.startsWith('\\') && !/^[A-Za-z]:/.test(origPathRaw)
        ? `${cleanDrive}${origPathRaw}`
        : origPathRaw || (cleanDrive ? `${cleanDrive}\\$Recycle.Bin\\${item.filename}` : `\\$Recycle.Bin\\${item.filename}`);

    const dedupeKey = `${cleanDrive}|${item.offset || 0}|${item.filename.toLowerCase()}|${prefixedPath.toLowerCase()}`;
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);

    results.push({
      ...item,
      sourceKind: 'recycle-bin',
      isDeleted: true,
      originalPath: prefixedPath,
      partitionName: cleanDrive
        ? `Emptied $Recycle.Bin (${cleanDrive} · ${srcTag})`
        : `Emptied $Recycle.Bin (${srcTag})`,
      details:
        item.details ||
        (item.scanPhase === 'usn'
          ? `Recorded as emptied/deleted in ${cleanDrive || 'NTFS'} $UsnJrnl:$J change journal`
          : `Recovered emptied Recycle Bin $MFT record from ${cleanDrive || 'NTFS'} (${item.mftResident ? 'resident' : `${item.runs?.length || 0} extent(s)`})`),
    });
  }
  return results;
}

/**
 * Builds an ordered list of readable NTFS volume scan targets from Windows PowerShell
 * Get-Volume + Get-Partition outputs.
 */
function buildNtfsVolumeScanPlanCjs(volumes = [], partitions = []) {
  const partByLetter = new Map();
  for (const p of Array.isArray(partitions) ? partitions : []) {
    const letter = String(p?.DriveLetter || '').trim().replace(/:$/, '').toUpperCase();
    if (!/^[A-Z]$/.test(letter)) continue;
    partByLetter.set(letter, {
      diskNumber: p.DiskNumber !== undefined && p.DiskNumber !== null ? Number(p.DiskNumber) : null,
      partOffset: p.Offset !== undefined && p.Offset !== null ? Number(p.Offset) : 0,
      partSize: p.Size !== undefined && p.Size !== null ? Number(p.Size) : 0,
    });
  }

  const seenLetters = new Set();
  const plan = [];
  for (const v of Array.isArray(volumes) ? volumes : []) {
    const letter = String(v?.DriveLetter || v?.Root || '')
      .trim()
      .replace(/[:\\/]+$/, '')
      .toUpperCase();
    if (!/^[A-Z]$/.test(letter) || seenLetters.has(letter)) continue;
    const fsName = String(v?.FileSystem || '').trim().toUpperCase();
    // Target NTFS volumes explicitly (and include volumes with empty FS string only if no NTFS metadata says otherwise)
    if (fsName && fsName !== 'NTFS') continue;

    seenLetters.add(letter);
    const pInfo = partByLetter.get(letter);
    plan.push({
      driveLetter: `${letter}:`,
      rootPath: `${letter}:\\`,
      label: String(v?.FileSystemLabel || 'Local Disk'),
      fileSystem: fsName || 'NTFS',
      sizeBytes: Number(v?.Size || pInfo?.partSize || 0),
      volumeDevicePath: `\\\\.\\${letter}:`,
      physicalDevicePath:
        pInfo && pInfo.diskNumber !== null && Number.isFinite(pInfo.diskNumber)
          ? `\\\\.\\PhysicalDrive${pInfo.diskNumber}`
          : null,
      partOffset: pInfo?.partOffset || 0,
      partSize: Number(pInfo?.partSize || v?.Size || 0),
    });
  }

  plan.sort((a, b) => a.driveLetter.localeCompare(b.driveLetter));
  return plan;
}

module.exports = {
  buildNtfsVolumeScanPlanCjs,
  filterAndTagEmptiedRecycleEntriesCjs,
  isRecycleBinEntryName,
  parseRecycleIFileBufferCjs,
  rePairDeletedRecycleRecordsCjs,
};
