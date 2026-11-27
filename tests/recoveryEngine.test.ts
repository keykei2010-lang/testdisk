import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildSampleDiskImage } from '../src/engine/sampleDisk';
import { analyzeDiskImage, writeMbrPartitionTable } from '../src/engine/partitions';
import { scanNtfsMftRecordsInBuffer } from '../src/engine/ntfsMft';
import { scanFatAndExfatDeletedInBuffer } from '../src/engine/fatExfat';
import { carveDiskBuffer, FILE_FORMATS, identifyBuffer } from '../src/engine/signatures';
import { computeCrc32 } from '../src/engine/crc32';
import {
  buildCsvReport,
  computeRecoveryLikelihood,
  diagnoseMediaFile,
  extractEmbeddedJpegPreview,
  formatCompactCount,
  formatShortDate,
  repairAviBuffer,
  repairFileBuffer,
  repairJpegBuffer,
  repairPngBuffer,
  resolvePreferredExtension,
  runRecoverySelfTest,
} from '../src/engine/recoveryHealth';
import { buildDfxmlReport } from '../src/engine/dfxml';
import { buildFolderTreeForPartition } from '../src/engine/folderTree';
import { ExplorerFileItem, itemMatchesNode } from '../src/engine/explorerTypes';
import { parseUsnJournalBuffer, USN_REASON_FILE_DELETE } from '../src/engine/ntfsJournal';
import {
  inspectMp4Health,
  parseH264SpsDimensions,
  rebuildMp4WithMoov,
} from '../src/engine/mp4Repair';

test('sample disk analyzes MBR + lost NTFS partition + FAT32 LFN + nested NTFS path', () => {
  const sample = buildSampleDiskImage();
  const analysis = analyzeDiskImage(sample.name, sample.bytes);

  assert.equal(analysis.mbrSignatureValid, true);
  assert.ok(analysis.partitions.length >= 2, 'Expected primary + lost partition');
  const lost = analysis.partitions.find((p) => p.status === 'Deleted / Lost');
  if (!lost) throw new Error('Expected a lost NTFS partition');

  const mft = scanNtfsMftRecordsInBuffer(sample.bytes, analysis.partitions, { includeExisting: true });
  const tax = mft.find((r) => r.filename === 'Tax_Return_2025_Deleted.txt');
  if (!tax) throw new Error('Expected deleted NTFS Tax Return file');
  assert.equal(tax.isDeleted, true);
  assert.equal(tax.reconstructedPath, '\\Finance_2025\\Tax_Return_2025_Deleted.txt');

  const fat = scanFatAndExfatDeletedInBuffer(sample.bytes, analysis.partitions, { includeExisting: true });
  const beach = fat.find((f) => f.filename === 'Vacation_Beach_Deleted.jpg');
  if (!beach) throw new Error('Expected deleted FAT32 LFN JPEG file');
  assert.equal(beach.isDeleted, true);
  const idRes = identifyBuffer(beach.reconstructedBytes);
  assert.equal(idRes?.extension, 'jpg');
  assert.equal(idRes?.status, 'OK');

  // Verify MBR partition restore creates valid 0x55AA table
  const repaired = writeMbrPartitionTable(sample.bytes, analysis.partitions);
  const reAnalyzed = analyzeDiskImage('repaired.img', repaired);
  assert.equal(
    reAnalyzed.partitions.some(
      (p) => p.startLba === lost.startLba && p.status !== 'Deleted / Lost',
    ),
    true,
  );
});

test('BitLocker -FVE-FS- boot sector is detected cleanly', () => {
  const disk = new Uint8Array(64 * 512);
  // Write minimal MBR entry pointing to LBA 10
  disk[510] = 0x55;
  disk[511] = 0xaa;
  disk[446 + 4] = 0x07;
  disk[446 + 8] = 10;
  disk[446 + 12] = 40;
  // Write -FVE-FS- OEM at LBA 10 (+3)
  const fve = '-FVE-FS-';
  for (let i = 0; i < fve.length; i++) {
    disk[10 * 512 + 3 + i] = fve.charCodeAt(i);
  }
  disk[10 * 512 + 510] = 0x55;
  disk[10 * 512 + 511] = 0xaa;
  const analysis = analyzeDiskImage('bitlocker.img', disk);
  assert.equal(analysis.partitions[0]?.detectedFs?.encrypted, 'BitLocker');
  assert.ok(analysis.warnings.some((w) => w.includes('BitLocker')));
});

test('repairFileBuffer patches truncated MP4 mdat box, JPEG EOI, and PNG IEND', () => {
  // Truncated MP4 with ftyp (16 bytes) + mdat declaring oversized length
  const mp4 = new Uint8Array(40);
  mp4[3] = 16;
  mp4.set([0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 4); // ftyp isom
  mp4[18] = 0x13;
  mp4[19] = 0x88;
  mp4.set([0x6d, 0x64, 0x61, 0x74], 20);
  const repMp4 = repairFileBuffer('mp4', mp4);
  assert.equal(repMp4.repaired, true);
  const dv = new DataView(repMp4.data.buffer);
  assert.equal(dv.getUint32(16, false), 24);

  // Truncated JPEG
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const repJpg = repairFileBuffer('jpg', jpg);
  assert.equal(repJpg.repaired, true);
  assert.equal(repJpg.data[repJpg.data.length - 2], 0xff);
  assert.equal(repJpg.data[repJpg.data.length - 1], 0xd9);

  // Compact count + bitmap intact scoring
  assert.equal(formatCompactCount(1140), '1.1K');
  const score = computeRecoveryLikelihood({
    status: 'OK',
    size: 1024,
    calculatedSize: 1024,
    partitionId: 'part-0',
    metadata: {},
    extension: 'txt',
    mftBitmapIntact: true,
  });
  assert.equal(score.chance, 98);
});

test('rebuildMp4WithMoov synthesizes moov/avcC/stco/stsz for H.264 mdat missing moov', () => {
  const ftyp = new Uint8Array([
    0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  ]);
  // Annex-B SPS (NAL 7), PPS (NAL 8), and IDR keyframe (NAL 5)
  const annexB = new Uint8Array([
    0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0xc0, 0x1e,
    0x00, 0x00, 0x00, 0x01, 0x68, 0xce, 0x38, 0x80,
    0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x21, 0xa0,
  ]);
  const mdat = new Uint8Array(8 + annexB.length);
  new DataView(mdat.buffer).setUint32(0, mdat.length, false);
  mdat.set([0x6d, 0x64, 0x61, 0x74], 4);
  mdat.set(annexB, 8);

  const broken = new Uint8Array(ftyp.length + mdat.length);
  broken.set(ftyp, 0);
  broken.set(mdat, ftyp.length);

  const rep = rebuildMp4WithMoov(broken);
  assert.equal(rep.repaired, true);
  assert.ok(rep.note.includes('Synthesized missing MP4 moov'));
  const ascii = Buffer.from(rep.data).toString('latin1');
  assert.ok(ascii.includes('moov'));
  assert.ok(ascii.includes('avcC'));
  assert.ok(ascii.includes('stco'));
  assert.ok(ascii.includes('stsz'));
});

test('parseUsnJournalBuffer extracts USN_RECORD_V2 deleted filename and path', () => {
  const name = 'Budget_Deleted.xlsx';
  const nameBytes = Buffer.from(name, 'utf16le');
  const recLen = ((60 + nameBytes.length + 7) & ~7);
  const buf = new Uint8Array(16 + recLen);
  const dv = new DataView(buf.buffer);
  // Leading 16 zero bytes simulate sparse page padding before first record
  const off = 16;
  dv.setUint32(off, recLen, true);
  dv.setUint16(off + 4, 2, true); // Major version 2
  dv.setUint16(off + 6, 0, true); // Minor version 0
  dv.setUint32(off + 8, 42, true); // FileReferenceNumber
  dv.setUint32(off + 16, 12, true); // ParentFileReferenceNumber
  dv.setUint32(off + 24, 1024, true); // USN
  dv.setUint32(off + 40, USN_REASON_FILE_DELETE, true); // Reason
  dv.setUint32(off + 52, 0x20, true); // Archive attr (not dir)
  dv.setUint16(off + 56, nameBytes.length, true); // FileNameLength
  dv.setUint16(off + 58, 60, true); // FileNameOffset
  buf.set(nameBytes, off + 60);

  const dirMap = new Map<string, { parentRecord: number; name: string }>([
    ['part-0:12', { parentRecord: 5, name: 'Users' }],
  ]);
  const entries = parseUsnJournalBuffer(buf, { partId: 'part-0', dirMap });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].filename, name);
  assert.equal(entries[0].recordNumber, 42);
  assert.equal(entries[0].reconstructedPath, '\\Users\\Budget_Deleted.xlsx');
  assert.equal(entries[0].isDelete, true);
});

test('Camera RAW signatures are detected without collapsing into TIFF/MP4', () => {
  // Canon CR2
  const cr2 = new Uint8Array(64);
  cr2.set([0x49, 0x49, 0x2a, 0x00, 0x10, 0x00, 0x00, 0x00, 0x43, 0x52, 0x02, 0x00], 0);
  assert.equal(identifyBuffer(cr2)?.extension, 'cr2');

  // Canon CR3
  const cr3 = new Uint8Array(64);
  cr3.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x63, 0x72, 0x78, 0x20], 0);
  assert.equal(identifyBuffer(cr3)?.extension, 'cr3');

  // Fujifilm RAF
  const raf = new Uint8Array(64);
  raf.set(Buffer.from('FUJIFILMCCD-RAW'), 0);
  assert.equal(identifyBuffer(raf)?.extension, 'raf');

  // Olympus ORF & Panasonic RW2
  const orf = new Uint8Array(32);
  orf.set([0x49, 0x49, 0x52, 0x4f, 0x08, 0x00, 0x00, 0x00], 0);
  assert.equal(identifyBuffer(orf)?.extension, 'orf');

  const rw2 = new Uint8Array(32);
  rw2.set([0x49, 0x49, 0x55, 0x00, 0x08, 0x00, 0x00, 0x00], 0);
  assert.equal(identifyBuffer(rw2)?.extension, 'rw2');

  // Nikon NEF & Adobe DNG via TIFF IFD0 tag inspection
  const nef = new Uint8Array(64);
  const ndv = new DataView(nef.buffer);
  nef.set([0x49, 0x49, 0x2a, 0x00], 0);
  ndv.setUint32(4, 8, true); // IFD0 offset
  ndv.setUint16(8, 1, true); // 1 tag
  ndv.setUint16(10, 0x010f, true); // Make tag
  ndv.setUint16(12, 2, true); // ASCII
  ndv.setUint32(14, 10, true); // length
  ndv.setUint32(18, 28, true); // offset
  nef.set(Buffer.from('NIKON CORP'), 28);
  assert.equal(identifyBuffer(nef)?.extension, 'nef');

  const dng = new Uint8Array(64);
  const ddv = new DataView(dng.buffer);
  dng.set([0x49, 0x49, 0x2a, 0x00], 0);
  ddv.setUint32(4, 8, true);
  ddv.setUint16(8, 1, true);
  ddv.setUint16(10, 0xc612, true); // DNGVersion
  assert.equal(identifyBuffer(dng)?.extension, 'dng');
});

test('buildFolderTreeForPartition & itemMatchesNode build nested hierarchy', () => {
  const items: ExplorerFileItem[] = [
    {
      id: '1',
      filename: 'Tax_Return_2025_Deleted.txt',
      extension: 'txt',
      family: 'Documents',
      mimeType: 'text/plain',
      size: 100,
      calculatedSize: 100,
      status: 'OK',
      sourceKind: 'ntfs-mft',
      partitionId: 'lost-1000',
      partitionName: 'Lost Partition (NTFS)',
      originalPath: '\\Finance_2025\\Q4\\Tax_Return_2025_Deleted.txt',
      offset: 0,
      sector: 0,
      matchedOffset: 0,
      matchedLength: 0,
      metadata: {},
      description: 'Text',
      data: new Uint8Array(0),
      modifiedAt: 0,
      recoveryChance: 98,
      recoveryTier: 'high',
      recoveryReason: 'Intact',
    },
  ];
  const tree = buildFolderTreeForPartition(items, 'lost-1000');
  assert.equal(tree.length, 1);
  assert.equal(tree[0].name, 'Finance_2025');
  assert.equal(tree[0].children[0].name, 'Q4');
  assert.equal(
    itemMatchesNode(items[0], {
      kind: 'folder-node',
      partitionId: 'lost-1000',
      folderPath: 'Finance_2025',
    }),
    true,
  );
});

test('resolvePreferredExtension auto-corrects generic/mismatched extensions while keeping OOXML/OLE2', () => {
  assert.equal(resolvePreferredExtension('unknown_01.bin', 'jpg'), 'unknown_01.jpg');
  assert.equal(resolvePreferredExtension('noext', 'pdf'), 'noext.pdf');
  assert.equal(resolvePreferredExtension('wrong.txt', 'png'), 'wrong.png');
  assert.equal(resolvePreferredExtension('photo.jpeg', 'jpg'), 'photo.jpeg');
  assert.equal(resolvePreferredExtension('report.docx', 'zip'), 'report.docx');
  assert.equal(resolvePreferredExtension('ledger.xlsx', 'zip'), 'ledger.xlsx');
  assert.equal(resolvePreferredExtension('memo.xls', 'doc'), 'memo.xls');
});

test('buildCsvReport escapes cells and includes discovery CRC-32', () => {
  const sampleItem: ExplorerFileItem = {
    id: 'csv-1',
    filename: 'Quarter, "Q4" Report.pdf',
    extension: 'pdf',
    family: 'Documents',
    mimeType: 'application/pdf',
    size: 4096,
    calculatedSize: 4096,
    status: 'OK',
    sourceKind: 'carved',
    isDeleted: true,
    partitionId: 'part-0',
    partitionName: 'NTFS (Data)',
    originalPath: '\\Docs\\Quarter.pdf',
    offset: 0x2000,
    sector: 16,
    matchedOffset: 0,
    matchedLength: 4,
    metadata: {},
    description: 'PDF Document',
    data: new Uint8Array(0),
    modifiedAt: 0,
    recoveryChance: 96,
    recoveryTier: 'high',
    recoveryReason: 'Valid header & footer',
    discoveryCrc32: 0x0a1b2c3d,
  };
  const csv = buildCsvReport([sampleItem], 'Disk0');
  const lines = csv.split('\r\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes('CRC32 Fingerprint'));
  assert.ok(lines[1].includes('"Quarter, ""Q4"" Report.pdf"'));
  assert.ok(lines[1].includes('0x2000'));
  assert.ok(lines[1].includes('0a1b2c3d'));
});

test('carveDiskBuffer computes discoveryCrc32 and skips allocated offsets when unallocatedOnly is true', () => {
  const buf = new Uint8Array(4096);
  // JPEG at offset 512 (allocated) with valid FFE0 length + FFDA + FFD9
  buf.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9], 512);
  // PNG at offset 2048 (unallocated)
  buf.set([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ], 2048);

  const enabled = new Set(FILE_FORMATS.map((f) => f.id));
  const whole = carveDiskBuffer(buf, {
    startByte: 0,
    endByte: buf.length,
    blockSize: 512,
    paranoid: true,
    keepCorrupted: true,
    enabledFormats: enabled,
  });
  assert.equal(whole.length, 2);
  for (const c of whole) {
    assert.equal(c.discoveryCrc32, computeCrc32(c.data, 0, Math.min(65536, c.data.length)));
  }

  const unalloc = carveDiskBuffer(buf, {
    startByte: 0,
    endByte: buf.length,
    blockSize: 512,
    paranoid: true,
    keepCorrupted: true,
    unallocatedOnly: true,
    allocatedChecker: (offset) => offset === 512,
    enabledFormats: enabled,
  });
  assert.equal(unalloc.length, 1);
  assert.equal(unalloc[0].extension, 'png');
  assert.equal(unalloc[0].offset, 2048);
});

