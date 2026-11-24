import { PartitionEntry } from './partitions';

export interface NtfsClusterRun {
  lcn: number; // -1 for sparse run
  clusterCount: number;
}

export interface NtfsByteExtent {
  offset: number;
  length: number;
}

export interface MftDeletedRecord {
  recordNumber: number;
  mftOffset: number;
  parentRecord: number;
  filename: string;
  reconstructedPath: string;
  isDirectory: boolean;
  inUse: boolean;
  isDeleted: boolean;
  fileSize: number;
  modifiedAtMs: number;
  residentData: Uint8Array | null;
  runs: NtfsClusterRun[];
  extents: NtfsByteExtent[];
  partitionId: string;
  partitionName: string;
  usaValid: boolean;
  bitmapChecked: boolean;
  overwritten: boolean;
  overwrittenClusters: number;
  totalClusters: number;
  reconstructedBytes: Uint8Array;
}

const WINDOWS_EPOCH_DIFF_MS = 11644473600000;

function filetimeToUnixMs(dv: DataView, pos: number): number {
  if (pos + 8 > dv.byteLength) return Date.now();
  const lo = dv.getUint32(pos, true);
  const hi = dv.getUint32(pos + 4, true);
  const ticks = hi * 4294967296 + lo;
  if (ticks <= 0) return Date.now();
  const ms = Math.floor(ticks / 10000 - WINDOWS_EPOCH_DIFF_MS);
  return ms > 0 ? ms : Date.now();
}

function decodeUtf16Le(buf: Uint8Array, pos: number, charCount: number): string {
  let out = '';
  const maxChars = Math.min(charCount, Math.floor((buf.length - pos) / 2));
  for (let i = 0; i < maxChars; i++) {
    const code = buf[pos + i * 2] | (buf[pos + i * 2 + 1] << 8);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}

/**
 * Decodes NTFS Mapping Pairs (runlist) for non-resident $DATA attributes
 * into physical (LCN, clusterCount) extents, following RecoveryNtfs.cpp.
 */
export function decodeNtfsRunlist(
  buf: Uint8Array,
  start: number,
  maxEnd: number,
  lowestVcn: number,
  highestVcn: number,
): NtfsClusterRun[] {
  const runs: NtfsClusterRun[] = [];
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
    for (let i = 0; i < lenBytes; i++) {
      count += buf[pos + i] * Math.pow(256, i);
    }
    pos += lenBytes;

    if (offBytes === 0) {
      runs.push({ lcn: -1, clusterCount: count });
    } else {
      let delta = 0;
      for (let i = 0; i < offBytes; i++) {
        delta += buf[pos + i] * Math.pow(256, i);
      }
      if ((buf[pos + offBytes - 1] & 0x80) !== 0) {
        delta -= Math.pow(256, offBytes);
      }
      pos += offBytes;
      lcn += delta;
      if (lcn < 0) return [];
      runs.push({ lcn, clusterCount: count });
    }
    vcn += count;
    if (runs.length > 2048 || vcn - 1 > highestVcn + count) break;
  }

  return runs;
}

/**
 * Validates and applies NTFS Update Sequence Array (USA) fixup to a 1024-byte FILE record.
 * When includeSystemAndDirs is true, preserves directory records and $Bitmap (#6) for reconstruction.
 */
