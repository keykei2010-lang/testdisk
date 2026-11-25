interface Mp4Box {
  type: string;
  offset: number;
  size: number;
  headerSize: number;
}

interface TrackSample {
  offset: number; // offset relative to mdat payload start
  size: number;
  isKey: boolean;
}

export interface Mp4HealthReport {
  valid: boolean;
  hasFtyp: boolean;
  hasMoov: boolean;
  hasMdat: boolean;
  isFragmented: boolean;
  codec: 'h264' | 'hevc' | 'unknown';
  hasAudio: boolean;
  missingMoov: boolean;
  truncatedTail: boolean;
  headerlessStream: boolean;
  width?: number;
  height?: number;
  issueSummary: string;
}

interface ReferenceVideoConfig {
  codec: 'h264' | 'hevc';
  codecBoxType: 'avc1' | 'hvc1' | 'hev1';
  configBox?: Uint8Array; // avcC or hvcC full box
  width: number;
  height: number;
  timescale: number;
  sampleDelta: number;
}

interface ReferenceAudioConfig {
  codecType: string; // e.g. 'mp4a', 'sowt', 'twos', 'lpcm'
  stsdEntryBox: Uint8Array; // full audio sample entry box
  timescale: number;
  sampleDelta: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

function readU32BE(buf: Uint8Array, pos: number): number {
  return (
    ((buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]) >>> 0
  );
}

function writeU32BE(buf: Uint8Array, pos: number, val: number): void {
  buf[pos] = (val >>> 24) & 0xff;
  buf[pos + 1] = (val >>> 16) & 0xff;
  buf[pos + 2] = (val >>> 8) & 0xff;
  buf[pos + 3] = val & 0xff;
}

function writeU64BE(buf: Uint8Array, pos: number, val: number): void {
  const hi = Math.floor(val / 4294967296);
  const lo = val >>> 0;
  writeU32BE(buf, pos, hi);
  writeU32BE(buf, pos + 4, lo);
}

function writeU16BE(buf: Uint8Array, pos: number, val: number): void {
  buf[pos] = (val >>> 8) & 0xff;
  buf[pos + 1] = val & 0xff;
}

function asciiBytes(str: string): Uint8Array {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i);
  return out;
}

function makeBox(type: string, ...parts: Uint8Array[]): Uint8Array {
  const payloadLen = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(8 + payloadLen);
  writeU32BE(out, 0, out.length);
  out.set(asciiBytes(type.slice(0, 4)), 4);
  let cursor = 8;
  for (const p of parts) {
    out.set(p, cursor);
    cursor += p.length;
  }
  return out;
}

function makeFullBox(
  type: string,
  version: number,
  flags: number,
  ...parts: Uint8Array[]
): Uint8Array {
  const vf = new Uint8Array(4);
  vf[0] = version & 0xff;
  vf[1] = (flags >>> 16) & 0xff;
  vf[2] = (flags >>> 8) & 0xff;
  vf[3] = flags & 0xff;
  return makeBox(type, vf, ...parts);
}

// Removes Annex-B emulation prevention bytes (0x00 0x00 0x03 -> 0x00 0x00) for SPS RBSP parsing
function stripEmulationBytes(nal: Uint8Array, maxOut = 128): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < nal.length && out.length < maxOut; i++) {
    if (i >= 2 && nal[i] === 0x03 && nal[i - 1] === 0x00 && nal[i - 2] === 0x00) {
      continue;
    }
    out.push(nal[i]);
  }
  return new Uint8Array(out);
}

class BitReader {
  private bitPos = 0;
  constructor(private readonly data: Uint8Array) {}

  readBits(n: number): number {
    let val = 0;
    for (let i = 0; i < n; i++) {
      const byteIdx = this.bitPos >>> 3;
      if (byteIdx >= this.data.length) return 0;
      const bitIdx = 7 - (this.bitPos & 7);
      val = (val << 1) | ((this.data[byteIdx] >>> bitIdx) & 1);
      this.bitPos++;
    }
    return val;
  }

  readUE(): number {
    let zeros = 0;
    while (this.bitPos < this.data.length * 8 && this.readBits(1) === 0 && zeros < 24) {
      zeros++;
    }
    if (zeros === 0) return 0;
    return ((1 << zeros) - 1) + this.readBits(zeros);
  }

  readSE(): number {
    const code = this.readUE();
    return (code & 1) !== 0 ? (code + 1) >> 1 : -(code >> 1);
  }
}

export function parseH264SpsDimensions(sps: Uint8Array): { width: number; height: number; fps?: number } | null {
  if (!sps || sps.length < 4 || (sps[0] & 0x1f) !== 7) return null;
  const rbsp = stripEmulationBytes(sps.subarray(1));
  if (rbsp.length < 3) return null;

  const br = new BitReader(rbsp);
  const profileIdc = br.readBits(8);
  br.readBits(8); // constraint flags + reserved
  br.readBits(8); // level_idc
  br.readUE(); // seq_parameter_set_id

  let chromaFormatIdc = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134].includes(profileIdc)) {
    chromaFormatIdc = br.readUE();
    if (chromaFormatIdc === 3) br.readBits(1);
    br.readUE(); // bit_depth_luma_minus8
    br.readUE(); // bit_depth_chroma_minus8
    br.readBits(1); // qpprime_y_zero_transform_bypass_flag
    if (br.readBits(1) === 1) {
      const count = chromaFormatIdc !== 3 ? 8 : 12;
      for (let i = 0; i < count; i++) {
        if (br.readBits(1) === 1) {
          const size = i < 6 ? 16 : 64;
          let lastScale = 8;
          let nextScale = 8;
          for (let j = 0; j < size; j++) {
            if (nextScale !== 0) nextScale = (lastScale + br.readSE() + 256) % 256;
            lastScale = nextScale === 0 ? lastScale : nextScale;
          }
        }
      }
    }
  }

  br.readUE(); // log2_max_frame_num_minus4
  const picOrderCntType = br.readUE();
  if (picOrderCntType === 0) {
    br.readUE();
  } else if (picOrderCntType === 1) {
    br.readBits(1);
    br.readSE();
    br.readSE();
    const nRef = Math.min(64, br.readUE());
    for (let i = 0; i < nRef; i++) br.readSE();
  }

  br.readUE(); // max_num_ref_frames
  br.readBits(1); // gaps_in_frame_num_value_allowed_flag
  const picWidthInMbsMinus1 = br.readUE();
  const picHeightInMapUnitsMinus1 = br.readUE();
  const frameMbsOnlyFlag = br.readBits(1);
  if (frameMbsOnlyFlag === 0) br.readBits(1);
  br.readBits(1); // direct_8x8_inference_flag

  let cropLeft = 0;
  let cropRight = 0;
  let cropTop = 0;
  let cropBottom = 0;
  if (br.readBits(1) === 1) {
    cropLeft = br.readUE();
    cropRight = br.readUE();
    cropTop = br.readUE();
    cropBottom = br.readUE();
  }

  const cropUnitX = chromaFormatIdc === 0 ? 1 : 2;
  const cropUnitY = (chromaFormatIdc === 0 ? 1 : 2) * (2 - frameMbsOnlyFlag);
  const width = (picWidthInMbsMinus1 + 1) * 16 - (cropLeft + cropRight) * cropUnitX;
  const height = (2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16 - (cropTop + cropBottom) * cropUnitY;

  if (width < 64 || width > 8192 || height < 64 || height > 8192) return null;

  let fps: number | undefined;
  if (br.readBits(1) === 1) {
    // vui_parameters_present_flag
    if (br.readBits(1) === 1) {
      const aspectIdc = br.readBits(8);
      if (aspectIdc === 255) {
        br.readBits(16);
        br.readBits(16);
      }
    }
    if (br.readBits(1) === 1) br.readBits(1); // overscan
    if (br.readBits(1) === 1) {
      br.readBits(4);
      if (br.readBits(1) === 1) {
        br.readBits(24);
      }
    }
    if (br.readBits(1) === 1) {
      br.readUE();
      br.readUE();
    }
    if (br.readBits(1) === 1) {
      const numUnits = br.readBits(32) >>> 0;
      const timeScale = br.readBits(32) >>> 0;
      if (numUnits > 0 && timeScale > 0) {
        const computed = timeScale / (2 * numUnits);
        if (computed >= 5 && computed <= 240) fps = Math.round(computed * 100) / 100;
      }
    }
  }

  return { width, height, fps };
}

