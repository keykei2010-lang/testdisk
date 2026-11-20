import { PartitionEntry } from './partitions';

export interface FsDeletedRecord {
  id: string;
  fsType: 'FAT32' | 'exFAT';
  filename: string;
  reconstructedPath: string;
  fileSize: number;
  modifiedAtMs: number;
  extents: { offset: number; length: number }[];
  partitionId: string;
  partitionName: string;
  bitmapChecked: boolean;
  overwritten: boolean;
  reconstructedBytes: Uint8Array;
}

function dosDateTimeToMs(dateVal: number, timeVal: number): number {
  if (dateVal === 0) return Date.now();
  const year = 1980 + ((dateVal >> 9) & 0x7f);
  const month = Math.max(1, (dateVal >> 5) & 0x0f);
  const day = Math.max(1, dateVal & 0x1f);
  const hour = (timeVal >> 11) & 0x1f;
  const min = (timeVal >> 5) & 0x3f;
  const sec = (timeVal & 0x1f) * 2;
  const ms = Date.UTC(year, month - 1, day, hour, min, sec);
  return Number.isFinite(ms) ? ms : Date.now();
}

function extractLfnChars(entry: Uint8Array): string {
  const offsets = [1, 3, 5, 7, 9, 14, 16, 18, 20, 22, 24, 28, 30];
  let out = '';
  for (const o of offsets) {
    const code = entry[o] | (entry[o + 1] << 8);
    if (code === 0x0000 || code === 0xffff) break;
    out += String.fromCharCode(code);
  }
  return out;
}

function formatShortName83(entry: Uint8Array, isDeleted: boolean): string {
  const raw = new Uint8Array(entry.subarray(0, 11));
  if (isDeleted && raw[0] === 0xe5) {
    raw[0] = 0x5f; // '_' placeholder when LFN slots are absent
  }
  const base = String.fromCharCode(...raw.subarray(0, 8)).trimEnd();
  const ext = String.fromCharCode(...raw.subarray(8, 11)).trimEnd();
  return ext ? `${base}.${ext}` : base;
}

function isValidDosNameChar(c: number): boolean {
  return c >= 0x20 && c <= 0x7e;
}

function readFat32ClusterBytes(
  disk: Uint8Array,
  dataStart: number,
  clusterBytes: number,
  cluster: number,
): Uint8Array | null {
  if (cluster < 2) return null;
  const off = dataStart + (cluster - 2) * clusterBytes;
  if (off < 0 || off + clusterBytes > disk.length) return null;
  return disk.subarray(off, off + clusterBytes);
}

/**
 * Scans FAT32 directory clusters (root + subdirectories up to depth 8) for deleted 0xE5 entries,
 * reconstructing UTF-16LE Long File Names (LFN), DOS timestamps, and cluster extents.
 */
