import { computeCrc32 } from './crc32';
import { rebuildMp4WithMoov } from './mp4Repair';
import type { CarvedFile } from './signatures';

export interface VideoRun {
  offset: number;
  length: number;
}

const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v', '3gp']);

function readU32BE(b: Uint8Array, p: number): number {
  return (((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0);
}

function isForeignSignatureStart(b: Uint8Array, off: number, len: number): boolean {
  if (off + 8 > len) return false;
  const b0 = b[off];
  const b1 = b[off + 1];
  const b2 = b[off + 2];
  const b3 = b[off + 3];
  // JPEG, PNG, GIF, PDF, ZIP, RAR, 7z, SQLite, MZ/PE, ELF, RIFF, TIFF, PSD
  if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) return true;
  if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47) return true;
  if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46 && b3 === 0x38) return true;
  if (b0 === 0x25 && b1 === 0x50 && b2 === 0x44 && b3 === 0x46) return true;
  if (b0 === 0x50 && b1 === 0x4b && b2 === 0x03 && b3 === 0x04) return true;
  if (b0 === 0xd0 && b1 === 0xcf && b2 === 0x11 && b3 === 0xe0) return true;
  if (b0 === 0x52 && b1 === 0x61 && b2 === 0x72 && b3 === 0x21) return true;
  if (b0 === 0x37 && b1 === 0x7a && b2 === 0xbc && b3 === 0xaf) return true;
  if (b0 === 0x53 && b1 === 0x51 && b2 === 0x4c && b3 === 0x69) return true;
  if (b0 === 0x38 && b1 === 0x42 && b2 === 0x50 && b3 === 0x53) return true;
  if (b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && (b3 === 0x46 || b3 === 0x58)) return true;
  if (b0 === 0x7f && b1 === 0x45 && b2 === 0x4c && b3 === 0x46) return true;
  if (off + 8 <= b.length && b[off + 4] === 0x66 && b[off + 5] === 0x74 && b[off + 6] === 0x79 && b[off + 7] === 0x70) {
    return true;
  }
  return false;
}

function isZeroOrAsciiNoiseBlock(b: Uint8Array, off: number, len: number, allowSlackTail = false): boolean {
  const end = Math.min(b.length, off + len);
  if (end - off < 16) return true;
  let zeros = 0;
  let printable = 0;
  const count = end - off;
  for (let i = off; i < end; i++) {
    const v = b[i];
    if (v === 0) zeros++;
    else if (v === 9 || v === 10 || v === 13 || (v >= 32 && v <= 126)) printable++;
  }
  const nonZero = count - zeros;
  if (allowSlackTail) {
    // Allow partially filled tail sectors/clusters (>= 16 non-zero bytes), reject wiped or ASCII-dominated sectors
    if (nonZero < 16) return true;
    if (nonZero >= 24 && printable / nonZero > 0.92) return true;
    return false;
  }
  if (zeros / count > 0.92) return true;
  if (nonZero >= 24 && printable / nonZero > 0.92) return true;
  return false;
}

function isValidAvcNalHeader(h: number): boolean {
  if ((h & 0x80) !== 0) return false;
  const nalType = h & 0x1f;
  return nalType >= 1 && nalType <= 12;
}

function isValidHevcNalHeader(h0: number, h1: number): boolean {
  if ((h0 & 0x80) !== 0) return false;
  const nalType = (h0 >>> 1) & 0x3f;
  const tid = h1 & 0x07;
  return tid >= 1 && (nalType <= 21 || (nalType >= 32 && nalType <= 40));
}

/**
 * Scores how strongly a disk sector/cluster resembles continuation video/audio payload (AVCC, HVCC, Annex-B, or ADTS).
 */