export function parseHevcSpsDimensions(sps: Uint8Array): { width: number; height: number; fps?: number } | null {
  if (!sps || sps.length < 6 || ((sps[0] >> 1) & 0x3f) !== 33) return null;
  const rbsp = stripEmulationBytes(sps.subarray(2));
  if (rbsp.length < 4) return null;

  const br = new BitReader(rbsp);
  br.readBits(4); // vps_id
  const maxSubLayersMinus1 = br.readBits(3);
  br.readBits(1); // temporal_id_nesting_flag

  // profile_tier_level(1, maxSubLayersMinus1)
  br.readBits(2); // general_profile_space
  br.readBits(1); // general_tier_flag
  br.readBits(5); // general_profile_idc
  br.readBits(32); // profile_compatibility_flag
  br.readBits(32); // constraint flags high
  br.readBits(16); // constraint flags low
  br.readBits(8); // general_level_idc

  const subProfilePresent: number[] = [];
  const subLevelPresent: number[] = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    subProfilePresent.push(br.readBits(1));
    subLevelPresent.push(br.readBits(1));
  }
  if (maxSubLayersMinus1 > 0) {
    for (let i = maxSubLayersMinus1; i < 8; i++) br.readBits(2);
  }
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (subProfilePresent[i]) {
      br.readBits(32);
      br.readBits(32);
      br.readBits(24);
    }
    if (subLevelPresent[i]) br.readBits(8);
  }

  br.readUE(); // sps_seq_parameter_set_id
  const chromaFormatIdc = br.readUE();
  if (chromaFormatIdc === 3) br.readBits(1);
  const width = br.readUE();
  const height = br.readUE();
  if (width < 64 || width > 8192 || height < 64 || height > 8192) return null;

  if (br.readBits(1) === 1) {
    const left = br.readUE();
    const right = br.readUE();
    const top = br.readUE();
    const bottom = br.readUE();
    const subX = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1;
    const subY = chromaFormatIdc === 1 ? 2 : 1;
    const cw = width - (left + right) * subX;
    const ch = height - (top + bottom) * subY;
    if (cw >= 64 && ch >= 64) return { width: cw, height: ch };
  }
  return { width, height };
}

function parseTopBoxes(buf: Uint8Array): { boxes: Mp4Box[]; truncatedAt: number | null } {
  const boxes: Mp4Box[] = [];
  let pos = 0;
  while (pos + 8 <= buf.length && boxes.length < 512) {
    let size = readU32BE(buf, pos);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    if (!/^[\x20-\x7e]{4}$/.test(type)) break;
    let headerSize = 8;
    if (size === 1 && pos + 16 <= buf.length) {
      size = readU32BE(buf, pos + 8) * 4294967296 + readU32BE(buf, pos + 12);
      headerSize = 16;
    } else if (size === 0) {
      size = buf.length - pos;
      boxes.push({ type, offset: pos, size, headerSize });
      return { boxes, truncatedAt: pos };
    }
    if (size < 8) break;
    if (pos + size > buf.length) {
      boxes.push({ type, offset: pos, size: buf.length - pos, headerSize });
      return { boxes, truncatedAt: pos };
    }
    boxes.push({ type, offset: pos, size, headerSize });
    pos += size;
  }
  return { boxes, truncatedAt: null };
}

function findNestedBox(
  buf: Uint8Array,
  start: number,
  end: number,
  targetType: string,
): Mp4Box | null {
  let pos = start;
  while (pos + 8 <= end) {
    let size = readU32BE(buf, pos);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    if (size === 0) size = end - pos;
    if (size < 8 || pos + size > end) break;
    if (type === targetType) {
      return { type, offset: pos, size, headerSize: 8 };
    }
    pos += size;
  }
  return null;
}