export function parseSingleMftRecord(
  rawRecord: Uint8Array,
  includeSystemAndDirs = false,
): {
  inUse: boolean;
  isDirectory: boolean;
  usaValid: boolean;
  recordNumber: number;
  parentRecord: number;
  filename: string;
  fileSize: number;
  modifiedAtMs: number;
  residentData: Uint8Array | null;
  runs: NtfsClusterRun[];
} | null {
  if (rawRecord.length < 1024) return null;
  if (
    rawRecord[0] !== 0x46 ||
    rawRecord[1] !== 0x49 ||
    rawRecord[2] !== 0x4c ||
    rawRecord[3] !== 0x45
  ) {
    return null;
  }

  const work = rawRecord.slice(0, 1024);
  const dv = new DataView(work.buffer);
  const usaOffset = dv.getUint16(4, true);
  const usaCount = dv.getUint16(6, true);
  const firstAttrOffset = dv.getUint16(20, true);
  const flags = dv.getUint16(22, true);
  const usedBytes = dv.getUint32(24, true);
  const recordNumber = work.length >= 48 ? dv.getUint32(44, true) : 0;

  if (
    usaOffset < 42 ||
    usaCount < 2 ||
    usaOffset + usaCount * 2 > 1024 ||
    firstAttrOffset < 42 ||
    firstAttrOffset >= 1024 ||
    usedBytes < firstAttrOffset ||
    usedBytes > 1024
  ) {
    return null;
  }

  // Verify & apply Update Sequence Number (USN) fixup per 512-byte sector
  const usn = dv.getUint16(usaOffset, true);
  let usaValid = true;
  for (let s = 1; s < usaCount && s * 512 <= 1024; s++) {
    const sectorEnd = s * 512 - 2;
    if (dv.getUint16(sectorEnd, true) !== usn) {
      usaValid = false;
      break;
    }
    work[sectorEnd] = work[usaOffset + s * 2];
    work[sectorEnd + 1] = work[usaOffset + s * 2 + 1];
  }

  const inUse = (flags & 0x0001) !== 0;
  const isDirectory = (flags & 0x0002) !== 0;

  let pos = firstAttrOffset;
  let filename = '';
  let nameScore = -1;
  let parentRecord = 5;
  let modifiedAtMs = Date.now();
  let fileSize = 0;
  let residentData: Uint8Array | null = null;
  let runs: NtfsClusterRun[] = [];

  while (pos + 16 <= usedBytes) {
    const attrType = dv.getUint32(pos, true);
    if (attrType === 0xffffffff) break;
    const attrLen = dv.getUint32(pos + 4, true);
    if (attrLen < 16 || pos + attrLen > usedBytes) break;

    const form = work[pos + 8];
    const nameLen = work[pos + 9];

    if (attrType === 0x10 && form === 0 && pos + 24 <= usedBytes) {
      const valOffset = dv.getUint16(pos + 20, true);
      const valLen = dv.getUint32(pos + 16, true);
      if (pos + valOffset + 32 <= pos + attrLen && valLen >= 32) {
        modifiedAtMs = filetimeToUnixMs(dv, pos + valOffset + 8);
      }
    } else if (attrType === 0x30 && form === 0 && pos + 24 <= usedBytes) {
      const valOffset = dv.getUint16(pos + 20, true);
      const valLen = dv.getUint32(pos + 16, true);
      const fnBase = pos + valOffset;
      if (valLen >= 66 && fnBase + 66 <= pos + attrLen) {
        const fnNameLen = work[fnBase + 64];
        const fnSpace = work[fnBase + 65]; // 0=POSIX, 1=Win32, 2=DOS, 3=Win32+DOS
        const candidate = decodeUtf16Le(work, fnBase + 66, fnNameLen);
        const spaceRank = fnSpace === 1 || fnSpace === 3 ? 2 : fnSpace === 0 ? 1 : 0;
        if (candidate && spaceRank >= nameScore) {
          nameScore = spaceRank;
          filename = candidate;
          parentRecord = dv.getUint32(fnBase, true);
          const fnModified = filetimeToUnixMs(dv, fnBase + 16);
          if (fnModified > 0) modifiedAtMs = fnModified;
          const fnSizeLo = dv.getUint32(fnBase + 48, true);
          const fnSizeHi = dv.getUint32(fnBase + 52, true);
          const fnSize = fnSizeHi * 4294967296 + fnSizeLo;
          if (fileSize === 0 && fnSize > 0) fileSize = fnSize;
        }
      }
    } else if (attrType === 0x80 && nameLen === 0) {
      if (form === 0 && pos + 24 <= pos + attrLen) {
        const valLen = dv.getUint32(pos + 16, true);
        const valOffset = dv.getUint16(pos + 20, true);
        if (pos + valOffset + valLen <= pos + attrLen) {
          fileSize = valLen;
          residentData = work.slice(pos + valOffset, pos + valOffset + valLen);
        }
      } else if (form === 1 && pos + 64 <= pos + attrLen) {
        const lowestVcn = dv.getUint32(pos + 16, true) + dv.getUint32(pos + 20, true) * 4294967296;
        const highestVcn = dv.getUint32(pos + 24, true) + dv.getUint32(pos + 28, true) * 4294967296;
        const mpOffset = dv.getUint16(pos + 32, true);
        const realSizeLo = dv.getUint32(pos + 48, true);
        const realSizeHi = dv.getUint32(pos + 52, true);
        fileSize = realSizeHi * 4294967296 + realSizeLo;
        if (pos + mpOffset < pos + attrLen) {
          runs = decodeNtfsRunlist(work, pos + mpOffset, pos + attrLen, lowestVcn, highestVcn);
        }
      }
    }

    pos += attrLen;
  }

  if (!filename) return null;
  if (!includeSystemAndDirs && (filename.startsWith('$') || isDirectory)) return null;

  return {
    inUse,
    isDirectory,
    usaValid,
    recordNumber,
    parentRecord,
    filename,
    fileSize,
    modifiedAtMs,
    residentData,
    runs,
  };
}

