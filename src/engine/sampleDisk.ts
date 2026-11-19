import { computeCrc32, createZipArchive } from './crc32';

function writeAscii(buf: Uint8Array, offset: number, text: string) {
  for (let i = 0; i < text.length && offset + i < buf.length; i++) {
    buf[offset + i] = text.charCodeAt(i);
  }
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Generates a real, browser-renderable 48x48 RGB PNG with valid CRC32 chunks and zlib stored deflate.
 */
export function buildValidSamplePng(): Uint8Array {
  const width = 48;
  const height = 48;
  const rowSize = 1 + width * 3;
  const raw = new Uint8Array(rowSize * height);
  for (let y = 0; y < height; y++) {
    const rowOff = y * rowSize;
    raw[rowOff] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const px = rowOff + 1 + x * 3;
      const inGrid = (x % 12 === 0 || y % 12 === 0);
      const inSector = x >= 10 && x < 38 && y >= 10 && y < 38;
      if (inSector) {
        raw[px] = 15;
        raw[px + 1] = 118 + Math.floor((x / width) * 60);
        raw[px + 2] = 110 + Math.floor((y / height) * 80);
      } else if (inGrid) {
        raw[px] = 148;
        raw[px + 1] = 163;
        raw[px + 2] = 184;
      } else {
        raw[px] = 241;
        raw[px + 1] = 245;
        raw[px + 2] = 249;
      }
    }
  }

  // Zlib stream: CMF(0x78) FLG(0x01) + uncompressed deflate block + Adler32
  const zlib = new Uint8Array(2 + 5 + raw.length + 4);
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  zlib[2] = 0x01; // BFINAL=1, BTYPE=00 (stored)
  zlib[3] = raw.length & 0xff;
  zlib[4] = (raw.length >>> 8) & 0xff;
  const nlen = (~raw.length) & 0xffff;
  zlib[5] = nlen & 0xff;
  zlib[6] = (nlen >>> 8) & 0xff;
  zlib.set(raw, 7);
  const adler = adler32(raw);
  const zv = new DataView(zlib.buffer);
  zv.setUint32(7 + raw.length, adler, false);

  function makeChunk(type: string, data: Uint8Array): Uint8Array {
    const chunk = new Uint8Array(12 + data.length);
    const cv = new DataView(chunk.buffer);
    cv.setUint32(0, data.length, false);
    writeAscii(chunk, 4, type);
    chunk.set(data, 8);
    const crc = computeCrc32(chunk, 4, 4 + data.length);
    cv.setUint32(8 + data.length, crc, false);
    return chunk;
  }

  const ihdrData = new Uint8Array(13);
  const iv = new DataView(ihdrData.buffer);
  iv.setUint32(0, width, false);
  iv.setUint32(4, height, false);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // RGB
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;

  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = makeChunk('IHDR', ihdrData);
  const idat = makeChunk('IDAT', zlib);
  const iend = makeChunk('IEND', new Uint8Array(0));

  const png = new Uint8Array(sig.length + ihdr.length + idat.length + iend.length);
  let p = 0;
  png.set(sig, p); p += sig.length;
  png.set(ihdr, p); p += ihdr.length;
  png.set(idat, p); p += idat.length;
  png.set(iend, p);
  return png;
}

/**
 * Generates a valid 16x16 uncompressed 24-bit BMP image.
 */
export function buildValidSampleBmp(): Uint8Array {
  const w = 16;
  const h = 16;
  const pixelSize = w * h * 3;
  const fileSize = 54 + pixelSize;
  const bmp = new Uint8Array(fileSize);
  const dv = new DataView(bmp.buffer);
  bmp[0] = 0x42; // B
  bmp[1] = 0x4d; // M
  dv.setUint32(2, fileSize, true);
  dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true); // BITMAPINFOHEADER
  dv.setInt32(18, w, true);
  dv.setInt32(22, h, true);
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  dv.setUint32(34, pixelSize, true);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = 54 + (y * w + x) * 3;
      const checker = ((x >> 2) + (y >> 2)) % 2 === 0;
      bmp[idx] = checker ? 235 : 30;     // B
      bmp[idx + 1] = checker ? 99 : 64;  // G
      bmp[idx + 2] = checker ? 37 : 175; // R
    }
  }
  return bmp;
}

/**
 * Generates a valid minimal GIF89a 8x8 image.
 */
