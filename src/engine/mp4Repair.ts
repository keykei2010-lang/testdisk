interface Mp4Box {
  type: string;
  offset: number;
  size: number;
  headerSize: number;
}

interface AvcSample {
  offset: number; // offset relative to mdat payload start
  size: number;
  isKey: boolean;
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
  out.set(asciiBytes(type), 4);
  let cursor = 8;
  for (const p of parts) {
    out.set(p, cursor);
    cursor += p.length;
  }
  return out;
}

function makeFullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array {
  const vf = new Uint8Array(4);
  vf[0] = version & 0xff;
  vf[1] = (flags >>> 16) & 0xff;
  vf[2] = (flags >>> 8) & 0xff;
  vf[3] = flags & 0xff;
  return makeBox(type, vf, ...parts);
}

function parseTopBoxes(buf: Uint8Array): { boxes: Mp4Box[]; truncatedAt: number | null } {
  const boxes: Mp4Box[] = [];
  let pos = 0;
  while (pos + 8 <= buf.length && boxes.length < 128) {
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

function findNestedBox(buf: Uint8Array, start: number, end: number, targetType: string): Mp4Box | null {
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

function extractReferenceAvcConfig(refBytes: Uint8Array): {
  avcC?: Uint8Array;
  width: number;
  height: number;
  timescale: number;
  sampleDelta: number;
} {
  let width = 1280;
  let height = 720;
  let timescale = 30000;
  let sampleDelta = 1000;
  let avcC: Uint8Array | undefined;

  const { boxes } = parseTopBoxes(refBytes);
  const moov = boxes.find((b) => b.type === 'moov');
  if (!moov) return { width, height, timescale, sampleDelta };

  // Search for trak -> tkhd/mdia -> mdhd/minf -> stbl -> stsd -> avc1 -> avcC
  let pos = moov.offset + 8;
  const moovEnd = moov.offset + moov.size;
  while (pos + 8 <= moovEnd) {
    const sz = readU32BE(refBytes, pos);
    const tp = String.fromCharCode(refBytes[pos + 4], refBytes[pos + 5], refBytes[pos + 6], refBytes[pos + 7]);
    if (sz < 8 || pos + sz > moovEnd) break;
    if (tp === 'trak') {
      const mdia = findNestedBox(refBytes, pos + 8, pos + sz, 'mdia');
      if (mdia) {
        const mdhd = findNestedBox(refBytes, mdia.offset + 8, mdia.offset + mdia.size, 'mdhd');
        if (mdhd && mdhd.size >= 24) {
          const ver = refBytes[mdhd.offset + 8];
          const tsOff = ver === 1 ? mdhd.offset + 28 : mdhd.offset + 20;
          if (tsOff + 4 <= mdhd.offset + mdhd.size) {
            const ts = readU32BE(refBytes, tsOff);
            if (ts >= 1000 && ts <= 1000000) {
              timescale = ts;
              sampleDelta = Math.max(1, Math.round(ts / 30));
            }
          }
        }
        const minf = findNestedBox(refBytes, mdia.offset + 8, mdia.offset + mdia.size, 'minf');
        if (minf) {
          const stbl = findNestedBox(refBytes, minf.offset + 8, minf.offset + minf.size, 'stbl');
          if (stbl) {
            const stsd = findNestedBox(refBytes, stbl.offset + 8, stbl.offset + stbl.size, 'stsd');
            if (stsd && stsd.size > 24) {
              const entry = findNestedBox(refBytes, stsd.offset + 16, stsd.offset + stsd.size, 'avc1');
              if (entry && entry.size > 86) {
                width = (refBytes[entry.offset + 32] << 8) | refBytes[entry.offset + 33] || width;
                height = (refBytes[entry.offset + 34] << 8) | refBytes[entry.offset + 35] || height;
                const foundAvcc = findNestedBox(
                  refBytes,
                  entry.offset + 86,
                  entry.offset + entry.size,
                  'avcC',
                );
                if (foundAvcc) {
                  avcC = refBytes.slice(foundAvcc.offset, foundAvcc.offset + foundAvcc.size);
                  return { avcC, width, height, timescale, sampleDelta };
                }
              }
            }
          }
        }
      }
    }
    pos += sz;
  }

  return { avcC, width, height, timescale, sampleDelta };
}

function buildAvcCBox(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const profile = sps.length >= 2 ? sps[1] : 0x42;
  const compat = sps.length >= 3 ? sps[2] : 0xc0;
  const level = sps.length >= 4 ? sps[3] : 0x1e;
  const body = new Uint8Array(11 + sps.length + pps.length);
  body[0] = 1; // configurationVersion
  body[1] = profile;
  body[2] = compat;
  body[3] = level;
  body[4] = 0xff; // 4-byte NAL length prefix
  body[5] = 0xe1; // 1 SPS
  writeU16BE(body, 6, sps.length);
  body.set(sps, 8);
  const ppsPos = 8 + sps.length;
  body[ppsPos] = 1; // 1 PPS
  writeU16BE(body, ppsPos + 1, pps.length);
  body.set(pps, ppsPos + 3);
  return makeBox('avcC', body);
}

function scanMdatH264Samples(payload: Uint8Array): {
  avccPayload: Uint8Array;
  samples: AvcSample[];
  sps: Uint8Array | null;
  pps: Uint8Array | null;
} {
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  const samples: AvcSample[] = [];

  // Strategy 1: Length-prefixed AVCC NALs inside mdat
  let pos = 0;
  let validAvccCount = 0;
  const avccSamples: AvcSample[] = [];
  while (pos + 5 <= payload.length) {
    const nalLen = readU32BE(payload, pos);
    if (nalLen === 0 || nalLen > 16 * 1024 * 1024 || pos + 4 + nalLen > payload.length) {
      break;
    }
    const nalHeader = payload[pos + 4];
    const forbiddenBit = (nalHeader & 0x80) !== 0;
    const nalType = nalHeader & 0x1f;
    if (forbiddenBit || nalType === 0 || nalType > 20) break;

    validAvccCount++;
    if (nalType === 7 && !sps) {
      sps = payload.slice(pos + 4, pos + 4 + nalLen);
    } else if (nalType === 8 && !pps) {
      pps = payload.slice(pos + 4, pos + 4 + nalLen);
    } else if (nalType === 5 || nalType === 1) {
      avccSamples.push({
        offset: pos,
        size: 4 + nalLen,
        isKey: nalType === 5,
      });
    }
    pos += 4 + nalLen;
  }

  if (validAvccCount >= 1 && avccSamples.length > 0 && pos === payload.length) {
    return { avccPayload: payload, samples: avccSamples, sps, pps };
  }

  // Strategy 2: Annex-B start codes (00 00 00 01 or 00 00 01) -> convert to AVCC 4-byte lengths
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
    const chunks: Uint8Array[] = [];
    let outCursor = 0;
    for (let idx = 0; idx < startCodeOffsets.length; idx++) {
      const { scPos, scLen } = startCodeOffsets[idx];
      const nalStart = scPos + scLen;
      const nalEnd =
        idx + 1 < startCodeOffsets.length ? startCodeOffsets[idx + 1].scPos : payload.length;
      if (nalEnd <= nalStart) continue;
      const nalBody = payload.subarray(nalStart, nalEnd);
      const nalType = nalBody[0] & 0x1f;
      if (nalType === 7 && !sps) sps = nalBody.slice();
      if (nalType === 8 && !pps) pps = nalBody.slice();

      const boxedNal = new Uint8Array(4 + nalBody.length);
      writeU32BE(boxedNal, 0, nalBody.length);
      boxedNal.set(nalBody, 4);
      chunks.push(boxedNal);

      if (nalType === 5 || nalType === 1) {
        samples.push({
          offset: outCursor,
          size: boxedNal.length,
          isKey: nalType === 5,
        });
      }
      outCursor += boxedNal.length;
    }
    if (samples.length > 0) {
      const avccPayload = new Uint8Array(outCursor);
      let w = 0;
      for (const c of chunks) {
        avccPayload.set(c, w);
        w += c.length;
      }
      return { avccPayload, samples, sps, pps };
    }
  }

  return { avccPayload: payload, samples: [], sps, pps };
}

/**
 * Smart Video Reorganization & MOOV Atom Synthesis:
 * - Repairs truncated mdat box lengths in MP4/MOV/M4V containers
 * - If moov index atom is missing (e.g. crashed camera/phone recording), scans mdat H.264/AVC
 *   NAL units (or uses an optional healthy reference MP4's avcC codec config) and synthesizes
 *   a standards-compliant ISO BMFF moov/trak/stbl index so the video is playable & seekable.
 */
export function rebuildMp4WithMoov(
  brokenBytes: Uint8Array,
  referenceBytes?: Uint8Array,
): { repaired: boolean; data: Uint8Array; note: string } {
  if (brokenBytes.length < 16) {
    return { repaired: false, data: brokenBytes, note: 'Buffer too small for ISO BMFF container.' };
  }

  const { boxes, truncatedAt } = parseTopBoxes(brokenBytes);
  const hasMoov = boxes.some((b) => b.type === 'moov');
  const ftypBox = boxes.find((b) => b.type === 'ftyp');
  const mdatBox = boxes.find((b) => b.type === 'mdat');

  // Step 1: If moov is present, only clamp truncated trailing box size if needed
  if (hasMoov) {
    if (truncatedAt !== null) {
      const patched = brokenBytes.slice();
      writeU32BE(patched, truncatedAt, Math.max(8, patched.length - truncatedAt));
      return {
        repaired: true,
        data: patched,
        note: 'Reorganized ISO BMFF atom sizes and patched truncated mdat container length.',
      };
    }
    return { repaired: false, data: brokenBytes, note: 'MP4 moov index already intact.' };
  }

  if (!ftypBox || !mdatBox) {
    return {
      repaired: false,
      data: brokenBytes,
      note: 'Missing ftyp or mdat container atom.',
    };
  }

  // Step 2: Try synthesizing missing moov atom from mdat H.264 NAL stream
  const mdatPayloadStart = mdatBox.offset + mdatBox.headerSize;
  const rawPayload = brokenBytes.subarray(mdatPayloadStart, mdatBox.offset + mdatBox.size);
  const { avccPayload, samples, sps, pps } = scanMdatH264Samples(rawPayload);

  const refCfg = referenceBytes ? extractReferenceAvcConfig(referenceBytes) : null;
  const fallbackSps = sps ?? new Uint8Array([0x67, 0x42, 0xc0, 0x1e, 0xd9, 0x00, 0xa0, 0x47, 0xfe, 0xc8]);
  const fallbackPps = pps ?? new Uint8Array([0x68, 0xce, 0x38, 0x80]);
  const avcC = refCfg?.avcC ?? (sps || pps ? buildAvcCBox(fallbackSps, fallbackPps) : null);

  if (samples.length === 0 || !avcC) {
    // No decodable NAL samples found; still clamp truncated mdat box header length cleanly
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
      note: 'Missing moov index atom; provide a healthy reference MP4 from the same camera for frame index rebuild.',
    };
  }

  // Rebuild ftyp + fixed mdat prefix
  const ftypBytes = brokenBytes.slice(ftypBox.offset, ftypBox.offset + ftypBox.size);
  const newMdat = new Uint8Array(8 + avccPayload.length);
  writeU32BE(newMdat, 0, newMdat.length);
  newMdat.set(asciiBytes('mdat'), 4);
  newMdat.set(avccPayload, 8);

  const mdatDataBaseOffset = ftypBytes.length + 8;
  const width = refCfg?.width ?? 1280;
  const height = refCfg?.height ?? 720;
  const timescale = refCfg?.timescale ?? 30000;
  const sampleDelta = refCfg?.sampleDelta ?? 1000;
  const duration = samples.length * sampleDelta;

  // mvhd (version 0, 96 bytes payload)
  const mvhdPayload = new Uint8Array(96);
  writeU32BE(mvhdPayload, 8, timescale);
  writeU32BE(mvhdPayload, 12, duration);
  writeU32BE(mvhdPayload, 16, 0x00010000); // rate 1.0
  writeU16BE(mvhdPayload, 20, 0x0100); // volume 1.0
  writeU32BE(mvhdPayload, 32, 0x00010000); // identity matrix
  writeU32BE(mvhdPayload, 48, 0x00010000);
  writeU32BE(mvhdPayload, 64, 0x40000000);
  writeU32BE(mvhdPayload, 92, 2); // next_track_ID
  const mvhd = makeFullBox('mvhd', 0, 0, mvhdPayload);

  // tkhd (version 0, flags=3 enabled+in_movie, 80 bytes payload)
  const tkhdPayload = new Uint8Array(80);
  writeU32BE(tkhdPayload, 8, 1); // track_ID
  writeU32BE(tkhdPayload, 16, duration);
  writeU32BE(tkhdPayload, 36, 0x00010000);
  writeU32BE(tkhdPayload, 52, 0x00010000);
  writeU32BE(tkhdPayload, 68, 0x40000000);
  writeU32BE(tkhdPayload, 72, width << 16);
  writeU32BE(tkhdPayload, 76, height << 16);
  const tkhd = makeFullBox('tkhd', 0, 3, tkhdPayload);

  // mdhd (version 0, 20 bytes)
  const mdhdPayload = new Uint8Array(20);
  writeU32BE(mdhdPayload, 8, timescale);
  writeU32BE(mdhdPayload, 12, duration);
  writeU16BE(mdhdPayload, 16, 0x55c4); // und
  const mdhd = makeFullBox('mdhd', 0, 0, mdhdPayload);

  // hdlr ('vide')
  const hdlrPayload = new Uint8Array(33);
  hdlrPayload.set(asciiBytes('vide'), 4);
  hdlrPayload.set(asciiBytes('VideoHandler\0'), 20);
  const hdlr = makeFullBox('hdlr', 0, 0, hdlrPayload);

  const vmhd = makeFullBox('vmhd', 0, 1, new Uint8Array(8));
  const urlBox = makeFullBox('url ', 0, 1);
  const drefPayload = new Uint8Array(4 + urlBox.length);
  writeU32BE(drefPayload, 0, 1);
  drefPayload.set(urlBox, 4);
  const dref = makeFullBox('dref', 0, 0, drefPayload);
  const dinf = makeBox('dinf', dref);

  // stsd -> avc1 -> avcC
  const avc1Header = new Uint8Array(78);
  writeU16BE(avc1Header, 6, 1); // data_reference_index
  writeU16BE(avc1Header, 24, width);
  writeU16BE(avc1Header, 26, height);
  writeU32BE(avc1Header, 28, 0x00480000);
  writeU32BE(avc1Header, 32, 0x00480000);
  writeU16BE(avc1Header, 40, 1);
  writeU16BE(avc1Header, 74, 0x0018);
  writeU16BE(avc1Header, 76, 0xffff);
  const avc1 = makeBox('avc1', avc1Header, avcC);
  const stsdCount = new Uint8Array(4);
  writeU32BE(stsdCount, 0, 1);
  const stsd = makeFullBox('stsd', 0, 0, stsdCount, avc1);

  // stts
  const sttsPayload = new Uint8Array(12);
  writeU32BE(sttsPayload, 0, 1);
  writeU32BE(sttsPayload, 4, samples.length);
  writeU32BE(sttsPayload, 8, sampleDelta);
  const stts = makeFullBox('stts', 0, 0, sttsPayload);

  // stsc (each sample as its own chunk so stco maps 1:1 safely)
  const stscPayload = new Uint8Array(16);
  writeU32BE(stscPayload, 0, 1);
  writeU32BE(stscPayload, 4, 1);
  writeU32BE(stscPayload, 8, 1);
  writeU32BE(stscPayload, 12, 1);
  const stsc = makeFullBox('stsc', 0, 0, stscPayload);

  // stsz
  const stszPayload = new Uint8Array(8 + samples.length * 4);
  writeU32BE(stszPayload, 0, 0);
  writeU32BE(stszPayload, 4, samples.length);
  for (let i = 0; i < samples.length; i++) {
    writeU32BE(stszPayload, 8 + i * 4, samples[i].size);
  }
  const stsz = makeFullBox('stsz', 0, 0, stszPayload);

  // stco
  const stcoPayload = new Uint8Array(4 + samples.length * 4);
  writeU32BE(stcoPayload, 0, samples.length);
  for (let i = 0; i < samples.length; i++) {
    writeU32BE(stcoPayload, 4 + i * 4, mdatDataBaseOffset + samples[i].offset);
  }
  const stco = makeFullBox('stco', 0, 0, stcoPayload);

  // stss (sync IDR keyframes)
  const keyIndices = samples
    .map((s, idx) => (s.isKey ? idx + 1 : 0))
    .filter((n) => n > 0);
  const stssBoxes: Uint8Array[] = [];
  if (keyIndices.length > 0) {
    const stssPayload = new Uint8Array(4 + keyIndices.length * 4);
    writeU32BE(stssPayload, 0, keyIndices.length);
    for (let i = 0; i < keyIndices.length; i++) {
      writeU32BE(stssPayload, 4 + i * 4, keyIndices[i]);
    }
    stssBoxes.push(makeFullBox('stss', 0, 0, stssPayload));
  }

  const stbl = makeBox('stbl', stsd, stts, stsc, stsz, stco, ...stssBoxes);
  const minf = makeBox('minf', vmhd, dinf, stbl);
  const mdia = makeBox('mdia', mdhd, hdlr, minf);
  const trak = makeBox('trak', tkhd, mdia);
  const moov = makeBox('moov', mvhd, trak);

  const out = new Uint8Array(ftypBytes.length + newMdat.length + moov.length);
  out.set(ftypBytes, 0);
  out.set(newMdat, ftypBytes.length);
  out.set(moov, ftypBytes.length + newMdat.length);

  return {
    repaired: true,
    data: out,
    note: `Synthesized missing MP4 moov index atom (${samples.length} H.264 frame${samples.length === 1 ? '' : 's'}${refCfg?.avcC ? ', reference codec config' : ''}).`,
  };
}