function readNtfsBootClusterSize(diskBytes: Uint8Array, partStartOffset: number): number {
  if (partStartOffset + 64 > diskBytes.length) return 4096;
  const dv = new DataView(diskBytes.buffer, diskBytes.byteOffset + partStartOffset, 64);
  const oem = String.fromCharCode(
    diskBytes[partStartOffset + 3],
    diskBytes[partStartOffset + 4],
    diskBytes[partStartOffset + 5],
    diskBytes[partStartOffset + 6],
  );
  if (oem !== 'NTFS') return 4096;
  const bytesPerSec = dv.getUint16(11, true) || 512;
  const secPerCluster = diskBytes[partStartOffset + 13] || 8;
  return Math.max(512, bytesPerSec * secPerCluster);
}

function buildHierarchyPath(
  partId: string,
  parentRecord: number,
  filename: string,
  dirMap: Map<string, { parentRecord: number; name: string }>,
): string {
  const segments = [filename];
  const visited = new Set<number>();
  let cur = parentRecord;
  let guard = 0;

  while (cur > 5 && !visited.has(cur) && guard < 32) {
    visited.add(cur);
    const node = dirMap.get(`${partId}:${cur}`);
    if (!node || !node.name || node.name === '.') break;
    segments.unshift(node.name);
    if (node.parentRecord === cur) break;
    cur = node.parentRecord;
    guard++;
  }

  return `\\${segments.join('\\')}`;
}

function checkClustersAgainstBitmap(
  bitmap: Uint8Array,
  runs: NtfsClusterRun[],
): { overwrittenClusters: number; totalClusters: number } {
  let overwrittenClusters = 0;
  let totalClusters = 0;

  for (const run of runs) {
    if (run.lcn < 0) continue;
    for (let i = 0; i < run.clusterCount; i++) {
      const lcn = run.lcn + i;
      const byteIdx = lcn >>> 3;
      const bitMask = 1 << (lcn & 7);
      totalClusters++;
      if (byteIdx < bitmap.length && (bitmap[byteIdx] & bitMask) !== 0) {
        overwrittenClusters++;
      }
    }
  }

  return { overwrittenClusters, totalClusters };
}

/**
 * Scans raw disk image bytes for NTFS MFT FILE records:
 * - Builds directory hierarchy maps (active & deleted folders) to reconstruct real Windows paths
 * - Extracts $Bitmap (#6) allocation bitmaps per NTFS partition to detect cluster overwriting
 * - Reconstructs resident payloads and fragmented non-resident cluster runlists cleanly
 */