test('runRecoverySelfTest verifies MBR, MFT, FAT32 LFN, raw carving CRC-32, and MP4 moov synthesis', async () => {
  const res = await runRecoverySelfTest();
  assert.equal(res.passed, true);
  assert.equal(res.checks.length, 5);
  assert.ok(res.sha256Hex.length >= 16);
});

test('rebuildMp4WithMoov synthesizes H.265/HEVC hvc1/hvcC moov index and inspectMp4Health diagnoses missing moov', () => {
  const ftyp = new Uint8Array([
    0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  ]);
  // Length-prefixed HEVC NALs: VPS (type 32 -> 0x40 0x01), SPS (type 33 -> 0x42 0x01), PPS (type 34 -> 0x44 0x01), IDR_W_RADL (type 19 -> 0x26 0x01)
  const hvccPayload = new Uint8Array([
    0x00, 0x00, 0x00, 0x04, 0x40, 0x01, 0x0c, 0x01, // VPS
    0x00, 0x00, 0x00, 0x04, 0x42, 0x01, 0x01, 0x60, // SPS
    0x00, 0x00, 0x00, 0x04, 0x44, 0x01, 0xc1, 0x73, // PPS
    0x00, 0x00, 0x00, 0x05, 0x26, 0x01, 0xaf, 0x12, 0x34, // IDR frame
  ]);
  const mdat = new Uint8Array(8 + hvccPayload.length);
  new DataView(mdat.buffer).setUint32(0, mdat.length, false);
  mdat.set([0x6d, 0x64, 0x61, 0x74], 4);
  mdat.set(hvccPayload, 8);

  const brokenHevc = new Uint8Array(ftyp.length + mdat.length);
  brokenHevc.set(ftyp, 0);
  brokenHevc.set(mdat, ftyp.length);

  const health = inspectMp4Health(brokenHevc);
  assert.equal(health.missingMoov, true);
  assert.equal(health.codec, 'hevc');

  const rep = rebuildMp4WithMoov(brokenHevc);
  assert.equal(rep.repaired, true);
  assert.ok(rep.note.includes('H.265/HEVC'));
  const ascii = Buffer.from(rep.data).toString('latin1');
  assert.ok(ascii.includes('moov'));
  assert.ok(ascii.includes('hvc1'));
  assert.ok(ascii.includes('hvcC'));
});

test('rebuildMp4WithMoov resynchronizes past corrupt bytes & inline ADTS AAC audio inside mdat', () => {
  const ftyp = new Uint8Array([
    0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  ]);
  // H.264 SPS + PPS + IDR, followed by a 10-byte ADTS AAC frame (0xFF 0xF1 ... len=10), corrupt 3 bytes, then IDR frame
  const payload = new Uint8Array([
    0x00, 0x00, 0x00, 0x04, 0x67, 0x42, 0xc0, 0x1e, // SPS
    0x00, 0x00, 0x00, 0x04, 0x68, 0xce, 0x38, 0x80, // PPS
    0x00, 0x00, 0x00, 0x05, 0x65, 0x88, 0x84, 0x21, 0xa0, // IDR #1
    0xff, 0xf1, 0x50, 0x80, 0x01, 0x5f, 0xfc, 0x21, 0x00, 0x1a, // ADTS AAC frame (10 B)
    0xde, 0xad, 0xbe, // corrupt sector gap
    0x00, 0x00, 0x00, 0x05, 0x65, 0x88, 0x84, 0x22, 0xb0, // IDR #2 after resync
  ]);
  const mdat = new Uint8Array(8 + payload.length);
  new DataView(mdat.buffer).setUint32(0, mdat.length, false);
  mdat.set([0x6d, 0x64, 0x61, 0x74], 4);
  mdat.set(payload, 8);

  const broken = new Uint8Array(ftyp.length + mdat.length);
  broken.set(ftyp, 0);
  broken.set(mdat, ftyp.length);

  const rep = rebuildMp4WithMoov(broken);
  assert.equal(rep.repaired, true);
  assert.ok(rep.note.includes('2 H.264/AVC frames'));
  assert.ok(rep.note.includes('1 AAC audio frames'));
  const ascii = Buffer.from(rep.data).toString('latin1');
  assert.ok(ascii.includes('soun'));
  assert.ok(ascii.includes('mp4a'));
  assert.ok(ascii.includes('vide'));
});

test('repairFileBuffer performs Reference JPEG Header Transplant, Baseline DHT injection, and diagnoseMediaFile', () => {
  // Healthy reference JPEG: SOI + DQT + SOF0 + DHT + SOS(len=12) + dummy ref scan + EOI
  const refJpg = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xdb, 0x00, 0x04, 0x00, 0x01, // DQT
    0xff, 0xc0, 0x00, 0x06, 0x08, 0x00, 0x10, 0x00, // SOF0
    0xff, 0xc4, 0x00, 0x04, 0x00, 0x00, // DHT
    0xff, 0xda, 0x00, 0x04, 0x01, 0x00, // SOS
    0xaa, 0xbb, 0xff, 0xd9,
  ]);
  // Headerless damaged JPEG (missing SOI/DQT/SOF and missing EOI)
  const headerlessScan = new Uint8Array(24);
  headerlessScan.set([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88], 0);

  const diag = diagnoseMediaFile('jpg', headerlessScan);
  assert.equal(diag.needsReferenceHint, true);

  const repWithRef = repairFileBuffer('jpg', headerlessScan, refJpg);
  assert.equal(repWithRef.repaired, true);
  assert.ok(repWithRef.note.includes('Transplanted healthy reference JPEG header'));
  assert.equal(repWithRef.data[0], 0xff);
  assert.equal(repWithRef.data[1], 0xd8);
  assert.equal(repWithRef.data[repWithRef.data.length - 2], 0xff);
  assert.equal(repWithRef.data[repWithRef.data.length - 1], 0xd9);

  // Baseline JPEG with SOI + DQT + SOF0 + SOS, missing DHT and EOI
  const dhtMissing = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xdb, 0x00, 0x04, 0x00, 0x01, // DQT
    0xff, 0xc0, 0x00, 0x06, 0x08, 0x00, 0x10, 0x00, // SOF0
    0xff, 0xda, 0x00, 0x04, 0x01, 0x00, // SOS
    0x12, 0x34,
  ]);
  const repDht = repairFileBuffer('jpg', dhtMissing);
  assert.equal(repDht.repaired, true);
  assert.ok(repDht.note.includes('DHT'));
  assert.equal(repDht.data[repDht.data.length - 2], 0xff);
  assert.equal(repDht.data[repDht.data.length - 1], 0xd9);
});

test('parseH264SpsDimensions & rebuildMp4WithMoov rescue headerless raw Annex-B stream', () => {
  // Real Baseline H.264 SPS for 1280x720 (profile=66, level=31, seq_param_set_id=0, log2_max_frame_num=4, pic_order_cnt=0, max_num_ref=1, gaps=0, pic_width_in_mbs_minus1=79 (80*16=1280), pic_height_in_map_units_minus1=44 (45*16=720), frame_mbs_only=1)
  // Exp-Golomb bits: 0(id) 1 -> 01001(4? wait: 4->ue=4 is 00101), let's construct exact bit-packed SPS NALU:
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  const pushUe = (v: number) => {
    const codeNum = v + 1;
    const len = Math.floor(Math.log2(codeNum)) + 1;
    for (let i = 0; i < len - 1; i++) bits.push(0);
    pushBits(codeNum, len);
  };
  pushBits(0x67, 8); // NALU header (SPS)
  pushBits(66, 8); // profile_idc (Baseline)
  pushBits(0xc0, 8); // constraint flags
  pushBits(31, 8); // level_idc
  pushUe(0); // seq_parameter_set_id
  pushUe(0); // log2_max_frame_num_minus4
  pushUe(0); // pic_order_cnt_type
  pushUe(0); // log2_max_pic_order_cnt_lsb_minus4
  pushUe(1); // max_num_ref_frames
  pushBits(0, 1); // gaps_in_frame_num_value_allowed_flag
  pushUe(79); // pic_width_in_mbs_minus1 -> 80 * 16 = 1280
  pushUe(44); // pic_height_in_map_units_minus1 -> 45 * 16 = 720
  pushBits(1, 1); // frame_mbs_only_flag
  pushBits(0, 1); // direct_8x8_inference_flag
  pushBits(0, 1); // frame_cropping_flag
  pushBits(0, 1); // vui_parameters_present_flag
  pushBits(1, 1); // RBSP stop bit
  while (bits.length % 8 !== 0) bits.push(0);
  const sps = new Uint8Array(bits.length / 8);
  for (let i = 0; i < sps.length; i++) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | bits[i * 8 + k];
    sps[i] = b;
  }

  const dims = parseH264SpsDimensions(sps);
  assert.ok(dims);
  assert.equal(dims.width, 1280);
  assert.equal(dims.height, 720);

  // Headerless raw Annex-B stream (no ftyp or mdat box header at offset 0!)
  const pps = new Uint8Array([0x68, 0xce, 0x38, 0x80]);
  const idr = new Uint8Array([0x65, 0x88, 0x84, 0x21, 0xa0, 0x11, 0x22]);
  const rawStream = new Uint8Array(12 + 4 + sps.length + 4 + pps.length + 4 + idr.length);
  // Leading 12 garbage bytes before Annex-B start code
  let p = 12;
  rawStream.set([0x00, 0x00, 0x00, 0x01], p);
  p += 4;
  rawStream.set(sps, p);
  p += sps.length;
  rawStream.set([0x00, 0x00, 0x00, 0x01], p);
  p += 4;
  rawStream.set(pps, p);
  p += pps.length;
  rawStream.set([0x00, 0x00, 0x00, 0x01], p);
  p += 4;
  rawStream.set(idr, p);

  const health = inspectMp4Health(rawStream);
  assert.equal(health.headerlessStream, true);

  const rep = rebuildMp4WithMoov(rawStream);
  assert.equal(rep.repaired, true);
  assert.ok(rep.note.includes('1280×720'));
  assert.ok(rep.note.includes('headerless stream'));
  const ascii = Buffer.from(rep.data).toString('latin1');
  assert.ok(ascii.includes('ftyp'));
  assert.ok(ascii.includes('mdat'));
  assert.ok(ascii.includes('moov'));
  assert.ok(ascii.includes('avcC'));
});

test('repairJpegBuffer fixes corrupt 0xFF bytes & RSTn markers and extracts embedded EXIF/RAW JPEG preview', () => {
  // JPEG with embedded EXIF preview JPEG (>=256 B) inside APP1 + corrupt 0xFF 0x33 unstuffed byte and out-of-order RST2/RST5 in entropy scan
  const thumbBody = new Array(256).fill(0x2a);
  const thumb = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x01, ...thumbBody, 0xff, 0xd9]);
  const app1Len = 2 + 6 + thumb.length;
  const damagedJpg = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe1, (app1Len >>> 8) & 0xff, app1Len & 0xff, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    ...thumb,
    0xff, 0xdb, 0x00, 0x04, 0x00, 0x01,
    0xff, 0xc0, 0x00, 0x06, 0x08, 0x00, 0x10, 0x00,
    0xff, 0xc4, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xda, 0x00, 0x04, 0x01, 0x00,
    0xaa, 0xff, 0x33, // invalid unstuffed 0xFF 0x33 -> must become 0xFF 0x00 0x33
    0xff, 0xd2, // out-of-order RST2 -> must become RST0 (0xD0)
    0xff, 0xd5, // out-of-order RST5 -> must become RST1 (0xD1)
    0xbb, 0x00, 0x00, 0x00, 0x00, // trailing zero slack + missing EOI
  ]);

  const diag = diagnoseMediaFile('jpg', damagedJpg);
  assert.equal(diag.canRepair, true);
  assert.ok(diag.issue.includes('0xFF'));

  const rep = repairJpegBuffer(damagedJpg);
  assert.equal(rep.repaired, true);
  assert.ok(rep.note.includes('byte-stuffed 1 corrupt entropy 0xFF'));
  assert.ok(rep.note.includes('re-sequenced 2 RSTn'));
  assert.ok(rep.salvagedPreviewBytes);
  assert.equal(rep.salvagedPreviewBytes[0], 0xff);
  assert.equal(rep.salvagedPreviewBytes[1], 0xd8);
  assert.equal(rep.data[rep.data.length - 2], 0xff);
  assert.equal(rep.data[rep.data.length - 1], 0xd9);

  // Also test Camera RAW (NEF/CR2-style wrapper) embedded JPEG preview extraction
  const rawWrapper = new Uint8Array(40 + thumb.length + 32);
  rawWrapper.set([0x49, 0x49, 0x2a, 0x00], 0);
  rawWrapper.set(thumb, 40);
  const extracted = extractEmbeddedJpegPreview(rawWrapper);
  assert.ok(extracted);
  assert.deepEqual(extracted, thumb);
});

test('repairPngBuffer fixes bad CRC-32, clamps truncated IDAT, and appends IEND', () => {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdrData = new Uint8Array([
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00,
  ]);
  const badCrc = [0xde, 0xad, 0xbe, 0xef];
  // Truncated IDAT claims length 9999, actually only 6 bytes remain
  const idatPayload = [0x78, 0x9c, 0x63, 0x60, 0x00, 0x00];
  const brokenPng = new Uint8Array([
    ...sig,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, ...ihdrData, ...badCrc,
    0x00, 0x00, 0x27, 0x0f, 0x49, 0x44, 0x41, 0x54, ...idatPayload,
  ]);

  const rep = repairPngBuffer(brokenPng);
  assert.equal(rep.repaired, true);
  assert.ok(rep.note.includes('CRC-32'));
  assert.ok(rep.note.includes('clamped truncated IDAT'));
  assert.ok(rep.note.includes('IEND'));
  // Verify fixed IHDR CRC at offset 29
  const dv = new DataView(rep.data.buffer, rep.data.byteOffset, rep.data.byteLength);
  assert.equal(dv.getUint32(29, false), computeCrc32(rep.data, 12, 17));
  // Verify clamped IDAT length at offset 33 === 6
  assert.equal(dv.getUint32(33, false), 6);
  // Verify ends with IEND
  assert.deepEqual(
    Array.from(rep.data.subarray(rep.data.length - 12)),
    [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82],
  );
});