function extractReferenceTrackConfigs(refBytes: Uint8Array): {
  video: ReferenceVideoConfig | null;
  audio: ReferenceAudioConfig | null;
} {
  let video: ReferenceVideoConfig | null = null;
  let audio: ReferenceAudioConfig | null = null;

  const { boxes } = parseTopBoxes(refBytes);
  const moov = boxes.find((b) => b.type === 'moov');
  if (!moov) return { video, audio };

  let pos = moov.offset + 8;
  const moovEnd = moov.offset + moov.size;
  while (pos + 8 <= moovEnd) {
    const sz = readU32BE(refBytes, pos);
    const tp = String.fromCharCode(
      refBytes[pos + 4],
      refBytes[pos + 5],
      refBytes[pos + 6],
      refBytes[pos + 7],
    );
    if (sz < 8 || pos + sz > moovEnd) break;
    if (tp === 'trak') {
      const mdia = findNestedBox(refBytes, pos + 8, pos + sz, 'mdia');
      if (mdia) {
        let timescale = 30000;
        const mdhd = findNestedBox(refBytes, mdia.offset + 8, mdia.offset + mdia.size, 'mdhd');
        if (mdhd && mdhd.size >= 24) {
          const ver = refBytes[mdhd.offset + 8];
          const tsOff = ver === 1 ? mdhd.offset + 28 : mdhd.offset + 20;
          if (tsOff + 4 <= mdhd.offset + mdhd.size) {
            const ts = readU32BE(refBytes, tsOff);
            if (ts >= 100 && ts <= 2_000_000) timescale = ts;
          }
        }
        const hdlr = findNestedBox(refBytes, mdia.offset + 8, mdia.offset + mdia.size, 'hdlr');
        const hdlrType =
          hdlr && hdlr.size >= 20
            ? String.fromCharCode(
                refBytes[hdlr.offset + 16],
                refBytes[hdlr.offset + 17],
                refBytes[hdlr.offset + 18],
                refBytes[hdlr.offset + 19],
              )
            : '';

        const minf = findNestedBox(refBytes, mdia.offset + 8, mdia.offset + mdia.size, 'minf');
        const stbl = minf
          ? findNestedBox(refBytes, minf.offset + 8, minf.offset + minf.size, 'stbl')
          : null;
        const stsd = stbl
          ? findNestedBox(refBytes, stbl.offset + 8, stbl.offset + stbl.size, 'stsd')
          : null;
        const stts = stbl
          ? findNestedBox(refBytes, stbl.offset + 8, stbl.offset + stbl.size, 'stts')
          : null;

        let refDelta = Math.max(1, Math.round(timescale / 30));
        if (stts && stts.size >= 24) {
          const d = readU32BE(refBytes, stts.offset + 20);
          if (d >= 1 && d <= timescale) refDelta = d;
        }

        if (stsd && stsd.size > 24) {
          if (!video && (!hdlrType || hdlrType === 'vide')) {
            const avcEntry = findNestedBox(
              refBytes,
              stsd.offset + 16,
              stsd.offset + stsd.size,
              'avc1',
            );
            const hvcEntry =
              findNestedBox(refBytes, stsd.offset + 16, stsd.offset + stsd.size, 'hvc1') ??
              findNestedBox(refBytes, stsd.offset + 16, stsd.offset + stsd.size, 'hev1');

            if (avcEntry && avcEntry.size > 86) {
              const width =
                (refBytes[avcEntry.offset + 32] << 8) | refBytes[avcEntry.offset + 33] || 1280;
              const height =
                (refBytes[avcEntry.offset + 34] << 8) | refBytes[avcEntry.offset + 35] || 720;
              const foundAvcc = findNestedBox(
                refBytes,
                avcEntry.offset + 86,
                avcEntry.offset + avcEntry.size,
                'avcC',
              );
              if (foundAvcc) {
                video = {
                  codec: 'h264',
                  codecBoxType: 'avc1',
                  configBox: refBytes.slice(foundAvcc.offset, foundAvcc.offset + foundAvcc.size),
                  width,
                  height,
                  timescale,
                  sampleDelta: refDelta,
                };
              }
            } else if (hvcEntry && hvcEntry.size > 86) {
              const width =
                (refBytes[hvcEntry.offset + 32] << 8) | refBytes[hvcEntry.offset + 33] || 1920;
              const height =
                (refBytes[hvcEntry.offset + 34] << 8) | refBytes[hvcEntry.offset + 35] || 1080;
              const foundHvcc = findNestedBox(
                refBytes,
                hvcEntry.offset + 86,
                hvcEntry.offset + hvcEntry.size,
                'hvcC',
              );
              if (foundHvcc) {
                video = {
                  codec: 'hevc',
                  codecBoxType: hvcEntry.type as 'hvc1' | 'hev1',
                  configBox: refBytes.slice(foundHvcc.offset, foundHvcc.offset + foundHvcc.size),
                  width,
                  height,
                  timescale,
                  sampleDelta: refDelta,
                };
              }
            }
          }

          if (!audio && (!hdlrType || hdlrType === 'soun')) {
            const audioEntry =
              findNestedBox(refBytes, stsd.offset + 16, stsd.offset + stsd.size, 'mp4a') ??
              findNestedBox(refBytes, stsd.offset + 16, stsd.offset + stsd.size, 'sowt') ??
              findNestedBox(refBytes, stsd.offset + 16, stsd.offset + stsd.size, 'twos') ??
              findNestedBox(refBytes, stsd.offset + 16, stsd.offset + stsd.size, 'lpcm');
            if (audioEntry && audioEntry.size >= 36) {
              const channels = (refBytes[audioEntry.offset + 24] << 8) | refBytes[audioEntry.offset + 25] || 2;
              const bits = (refBytes[audioEntry.offset + 26] << 8) | refBytes[audioEntry.offset + 27] || 16;
              const sr = (refBytes[audioEntry.offset + 32] << 8) | refBytes[audioEntry.offset + 33] || 48000;
              audio = {
                codecType: audioEntry.type,
                stsdEntryBox: refBytes.slice(audioEntry.offset, audioEntry.offset + audioEntry.size),
                timescale: timescale || sr,
                sampleDelta: audioEntry.type === 'mp4a' ? 1024 : refDelta,
                sampleRate: sr,
                channels,
                bitsPerSample: bits,
              };
            }
          }
        }
      }
    }
    pos += sz;
  }

  return { video, audio };
}

function buildAvcCBox(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const profile = sps.length >= 2 ? sps[1] : 0x42;
  const compat = sps.length >= 3 ? sps[2] : 0xc0;
  const level = sps.length >= 4 ? sps[3] : 0x1e;
  const body = new Uint8Array(11 + sps.length + pps.length);
  body[0] = 1;
  body[1] = profile;
  body[2] = compat;
  body[3] = level;
  body[4] = 0xff;
  body[5] = 0xe1;
  writeU16BE(body, 6, sps.length);
  body.set(sps, 8);
  const ppsPos = 8 + sps.length;
  body[ppsPos] = 1;
  writeU16BE(body, ppsPos + 1, pps.length);
  body.set(pps, ppsPos + 3);
  return makeBox('avcC', body);
}

function buildHvcCBox(
  vps: Uint8Array | null,
  sps: Uint8Array | null,
  pps: Uint8Array | null,
): Uint8Array {
  const arrays: { nalType: number; unit: Uint8Array }[] = [];
  if (vps && vps.length > 2) arrays.push({ nalType: 32, unit: vps });
  if (sps && sps.length > 2) arrays.push({ nalType: 33, unit: sps });
  if (pps && pps.length > 2) arrays.push({ nalType: 34, unit: pps });

  const arraysByteLen = arrays.reduce((sum, a) => sum + 5 + a.unit.length, 0);
  const body = new Uint8Array(23 + arraysByteLen);
  body[0] = 1;
  body[1] = 0x01;
  writeU32BE(body, 2, 0x60000000);
  body[6] = 0x90;
  body[12] = 93;
  writeU16BE(body, 13, 0xf000);
  body[15] = 0xfc;
  body[16] = 0xfd;
  body[17] = 0xf8;
  body[18] = 0xf8;
  writeU16BE(body, 19, 0);
  body[21] = 0x0f;
  body[22] = arrays.length;

  let cursor = 23;
  for (const arr of arrays) {
    body[cursor] = 0x80 | (arr.nalType & 0x3f);
    writeU16BE(body, cursor + 1, 1);
    writeU16BE(body, cursor + 3, arr.unit.length);
    body.set(arr.unit, cursor + 5);
    cursor += 5 + arr.unit.length;
  }
  return makeBox('hvcC', body);
}

function buildDefaultMp4aBox(sampleRate = 48000, channels = 2): Uint8Array {
  const srIndexTable = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
  ];
  let srIdx = srIndexTable.indexOf(sampleRate);
  if (srIdx < 0) srIdx = 3;
  const asc0 = (2 << 3) | ((srIdx >> 1) & 0x07);
  const asc1 = ((srIdx & 1) << 7) | ((channels & 0x0f) << 3);

  const esdsPayload = new Uint8Array([
    0x03, 0x19, 0x00, 0x01, 0x00,
    0x04, 0x11, 0x40, 0x15, 0x00, 0x00, 0x00, 0x00, 0x01, 0xf4, 0x00, 0x00, 0x01, 0xf4, 0x00,
    0x05, 0x02, asc0, asc1,
    0x06, 0x01, 0x02,
  ]);
  const esds = makeFullBox('esds', 0, 0, esdsPayload);

  const mp4aHeader = new Uint8Array(28);
  writeU16BE(mp4aHeader, 6, 1);
  writeU16BE(mp4aHeader, 16, channels);
  writeU16BE(mp4aHeader, 18, 16);
  writeU32BE(mp4aHeader, 24, (sampleRate << 16) >>> 0);
  return makeBox('mp4a', mp4aHeader, esds);
}

function isLikelyAdtsHeader(
  buf: Uint8Array,
  pos: number,
): { frameLen: number; sampleRate: number; channels: number } | null {
  if (pos + 7 > buf.length) return null;
  if (buf[pos] !== 0xff || (buf[pos + 1] & 0xf0) !== 0xf0) return null;
  const layer = (buf[pos + 1] >> 1) & 0x03;
  if (layer !== 0) return null;
  const srIndex = (buf[pos + 2] >> 2) & 0x0f;
  const srTable = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  if (srIndex >= srTable.length) return null;
  const frameLen =
    ((buf[pos + 3] & 0x03) << 11) | (buf[pos + 4] << 3) | ((buf[pos + 5] >> 5) & 0x07);
  if (frameLen < 7 || pos + frameLen > buf.length) return null;
  const channels = ((buf[pos + 2] & 0x01) << 2) | ((buf[pos + 3] >> 6) & 0x03);
  return { frameLen, sampleRate: srTable[srIndex], channels: channels || 2 };
}

