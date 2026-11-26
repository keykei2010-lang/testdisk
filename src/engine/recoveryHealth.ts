import { computeCrc32 } from './crc32';
import { ExplorerFileItem, RecoveryLikelihoodTier } from './explorerTypes';
import { scanFatAndExfatDeletedInBuffer } from './fatExfat';
import {
  diagnoseNonMediaFile,
  isNonMediaRepairableExtension,
  repairNonMediaBuffer,
} from './documentRepair';
import {
  extractEmbeddedJpegPreview,
  inspectJpegStructure,
  repairAviBuffer,
  repairJpegBuffer,
  repairMkvOrWebmBuffer,
  repairPngBuffer,
  repairRawOrImageBuffer,
} from './imageRepair';
import { inspectMp4Health, rebuildMp4WithMoov } from './mp4Repair';
import { scanNtfsMftRecordsInBuffer } from './ntfsMft';
import { analyzeDiskImage } from './partitions';
import { buildSampleDiskImage } from './sampleDisk';
import { carveDiskBuffer, FILE_FORMATS, identifyBuffer, IdentifyMetadata } from './signatures';

export { extractEmbeddedJpegPreview, repairJpegBuffer, repairPngBuffer, repairAviBuffer, isNonMediaRepairableExtension };

export interface RecoveryLikelihoodAssessment {
  chance: number;
  tier: RecoveryLikelihoodTier;
  label: 'Excellent' | 'Good' | 'Fair' | 'Poor';
  reason: string;
}