test('repairAviBuffer rebuilds LIST movi size, avih.dwTotalFrames, and idx1 seek table', () => {
  // Construct minimal RIFF AVI with avih (hdrl) + LIST movi containing 2 video frames (00dc) without idx1
  const frame0 = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
  const frame1 = new Uint8Array([0x55, 0x66, 0x77, 0x88, 0x99]); // odd length (needs pad in RIFF)

  const avih = new Uint8Array(64);
  const adv = new DataView(avih.buffer);
  avih.set(Buffer.from('avih'), 0);
  adv.setUint32(4, 56, true);
  adv.setUint32(24, 0, true); // wrong dwTotalFrames = 0

  const hdrl = new Uint8Array(12 + avih.length);
  const hdv = new DataView(hdrl.buffer);
  hdrl.set(Buffer.from('LIST'), 0);
  hdv.setUint32(4, 4 + avih.length, true);
  hdrl.set(Buffer.from('hdrl'), 8);
  hdrl.set(avih, 12);

  const c0 = new Uint8Array(8 + frame0.length);
  c0.set(Buffer.from('00dc'), 0);
  new DataView(c0.buffer).setUint32(4, frame0.length, true);
  c0.set(frame0, 8);

  const c1 = new Uint8Array(8 + frame1.length + 1); // padded
  c1.set(Buffer.from('00dc'), 0);
  new DataView(c1.buffer).setUint32(4, frame1.length, true);
  c1.set(frame1, 8);

  const movi = new Uint8Array(12 + c0.length + c1.length);
  movi.set(Buffer.from('LIST'), 0);
  new DataView(movi.buffer).setUint32(4, 999999, true); // intentionally corrupt movi size
  movi.set(Buffer.from('movi'), 8);
  movi.set(c0, 12);
  movi.set(c1, 12 + c0.length);

  const avi = new Uint8Array(12 + hdrl.length + movi.length);
  avi.set(Buffer.from('RIFF'), 0);
  new DataView(avi.buffer).setUint32(4, 4, true); // wrong RIFF size
  avi.set(Buffer.from('AVI '), 8);
  avi.set(hdrl, 12);
  avi.set(movi, 12 + hdrl.length);

  const rep = repairAviBuffer(avi);
  assert.equal(rep.repaired, true);
  assert.ok(rep.note.includes('idx1'));
  assert.ok(rep.note.includes('2 video frames'));
  const dv = new DataView(rep.data.buffer, rep.data.byteOffset, rep.data.byteLength);
  // avih dwTotalFrames is at hdrl offset (12) + 12 + 24 = 48
  assert.equal(dv.getUint32(48, true), 2);
  assert.ok(Buffer.from(rep.data).toString('latin1').includes('idx1'));
});

test('Electron CJS repairMp4StreamingFileCjs streams H.264/ADTS mdat into playable ftyp+mdat+moov', () => {
  const req = createRequire(import.meta.url);
  const { repairMp4StreamingFileCjs } = req('../electron/mediaRepairCjs.cjs');

  const tmpDir = os.tmpdir();
  const srcPath = path.join(tmpDir, `test_stream_${Date.now()}.mp4`);
  const dstPath = path.join(tmpDir, `test_stream_out_${Date.now()}.mp4`);
  try {
    const ftyp = Buffer.from([
      0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    ]);
    const payload = Buffer.from([
      0x00, 0x00, 0x00, 0x04, 0x67, 0x42, 0xc0, 0x1e, // SPS
      0x00, 0x00, 0x00, 0x04, 0x68, 0xce, 0x38, 0x80, // PPS
      0x00, 0x00, 0x00, 0x05, 0x65, 0x88, 0x84, 0x21, 0xa0, // IDR #1
      0xff, 0xf1, 0x50, 0x80, 0x01, 0x5f, 0xfc, 0x21, 0x00, 0x1a, // ADTS AAC frame
      0x00, 0x00, 0x00, 0x05, 0x41, 0x9a, 0x22, 0x11, 0x00, // P-frame
    ]);
    const mdatHdr = Buffer.alloc(8);
    mdatHdr.writeUInt32BE(8 + payload.length, 0);
    mdatHdr.write('mdat', 4, 'ascii');
    fs.writeFileSync(srcPath, Buffer.concat([ftyp, mdatHdr, payload]));

    const res = repairMp4StreamingFileCjs(srcPath, dstPath, null);
    assert.equal(res.ok, true);
    assert.ok(res.videoSamples === 2);
    assert.ok(res.audioSamples === 1);
    const out = fs.readFileSync(dstPath);
    const ascii = out.toString('latin1');
    assert.ok(ascii.includes('ftyp'));
    assert.ok(ascii.includes('mdat'));
    assert.ok(ascii.includes('moov'));
    assert.ok(ascii.includes('stsz'));
    assert.ok(ascii.includes('stco'));
    assert.ok(ascii.includes('soun'));
    assert.ok(ascii.includes('mp4a'));
  } finally {
    if (fs.existsSync(srcPath)) fs.unlinkSync(srcPath);
    if (fs.existsSync(dstPath)) fs.unlinkSync(dstPath);
  }
});

test('scanNtfsMftRecordsInBuffer recovers emptied $I/$R Recycle Bin pair with original name and path', () => {
  const bytesPerSector = 512;
  const clusterSize = 4096;
  const partStartLba = 2048;
  const partByteOffset = partStartLba * bytesPerSector;
  const mftStartCluster = 4;
  const mftByteOffset = partByteOffset + mftStartCluster * clusterSize;
  const disk = new Uint8Array(partByteOffset + 16 * clusterSize);

  // MBR partition 0 -> NTFS starting at LBA 2048 (128 sectors)
  const mbrView = new DataView(disk.buffer);
  disk[510] = 0x55;
  disk[511] = 0xaa;
  disk[446 + 4] = 0x07;
  mbrView.setUint32(446 + 8, partStartLba, true);
  mbrView.setUint32(446 + 12, 128, true);

  // NTFS Boot Sector at LBA 2048
  const oem = 'NTFS    ';
  for (let i = 0; i < oem.length; i++) {
    disk[partByteOffset + 3 + i] = oem.charCodeAt(i);
  }
  const bsView = new DataView(disk.buffer, partByteOffset, 512);
  bsView.setUint16(11, bytesPerSector, true);
  disk[partByteOffset + 13] = clusterSize / bytesPerSector; // sectors per cluster = 8
  bsView.setBigUint64(40, 128n, true);
  bsView.setBigUint64(48, BigInt(mftStartCluster), true); // $MFT LCN
  disk[partByteOffset + 64] = 0xf6; // -10 => 1024-byte MFT records
  disk[partByteOffset + 510] = 0x55;
  disk[partByteOffset + 511] = 0xaa;

  const writeMftRecord = (
    recIndex: number,
    flags: number,
    parentRecNum: number,
    filename: string,
    residentBytes?: Uint8Array,
    nonResidentCluster?: { lcn: number; clusterCount: number; fileSize: number },
  ) => {
    const recOff = mftByteOffset + recIndex * 1024;
    const rec = disk.subarray(recOff, recOff + 1024);
    const v = new DataView(disk.buffer, recOff, 1024);
    rec[0] = 0x46; // F
    rec[1] = 0x49; // I
    rec[2] = 0x4c; // L
    rec[3] = 0x45; // E
    v.setUint16(4, 48, true); // USA offset
    v.setUint16(6, 3, true); // USA count (USN + 2 sectors)
    v.setUint16(20, 56, true); // first attr offset
    v.setUint16(22, flags, true); // 0x00 deleted file, 0x01 active file, 0x02 deleted dir, 0x03 active dir
    v.setUint32(44, recIndex, true); // recordNumber
    v.setUint16(48, 1, true); // USN value = 1
    v.setUint16(510, 1, true); // Sector 1 end fixup = USN
    v.setUint16(1022, 1, true); // Sector 2 end fixup = USN

    let cur = 56;
    // $FILE_NAME (0x30)
    const fnPayloadLen = 66 + filename.length * 2;
    const fnAttrLen = Math.ceil((24 + fnPayloadLen) / 8) * 8;
    v.setUint32(cur, 0x30, true);
    v.setUint32(cur + 4, fnAttrLen, true);
    rec[cur + 8] = 0; // resident
    v.setUint32(cur + 16, fnPayloadLen, true);
    v.setUint16(cur + 20, 24, true);
    const fnStart = cur + 24;
    v.setUint32(fnStart, parentRecNum, true);
    v.setUint16(fnStart + 4, 0, true);
    rec[fnStart + 64] = filename.length;
    rec[fnStart + 65] = 3; // Win32 + DOS
    for (let i = 0; i < filename.length; i++) {
      v.setUint16(fnStart + 66 + i * 2, filename.charCodeAt(i), true);
    }
    cur += fnAttrLen;

    // $DATA (0x80)
    if (residentBytes) {
      const dataAttrLen = Math.ceil((24 + residentBytes.length) / 8) * 8;
      v.setUint32(cur, 0x80, true);
      v.setUint32(cur + 4, dataAttrLen, true);
      rec[cur + 8] = 0; // resident
      v.setUint32(cur + 16, residentBytes.length, true);
      v.setUint16(cur + 20, 24, true);
      rec.set(residentBytes, cur + 24);
      cur += dataAttrLen;
    } else if (nonResidentCluster) {
      v.setUint32(cur, 0x80, true);
      v.setUint32(cur + 4, 72, true);
      rec[cur + 8] = 1; // non-resident
      v.setUint16(cur + 32, 64, true); // data runs offset
      v.setBigUint64(cur + 48, BigInt(nonResidentCluster.fileSize), true); // real size
      // Data run header: 1 byte len + 1 byte LCN
      rec[cur + 64] = 0x11;
      rec[cur + 65] = nonResidentCluster.clusterCount;
      rec[cur + 66] = nonResidentCluster.lcn;
      rec[cur + 67] = 0x00;
      cur += 72;
    }

    // End marker
    v.setUint32(cur, 0xffffffff, true);
    v.setUint32(24, cur + 8, true); // usedBytes
  };

  // Directory chain: Record 5 (root) -> Record 6 ($Recycle.Bin) -> Record 7 (S-1-5-21-1001)
  writeMftRecord(6, 0x03, 5, '$Recycle.Bin');
  writeMftRecord(7, 0x03, 6, 'S-1-5-21-1001');

  // Build Windows $IABC123 v2 stub pointing to C:\Users\Owner\Pictures\Emptied_Sunset.jpg
  const origPath = 'C:\\Users\\Owner\\Pictures\\Emptied_Sunset.jpg';
  const iStub = new Uint8Array(28 + origPath.length * 2 + 2);
  const iView = new DataView(iStub.buffer);
  iView.setUint32(0, 2, true); // version 2
  iView.setUint32(8, 2048, true); // original size
  iView.setBigUint64(16, 133800000000000000n, true); // Windows FILETIME
  iView.setUint32(24, origPath.length + 1, true);
  for (let i = 0; i < origPath.length; i++) {
    iView.setUint16(28 + i * 2, origPath.charCodeAt(i), true);
  }

  // Write payload cluster at LCN 10 with valid JPEG SOI + EOI
  const payloadCluster = partByteOffset + 10 * clusterSize;
  disk.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00], payloadCluster);
  disk[payloadCluster + 2046] = 0xff;
  disk[payloadCluster + 2047] = 0xd9;

  // Emptied (deleted, flag=0x00) $IABC123 and $RABC123.jpg in MFT records 10 and 11
  writeMftRecord(10, 0x00, 7, '$IABC123.jpg', iStub);
  writeMftRecord(11, 0x00, 7, '$RABC123.jpg', undefined, { lcn: 10, clusterCount: 1, fileSize: 2048 });

  const partitions = analyzeDiskImage('ntfs_recycle_test.img', disk).partitions;
  const recovered = scanNtfsMftRecordsInBuffer(disk, partitions, { includeExisting: false });

  assert.equal(recovered.some((r) => r.filename === '$IABC123.jpg'), false, '$I stub should be consumed');
  const sunset = recovered.find((r) => r.filename === 'Emptied_Sunset.jpg');
  assert.ok(sunset, 'Expected emptied $RABC123.jpg to be recovered and re-paired as Emptied_Sunset.jpg');
  assert.equal(sunset.isDeleted, true);
  assert.equal(sunset.originalWindowsPath, origPath);
  assert.equal(sunset.reconstructedPath, '\\$Recycle.Bin\\S-1-5-21-1001\\Emptied_Sunset.jpg');
  assert.equal(sunset.reconstructedBytes[0], 0xff);
  assert.equal(sunset.reconstructedBytes[1], 0xd8);
});

test('recycleBinCjs plans NTFS volumes, re-pairs deleted $I/$R records, and tags emptied entries', () => {
  const requireCjs = createRequire(import.meta.url);
  const {
    buildNtfsVolumeScanPlanCjs,
    filterAndTagEmptiedRecycleEntriesCjs,
    isRecycleBinEntryName,
    rePairDeletedRecycleRecordsCjs,
  } = requireCjs('../electron/recycleBinCjs.cjs');

  assert.equal(isRecycleBinEntryName('$R9X8Y7Z.mp4'), true);
  assert.equal(isRecycleBinEntryName('$I9X8Y7Z.mp4'), true);
  assert.equal(isRecycleBinEntryName('$MFT'), false);
  assert.equal(isRecycleBinEntryName('$UsnJrnl'), false);

  const plan = buildNtfsVolumeScanPlanCjs(
    [
      { DriveLetter: 'D', FileSystem: 'NTFS', FileSystemLabel: 'Media', Size: 500_000_000_000 },
      { DriveLetter: 'C', FileSystem: 'NTFS', FileSystemLabel: 'Windows', Size: 256_000_000_000 },
      { DriveLetter: 'E', FileSystem: 'FAT32', FileSystemLabel: 'USB', Size: 32_000_000_000 },
    ],
    [
      { DriveLetter: 'C', DiskNumber: 0, Offset: 1048576, Size: 256_000_000_000 },
      { DriveLetter: 'D', DiskNumber: 1, Offset: 1048576, Size: 500_000_000_000 },
    ],
  );
  assert.equal(plan.length, 2, 'FAT32 volume should be excluded from NTFS recycle lookup plan');
  assert.equal(plan[0].driveLetter, 'C:');
  assert.equal(plan[0].volumeDevicePath, '\\\\.\\C:');
  assert.equal(plan[0].physicalDevicePath, '\\\\.\\PhysicalDrive0');
  assert.equal(plan[1].driveLetter, 'D:');
  assert.equal(plan[1].volumeDevicePath, '\\\\.\\D:');

  // Build $I9X8Y7Z.mp4 v2 metadata buffer
  const orig = 'D:\\Videos\\Emptied_Holiday.mp4';
  const iBuf = Buffer.alloc(28 + orig.length * 2 + 2);
  iBuf.writeUInt32LE(2, 0);
  iBuf.writeUInt32LE(8_388_608, 8);
  iBuf.writeBigUInt64LE(133800000000000000n, 16);
  iBuf.writeUInt32LE(orig.length + 1, 24);
  iBuf.write(orig, 28, 'utf16le');

  const paired = rePairDeletedRecycleRecordsCjs([
    {
      volKey: 0,
      parentRecord: 42,
      entry: {
        id: 'i-stub',
        filename: '$I9X8Y7Z.mp4',
        size: iBuf.length,
        headerSample: new Uint8Array(iBuf),
      },
    },
    {
      volKey: 0,
      parentRecord: 42,
      entry: {
        id: 'r-payload',
        filename: '$R9X8Y7Z.mp4',
        originalPath: '\\$Recycle.Bin\\S-1-5-21\\$R9X8Y7Z.mp4',
        size: 8_388_608,
        offset: 409600,
        scanPhase: 'mft',
        mftResident: false,
        runs: [{ offset: 409600, length: 8_388_608 }],
      },
    },
    {
      volKey: 0,
      parentRecord: 99,
      entry: {
        id: 'normal-doc',
        filename: 'Other_File.txt',
        originalPath: '\\Docs\\Other_File.txt',
        size: 120,
        offset: 819200,
        scanPhase: 'mft',
      },
    },
  ]);

  const tagged = filterAndTagEmptiedRecycleEntriesCjs(
    paired.map((r: { entry: Record<string, unknown> }) => r.entry),
    { driveLetter: 'D:' },
  );
  assert.equal(tagged.length, 1);
  assert.equal(tagged[0].filename, 'Emptied_Holiday.mp4');
  assert.equal(tagged[0].originalPath, orig);
  assert.equal(tagged[0].sourceKind, 'recycle-bin');
  assert.equal(tagged[0].partitionName, 'Emptied $Recycle.Bin (D: · $MFT)');
});