export function scoreVideoContinuationCluster(
  disk: Uint8Array,
  offset: number,
  len: number,
  codecHint: 'h264' | 'hevc' | 'auto' = 'auto',
): { isVideo: boolean; score: number; hasMoovEnd: boolean } {
  const end = Math.min(disk.length, offset + len);
  if (end - offset < 16) return { isVideo: false, score: 0, hasMoovEnd: false };
  if (isForeignSignatureStart(disk, offset, end) || isZeroOrAsciiNoiseBlock(disk, offset, end - offset, true)) {
    return { isVideo: false, score: 0, hasMoovEnd: false };
  }

  // Detect `moov` or `free` box header inside continuation cluster
  let hasMoovEnd = false;
  for (let i = offset; i + 8 <= end; i += 4) {
    if (
      disk[i + 4] === 0x6d &&
      disk[i + 5] === 0x6f &&
      disk[i + 6] === 0x6f &&
      disk[i + 7] === 0x76
    ) {
      const sz = readU32BE(disk, i);
      if (sz >= 16 && sz <= 16 * 1024 * 1024) {
        hasMoovEnd = true;
        break;
      }
    }
  }

  let nalScore = 0;
  let seenSingleSlice = false;

  // 1. Check AVCC/HVCC 4-byte length-prefixed NAL chain starting within the first 256 bytes
  const probeLimit = Math.min(end - 8, offset + 256);
  for (let start = offset; start < probeLimit; start += 2) {
    let p = start;
    let chain = 0;
    let seenVideoSlice = false;
    while (p + 6 <= end && chain < 12) {
      const nalLen = readU32BE(disk, p);
      if (nalLen < 2 || nalLen > 4 * 1024 * 1024) break;
      const h0 = disk[p + 4];
      const h1 = disk[p + 5];
      const avcOk = codecHint !== 'hevc' && isValidAvcNalHeader(h0);
      const hevcOk = codecHint !== 'h264' && isValidHevcNalHeader(h0, h1);
      if (!avcOk && !hevcOk) break;
      const avcType = h0 & 0x1f;
      if (avcOk && (avcType === 1 || avcType === 5 || avcType === 7 || avcType === 8)) {
        seenVideoSlice = true;
      }
      if (hevcOk) seenVideoSlice = true;
      chain++;
      if (p + 4 + nalLen >= end) break;
      p += 4 + nalLen;
    }
    if (chain >= 2 && seenVideoSlice) {
      nalScore = Math.max(nalScore, chain * 3);
      break;
    }
    if (chain === 1 && seenVideoSlice && start === offset) {
      seenSingleSlice = true;
      if (readU32BE(disk, start) >= 64) {
        nalScore = Math.max(nalScore, 4);
      } else {
        nalScore = Math.max(nalScore, 2);
      }
    }
  }

  // 2. Check Annex-B `00 00 00 01` NAL headers
  let annexHits = 0;
  for (let i = offset; i + 5 <= end; i++) {
    if (disk[i] === 0 && disk[i + 1] === 0 && disk[i + 2] === 0 && disk[i + 3] === 1) {
      if (isValidAvcNalHeader(disk[i + 4]) || (i + 5 < end && isValidHevcNalHeader(disk[i + 4], disk[i + 5]))) {
        annexHits++;
        i += 4;
      }
    }
  }
  const annexScore = annexHits >= 2 ? annexHits * 3 : annexHits === 1 ? 2 : 0;

  // 3. Check ADTS AAC audio frame sync transitions (0xFF F1 / 0xFF F9 -> frameLen -> 0xFF F1 / 0xFF F9)
  let adtsTransitions = 0;
  for (let i = offset; i + 7 <= end; i++) {
    if (disk[i] === 0xff && (disk[i + 1] & 0xf6) === 0xf0) {
      const frameLen = (((disk[i + 3] & 0x03) << 11) | (disk[i + 4] << 3) | ((disk[i + 5] >>> 5) & 0x07)) >>> 0;
      if (frameLen >= 7 && frameLen <= 4096) {
        if (i + frameLen + 2 <= end && disk[i + frameLen] === 0xff && (disk[i + frameLen + 1] & 0xf6) === 0xf0) {
          adtsTransitions++;
          i += frameLen - 1;
        }
      }
    }
  }
  // 1 valid ADTS transition already proves 2 consecutive ADTS frames with matching exact frameLen
  const adtsScore = adtsTransitions >= 2 ? adtsTransitions * 2 + 1 : adtsTransitions === 1 ? (seenSingleSlice || annexHits > 0 ? 3 : 2) : 0;

  const totalScore = (hasMoovEnd ? 3 : 0) + Math.max(nalScore, annexScore) + adtsScore;
  const bestScore = Math.max(hasMoovEnd ? 3 : 0, nalScore, annexScore, adtsScore, totalScore >= 4 ? totalScore : 0);

  return { isVideo: bestScore >= 4, score: bestScore, hasMoovEnd };
}