export function scanNtfsMftRecordsInBuffer(
  diskBytes: Uint8Array,
  partitions: PartitionEntry[],
  options?: { includeExisting?: boolean },
): MftDeletedRecord[] {
  const includeExisting = options?.includeExisting ?? false;
  const dirMap = new Map<string, { parentRecord: number; name: string }>();
  const bitmapByPartition = new Map<string, Uint8Array>();

  type ParsedCandidate = {
    off: number;
    partId: string;
    partName: string;
    volOffset: number;
    clusterBytes: number;
    parsed: NonNullable<ReturnType<typeof parseSingleMftRecord>>;
  };
  const candidates: ParsedCandidate[] = [];
  const seenOffsets = new Set<number>();

  // Pass 1: Read MFT records -> collect directories, $Bitmap (#6), and deleted (or existing) files
  for (let off = 0; off + 1024 <= diskBytes.length; off += 512) {
    if (
      diskBytes[off] !== 0x46 ||
      diskBytes[off + 1] !== 0x49 ||
      diskBytes[off + 2] !== 0x4c ||
      diskBytes[off + 3] !== 0x45
    ) {
      continue;
    }

    const parsed = parseSingleMftRecord(diskBytes.subarray(off, off + 1024), true);
    if (!parsed || !parsed.usaValid) continue;

    const lba = Math.floor(off / 512);
    const part = partitions.find((p) => lba >= p.startLba && lba <= p.endLba);
    const volOffset = part ? part.startOffset : 0;
    const clusterBytes = part ? readNtfsBootClusterSize(diskBytes, part.startOffset) : 4096;
    const partId = part ? part.id : 'unallocated';
    const partName = part
      ? `NTFS MFT (${part.detectedFs?.filesystem ?? part.name})`
      : 'Reconstructed NTFS MFT';

    if (parsed.isDirectory && parsed.recordNumber >= 5 && parsed.filename) {
      dirMap.set(`${partId}:${parsed.recordNumber}`, {
        parentRecord: parsed.parentRecord,
        name: parsed.filename,
      });
      continue;
    }

    // Extract $Bitmap (record #6) allocation map
    if (parsed.recordNumber === 6 && parsed.filename === '$Bitmap') {
      if (parsed.residentData && parsed.residentData.length > 0) {
        bitmapByPartition.set(partId, parsed.residentData);
      } else if (parsed.runs.length > 0 && parsed.fileSize > 0) {
        const bmSize = Math.min(parsed.fileSize, 4 * 1024 * 1024);
        const bm = new Uint8Array(bmSize);
        let cursor = 0;
        for (const r of parsed.runs) {
          if (cursor >= bm.length) break;
          const take = Math.min(r.clusterCount * clusterBytes, bm.length - cursor);
          if (r.lcn >= 0) {
            const byteStart = volOffset + r.lcn * clusterBytes;
            if (byteStart + take <= diskBytes.length) {
              bm.set(diskBytes.subarray(byteStart, byteStart + take), cursor);
            }
          }
          cursor += take;
        }
        bitmapByPartition.set(partId, bm);
      }
      continue;
    }

    if ((!includeExisting && parsed.inUse) || parsed.filename.startsWith('$') || seenOffsets.has(off)) {
      continue;
    }
    seenOffsets.add(off);
    candidates.push({ off, partId, partName, volOffset, clusterBytes, parsed });
  }

  // Pass 2: Assemble reconstructed paths, extents, payloads, and $Bitmap overwrite checks
  const results: MftDeletedRecord[] = [];
  for (const item of candidates) {
    const { off, partId, partName, volOffset, clusterBytes, parsed } = item;
    let reconstructedBytes: Uint8Array = new Uint8Array(0);
    const extents: NtfsByteExtent[] = [];

    if (parsed.residentData) {
      reconstructedBytes = parsed.residentData;
    } else if (parsed.runs.length > 0 && parsed.fileSize > 0) {
      const out = new Uint8Array(Math.min(parsed.fileSize, 32 * 1024 * 1024));
      let writeCursor = 0;
      for (const run of parsed.runs) {
        if (writeCursor >= out.length) break;
        const runByteLen = run.clusterCount * clusterBytes;
        const copyLen = Math.min(runByteLen, out.length - writeCursor);
        if (run.lcn >= 0) {
          const byteStart = volOffset + run.lcn * clusterBytes;
          extents.push({ offset: byteStart, length: copyLen });
          if (byteStart + copyLen <= diskBytes.length) {
            out.set(diskBytes.subarray(byteStart, byteStart + copyLen), writeCursor);
          }
        }
        writeCursor += copyLen;
      }
      reconstructedBytes = out;
    }

    if (reconstructedBytes.length === 0 && extents.length === 0) continue;

    const bitmap = bitmapByPartition.get(partId);
    let bitmapChecked = false;
    let overwritten = false;
    let overwrittenClusters = 0;
    let totalClusters = 0;

    if (bitmap && parsed.runs.length > 0 && !parsed.inUse) {
      bitmapChecked = true;
      const check = checkClustersAgainstBitmap(bitmap, parsed.runs);
      overwrittenClusters = check.overwrittenClusters;
      totalClusters = check.totalClusters;
      overwritten = overwrittenClusters > 0;
    }

    const reconstructedPath = buildHierarchyPath(partId, parsed.parentRecord, parsed.filename, dirMap);

    results.push({
      recordNumber: parsed.recordNumber,
      mftOffset: off,
      parentRecord: parsed.parentRecord,
      filename: parsed.filename,
      reconstructedPath,
      isDirectory: false,
      inUse: parsed.inUse,
      isDeleted: !parsed.inUse,
      fileSize: parsed.fileSize || reconstructedBytes.length,
      modifiedAtMs: parsed.modifiedAtMs,
      residentData: parsed.residentData,
      runs: parsed.runs,
      extents,
      partitionId: partId,
      partitionName: partName,
      usaValid: parsed.usaValid,
      bitmapChecked,
      overwritten,
      overwrittenClusters,
      totalClusters,
      reconstructedBytes,
    });
  }

  return results;
}