// Heuristic check for raw headerless AAC access unit (iPhone/GoPro MP4 mdat)
function isLikelyRawAacFrame(buf: Uint8Array, pos: number, len: number): boolean {
  if (len < 12 || len > 4096 || pos + len > buf.length) return false;
  const synEle = (buf[pos] >>> 5) & 0x07;
  // Raw AAC frame starts with SCE(0), CPE(1), CCE(2), LFE(3), DSE(4), PCE(5), or FIL(6)
  return synEle <= 6 && buf[pos] !== 0x00;
}

function scanMdatMediaSamples(
  payload: Uint8Array,
  preferredCodec?: 'h264' | 'hevc',
  refAudio?: ReferenceAudioConfig | null,
): {
  codec: 'h264' | 'hevc';
  avccPayload: Uint8Array;
  videoSamples: TrackSample[];
  audioSamples: TrackSample[];
  vps: Uint8Array | null;
  sps: Uint8Array | null;
  pps: Uint8Array | null;
  detectedAudioSampleRate: number;
  detectedAudioChannels: number;
  rawAudioIsPcm: boolean;
} {
  let detectedCodec: 'h264' | 'hevc' = preferredCodec ?? 'h264';
  let vps: Uint8Array | null = null;
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  let detectedAudioSampleRate = refAudio?.sampleRate ?? 48000;
  let detectedAudioChannels = refAudio?.channels ?? 2;
  const rawAudioIsPcm = Boolean(
    refAudio && ['sowt', 'twos', 'lpcm', 'in24', 'in32', 'fl32'].includes(refAudio.codecType),
  );

  // Quick pre-probe for H.265 vs H.264 if no reference codec hint
  if (!preferredCodec) {
    let probePos = 0;
    let hevcHits = 0;
    let h264Hits = 0;
    let steps = 0;
    while (probePos + 6 <= payload.length && steps < 48) {
      steps++;
      const nl = readU32BE(payload, probePos);
      if (nl >= 2 && nl <= 4 * 1024 * 1024 && probePos + 4 + nl <= payload.length) {
        const b0 = payload[probePos + 4];
        const b1 = payload[probePos + 5];
        if ((b0 & 0x80) === 0) {
          const h264T = b0 & 0x1f;
          const hevcT = (b0 >> 1) & 0x3f;
          const nuhTemp = b1 & 0x07;
          if ((hevcT === 32 || hevcT === 33 || hevcT === 34) && (b0 & 0x01) === 0 && nuhTemp >= 1) {
            hevcHits += 3;
          } else if (hevcT >= 16 && hevcT <= 21 && (b0 & 0x01) === 0 && nuhTemp >= 1) {
            hevcHits += 2;
          }
          if (h264T === 7 || h264T === 8) h264Hits += 3;
          else if (h264T === 5 || h264T === 1) h264Hits += 1;
        }
        probePos += 4 + nl;
      } else {
        break;
      }
    }
    if (hevcHits > h264Hits) detectedCodec = 'hevc';
  }

  // Strategy 1: Length-prefixed AVCC/HVCC NALs + ADTS AAC + raw camera audio + corrupt-sector resync
  const chunks: Uint8Array[] = [];
  const videoSamples: TrackSample[] = [];
  const audioSamples: TrackSample[] = [];
  let outCursor = 0;
  let pos = 0;
  let validAvccVideoUnits = 0;

  while (pos + 5 <= payload.length) {
    // 1A: Inline ADTS AAC audio frame
    const adts = isLikelyAdtsHeader(payload, pos);
    if (adts) {
      const hdrLen = (payload[pos + 1] & 0x01) === 0 ? 9 : 7;
      if (adts.frameLen > hdrLen) {
        const rawAac = payload.subarray(pos + hdrLen, pos + adts.frameLen);
        detectedAudioSampleRate = adts.sampleRate;
        detectedAudioChannels = adts.channels;
        chunks.push(rawAac);
        audioSamples.push({ offset: outCursor, size: rawAac.length, isKey: true });
        outCursor += rawAac.length;
        pos += adts.frameLen;
        continue;
      }
    }

    const nalLen = readU32BE(payload, pos);
    const maxReasonableLen = Math.min(16 * 1024 * 1024, payload.length - pos - 4);
    if (nalLen >= 1 && nalLen <= maxReasonableLen) {
      const b0 = payload[pos + 4];
      const forbiddenBit = (b0 & 0x80) !== 0;

      if (!forbiddenBit && detectedCodec === 'hevc' && nalLen >= 2) {
        const hevcType = (b0 >> 1) & 0x3f;
        const nuhTemp = payload[pos + 5] & 0x07;
        const isKnownHevc =
          nuhTemp >= 1 &&
          ((hevcType >= 0 && hevcType <= 9) ||
            (hevcType >= 16 && hevcType <= 21) ||
            (hevcType >= 32 && hevcType <= 40));
        if (isKnownHevc) {
          validAvccVideoUnits++;
          if (hevcType === 32 && !vps) vps = payload.slice(pos + 4, pos + 4 + nalLen);
          else if (hevcType === 33 && !sps) sps = payload.slice(pos + 4, pos + 4 + nalLen);
          else if (hevcType === 34 && !pps) pps = payload.slice(pos + 4, pos + 4 + nalLen);

          const boxed = payload.subarray(pos, pos + 4 + nalLen);
          chunks.push(boxed);
          if (hevcType <= 21) {
            videoSamples.push({
              offset: outCursor,
              size: boxed.length,
              isKey: hevcType >= 16 && hevcType <= 21,
            });
          }
          outCursor += boxed.length;
          pos += 4 + nalLen;
          continue;
        }
      } else if (!forbiddenBit && detectedCodec === 'h264') {
        const nalType = b0 & 0x1f;
        if (nalType >= 1 && nalType <= 20) {
          validAvccVideoUnits++;
          if (nalType === 7 && !sps) sps = payload.slice(pos + 4, pos + 4 + nalLen);
          else if (nalType === 8 && !pps) pps = payload.slice(pos + 4, pos + 4 + nalLen);

          const boxed = payload.subarray(pos, pos + 4 + nalLen);
          chunks.push(boxed);
          if (nalType === 5 || nalType === 1) {
            videoSamples.push({
              offset: outCursor,
              size: boxed.length,
              isKey: nalType === 5,
            });
          }
          outCursor += boxed.length;
          pos += 4 + nalLen;
          continue;
        }
      }

      // 1B: Interleaved length-prefixed auxiliary/raw audio packet inside mdat
      if (nalLen >= 12 && nalLen <= 4096 && pos + 4 + nalLen <= payload.length && videoSamples.length > 0) {
        if (pos + 4 + nalLen + 5 <= payload.length) {
          const nextLen = readU32BE(payload, pos + 4 + nalLen);
          const nextB0 = payload[pos + 4 + nalLen + 4];
          const nextType = detectedCodec === 'hevc' ? (nextB0 >> 1) & 0x3f : nextB0 & 0x1f;
          if (
            nextLen > 0 &&
            pos + 4 + nalLen + 4 + nextLen <= payload.length &&
            (nextB0 & 0x80) === 0 &&
            ((detectedCodec === 'hevc' && nextType <= 40) ||
              (detectedCodec === 'h264' && nextType >= 1 && nextType <= 20))
          ) {
            // If reference audio is AAC, index raw AAC packet directly as sound sample
            if (refAudio?.codecType === 'mp4a' && isLikelyRawAacFrame(payload, pos + 4, nalLen)) {
              const aacPkt = payload.subarray(pos + 4, pos + 4 + nalLen);
              chunks.push(aacPkt);
              audioSamples.push({ offset: outCursor, size: aacPkt.length, isKey: true });
              outCursor += aacPkt.length;
            }
            pos += 4 + nalLen;
            continue;
          }
        }
      }
    }

    // 1C: Unprefixed interleaved raw audio gap (e.g., iPhone/GoPro raw AAC or PCM sitting between video NALs)
    if (videoSamples.length > 0 && pos + 5 <= payload.length) {
      let resynced = false;
      const searchEnd = Math.min(payload.length - 5, pos + 8192);
      for (let scan = pos + 1; scan <= searchEnd; scan++) {
        if (isLikelyAdtsHeader(payload, scan)) {
          pos = scan;
          resynced = true;
          break;
        }
        const candLen = readU32BE(payload, scan);
        if (candLen >= 4 && candLen <= 2 * 1024 * 1024 && scan + 4 + candLen <= payload.length) {
          const cb0 = payload[scan + 4];
          if ((cb0 & 0x80) === 0) {
            const nt = detectedCodec === 'hevc' ? (cb0 >> 1) & 0x3f : cb0 & 0x1f;
            const looksValid =
              detectedCodec === 'hevc'
                ? nt === 32 || nt === 33 || (nt >= 16 && nt <= 21) || (nt <= 9 && candLen > 32)
                : nt === 7 || nt === 8 || nt === 5 || (nt === 1 && candLen > 32);
            if (looksValid && (scan + 4 + candLen === payload.length || scan + 4 + candLen + 5 <= payload.length)) {
              const gapLen = scan - pos;
              if (refAudio && gapLen >= 16 && gapLen <= 8192) {
                if (rawAudioIsPcm && gapLen % Math.max(2, Math.floor((refAudio.bitsPerSample / 8) * refAudio.channels)) === 0) {
                  const pcmChunk = payload.subarray(pos, scan);
                  chunks.push(pcmChunk);
                  audioSamples.push({ offset: outCursor, size: pcmChunk.length, isKey: true });
                  outCursor += pcmChunk.length;
                } else if (refAudio.codecType === 'mp4a' && isLikelyRawAacFrame(payload, pos, gapLen)) {
                  const rawChunk = payload.subarray(pos, scan);
                  chunks.push(rawChunk);
                  audioSamples.push({ offset: outCursor, size: rawChunk.length, isKey: true });
                  outCursor += rawChunk.length;
                }
              }
              pos = scan;
              resynced = true;
              break;
            }
          }
        }
      }
      if (resynced) continue;
    }
    break;
  }

  if (validAvccVideoUnits >= 1 && videoSamples.length > 0) {
    if (
      audioSamples.length === 0 &&
      chunks.length === videoSamples.length + (vps ? 1 : 0) + (sps ? 1 : 0) + (pps ? 1 : 0) &&
      outCursor === payload.length
    ) {
      return {
        codec: detectedCodec,
        avccPayload: payload,
        videoSamples,
        audioSamples,
        vps,
        sps,
        pps,
        detectedAudioSampleRate,
        detectedAudioChannels,
        rawAudioIsPcm,
      };
    }
    const rebuiltPayload = new Uint8Array(outCursor);
    let w = 0;
    for (const c of chunks) {
      rebuiltPayload.set(c, w);
      w += c.length;
    }
    return {
      codec: detectedCodec,
      avccPayload: rebuiltPayload,
      videoSamples,
      audioSamples,
      vps,
      sps,
      pps,
      detectedAudioSampleRate,
      detectedAudioChannels,
      rawAudioIsPcm,
    };
  }

  // Strategy 2: Annex-B start codes (00 00 00 01 or 00 00 01) for H.264 and HEVC -> AVCC/HVCC
  const startCodeOffsets: { scPos: number; scLen: number }[] = [];
  for (let i = 0; i + 4 <= payload.length; i++) {
    if (payload[i] === 0 && payload[i + 1] === 0 && payload[i + 2] === 0 && payload[i + 3] === 1) {
      startCodeOffsets.push({ scPos: i, scLen: 4 });
      i += 3;
    } else if (payload[i] === 0 && payload[i + 1] === 0 && payload[i + 2] === 1) {
      startCodeOffsets.push({ scPos: i, scLen: 3 });
      i += 2;
    }
  }

  if (startCodeOffsets.length > 0) {
    const abChunks: Uint8Array[] = [];
    const abSamples: TrackSample[] = [];
    let abCursor = 0;

    let abCodec: 'h264' | 'hevc' = preferredCodec ?? 'h264';
    if (!preferredCodec) {
      for (const sc of startCodeOffsets.slice(0, 16)) {
        const b0 = payload[sc.scPos + sc.scLen];
        if (b0 !== undefined && (b0 & 0x80) === 0) {
          const ht = (b0 >> 1) & 0x3f;
          if ((ht === 32 || ht === 33 || ht === 34) && (b0 & 0x01) === 0) {
            abCodec = 'hevc';
            break;
          }
        }
      }
    }

    for (let idx = 0; idx < startCodeOffsets.length; idx++) {
      const { scPos, scLen } = startCodeOffsets[idx];
      const nalStart = scPos + scLen;
      const nalEnd =
        idx + 1 < startCodeOffsets.length ? startCodeOffsets[idx + 1].scPos : payload.length;
      if (nalEnd <= nalStart) continue;
      const nalBody = payload.subarray(nalStart, nalEnd);
      const boxedNal = new Uint8Array(4 + nalBody.length);
      writeU32BE(boxedNal, 0, nalBody.length);
      boxedNal.set(nalBody, 4);
      abChunks.push(boxedNal);

      if (abCodec === 'hevc') {
        const ht = (nalBody[0] >> 1) & 0x3f;
        if (ht === 32 && !vps) vps = nalBody.slice();
        if (ht === 33 && !sps) sps = nalBody.slice();
        if (ht === 34 && !pps) pps = nalBody.slice();
        if (ht <= 21) {
          abSamples.push({
            offset: abCursor,
            size: boxedNal.length,
            isKey: ht >= 16 && ht <= 21,
          });
        }
      } else {
        const nt = nalBody[0] & 0x1f;
        if (nt === 7 && !sps) sps = nalBody.slice();
        if (nt === 8 && !pps) pps = nalBody.slice();
        if (nt === 5 || nt === 1) {
          abSamples.push({
            offset: abCursor,
            size: boxedNal.length,
            isKey: nt === 5,
          });
        }
      }
      abCursor += boxedNal.length;
    }

    if (abSamples.length > 0) {
      const avccPayload = new Uint8Array(abCursor);
      let w = 0;
      for (const c of abChunks) {
        avccPayload.set(c, w);
        w += c.length;
      }
      return {
        codec: abCodec,
        avccPayload,
        videoSamples: abSamples,
        audioSamples: [],
        vps,
        sps,
        pps,
        detectedAudioSampleRate,
        detectedAudioChannels,
        rawAudioIsPcm,
      };
    }
  }

  return {
    codec: detectedCodec,
    avccPayload: payload,
    videoSamples: [],
    audioSamples: [],
    vps,
    sps,
    pps,
    detectedAudioSampleRate,
    detectedAudioChannels,
    rawAudioIsPcm,
  };
}