function scanFat32Partition(disk: Uint8Array, part: PartitionEntry): FsDeletedRecord[] {
  const volStart = part.startOffset;
  if (volStart + 512 > disk.length) return [];
  const dv = new DataView(disk.buffer, disk.byteOffset + volStart, 512);

  const bps = dv.getUint16(11, true) || 512;
  const spc = disk[volStart + 13] || 8;
  const reservedSectors = dv.getUint16(14, true);
  const numFats = disk[volStart + 16] || 2;
  const fatSz32 = dv.getUint32(36, true);
  const rootCluster = dv.getUint32(44, true) || 2;

  if (fatSz32 === 0 || bps < 512 || spc === 0) return [];
  const clusterBytes = bps * spc;
  const fatStart = volStart + reservedSectors * bps;
  const fatByteLen = fatSz32 * bps;
  const dataStart = fatStart + numFats * fatByteLen;

  const readFatEntry = (cluster: number): number => {
    const off = fatStart + cluster * 4;
    if (off + 4 > disk.length) return 0;
    return (
      (disk[off] | (disk[off + 1] << 8) | (disk[off + 2] << 16) | (disk[off + 3] << 24)) &
      0x0fffffff
    );
  };

  const results: FsDeletedRecord[] = [];
  const visitedClusters = new Set<number>();
  const queue: { cluster: number; prefixPath: string; depth: number; parentDeleted: boolean }[] = [
    { cluster: rootCluster, prefixPath: '', depth: 0, parentDeleted: false },
  ];

  while (queue.length > 0 && visitedClusters.size < 1024) {
    const { cluster: startCluster, prefixPath, depth, parentDeleted } = queue.shift()!;
    let curCluster = startCluster;
    let chainCount = 0;

    while (curCluster >= 2 && curCluster < 0x0ffffff0 && !visitedClusters.has(curCluster) && chainCount < 128) {
      visitedClusters.add(curCluster);
      const buf = readFat32ClusterBytes(disk, dataStart, clusterBytes, curCluster);
      if (!buf) break;

      let lfnParts: { seq: number; text: string }[] = [];
      let endOfDir = false;

      for (let off = 0; off + 32 <= buf.length; off += 32) {
        const entry = buf.subarray(off, off + 32);
        const firstByte = entry[0];
        if (firstByte === 0x00) {
          endOfDir = true;
          break;
        }
        const attr = entry[11];

        // Long File Name (LFN) slot
        if (attr === 0x0f) {
          const text = extractLfnChars(entry);
          const seqRaw = firstByte === 0xe5 ? 0 : firstByte & 0x1f;
          lfnParts.push({ seq: seqRaw, text });
          continue;
        }

        // Volume label
        if ((attr & 0x08) !== 0) {
          lfnParts = [];
          continue;
        }

        const isDeletedEntry = firstByte === 0xe5 || parentDeleted;
        // Validate plausibility of 8.3 entry
        const nameOk =
          (firstByte === 0xe5 || isValidDosNameChar(firstByte)) &&
          isValidDosNameChar(entry[8]);
        if (!nameOk) {
          lfnParts = [];
          continue;
        }

        const shortName = formatShortName83(entry, firstByte === 0xe5);
        if (shortName === '.' || shortName === '..') {
          lfnParts = [];
          continue;
        }

        let fullName = shortName;
        if (lfnParts.length > 0) {
          // LFN slots are stored in reverse order right above the 8.3 entry
          const ordered =
            firstByte === 0xe5
              ? [...lfnParts].reverse().map((p) => p.text).join('')
              : [...lfnParts].sort((a, b) => a.seq - b.seq).map((p) => p.text).join('');
          if (ordered.trim().length > 0) {
            fullName = ordered.trim();
          }
        }
        lfnParts = [];

        const edv = new DataView(entry.buffer, entry.byteOffset, 32);
        const hiCluster = edv.getUint16(20, true);
        const loCluster = edv.getUint16(26, true);
        const firstCluster = (hiCluster << 16) | loCluster;
        const fileSize = edv.getUint32(28, true);
        const writeTime = edv.getUint16(22, true);
        const writeDate = edv.getUint16(24, true);
        const modifiedAtMs = dosDateTimeToMs(writeDate, writeTime);
        const isDir = (attr & 0x10) !== 0;

        const fullPath = `${prefixPath}\\${fullName}`;

        if (isDir) {
          if (firstCluster >= 2 && depth < 8 && !visitedClusters.has(firstCluster)) {
            queue.push({
              cluster: firstCluster,
              prefixPath: fullPath,
              depth: depth + 1,
              parentDeleted: isDeletedEntry,
            });
          }
          continue;
        }

        if (!isDeletedEntry || fileSize === 0 || firstCluster < 2) continue;

        // Build extents: follow FAT chain if intact, otherwise contiguous fallback
        const neededClusters = Math.max(1, Math.ceil(fileSize / clusterBytes));
        const extents: { offset: number; length: number }[] = [];
        let overwritten = false;
        const firstFatVal = readFatEntry(firstCluster);

        if (firstFatVal !== 0) {
          // Wait: if FAT entry is non-zero on a deleted entry, either FAT chain remained or cluster was reallocated!
          // Check if subsequent clusters look like a valid linked chain or single-cluster EOF (>= 0x0ffffff8)
          let c = firstCluster;
          let rem = fileSize;
          const seenChain = new Set<number>();
          while (c >= 2 && c < 0x0ffffff0 && rem > 0 && !seenChain.has(c) && extents.length < 4096) {
            seenChain.add(c);
            const byteOff = dataStart + (c - 2) * clusterBytes;
            const take = Math.min(rem, clusterBytes);
            if (byteOff + take <= disk.length) {
              extents.push({ offset: byteOff, length: take });
            }
            rem -= take;
            const next = readFatEntry(c);
            if (next === 0 || next >= 0x0ffffff8) break;
            c = next;
          }
          // If recovered extents don't reach fileSize while FAT had non-zero link, mark likely overwritten
          const covered = extents.reduce((s, e) => s + e.length, 0);
          if (covered < fileSize) overwritten = true;
        } else {
          // Standard Windows/Camera FAT32 deletion zeros FAT entries -> assume contiguous clusters
          let rem = fileSize;
          for (let ci = 0; ci < neededClusters && rem > 0; ci++) {
            const c = firstCluster + ci;
            if (ci > 0 && readFatEntry(c) !== 0) {
              overwritten = true;
            }
            const byteOff = dataStart + (c - 2) * clusterBytes;
            const take = Math.min(rem, clusterBytes);
            if (byteOff + take <= disk.length) {
              extents.push({ offset: byteOff, length: take });
            }
            rem -= take;
          }
        }

        if (extents.length === 0) continue;

        const outSize = Math.min(fileSize, 32 * 1024 * 1024);
        const out = new Uint8Array(outSize);
        let writeCursor = 0;
        for (const ext of extents) {
          if (writeCursor >= out.length) break;
          const copyLen = Math.min(ext.length, out.length - writeCursor);
          out.set(disk.subarray(ext.offset, ext.offset + copyLen), writeCursor);
          writeCursor += copyLen;
        }

        results.push({
          id: `fat32-${volStart}-${curCluster}-${off}`,
          fsType: 'FAT32',
          filename: fullName,
          reconstructedPath: fullPath,
          fileSize,
          modifiedAtMs,
          extents,
          partitionId: part.id,
          partitionName: `FAT32 (${part.name})`,
          bitmapChecked: fatByteLen >= 16,
          overwritten,
          reconstructedBytes: out,
        });
      }

      if (endOfDir) break;
      const nextDirCluster = readFatEntry(curCluster);
      if (nextDirCluster < 2 || nextDirCluster >= 0x0ffffff8) break;
      curCluster = nextDirCluster;
      chainCount++;
    }
  }

  return results;
}

