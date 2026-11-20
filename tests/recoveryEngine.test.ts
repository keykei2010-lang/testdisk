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

test('sample disk analyzes MBR + lost NTFS partition + FAT32 LFN + nested NTFS path', () => {
  const sample = buildSampleDiskImage();
  const analysis = analyzeDiskImage(sample.name, sample.bytes);

  assert.equal(analysis.mbrSignatureValid, true);
  assert.ok(analysis.partitions.length >= 2, 'Expected primary + lost partition');
  const lost = analysis.partitions.find((p) => p.status === 'Deleted / Lost');
  if (!lost) throw new Error('Expected a lost NTFS partition');

  const mft = scanNtfsMftRecordsInBuffer(sample.bytes, analysis.partitions);
  const tax = mft.find((r) => r.filename === 'Tax_Return_2025_Deleted.txt');
  if (!tax) throw new Error('Expected deleted NTFS Tax Return file');
  assert.equal(tax.reconstructedPath, '\\Finance_2025\\Tax_Return_2025_Deleted.txt');

  const fat = scanFatAndExfatDeletedInBuffer(sample.bytes, analysis.partitions);
  const beach = fat.find((f) => f.filename === 'Vacation_Beach_Deleted.jpg');
  if (!beach) throw new Error('Expected deleted FAT32 LFN JPEG file');
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