test('scanNtfsMftRecordsInBuffer preserves sparse cluster alignment', () => {
  const bytesPerSector = 512;
  const clusterSize = 4096;
  const partStartLba = 2048;
  const partByteOffset = partStartLba * bytesPerSector;
  const mftStartCluster = 4;
  const mftByteOffset = partByteOffset + mftStartCluster * clusterSize;
  const disk = new Uint8Array(partByteOffset + 16 * clusterSize);

  const mbrView = new DataView(disk.buffer);
  disk[510] = 0x55;
  disk[511] = 0xaa;
  disk[446 + 4] = 0x07;
  mbrView.setUint32(446 + 8, partStartLba, true);
  mbrView.setUint32(446 + 12, 128, true);

  for (let i = 0; i < 8; i++) disk[partByteOffset + 3 + i] = 'NTFS    '.charCodeAt(i);
  const bsView = new DataView(disk.buffer, partByteOffset, 512);
  bsView.setUint16(11, bytesPerSector, true);
  disk[partByteOffset + 13] = clusterSize / bytesPerSector;
  bsView.setBigUint64(40, 128n, true);
  bsView.setBigUint64(48, BigInt(mftStartCluster), true);
  disk[partByteOffset + 64] = 0xf6;
  disk[partByteOffset + 510] = 0x55;
  disk[partByteOffset + 511] = 0xaa;

  // Record 10: sparse run (1 sparse cluster = 4096 zero bytes) followed by LCN 11 ('HELLO')
  const recOff = mftByteOffset + 10 * 1024;
  const rec = disk.subarray(recOff, recOff + 1024);
  const v = new DataView(disk.buffer, recOff, 1024);
  rec.set([0x46, 0x49, 0x4c, 0x45], 0);
  v.setUint16(4, 48, true);
  v.setUint16(6, 3, true);
  v.setUint16(20, 56, true);
  v.setUint16(22, 0x00, true); // deleted file
  v.setUint32(44, 10, true);
  v.setUint16(48, 1, true);
  v.setUint16(510, 1, true);
  v.setUint16(1022, 1, true);

  const fn = 'Sparse_File.bin';
  let cur = 56;
  const fnPayloadLen = 66 + fn.length * 2;
  const fnAttrLen = Math.ceil((24 + fnPayloadLen) / 8) * 8;
  v.setUint32(cur, 0x30, true);
  v.setUint32(cur + 4, fnAttrLen, true);
  v.setUint32(cur + 16, fnPayloadLen, true);
  v.setUint16(cur + 20, 24, true);
  v.setUint32(cur + 24, 5, true);
  rec[cur + 24 + 64] = fn.length;
  rec[cur + 24 + 65] = 3;
  for (let i = 0; i < fn.length; i++) v.setUint16(cur + 24 + 66 + i * 2, fn.charCodeAt(i), true);
  cur += fnAttrLen;

  // Non-resident $DATA with Run 1: sparse (header 0x01, count=1), Run 2: len=1, lcn=+11 (header 0x11, 1, 11)
  v.setUint32(cur, 0x80, true);
  v.setUint32(cur + 4, 80, true);
  rec[cur + 8] = 1;
  v.setUint16(cur + 32, 64, true);
  v.setBigUint64(cur + 48, BigInt(clusterSize + 5), true);
  rec[cur + 64] = 0x01;
  rec[cur + 65] = 1;
  rec[cur + 66] = 0x11;
  rec[cur + 67] = 1;
  rec[cur + 68] = 11;
  rec[cur + 69] = 0x00;
  cur += 80;
  v.setUint32(cur, 0xffffffff, true);
  v.setUint32(24, cur + 8, true);

  disk.set(Buffer.from('HELLO'), partByteOffset + 11 * clusterSize);

  const partitions = analyzeDiskImage('sparse.img', disk).partitions;
  const mft = scanNtfsMftRecordsInBuffer(disk, partitions, { includeExisting: false });
  const sparseRec = mft.find((r) => r.filename === 'Sparse_File.bin');
  assert.ok(sparseRec);
  assert.equal(sparseRec.extents.length, 2);
  assert.equal(sparseRec.extents[0].offset, -1);
  assert.equal(sparseRec.extents[0].length, clusterSize);
  assert.equal(sparseRec.extents[1].offset, partByteOffset + 11 * clusterSize);
  assert.equal(sparseRec.extents[1].length, 5);
  assert.equal(
    Buffer.from(sparseRec.reconstructedBytes.subarray(clusterSize, clusterSize + 5)).toString('ascii'),
    'HELLO',
  );
});

test('corrupt huge exFAT deleted file size exits cleanly and ftyp-only MP4 stub is flagged truncated', () => {
  const disk = new Uint8Array(64 * 512);
  const dv = new DataView(disk.buffer);
  disk[510] = 0x55;
  disk[511] = 0xaa;
  disk[446 + 4] = 0x07;
  dv.setUint32(446 + 8, 8, true);
  dv.setUint32(446 + 12, 48, true);

  const vol = 8 * 512;
  for (let i = 0; i < 8; i++) disk[vol + 3 + i] = 'EXFAT   '.charCodeAt(i);
  const ev = new DataView(disk.buffer, vol, 512);
  ev.setUint32(80, 16, true);
  ev.setUint32(84, 4, true);
  ev.setUint32(88, 24, true);
  ev.setUint32(92, 4, true);
  ev.setUint32(96, 2, true);
  disk[vol + 108] = 9;
  disk[vol + 109] = 3;
  disk[vol + 510] = 0x55;
  disk[vol + 511] = 0xaa;

  const rootOff = vol + 24 * 512;
  disk[rootOff] = 0x05;
  disk[rootOff + 1] = 2;
  disk[rootOff + 32] = 0x40;
  disk[rootOff + 33] = 0x02;
  const sv = new DataView(disk.buffer, rootOff + 32, 32);
  sv.setBigUint64(24, 0x80000000n, true);
  sv.setUint32(20, 3, true);
  disk[rootOff + 64] = 0x41;
  disk[rootOff + 66] = 0x41;

  const parts = analyzeDiskImage('exfat_corrupt.img', disk).partitions;
  const t0 = Date.now();
  const res = scanFatAndExfatDeletedInBuffer(disk, parts, { includeExisting: true });
  assert.ok(Date.now() - t0 < 1000, 'Corrupt exFAT size scan should finish instantaneously');
  assert.ok(Array.isArray(res));

  const ftypOnly = new Uint8Array([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
    0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00,
    0x6d, 0x70, 0x34, 0x32, 0x69, 0x73, 0x6f, 0x6d,
  ]);
  const idFtyp = identifyBuffer(ftypOnly);
  assert.ok(idFtyp);
  assert.equal(idFtyp.status, 'OK_TRUNCATED');
});

test('expanded 150+ signature catalog has unique IDs and identifies modern project, office, database, and forensic containers', () => {
  assert.ok(FILE_FORMATS.length >= 145, `Expected >=145 formats, got ${FILE_FORMATS.length}`);
  const idSet = new Set<string>();
  for (const fmt of FILE_FORMATS) {
    assert.equal(idSet.has(fmt.id), false, `Duplicate format ID: ${fmt.id}`);
    idSet.add(fmt.id);
  }

  // ZIP sub-typing -> .docx, .xlsx, .apk
  const mkZipEntry = (name: string) => {
    const nb = Buffer.from(name, 'utf8');
    const hdr = Buffer.alloc(30 + nb.length);
    hdr.writeUInt32LE(0x04034b50, 0);
    hdr.writeUInt16LE(20, 4);
    hdr.writeUInt16LE(nb.length, 26);
    nb.copy(hdr, 30);
    return new Uint8Array(hdr);
  };
  assert.equal(identifyBuffer(mkZipEntry('word/document.xml'))?.extension, 'docx');
  assert.equal(identifyBuffer(mkZipEntry('xl/workbook.xml'))?.extension, 'xlsx');
  assert.equal(identifyBuffer(mkZipEntry('AndroidManifest.xml'))?.extension, 'apk');

  // After Effects .aep (RIFX...Egg!)
  const aep = Buffer.alloc(32);
  aep.write('RIFX', 0, 'ascii');
  aep.writeUInt32BE(24, 4);
  aep.write('Egg!', 8, 'ascii');
  aep.write('LIST', 12, 'ascii');
  assert.equal(identifyBuffer(new Uint8Array(aep))?.extension, 'aep');

  // Photoshop .psd (8BPS v1)
  const psd = Buffer.alloc(36);
  psd.write('8BPS', 0, 'ascii');
  psd.writeUInt16BE(1, 4);
  assert.equal(identifyBuffer(new Uint8Array(psd))?.extension, 'psd');

  // Outlook .pst (!BDN...SM\0\0)
  const pst = Buffer.alloc(576);
  pst.write('!BDN', 0, 'ascii');
  pst.write('SM\0\0', 8, 'ascii');
  assert.equal(identifyBuffer(new Uint8Array(pst))?.extension, 'pst');

  // Ren'Py .rpa & .rpyc
  const rpa = Buffer.from('RPA-3.0 0000000000000120 42424242\nPAYLOAD', 'ascii');
  assert.equal(identifyBuffer(new Uint8Array(rpa))?.extension, 'rpa');
  const rpyc = Buffer.concat([Buffer.from('RENPY RPC2', 'ascii'), Buffer.from([1, 0, 0, 0, 0, 0])]);
  assert.equal(identifyBuffer(new Uint8Array(rpyc))?.extension, 'rpyc');

  // Blender, glTF binary (.glb), AutoCAD (.dwg), EVTX, LNK, PCAPNG, ZSTD
  assert.equal(identifyBuffer(new Uint8Array(Buffer.from('BLENDER-v305REND\0\0\0\0', 'ascii')))?.extension, 'blend');
  const glb = Buffer.alloc(24);
  glb.write('glTF', 0, 'ascii');
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(24, 8);
  assert.equal(identifyBuffer(new Uint8Array(glb))?.extension, 'glb');
  assert.equal(identifyBuffer(new Uint8Array(Buffer.from('AC1032\0\0\0\0\0\0\0\0\0\0', 'ascii')))?.extension, 'dwg');
  assert.equal(identifyBuffer(new Uint8Array(Buffer.from('ElfFile\0\0\0\0\0\0\0\0\0', 'ascii')))?.extension, 'evtx');
  assert.equal(
    identifyBuffer(new Uint8Array([0x0a, 0x0d, 0x0d, 0x0a, 28, 0, 0, 0, 0x4d, 0x3c, 0x2b, 0x1a, 1, 0, 0, 0]))?.extension,
    'pcapng',
  );
  assert.equal(identifyBuffer(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x24, 0x00, 0x00, 0x00]))?.extension, 'zst');
});