function verifyPngIhdrCrc(data: Uint8Array): boolean | null {
  if (
    data.length < 33 ||
    data[0] !== 0x89 ||
    data[1] !== 0x50 ||
    data[2] !== 0x4e ||
    data[3] !== 0x47
  ) {
    return null;
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ihdrLen = dv.getUint32(8, false);
  if (ihdrLen !== 13 || data.length < 33) return false;
  const storedCrc = dv.getUint32(29, false);
  const computedCrc = computeCrc32(data, 12, 17);
  return storedCrc === computedCrc;
}

function zeroByteRatio(data: Uint8Array): number {
  if (data.length < 512) return 0;
  const step = data.length > 65536 ? Math.floor(data.length / 8192) : 1;
  let sampled = 0;
  let zeros = 0;
  for (let i = 64; i < data.length; i += step) {
    sampled++;
    if (data[i] === 0) zeros++;
  }
  return sampled > 0 ? zeros / sampled : 0;
}

export function computeContentFingerprint(size: number, sample: Uint8Array): string {
  const len = Math.min(sample.length, 65536);
  const crc = len > 0 ? computeCrc32(sample, 0, len) : 0;
  return `${size}:${crc.toString(16).padStart(8, '0')}`;
}

export function computeRecoveryLikelihood(params: {
  status: 'OK' | 'OK_TRUNCATED' | 'HEADER_ONLY' | 'UNKNOWN';
  size: number;
  calculatedSize: number | null;
  partitionId: string;
  metadata: IdentifyMetadata;
  extension?: string;
  data?: Uint8Array;
  repaired?: boolean;
  mftResident?: boolean;
  mftOverwritten?: boolean;
  mftBitmapIntact?: boolean;
  sizeEstimated?: boolean;
  ntfsCompressed?: boolean;
  ntfsEncrypted?: boolean;
}): RecoveryLikelihoodAssessment {
  const {
    status,
    size,
    calculatedSize,
    partitionId,
    metadata,
    extension,
    data,
    repaired,
    mftResident,
    mftOverwritten,
    mftBitmapIntact,
    sizeEstimated,
    ntfsCompressed,
    ntfsEncrypted,
  } = params;
  const hasRichMeta = Boolean(metadata.width || metadata.subExtension || metadata.details);
  const inUnallocated = partitionId === 'unallocated';
  const isTruncatedBySize = calculatedSize !== null && calculatedSize > size;

  let chance: number;
  let reason: string;

  if (mftOverwritten) {
    chance = 24;
    reason = 'Filesystem record recovered, but disk clusters were reallocated/overwritten';
  } else if (ntfsEncrypted) {
    chance = 35;
    reason = 'NTFS EFS-encrypted $DATA (raw ciphertext cannot be read without user key)';
  } else if (ntfsCompressed) {
    chance = 55;
    reason = 'NTFS LZNT1/WOF-compressed $DATA requires OS decompression on restore';
  } else if (mftResident) {
    chance = 98;
    reason = 'Resident NTFS MFT payload (stored intact inside MFT record)';
  } else if (mftBitmapIntact && status === 'OK' && !sizeEstimated) {
    chance = 98;
    reason = 'Deleted filesystem entry verified intact via cluster bitmap (0 clusters overwritten)';
  } else if (repaired) {
    chance = 86;
    reason = 'Structural footer/header patched for recovery';
  } else if (sizeEstimated) {
    chance = hasRichMeta ? 72 : 66;
    if (inUnallocated) chance -= 5;
    reason = 'Header matched; size is estimated (payload boundary unframed)';
  } else if (status === 'OK' && !isTruncatedBySize) {
    chance = 93;
    if (calculatedSize !== null && calculatedSize === size) {
      chance += 4;
    }
    if (hasRichMeta) {
      chance += 2;
    }
    if (inUnallocated) {
      chance -= 4;
    }
    reason = inUnallocated
      ? 'Complete header & footer in unallocated clusters'
      : 'Valid magic header and intact EOF/chunk structure';
  } else if (status === 'HEADER_ONLY') {
    chance = hasRichMeta ? 74 : 68;
    if (inUnallocated) chance -= 5;
    reason = 'Valid header matched; payload boundary unframed';
  } else if (status === 'OK_TRUNCATED' || isTruncatedBySize) {
    const ratio =
      calculatedSize && calculatedSize > 0 ? Math.min(1, size / calculatedSize) : 0.6;
    chance = Math.round(35 + ratio * 33);
    if (inUnallocated) chance -= 5;
    reason =
      calculatedSize && calculatedSize > size
        ? `Truncated (${Math.round(ratio * 100)}% of declared ${calculatedSize} B recovered)`
        : 'Valid header found, but EOF/trailer is missing (repairable)';
  } else {
    chance = 24;
    reason = 'No recognized file signature in leading bytes';
  }

  // Real binary integrity checks on payload bytes (PNG CRC32 + JPEG structural markers + zero-wipe density)
  if (!mftOverwritten && !mftResident && !ntfsEncrypted && metadata.jpegValid && (extension === 'jpg' || extension === 'jpeg')) {
    const { hasDqt, hasSof, hasDht } = metadata.jpegValid;
    if (!hasDqt || !hasSof) {
      chance -= 18;
      reason = 'JPEG header missing DQT/SOF frame tables (partial image risk)';
    } else if (hasDht && status === 'OK' && !sizeEstimated) {
      chance = Math.min(100, chance + 1);
    }
  }

  if (data && !ntfsEncrypted) {
    if (extension === 'png') {
      const crcOk = verifyPngIhdrCrc(data);
      if (crcOk === true && status === 'OK' && !sizeEstimated) {
        chance = Math.min(100, chance + 1);
      } else if (crcOk === false) {
        chance -= 28;
        reason = 'PNG IHDR CRC32 checksum mismatch (header corruption)';
      }
    }

    const zRatio = zeroByteRatio(data);
    if (zRatio > 0.85 && extension !== 'bmp' && extension !== 'sqlite') {
      chance -= 25;
      reason = 'High zero-byte density detected (sectors may be wiped)';
    }
  }

  chance = Math.min(100, Math.max(10, Math.round(chance)));
  if (ntfsEncrypted) chance = Math.min(35, chance);
  else if (ntfsCompressed) chance = Math.min(55, chance);
  else if (sizeEstimated) chance = Math.min(74, chance);

  const tier: RecoveryLikelihoodTier =
    chance >= 85 ? 'high' : chance >= 50 ? 'medium' : 'low';
  const label: RecoveryLikelihoodAssessment['label'] =
    chance >= 94 ? 'Excellent' : chance >= 85 ? 'Good' : chance >= 50 ? 'Fair' : 'Poor';

  return { chance, tier, label, reason };
}

export function formatShortDate(ms?: number): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
    return 'Unknown';
  }
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return 'Unknown';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

export function formatCompactCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(count);
}

export interface MediaDiagnosis {
  issue: string;
  canRepair: boolean;
  needsReferenceHint: boolean;
}