/**
 * Scans exFAT directory entry sets (0x85/0x05 File + 0xC0/0x40 Stream + 0xC1/0x41 FileName)
 * and uses exFAT Allocation Bitmap (0x81) to verify whether deleted clusters are intact.
 */
function scanExfatPartition(disk: Uint8Array, part: PartitionEntry): FsDeletedRecord[] {
  const volStart = part.startOffset;
  if (volStart + 512 > disk.length) return [];
  const dv = new DataView(disk.buffer, disk.byteOffset + volStart, 512);

  const fatOffsetSec = dv.getUint32(80, true);
  const clusterHeapSec = dv.getUint32(88, true);
  const rootCluster = dv.getUint32(96, true) || 4;
  const bps = 1 << Math.min(12, Math.max(9, disk[volStart + 108] || 9));
  const spc = 1 << Math.min(25, disk[volStart + 109] || 3);
  const clusterBytes = bps * spc;

  const fatStart = volStart + fatOffsetSec * bps;
  const heapStart = volStart + clusterHeapSec * bps;

  const readCluster = (cluster: number): Uint8Array | null => {
    if (cluster < 2) return null;
    const off = heapStart + (cluster - 2) * clusterBytes;
    if (off < 0 || off + clusterBytes > disk.length) return null;
    return disk.subarray(off, off + clusterBytes);
  };

  const readFat = (cluster: number): number => {
    const off = fatStart + cluster * 4;
    if (off + 4 > disk.length) return 0;
    return (disk[off] | (disk[off + 1] << 8) | (disk[off + 2] << 16) | (disk[off + 3] << 24)) >>> 0;
  };

  // Look for Allocation Bitmap (type 0x81) in root directory first
  let bitmap: Uint8Array | null = null;
  const rootBuf = readCluster(rootCluster);
  if (rootBuf) {
    for (let off = 0; off + 32 <= rootBuf.length; off += 32) {
      if (rootBuf[off] === 0x81) {
        const edv = new DataView(rootBuf.buffer, rootBuf.byteOffset + off, 32);
        const bmCluster = edv.getUint32(20, true);
        const bmLen = Math.min(edv.getUint32(24, true), 4 * 1024 * 1024);
        const bmOff = heapStart + (bmCluster - 2) * clusterBytes;
        if (bmCluster >= 2 && bmOff + bmLen <= disk.length) {
          bitmap = disk.subarray(bmOff, bmOff + bmLen);
        }
        break;
      }
    }
  }

  const isClusterAllocated = (cluster: number): boolean => {
    if (!bitmap || cluster < 2) return false;
    const idx = cluster - 2;
    const byteIdx = idx >>> 3;
    if (byteIdx >= bitmap.length) return false;
    return (bitmap[byteIdx] & (1 << (idx & 7))) !== 0;
  };

  const results: FsDeletedRecord[] = [];
  const visited = new Set<number>();
  const queue: { cluster: number; prefix: string; depth: number; parentDeleted: boolean }[] = [
    { cluster: rootCluster, prefix: '', depth: 0, parentDeleted: false },
  ];

  while (queue.length > 0 && visited.size < 1024) {
    const { cluster: startCluster, prefix, depth, parentDeleted } = queue.shift()!;
    let cur = startCluster;
    let guard = 0;

    while (cur >= 2 && cur < 0xfffffff0 && !visited.has(cur) && guard < 128) {
      visited.add(cur);
      const buf = readCluster(cur);
      if (!buf) break;

      for (let off = 0; off + 32 <= buf.length; ) {
        const entryType = buf[off];
        if (entryType === 0x00) break;

        // File Directory Entry: 0x85 (in-use) or 0x05 (deleted)
        if (entryType !== 0x85 && entryType !== 0x05) {
          off += 32;
          continue;
        }

        const isDeleted = entryType === 0x05 || parentDeleted;
        const secondaryCount = buf[off + 1];
        if (secondaryCount < 2 || off + (1 + secondaryCount) * 32 > buf.length) {
          off += 32;
          continue;
        }

        const fdv = new DataView(buf.buffer, buf.byteOffset + off, 32);
        const fileAttrs = fdv.getUint16(4, true);
        const modTime = fdv.getUint16(12, true);
        const modDate = fdv.getUint16(14, true);
        const modifiedAtMs = dosDateTimeToMs(modDate, modTime);
        const isDir = (fileAttrs & 0x10) !== 0;

        // Stream Extension: 0xC0 (in-use) or 0x40 (deleted)
        const streamOff = off + 32;
        const streamType = buf[streamOff];
        if (streamType !== 0xc0 && streamType !== 0x40) {
          off += 32;
          continue;
        }
        const sdv = new DataView(buf.buffer, buf.byteOffset + streamOff, 32);
        const genFlags = buf[streamOff + 1];
        const noFatChain = (genFlags & 0x02) !== 0;
        const nameLen = buf[streamOff + 3];
        const firstCluster = sdv.getUint32(20, true);
        const dataLenLo = sdv.getUint32(24, true);
        const dataLenHi = sdv.getUint32(28, true);
        const dataLength = dataLenHi * 4294967296 + dataLenLo;

        // Collect File Name entries: 0xC1 / 0x41
        let fullName = '';
        for (let s = 2; s <= secondaryCount; s++) {
          const nOff = off + s * 32;
          if (buf[nOff] !== 0xc1 && buf[nOff] !== 0x41) break;
          for (let j = 2; j + 1 < 32 && fullName.length < nameLen; j += 2) {
            const code = buf[nOff + j] | (buf[nOff + j + 1] << 8);
            if (code === 0) break;
            fullName += String.fromCharCode(code);
          }
        }

        off += (1 + secondaryCount) * 32;
        if (!fullName) continue;
        const fullPath = `${prefix}\\${fullName}`;

        if (isDir) {
          if (firstCluster >= 2 && depth < 8 && !visited.has(firstCluster)) {
            queue.push({
              cluster: firstCluster,
              prefix: fullPath,
              depth: depth + 1,
              parentDeleted: isDeleted,
            });
          }
          continue;
        }

        if (!isDeleted || dataLength === 0 || firstCluster < 2) continue;

        const needed = Math.max(1, Math.ceil(dataLength / clusterBytes));
        const extents: { offset: number; length: number }[] = [];
        let overwritten = false;
        let rem = dataLength;

        if (noFatChain || readFat(firstCluster) === 0) {
          for (let ci = 0; ci < needed && rem > 0; ci++) {
            const c = firstCluster + ci;
            if (bitmap && isClusterAllocated(c)) overwritten = true;
            const byteOff = heapStart + (c - 2) * clusterBytes;
            const take = Math.min(rem, clusterBytes);
            if (byteOff + take <= disk.length) {
              extents.push({ offset: byteOff, length: take });
            }
            rem -= take;
          }
        } else {
          let c = firstCluster;
          const seen = new Set<number>();
          while (c >= 2 && c < 0xfffffff0 && rem > 0 && !seen.has(c) && extents.length < 4096) {
            seen.add(c);
            if (bitmap && isClusterAllocated(c)) overwritten = true;
            const byteOff = heapStart + (c - 2) * clusterBytes;
            const take = Math.min(rem, clusterBytes);
            if (byteOff + take <= disk.length) {
              extents.push({ offset: byteOff, length: take });
            }
            rem -= take;
            const next = readFat(c);
            if (next === 0 || next >= 0xfffffff8) break;
            c = next;
          }
        }

        if (extents.length === 0) continue;
        const outSize = Math.min(dataLength, 32 * 1024 * 1024);
        const out = new Uint8Array(outSize);
        let w = 0;
        for (const ext of extents) {
          if (w >= out.length) break;
          const len = Math.min(ext.length, out.length - w);
          out.set(disk.subarray(ext.offset, ext.offset + len), w);
          w += len;
        }

        results.push({
          id: `exfat-${volStart}-${cur}-${off}`,
          fsType: 'exFAT',
          filename: fullName,
          reconstructedPath: fullPath,
          fileSize: dataLength,
          modifiedAtMs,
          extents,
          partitionId: part.id,
          partitionName: `exFAT (${part.name})`,
          bitmapChecked: bitmap !== null,
          overwritten,
          reconstructedBytes: out,
        });
      }

      const nextCluster = readFat(cur);
      if (nextCluster < 2 || nextCluster >= 0xfffffff8) break;
      cur = nextCluster;
      guard++;
    }
  }

  return results;
}

export function scanFatAndExfatDeletedInBuffer(
  diskBytes: Uint8Array,
  partitions: PartitionEntry[],
): FsDeletedRecord[] {
  const out: FsDeletedRecord[] = [];
  for (const part of partitions) {
    const fs = part.detectedFs?.filesystem;
    if (fs === 'FAT32') {
      out.push(...scanFat32Partition(diskBytes, part));
    } else if (fs === 'exFAT') {
      out.push(...scanExfatPartition(diskBytes, part));
    }
  }
  return out;
}
