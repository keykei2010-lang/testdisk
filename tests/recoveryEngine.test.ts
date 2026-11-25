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
  repairAviBuffer,
  repairFileBuffer,
  repairJpegBuffer,
  repairPngBuffer,
  resolvePreferredExtension,
  runRecoverySelfTest,
} from '../src/engine/recoveryHealth';
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