// Headerless / overwritten ftyp+mdat salvage scan across the leading bytes of a damaged video
function findHeaderlessStreamStart(buf: Uint8Array, preferredCodec?: 'h264' | 'hevc'): number {
  const limit = Math.min(buf.length - 8, 4 * 1024 * 1024);
  for (let i = 0; i < limit; i++) {
    // Annex-B start code followed by SPS(7) / IDR(5) / HEVC VPS(32)/SPS(33)/IDR(19-20)
    if (buf[i] === 0 && buf[i + 1] === 0 && ((buf[i + 2] === 0 && buf[i + 3] === 1) || buf[i + 2] === 1)) {
      const scLen = buf[i + 2] === 1 ? 3 : 4;
      const b0 = buf[i + scLen];
      if ((b0 & 0x80) === 0) {
        const h264T = b0 & 0x1f;
        const hevcT = (b0 >> 1) & 0x3f;
        if (h264T === 7 || h264T === 5 || hevcT === 32 || hevcT === 33 || (hevcT >= 16 && hevcT <= 21)) {
          return i;
        }
      }
    }
    // Length-prefixed AVCC/HVCC NAL chain with two consecutive valid NAL units
    const nl = readU32BE(buf, i);
    if (nl >= 4 && nl <= 2 * 1024 * 1024 && i + 4 + nl + 5 <= buf.length) {
      const b0 = buf[i + 4];
      const nextLen = readU32BE(buf, i + 4 + nl);
      if (
        (b0 & 0x80) === 0 &&
        nextLen >= 4 &&
        nextLen <= 2 * 1024 * 1024 &&
        i + 4 + nl + 4 + nextLen <= buf.length
      ) {
        const nb0 = buf[i + 4 + nl + 4];
        if ((nb0 & 0x80) === 0) {
          const nt1 = preferredCodec === 'hevc' ? (b0 >> 1) & 0x3f : b0 & 0x1f;
          const nt2 = preferredCodec === 'hevc' ? (nb0 >> 1) & 0x3f : nb0 & 0x1f;
          const ok1 =
            preferredCodec === 'hevc'
              ? nt1 === 32 || nt1 === 33 || (nt1 >= 16 && nt1 <= 21)
              : nt1 === 7 || nt1 === 8 || nt1 === 5;
          const ok2 =
            preferredCodec === 'hevc'
              ? nt2 <= 40
              : nt2 >= 1 && nt2 <= 20;
          if (ok1 && ok2) return i;
        }
      }
    }
  }
  return -1;
}