export function buildValidSampleGif(): Uint8Array {
  return new Uint8Array([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
    0x08, 0x00, 0x08, 0x00,             // 8x8
    0x80, 0x00, 0x00,                   // GCT 2 colors
    0x0f, 0x17, 0x2a,                   // Color 0: dark slate
    0x38, 0xbd, 0xf8,                   // Color 1: sky blue
    0x2c, 0x00, 0x00, 0x00, 0x00,       // Image descriptor
    0x08, 0x00, 0x08, 0x00, 0x00,
    0x02, 0x0a,                         // LZW min code 2, 10 bytes
    0x84, 0x8f, 0xa9, 0xcb, 0xed, 0x0f, 0xa3, 0x9c, 0xb4, 0x22,
    0x00,                               // Block terminator
    0x3b,                               // Trailer ;
  ]);
}

/**
 * Generates a valid minimal PDF 1.4 document with /Title and %%EOF.
 */
export function buildValidSamplePdf(): Uint8Array {
  const pdfText = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 44 >>
stream
BT /F1 18 Tf 72 720 Td (Recovered PDF Document) Tj ET
endstream
endobj
5 0 obj
<< /Title (Incident Recovery Report) /Producer (TestDisk Web Suite) >>
endobj
trailer
<< /Root 1 0 R /Info 5 0 R >>
%%EOF
`;
  return new TextEncoder().encode(pdfText);
}

/**
 * Generates a valid playable 0.25s 440Hz WAV audio file.
 */
export function buildValidSampleWav(): Uint8Array {
  const sampleRate = 8000;
  const numSamples = 2000;
  const dataSize = numSamples;
  const wav = new Uint8Array(44 + dataSize);
  const dv = new DataView(wav.buffer);
  writeAscii(wav, 0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  writeAscii(wav, 8, 'WAVE');
  writeAscii(wav, 12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate, true);
  dv.setUint16(32, 1, true);
  dv.setUint16(34, 8, true);
  writeAscii(wav, 36, 'data');
  dv.setUint32(40, dataSize, true);
  for (let i = 0; i < numSamples; i++) {
    wav[44 + i] = Math.round(128 + 80 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
  }
  return wav;
}

/**
 * Generates a synthetic 1.5 MiB (3072-sector) multi-partition disk image with:
 *  - MBR Partition 1 (Active): FAT32 "RECOVERY_CAM" at LBA 64..1087
 *  - MBR Partition 2: NTFS "WORK_DOCS" at LBA 1088..2111
 *  - Unmapped/Deleted Partition 3 (MBR entry wiped): Linux Ext4 "ARCHIVE_EXT4" at LBA 2112..3071
 */
export function buildSampleDiskImage(): { name: string; bytes: Uint8Array } {
  const sectorSize = 512;
  const totalSectors = 3072; // 1.5 MiB
  const disk = new Uint8Array(totalSectors * sectorSize);
  const dv = new DataView(disk.buffer);

  // --- Sector 0: MBR ---
  dv.setUint32(0x1b8, 0x89abcdef, true); // Disk signature

  // Entry 0: FAT32 LBA (0x0C), Bootable (0x80), LBA 64, 1024 sectors
  disk[0x1be] = 0x80;
  disk[0x1be + 4] = 0x0c;
  dv.setUint32(0x1be + 8, 64, true);
  dv.setUint32(0x1be + 12, 1024, true);

  // Entry 1: NTFS (0x07), LBA 1088, 1024 sectors
  disk[0x1ce] = 0x00;
  disk[0x1ce + 4] = 0x07;
  dv.setUint32(0x1ce + 8, 1088, true);
  dv.setUint32(0x1ce + 12, 1024, true);

  // Entry 2 intentionally left zeroed -> simulates deleted Ext4 partition at LBA 2112!
  disk[510] = 0x55;
  disk[511] = 0xaa;

  // --- Partition 1: FAT32 Boot Sector at LBA 64 ---
  const fatOff = 64 * sectorSize;
  disk[fatOff] = 0xeb;
  disk[fatOff + 1] = 0x58;
  disk[fatOff + 2] = 0x90;
  writeAscii(disk, fatOff + 3, 'MSDOS5.0');
  dv.setUint16(fatOff + 11, 512, true); // bytes/sector
  disk[fatOff + 13] = 8; // sectors/cluster
  dv.setUint16(fatOff + 14, 32, true); // reserved sectors
  disk[fatOff + 16] = 2; // FATs
  dv.setUint32(fatOff + 32, 1024, true); // total sectors 32
  dv.setUint32(fatOff + 36, 8, true); // FAT size 32
  writeAscii(disk, fatOff + 71, 'RECOVERYCAM');
  writeAscii(disk, fatOff + 82, 'FAT32   ');
  disk[fatOff + 510] = 0x55;
  disk[fatOff + 511] = 0xaa;

  // Embed carved artifacts inside Partition 1
  const samplePng = buildValidSamplePng();
  disk.set(samplePng, (64 + 16) * sectorSize);

  const sampleGif = buildValidSampleGif();
  disk.set(sampleGif, (64 + 48) * sectorSize);

  // Minimal valid JPEG SOI + APP0 + SOF0 (32x24) + SOS + EOI
  const sampleJpg = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x18, 0x00, 0x20, 0x01, 0x01, 0x11,
    0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xd2, 0xcf, 0x20, 0xff, 0xd9,
  ]);
  disk.set(sampleJpg, (64 + 64) * sectorSize);

  // --- Partition 2: NTFS Boot Sector at LBA 1088 ---
  const ntfsOff = 1088 * sectorSize;
  disk[ntfsOff] = 0xeb;
  disk[ntfsOff + 1] = 0x52;
  disk[ntfsOff + 2] = 0x90;
  writeAscii(disk, ntfsOff + 3, 'NTFS    ');
  dv.setUint16(ntfsOff + 11, 512, true);
  disk[ntfsOff + 13] = 8; // sectors/cluster
  dv.setUint32(ntfsOff + 40, 1023, true); // total sectors (low)
  dv.setUint32(ntfsOff + 48, 4, true); // $MFT LCN
  disk[ntfsOff + 510] = 0x55;
  disk[ntfsOff + 511] = 0xaa;

  // Embed PDF, DOCX (ZIP), and SQLite inside Partition 2
  const samplePdf = buildValidSamplePdf();
  disk.set(samplePdf, (1088 + 12) * sectorSize);

  const enc = new TextEncoder();
  const sampleDocx = createZipArchive([
    {
      name: 'word/document.xml',
      data: enc.encode('<w:document><w:body><w:p><w:r><w:t>Recovered Office Document</w:t></w:r></w:p></w:body></w:document>'),
    },
    {
      name: '[Content_Types].xml',
      data: enc.encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    },
  ]);
  disk.set(sampleDocx, (1088 + 32) * sectorSize);

  const sampleSqlite = new Uint8Array(2048);
  writeAscii(sampleSqlite, 0, 'SQLite format 3\0');
  const sqv = new DataView(sampleSqlite.buffer);
  sqv.setUint16(16, 1024, false); // page size
  sqv.setUint32(28, 2, false); // 2 pages = 2048 bytes
  disk.set(sampleSqlite, (1088 + 64) * sectorSize);

  // Embed a deleted NTFS MFT FILE record (Record #38, Tax_Return_2025_Deleted.txt) at LBA 1184
  const mftRec = new Uint8Array(1024);
  const mv = new DataView(mftRec.buffer);
  writeAscii(mftRec, 0, 'FILE');
  mv.setUint16(4, 48, true); // USA offset
  mv.setUint16(6, 3, true); // USA count (USN + 2 sectors)
  mv.setUint16(20, 56, true); // first attribute offset
  mv.setUint16(22, 0x0000, true); // flags: deleted (inUse = 0)
  mv.setUint32(28, 1024, true); // allocated size
  mv.setUint32(44, 38, true); // MFT record #38
  // Update Sequence Array (USN = 0x0042)
  mv.setUint16(48, 0x0042, true);
  mv.setUint16(510, 0x0042, true);
  mv.setUint16(1022, 0x0042, true);

  let attrPos = 56;
  // Attr 0x10 ($STANDARD_INFORMATION) - total length 72
  mv.setUint32(attrPos, 0x10, true);
  mv.setUint32(attrPos + 4, 72, true);
  mftRec[attrPos + 8] = 0; // resident
  mv.setUint32(attrPos + 16, 48, true);
  mv.setUint16(attrPos + 20, 24, true);
  // FILETIME for 2026-11-17T14:20:00Z = 134077764000000000 ticks (0x01DB3A... approx)
  const ticks = BigInt(Math.floor((Date.UTC(2026, 10, 17, 14, 20, 0) + 11644473600000) * 10000));
  mv.setUint32(attrPos + 24 + 8, Number(ticks & 0xffffffffn), true);
  mv.setUint32(attrPos + 24 + 12, Number((ticks >> 32n) & 0xffffffffn), true);
  attrPos += 72;

  // Attr 0x30 ($FILE_NAME)
  const mftFilename = 'Tax_Return_2025_Deleted.txt';
  const fnValueLen = 66 + mftFilename.length * 2;
  const fnAttrLen = Math.ceil((24 + fnValueLen) / 8) * 8;
  mv.setUint32(attrPos, 0x30, true);
  mv.setUint32(attrPos + 4, fnAttrLen, true);
  mftRec[attrPos + 8] = 0; // resident
  mv.setUint32(attrPos + 16, fnValueLen, true);
  mv.setUint16(attrPos + 20, 24, true);
  mv.setUint32(attrPos + 24, 5, true); // parent = root record 5
  mv.setUint32(attrPos + 24 + 16, Number(ticks & 0xffffffffn), true);
  mv.setUint32(attrPos + 24 + 20, Number((ticks >> 32n) & 0xffffffffn), true);
  mftRec[attrPos + 24 + 64] = mftFilename.length;
  mftRec[attrPos + 24 + 65] = 1; // Win32 namespace
  for (let i = 0; i < mftFilename.length; i++) {
    mv.setUint16(attrPos + 24 + 66 + i * 2, mftFilename.charCodeAt(i), true);
  }
  attrPos += fnAttrLen;

  // Attr 0x80 ($DATA) resident payload
  const mftPayload = enc.encode(
    'Recovered from NTFS $MFT Record #38 ($DATA resident attribute)\r\nDocument: 2025 Tax Summary\r\nIntegrity: Intact UTF-8 text preserved after Shift+Delete.',
  );
  const dataAttrLen = Math.ceil((24 + mftPayload.length) / 8) * 8;
  mv.setUint32(attrPos, 0x80, true);
  mv.setUint32(attrPos + 4, dataAttrLen, true);
  mftRec[attrPos + 8] = 0; // resident
  mv.setUint32(attrPos + 16, mftPayload.length, true);
  mv.setUint16(attrPos + 20, 24, true);
  mftRec.set(mftPayload, attrPos + 24);
  attrPos += dataAttrLen;

  mv.setUint32(attrPos, 0xffffffff, true);
  mv.setUint32(24, attrPos + 8, true); // usedBytes
  disk.set(mftRec, (1088 + 96) * sectorSize);

  // --- Deleted Partition 3: Windows exFAT Boot Sector at LBA 2112 ---
  const exfatOff = 2112 * sectorSize;
  disk[exfatOff] = 0xeb;
  disk[exfatOff + 1] = 0x76;
  disk[exfatOff + 2] = 0x90;
  writeAscii(disk, exfatOff + 3, 'EXFAT   ');
  dv.setUint32(exfatOff + 72, 960, true); // VolumeLength (low 32 bits)
  dv.setUint32(exfatOff + 80, 16, true); // FatOffset
  dv.setUint32(exfatOff + 84, 8, true); // FatLength
  dv.setUint32(exfatOff + 88, 24, true); // ClusterHeapOffset
  dv.setUint32(exfatOff + 92, 110, true); // ClusterCount
  disk[exfatOff + 108] = 9; // BytesPerSectorShift (512)
  disk[exfatOff + 109] = 3; // SectorsPerClusterShift (8)
  disk[exfatOff + 110] = 1; // NumberOfFats
  disk[exfatOff + 510] = 0x55;
  disk[exfatOff + 511] = 0xaa;

  // Embed BMP and WAV inside deleted exFAT Partition 3
  const sampleBmp = buildValidSampleBmp();
  disk.set(sampleBmp, (2112 + 16) * sectorSize);

  const sampleWav = buildValidSampleWav();
  disk.set(sampleWav, (2112 + 32) * sectorSize);

  // Embed a truncated (missing FFD9 EOI) JPEG at LBA 3070 so amber likelihood & Repair File are testable
  const truncatedJpg = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x18, 0x00, 0x20, 0x01, 0x01, 0x11,
    0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xd2, 0xcf, 0x20,
  ]);
  disk.set(truncatedJpg, 3070 * sectorSize);

  return {
    name: 'windows_drive_sample.img',
    bytes: disk,
  };
}

export function buildSampleUnknownFiles(): { name: string; bytes: Uint8Array }[] {
  return [
    { name: 'mystery_001.bin', bytes: buildValidSamplePng() },
    { name: 'corrupted_doc.dat', bytes: buildValidSamplePdf() },
    {
      name: 'container_blob',
      bytes: createZipArchive([
        {
          name: 'xl/workbook.xml',
          data: new TextEncoder().encode('<workbook><sheets><sheet name="RecoveryLog"/></sheets></workbook>'),
        },
      ]),
    },
    { name: 'audio_clip.raw', bytes: buildValidSampleWav() },
    {
      name: 'encrypted_fragment.tmp',
      bytes: new Uint8Array([
        0x00, 0xde, 0xad, 0xbe, 0xef, 0x13, 0x37, 0x99, 0x81, 0x02, 0x44, 0xab, 0xcd, 0xef, 0x10, 0x20,
      ]),
    },
  ];
}