test('non-media structural repair fixes ZIP/DOCX central directory, AEP RIFX, AEPX/JSON/RPY, SQLite, PDF xref, PSD, PST, RPA', () => {
  // 1. Truncated .docx (ZIP missing EOCD + truncated stored XML entry)
  const docName = Buffer.from('word/document.xml', 'utf8');
  const xmlBody = Buffer.from('<w:document><w:body><w:p>Hello world', 'utf8');
  const lfh = Buffer.alloc(30 + docName.length + xmlBody.length);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(0, 8); // store
  lfh.writeUInt32LE(xmlBody.length + 50, 18); // intentionally over-long
  lfh.writeUInt32LE(xmlBody.length + 50, 22);
  lfh.writeUInt16LE(docName.length, 26);
  docName.copy(lfh, 30);
  xmlBody.copy(lfh, 30 + docName.length);

  const docxDiag = diagnoseMediaFile('docx', new Uint8Array(lfh));
  assert.equal(docxDiag.canRepair, true);
  const docxRep = repairFileBuffer('docx', new Uint8Array(lfh));
  assert.equal(docxRep.repaired, true);
  const docxStr = Buffer.from(docxRep.data).toString('latin1');
  assert.ok(docxStr.includes('PK\x01\x02'), 'Expected rebuilt Central Directory');
  assert.ok(docxStr.includes('PK\x05\x06'), 'Expected rebuilt EOCD');
  assert.ok(docxStr.includes('</w:p></w:body></w:document>'), 'Expected unclosed OOXML tags closed');

  // 2. Truncated .aep RIFX container
  const aepBad = Buffer.alloc(36);
  aepBad.write('RIFX', 0, 'ascii');
  aepBad.writeUInt32BE(9999, 4);
  aepBad.write('Egg!', 8, 'ascii');
  aepBad.write('head', 12, 'ascii');
  aepBad.writeUInt32BE(8, 16);
  aepBad.write('LIST', 28, 'ascii');
  aepBad.writeUInt32BE(4000, 32); // broken trailing chunk header
  const aepRep = repairFileBuffer('aep', new Uint8Array(aepBad));
  assert.equal(aepRep.repaired, true);
  assert.equal(aepRep.data.length, 28);
  assert.equal(Buffer.from(aepRep.data).readUInt32BE(4), 20);

  // 3. Truncated JSON & .aepx / .rpy with trailing nulls
  const jsonTrunc = Buffer.from('{"project":{"name":"Scene 1","layers":[1,2]}\0\0\0\0', 'utf8');
  const jsonRep = repairFileBuffer('json', new Uint8Array(jsonTrunc));
  assert.equal(jsonRep.repaired, true);
  const parsedJson = JSON.parse(Buffer.from(jsonRep.data).toString('utf8'));
  assert.equal(parsedJson.project.name, 'Scene 1');

  const aepxTrunc = Buffer.from('<?xml version="1.0"?><AfterEffectsProject><Comp name="Main">\0\0\0', 'utf8');
  const aepxRep = repairFileBuffer('aepx', new Uint8Array(aepxTrunc));
  assert.equal(aepxRep.repaired, true);
  const aepxText = Buffer.from(aepxRep.data).toString('utf8');
  assert.ok(aepxText.endsWith('</Comp></AfterEffectsProject>'));

  const rpySlack = Buffer.from('label start:\n    "Hi"\n\0\0\0\0\0\0\0\0', 'utf8');
  const rpyRep = repairFileBuffer('rpy', new Uint8Array(rpySlack));
  assert.equal(rpyRep.repaired, true);
  assert.equal(Buffer.from(rpyRep.data).toString('utf8'), 'label start:\n    "Hi"\n');

  // 4. SQLite header alignment + WAL reset
  const dbBuf = Buffer.alloc(4096 * 2);
  dbBuf.write('SQLite format 3\0', 0, 'ascii');
  dbBuf.writeUInt16BE(4096, 16);
  dbBuf[18] = 2; // WAL write version
  dbBuf[19] = 2; // WAL read version
  dbBuf.writeUInt32BE(10, 28); // wrong pageCount + trailing zero page
  const sqlRep = repairFileBuffer('sqlite', new Uint8Array(dbBuf));
  assert.equal(sqlRep.repaired, true);
  assert.equal(sqlRep.data.length, 4096);
  assert.equal(Buffer.from(sqlRep.data).readUInt32BE(28), 1);
  assert.equal(sqlRep.data[18], 1);

  // 5. PDF missing xref / startxref
  const pdfRaw = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 0 >>\nendobj\n',
    'ascii',
  );
  const pdfRep = repairFileBuffer('pdf', new Uint8Array(pdfRaw));
  assert.equal(pdfRep.repaired, true);
  const pdfTxt = Buffer.from(pdfRep.data).toString('ascii');
  assert.ok(pdfTxt.includes('\nxref\n0 3\n'));
  assert.ok(pdfTxt.includes('/Root 1 0 R'));
  assert.ok(pdfTxt.includes('startxref'));
  assert.ok(pdfTxt.trimEnd().endsWith('%%EOF'));

  // 6. PSD truncated section clamp + RPA / PST
  const psdBad = Buffer.alloc(48);
  psdBad.write('8BPS', 0, 'ascii');
  psdBad.writeUInt16BE(1, 4);
  psdBad.writeUInt32BE(999999, 26); // ColorModeData len exceeds buffer
  const psdRep = repairFileBuffer('psd', new Uint8Array(psdBad));
  assert.equal(psdRep.repaired, true);
  assert.equal(Buffer.from(psdRep.data).readUInt32BE(26), psdBad.length - 30);

  const pstBad = Buffer.alloc(600);
  pstBad.write('!BDN', 0, 'ascii');
  pstBad.write('SM\0\0', 8, 'ascii');
  pstBad[10] = 23; // Unicode PST magic >= 23
  pstBad.writeBigUInt64LE(999999n, 0xb8);
  const pstRep = repairFileBuffer('pst', new Uint8Array(pstBad));
  assert.equal(pstRep.repaired, true);
  assert.equal(Buffer.from(pstRep.data).readBigUInt64LE(0xb8), 600n);
});

test('non-contiguous / interleaved MP4 fragments interrupted by JPEG photo are stitched and playable in TS & Electron CJS', () => {
  const ftyp = Buffer.from([
    0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70,
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  ]);
  const frag1Payload = Buffer.from([
    0x00, 0x00, 0x00, 0x04, 0x67, 0x42, 0xc0, 0x1e, // SPS
    0x00, 0x00, 0x00, 0x04, 0x68, 0xce, 0x38, 0x80, // PPS
    0x00, 0x00, 0x00, 0x06, 0x65, 0x88, 0x84, 0x21, 0xa0, 0x00, // IDR #1
  ]);
  const mdatHdr = Buffer.alloc(8);
  mdatHdr.writeUInt32BE(2048, 0); // declared size spans across fragmentation gap & interleaved JPEG!
  mdatHdr.write('mdat', 4, 'ascii');

  const jpgPhoto = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
    0x00, 0x01, 0x00, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x11, 0x22,
    0xff, 0xd9,
  ]);

  const frag2Frames = Buffer.from([
    0x00, 0x00, 0x00, 0x06, 0x65, 0x88, 0x84, 0x21, 0xb0, 0x01, // IDR #2
    0xff, 0xf1, 0x50, 0x80, 0x01, 0x5f, 0xfc, 0x21, 0x00, 0x1a, // ADTS #1
    0xff, 0xf1, 0x50, 0x80, 0x01, 0x5f, 0xfc, 0x21, 0x00, 0x1b, // ADTS #2
    0x00, 0x00, 0x00, 0x06, 0x41, 0x9a, 0x22, 0x11, 0x00, 0x02, // P-frame
  ]);

  // Disk layout:
  // 512..1024   : Fragment 1 (ftyp + mdat header + SPS/PPS/IDR1)
  // 1024..1536  : Interleaved JPEG photo
  // 2048..2560  : Fragment 2 (IDR2 + ADTS + P-frame)
  const disk = new Uint8Array(8192);
  disk.set(ftyp, 512);
  disk.set(mdatHdr, 512 + ftyp.length);
  disk.set(frag1Payload, 512 + ftyp.length + 8);
  disk.set(jpgPhoto, 1024);
  disk.set(frag2Frames, 2048);

  const carved = carveDiskBuffer(disk, { startByte: 0, endByte: disk.length, blockSize: 512 });
  const carvedJpg = carved.find((c) => c.extension === 'jpg');
  assert.ok(carvedJpg, 'Expected interleaved JPEG to still be carved');

  const stitchedMp4 = carved.find((c) => c.extension === 'mp4');
  assert.ok(stitchedMp4, 'Expected MP4 to be carved & stitched');
  assert.ok(stitchedMp4.runs && stitchedMp4.runs.length >= 2, 'Expected >=2 extent runs after stitching');
  assert.equal(stitchedMp4.status, 'OK');
  assert.ok(inspectMp4Health(stitchedMp4.data).hasMoov, 'Expected rebuilt playable moov atom');

  // Verify Electron CJS stitcher + documentRepairCjs + offline fidentify fallback
  const req = createRequire(import.meta.url);
  const { stitchFragmentedVideosFromFdCjs } = req('../electron/mediaRepairCjs.cjs');
  const { repairNonMediaBufferCjs } = req('../electron/documentRepairCjs.cjs');
  const { runFidentifyPaths, getEngineCapabilitiesSync } = req('../electron/enginesHelper.cjs');

  assert.equal(getEngineCapabilitiesSync(false).fidentify, true);
  assert.equal(repairNonMediaBufferCjs('json', Buffer.from('{"a":1\0\0')).data.toString('utf8'), '{"a":1}');

  const tmpDir = os.tmpdir();
  const imgPath = path.join(tmpDir, `frag_test_${Date.now()}.img`);
  const unkPath = path.join(tmpDir, `unknown_noext_${Date.now()}`);
  try {
    fs.writeFileSync(imgPath, disk);
    fs.writeFileSync(unkPath, Buffer.from('%PDF-1.7\n1 0 obj\n'));

    const cjsEntries: Array<Record<string, unknown>> = [
      {
        id: 'drv-512-mp4',
        extensionHint: 'mp4',
        sourceKind: 'carved',
        offset: 512,
        size: 1024,
        truncated: true,
      },
      {
        id: 'drv-1024-jpg',
        extensionHint: 'jpg',
        sourceKind: 'carved',
        offset: 1024,
        size: jpgPhoto.length,
        truncated: false,
      },
    ];
    const stitchedCjs = stitchFragmentedVideosFromFdCjs(imgPath, cjsEntries, disk.length, 512);
    assert.equal(stitchedCjs.length, 1);
    assert.ok(Array.isArray(stitchedCjs[0].runs) && stitchedCjs[0].runs.length >= 2);

    return runFidentifyPaths([unkPath]).then((idMap: Record<string, string>) => {
      assert.equal(idMap[unkPath], 'pdf');
    });
  } finally {
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
    if (fs.existsSync(unkPath)) fs.unlinkSync(unkPath);
  }
});

test('audit fixes: multi-byte UTF-8 text not corrupted, RTF brace repair, OST vs PST detection, and stitched CRC-32 match', () => {
  const req = createRequire(import.meta.url);
  const { repairNonMediaBufferCjs } = req('../electron/documentRepairCjs.cjs');
  const { stitchFragmentedVideosFromFdCjs } = req('../electron/mediaRepairCjs.cjs');

  // 1. Intact multi-byte UTF-8 text must NOT trigger trailing slack false positive
  const utf8Intact = Buffer.from('Copyright © 2026 — 日本語テスト\nlabel hello:', 'utf8');
  assert.equal(repairNonMediaBufferCjs('rpy', utf8Intact), null);
  assert.equal(repairFileBuffer('rpy', new Uint8Array(utf8Intact)).repaired, false);

  // 2. Truncated RTF closes unclosed group braces and strips trailing binary null slack
  const rtfTruncated = Buffer.from('{\\rtf1\\ansi{\\fonttbl\\f0 Arial;\\0\0\0', 'utf8');
  const rtfTs = repairFileBuffer('rtf', new Uint8Array(rtfTruncated));
  assert.equal(rtfTs.repaired, true);
  assert.ok(Buffer.from(rtfTs.data).toString('utf8').endsWith('}}'));
  const rtfCjs = repairNonMediaBufferCjs('rtf', rtfTruncated);
  assert.ok(rtfCjs && rtfCjs.data.toString('utf8').endsWith('}}'));

  // 3. OST vs PST magic distinction in identifyBuffer
  const ostHdr = new Uint8Array(512);
  ostHdr[0] = 0x21; ostHdr[1] = 0x42; ostHdr[2] = 0x44; ostHdr[3] = 0x4e; // !BDN
  ostHdr[8] = 0x53; ostHdr[9] = 0x4f; ostHdr[10] = 23; ostHdr[11] = 0; // SO + Unicode ver 23
  const ostMatch = identifyBuffer(ostHdr);
  assert.equal(ostMatch?.extension, 'ost');

  const pstHdr = new Uint8Array(512);
  pstHdr[0] = 0x21; pstHdr[1] = 0x42; pstHdr[2] = 0x44; pstHdr[3] = 0x4e; // !BDN
  pstHdr[8] = 0x53; pstHdr[9] = 0x4d; pstHdr[10] = 23; pstHdr[11] = 0; // SM + Unicode ver 23
  const pstMatch = identifyBuffer(pstHdr);
  assert.equal(pstMatch?.extension, 'pst');

  // 4. Stitched video CRC-32 updates to match assembled multi-run bytes (not contiguous gap bytes)
  const disk = Buffer.alloc(8192);
  const ftyp = Buffer.from([0x00, 0x00, 0x00, 0x10, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00]);
  const mdatHdr = Buffer.alloc(8);
  mdatHdr.writeUInt32BE(2048, 0);
  mdatHdr.write('mdat', 4, 'ascii');
  const spsPpsIdr = Buffer.from([
    0x00, 0x00, 0x00, 0x04, 0x67, 0x42, 0xc0, 0x1e,
    0x00, 0x00, 0x00, 0x04, 0x68, 0xce, 0x38, 0x80,
    0x00, 0x00, 0x00, 0x06, 0x65, 0x88, 0x84, 0x21, 0xa0, 0x00,
  ]);
  const jpgGap = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
  const frag2 = Buffer.from([
    0x00, 0x00, 0x00, 0x06, 0x65, 0x88, 0x84, 0x21, 0xb0, 0x01,
    0xff, 0xf1, 0x50, 0x80, 0x01, 0x5f, 0xfc, 0x21, 0x00, 0x1a,
    0xff, 0xf1, 0x50, 0x80, 0x01, 0x5f, 0xfc, 0x21, 0x00, 0x1b,
  ]);
  ftyp.copy(disk, 512);
  mdatHdr.copy(disk, 512 + ftyp.length);
  spsPpsIdr.copy(disk, 512 + ftyp.length + 8);
  jpgGap.copy(disk, 1024);
  frag2.copy(disk, 2048);

  const imgPath = path.join(os.tmpdir(), `crc_stitch_${Date.now()}.img`);
  try {
    fs.writeFileSync(imgPath, disk);
    const oldContigCrc = computeCrc32(new Uint8Array(disk.subarray(512, 512 + 2048)));
    const entries: Array<Record<string, unknown>> = [
      { id: 'drv-512-mp4', extensionHint: 'mp4', sourceKind: 'carved', offset: 512, size: 1024, truncated: true, discoveryCrc32: oldContigCrc },
      { id: 'drv-1024-jpg', extensionHint: 'jpg', sourceKind: 'carved', offset: 1024, size: jpgGap.length, truncated: false },
    ];
    const stitched = stitchFragmentedVideosFromFdCjs(imgPath, entries, disk.length, 512);
    assert.equal(stitched.length, 1);
    const stitchedRuns = stitched[0].runs as Array<{ offset: number; length: number }>;
    const assembled = Buffer.concat(stitchedRuns.map((r) => disk.subarray(r.offset, r.offset + r.length)));
    assert.equal(stitched[0].discoveryCrc32, computeCrc32(new Uint8Array(assembled.subarray(0, 65536))));
    assert.notEqual(stitched[0].discoveryCrc32, oldContigCrc);
  } finally {
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
  }
});

