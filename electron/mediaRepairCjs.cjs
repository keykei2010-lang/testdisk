const fs = require('node:fs');

// IEEE 802.3 CRC-32 for PNG chunk verification & recalculation
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[i] = c >>> 0;
}

function computeCrc32Cjs(buf, start = 0, length = buf.length - start) {
  let crc = 0xffffffff;
  const end = Math.min(buf.length, start + length);
  for (let i = start; i < end; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeBoxCjs(type, ...parts) {
  const payloadLen = parts.reduce((s, p) => s + p.length, 0);
  const out = Buffer.allocUnsafe(8 + payloadLen);
  out.writeUInt32BE(out.length, 0);
  out.write(type.slice(0, 4), 4, 'ascii');
  let off = 8;
  for (const p of parts) {
    p.copy(out, off);
    off += p.length;
  }
  return out;
}

function makeFullBoxCjs(type, version, flags, ...parts) {
  const vf = Buffer.from([
    version & 0xff,
    (flags >>> 16) & 0xff,
    (flags >>> 8) & 0xff,
    flags & 0xff,
  ]);
  return makeBoxCjs(type, vf, ...parts);
}

function writeU64BECjs(buf, pos, val) {
  const hi = Math.floor(val / 4294967296);
  const lo = val >>> 0;
  buf.writeUInt32BE(hi >>> 0, pos);
  buf.writeUInt32BE(lo, pos + 4);
}

// ============================================================================
// H.264 / HEVC SPS Exp-Golomb Resolution & FPS Parser
// ============================================================================
function stripEmulationBytesCjs(nal, maxOut = 128) {
  const out = [];
  for (let i = 0; i < nal.length && out.length < maxOut; i++) {
    if (i >= 2 && nal[i] === 0x03 && nal[i - 1] === 0x00 && nal[i - 2] === 0x00) continue;
    out.push(nal[i]);
  }
  return Buffer.from(out);
}

class BitReaderCjs {
  constructor(data) {
    this.data = data;
    this.bitPos = 0;
  }
  readBits(n) {
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
  readUE() {
    let zeros = 0;
    while (this.bitPos < this.data.length * 8 && this.readBits(1) === 0 && zeros < 24) zeros++;
    if (zeros === 0) return 0;
    return ((1 << zeros) - 1) + this.readBits(zeros);
  }
  readSE() {
    const c = this.readUE();
    return (c & 1) !== 0 ? (c + 1) >> 1 : -(c >> 1);
  }
}

function parseH264SpsCjs(sps) {
  if (!sps || sps.length < 4 || (sps[0] & 0x1f) !== 7) return null;
  const rbsp = stripEmulationBytesCjs(sps.subarray(1));
  if (rbsp.length < 3) return null;
  const br = new BitReaderCjs(rbsp);
  const profileIdc = br.readBits(8);
  br.readBits(16);
  br.readUE();
  let chroma = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134].includes(profileIdc)) {
    chroma = br.readUE();
    if (chroma === 3) br.readBits(1);
    br.readUE();
    br.readUE();
    br.readBits(1);
    if (br.readBits(1) === 1) {
      const cnt = chroma !== 3 ? 8 : 12;
      for (let i = 0; i < cnt; i++) {
        if (br.readBits(1) === 1) {
          const sz = i < 6 ? 16 : 64;
          let last = 8;
          let next = 8;
          for (let j = 0; j < sz; j++) {
            if (next !== 0) next = (last + br.readSE() + 256) % 256;
            last = next === 0 ? last : next;
          }
        }
      }
    }
  }
  br.readUE();
  const poc = br.readUE();
  if (poc === 0) br.readUE();
  else if (poc === 1) {
    br.readBits(1);
    br.readSE();
    br.readSE();
    const n = Math.min(64, br.readUE());
    for (let i = 0; i < n; i++) br.readSE();
  }
  br.readUE();
  br.readBits(1);
  const wMbs = br.readUE();
  const hMap = br.readUE();
  const frameMbs = br.readBits(1);
  if (frameMbs === 0) br.readBits(1);
  br.readBits(1);
  let cl = 0, cr = 0, ct = 0, cb = 0;
  if (br.readBits(1) === 1) {
    cl = br.readUE();
    cr = br.readUE();
    ct = br.readUE();
    cb = br.readUE();
  }
  const cx = chroma === 0 ? 1 : 2;
  const cy = (chroma === 0 ? 1 : 2) * (2 - frameMbs);
  const width = (wMbs + 1) * 16 - (cl + cr) * cx;
  const height = (2 - frameMbs) * (hMap + 1) * 16 - (ct + cb) * cy;
  if (width < 64 || width > 8192 || height < 64 || height > 8192) return null;

  let fps;
  if (br.readBits(1) === 1) {
    if (br.readBits(1) === 1 && br.readBits(8) === 255) br.readBits(32);
    if (br.readBits(1) === 1) br.readBits(1);
    if (br.readBits(1) === 1) {
      br.readBits(4);
      if (br.readBits(1) === 1) br.readBits(24);
    }
    if (br.readBits(1) === 1) {
      br.readUE();
      br.readUE();
    }
    if (br.readBits(1) === 1) {
      const nu = br.readBits(32) >>> 0;
      const ts = br.readBits(32) >>> 0;
      if (nu > 0 && ts > 0) {
        const f = ts / (2 * nu);
        if (f >= 5 && f <= 240) fps = Math.round(f * 100) / 100;
      }
    }
  }
  return { width, height, fps };
}

function parseHevcSpsCjs(sps) {
  if (!sps || sps.length < 6 || ((sps[0] >> 1) & 0x3f) !== 33) return null;
  const rbsp = stripEmulationBytesCjs(sps.subarray(2));
  if (rbsp.length < 4) return null;
  const br = new BitReaderCjs(rbsp);
  br.readBits(4);
  const maxSub = br.readBits(3);
  br.readBits(1);
  br.readBits(88); // PTL fixed bits
  br.readBits(8);
  const sp = [];
  const sl = [];
  for (let i = 0; i < maxSub; i++) {
    sp.push(br.readBits(1));
    sl.push(br.readBits(1));
  }
  if (maxSub > 0) for (let i = maxSub; i < 8; i++) br.readBits(2);
  for (let i = 0; i < maxSub; i++) {
    if (sp[i]) br.readBits(88);
    if (sl[i]) br.readBits(8);
  }
  br.readUE();
  const chroma = br.readUE();
  if (chroma === 3) br.readBits(1);
  const w = br.readUE();
  const h = br.readUE();
  if (w < 64 || w > 8192 || h < 64 || h > 8192) return null;
  if (br.readBits(1) === 1) {
    const l = br.readUE(), r = br.readUE(), t = br.readUE(), b = br.readUE();
    const sx = chroma === 1 || chroma === 2 ? 2 : 1;
    const sy = chroma === 1 ? 2 : 1;
    const cw = w - (l + r) * sx;
    const ch = h - (t + b) * sy;
    if (cw >= 64 && ch >= 64) return { width: cw, height: ch };
  }
  return { width: w, height: h };
}

// ============================================================================
// Streaming File-Descriptor Reader for Multi-GB MP4/MOV/HEVC Files
// ============================================================================
class SlidingFdWindow {
  constructor(fd, rangeStart, rangeEnd, windowBytes = 8 * 1024 * 1024) {
    this.fd = fd;
    this.rangeStart = rangeStart;
    this.rangeEnd = rangeEnd;
    this.windowBytes = windowBytes;
    this.buf = Buffer.allocUnsafe(windowBytes);
    this.winStart = -1;
    this.winLen = 0;
  }

  ensure(absOffset, minBytes = 1) {
    if (absOffset < this.rangeStart || absOffset >= this.rangeEnd) return false;
    if (
      this.winStart >= 0 &&
      absOffset >= this.winStart &&
      absOffset + minBytes <= this.winStart + this.winLen
    ) {
      return true;
    }
    const maxAvail = this.rangeEnd - absOffset;
    const toRead = Math.min(this.windowBytes, maxAvail);
    if (toRead <= 0) return false;
    const n = fs.readSync(this.fd, this.buf, 0, toRead, absOffset);
    if (n <= 0) return false;
    this.winStart = absOffset;
    this.winLen = n;
    return absOffset + minBytes <= this.winStart + this.winLen;
  }

  availableFrom(absOffset) {
    if (!this.ensure(absOffset, 1)) return 0;
    return this.winStart + this.winLen - absOffset;
  }

  byteAt(absOffset) {
    if (!this.ensure(absOffset, 1)) return 0;
    return this.buf[absOffset - this.winStart];
  }

  readU32BE(absOffset) {
    if (!this.ensure(absOffset, 4)) return 0;
    return this.buf.readUInt32BE(absOffset - this.winStart);
  }

  readSlice(absOffset, length) {
    if (length <= this.windowBytes && this.ensure(absOffset, length)) {
      const rel = absOffset - this.winStart;
      return Buffer.from(this.buf.subarray(rel, rel + length));
    }
    const out = Buffer.allocUnsafe(length);
    const n = fs.readSync(this.fd, out, 0, length, absOffset);
    return n === length ? out : out.subarray(0, Math.max(0, n));
  }

  copyToFd(dstFd, absOffset, length, scratch = Buffer.allocUnsafe(4 * 1024 * 1024)) {
    let rem = length;
    let cur = absOffset;
    while (rem > 0) {
      const chunk = Math.min(rem, scratch.length);
      if (
        this.winStart >= 0 &&
        cur >= this.winStart &&
        cur + chunk <= this.winStart + this.winLen
      ) {
        const rel = cur - this.winStart;
        fs.writeSync(dstFd, this.buf, rel, chunk);
        cur += chunk;
        rem -= chunk;
      } else {
        const n = fs.readSync(this.fd, scratch, 0, chunk, cur);
        if (n <= 0) break;
        fs.writeSync(dstFd, scratch, 0, n);
        cur += n;
        rem -= n;
      }
    }
  }
}

function findNestedBoxBuf(buf, start, end, targetType) {
  let pos = start;
  while (pos + 8 <= end) {
    let sz = buf.readUInt32BE(pos);
    const tp = buf.toString('ascii', pos + 4, pos + 8);
    if (sz === 0) sz = end - pos;
    if (sz < 8 || pos + sz > end) break;
    if (tp === targetType) return { offset: pos, size: sz, type: tp };
    pos += sz;
  }
  return null;
}

function extractReferenceConfigsCjs(refBuf) {
  let video = null;
  let audio = null;
  if (!refBuf || refBuf.length < 32) return { video, audio };

  let pos = 0;
  let moovStart = -1;
  let moovEnd = -1;
  while (pos + 8 <= refBuf.length) {
    let sz = refBuf.readUInt32BE(pos);
    const tp = refBuf.toString('ascii', pos + 4, pos + 8);
    if (sz === 1 && pos + 16 <= refBuf.length) {
      sz = refBuf.readUInt32BE(pos + 8) * 4294967296 + refBuf.readUInt32BE(pos + 12);
    } else if (sz === 0) {
      sz = refBuf.length - pos;
    }
    if (!/^[\x20-\x7e]{4}$/.test(tp) || sz < 8 || pos + sz > refBuf.length) break;
    if (tp === 'moov') {
      moovStart = pos + 8;
      moovEnd = pos + sz;
      break;
    }
    pos += sz;
  }
  if (moovStart < 0) return { video, audio };

  let p = moovStart;
  while (p + 8 <= moovEnd) {
    const sz = refBuf.readUInt32BE(p);
    const tp = refBuf.toString('ascii', p + 4, p + 8);
    if (sz < 8 || p + sz > moovEnd) break;
    if (tp === 'trak') {
      const mdia = findNestedBoxBuf(refBuf, p + 8, p + sz, 'mdia');
      if (mdia) {
        let timescale = 30000;
        const mdhd = findNestedBoxBuf(refBuf, mdia.offset + 8, mdia.offset + mdia.size, 'mdhd');
        if (mdhd && mdhd.size >= 24) {
          const ver = refBuf[mdhd.offset + 8];
          const tsOff = ver === 1 ? mdhd.offset + 28 : mdhd.offset + 20;
          if (tsOff + 4 <= mdhd.offset + mdhd.size) {
            const ts = refBuf.readUInt32BE(tsOff);
            if (ts >= 100 && ts <= 2000000) timescale = ts;
          }
        }
        const hdlr = findNestedBoxBuf(refBuf, mdia.offset + 8, mdia.offset + mdia.size, 'hdlr');
        const hdlrType = hdlr && hdlr.size >= 20 ? refBuf.toString('ascii', hdlr.offset + 16, hdlr.offset + 20) : '';
        const minf = findNestedBoxBuf(refBuf, mdia.offset + 8, mdia.offset + mdia.size, 'minf');
        const stbl = minf ? findNestedBoxBuf(refBuf, minf.offset + 8, minf.offset + minf.size, 'stbl') : null;
        const stsd = stbl ? findNestedBoxBuf(refBuf, stbl.offset + 8, stbl.offset + stbl.size, 'stsd') : null;
        const stts = stbl ? findNestedBoxBuf(refBuf, stbl.offset + 8, stbl.offset + stbl.size, 'stts') : null;
        let refDelta = Math.max(1, Math.round(timescale / 30));
        if (stts && stts.size >= 24) {
          const d = refBuf.readUInt32BE(stts.offset + 20);
          if (d >= 1 && d <= timescale) refDelta = d;
        }

        if (stsd && stsd.size > 24) {
          if (!video && (!hdlrType || hdlrType === 'vide')) {
            const avc1 = findNestedBoxBuf(refBuf, stsd.offset + 16, stsd.offset + stsd.size, 'avc1');
            const hvc1 =
              findNestedBoxBuf(refBuf, stsd.offset + 16, stsd.offset + stsd.size, 'hvc1') ||
              findNestedBoxBuf(refBuf, stsd.offset + 16, stsd.offset + stsd.size, 'hev1');
            if (avc1 && avc1.size > 86) {
              const avcC = findNestedBoxBuf(refBuf, avc1.offset + 86, avc1.offset + avc1.size, 'avcC');
              if (avcC) {
                video = {
                  codec: 'h264',
                  codecBoxType: 'avc1',
                  configBox: Buffer.from(refBuf.subarray(avcC.offset, avcC.offset + avcC.size)),
                  width: refBuf.readUInt16BE(avc1.offset + 32) || 1280,
                  height: refBuf.readUInt16BE(avc1.offset + 34) || 720,
                  timescale,
                  sampleDelta: refDelta,
                };
              }
            } else if (hvc1 && hvc1.size > 86) {
              const hvcC = findNestedBoxBuf(refBuf, hvc1.offset + 86, hvc1.offset + hvc1.size, 'hvcC');
              if (hvcC) {
                video = {
                  codec: 'hevc',
                  codecBoxType: hvc1.type,
                  configBox: Buffer.from(refBuf.subarray(hvcC.offset, hvcC.offset + hvcC.size)),
                  width: refBuf.readUInt16BE(hvc1.offset + 32) || 1920,
                  height: refBuf.readUInt16BE(hvc1.offset + 34) || 1080,
                  timescale,
                  sampleDelta: refDelta,
                };
              }
            }
          }
          if (!audio && (!hdlrType || hdlrType === 'soun')) {
            const ae =
              findNestedBoxBuf(refBuf, stsd.offset + 16, stsd.offset + stsd.size, 'mp4a') ||
              findNestedBoxBuf(refBuf, stsd.offset + 16, stsd.offset + stsd.size, 'sowt') ||
              findNestedBoxBuf(refBuf, stsd.offset + 16, stsd.offset + stsd.size, 'twos') ||
              findNestedBoxBuf(refBuf, stsd.offset + 16, stsd.offset + stsd.size, 'lpcm');
            if (ae && ae.size >= 36) {
              const channels = refBuf.readUInt16BE(ae.offset + 24) || 2;
              const bits = refBuf.readUInt16BE(ae.offset + 26) || 16;
              const sr = refBuf.readUInt16BE(ae.offset + 32) || 48000;
              audio = {
                codecType: ae.type,
                stsdEntryBox: Buffer.from(refBuf.subarray(ae.offset, ae.offset + ae.size)),
                timescale: timescale || sr,
                sampleDelta: ae.type === 'mp4a' ? 1024 : refDelta,
                sampleRate: sr,
                channels,
                bitsPerSample: bits,
              };
            }
          }
        }
      }
    }
    p += sz;
  }
  return { video, audio };
}

function buildAvcCBoxCjs(sps, pps) {
  const profile = sps.length >= 2 ? sps[1] : 0x42;
  const compat = sps.length >= 3 ? sps[2] : 0xc0;
  const level = sps.length >= 4 ? sps[3] : 0x1e;
  const body = Buffer.allocUnsafe(11 + sps.length + pps.length);
  body[0] = 1;
  body[1] = profile;
  body[2] = compat;
  body[3] = level;
  body[4] = 0xff;
  body[5] = 0xe1;
  body.writeUInt16BE(sps.length, 6);
  sps.copy(body, 8);
  const pp = 8 + sps.length;
  body[pp] = 1;
  body.writeUInt16BE(pps.length, pp + 1);
  pps.copy(body, pp + 3);
  return makeBoxCjs('avcC', body);
}

function buildHvcCBoxCjs(vps, sps, pps) {
  const arrays = [];
  if (vps && vps.length > 2) arrays.push({ t: 32, u: vps });
  if (sps && sps.length > 2) arrays.push({ t: 33, u: sps });
  if (pps && pps.length > 2) arrays.push({ t: 34, u: pps });
  const arrLen = arrays.reduce((s, a) => s + 5 + a.u.length, 0);
  const body = Buffer.alloc(23 + arrLen);
  body[0] = 1;
  body[1] = 1;
  body.writeUInt32BE(0x60000000, 2);
  body[6] = 0x90;
  body[12] = 93;
  body.writeUInt16BE(0xf000, 13);
  body[15] = 0xfc;
  body[16] = 0xfd;
  body[17] = 0xf8;
  body[18] = 0xf8;
  body[21] = 0x0f;
  body[22] = arrays.length;
  let cur = 23;
  for (const a of arrays) {
    body[cur] = 0x80 | a.t;
    body.writeUInt16BE(1, cur + 1);
    body.writeUInt16BE(a.u.length, cur + 3);
    a.u.copy(body, cur + 5);
    cur += 5 + a.u.length;
  }
  return makeBoxCjs('hvcC', body);
}

function buildDefaultMp4aBoxCjs(sampleRate = 48000, channels = 2) {
  const srTable = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  let idx = srTable.indexOf(sampleRate);
  if (idx < 0) idx = 3;
  const asc0 = (2 << 3) | ((idx >> 1) & 0x07);
  const asc1 = ((idx & 1) << 7) | ((channels & 0x0f) << 3);
  const esdsPayload = Buffer.from([
    0x03, 0x19, 0x00, 0x01, 0x00,
    0x04, 0x11, 0x40, 0x15, 0x00, 0x00, 0x00, 0x00, 0x01, 0xf4, 0x00, 0x00, 0x01, 0xf4, 0x00,
    0x05, 0x02, asc0, asc1,
    0x06, 0x01, 0x02,
  ]);
  const esds = makeFullBoxCjs('esds', 0, 0, esdsPayload);
  const hdr = Buffer.alloc(28);
  hdr.writeUInt16BE(1, 6);
  hdr.writeUInt16BE(channels, 16);
  hdr.writeUInt16BE(16, 18);
  hdr.writeUInt32BE((sampleRate << 16) >>> 0, 24);
  return makeBoxCjs('mp4a', hdr, esds);
}

function buildTrackBoxCjs({
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
}) {
  const duration = samples.length * sampleDelta;
  const tkhdP = Buffer.alloc(80);
  tkhdP.writeUInt32BE(trackId, 8);
  tkhdP.writeUInt32BE(duration >>> 0, 16);
  if (handlerType === 'soun') tkhdP.writeUInt16BE(0x0100, 32);
  tkhdP.writeUInt32BE(0x00010000, 36);
  tkhdP.writeUInt32BE(0x00010000, 52);
  tkhdP.writeUInt32BE(0x40000000, 68);
  if (handlerType === 'vide') {
    tkhdP.writeUInt32BE((width << 16) >>> 0, 72);
    tkhdP.writeUInt32BE((height << 16) >>> 0, 76);
  }
  const tkhd = makeFullBoxCjs('tkhd', 0, 3, tkhdP);

  const mdhdP = Buffer.alloc(20);
  mdhdP.writeUInt32BE(timescale >>> 0, 8);
  mdhdP.writeUInt32BE(duration >>> 0, 12);
  mdhdP.writeUInt16BE(0x55c4, 16);
  const mdhd = makeFullBoxCjs('mdhd', 0, 0, mdhdP);

  const hdlrP = Buffer.alloc(20 + handlerName.length + 1);
  hdlrP.write(handlerType, 4, 'ascii');
  hdlrP.write(`${handlerName}\0`, 20, 'ascii');
  const hdlr = makeFullBoxCjs('hdlr', 0, 0, hdlrP);

  const mediaHdr =
    handlerType === 'vide'
      ? makeFullBoxCjs('vmhd', 0, 1, Buffer.alloc(8))
      : makeFullBoxCjs('smhd', 0, 0, Buffer.alloc(4));

  const drefP = Buffer.alloc(4);
  drefP.writeUInt32BE(1, 0);
  const dinf = makeBoxCjs('dinf', makeFullBoxCjs('dref', 0, 0, Buffer.concat([drefP, makeFullBoxCjs('url ', 0, 1)])));

  const stsdCnt = Buffer.alloc(4);
  stsdCnt.writeUInt32BE(1, 0);
  const stsd = makeFullBoxCjs('stsd', 0, 0, stsdCnt, stsdEntry);

  const sttsP = Buffer.alloc(12);
  sttsP.writeUInt32BE(1, 0);
  sttsP.writeUInt32BE(samples.length, 4);
  sttsP.writeUInt32BE(sampleDelta, 8);
  const stts = makeFullBoxCjs('stts', 0, 0, sttsP);

  const stscP = Buffer.alloc(16);
  stscP.writeUInt32BE(1, 0);
  stscP.writeUInt32BE(1, 4);
  stscP.writeUInt32BE(1, 8);
  stscP.writeUInt32BE(1, 12);
  const stsc = makeFullBoxCjs('stsc', 0, 0, stscP);

  const stszP = Buffer.allocUnsafe(8 + samples.length * 4);
  stszP.writeUInt32BE(0, 0);
  stszP.writeUInt32BE(samples.length, 4);
  for (let i = 0; i < samples.length; i++) {
    stszP.writeUInt32BE(samples[i].size >>> 0, 8 + i * 4);
  }
  const stsz = makeFullBoxCjs('stsz', 0, 0, stszP);

  let maxOff = 0;
  for (const s of samples) {
    const abs = mdatDataBaseOffset + s.offset;
    if (abs > maxOff) maxOff = abs;
  }

  let chunkBox;
  if (maxOff > 0xffffffff) {
    const co64P = Buffer.allocUnsafe(4 + samples.length * 8);
    co64P.writeUInt32BE(samples.length, 0);
    for (let i = 0; i < samples.length; i++) {
      writeU64BECjs(co64P, 4 + i * 8, mdatDataBaseOffset + samples[i].offset);
    }
    chunkBox = makeFullBoxCjs('co64', 0, 0, co64P);
  } else {
    const stcoP = Buffer.allocUnsafe(4 + samples.length * 4);
    stcoP.writeUInt32BE(samples.length, 0);
    for (let i = 0; i < samples.length; i++) {
      stcoP.writeUInt32BE((mdatDataBaseOffset + samples[i].offset) >>> 0, 4 + i * 4);
    }
    chunkBox = makeFullBoxCjs('stco', 0, 0, stcoP);
  }

  const stssBoxes = [];
  if (handlerType === 'vide') {
    const keys = [];
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].isKey) keys.push(i + 1);
    }
    if (keys.length > 0) {
      const stssP = Buffer.allocUnsafe(4 + keys.length * 4);
      stssP.writeUInt32BE(keys.length, 0);
      for (let i = 0; i < keys.length; i++) stssP.writeUInt32BE(keys[i], 4 + i * 4);
      stssBoxes.push(makeFullBoxCjs('stss', 0, 0, stssP));
    }
  }

  const stbl = makeBoxCjs('stbl', stsd, stts, stsc, stsz, chunkBox, ...stssBoxes);
  const minf = makeBoxCjs('minf', mediaHdr, dinf, stbl);
  const mdia = makeBoxCjs('mdia', mdhd, hdlr, minf);
  return makeBoxCjs('trak', tkhd, mdia);
}