function detectCodecHint(buf: Uint8Array): 'h264' | 'hevc' | 'auto' {
  const lim = Math.min(buf.length, 65536);
  for (let i = 0; i + 8 < lim; i++) {
    if (buf[i] === 0x61 && buf[i + 1] === 0x76 && buf[i + 2] === 0x63 && buf[i + 3] === 0x31) return 'h264';
    if ((buf[i] === 0x68 && buf[i + 1] === 0x76 && buf[i + 2] === 0x63 && buf[i + 3] === 0x31) ||
        (buf[i] === 0x68 && buf[i + 1] === 0x65 && buf[i + 2] === 0x76 && buf[i + 3] === 0x31)) {
      return 'hevc';
    }
  }
  return 'auto';
}

function isOffsetInsideNonVideoFile(offset: number, nonVideoRanges: { start: number; end: number }[]): boolean {
  for (const r of nonVideoRanges) {
    if (offset >= r.start && offset < r.end) return true;
  }
  return false;
}

/**
 * Non-contiguous & interleaved video frame reassembly across unallocated clusters:
 * Walks carved MP4/MOV/M4V/3GP files, truncates any contiguous initial extent cleanly before foreign gaps,
 * locates orphaned AVCC/HVCC/Annex-B/ADTS continuation clusters later on disk, stitches multi-extent `runs`,
 * and optionally synthesizes a valid `moov` container when missing.
 */