export function extractNtfsAllocatedChecker(
  diskBytes: Uint8Array,
  partitions: PartitionEntry[],
): ((offset: number) => boolean) | undefined {
  const regions: { volStart: number; volEnd: number; clusterBytes: number; bitmap: Uint8Array }[] = [];

  for (let off = 0; off + 1024 <= diskBytes.length; off += 512) {
    if (
      diskBytes[off] !== 0x46 ||
      diskBytes[off + 1] !== 0x49 ||
      diskBytes[off + 2] !== 0x4c ||
      diskBytes[off + 3] !== 0x45
    ) {
      continue;
    }
    const parsed = parseSingleMftRecord(diskBytes.subarray(off, off + 1024), true);
    if (!parsed || !parsed.usaValid) continue;
    if (parsed.recordNumber !== 6 || parsed.filename !== '$Bitmap') continue;

    const lba = Math.floor(off / 512);
    const part = partitions.find((p) => lba >= p.startLba && lba <= p.endLba);
    if (!part) continue;
    const volStart = part.startOffset;
    const volEnd = part.startOffset + part.sizeBytes;
    const clusterBytes = readNtfsBootClusterSize(diskBytes, volStart);

    if (parsed.residentData && parsed.residentData.length > 0) {
      regions.push({ volStart, volEnd, clusterBytes, bitmap: parsed.residentData });
    } else if (parsed.runs.length > 0 && parsed.fileSize > 0) {
      const bmSize = Math.min(parsed.fileSize, 4 * 1024 * 1024);
      const bm = new Uint8Array(bmSize);
      let cursor = 0;
      for (const r of parsed.runs) {
        if (cursor >= bm.length) break;
        const take = Math.min(r.clusterCount * clusterBytes, bm.length - cursor);
        if (r.lcn >= 0) {
          const byteStart = volStart + r.lcn * clusterBytes;
          if (byteStart + take <= diskBytes.length) {
            bm.set(diskBytes.subarray(byteStart, byteStart + take), cursor);
          }
        }
        cursor += take;
      }
      regions.push({ volStart, volEnd, clusterBytes, bitmap: bm });
    }
  }

  if (regions.length === 0) return undefined;
  return (offset: number) => {
    for (const r of regions) {
      if (offset >= r.volStart && offset < r.volEnd) {
        const lcn = Math.floor((offset - r.volStart) / r.clusterBytes);
        const bIdx = lcn >>> 3;
        return bIdx < r.bitmap.length && (r.bitmap[bIdx] & (1 << (lcn & 7))) !== 0;
      }
    }
    return false;
  };
}