test('alignedIoCjs: sector-aligned reads and resilient bad-sector retry skip unreadable sectors safely', () => {
  const req = createRequire(import.meta.url);
  const {
    normalizeSectorSize,
    readAlignedSync,
    readAlignedResilientSync,
  } = req('../electron/alignedIoCjs.cjs');

  assert.equal(normalizeSectorSize(512), 512);
  assert.equal(normalizeSectorSize(4096), 4096);
  assert.equal(normalizeSectorSize(128), 512);

  const tmpFile = path.join(os.tmpdir(), `aligned_io_${Date.now()}.bin`);
  const payload = Buffer.alloc(16384);
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
  fs.writeFileSync(tmpFile, payload);

  const fd = fs.openSync(tmpFile, 'r');
  try {
    // Read unaligned slice across 4096-byte sector boundaries
    const out = Buffer.alloc(3000);
    const readN = readAlignedSync(fd, out, 0, 3000, 123, 4096);
    assert.equal(readN, 3000);
    assert.deepEqual(out, payload.subarray(123, 3123));

    // Simulate bulk EIO followed by single bad sector at offset 512
    const origReadSync = fs.readSync;
    (fs as unknown as { readSync: typeof fs.readSync }).readSync = ((
      _fd: number,
      buf: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      const pos = Number(position ?? 0);
      if (length > 512 && pos <= 512 && pos + length > 512) {
        const err = Object.assign(new Error('EIO simulated bulk failure'), { code: 'EIO' });
        throw err;
      }
      if (pos === 512 && length === 512) {
        const err = Object.assign(new Error('EIO simulated bad sector 1'), { code: 'EIO' });
        throw err;
      }
      return origReadSync(_fd, buf, offset, length, position);
    }) as typeof fs.readSync;

    try {
      const resBuf = Buffer.alloc(2048, 0xaa);
      const res = readAlignedResilientSync(fd, resBuf, 0, 2048, 0, 512);
      assert.equal(res.bytesRead, 2048);
      assert.equal(res.skippedSectors, 1);
      assert.equal(res.skippedBytes, 512);
      assert.deepEqual(res.skippedRanges, [{ offset: 512, length: 512 }]);
      assert.deepEqual(resBuf.subarray(0, 512), payload.subarray(0, 512));
      assert.ok(resBuf.subarray(512, 1024).every((b) => b === 0), 'Expected bad sector zero-filled');
      assert.deepEqual(resBuf.subarray(1024, 2048), payload.subarray(1024, 2048));
    } finally {
      (fs as unknown as { readSync: typeof fs.readSync }).readSync = origReadSync;
    }
  } finally {
    fs.closeSync(fd);
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  }
});

test('scannerWorker & signatures: sizeEstimated cursors advance by step so adjacent files are never skipped', async () => {
  const req = createRequire(import.meta.url);
  const { scanRange, checkOffsetAllocation } = req('../electron/scannerWorker.cjs');

  // Verify checkOffsetAllocation against bitmap
  const bitmap = Buffer.from([0b00000101]); // clusters 0 & 2 allocated, cluster 1 free
  const bmMeta = [{ volStart: 4096, volEnd: 65536, clusterBytes: 4096, bitmap }];
  assert.deepEqual(checkOffsetAllocation(4096, true, bmMeta), { allocated: true, verified: true });
  assert.deepEqual(checkOffsetAllocation(4096 + 4096, true, bmMeta), { allocated: false, verified: true });
  assert.deepEqual(checkOffsetAllocation(4096 + 8192, true, bmMeta), { allocated: true, verified: true });

  // Put an unframed header-only signature (RTF) at sector 1 (offset 512) and a real JPEG at sector 2 (offset 1024)
  const disk = Buffer.alloc(4096);
  Buffer.from('{\\rtf1\\ansi Recovered RTF stream', 'utf8').copy(disk, 512);
  const jpg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xdb, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xaa, 0xff, 0xd9,
  ]);
  jpg.copy(disk, 1024);

  const tsCarved = carveDiskBuffer(new Uint8Array(disk), { startByte: 0, endByte: disk.length, blockSize: 512 });
  const tsRtf = tsCarved.find((c) => c.extension === 'rtf');
  const tsJpg = tsCarved.find((c) => c.extension === 'jpg');
  assert.ok(tsRtf && tsRtf.sizeEstimated === true && tsRtf.status === 'OK_TRUNCATED');
  assert.ok(tsJpg, 'Expected adjacent JPEG after sizeEstimated RTF not to be skipped in TS carver');

  const imgPath = path.join(os.tmpdir(), `worker_step_${Date.now()}.img`);
  fs.writeFileSync(imgPath, disk);
  try {
    const res = await scanRange({
      devicePath: imgPath,
      rangeStart: 0,
      rangeEnd: disk.length,
      totalLimitBytes: disk.length,
      step: 512,
      sectorSize: 512,
    });
    const wJpg = res.entries.find((e: { extensionHint: string }) => e.extensionHint === 'jpg');
    assert.ok(wJpg, 'Expected adjacent JPEG not to be skipped in scannerWorker.cjs');
  } finally {
    if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
  }
});