export function stitchFragmentedVideosInBuffer(
  diskBytes: Uint8Array,
  carvedFiles: CarvedFile[],
  options?: {
    blockSize?: number;
    maxSearchWindowBytes?: number;
    allocatedChecker?: (offset: number) => boolean;
    unallocatedOnly?: boolean;
  },
): CarvedFile[] {
  if (carvedFiles.length === 0 || diskBytes.length < 1024) return carvedFiles;

  const step = Math.max(512, options?.blockSize ?? 512);
  const maxSearch = options?.maxSearchWindowBytes ?? 16 * 1024 * 1024;

  const nonVideoRanges = carvedFiles
    .filter((f) => !VIDEO_EXTS.has(f.extension.toLowerCase()))
    .map((f) => ({ start: f.offset, end: f.offset + Math.max(step, f.size) }));

  return carvedFiles.map((file) => {
    const ext = file.extension.toLowerCase();
    if (!VIDEO_EXTS.has(ext)) return file;

    const codecHint = detectCodecHint(file.data);
    // Find `mdat` header inside lead segment
    let mdatOffset = -1;
    let cursor = file.offset;
    const headScanEnd = Math.min(diskBytes.length, file.offset + 4096);
    while (cursor + 8 <= headScanEnd) {
      const sz = readU32BE(diskBytes, cursor);
      const tp = String.fromCharCode(diskBytes[cursor + 4], diskBytes[cursor + 5], diskBytes[cursor + 6], diskBytes[cursor + 7]);
      if (tp === 'mdat') {
        mdatOffset = cursor;
        break;
      }
      if (sz < 8 || cursor + sz > headScanEnd) break;
      cursor += sz;
    }
    if (mdatOffset < 0) return file;

    // 1. Walk Fragment 1 forward cluster-by-cluster until foreign interruption or clean EOF
    const initialStart = file.offset;
    const declaredEnd = Math.min(diskBytes.length, file.offset + Math.max(file.size, file.calculatedSize ?? file.size));
    let frag1End = Math.min(declaredEnd, mdatOffset + step);
    let sawInterruption = false;

    for (let pos = mdatOffset + step; pos + 64 <= declaredEnd; pos += step) {
      if (
        isOffsetInsideNonVideoFile(pos, nonVideoRanges) ||
        isForeignSignatureStart(diskBytes, pos, Math.min(diskBytes.length, pos + step)) ||
        isZeroOrAsciiNoiseBlock(diskBytes, pos, Math.min(step, diskBytes.length - pos))
      ) {
        sawInterruption = true;
        break;
      }
      frag1End = Math.min(declaredEnd, pos + step);
    }

    // Also inspect beyond declaredEnd if file is truncated and no interruption happened yet
    if (!sawInterruption && file.status === 'OK_TRUNCATED') {
      const extScanLimit = Math.min(diskBytes.length, frag1End + 2 * 1024 * 1024);
      for (let pos = frag1End; pos + 64 <= extScanLimit; pos += step) {
        if (options?.unallocatedOnly && options.allocatedChecker?.(pos)) {
          sawInterruption = true;
          break;
        }
        if (isOffsetInsideNonVideoFile(pos, nonVideoRanges)) {
          sawInterruption = true;
          break;
        }
        const probe = scoreVideoContinuationCluster(diskBytes, pos, Math.min(step, extScanLimit - pos), codecHint);
        if (!probe.isVideo) {
          sawInterruption = true;
          break;
        }
        frag1End = Math.min(extScanLimit, pos + step);
        if (probe.hasMoovEnd) break;
      }
    }

    const runs: VideoRun[] = [{ offset: initialStart, length: Math.max(0, frag1End - initialStart) }];
    if (!sawInterruption && file.status === 'OK') {
      return file;
    }

    // 2. Scan forward across interleaved/non-contiguous sectors for orphaned continuation runs
    const scanStart = Math.ceil((frag1End + step) / step) * step;
    const scanEnd = Math.min(diskBytes.length, scanStart + maxSearch);
    let activeRunStart = -1;
    let activeRunEnd = -1;
    let foundMoov = false;

    for (let pos = scanStart; pos + 64 <= scanEnd; pos += step) {
      if (options?.unallocatedOnly && options.allocatedChecker?.(pos)) {
        if (activeRunStart !== -1) {
          runs.push({ offset: activeRunStart, length: activeRunEnd - activeRunStart });
          activeRunStart = -1;
        }
        continue;
      }
      if (isOffsetInsideNonVideoFile(pos, nonVideoRanges)) {
        if (activeRunStart !== -1) {
          runs.push({ offset: activeRunStart, length: activeRunEnd - activeRunStart });
          activeRunStart = -1;
        }
        continue;
      }

      const chunkLen = Math.min(step, scanEnd - pos);
      const probe = scoreVideoContinuationCluster(diskBytes, pos, chunkLen, codecHint);
      if (probe.isVideo) {
        if (activeRunStart === -1) activeRunStart = pos;
        activeRunEnd = pos + chunkLen;
        if (probe.hasMoovEnd) {
          runs.push({ offset: activeRunStart, length: activeRunEnd - activeRunStart });
          activeRunStart = -1;
          foundMoov = true;
          break;
        }
      } else if (activeRunStart !== -1) {
        runs.push({ offset: activeRunStart, length: activeRunEnd - activeRunStart });
        activeRunStart = -1;
        if (runs.length >= 16) break;
      }
    }

    if (activeRunStart !== -1) {
      runs.push({ offset: activeRunStart, length: activeRunEnd - activeRunStart });
    }

    if (runs.length <= 1) {
      return file;
    }

    // 3. Merge multi-extent payload & update mdat container size so moov builder indexes all stitched frames!
    const totalLen = runs.reduce((s, r) => s + r.length, 0);
    const stitched = new Uint8Array(totalLen);
    let w = 0;
    for (const r of runs) {
      stitched.set(diskBytes.subarray(r.offset, r.offset + r.length), w);
      w += r.length;
    }

    const relMdat = mdatOffset - initialStart;
    if (!foundMoov && relMdat >= 0 && relMdat + 8 <= stitched.length) {
      const mdatLen = stitched.length - relMdat;
      stitched[relMdat] = (mdatLen >>> 24) & 0xff;
      stitched[relMdat + 1] = (mdatLen >>> 16) & 0xff;
      stitched[relMdat + 2] = (mdatLen >>> 8) & 0xff;
      stitched[relMdat + 3] = mdatLen & 0xff;
    }

    // Auto-synthesize moov if stream lacks moov so stitched fragmented video plays immediately!
    const moovRes = rebuildMp4WithMoov(stitched);
    const finalBytes = moovRes.repaired ? moovRes.data : stitched;
    const isNowOk = foundMoov || moovRes.repaired;

    return {
      ...file,
      size: finalBytes.length,
      calculatedSize: finalBytes.length,
      status: isNowOk ? 'OK' : 'OK_TRUNCATED',
      data: finalBytes,
      runs,
      discoveryCrc32: computeCrc32(finalBytes, 0, Math.min(65536, finalBytes.length)),
      metadata: {
        ...file.metadata,
        details: `${file.metadata.details || `${ext.toUpperCase()} stream`} · stitched ${runs.length} non-contiguous fragments${moovRes.repaired ? ' + moov rebuilt' : ''}`,
      },
    };
  });
}
