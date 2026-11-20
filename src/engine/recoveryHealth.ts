import { computeCrc32 } from './crc32';
import { RecoveryLikelihoodTier } from './explorerTypes';
import { IdentifyMetadata } from './signatures';

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
  } = params;
  const hasRichMeta = Boolean(metadata.width || metadata.subExtension || metadata.details);
  const inUnallocated = partitionId === 'unallocated';
  const isTruncatedBySize = calculatedSize !== null && calculatedSize > size;

  let chance: number;
  let reason: string;

  if (mftOverwritten) {
    chance = 24;
    reason = 'Filesystem record recovered, but disk clusters were reallocated/overwritten';
  } else if (mftResident) {
    chance = 98;
    reason = 'Resident NTFS MFT payload (stored intact inside MFT record)';
  } else if (mftBitmapIntact && status === 'OK') {
    chance = 98;
    reason = 'Deleted filesystem entry verified intact via cluster bitmap (0 clusters overwritten)';
  } else if (repaired) {
    chance = 86;
    reason = 'Structural footer/header patched for recovery';
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
  if (!mftOverwritten && !mftResident && metadata.jpegValid && (extension === 'jpg' || extension === 'jpeg')) {
    const { hasDqt, hasSof, hasDht } = metadata.jpegValid;
    if (!hasDqt || !hasSof) {
      chance -= 18;
      reason = 'JPEG header missing DQT/SOF frame tables (partial image risk)';
    } else if (hasDht && status === 'OK') {
      chance = Math.min(100, chance + 1);
    }
  }

  if (data) {
    if (extension === 'png') {
      const crcOk = verifyPngIhdrCrc(data);
      if (crcOk === true && status === 'OK') {
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

  const tier: RecoveryLikelihoodTier =
    chance >= 85 ? 'high' : chance >= 50 ? 'medium' : 'low';
  const label: RecoveryLikelihoodAssessment['label'] =
    chance >= 94 ? 'Excellent' : chance >= 85 ? 'Good' : chance >= 50 ? 'Fair' : 'Poor';

  return { chance, tier, label, reason };
}

/**
 * Deterministic timestamp derived from sector offset when carving raw sectors
 * without directory-entry timestamps.
 */
export function deriveCarvedTimestamp(sector: number, partitionId: string): number {
  const baseMs = Date.UTC(2026, 10, 18, 18, 30, 0);
  const partShiftHours = partitionId.startsWith('lost-')
    ? 96
    : partitionId === 'unallocated'
      ? 168
      : 12;
  const sectorSpreadMins = (sector % 720) * 3;
  return baseMs - (partShiftHours * 60 + sectorSpreadMins) * 60 * 1000;
}

export function formatShortDate(ms: number): string {
  const d = new Date(ms);
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

/**
 * Structural repair for truncated/damaged carved buffers:
 * - JPEG EOI (0xFFD9)
 * - PNG IEND + CRC
 * - PDF %%EOF trailer
 * - RIFF WAV/AVI/WEBP length patching
 * - BMP bfSize header patching
 * - MP4 / MOV ISO BMFF atom size patching & tail cleanup (Smart Video Reorganization)
 */
export function repairFileBuffer(
  extension: string,
  data: Uint8Array,
): { repaired: boolean; data: Uint8Array; note: string } {
  const ext = extension.toLowerCase();

  if (ext === 'jpg' || ext === 'jpeg') {
    const hasEoi =
      data.length >= 2 && data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9;
    if (!hasEoi) {
      const patched = new Uint8Array(data.length + 2);
      patched.set(data, 0);
      patched[data.length] = 0xff;
      patched[data.length + 1] = 0xd9;
      return {
        repaired: true,
        data: patched,
        note: 'Appended missing JPEG EOI (0xFFD9) marker.',
      };
    }
  }

  if (ext === 'png') {
    const iend = new Uint8Array([
      0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const tail = data.subarray(Math.max(0, data.length - 12));
    const alreadyHasIend =
      tail.length === 12 && tail.every((b, idx) => b === iend[idx]);
    if (!alreadyHasIend) {
      const patched = new Uint8Array(data.length + 12);
      patched.set(data, 0);
      patched.set(iend, data.length);
      return {
        repaired: true,
        data: patched,
        note: 'Appended valid PNG IEND chunk and CRC.',
      };
    }
  }

  if (ext === 'pdf') {
    const tailText = new TextDecoder().decode(data.subarray(Math.max(0, data.length - 32)));
    if (!tailText.includes('%%EOF')) {
      const suffix = new TextEncoder().encode('\n%%EOF\n');
      const patched = new Uint8Array(data.length + suffix.length);
      patched.set(data, 0);
      patched.set(suffix, data.length);
      return {
        repaired: true,
        data: patched,
        note: 'Appended missing %%EOF trailer to PDF stream.',
      };
    }
  }

  if ((ext === 'wav' || ext === 'avi' || ext === 'webp') && data.length >= 12) {
    const patched = data.slice();
    const dv = new DataView(patched.buffer);
    dv.setUint32(4, Math.max(4, patched.length - 8), true);
    if (ext === 'wav' && patched.length >= 44) {
      dv.setUint32(40, Math.max(0, patched.length - 44), true);
    }
    return {
      repaired: true,
      data: patched,
      note: 'Recalculated RIFF header payload length.',
    };
  }

  if ((ext === 'mp4' || ext === 'mov' || ext === 'm4v') && data.length >= 16) {
    const patched = data.slice();
    const dv = new DataView(patched.buffer);
    let pos = 0;
    let changed = false;

    while (pos + 8 <= patched.length) {
      const size = dv.getUint32(pos, false);
      const type = String.fromCharCode(
        patched[pos + 4],
        patched[pos + 5],
        patched[pos + 6],
        patched[pos + 7],
      );
      if (!/^[\x20-\x7e]{4}$/.test(type)) break;

      if (size === 0 || pos + size > patched.length) {
        const clamped = patched.length - pos;
        if (clamped >= 8) {
          dv.setUint32(pos, clamped, false);
          changed = true;
        }
        break;
      }
      if (size < 8) break;
      pos += size;
    }

    if (changed) {
      return {
        repaired: true,
        data: patched,
        note: 'Reorganized ISO BMFF atom sizes and patched truncated mdat container length.',
      };
    }
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

  return {
    repaired: false,
    data,
    note: 'Header and structure did not require patching.',
  };
}