export function diagnoseMediaFile(extension: string, data: Uint8Array): MediaDiagnosis {
  const ext = extension.toLowerCase().replace(/^\./, '');
  if (['mp4', 'mov', 'm4v', '3gp'].includes(ext)) {
    const mp4 = inspectMp4Health(data);
    return {
      issue: mp4.issueSummary,
      canRepair: !mp4.valid,
      needsReferenceHint: mp4.missingMoov || mp4.headerlessStream,
    };
  }
  if (ext === 'jpg' || ext === 'jpeg') {
    const jpg = inspectJpegStructure(data);
    if (!jpg.hasSoi || !jpg.hasDqt || !jpg.hasSof) {
      return {
        issue: 'Damaged or missing JPEG DQT/SOF header markers.',
        canRepair: true,
        needsReferenceHint: true,
      };
    }
    if (!jpg.hasDht) {
      return {
        issue: 'Missing JPEG Huffman tables (DHT) before image scan.',
        canRepair: true,
        needsReferenceHint: false,
      };
    }
    if (jpg.hasCorruptEntropyMarkers) {
      return {
        issue: 'Corrupt 0xFF marker bytes inside JPEG entropy scan (causes gray/green shifts).',
        canRepair: true,
        needsReferenceHint: false,
      };
    }
    if (!jpg.hasEoi) {
      return {
        issue: 'Truncated JPEG stream missing EOI (0xFFD9) trailer.',
        canRepair: true,
        needsReferenceHint: false,
      };
    }
    return { issue: 'JPEG container markers & entropy verified.', canRepair: false, needsReferenceHint: false };
  }
  if (ext === 'png') {
    const iend = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
    const tail = data.subarray(Math.max(0, data.length - 12));
    const hasIend = tail.length === 12 && tail.every((b, i) => b === iend[i]);
    const ihdrCrcOk = verifyPngIhdrCrc(data);
    if (ihdrCrcOk === false) {
      return { issue: 'PNG IHDR CRC-32 mismatch (recomputable).', canRepair: true, needsReferenceHint: false };
    }
    if (!hasIend) {
      return { issue: 'Truncated PNG stream missing IEND trailer / IDAT length clamp.', canRepair: true, needsReferenceHint: false };
    }
    return { issue: 'PNG chunks intact.', canRepair: false, needsReferenceHint: false };
  }
  if (['cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'rw2', 'tif', 'tiff'].includes(ext)) {
    return {
      issue: `${ext.toUpperCase()} Camera RAW/TIFF ready for embedded JPEG preview salvage & header check.`,
      canRepair: true,
      needsReferenceHint: false,
    };
  }
  if (ext === 'avi' || ext === 'wav' || ext === 'webp' || ext === 'mkv' || ext === 'webm' || ext === 'gif') {
    return {
      issue: `Container index/length check ready for .${ext.toUpperCase()} structural repair.`,
      canRepair: true,
      needsReferenceHint: false,
    };
  }
  if (isNonMediaRepairableExtension(ext)) {
    return diagnoseNonMediaFile(ext, data);
  }
  return {
    issue: 'Ready for structural inspection & magic-byte header verification.',
    canRepair: false,
    needsReferenceHint: false,
  };
}

/**
 * Structural repair for truncated/damaged carved & recovered media & document buffers:
 * - JPEG EOI, Baseline DHT, RSTn/0xFF entropy sanitizer, Reference Header Transplant & EXIF preview salvage
 * - PNG chunk CRC-32 repair, truncated IDAT length clamping & IEND trailer
 * - Camera RAW (CR2/CR3/NEF/ARW/DNG) & TIFF embedded JPEG preview salvage
 * - AVI idx1 index + avih dwTotalFrames + movi rebuild
 * - MKV / WebM EBML null-tail trim; WebP / GIF / BMP / WAV header & EOF repairs
 * - MP4 / MOV / M4V / 3GP H.264/HEVC SPS parsing, headerless salvage, moov + dual-track audio synthesis
 * - ZIP / DOCX / XLSX / PPTX / ODT / EPUB / APK / JAR / KRA / ORA Central Directory & EOCD rebuild
 * - Adobe After Effects (.aep RIFX / .aepx XML), Photoshop (.psd/.psb), PDF xref/startxref, SQLite pageCount/WAL,
 *   OLE2 (.doc/.xls/.ppt/.msg), Outlook (.pst/.ost), Ren'Py (.rpa/.rpy), JSON/XML/SVG/TAR/GZ/MP3/FLAC
 */
export function repairFileBuffer(
  extension: string,
  data: Uint8Array,
  referenceBytes?: Uint8Array,
): { repaired: boolean; data: Uint8Array; note: string; salvagedPreviewBytes?: Uint8Array } {
  const ext = extension.toLowerCase().replace(/^\./, '');

  if (ext === 'jpg' || ext === 'jpeg') {
    return repairJpegBuffer(data, referenceBytes);
  }

  if (ext === 'png') {
    return repairPngBuffer(data);
  }

  if (ext === 'avi') {
    return repairAviBuffer(data);
  }

  if (ext === 'mkv' || ext === 'webm') {
    return repairMkvOrWebmBuffer(data);
  }

  if (['webp', 'gif', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'rw2', 'tif', 'tiff'].includes(ext)) {
    return repairRawOrImageBuffer(ext, data);
  }

  if (ext === 'wav' && data.length >= 12) {
    const patched = data.slice();
    const dv = new DataView(patched.buffer);
    dv.setUint32(4, Math.max(4, patched.length - 8), true);
    if (patched.length >= 44) {
      dv.setUint32(40, Math.max(0, patched.length - 44), true);
    }
    return {
      repaired: true,
      data: patched,
      note: 'Recalculated WAV RIFF & data chunk payload length.',
    };
  }

  if ((ext === 'mp4' || ext === 'mov' || ext === 'm4v' || ext === '3gp') && data.length >= 16) {
    return rebuildMp4WithMoov(data, referenceBytes);
  }

  if (ext === 'bmp' && data.length >= 18) {
    const patched = data.slice();
    const dv = new DataView(patched.buffer);
    dv.setUint32(2, patched.length, true);
    return {
      repaired: true,
      data: patched,
      note: 'Updated BMP bfSize header field to recovered byte length.',
    };
  }

  if (isNonMediaRepairableExtension(ext)) {
    return repairNonMediaBuffer(ext, data);
  }

  return {
    repaired: false,
    data,
    note: 'Header and structure did not require patching.',
  };
}

const ZIP_CONTAINER_EXTS = new Set([
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
  'zip',
]);

const OLE2_CONTAINER_EXTS = new Set(['doc', 'xls', 'ppt', 'msi', 'msg']);

/**
 * Magic-header extension auto-correction (Digger-inspired):
 * Fixes missing, `.bin`, `.unknown`, or mismatched extensions using signature detection,
 * while preserving specialized ZIP (OOXML/ODF/EPUB/APK) & OLE2 office extensions.
 */
export function resolvePreferredExtension(filename: string, detectedExt?: string): string {
  const cleanDetected = String(detectedExt || '')
    .trim()
    .toLowerCase()
    .replace(/^\./, '');
  if (!cleanDetected || cleanDetected === 'unknown' || cleanDetected === 'bin') {
    return filename;
  }

  const lastDot = filename.lastIndexOf('.');
  const curExt = lastDot > 0 ? filename.slice(lastDot + 1).toLowerCase() : '';
  const stem = lastDot > 0 ? filename.slice(0, lastDot) : filename;

  if (!curExt || curExt === 'bin' || curExt === 'unknown' || curExt === 'tmp') {
    return `${stem}.${cleanDetected}`;
  }
  if (curExt === cleanDetected) return filename;
  if ((curExt === 'jpeg' && cleanDetected === 'jpg') || (curExt === 'jpg' && cleanDetected === 'jpeg')) {
    return filename;
  }
  if ((curExt === 'tiff' && cleanDetected === 'tif') || (curExt === 'tif' && cleanDetected === 'tiff')) {
    return filename;
  }
  if (cleanDetected === 'zip' && ZIP_CONTAINER_EXTS.has(curExt)) {
    return filename;
  }
  if (cleanDetected === 'doc' && OLE2_CONTAINER_EXTS.has(curExt)) {
    return filename;
  }
  return `${stem}.${cleanDetected}`;
}

function escapeCsvCell(raw: string | number | boolean | undefined | null): string {
  const s = raw === undefined || raw === null ? '' : String(raw);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildCsvReport(items: ExplorerFileItem[], diskName: string): string {
  const headers = [
    'Disk / Source',
    'Filename',
    'Extension',
    'Family',
    'Size Bytes',
    'Status',
    'Recovery Chance %',
    'Recovery Reason',
    'Source Engine',
    'Deleted',
    'Partition / Origin',
    'Original Path',
    'Offset Hex',
    'Sector',
    'CRC32 Fingerprint',
  ];
  const rows = [headers.map(escapeCsvCell).join(',')];
  for (const item of items) {
    rows.push(
      [
        diskName,
        item.filename,
        item.extension,
        item.family,
        item.size,
        item.repaired ? 'REPAIRED' : item.status,
        item.recoveryChance,
        item.recoveryReason,
        item.sourceKind,
        item.isDeleted === false ? 'No' : 'Yes',
        item.partitionName,
        item.originalPath || '',
        `0x${item.offset.toString(16)}`,
        item.sector,
        item.discoveryCrc32 !== undefined
          ? item.discoveryCrc32.toString(16).padStart(8, '0')
          : item.contentFingerprint || '',
      ]
        .map(escapeCsvCell)
        .join(','),
    );
  }
  return rows.join('\r\n');
}

export interface RecoverySelfTestCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface RecoverySelfTestResult {
  passed: boolean;
  durationMs: number;
  sha256Hex: string;
  checks: RecoverySelfTestCheck[];
}

async function computeSha256Hex(bytes: Uint8Array): Promise<string> {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.slice().buffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  const crc = computeCrc32(bytes, 0, bytes.length);
  return `crc32-${crc.toString(16).padStart(8, '0')}`;
}

export async function runRecoverySelfTest(): Promise<RecoverySelfTestResult> {
  const t0 = Date.now();
  const checks: RecoverySelfTestCheck[] = [];
  const sample = buildSampleDiskImage();

  // 1. MBR + Lost Partition Detection
  const analysis = analyzeDiskImage(sample.name, sample.bytes);
  const lost = analysis.partitions.find((p) => p.status === 'Deleted / Lost');
  checks.push({
    name: 'MBR + Lost Partition Rescue',
    passed: Boolean(analysis.mbrSignatureValid && lost),
    detail: lost
      ? `Detected MBR + lost ${lost.detectedFs?.filesystem ?? 'NTFS'} partition at LBA ${lost.startLba}`
      : 'Failed to locate lost partition',
  });

  // 2. NTFS $MFT Record + Path + SHA-256 Reconstruction
  const mft = scanNtfsMftRecordsInBuffer(sample.bytes, analysis.partitions, { includeExisting: true });
  const tax = mft.find((r) => r.filename === 'Tax_Return_2025_Deleted.txt');
  const taxHash = tax ? await computeSha256Hex(tax.reconstructedBytes) : '';
  const taxOk = Boolean(
    tax &&
      tax.isDeleted &&
      tax.reconstructedPath === '\\Finance_2025\\Tax_Return_2025_Deleted.txt' &&
      taxHash.length >= 16,
  );
  checks.push({
    name: 'NTFS $MFT Deleted Record & Path',
    passed: taxOk,
    detail: taxOk
      ? `${tax!.reconstructedPath} (${tax!.reconstructedBytes.length} B, SHA-256 ${taxHash.slice(0, 12)}...)`
      : 'Failed to reconstruct deleted NTFS MFT record',
  });

  // 3. FAT32 LFN Deleted File + Signature Verification
  const fat = scanFatAndExfatDeletedInBuffer(sample.bytes, analysis.partitions, {
    includeExisting: true,
  });
  const beach = fat.find((f) => f.filename === 'Vacation_Beach_Deleted.jpg');
  const beachId = beach ? identifyBuffer(beach.reconstructedBytes) : null;
  const beachOk = Boolean(beach && beach.isDeleted && beachId?.extension === 'jpg' && beachId.status === 'OK');
  checks.push({
    name: 'FAT32 LFN Deleted JPEG Recovery',
    passed: beachOk,
    detail: beachOk
      ? `Recovered ${beach!.filename} (${beach!.reconstructedBytes.length} B)`
      : 'Failed to recover FAT32 LFN JPEG',
  });

  // 4. Raw Sector Carving + Discovery CRC-32 Checksum Verification
  const enabled = new Set(FILE_FORMATS.map((f) => f.id));
  const carved = carveDiskBuffer(sample.bytes, {
    startByte: 0,
    endByte: sample.bytes.length,
    blockSize: 512,
    paranoid: true,
    keepCorrupted: true,
    enabledFormats: enabled,
  });
  const crcMatch =
    carved.length > 0 &&
    carved.every(
      (c) =>
        c.discoveryCrc32 === computeCrc32(c.data, 0, Math.min(65536, c.data.length)),
    );
  checks.push({
    name: 'Raw Signature Carving + Discovery CRC-32',
    passed: carved.length >= 2 && crcMatch,
    detail: `Carved ${carved.length} raw streams · CRC-32 ${crcMatch ? 'verified' : 'mismatch'}`,
  });

  // 5. MP4 moov Atom Synthesis
  const brokenMp4 = new Uint8Array([
    0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x00, 0x00, 0x00, 0x21, 0x6d, 0x64, 0x61, 0x74,
    0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0xc0, 0x1e,
    0x00, 0x00, 0x00, 0x01, 0x68, 0xce, 0x38, 0x80,
    0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x21, 0xa0,
  ]);
  const mp4Rep = rebuildMp4WithMoov(brokenMp4);
  checks.push({
    name: 'Truncated MP4 moov Synthesis',
    passed: mp4Rep.repaired,
    detail: mp4Rep.repaired ? mp4Rep.note : 'MP4 moov synthesis failed',
  });

  return {
    passed: checks.every((c) => c.passed),
    durationMs: Math.max(1, Date.now() - t0),
    sha256Hex: taxHash,
    checks,
  };
}