function buildTrackBox(params: {
  trackId: number;
  handlerType: 'vide' | 'soun';
  handlerName: string;
  timescale: number;
  sampleDelta: number;
  samples: TrackSample[];
  mdatDataBaseOffset: number;
  width?: number;
  height?: number;
  stsdEntry: Uint8Array;
}): Uint8Array {
  const {
    trackId,
    handlerType,
    handlerName,
    timescale,
    sampleDelta,
    samples,
    mdatDataBaseOffset,
    width = 0,
    height = 0,
    stsdEntry,
  } = params;
  const duration = samples.length * sampleDelta;

  const tkhdPayload = new Uint8Array(80);
  writeU32BE(tkhdPayload, 8, trackId);
  writeU32BE(tkhdPayload, 16, duration);
  if (handlerType === 'soun') writeU16BE(tkhdPayload, 32, 0x0100);
  writeU32BE(tkhdPayload, 36, 0x00010000);
  writeU32BE(tkhdPayload, 52, 0x00010000);
  writeU32BE(tkhdPayload, 68, 0x40000000);
  if (handlerType === 'vide') {
    writeU32BE(tkhdPayload, 72, width << 16);
    writeU32BE(tkhdPayload, 76, height << 16);
  }
  const tkhd = makeFullBox('tkhd', 0, 3, tkhdPayload);

  const mdhdPayload = new Uint8Array(20);
  writeU32BE(mdhdPayload, 8, timescale);
  writeU32BE(mdhdPayload, 12, duration);
  writeU16BE(mdhdPayload, 16, 0x55c4);
  const mdhd = makeFullBox('mdhd', 0, 0, mdhdPayload);

  const hdlrPayload = new Uint8Array(20 + handlerName.length + 1);
  hdlrPayload.set(asciiBytes(handlerType), 4);
  hdlrPayload.set(asciiBytes(`${handlerName}\0`), 20);
  const hdlr = makeFullBox('hdlr', 0, 0, hdlrPayload);

  const mediaHeader =
    handlerType === 'vide'
      ? makeFullBox('vmhd', 0, 1, new Uint8Array(8))
      : makeFullBox('smhd', 0, 0, new Uint8Array(4));

  const urlBox = makeFullBox('url ', 0, 1);
  const drefPayload = new Uint8Array(4 + urlBox.length);
  writeU32BE(drefPayload, 0, 1);
  drefPayload.set(urlBox, 4);
  const dref = makeFullBox('dref', 0, 0, drefPayload);
  const dinf = makeBox('dinf', dref);

  const stsdCount = new Uint8Array(4);
  writeU32BE(stsdCount, 0, 1);
  const stsd = makeFullBox('stsd', 0, 0, stsdCount, stsdEntry);

  const sttsPayload = new Uint8Array(12);
  writeU32BE(sttsPayload, 0, 1);
  writeU32BE(sttsPayload, 4, samples.length);
  writeU32BE(sttsPayload, 8, sampleDelta);
  const stts = makeFullBox('stts', 0, 0, sttsPayload);

  const stscPayload = new Uint8Array(16);
  writeU32BE(stscPayload, 0, 1);
  writeU32BE(stscPayload, 4, 1);
  writeU32BE(stscPayload, 8, 1);
  writeU32BE(stscPayload, 12, 1);
  const stsc = makeFullBox('stsc', 0, 0, stscPayload);

  const stszPayload = new Uint8Array(8 + samples.length * 4);
  writeU32BE(stszPayload, 0, 0);
  writeU32BE(stszPayload, 4, samples.length);
  for (let i = 0; i < samples.length; i++) {
    writeU32BE(stszPayload, 8 + i * 4, samples[i].size);
  }
  const stsz = makeFullBox('stsz', 0, 0, stszPayload);

  const maxChunkOffset = samples.reduce(
    (mx, s) => Math.max(mx, mdatDataBaseOffset + s.offset),
    0,
  );
  let chunkBox: Uint8Array;
  if (maxChunkOffset > 0xffffffff) {
    const co64Payload = new Uint8Array(4 + samples.length * 8);
    writeU32BE(co64Payload, 0, samples.length);
    for (let i = 0; i < samples.length; i++) {
      writeU64BE(co64Payload, 4 + i * 8, mdatDataBaseOffset + samples[i].offset);
    }
    chunkBox = makeFullBox('co64', 0, 0, co64Payload);
  } else {
    const stcoPayload = new Uint8Array(4 + samples.length * 4);
    writeU32BE(stcoPayload, 0, samples.length);
    for (let i = 0; i < samples.length; i++) {
      writeU32BE(stcoPayload, 4 + i * 4, mdatDataBaseOffset + samples[i].offset);
    }
    chunkBox = makeFullBox('stco', 0, 0, stcoPayload);
  }

  const stssBoxes: Uint8Array[] = [];
  if (handlerType === 'vide') {
    const keyIndices = samples.map((s, idx) => (s.isKey ? idx + 1 : 0)).filter((n) => n > 0);
    if (keyIndices.length > 0) {
      const stssPayload = new Uint8Array(4 + keyIndices.length * 4);
      writeU32BE(stssPayload, 0, keyIndices.length);
      for (let i = 0; i < keyIndices.length; i++) {
        writeU32BE(stssPayload, 4 + i * 4, keyIndices[i]);
      }
      stssBoxes.push(makeFullBox('stss', 0, 0, stssPayload));
    }
  }

  const stbl = makeBox('stbl', stsd, stts, stsc, stsz, chunkBox, ...stssBoxes);
  const minf = makeBox('minf', mediaHeader, dinf, stbl);
  const mdia = makeBox('mdia', mdhd, hdlr, minf);
  return makeBox('trak', tkhd, mdia);
}