test('main.cjs security & integrity helpers: BitLocker env vars, same-disk block, exact FD slice, CRC verification & keepOriginalOnRepair', async () => {
  const req = createRequire(import.meta.url);
  const {
    buildBitLockerUnlockSpec,
    checkSameSourcePaths,
    readDiskBytesFromFdSync,
    recoverFilesImpl,
    scanLostPartitionsFromFd,
  } = req('../electron/main.cjs');
  const { getCandidateEngineDirs } = req('../electron/enginesHelper.cjs');

  // 1. Engine lookup excludes user-writable paths when elevated or packaged
  const elevatedDirs = getCandidateEngineDirs({ elevated: true, packaged: true });
  assert.equal(elevatedDirs.some((d: string) => /AppData|scoop|WinGet/i.test(d)), false);

  // 2. BitLocker secrets passed via envPatch instead of CLI arguments
  const blSpec = buildBitLockerUnlockSpec({
    driveLetter: 'e:',
    recoveryKey: '111111-222222-333333-444444-555555-666666-777777-888888',
  });
  assert.equal(blSpec.ok, true);
  assert.equal(blSpec.args.join(' ').includes('111111-222222'), false);
  assert.equal(blSpec.envPatch.TD_BL_KEY, '111111-222222-333333-444444-555555-666666-777777-888888');
  assert.equal(blSpec.envPatch.TD_BL_LETTER, 'E');

  // 3. Same-source path blocking & unverified PhysicalDrive guard
  const sameVol = await checkSameSourcePaths({
    targetPath: 'D:\\RecoveryOut',
    sourcePaths: ['\\\\.\\D:'],
    platform: 'win32',
  });
  assert.equal(sameVol.blocked, true);

  const sameDisk = await checkSameSourcePaths({
    targetPath: 'D:\\RecoveryOut',
    sourcePaths: ['\\\\.\\PhysicalDrive1'],
    platform: 'win32',
    resolveBackingDriveFn: async () => ({ devicePath: '\\\\.\\PhysicalDrive1' }),
  });
  assert.equal(sameDisk.blocked, true);

  const unverified = await checkSameSourcePaths({
    targetPath: 'Z:\\NetworkShare',
    sourcePaths: ['\\\\.\\PhysicalDrive1'],
    platform: 'win32',
    resolveBackingDriveFn: async () => null,
    allowUnverifiedDestination: false,
  });
  assert.equal(unverified.blocked, true);
  assert.equal(unverified.unverified, true);

  // 4. readDiskBytesFromFdSync exact slice + scanLostPartitionsFromFd at LBA 2048 (> 1 MiB) + strict CRC & keepOriginalOnRepair
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td_main_test_'));
  try {
    const imgPath = path.join(tmpDir, 'disk.img');
    const diskBuf = Buffer.alloc(2 * 1024 * 1024);
    Buffer.from('EXACT_SLICE_MARKER').copy(diskBuf, 100);
    // Lost NTFS boot sector at LBA 2048 (1 MiB offset)
    const lba2048 = 2048 * 512;
    diskBuf[lba2048] = 0xeb; diskBuf[lba2048 + 1] = 0x52; diskBuf[lba2048 + 2] = 0x90;
    diskBuf.write('NTFS    ', lba2048 + 3, 'ascii');
    diskBuf.writeUInt16LE(512, lba2048 + 11);
    diskBuf[lba2048 + 13] = 8;
    diskBuf.writeBigUInt64LE(4096n, lba2048 + 40);
    diskBuf[lba2048 + 510] = 0x55; diskBuf[lba2048 + 511] = 0xaa;

    // Truncated JSON payload at offset 4096 (missing closing brace)
    const truncJson = Buffer.from('{"recovered":true\0\0\0', 'utf8');
    truncJson.copy(diskBuf, 4096);
    fs.writeFileSync(imgPath, diskBuf);

    const fd = fs.openSync(imgPath, 'r');
    try {
      const slice = readDiskBytesFromFdSync(fd, 100, 18, 512);
      assert.equal(slice.toString('ascii'), 'EXACT_SLICE_MARKER');

      const lostParts = scanLostPartitionsFromFd(fd, diskBuf.length, 512);
      assert.ok(lostParts.some((p: { fsType: string; startLba: number }) => p.fsType === 'NTFS' && p.startLba === 2048));
    } finally {
      fs.closeSync(fd);
    }

    const goodCrc = computeCrc32(new Uint8Array(truncJson));
    const destDir = path.join(tmpDir, 'out');
    fs.mkdirSync(destDir);

    // Strict CRC mismatch must refuse to commit file
    const badRes = await recoverFilesImpl({
      targetRoot: destDir,
      keepOriginalOnRepair: true,
      items: [
        {
          filename: 'bad.json',
          folder: 'Documents',
          sourceKind: 'native-device',
          devicePath: imgPath,
          offset: 4096,
          size: truncJson.length,
          discoveryCrc32: goodCrc ^ 0xffffffff,
          extension: 'json',
          repairIfTruncated: false,
        },
      ],
    });
    assert.equal(badRes.savedCount, 0);
    assert.equal(badRes.failures.length, 1);

    // Valid CRC + repair keeps untouched original when keepOriginalOnRepair=true
    const okRes = await recoverFilesImpl({
      targetRoot: destDir,
      keepOriginalOnRepair: true,
      items: [
        {
          filename: 'doc.json',
          folder: 'Documents',
          sourceKind: 'native-device',
          devicePath: imgPath,
          offset: 4096,
          size: truncJson.length,
          discoveryCrc32: goodCrc,
          extension: 'json',
          repairIfTruncated: true,
        },
      ],
    });
    assert.equal(okRes.savedCount, 1);
    assert.equal(okRes.verifiedCount, 1);
    assert.equal(okRes.repairedCount, 1);
    assert.equal(okRes.originalKeptCount, 1);
    assert.ok(okRes.reportPath?.endsWith('Recovery-Audit-Report.txt'));
    const outSubdir = path.join(destDir, 'Documents');
    const filesOut = fs.readdirSync(outSubdir);
    assert.ok(filesOut.some((f) => f === 'doc.json'));
    assert.ok(filesOut.some((f) => f === 'doc_original.json'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('main.cjs NTFS 4K MFT record + $ATTRIBUTE_LIST + compression/EFS + missing timestamp safety + GPT refusal', () => {
  const req = createRequire(import.meta.url);
  const { parseMftRecordBuffer, applyMftUsaFixup } = req('../electron/main.cjs');

  // Construct an image containing Base Record 100 (4096-byte) with $ATTRIBUTE_LIST pointing to Ext Record 101 for $DATA
  const recSize = 4096;
  const clusterBytes = 4096;
  const imgBuf = Buffer.alloc(65536);

  const buildMftRec = (recNum: number, baseRec: number, attrs: Buffer[]) => {
    const rec = Buffer.alloc(recSize);
    rec.write('FILE', 0, 'ascii');
    rec.writeUInt16LE(48, 4); // USA offset (48..65 for 1+8 words)
    rec.writeUInt16LE(1 + recSize / 512, 6);
    rec.writeUInt16LE(1, 16); // seq
    rec.writeUInt32LE(72, 20); // first attr offset past USA
    rec.writeUInt16LE(0x0000, 22); // deleted file
    rec.writeUInt32LE(baseRec, 32); // base file record ref
    rec.writeUInt32LE(recNum, 44);
    const usn = 0x0007;
    rec.writeUInt16LE(usn, 48);
    let pos = 72;
    for (const a of attrs) {
      a.copy(rec, pos);
      pos += a.length;
    }
    rec.writeUInt32LE(0xffffffff, pos);
    rec.writeUInt32LE(pos + 8, 24);
    for (let s = 1; s <= recSize / 512; s++) {
      const se = s * 512 - 2;
      rec.writeUInt16LE(rec.readUInt16LE(se), 48 + s * 2);
      rec.writeUInt16LE(usn, se);
    }
    return rec;
  };

  // $FILE_NAME attr (0x30) for "secret.txt"
  const fnName = Buffer.from('secret.txt', 'utf16le');
  const fnAttr = Buffer.alloc(Math.ceil((24 + 66 + fnName.length) / 8) * 8);
  fnAttr.writeUInt32LE(0x30, 0);
  fnAttr.writeUInt32LE(fnAttr.length, 4);
  fnAttr.writeUInt32LE(66 + fnName.length, 16);
  fnAttr.writeUInt16LE(24, 20);
  fnAttr.writeUInt32LE(5, 24); // parent = 5
  fnAttr[24 + 64] = 'secret.txt'.length;
  fnAttr[24 + 65] = 3;
  fnName.copy(fnAttr, 24 + 66);

  // $ATTRIBUTE_LIST (0x20) entry pointing to record 1 for $DATA (0x80)
  const alEntry = Buffer.alloc(32);
  alEntry.writeUInt32LE(0x80, 0);
  alEntry.writeUInt16LE(26, 4);
  alEntry[6] = 0; // nameLen
  alEntry[7] = 26; // nameOff
  alEntry.writeUInt32LE(1, 16); // ext record 1
  const alAttr = Buffer.alloc(24 + 32);
  alAttr.writeUInt32LE(0x20, 0);
  alAttr.writeUInt32LE(alAttr.length, 4);
  alAttr.writeUInt32LE(32, 16);
  alAttr.writeUInt16LE(24, 20);
  alEntry.copy(alAttr, 24);

  // Extension record 1 with compressed + encrypted flags on resident $DATA
  const payload = Buffer.from('COMPRESSED_EFS_BYTES', 'utf8');
  const dataAttr = Buffer.alloc(Math.ceil((24 + payload.length) / 8) * 8);
  dataAttr.writeUInt32LE(0x80, 0);
  dataAttr.writeUInt32LE(dataAttr.length, 4);
  dataAttr.writeUInt16LE(0x4001, 12); // Compressed (0x0001) + Encrypted (0x4000)
  dataAttr.writeUInt32LE(payload.length, 16);
  dataAttr.writeUInt16LE(24, 20);
  payload.copy(dataAttr, 24);

  const mftStartOffset = 8192;
  // Place rec 0 at slot 0, rec 1 (pointing back to base record 0) at slot 1 inside mftRuns
  const baseRecBuf = buildMftRec(0, 0, [fnAttr, alAttr]);
  const extRecBuf = buildMftRec(1, 0, [dataAttr]);
  baseRecBuf.copy(imgBuf, mftStartOffset);
  extRecBuf.copy(imgBuf, mftStartOffset + recSize);

  const tmpImg = path.join(os.tmpdir(), `mft_4k_${Date.now()}.img`);
  fs.writeFileSync(tmpImg, imgBuf);
  const fd = fs.openSync(tmpImg, 'r');
  try {
    const part = { volStart: 0, volEnd: imgBuf.length, clusterBytes, sectorSize: 512, mftRecSize: recSize };
    const mftRuns = [{ lcn: Math.floor(mftStartOffset / clusterBytes), clusterCount: 4 }];
    assert.equal(applyMftUsaFixup(Buffer.from(baseRecBuf), recSize), true);
    const parsed = parseMftRecordBuffer(
      baseRecBuf,
      mftStartOffset,
      [part],
      fd,
      imgBuf.length,
      new Map(),
      new Map(),
      true,
      { mftRuns, mftRecSize: recSize, sectorSize: 512 },
    );
    assert.ok(parsed?.entry);
    assert.equal(parsed.entry.filename, 'secret.txt');
    assert.equal(parsed.entry.ntfsCompressed, true);
    assert.equal(parsed.entry.ntfsEncrypted, true);
    assert.equal(parsed.entry.modifiedAt, undefined);

    // Extension record with mismatched baseRec (99 != 0) MUST be rejected by ownership check (#10)
    const rogueExt = buildMftRec(1, 99, [dataAttr]);
    const rogueFdBuf = Buffer.from(imgBuf);
    rogueExt.copy(rogueFdBuf, mftStartOffset + recSize);
    const roguePath = `${tmpImg}.rogue`;
    fs.writeFileSync(roguePath, rogueFdBuf);
    const rfd = fs.openSync(roguePath, 'r');
    try {
      const rogueParsed = parseMftRecordBuffer(
        baseRecBuf,
        mftStartOffset,
        [part],
        rfd,
        rogueFdBuf.length,
        new Map(),
        new Map(),
        true,
        { mftRuns, mftRecSize: recSize, sectorSize: 512 },
      );
      assert.equal(rogueParsed?.entry, undefined);
    } finally {
      fs.closeSync(rfd);
      if (fs.existsSync(roguePath)) fs.unlinkSync(roguePath);
    }
  } finally {
    fs.closeSync(fd);
    if (fs.existsSync(tmpImg)) fs.unlinkSync(tmpImg);
  }

  // Missing timestamps format as Unknown and omit <mtime> in DFXML
  assert.equal(formatShortDate(undefined), 'Unknown');
  assert.equal(formatShortDate(0), 'Unknown');

  // Likelihood caps on encrypted / compressed / estimated
  assert.ok(computeRecoveryLikelihood({ status: 'OK', size: 100, calculatedSize: 100, partitionId: 'p1', metadata: {}, ntfsEncrypted: true }).chance <= 35);
  assert.ok(computeRecoveryLikelihood({ status: 'OK', size: 100, calculatedSize: 100, partitionId: 'p1', metadata: {}, ntfsCompressed: true }).chance <= 55);
  assert.ok(computeRecoveryLikelihood({ status: 'OK_TRUNCATED', size: 100, calculatedSize: 100, partitionId: 'p1', metadata: {}, sizeEstimated: true }).chance <= 74);

  const dfxml = buildDfxmlReport({
    diskName: 'TestDisk.img',
    diskSizeBytes: 4096,
    items: [
      {
        id: '1',
        filename: 'sparse.bin',
        extension: 'bin',
        family: 'Others',
        mimeType: 'application/octet-stream',
        size: 8192,
        calculatedSize: 8192,
        status: 'OK',
        sourceKind: 'ntfs-mft',
        partitionId: 'p1',
        partitionName: 'NTFS',
        offset: 4096,
        sector: 8,
        matchedOffset: 0,
        matchedLength: 0,
        metadata: {},
        description: 'Sparse test',
        data: new Uint8Array(0),
        sourceRef: { kind: 'native-runs', offset: 4096, size: 8192, runs: [{ offset: 4096, length: 4096 }, { offset: -1, length: 4096 }] },
        recoveryChance: 80,
        recoveryTier: 'medium',
        recoveryReason: 'Test',
      },
    ],
  });
  assert.equal(dfxml.includes('<mtime>'), false);
  assert.ok(dfxml.includes('fill="0"'));
  assert.equal(/cgsecurity/i.test(dfxml), false);

  // writeMbrPartitionTable refuses EFI GPT protective MBR disks
  const gptDisk = new Uint8Array(4096);
  gptDisk[0x1be + 4] = 0xee;
  gptDisk[510] = 0x55;
  gptDisk[511] = 0xaa;
  assert.throws(() => writeMbrPartitionTable(gptDisk, []), /GPT/);
});

test('third-audit regressions: lost partitions IPC + sparse probe + early EOF + unreadable bitmap + range bitmap + incomplete export + zero-fill audit + same-drive + MBR bounds + CSV Unknown', async () => {
  const req = createRequire(import.meta.url);
  const {
    scanLostPartitionsHandlerImpl,
    startDriveScanHandlerImpl,
    loadNtfsBitmapsOnly,
    readFat32BitmapOnly,
    readExfatBitmapOnly,
    checkSameSourcePaths,
    recoverFilesImpl,
    readDiskBytesDetailedFromFdSync,
    scanVssSnapshotsForPrefix,
  } = req('../electron/main.cjs');
  const { checkRangeAllocation, scanRange } = req('../electron/scannerWorker.cjs');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td_audit3_test_'));
  try {
    // 1 + 13: 8 MiB image with NTFS at LBA 2048 and ext4 superblock at LBA 5000 (superblock +1024 inside LBA 5000)
    const img8mPath = path.join(tmpDir, 'lost8m.img');
    const img8m = Buffer.alloc(8 * 1024 * 1024);
    const lba2048 = 2048 * 512;
    img8m[lba2048] = 0xeb; img8m[lba2048 + 1] = 0x52; img8m[lba2048 + 2] = 0x90;
    img8m.write('NTFS    ', lba2048 + 3, 'ascii');
    img8m.writeUInt16LE(512, lba2048 + 11);
    img8m[lba2048 + 13] = 8;
    img8m.writeBigUInt64LE(4096n, lba2048 + 40);
    img8m[lba2048 + 510] = 0x55; img8m[lba2048 + 511] = 0xaa;

    const lba5000 = 5000 * 512;
    const sbOff = lba5000 + 1024;
    img8m.writeUInt16LE(0xef53, sbOff + 0x38); // ext magic
    img8m.writeUInt32LE(2, sbOff + 0x18); // s_log_block_size -> 4096
    img8m.writeUInt32LE(512, sbOff + 0x04); // s_blocks_count_lo -> 512 * 4096 = 2 MiB
    img8m.writeUInt32LE(0x40, sbOff + 0x60); // ext4 feature extents

    // Also place an out-of-bounds FAT16 boot sector at LBA 7000 claiming 999999 sectors -> must be clamped or rejected
    const lba7000 = 7000 * 512;
    img8m[lba7000] = 0xeb; img8m[lba7000 + 1] = 0x3c; img8m[lba7000 + 2] = 0x90;
    img8m.write('MSDOS5.0', lba7000 + 3, 'ascii');
    img8m.writeUInt16LE(512, lba7000 + 11);
    img8m[lba7000 + 13] = 4;
    img8m.writeUInt16LE(1, lba7000 + 14);
    img8m[lba7000 + 16] = 2;
    img8m.writeUInt16LE(512, lba7000 + 17);
    img8m.writeUInt32LE(999999, lba7000 + 32); // way past 8 MiB EOF
    img8m.write('FAT16   ', lba7000 + 54, 'ascii');
    img8m[lba7000 + 510] = 0x55; img8m[lba7000 + 511] = 0xaa;
    fs.writeFileSync(img8mPath, img8m);

    const lostIpcRes = await scanLostPartitionsHandlerImpl({
      devicePath: img8mPath,
      totalBytes: img8m.length,
    });
    assert.ok(Array.isArray(lostIpcRes.partitions));
    assert.ok(lostIpcRes.partitions.some((p: { startLba: number; status: string }) => p.startLba === 2048 && p.status === 'Deleted / Lost'));
    assert.ok(lostIpcRes.partitions.some((p: { startLba: number; typeName: string }) => p.startLba === 5000 && /ext/i.test(p.typeName)));
    for (const p of lostIpcRes.partitions) {
      assert.ok(p.endLba * 512 <= img8m.length, `LBA ${p.startLba} endLba ${p.endLba} exceeded image bounds`);
    }

    // 2: Early EOF on Deep Scan (1024-byte file, declared totalBytes = 1 MiB) -> incomplete=true + warning
    const tinyPath = path.join(tmpDir, 'tiny_eof.img');
    fs.writeFileSync(tinyPath, Buffer.alloc(1024));
    const eofRes = await startDriveScanHandlerImpl(null, {
      scanId: 'test-eof-1',
      devicePath: tinyPath,
      totalBytes: 1024 * 1024,
      blockSize: 512,
      scanMode: 'full',
      startPhase: 'deep',
    });
    assert.equal(eofRes.incomplete, true);
    assert.ok(eofRes.warnings.some((w: string) => /EOF|bytes of/i.test(w)));

    // Direct worker scanRange early EOF reporting
    const workerMsgs: unknown[] = [];
    const resWorker = await scanRange({
      devicePath: tinyPath,
      rangeStart: 0,
      rangeEnd: 64 * 1024,
      totalLimitBytes: 64 * 1024,
      blockSize: 512,
      workerIndex: 0,
      emit: (m: unknown) => workerMsgs.push(m),
    });
    assert.equal(resWorker.earlyEof, true);
    assert.ok(workerMsgs.some((m: { type?: string }) => m.type === 'error'));

    // 3: Simulated EIO on $Bitmap middle sector keeps sectorValidity false and prevents marking unverified clusters as free
    const ntfsMapImg = Buffer.alloc(64 * 1024);
    ntfsMapImg[0] = 0xeb; ntfsMapImg[1] = 0x52; ntfsMapImg[2] = 0x90;
    ntfsMapImg.write('NTFS    ', 3, 'ascii');
    ntfsMapImg.writeUInt16LE(512, 11);
    ntfsMapImg[13] = 2; // 1024 B cluster
    ntfsMapImg.writeBigUInt64LE(128n, 40); // 128 sectors
    ntfsMapImg.writeBigUInt64LE(4n, 48); // MFT at cluster 4 (offset 4096)
    ntfsMapImg[64] = 0xfc; // -4 => 1024-byte MFT record
    ntfsMapImg[510] = 0x55; ntfsMapImg[511] = 0xaa;
    // MFT record 0 ($MFT) at offset 4096 with valid USA fixup so readNtfsBootAndMftLayout succeeds
    const writeSmallMftRec = (targetOff: number, recNum: number, attrs: Buffer[]) => {
      ntfsMapImg.write('FILE', targetOff, 'ascii');
      ntfsMapImg.writeUInt16LE(48, targetOff + 4); // USA offset
      ntfsMapImg.writeUInt16LE(3, targetOff + 6); // 1 + 1024/512 = 3 words
      ntfsMapImg.writeUInt16LE(1, targetOff + 16); // seq
      ntfsMapImg.writeUInt16LE(56, targetOff + 20); // first attr offset
      ntfsMapImg.writeUInt16LE(1, targetOff + 22); // in-use
      ntfsMapImg.writeUInt32LE(recNum, targetOff + 44);
      const usn = 1;
      ntfsMapImg.writeUInt16LE(usn, targetOff + 48);
      let pos = 56;
      for (const a of attrs) {
        a.copy(ntfsMapImg, targetOff + pos);
        pos += a.length;
      }
      ntfsMapImg.writeUInt32LE(0xffffffff, targetOff + pos);
      ntfsMapImg.writeUInt32LE(pos + 8, targetOff + 24); // usedBytes
      for (let s = 1; s <= 2; s++) {
        const se = targetOff + s * 512 - 2;
        ntfsMapImg.writeUInt16LE(ntfsMapImg.readUInt16LE(se), targetOff + 48 + s * 2);
        ntfsMapImg.writeUInt16LE(usn, se);
      }
    };
    writeSmallMftRec(4096, 0, []);

    // MFT record 6 ($Bitmap) at offset 4096 + 6*1024 = 10240 with $FILE_NAME('$Bitmap') + non-resident $DATA
    const bmNameBytes = Buffer.from('$Bitmap', 'utf16le');
    const bmFnAttr = Buffer.alloc(Math.ceil((24 + 66 + bmNameBytes.length) / 8) * 8);
    bmFnAttr.writeUInt32LE(0x30, 0);
    bmFnAttr.writeUInt32LE(bmFnAttr.length, 4);
    bmFnAttr.writeUInt32LE(66 + bmNameBytes.length, 16);
    bmFnAttr.writeUInt16LE(24, 20);
    bmFnAttr.writeUInt32LE(5, 24);
    bmFnAttr[24 + 64] = '$Bitmap'.length;
    bmFnAttr[24 + 65] = 3;
    bmNameBytes.copy(bmFnAttr, 24 + 66);

    const bmDataAttr = Buffer.alloc(80);
    bmDataAttr.writeUInt32LE(0x80, 0);
    bmDataAttr.writeUInt32LE(80, 4);
    bmDataAttr[8] = 1; // non-resident
    bmDataAttr.writeUInt16LE(64, 32); // mapping pairs offset
    bmDataAttr.writeBigUInt64LE(1536n, 48); // real size = 1536 B (3 sectors)
    bmDataAttr[64] = 0x11; // len=1, off=1
    bmDataAttr[65] = 2; // 2 clusters = 2048 B
    bmDataAttr[66] = 20; // LCN 20
    bmDataAttr[67] = 0x00;

    writeSmallMftRec(4096 + 6 * 1024, 6, [bmFnAttr, bmDataAttr]);

    const ntfsMapPath = path.join(tmpDir, 'ntfs_eio.img');
    fs.writeFileSync(ntfsMapPath, ntfsMapImg);
    const eioFd = fs.openSync(ntfsMapPath, 'r');
    const origReadSync = fs.readSync;
    const targetBadSectorOffset = 20 * 1024 + 512; // middle sector of $Bitmap!
    fs.readSync = ((fdArg: number, buf: Buffer, off: number, len: number, pos: number) => {
      if (fdArg === eioFd && pos !== null && pos <= targetBadSectorOffset && pos + len > targetBadSectorOffset) {
        const err = new Error('Simulated EIO on $Bitmap') as NodeJS.ErrnoException;
        err.code = 'EIO';
        throw err;
      }
      return origReadSync.call(fs, fdArg, buf, off, len, pos);
    }) as typeof fs.readSync;
    try {
      const bmRes = loadNtfsBitmapsOnly(
        eioFd,
        [{ fsType: 'NTFS', volStart: 0, volEnd: ntfsMapImg.length, clusterBytes: 1024, sectorSize: 512, mftLcn: 4, mftRecSize: 1024 }],
        ntfsMapImg.length,
      );
      const bmBuf = bmRes.bitmapByVol.get(0);
      assert.ok(bmBuf);
      assert.equal(bmBuf.hadReadError, true);
      assert.equal((bmBuf.sectorValidity[0] & (1 << 1)) === 0, true);
      assert.ok(bmRes.warnings.length > 0);
      // Sector 1 of $Bitmap covers bytes 512..1023 -> clusters 4096..8191; cluster 4096 must NOT be marked verified free!
      const ntfsBmList = [{
        volStart: 0,
        volEnd: ntfsMapImg.length,
        clusterBytes: 1024,
        bitmap: bmBuf,
        sectorValidity: bmBuf.sectorValidity,
      }];
      const rangeCheck = checkRangeAllocation(4096 * 1024, 512, true, ntfsBmList);
      assert.equal(rangeCheck.allVerified, false);
    } finally {
      fs.readSync = origReadSync;
      fs.closeSync(eioFd);
    }

    // 4: checkRangeAllocation rejects multi-cluster file whose starting cluster is free (0) but second cluster is allocated (1)
    const synthBitmap = Buffer.from([0b00000010]); // cluster 0 free, cluster 1 allocated!
    const synthMap = [{
      fsType: 'FAT32',
      volStart: 0,
      volEnd: 16 * 4096,
      dataStart: 0,
      clusterBytes: 4096,
      bitmap: synthBitmap,
      sectorValidity: Buffer.from([1]),
    }];
    assert.deepEqual(checkRangeAllocation(0, 2048, true, synthMap), { anyAllocated: false, allVerified: true });
    assert.deepEqual(checkRangeAllocation(0, 6000, true, synthMap), { anyAllocated: true, allVerified: false });

    // Verify FAT32 & exFAT bitmap readers extract real bitmaps
    const fatPath = path.join(tmpDir, 'fat32_bm.img');
    const fatImg = Buffer.alloc(64 * 1024);
    fatImg[0] = 0xeb; fatImg[1] = 0x58; fatImg[2] = 0x90;
    fatImg.writeUInt16LE(512, 11);
    fatImg[13] = 2; // 1024 B cluster
    fatImg.writeUInt16LE(8, 14); // reserved sectors = 8
    fatImg[16] = 1; // 1 FAT
    fatImg.writeUInt32LE(128, 32); // total sectors
    fatImg.writeUInt32LE(4, 36); // FAT size = 4 sectors -> data starts at sector 12 (6144 B)
    fatImg.write('FAT32   ', 82, 'ascii');
    fatImg[510] = 0x55; fatImg[511] = 0xaa;
    // FAT[2] at sector 8 * 512 + 8 = allocated, FAT[3] = free (0)
    fatImg.writeUInt32LE(0x0ffffff8, 8 * 512);
    fatImg.writeUInt32LE(0x0fffffff, 8 * 512 + 4);
    fatImg.writeUInt32LE(0x0fffffff, 8 * 512 + 8); // cluster 2 allocated!
    fs.writeFileSync(fatPath, fatImg);
    const fatFd = fs.openSync(fatPath, 'r');
    try {
      const fatBmRes = readFat32BitmapOnly(
        fatFd,
        [{ volStart: 0, volEnd: fatImg.length, sectorSize: 512, clusterBytes: 1024, bootBuf: fatImg.subarray(0, 512) }],
        fatImg.length,
        512,
      );
      assert.equal(fatBmRes.bitmaps.length, 1);
      assert.equal(checkRangeAllocation(12 * 512, 512, true, fatBmRes.bitmaps).anyAllocated, true); // cluster 2 allocated
      assert.equal(checkRangeAllocation(12 * 512 + 1024, 512, true, fatBmRes.bitmaps).anyAllocated, false); // cluster 3 free
    } finally {
      fs.closeSync(fatFd);
    }

    const exfatPath = path.join(tmpDir, 'exfat_bm.img');
    const exfatImg = Buffer.alloc(64 * 1024);
    exfatImg[0] = 0xeb; exfatImg[1] = 0x76; exfatImg[2] = 0x90;
    exfatImg.write('EXFAT   ', 3, 'ascii');
    exfatImg.writeBigUInt64LE(128n, 72);
    exfatImg.writeUInt32LE(16, 88); // clusterHeapOffset = sector 16 (8192 B)
    exfatImg.writeUInt32LE(2, 96); // rootDirFirstCluster = 2
    exfatImg[108] = 9; // 512 B sector
    exfatImg[109] = 1; // 2 sectors/cluster = 1024 B cluster
    exfatImg[510] = 0x55; exfatImg[511] = 0xaa;
    // Root directory entry type 0x81 (Allocation Bitmap) at cluster 2 (offset 8192)
    exfatImg[8192] = 0x81;
    exfatImg.writeUInt32LE(3, 8192 + 20); // bitmap at cluster 3 (offset 9216)
    exfatImg.writeBigUInt64LE(8n, 8192 + 24);
    exfatImg[9216] = 0b00000011; // clusters 2 & 3 allocated, cluster 4 free
    fs.writeFileSync(exfatPath, exfatImg);
    const exfatFd = fs.openSync(exfatPath, 'r');
    try {
      const exBmRes = readExfatBitmapOnly(
        exfatFd,
        [{ volStart: 0, volEnd: exfatImg.length, sectorSize: 512, clusterBytes: 1024, heapOffset: 8192, rootDirOffset: 8192 }],
        exfatImg.length,
        512,
      );
      assert.equal(exBmRes.bitmaps.length, 1);
      assert.equal(checkRangeAllocation(8192 + 1024, 512, true, exBmRes.bitmaps).anyAllocated, true); // cluster 3 allocated
      assert.equal(checkRangeAllocation(8192 + 2048, 512, true, exBmRes.bitmaps).anyAllocated, false); // cluster 4 free
    } finally {
      fs.closeSync(exfatFd);
    }

    // 5 + 6 + 8 + 15: incomplete run list, short memory payload, bad-sector partial reporting & zero-fill NOT verified
    const srcPath = path.join(tmpDir, 'export_src.bin');
    const srcBuf = Buffer.alloc(70 * 1024, 0x41);
    fs.writeFileSync(srcPath, srcBuf);
    const outDir = path.join(tmpDir, 'export_out');
    fs.mkdirSync(outDir);

    const incompleteRunsRes = await recoverFilesImpl({
      targetRoot: outDir,
      items: [
        {
          filename: 'incomplete.bin',
          folder: 'Docs',
          sourceKind: 'native-runs',
          devicePath: srcPath,
          offset: 0,
          size: 2048,
          runs: [{ offset: 0, length: 512 }],
          extension: 'bin',
          repairIfTruncated: false,
        },
      ],
    });
    assert.equal(incompleteRunsRes.savedCount, 0);
    assert.ok(/Incomplete.*run list/i.test(incompleteRunsRes.failures[0].reason));

    const shortMemRes = await recoverFilesImpl({
      targetRoot: outDir,
      items: [
        {
          filename: 'shortmem.bin',
          folder: 'Docs',
          sourceKind: 'memory',
          offset: 0,
          size: 2048,
          memoryBytes: new Uint8Array(512).fill(0x42),
          extension: 'bin',
          repairIfTruncated: false,
        },
      ],
    });
    assert.equal(shortMemRes.savedCount, 0);
    assert.ok(shortMemRes.failures[0].reason.includes('Short memory payload'));

    // Memory repair with keepOriginalOnRepair preserves _original (#15)
    const truncPngMem = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature (8)
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR header (len=13)
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, // 1x1 RGB (13)
      0x90, 0x77, 0x53, 0xde, // IHDR CRC (4)
      0x00, 0x00, 0x00, 0x10, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, // truncated IDAT without IEND
    ]);
    const memRepRes = await recoverFilesImpl({
      targetRoot: outDir,
      keepOriginalOnRepair: true,
      items: [
        {
          filename: 'pic.png',
          folder: 'Pictures',
          sourceKind: 'memory',
          offset: 0,
          size: truncPngMem.length,
          memoryBytes: new Uint8Array(truncPngMem),
          extension: 'png',
          repairIfTruncated: true,
        },
      ],
    });
    assert.equal(memRepRes.savedCount, 1);
    assert.equal(memRepRes.repairedCount, 1);
    assert.equal(memRepRes.originalKeptCount, 1);
    assert.ok(fs.existsSync(path.join(outDir, 'Pictures', 'pic_original.png')));

    // Bad sector past 64 KiB -> savedCount=1, partialCount=1, verifiedCount=0, audit log says PARTIAL_BAD_SECTORS (#8)
    const head64Crc = computeCrc32(new Uint8Array(srcBuf.subarray(0, 65536)));
    const fdSrc = fs.openSync(srcPath, 'r');
    const origOpen = fs.openSync;
    const origRead2 = fs.readSync;
    let patchedBadFd = -1;
    fs.openSync = ((p: fs.PathLike, flags: fs.OpenMode) => {
      const f = origOpen.call(fs, p, flags);
      if (String(p) === srcPath && flags === 'r') patchedBadFd = f;
      return f;
    }) as typeof fs.openSync;
    fs.readSync = ((fdArg: number, buf: Buffer, off: number, len: number, pos: number) => {
      if (fdArg === patchedBadFd && pos !== null && pos <= 66048 && pos + len > 66048) {
        const err = new Error('Simulated EIO after 64K') as NodeJS.ErrnoException;
        err.code = 'EIO';
        throw err;
      }
      return origRead2.call(fs, fdArg, buf, off, len, pos);
    }) as typeof fs.readSync;
    try {
      const detailed = readDiskBytesDetailedFromFdSync(fdSrc, 0, srcBuf.length, 512);
      assert.equal(detailed.shortRead, false);

      const partialExportRes = await recoverFilesImpl({
        targetRoot: outDir,
        items: [
          {
            filename: 'bad65k.bin',
            folder: 'Docs',
            sourceKind: 'native-device',
            devicePath: srcPath,
            offset: 0,
            size: srcBuf.length,
            discoveryCrc32: head64Crc,
            extension: 'bin',
            repairIfTruncated: false,
          },
        ],
      });
      assert.equal(partialExportRes.savedCount, 1);
      assert.equal(partialExportRes.partialCount, 1);
      assert.equal(partialExportRes.verifiedCount, 0);
      assert.ok(partialExportRes.failures.some((f: { reason: string }) => f.reason.includes('zero-filled')));
      const reportTxt = fs.readFileSync(partialExportRes.reportPath, 'utf8');
      assert.ok(reportTxt.includes('PARTIAL_BAD_SECTORS'));
      assert.ok(reportTxt.includes('HEAD64K_CRC_MATCH_PARTIAL'));
    } finally {
      fs.openSync = origOpen;
      fs.readSync = origRead2;
      fs.closeSync(fdSrc);
    }

    // 7: Cross-letter same PhysicalDrive block (\\\\.\\C: source vs D:\\RecoveryOut sharing PhysicalDrive0)
    const crossLetter = await checkSameSourcePaths({
      targetPath: 'D:\\RecoveryOut',
      sourcePaths: ['\\\\.\\C:'],
      platform: 'win32',
      resolveBackingDriveFn: async (dl: string) => {
        if (dl === 'C' || dl === 'D') return { devicePath: '\\\\.\\PhysicalDrive0' };
        return null;
      },
    });
    assert.equal(crossLetter.blocked, true);

    // 9: VSS snapshot sorting + multi-version retention (#9)
    const vssEntries: Array<Record<string, unknown>> = [];
    await scanVssSnapshotsForPrefix('Users\\Alice', new Set<string>(), vssEntries, 50, {
      platform: 'win32',
      driveLetter: 'C',
      volLetterByGuid: new Map([['\\\\?\\volume{vol-guid-1}', 'C:']]),
      runPowerShellJsonFn: async () => [
        { DeviceObject: '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1', VolumeName: '\\\\?\\Volume{vol-guid-1}\\', InstallDate: '20261101120000' },
        { DeviceObject: '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy2', VolumeName: '\\\\?\\Volume{vol-guid-1}\\', InstallDate: '20261102120000' },
      ],
      walkFolderEntriesFn: (snapDir: string, tempOut: Array<Record<string, unknown>>) => {
        if (snapDir.includes('ShadowCopy1')) {
          tempOut.push({ filename: 'notes.txt', relPath: 'notes.txt', devicePath: path.join(snapDir, 'notes.txt'), size: 100, modifiedAt: 1000 });
        } else {
          tempOut.push({ filename: 'notes.txt', relPath: 'notes.txt', devicePath: path.join(snapDir, 'notes.txt'), size: 220, modifiedAt: 2000 });
        }
      },
    });
    assert.equal(vssEntries.length, 2);

    // 14: writeMbrPartitionTable rejects > 4 partitions, out-of-bounds LBA, and overlapping partitions
    const mbrImg = new Uint8Array(64 * 512);
    assert.throws(
      () =>
        writeMbrPartitionTable(mbrImg, [
          { id: '1', index: 1, name: 'p1', typeHex: '0x07', typeName: 'NTFS', bootable: false, status: 'Primary', startLba: 2, endLba: 5, sectors: 4, startOffset: 1024, sizeBytes: 2048 },
          { id: '2', index: 2, name: 'p2', typeHex: '0x07', typeName: 'NTFS', bootable: false, status: 'Primary', startLba: 6, endLba: 9, sectors: 4, startOffset: 3072, sizeBytes: 2048 },
          { id: '3', index: 3, name: 'p3', typeHex: '0x07', typeName: 'NTFS', bootable: false, status: 'Primary', startLba: 10, endLba: 13, sectors: 4, startOffset: 5120, sizeBytes: 2048 },
          { id: '4', index: 4, name: 'p4', typeHex: '0x07', typeName: 'NTFS', bootable: false, status: 'Primary', startLba: 14, endLba: 17, sectors: 4, startOffset: 7168, sizeBytes: 2048 },
          { id: '5', index: 5, name: 'p5', typeHex: '0x07', typeName: 'NTFS', bootable: false, status: 'Primary', startLba: 18, endLba: 21, sectors: 4, startOffset: 9216, sizeBytes: 2048 },
        ]),
      /at most 4/i,
    );
    assert.throws(
      () =>
        writeMbrPartitionTable(mbrImg, [
          { id: '1', index: 1, name: 'p1', typeHex: '0x07', typeName: 'NTFS', bootable: false, status: 'Primary', startLba: 10, endLba: 25, sectors: 16, startOffset: 5120, sizeBytes: 8192 },
          { id: '2', index: 2, name: 'p2', typeHex: '0x07', typeName: 'NTFS', bootable: false, status: 'Primary', startLba: 20, endLba: 35, sectors: 16, startOffset: 10240, sizeBytes: 8192 },
        ]),
      /overlap/i,
    );
    assert.throws(
      () =>
        writeMbrPartitionTable(mbrImg, [
          { id: '1', index: 1, name: 'p1', typeHex: '0x07', typeName: 'NTFS', bootable: false, status: 'Primary', startLba: 50, endLba: 89, sectors: 40, startOffset: 25600, sizeBytes: 20480 },
        ]),
      /exceeds/i,
    );

    // 17: CSV exports Unknown when isDeleted === undefined
    const csvOut = buildCsvReport(
      [
        {
          id: 'u1',
          filename: 'carved.jpg',
          extension: 'jpg',
          family: 'Pictures',
          mimeType: 'image/jpeg',
          size: 512,
          calculatedSize: 512,
          status: 'OK',
          sourceKind: 'carved',
          isDeleted: undefined,
          partitionId: 'p1',
          partitionName: 'Reconstructed',
          offset: 0,
          sector: 0,
          matchedOffset: 0,
          matchedLength: 4,
          metadata: {},
          description: 'JPEG',
          data: new Uint8Array(0),
          recoveryChance: 80,
          recoveryTier: 'medium',
          recoveryReason: 'Test',
        },
      ],
      'TestDisk',
    );
    assert.ok(csvOut.includes(',Unknown,'), `Expected Unknown in CSV, got: ${csvOut}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});