function isLikelyAdtsAtReader(win, pos, end) {
  if (pos + 7 > end) return null;
  const b0 = win.byteAt(pos);
  const b1 = win.byteAt(pos + 1);
  if (b0 !== 0xff || (b1 & 0xf0) !== 0xf0) return null;
  if (((b1 >> 1) & 0x03) !== 0) return null;
  const b2 = win.byteAt(pos + 2);
  const b3 = win.byteAt(pos + 3);
  const b4 = win.byteAt(pos + 4);
  const b5 = win.byteAt(pos + 5);
  const srIdx = (b2 >> 2) & 0x0f;
  const srTable = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  if (srIdx >= srTable.length) return null;
  const frameLen = ((b3 & 0x03) << 11) | (b4 << 3) | ((b5 >> 5) & 0x07);
  if (frameLen < 7 || pos + frameLen > end) return null;
  const channels = ((b2 & 0x01) << 2) | ((b3 >> 6) & 0x03);
  return { frameLen, sampleRate: srTable[srIdx], channels: channels || 2 };
}

function isLikelyRawAacHead(win, pos, len) {
  if (len < 12 || len > 4096) return false;
  const b = win.byteAt(pos);
  return b !== 0 && ((b >>> 5) & 0x07) <= 6;
}

/**
 * Multi-GB Streaming MP4 / MOV / M4V / 3GP Repair:
 * Streams directly over file descriptors without reading huge videos into RAM.
 * Supports H.264/HEVC, SPS resolution/FPS decoding, Annex-B & AVCC/HVCC streams,
 * ADTS + reference-matched raw AAC/PCM audio tracks, corrupt sector resync,
 * headerless wiped ftyp/mdat recovery, and 64-bit co64/mdat (>4 GiB files).
 */