/**
 * Diagnoses structural health of an MP4/MOV/M4V/3GP buffer without modifying it.
 */
export function inspectMp4Health(buf: Uint8Array): Mp4HealthReport {
  if (buf.length < 16) {
    return {
      valid: false,
      hasFtyp: false,
      hasMoov: false,
      hasMdat: false,
      isFragmented: false,
      codec: 'unknown',
      hasAudio: false,
      missingMoov: false,
      truncatedTail: false,
      headerlessStream: false,
      issueSummary: 'Buffer smaller than ISO BMFF container header.',
    };
  }
  const { boxes, truncatedAt } = parseTopBoxes(buf);
  const hasFtyp = boxes.some((b) => b.type === 'ftyp');
  const hasMoov = boxes.some((b) => b.type === 'moov');
  const mdatBoxes = boxes.filter((b) => b.type === 'mdat');
  const hasMdat = mdatBoxes.length > 0;
  const isFragmented = boxes.some((b) => b.type === 'moof');

  let codec: 'h264' | 'hevc' | 'unknown' = 'unknown';
  let hasAudio = false;
  let width: number | undefined;
  let height: number | undefined;
  let headerlessStream = false;

  if (hasMoov) {
    const refCfg = extractReferenceTrackConfigs(buf);
    if (refCfg.video) {
      codec = refCfg.video.codec;
      width = refCfg.video.width;
      height = refCfg.video.height;
    }
    if (refCfg.audio) hasAudio = true;
  } else if (mdatBoxes.length > 0) {
    const firstMdat = mdatBoxes[0];
    const raw = buf.subarray(
      firstMdat.offset + firstMdat.headerSize,
      firstMdat.offset + firstMdat.size,
    );
    const scanned = scanMdatMediaSamples(raw);
    if (scanned.videoSamples.length > 0) codec = scanned.codec;
    if (scanned.audioSamples.length > 0) hasAudio = true;
    const dims =
      scanned.codec === 'hevc' && scanned.sps
        ? parseHevcSpsDimensions(scanned.sps)
        : scanned.sps
          ? parseH264SpsDimensions(scanned.sps)
          : null;
    if (dims) {
      width = dims.width;
      height = dims.height;
    }
  } else {
    const rawStart = findHeaderlessStreamStart(buf);
    if (rawStart >= 0) {
      headerlessStream = true;
      const scanned = scanMdatMediaSamples(buf.subarray(rawStart));
      if (scanned.videoSamples.length > 0) codec = scanned.codec;
      if (scanned.audioSamples.length > 0) hasAudio = true;
    }
  }

  const truncatedTail = truncatedAt !== null;
  const missingMoov = hasMdat && !hasMoov;
  const valid = hasFtyp && hasMoov && hasMdat && !truncatedTail;

  let issueSummary = 'ISO BMFF container intact (ftyp + moov + mdat verified).';
  if (missingMoov) {
    issueSummary = `Missing moov index atom (${codec === 'hevc' ? 'H.265/HEVC' : codec === 'h264' ? 'H.264/AVC' : 'unindexed'} mdat stream${width && height ? ` · ${width}×${height}` : ''}).`;
  } else if (headerlessStream) {
    issueSummary = `Wiped MP4/MOV ftyp+mdat header with salvageable ${codec.toUpperCase()} bitstream.`;
  } else if (truncatedTail) {
    issueSummary = isFragmented
      ? 'Truncated fragmented MP4 (moof/mdat) trailing box.'
      : 'Truncated trailing ISO BMFF box length.';
  } else if (!hasFtyp || !hasMdat) {
    issueSummary = 'Incomplete MP4/MOV container headers.';
  }

  return {
    valid,
    hasFtyp,
    hasMoov,
    hasMdat,
    isFragmented,
    codec,
    hasAudio,
    missingMoov,
    truncatedTail,
    headerlessStream,
    width,
    height,
    issueSummary,
  };
}

/**
 * untrunc-grade Smart Video Reorganization & MOOV Atom Synthesis:
 * - Supports H.264/AVC (avc1/avcC) and H.265/HEVC (hvc1/hev1/hvcC)
 * - Decodes SPS RBSP for exact width/height/FPS even without a reference clip
 * - Resynchronizes past corrupt sectors & extracts ADTS / reference-matched raw AAC/PCM audio
 * - Rescues headerless recordings whose ftyp/mdat header prefix was overwritten
 * - Emits dual-track moov (vide + optional soun) and 64-bit co64 when offsets > 4 GiB
 */
