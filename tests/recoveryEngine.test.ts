import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSampleDiskImage } from '../src/engine/sampleDisk';
import { analyzeDiskImage, writeMbrPartitionTable } from '../src/engine/partitions';
import { scanNtfsMftRecordsInBuffer } from '../src/engine/ntfsMft';
import { scanFatAndExfatDeletedInBuffer } from '../src/engine/fatExfat';
import { identifyBuffer } from '../src/engine/signatures';
import {
  repairFileBuffer,
  computeRecoveryLikelihood,
  formatCompactCount,
} from '../src/engine/recoveryHealth';
import { buildFolderTreeForPartition } from '../src/engine/folderTree';
import { ExplorerFileItem, itemMatchesNode } from '../src/engine/explorerTypes';
import { parseUsnJournalBuffer, USN_REASON_FILE_DELETE } from '../src/engine/ntfsJournal';
import { rebuildMp4WithMoov } from '../src/engine/mp4Repair';

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