function repairMp4StreamingFileCjs(srcPath, dstPath, referenceBuf) {
  if (!srcPath || !fs.existsSync(srcPath)) return { ok: false, note: 'Source file not found.' };
  const fileSize = fs.statSync(srcPath).size;
  if (fileSize < 16) return { ok: false, note: 'Video file smaller than ISO BMFF minimum.' };

  const refCfgs = extractReferenceConfigsCjs(referenceBuf);
  const refVideo = refCfgs.video;
  const refAudio = refCfgs.audio;

  const srcFd = fs.openSync(srcPath, 'r');
  try {
    // 1. Parse top-level ISO BMFF atoms using tiny header reads
    const boxes = [];
    let pos = 0;
    let truncatedAt = null;
    const hdrBuf = Buffer.allocUnsafe(16);

    while (pos + 8 <= fileSize && boxes.length < 512) {
      const nRead = fs.readSync(srcFd, hdrBuf, 0, Math.min(16, fileSize - pos), pos);
      if (nRead < 8) break;
      let sz = hdrBuf.readUInt32BE(0);
      const tp = hdrBuf.toString('ascii', 4, 8);
      if (!/^[\x20-\x7e]{4}$/.test(tp)) break;
      let hSz = 8;
      if (sz === 1 && nRead >= 16) {
        sz = hdrBuf.readUInt32BE(8) * 4294967296 + hdrBuf.readUInt32BE(12);
        hSz = 16;
      } else if (sz === 0) {
        sz = fileSize - pos;
        boxes.push({ type: tp, offset: pos, size: sz, headerSize: hSz });
        truncatedAt = pos;
        break;
      }
      if (sz < 8) break;
      if (pos + sz > fileSize) {
        boxes.push({ type: tp, offset: pos, size: fileSize - pos, headerSize: hSz });
        truncatedAt = pos;
        break;
      }
      boxes.push({ type: tp, offset: pos, size: sz, headerSize: hSz });
      pos += sz;
    }

    const hasMoov = boxes.some((b) => b.type === 'moov');
    const ftypBox = boxes.find((b) => b.type === 'ftyp');
    const mdatBoxes = boxes.filter((b) => b.type === 'mdat');

    // If moov exists and trailing box size is truncated, stream-copy + patch tail box header
    if (hasMoov) {
      if (truncatedAt === null) {
        return { ok: false, note: 'MP4 moov index already intact.' };
      }
      const dstFd = fs.openSync(dstPath, 'w');
      try {
        const win = new SlidingFdWindow(srcFd, 0, fileSize, 4 * 1024 * 1024);
        win.copyToFd(dstFd, 0, fileSize);
        const fixSz = Buffer.allocUnsafe(4);
        fixSz.writeUInt32BE(Math.max(8, fileSize - truncatedAt) >>> 0, 0);
        fs.writeSync(dstFd, fixSz, 0, 4, truncatedAt);
      } finally {
        fs.closeSync(dstFd);
      }
      return { ok: true, tier: 'structural-moov', note: 'Patched truncated ISO BMFF trailing atom length.' };
    }

    // Determine source payload spans
    let ftypBuf;
    let payloadSpans = [];
    let recoveredHeaderless = false;

    if (mdatBoxes.length > 0) {
      if (ftypBox) {
        ftypBuf = Buffer.allocUnsafe(ftypBox.size);
        fs.readSync(srcFd, ftypBuf, 0, ftypBox.size, ftypBox.offset);
      } else {
        ftypBuf = makeBoxCjs('ftyp', Buffer.from('mp42\0\0\0\0mp42isom', 'ascii'));
      }
      payloadSpans = mdatBoxes.map((b) => ({
        start: b.offset + b.headerSize,
        end: b.offset + b.size,
      }));
    } else {
      // Headerless recovery: scan leading 4 MiB for raw SPS/PPS/IDR or AVCC chain
      const probeLen = Math.min(fileSize, 4 * 1024 * 1024);
      const probeBuf = Buffer.allocUnsafe(probeLen);
      fs.readSync(srcFd, probeBuf, 0, probeLen, 0);
      let rawStart = -1;
      for (let i = 0; i + 8 < probeLen; i++) {
        if (probeBuf[i] === 0 && probeBuf[i + 1] === 0 && ((probeBuf[i + 2] === 0 && probeBuf[i + 3] === 1) || probeBuf[i + 2] === 1)) {
          const sc = probeBuf[i + 2] === 1 ? 3 : 4;
          const b0 = probeBuf[i + sc];
          if ((b0 & 0x80) === 0) {
            const h264T = b0 & 0x1f;
            const hevcT = (b0 >> 1) & 0x3f;
            if (h264T === 7 || h264T === 5 || hevcT === 32 || hevcT === 33 || (hevcT >= 16 && hevcT <= 21)) {
              rawStart = i;
              break;
            }
          }
        }
        const nl = probeBuf.readUInt32BE(i);
        if (nl >= 4 && nl <= 2 * 1024 * 1024 && i + 4 + nl + 5 <= probeLen) {
          const b0 = probeBuf[i + 4];
          const nl2 = probeBuf.readUInt32BE(i + 4 + nl);
          if ((b0 & 0x80) === 0 && nl2 >= 4 && nl2 <= 2 * 1024 * 1024 && i + 4 + nl + 4 + nl2 <= probeLen) {
            const nb0 = probeBuf[i + 4 + nl + 4];
            if ((nb0 & 0x80) === 0) {
              const nt1 = refVideo?.codec === 'hevc' ? (b0 >> 1) & 0x3f : b0 & 0x1f;
              const ok1 = refVideo?.codec === 'hevc' ? (nt1 === 32 || nt1 === 33 || (nt1 >= 16 && nt1 <= 21)) : (nt1 === 7 || nt1 === 8 || nt1 === 5);
              if (ok1) {
                rawStart = i;
                break;
              }
            }
          }
        }
      }
      if (rawStart < 0) {
        return { ok: false, note: 'No mdat atom or raw H.264/HEVC bitstream found in file.' };
      }
      recoveredHeaderless = true;
      ftypBuf = makeBoxCjs('ftyp', Buffer.from('mp42\0\0\0\0mp42isom', 'ascii'));
      payloadSpans = [{ start: rawStart, end: fileSize }];
    }

    // Reserve ftyp + 16-byte extended 64-bit mdat header in dstPath so we never need to shift multi-GB mdat bytes!
    const mdatBoxOffset = ftypBuf.length;
    const mdatHeaderSize = 16; // write 64-bit extended size box ('size=1', 'mdat', u64) universally valid in ISO BMFF
    const mdatDataBaseOffset = mdatBoxOffset + mdatHeaderSize;

    const dstFd = fs.openSync(dstPath, 'w');
    let committed = false;
    try {
      fs.writeSync(dstFd, ftypBuf);
      const placeholderHdr = Buffer.alloc(16);
      placeholderHdr.writeUInt32BE(1, 0);
      placeholderHdr.write('mdat', 4, 'ascii');
      fs.writeSync(dstFd, placeholderHdr);

      let codec = refVideo ? refVideo.codec : 'h264';
      let vps = null;
      let sps = null;
      let pps = null;
      let detectedAudioSampleRate = refAudio ? refAudio.sampleRate : 48000;
      let detectedAudioChannels = refAudio ? refAudio.channels : 2;
      const rawAudioIsPcm = Boolean(
        refAudio && ['sowt', 'twos', 'lpcm', 'in24', 'in32', 'fl32'].includes(refAudio.codecType),
      );

      const videoSamples = [];
      const audioSamples = [];
      let outCursor = 0;

      for (const span of payloadSpans) {
        if (span.end <= span.start) continue;
        const win = new SlidingFdWindow(srcFd, span.start, span.end, 8 * 1024 * 1024);

        // Quick codec probe at start of first span if no reference
        if (!refVideo && videoSamples.length === 0) {
          let pp = span.start;
          let hevcHits = 0;
          let h264Hits = 0;
          let steps = 0;
          while (pp + 6 <= span.end && steps < 48) {
            steps++;
            const nl = win.readU32BE(pp);
            if (nl >= 2 && nl <= 4 * 1024 * 1024 && pp + 4 + nl <= span.end) {
              const b0 = win.byteAt(pp + 4);
              const b1 = win.byteAt(pp + 5);
              if ((b0 & 0x80) === 0) {
                const ht = (b0 >> 1) & 0x3f;
                const h4 = b0 & 0x1f;
                if ((ht === 32 || ht === 33 || ht === 34) && (b0 & 0x01) === 0 && (b1 & 0x07) >= 1) hevcHits += 3;
                else if (ht >= 16 && ht <= 21 && (b0 & 0x01) === 0 && (b1 & 0x07) >= 1) hevcHits += 2;
                if (h4 === 7 || h4 === 8) h264Hits += 3;
                else if (h4 === 5 || h4 === 1) h264Hits += 1;
              }
              pp += 4 + nl;
            } else break;
          }
          if (hevcHits > h264Hits) codec = 'hevc';
        }

        // Scan length-prefixed AVCC/HVCC + ADTS + raw audio + 8KB resync
        let cur = span.start;
        let spanVideoHits = 0;
        while (cur + 5 <= span.end) {
          const adts = isLikelyAdtsAtReader(win, cur, span.end);
          if (adts) {
            const hLen = (win.byteAt(cur + 1) & 0x01) === 0 ? 9 : 7;
            if (adts.frameLen > hLen) {
              const rawLen = adts.frameLen - hLen;
              win.copyToFd(dstFd, cur + hLen, rawLen);
              detectedAudioSampleRate = adts.sampleRate;
              detectedAudioChannels = adts.channels;
              audioSamples.push({ offset: outCursor, size: rawLen, isKey: true });
              outCursor += rawLen;
              cur += adts.frameLen;
              continue;
            }
          }

          const nalLen = win.readU32BE(cur);
          const maxLen = Math.min(16 * 1024 * 1024, span.end - cur - 4);
          if (nalLen >= 1 && nalLen <= maxLen) {
            const b0 = win.byteAt(cur + 4);
            const forbidden = (b0 & 0x80) !== 0;
            if (!forbidden && codec === 'hevc' && nalLen >= 2) {
              const ht = (b0 >> 1) & 0x3f;
              const tid = win.byteAt(cur + 5) & 0x07;
              const okHevc = tid >= 1 && ((ht >= 0 && ht <= 9) || (ht >= 16 && ht <= 21) || (ht >= 32 && ht <= 40));
              if (okHevc) {
                spanVideoHits++;
                if (ht === 32 && !vps && nalLen <= 4096) vps = win.readSlice(cur + 4, nalLen);
                else if (ht === 33 && !sps && nalLen <= 4096) sps = win.readSlice(cur + 4, nalLen);
                else if (ht === 34 && !pps && nalLen <= 4096) pps = win.readSlice(cur + 4, nalLen);
                win.copyToFd(dstFd, cur, 4 + nalLen);
                if (ht <= 21) {
                  videoSamples.push({ offset: outCursor, size: 4 + nalLen, isKey: ht >= 16 && ht <= 21 });
                }
                outCursor += 4 + nalLen;
                cur += 4 + nalLen;
                continue;
              }
            } else if (!forbidden && codec === 'h264') {
              const nt = b0 & 0x1f;
              if (nt >= 1 && nt <= 20) {
                spanVideoHits++;
                if (nt === 7 && !sps && nalLen <= 4096) sps = win.readSlice(cur + 4, nalLen);
                else if (nt === 8 && !pps && nalLen <= 4096) pps = win.readSlice(cur + 4, nalLen);
                win.copyToFd(dstFd, cur, 4 + nalLen);
                if (nt === 5 || nt === 1) {
                  videoSamples.push({ offset: outCursor, size: 4 + nalLen, isKey: nt === 5 });
                }
                outCursor += 4 + nalLen;
                cur += 4 + nalLen;
                continue;
              }
            }

            if (nalLen >= 12 && nalLen <= 4096 && cur + 4 + nalLen + 5 <= span.end && videoSamples.length > 0) {
              const nextLen = win.readU32BE(cur + 4 + nalLen);
              const nb0 = win.byteAt(cur + 4 + nalLen + 4);
              const nType = codec === 'hevc' ? (nb0 >> 1) & 0x3f : nb0 & 0x1f;
              if (
                nextLen > 0 &&
                cur + 4 + nalLen + 4 + nextLen <= span.end &&
                (nb0 & 0x80) === 0 &&
                ((codec === 'hevc' && nType <= 40) || (codec === 'h264' && nType >= 1 && nType <= 20))
              ) {
                if (refAudio && refAudio.codecType === 'mp4a' && isLikelyRawAacHead(win, cur + 4, nalLen)) {
                  win.copyToFd(dstFd, cur + 4, nalLen);
                  audioSamples.push({ offset: outCursor, size: nalLen, isKey: true });
                  outCursor += nalLen;
                }
                cur += 4 + nalLen;
                continue;
              }
            }
          }

          if (videoSamples.length > 0 && cur + 5 <= span.end) {
            let resynced = false;
            const searchEnd = Math.min(span.end - 5, cur + 8192);
            for (let scan = cur + 1; scan <= searchEnd; scan++) {
              if (isLikelyAdtsAtReader(win, scan, span.end)) {
                cur = scan;
                resynced = true;
                break;
              }
              const cl = win.readU32BE(scan);
              if (cl >= 4 && cl <= 2 * 1024 * 1024 && scan + 4 + cl <= span.end) {
                const cb0 = win.byteAt(scan + 4);
                if ((cb0 & 0x80) === 0) {
                  const nt = codec === 'hevc' ? (cb0 >> 1) & 0x3f : cb0 & 0x1f;
                  const okNt =
                    codec === 'hevc'
                      ? nt === 32 || nt === 33 || (nt >= 16 && nt <= 21) || (nt <= 9 && cl > 32)
                      : nt === 7 || nt === 8 || nt === 5 || (nt === 1 && cl > 32);
                  if (okNt && (scan + 4 + cl === span.end || scan + 4 + cl + 5 <= span.end)) {
                    const gapLen = scan - cur;
                    if (refAudio && gapLen >= 16 && gapLen <= 8192) {
                      if (rawAudioIsPcm && gapLen % Math.max(2, Math.floor((refAudio.bitsPerSample / 8) * refAudio.channels)) === 0) {
                        win.copyToFd(dstFd, cur, gapLen);
                        audioSamples.push({ offset: outCursor, size: gapLen, isKey: true });
                        outCursor += gapLen;
                      } else if (refAudio.codecType === 'mp4a' && isLikelyRawAacHead(win, cur, gapLen)) {
                        win.copyToFd(dstFd, cur, gapLen);
                        audioSamples.push({ offset: outCursor, size: gapLen, isKey: true });
                        outCursor += gapLen;
                      }
                    }
                    cur = scan;
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

        // Strategy 2 fallback: Annex-B start codes inside mdat/raw span
        if (spanVideoHits === 0) {
          const spanLen = span.end - span.start;
          const scanLim = span.start + Math.min(spanLen, 192 * 1024 * 1024);
          let scOffsets = [];
          for (let i = span.start; i + 4 <= scanLim; i++) {
            const b0 = win.byteAt(i);
            if (b0 === 0 && win.byteAt(i + 1) === 0) {
              const b2 = win.byteAt(i + 2);
              if (b2 === 0 && win.byteAt(i + 3) === 1) {
                scOffsets.push({ p: i, l: 4 });
                i += 3;
              } else if (b2 === 1) {
                scOffsets.push({ p: i, l: 3 });
                i += 2;
              }
            }
          }
          if (scOffsets.length > 0) {
            if (!refVideo) {
              for (const sc of scOffsets.slice(0, 16)) {
                const nb = win.byteAt(sc.p + sc.l);
                if ((nb & 0x80) === 0) {
                  const ht = (nb >> 1) & 0x3f;
                  if ((ht === 32 || ht === 33 || ht === 34) && (nb & 0x01) === 0) {
                    codec = 'hevc';
                    break;
                  }
                }
              }
            }
            const lenHdr = Buffer.allocUnsafe(4);
            for (let idx = 0; idx < scOffsets.length; idx++) {
              const nStart = scOffsets[idx].p + scOffsets[idx].l;
              const nEnd = idx + 1 < scOffsets.length ? scOffsets[idx + 1].p : span.end;
              const nLen = nEnd - nStart;
              if (nLen <= 0) continue;
              lenHdr.writeUInt32BE(nLen >>> 0, 0);
              fs.writeSync(dstFd, lenHdr);
              win.copyToFd(dstFd, nStart, nLen);
              const fb = win.byteAt(nStart);
              if (codec === 'hevc') {
                const ht = (fb >> 1) & 0x3f;
                if (ht === 32 && !vps && nLen <= 4096) vps = win.readSlice(nStart, nLen);
                if (ht === 33 && !sps && nLen <= 4096) sps = win.readSlice(nStart, nLen);
                if (ht === 34 && !pps && nLen <= 4096) pps = win.readSlice(nStart, nLen);
                if (ht <= 21) videoSamples.push({ offset: outCursor, size: 4 + nLen, isKey: ht >= 16 && ht <= 21 });
              } else {
                const nt = fb & 0x1f;
                if (nt === 7 && !sps && nLen <= 4096) sps = win.readSlice(nStart, nLen);
                if (nt === 8 && !pps && nLen <= 4096) pps = win.readSlice(nStart, nLen);
                if (nt === 5 || nt === 1) videoSamples.push({ offset: outCursor, size: 4 + nLen, isKey: nt === 5 });
              }
              outCursor += 4 + nLen;
            }
          }
        }
      }

      let configBox = null;
      let entryBoxType = 'avc1';
      if (codec === 'hevc') {
        entryBoxType = refVideo?.codec === 'hevc' ? refVideo.codecBoxType : 'hvc1';
        configBox =
          refVideo?.codec === 'hevc' && refVideo.configBox
            ? refVideo.configBox
            : vps || sps || pps
              ? buildHvcCBoxCjs(vps, sps, pps)
              : null;
      } else {
        const useSps = sps || Buffer.from([0x67, 0x42, 0xc0, 0x1e, 0xd9, 0x00, 0xa0, 0x47, 0xfe, 0xc8]);
        const usePps = pps || Buffer.from([0x68, 0xce, 0x38, 0x80]);
        configBox =
          refVideo?.codec === 'h264' && refVideo.configBox
            ? refVideo.configBox
            : sps || pps
              ? buildAvcCBoxCjs(useSps, usePps)
              : null;
      }

      if (videoSamples.length === 0 || !configBox) {
        return { ok: false, note: 'Could not extract video frames or codec parameters; supply a healthy reference clip.' };
      }

      const parsedDims =
        codec === 'hevc' && sps ? parseHevcSpsCjs(sps) : sps ? parseH264SpsCjs(sps) : null;
      const width = parsedDims?.width || refVideo?.width || (codec === 'hevc' ? 1920 : 1280);
      const height = parsedDims?.height || refVideo?.height || (codec === 'hevc' ? 1080 : 720);
      const timescale = refVideo?.timescale || 30000;
      const spsDelta = parsedDims?.fps ? Math.max(1, Math.round(timescale / parsedDims.fps)) : undefined;
      const sampleDelta = refVideo?.sampleDelta || spsDelta || 1000;
      const videoDuration = videoSamples.length * sampleDelta;

      // Patch 64-bit mdat total size in-place
      const mdatTotalBuf = Buffer.allocUnsafe(8);
      writeU64BECjs(mdatTotalBuf, 0, mdatHeaderSize + outCursor);
      fs.writeSync(dstFd, mdatTotalBuf, 0, 8, mdatBoxOffset + 8);

      const includeAudio = audioSamples.length > 0;
      const nextTrackId = includeAudio ? 3 : 2;
      const mvhdP = Buffer.alloc(96);
      mvhdP.writeUInt32BE(timescale >>> 0, 8);
      mvhdP.writeUInt32BE(videoDuration >>> 0, 12);
      mvhdP.writeUInt32BE(0x00010000, 16);
      mvhdP.writeUInt16BE(0x0100, 20);
      mvhdP.writeUInt32BE(0x00010000, 32);
      mvhdP.writeUInt32BE(0x00010000, 48);
      mvhdP.writeUInt32BE(0x40000000, 64);
      mvhdP.writeUInt32BE(nextTrackId, 92);
      const mvhd = makeFullBoxCjs('mvhd', 0, 0, mvhdP);

      const vidHdr = Buffer.alloc(78);
      vidHdr.writeUInt16BE(1, 6);
      vidHdr.writeUInt16BE(width, 24);
      vidHdr.writeUInt16BE(height, 26);
      vidHdr.writeUInt32BE(0x00480000, 28);
      vidHdr.writeUInt32BE(0x00480000, 32);
      vidHdr.writeUInt16BE(1, 40);
      vidHdr.writeUInt16BE(24, 74);
      vidHdr.writeInt16BE(-1, 76);
      const vidEntry = makeBoxCjs(entryBoxType, vidHdr, configBox);

      const videoTrak = buildTrackBoxCjs({
        trackId: 1,
        handlerType: 'vide',
        handlerName: 'VideoHandler',
        timescale,
        sampleDelta,
        samples: videoSamples,
        mdatDataBaseOffset,
        width,
        height,
        stsdEntry: vidEntry,
      });

      const traks = [videoTrak];
      if (includeAudio) {
        const audioEntry =
          refAudio?.stsdEntryBox || buildDefaultMp4aBoxCjs(detectedAudioSampleRate, detectedAudioChannels);
        traks.push(
          buildTrackBoxCjs({
            trackId: 2,
            handlerType: 'soun',
            handlerName: 'SoundHandler',
            timescale: refAudio?.timescale || detectedAudioSampleRate,
            sampleDelta: refAudio?.sampleDelta || 1024,
            samples: audioSamples,
            mdatDataBaseOffset,
            stsdEntry: audioEntry,
          }),
        );
      }

      const moov = makeBoxCjs('moov', mvhd, ...traks);
      fs.writeSync(dstFd, moov);
      committed = true;

      const codecLabel = codec === 'hevc' ? 'H.265/HEVC' : 'H.264/AVC';
      const audNote = includeAudio ? ` + ${audioSamples.length} audio frames` : '';
      const hdrNote = recoveredHeaderless ? ', rebuilt wiped header' : '';
      return {
        ok: true,
        tier: 'structural-moov',
        videoSamples: videoSamples.length,
        audioSamples: audioSamples.length,
        note: `Streaming MOOV rebuild recovered ${videoSamples.length} ${codecLabel} frames @ ${width}×${height}${audNote}${hdrNote}.`,
      };
    } finally {
      fs.closeSync(dstFd);
      if (!committed && fs.existsSync(dstPath)) {
        try { fs.unlinkSync(dstPath); } catch { /* ignore */ }
      }
    }
  } finally {
    fs.closeSync(srcFd);
  }
}

// ============================================================================
// Pro Image, JPEG Bitstream, EXIF Preview, PNG CRC/IDAT & AVI/MKV Repairs (CJS)
// ============================================================================
const STANDARD_JPEG_DHT_CJS = Buffer.from([
  0xff, 0xc4, 0x01, 0xa2,
  0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
  0x01, 0x00, 0x03, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
  0x10, 0x00, 0x02, 0x01, 0x03, 0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d,
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
  0x11, 0x00, 0x02, 0x01, 0x02, 0x04, 0x04, 0x03, 0x04, 0x07, 0x05, 0x04, 0x04, 0x00, 0x01, 0x02, 0x77,
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
]);

function inspectJpegCjs(buf) {
  const hasSoi = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8;
  const hasEoi = buf.length >= 2 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
  let hasDqt = false, hasSof = false, hasDht = false, hasSos = false;
  let sosOffset = -1, entropyStart = -1, sofOffset = -1, width, height;

  if (hasSoi) {
    let p = 2;
    const cap = Math.min(buf.length, 512 * 1024);
    while (p + 4 <= cap) {
      if (buf[p] !== 0xff) { p++; continue; }
      while (p + 1 < cap && buf[p + 1] === 0xff) p++;
      if (p + 1 >= cap) break;
      const m = buf[p + 1];
      if (m === 0x00 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
      if (m === 0xd9) break;
      if (p + 4 > cap) break;
      const len = buf.readUInt16BE(p + 2);
      if (len < 2 || p + 2 + len > buf.length) break;
      if (m === 0xdb) hasDqt = true;
      else if (m === 0xc0 || m === 0xc1 || m === 0xc2) {
        hasSof = true;
        sofOffset = p;
        if (p + 9 <= buf.length) {
          height = buf.readUInt16BE(p + 5);
          width = buf.readUInt16BE(p + 7);
        }
      } else if (m === 0xc4) hasDht = true;
      else if (m === 0xda) {
        hasSos = true;
        sosOffset = p;
        entropyStart = p + 2 + len;
        break;
      }
      p += 2 + len;
    }
  } else {
    const lim = Math.min(buf.length - 4, 256 * 1024);
    for (let p = 0; p < lim; p++) {
      if (buf[p] === 0xff && buf[p + 1] === 0xda) {
        const len = buf.readUInt16BE(p + 2);
        if (len >= 8 && len <= 32 && p + 2 + len <= buf.length) {
          hasSos = true;
          sosOffset = p;
          entropyStart = p + 2 + len;
          break;
        }
      }
    }
  }
  return { hasSoi, hasDqt, hasSof, hasDht, hasSos, hasEoi, sosOffset, entropyStart, sofOffset, width, height };
}

function extractEmbeddedJpegCjs(buf, skipZero = true) {
  let best = null;
  for (let i = skipZero ? 2 : 0; i + 16 < buf.length; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8 && buf[i + 2] === 0xff && [0xe0, 0xe1, 0xdb, 0xc0, 0xc4].includes(buf[i + 3])) {
      const maxEnd = Math.min(buf.length - 1, i + 16 * 1024 * 1024);
      for (let j = i + 16; j < maxEnd; j++) {
        if (buf[j] === 0xff && buf[j + 1] === 0xd9) {
          const sl = buf.subarray(i, j + 2);
          if (sl.length >= 256 && (!best || sl.length > best.length)) best = Buffer.from(sl);
          i = j + 1;
          break;
        }
      }
    }
  }
  return best;
}

function sanitizeJpegEntropyCjs(entropy) {
  let end = entropy.length;
  if (end >= 2 && entropy[end - 2] === 0xff && entropy[end - 1] === 0xd9) end -= 2;
  const before = end;
  while (end > 16 && entropy[end - 1] === 0x00) end--;
  const trimmedZeros = before - end >= 32 ? before - end : 0;
  if (trimmedZeros === 0) end = before;

  const out = [];
  let stuffed = 0;
  let rstFixed = 0;
  let expRst = 0;

  for (let i = 0; i < end; i++) {
    const b = entropy[i];
    if (b !== 0xff) { out.push(b); continue; }
    if (i + 1 >= end) { stuffed++; break; }
    const nx = entropy[i + 1];
    if (nx === 0x00 || nx === 0xff) { out.push(0xff, nx); i++; continue; }
    if (nx >= 0xd0 && nx <= 0xd7) {
      if (nx - 0xd0 !== expRst) rstFixed++;
      out.push(0xff, 0xd0 + expRst);
      expRst = (expRst + 1) & 7;
      i++;
      continue;
    }
    if (nx === 0xd9) break;
    out.push(0xff, 0x00, nx);
    stuffed++;
    i++;
  }
  out.push(0xff, 0xd9);
  return { bytes: Buffer.from(out), stuffed, rstFixed, trimmedZeros };
}

function repairJpegBufferCjs(rawBuf, referenceBuf) {
  if (!rawBuf || rawBuf.length < 2) return null;
  const info = inspectJpegCjs(rawBuf);
  const salvagedPreview = extractEmbeddedJpegCjs(rawBuf, true);

  if ((!info.hasSoi || !info.hasDqt || !info.hasSof) && referenceBuf && referenceBuf.length >= 24) {
    const refInfo = inspectJpegCjs(referenceBuf);
    if (refInfo.hasSoi && refInfo.hasDqt && refInfo.hasSof && refInfo.entropyStart > 16) {
      const refPrefix = Buffer.from(referenceBuf.subarray(0, refInfo.entropyStart));
      if (info.hasSof && info.width && info.height && refInfo.sofOffset > 0 && refInfo.sofOffset + 9 <= refPrefix.length) {
        refPrefix.writeUInt16BE(info.height, refInfo.sofOffset + 5);
        refPrefix.writeUInt16BE(info.width, refInfo.sofOffset + 7);
      }
      const rawEntropy = info.entropyStart > 0 ? rawBuf.subarray(info.entropyStart) : rawBuf;
      const san = sanitizeJpegEntropyCjs(rawEntropy);
      return {
        data: Buffer.concat([refPrefix, san.bytes]),
        salvagedPreview,
        note: `Transplanted reference JPEG DQT/SOF/DHT header (${refPrefix.length} B) and sanitized scan stream.`,
      };
    }
  }

  let working = rawBuf;
  let entStart = info.entropyStart;
  const actions = [];
  if (info.hasSoi && info.hasDqt && info.hasSof && !info.hasDht && info.sosOffset > 2) {
    working = Buffer.concat([working.subarray(0, info.sosOffset), STANDARD_JPEG_DHT_CJS, working.subarray(info.sosOffset)]);
    if (entStart > 0) entStart += STANDARD_JPEG_DHT_CJS.length;
    actions.push('injected ITU Baseline DHT tables');
  }

  if (entStart > 0 && entStart < working.length) {
    const san = sanitizeJpegEntropyCjs(working.subarray(entStart));
    if (san.stuffed > 0 || san.rstFixed > 0 || san.trimmedZeros > 0 || !info.hasEoi) {
      working = Buffer.concat([working.subarray(0, entStart), san.bytes]);
      if (san.stuffed > 0) actions.push(`byte-stuffed ${san.stuffed} corrupt 0xFF markers`);
      if (san.rstFixed > 0) actions.push(`re-sequenced ${san.rstFixed} RSTn markers`);
      if (san.trimmedZeros > 0) actions.push(`trimmed ${san.trimmedZeros} B zero slack`);
      if (!info.hasEoi) actions.push('appended EOI (0xFFD9)');
    }
  } else if (!info.hasEoi) {
    working = Buffer.concat([working, Buffer.from([0xff, 0xd9])]);
    actions.push('appended EOI (0xFFD9)');
  }

  if (actions.length > 0) {
    return { data: working, salvagedPreview, note: `Repaired JPEG (${actions.join('; ')}).` };
  }
  if ((!info.hasSoi || !info.hasDqt || !info.hasSof) && salvagedPreview) {
    return {
      data: salvagedPreview,
      salvagedPreview,
      note: `Salvaged embedded EXIF JPEG preview (${salvagedPreview.length} B).`,
    };
  }
  return salvagedPreview ? { data: null, salvagedPreview, note: 'EXIF preview available.' } : null;
}

function repairPngBufferCjs(rawBuf) {
  if (!rawBuf || rawBuf.length < 33 || rawBuf[0] !== 0x89 || rawBuf[1] !== 0x50 || rawBuf[2] !== 0x4e || rawBuf[3] !== 0x47) {
    return null;
  }
  const IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  const out = [rawBuf.subarray(0, 8)];
  let pos = 8;
  let crcFixes = 0;
  let clamped = false;
  let hasIend = false;

  while (pos + 8 <= rawBuf.length) {
    const len = rawBuf.readUInt32BE(pos);
    const tp = rawBuf.toString('ascii', pos + 4, pos + 8);
    if (!/^[A-Za-z]{4}$/.test(tp)) break;
    const end = pos + 12 + len;
    if (end <= rawBuf.length) {
      const ch = Buffer.from(rawBuf.subarray(pos, end));
      const exp = computeCrc32Cjs(ch, 4, 4 + len);
      if (ch.readUInt32BE(8 + len) !== exp) {
        ch.writeUInt32BE(exp, 8 + len);
        crcFixes++;
      }
      out.push(ch);
      if (tp === 'IEND') { hasIend = true; break; }
      pos = end;
    } else {
      let avail = rawBuf.length - (pos + 8);
      while (avail > 16 && rawBuf[pos + 8 + avail - 1] === 0x00) avail--;
      if (avail > 0 && tp === 'IDAT') {
        const rb = Buffer.allocUnsafe(12 + avail);
        rb.writeUInt32BE(avail, 0);
        rawBuf.copy(rb, 4, pos + 4, pos + 8 + avail);
        rb.writeUInt32BE(computeCrc32Cjs(rb, 4, 4 + avail), 8 + avail);
        out.push(rb);
        clamped = true;
      }
      break;
    }
  }
  if (!hasIend) out.push(IEND);
  if (crcFixes === 0 && !clamped && hasIend) return null;
  return {
    data: Buffer.concat(out),
    note: `Repaired PNG (${[clamped ? 'clamped IDAT' : '', crcFixes > 0 ? `fixed ${crcFixes} CRC-32` : '', !hasIend ? 'appended IEND' : ''].filter(Boolean).join(', ')}).`,
  };
}

function repairAviBufferCjs(rawBuf) {
  if (!rawBuf || rawBuf.length < 64 || rawBuf.toString('ascii', 0, 4) !== 'RIFF' || rawBuf.toString('ascii', 8, 12) !== 'AVI ') {
    return null;
  }
  const patched = Buffer.from(rawBuf);
  let moviOffset = -1;
  let avihOff = -1;
  let p = 12;
  while (p + 12 <= patched.length) {
    const id = patched.toString('ascii', p, p + 4);
    const sz = patched.readUInt32LE(p + 4);
    if (id === 'LIST' && p + 12 <= patched.length) {
      const lt = patched.toString('ascii', p + 8, p + 12);
      if (lt === 'hdrl') {
        let hp = p + 12;
        const hEnd = Math.min(patched.length, p + 8 + sz);
        while (hp + 8 <= hEnd) {
          const hid = patched.toString('ascii', hp, hp + 4);
          const hsz = patched.readUInt32LE(hp + 4);
          if (hid === 'avih') avihOff = hp + 8;
          if (hsz === 0 || hp + 8 + hsz > hEnd) break;
          hp += 8 + hsz + (hsz & 1);
        }
      } else if (lt === 'movi') {
        moviOffset = p;
        break;
      }
    }
    if (sz === 0 || p + 8 + sz > patched.length) break;
    p += 8 + sz + (sz & 1);
  }
  if (moviOffset < 0) {
    patched.writeUInt32LE(Math.max(4, patched.length - 8) >>> 0, 4);
    return { data: patched, note: 'Recalculated AVI RIFF container size.' };
  }
  const idx = [];
  let cp = moviOffset + 12;
  const moviBase = moviOffset + 8;
  let lastValid = cp;
  let frames = 0;
  while (cp + 8 <= patched.length) {
    const tag = patched.toString('ascii', cp, cp + 4);
    if (tag === 'idx1') break;
    const cl = patched.readUInt32LE(cp + 4);
    if (!/^[0-9]{2}[a-zA-Z]{2}$/.test(tag) || cp + 8 + cl > patched.length) break;
    const isVid = tag.endsWith('dc') || tag.endsWith('db');
    if (isVid) frames++;
    idx.push({ tag, flags: isVid ? 0x10 : 0x00, rel: cp - moviBase, size: cl });
    const next = cp + 8 + cl + (cl & 1);
    lastValid = Math.min(patched.length, next);
    cp = next;
  }
  if (avihOff > 0 && avihOff + 20 <= patched.length && frames > 0) patched.writeUInt32LE(frames, avihOff + 16);
  patched.writeUInt32LE(Math.max(4, lastValid - moviBase) >>> 0, moviOffset + 4);
  const idxBuf = idx.length > 0 ? Buffer.allocUnsafe(8 + idx.length * 16) : Buffer.alloc(0);
  if (idx.length > 0) {
    idxBuf.write('idx1', 0, 'ascii');
    idxBuf.writeUInt32LE(idx.length * 16, 4);
    let w = 8;
    for (const e of idx) {
      idxBuf.write(e.tag, w, 'ascii');
      idxBuf.writeUInt32LE(e.flags, w + 4);
      idxBuf.writeUInt32LE(e.rel >>> 0, w + 8);
      idxBuf.writeUInt32LE(e.size >>> 0, w + 12);
      w += 16;
    }
  }
  const out = Buffer.concat([patched.subarray(0, lastValid), idxBuf]);
  out.writeUInt32LE(Math.max(4, out.length - 8) >>> 0, 4);
  return {
    data: out,
    note: `Rebuilt AVI movi sizes${idx.length > 0 ? ` + idx1 seek index (${idx.length} chunks, ${frames} video frames)` : ''}.`,
  };
}

function isForeignHeaderCjs(buf, off) {
  if (off + 8 > buf.length) return false;
  const b0 = buf[off], b1 = buf[off + 1], b2 = buf[off + 2], b3 = buf[off + 3];
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
  if (off + 8 <= buf.length && buf[off + 4] === 0x66 && buf[off + 5] === 0x74 && buf[off + 6] === 0x79 && buf[off + 7] === 0x70) return true;
  return false;
}

function scoreVideoClusterCjs(chunk) {
  if (!chunk || chunk.length < 16) return { isVideo: false, hasMoovEnd: false };
  if (isForeignHeaderCjs(chunk, 0)) return { isVideo: false, hasMoovEnd: false };
  let zeros = 0;
  let printable = 0;
  for (let i = 0; i < chunk.length; i++) {
    const v = chunk[i];
    if (v === 0) zeros++;
    else if (v === 9 || v === 10 || v === 13 || (v >= 32 && v <= 126)) printable++;
  }
  const nonZero = chunk.length - zeros;
  if (nonZero < 16 || (nonZero >= 24 && printable / nonZero > 0.92)) {
    return { isVideo: false, hasMoovEnd: false };
  }

  let hasMoovEnd = false;
  for (let i = 0; i + 8 <= chunk.length; i += 4) {
    if (chunk[i + 4] === 0x6d && chunk[i + 5] === 0x6f && chunk[i + 6] === 0x6f && chunk[i + 7] === 0x76) {
      const sz = chunk.readUInt32BE(i);
      if (sz >= 16 && sz <= 16 * 1024 * 1024) {
        hasMoovEnd = true;
        break;
      }
    }
  }

  let nalScore = 0;
  let seenSingleSlice = false;
  const lim = Math.min(chunk.length - 8, 256);
  for (let start = 0; start < lim; start += 2) {
    let p = start;
    let chain = 0;
    let seenVid = false;
    while (p + 6 <= chunk.length && chain < 12) {
      const nl = chunk.readUInt32BE(p);
      if (nl < 2 || nl > 4 * 1024 * 1024) break;
      const h0 = chunk[p + 4];
      const h1 = chunk[p + 5];
      const avcOk = (h0 & 0x80) === 0 && (h0 & 0x1f) >= 1 && (h0 & 0x1f) <= 12;
      const hevcOk = (h0 & 0x80) === 0 && (h1 & 0x07) >= 1 && (((h0 >>> 1) & 0x3f) <= 21 || (((h0 >>> 1) & 0x3f) >= 32 && ((h0 >>> 1) & 0x3f) <= 40));
      if (!avcOk && !hevcOk) break;
      if ((avcOk && [1, 5, 7, 8].includes(h0 & 0x1f)) || hevcOk) seenVid = true;
      chain++;
      if (p + 4 + nl >= chunk.length) break;
      p += 4 + nl;
    }
    if (chain >= 2 && seenVid) {
      nalScore = Math.max(nalScore, chain * 3);
      break;
    }
    if (chain === 1 && seenVid && start === 0) {
      seenSingleSlice = true;
      nalScore = Math.max(nalScore, chunk.readUInt32BE(0) >= 64 ? 4 : 2);
    }
  }

  let annexHits = 0;
  for (let i = 0; i + 5 <= chunk.length; i++) {
    if (chunk[i] === 0 && chunk[i + 1] === 0 && chunk[i + 2] === 0 && chunk[i + 3] === 1) {
      const h0 = chunk[i + 4];
      const avcOk = (h0 & 0x80) === 0 && (h0 & 0x1f) >= 1 && (h0 & 0x1f) <= 12;
      const hevcOk = i + 5 < chunk.length && (h0 & 0x80) === 0 && (chunk[i + 5] & 0x07) >= 1 && (((h0 >>> 1) & 0x3f) <= 21 || (((h0 >>> 1) & 0x3f) >= 32 && ((h0 >>> 1) & 0x3f) <= 40));
      if (avcOk || hevcOk) {
        annexHits++;
        i += 4;
      }
    }
  }
  const annexScore = annexHits >= 2 ? annexHits * 3 : annexHits === 1 ? 2 : 0;

  let adtsTransitions = 0;
  for (let i = 0; i + 7 <= chunk.length; i++) {
    if (chunk[i] === 0xff && (chunk[i + 1] & 0xf6) === 0xf0) {
      const fl = ((chunk[i + 3] & 0x03) << 11) | (chunk[i + 4] << 3) | ((chunk[i + 5] >>> 5) & 0x07);
      if (fl >= 7 && fl <= 4096 && i + fl + 2 <= chunk.length && chunk[i + fl] === 0xff && (chunk[i + fl + 1] & 0xf6) === 0xf0) {
        adtsTransitions++;
        i += fl - 1;
      }
    }
  }
  const adtsScore = adtsTransitions >= 2 ? adtsTransitions * 2 + 1 : adtsTransitions === 1 ? (seenSingleSlice || annexHits > 0 ? 3 : 2) : 0;

  const totalScore = (hasMoovEnd ? 3 : 0) + Math.max(nalScore, annexScore) + adtsScore;
  const bestScore = Math.max(hasMoovEnd ? 3 : 0, nalScore, annexScore, adtsScore, totalScore >= 4 ? totalScore : 0);

  return { isVideo: bestScore >= 4, hasMoovEnd };
}

/**
 * Streaming fd-based fragmented/interleaved video reassembly after Stage 2 worker carving.
 * Converts interrupted MP4/MOV/M4V/3GP carved entries into multi-extent `native-runs` entries.
 */
function stitchFragmentedVideosFromFdCjs(devicePath, results, limitBytes, blockSize = 4096) {
  if (!devicePath || !Array.isArray(results) || results.length === 0) return [];
  const step = Math.max(512, Math.floor(blockSize / 512) * 512);
  const nonVideoRanges = results
    .filter((r) => !['mp4', 'mov', 'm4v', '3gp'].includes(String(r.extensionHint || '').toLowerCase()))
    .map((r) => ({ start: r.offset || 0, end: (r.offset || 0) + Math.max(step, r.size || 0) }));
  const insideNonVid = (off) => nonVideoRanges.some((rg) => off >= rg.start && off < rg.end);

  let fd;
  const updated = [];
  const secBuf = Buffer.allocUnsafe(step);
  try {
    fd = fs.openSync(devicePath, 'r');
    for (const entry of results) {
      const ext = String(entry.extensionHint || '').toLowerCase();
      if ((entry.sourceKind !== 'carved' && entry.sourceKind !== 'native-device') || !['mp4', 'mov', 'm4v', '3gp'].includes(ext)) continue;
      const baseOff = entry.offset || 0;
      const declaredSize = entry.size || 0;
      if (declaredSize < 512 || declaredSize > 512 * 1024 * 1024) continue;

      const runs = [];
      let frag1End = baseOff + step;
      let interrupted = false;
      const declaredEnd = Math.min(limitBytes, baseOff + declaredSize);

      for (let pos = baseOff + step; pos + step <= declaredEnd; pos += step) {
        if (insideNonVid(pos)) { interrupted = true; break; }
        const n = fs.readSync(fd, secBuf, 0, step, pos);
        if (n < 64) { interrupted = true; break; }
        const slice = secBuf.subarray(0, n);
        if (isForeignHeaderCjs(slice, 0)) { interrupted = true; break; }
        let zeros = 0;
        for (let i = 0; i < n; i++) if (slice[i] === 0) zeros++;
        if (zeros / n > 0.94) { interrupted = true; break; }
        frag1End = pos + n;
      }

      if (!interrupted && declaredEnd < limitBytes && (entry.truncated || entry.status === 'OK_TRUNCATED')) {
        interrupted = true;
      }
      if (!interrupted) continue;

      runs.push({ offset: baseOff, length: Math.max(0, frag1End - baseOff) });
      const searchStart = Math.ceil((frag1End + step) / step) * step;
      const searchEnd = Math.min(limitBytes, searchStart + 32 * 1024 * 1024);
      let activeStart = -1;
      let activeEnd = -1;
      let sawMoovAtEnd = false;

      for (let pos = searchStart; pos + step <= searchEnd; pos += step) {
        if (insideNonVid(pos)) {
          if (activeStart !== -1) { runs.push({ offset: activeStart, length: activeEnd - activeStart }); activeStart = -1; }
          continue;
        }
        const n = fs.readSync(fd, secBuf, 0, step, pos);
        if (n < 64) break;
        const probe = scoreVideoClusterCjs(secBuf.subarray(0, n));
        if (probe.isVideo) {
          if (activeStart === -1) activeStart = pos;
          activeEnd = pos + n;
          if (probe.hasMoovEnd) {
            sawMoovAtEnd = true;
            runs.push({ offset: activeStart, length: activeEnd - activeStart });
            activeStart = -1;
            break;
          }
        } else if (activeStart !== -1) {
          runs.push({ offset: activeStart, length: activeEnd - activeStart });
          activeStart = -1;
          if (runs.length >= 16) break;
        }
      }
      if (activeStart !== -1) runs.push({ offset: activeStart, length: activeEnd - activeStart });

      if (runs.length > 1) {
        const totalSize = runs.reduce((s, r) => s + r.length, 0);
        const sampleTarget = Math.min(65536, totalSize);
        const hdrBuf = Buffer.allocUnsafe(sampleTarget);
        let hPos = 0;
        for (const r of runs) {
          if (hPos >= sampleTarget) break;
          const want = Math.min(r.length, sampleTarget - hPos);
          if (want <= 0) continue;
          const rn = r.offset >= 0 ? fs.readSync(fd, hdrBuf, hPos, want, r.offset) : 0;
          if (rn < want) hdrBuf.fill(0, hPos + Math.max(0, rn), hPos + want);
          hPos += want;
        }
        entry.runs = runs;
        entry.size = totalSize;
        entry.calculatedSize = totalSize;
        entry.truncated = !sawMoovAtEnd;
        entry.headerSample = new Uint8Array(hdrBuf.buffer, hdrBuf.byteOffset, hPos);
        entry.discoveryCrc32 = computeCrc32Cjs(hdrBuf, 0, hPos);
        entry.details = `${entry.details || `${ext.toUpperCase()} stream`} · stitched ${runs.length} non-contiguous fragments`;
        updated.push(entry);
      }
    }
  } catch {
    // ignore read error on closing handle
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
  return updated;
}

module.exports = {
  repairMp4StreamingFileCjs,
  repairJpegBufferCjs,
  repairPngBufferCjs,
  repairAviBufferCjs,
  extractEmbeddedJpegCjs,
  stitchFragmentedVideosFromFdCjs,
};