export function rebuildMp4WithMoov(
  brokenBytes: Uint8Array,
  referenceBytes?: Uint8Array,
): { repaired: boolean; data: Uint8Array; note: string } {
  if (brokenBytes.length < 16) {
    return { repaired: false, data: brokenBytes, note: 'Buffer too small for ISO BMFF container.' };
  }

  const refConfigs = referenceBytes
    ? extractReferenceTrackConfigs(referenceBytes)
    : { video: null, audio: null };
  const refVideo = refConfigs.video;
  const refAudio = refConfigs.audio;

  const { boxes, truncatedAt } = parseTopBoxes(brokenBytes);
  const hasMoov = boxes.some((b) => b.type === 'moov');
  const ftypBox = boxes.find((b) => b.type === 'ftyp');
  const mdatBoxes = boxes.filter((b) => b.type === 'mdat');

  if (hasMoov) {
    if (truncatedAt !== null) {
      const patched = brokenBytes.slice();
      writeU32BE(patched, truncatedAt, Math.max(8, patched.length - truncatedAt));
      return {
        repaired: true,
        data: patched,
        note: 'Reorganized ISO BMFF atom sizes and patched truncated trailing box length.',
      };
    }
    return { repaired: false, data: brokenBytes, note: 'MP4 moov index already intact.' };
  }

  let ftypBytes: Uint8Array;
  let rawPayload: Uint8Array;
  let recoveredHeaderless = false;

  if (mdatBoxes.length === 1) {
    ftypBytes = ftypBox
      ? brokenBytes.slice(ftypBox.offset, ftypBox.offset + ftypBox.size)
      : makeBox('ftyp', asciiBytes('mp42\0\0\0\0mp42isom'));
    rawPayload = brokenBytes.subarray(
      mdatBoxes[0].offset + mdatBoxes[0].headerSize,
      mdatBoxes[0].offset + mdatBoxes[0].size,
    );
  } else if (mdatBoxes.length > 1) {
    // Fragmented or multi-mdat recovery: concatenate all mdat payloads
    ftypBytes = ftypBox
      ? brokenBytes.slice(ftypBox.offset, ftypBox.offset + ftypBox.size)
      : makeBox('ftyp', asciiBytes('mp42\0\0\0\0mp42isom'));
    const totalLen = mdatBoxes.reduce((s, b) => s + Math.max(0, b.size - b.headerSize), 0);
    const merged = new Uint8Array(totalLen);
    let cursor = 0;
    for (const b of mdatBoxes) {
      const slice = brokenBytes.subarray(b.offset + b.headerSize, b.offset + b.size);
      merged.set(slice, cursor);
      cursor += slice.length;
    }
    rawPayload = merged;
  } else {
    // Headerless fallback: ftyp/mdat header overwritten — locate raw H.264/HEVC bitstream directly
    const rawStart = findHeaderlessStreamStart(brokenBytes, refVideo?.codec);
    if (rawStart < 0) {
      return {
        repaired: false,
        data: brokenBytes,
        note: 'Missing ftyp/mdat container header and no raw H.264/HEVC frames located.',
      };
    }
    recoveredHeaderless = true;
    ftypBytes = makeBox('ftyp', asciiBytes('mp42\0\0\0\0mp42isom'));
    rawPayload = brokenBytes.subarray(rawStart);
  }

  const scanned = scanMdatMediaSamples(rawPayload, refVideo?.codec, refAudio);
  const codec = scanned.codec;
  let configBox: Uint8Array | null;
  let entryBoxType: 'avc1' | 'hvc1' | 'hev1';

  if (codec === 'hevc') {
    entryBoxType = refVideo?.codec === 'hevc' ? refVideo.codecBoxType : 'hvc1';
    configBox =
      refVideo?.codec === 'hevc' && refVideo.configBox
        ? refVideo.configBox
        : scanned.vps || scanned.sps || scanned.pps
          ? buildHvcCBox(scanned.vps, scanned.sps, scanned.pps)
          : null;
  } else {
    entryBoxType = 'avc1';
    const fallbackSps =
      scanned.sps ?? new Uint8Array([0x67, 0x42, 0xc0, 0x1e, 0xd9, 0x00, 0xa0, 0x47, 0xfe, 0xc8]);
    const fallbackPps = scanned.pps ?? new Uint8Array([0x68, 0xce, 0x38, 0x80]);
    configBox =
      refVideo?.codec === 'h264' && refVideo.configBox
        ? refVideo.configBox
        : scanned.sps || scanned.pps
          ? buildAvcCBox(fallbackSps, fallbackPps)
          : null;
  }

  if (scanned.videoSamples.length === 0 || !configBox) {
    if (truncatedAt !== null) {
      const patched = brokenBytes.slice();
      writeU32BE(patched, truncatedAt, Math.max(8, patched.length - truncatedAt));
      return {
        repaired: true,
        data: patched,
        note: 'Reorganized ISO BMFF atom sizes and patched truncated mdat container length.',
      };
    }
    return {
      repaired: false,
      data: brokenBytes,
      note: 'Missing moov index atom; provide a healthy reference MP4/MOV from the same camera for frame index rebuild.',
    };
  }

  // Extract true resolution/FPS from SPS RBSP first, falling back to Reference clip
  const parsedDims =
    codec === 'hevc' && scanned.sps
      ? parseHevcSpsDimensions(scanned.sps)
      : scanned.sps
        ? parseH264SpsDimensions(scanned.sps)
        : null;

  const width = parsedDims?.width ?? refVideo?.width ?? (codec === 'hevc' ? 1920 : 1280);
  const height = parsedDims?.height ?? refVideo?.height ?? (codec === 'hevc' ? 1080 : 720);
  const timescale = refVideo?.timescale ?? 30000;
  const spsDelta =
    parsedDims?.fps && parsedDims.fps > 0
      ? Math.max(1, Math.round(timescale / parsedDims.fps))
      : undefined;
  const sampleDelta = refVideo?.sampleDelta ?? spsDelta ?? 1000;
  const videoDuration = scanned.videoSamples.length * sampleDelta;

  const useLargeMdat = scanned.avccPayload.length > 0xfffffff0;
  const mdatHeaderSize = useLargeMdat ? 16 : 8;
  const newMdat = new Uint8Array(mdatHeaderSize + scanned.avccPayload.length);
  if (useLargeMdat) {
    writeU32BE(newMdat, 0, 1);
    newMdat.set(asciiBytes('mdat'), 4);
    writeU64BE(newMdat, 8, newMdat.length);
  } else {
    writeU32BE(newMdat, 0, newMdat.length);
    newMdat.set(asciiBytes('mdat'), 4);
  }
  newMdat.set(scanned.avccPayload, mdatHeaderSize);

  const mdatDataBaseOffset = ftypBytes.length + mdatHeaderSize;
  const includeAudio = scanned.audioSamples.length > 0;
  const nextTrackId = includeAudio ? 3 : 2;

  const mvhdPayload = new Uint8Array(96);
  writeU32BE(mvhdPayload, 8, timescale);
  writeU32BE(mvhdPayload, 12, videoDuration);
  writeU32BE(mvhdPayload, 16, 0x00010000);
  writeU16BE(mvhdPayload, 20, 0x0100);
  writeU32BE(mvhdPayload, 32, 0x00010000);
  writeU32BE(mvhdPayload, 48, 0x00010000);
  writeU32BE(mvhdPayload, 64, 0x40000000);
  writeU32BE(mvhdPayload, 92, nextTrackId);
  const mvhd = makeFullBox('mvhd', 0, 0, mvhdPayload);

  const vidHeader = new Uint8Array(78);
  writeU16BE(vidHeader, 6, 1);
  writeU16BE(vidHeader, 24, width);
  writeU16BE(vidHeader, 26, height);
  writeU32BE(vidHeader, 28, 0x00480000);
  writeU32BE(vidHeader, 32, 0x00480000);
  writeU16BE(vidHeader, 40, 1);
  writeU16BE(vidHeader, 74, 0x0018);
  writeU16BE(vidHeader, 76, 0xffff);
  const videoSampleEntry = makeBox(entryBoxType, vidHeader, configBox);

  const videoTrak = buildTrackBox({
    trackId: 1,
    handlerType: 'vide',
    handlerName: 'VideoHandler',
    timescale,
    sampleDelta,
    samples: scanned.videoSamples,
    mdatDataBaseOffset,
    width,
    height,
    stsdEntry: videoSampleEntry,
  });

  const traks: Uint8Array[] = [videoTrak];
  if (includeAudio) {
    const audioEntry =
      refAudio?.stsdEntryBox ??
      buildDefaultMp4aBox(scanned.detectedAudioSampleRate, scanned.detectedAudioChannels);
    const audioTrak = buildTrackBox({
      trackId: 2,
      handlerType: 'soun',
      handlerName: 'SoundHandler',
      timescale: refAudio?.timescale ?? scanned.detectedAudioSampleRate,
      sampleDelta: refAudio?.sampleDelta ?? 1024,
      samples: scanned.audioSamples,
      mdatDataBaseOffset,
      stsdEntry: audioEntry,
    });
    traks.push(audioTrak);
  }

  const moov = makeBox('moov', mvhd, ...traks);
  const out = new Uint8Array(ftypBytes.length + newMdat.length + moov.length);
  out.set(ftypBytes, 0);
  out.set(newMdat, ftypBytes.length);
  out.set(moov, ftypBytes.length + newMdat.length);

  const codecLabel = codec === 'hevc' ? 'H.265/HEVC' : 'H.264/AVC';
  const audioCodecLabel = scanned.rawAudioIsPcm ? 'PCM' : 'AAC';
  const audioNote = includeAudio ? ` + ${scanned.audioSamples.length} ${audioCodecLabel} audio frames` : '';
  const refNote = refVideo?.configBox ? ', reference codec config' : '';
  const hdrNote = recoveredHeaderless ? ', rescued headerless stream & rebuilt ftyp+mdat' : '';
  return {
    repaired: true,
    data: out,
    note: `Synthesized missing MP4 moov index (${scanned.videoSamples.length} ${codecLabel} frame${scanned.videoSamples.length === 1 ? '' : 's'} @ ${width}×${height}${audioNote}${refNote}${hdrNote}).`,
  };
}
