import { computeCrc32 } from './crc32';

export type PartitionArch = 'Intel/MBR' | 'EFI GPT' | 'None (Unpartitioned)';
export type PartitionStatus = 'Active' | 'Primary' | 'Logical' | 'Deleted / Lost';

export interface BootSectorProbe {
  filesystem: string;
  label: string;
  oemOrVersion: string;
  bytesPerSector: number;
  sectorsPerCluster: number;
  totalSectors: number;
  details: string;
  encrypted?: 'BitLocker';
}

export interface PartitionEntry {
  id: string;
  order: number | null;
  bootable: boolean;
  status: PartitionStatus;
  typeCode: string;
  typeName: string;
  startLba: number;
  endLba: number;
  sectors: number;
  sizeBytes: number;
  startOffset: number;
  name: string;
  guid?: string;
  detectedFs?: BootSectorProbe;
  selectedForRestore: boolean;
}

export interface GptHeaderInfo {
  signatureValid: boolean;
  revision: string;
  headerSize: number;
  headerCrcStored: number;
  headerCrcComputed: number;
  headerCrcValid: boolean;
  currentLba: number;
  backupLba: number;
  firstUsableLba: number;
  lastUsableLba: number;
  diskGuid: string;
  partitionEntriesLba: number;
  numPartitionEntries: number;
  sizeOfPartitionEntry: number;
  entriesCrcStored: number;
  entriesCrcComputed: number;
  entriesCrcValid: boolean;
}

export interface DiskAnalysisResult {
  diskName: string;
  diskSizeBytes: number;
  sectorSize: number;
  totalSectors: number;
  arch: PartitionArch;
  mbrSignatureValid: boolean;
  mbrDiskSignature: string;
  gptHeader?: GptHeaderInfo;
  partitions: PartitionEntry[];
  warnings: string[];
}

export const MBR_TYPE_NAMES: Record<number, string> = {
  0x00: 'Empty',
  0x01: 'FAT12',
  0x04: 'FAT16 <32M',
  0x05: 'Extended',
  0x06: 'FAT16',
  0x07: 'HPFS - NTFS / exFAT',
  0x0b: 'FAT32',
  0x0c: 'FAT32 LBA',
  0x0e: 'FAT16 LBA',
  0x0f: 'Extended LBA',
  0x11: 'Hidden FAT12',
  0x14: 'Hidden FAT16 <32M',
  0x16: 'Hidden FAT16',
  0x17: 'Hidden HPFS/NTFS',
  0x1b: 'Hidden FAT32',
  0x1c: 'Hidden FAT32 LBA',
  0x82: 'Linux Swap',
  0x83: 'Linux',
  0x85: 'Linux Extended',
  0x8e: 'Linux LVM',
  0xa5: 'FreeBSD',
  0xa6: 'OpenBSD',
  0xa9: 'NetBSD',
  0xaf: 'HFS / HFS+',
  0xbe: 'Solaris Boot',
  0xbf: 'Solaris',
  0xeb: 'BeOS BFS',
  0xee: 'EFI GPT Protective',
  0xef: 'EFI System (FAT)',
  0xfb: 'VMware VMFS',
  0xfd: 'Linux RAID',
};

// Exact GUID map from TestDisk common.h & partgpt.c
export const GPT_TYPE_NAMES: Record<string, { name: string; mbrFallback: number }> = {
  'C12A7328-F81F-11D2-BA4B-00A0C93EC93B': { name: 'EFI System', mbrFallback: 0xef },
  'BC13C2FF-59E6-4262-A352-B275FD6F7172': { name: 'Extended Boot', mbrFallback: 0x83 },
  '024DEE41-33E7-11D3-9D69-0008C781F39F': { name: 'MBR Scheme', mbrFallback: 0x00 },
  'EBD0A0A2-B9E5-4433-87C0-68B6B72699C7': { name: 'MS Data', mbrFallback: 0x07 },
  'E3C9E316-0B5C-4DB8-817D-F92DF00215AE': { name: 'MS Reserved', mbrFallback: 0x0c },
  'DE94BBA4-06D1-4D40-A16A-BFD50179D6AC': { name: 'Windows Recovery Env', mbrFallback: 0x27 },
  '5808C8AA-7E8F-42E0-85D2-E1E90434CFB3': { name: 'MS LDM MetaData', mbrFallback: 0x42 },
  'AF9B60A0-1431-4F62-BC68-3311714A69AD': { name: 'MS LDM Data', mbrFallback: 0x42 },
  '0FC63DAF-8483-4772-8E79-3D69D8477DE4': { name: 'Linux Filesystem', mbrFallback: 0x83 },
  '933AC7E1-2EB4-4F13-B844-0E14E2AEF915': { name: 'Linux Home', mbrFallback: 0x83 },
  '0657FD6D-A4AB-43C4-84E5-0933C84B4F4F': { name: 'Linux Swap', mbrFallback: 0x82 },
  'E6D6D379-F507-44C2-A23C-238F2A3DF928': { name: 'Linux LVM', mbrFallback: 0x8e },
  'A19D880F-05FC-4D3B-A006-743F0F84911E': { name: 'Linux RAID', mbrFallback: 0xfd },
  '7C3457EF-0000-11AA-AA11-00306543ECAC': { name: 'Apple APFS', mbrFallback: 0xaf },
  '48465300-0000-11AA-AA11-00306543ECAC': { name: 'Mac HFS+', mbrFallback: 0xaf },
  '516E7CB4-6ECF-11D6-8FF8-00022D09712B': { name: 'FreeBSD', mbrFallback: 0xa5 },
  '516E7CB6-6ECF-11D6-8FF8-00022D09712B': { name: 'FreeBSD UFS', mbrFallback: 0xa5 },
  '516E7CBA-6ECF-11D6-8FF8-00022D09712B': { name: 'FreeBSD ZFS', mbrFallback: 0xa5 },
};

function u16le(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8)) >>> 0;
}

function u32le(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function u64le(b: Uint8Array, o: number): number {
  const lo = u32le(b, o);
  const hi = u32le(b, o + 4);
  return hi * 4294967296 + lo;
}

function ascii(b: Uint8Array, o: number, len: number): string {
  let s = '';
  for (let i = 0; i < len && o + i < b.length; i++) {
    const c = b[o + i];
    s += c >= 32 && c <= 126 ? String.fromCharCode(c) : ' ';
  }
  return s;
}

function formatGuid(b: Uint8Array, o: number): string {
  const d1 = u32le(b, o).toString(16).padStart(8, '0').toUpperCase();
  const d2 = u16le(b, o + 4).toString(16).padStart(4, '0').toUpperCase();
  const d3 = u16le(b, o + 6).toString(16).padStart(4, '0').toUpperCase();
  const d4 = Array.from(b.subarray(o + 8, o + 10))
    .map((x) => x.toString(16).padStart(2, '0').toUpperCase())
    .join('');
  const d5 = Array.from(b.subarray(o + 10, o + 16))
    .map((x) => x.toString(16).padStart(2, '0').toUpperCase())
    .join('');
  return `${d1}-${d2}-${d3}-${d4}-${d5}`;
}

function decodeUtf16Le(b: Uint8Array, o: number, maxBytes: number): string {
  let out = '';
  for (let i = 0; i + 1 < maxBytes && o + i + 1 < b.length; i += 2) {
    const code = u16le(b, o + i);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out.trim();
}

/**
 * Probes a byte offset (sector boundary) for known filesystem boot sectors or superblocks.
 */
export function probeFilesystemAtOffset(disk: Uint8Array, offset: number): BootSectorProbe | null {
  if (offset + 512 > disk.length) return null;

  // 0. BitLocker Encrypted Volume (-FVE-FS-)
  if (
    disk[offset + 510] === 0x55 &&
    disk[offset + 511] === 0xaa &&
    ascii(disk, offset + 3, 8) === '-FVE-FS-'
  ) {
    const bps = u16le(disk, offset + 11) || 512;
    const spc = disk[offset + 13] || 8;
    const totalSectors = u64le(disk, offset + 40);
    return {
      filesystem: 'BitLocker',
      label: 'BitLocker Volume (Encrypted)',
      oemOrVersion: '-FVE-FS-',
      bytesPerSector: bps,
      sectorsPerCluster: spc,
      totalSectors: totalSectors > 0 ? totalSectors + 1 : 0,
      details: 'Windows BitLocker FVE encrypted partition — unlock required before file carving',
      encrypted: 'BitLocker',
    };
  }

  // 1. NTFS Boot Sector
  if (
    disk[offset + 510] === 0x55 &&
    disk[offset + 511] === 0xaa &&
    ascii(disk, offset + 3, 8) === 'NTFS    '
  ) {
    const bps = u16le(disk, offset + 11);
    const spc = disk[offset + 13];
    const totalSectors = u64le(disk, offset + 40);
    const mftCluster = u64le(disk, offset + 48);
    if (bps >= 512 && bps <= 4096 && spc > 0) {
      return {
        filesystem: 'NTFS',
        label: 'NTFS Volume',
        oemOrVersion: 'NTFS    ',
        bytesPerSector: bps,
        sectorsPerCluster: spc,
        totalSectors: totalSectors > 0 ? totalSectors + 1 : 0,
        details: `Cluster ${spc * bps} B · $MFT @ cluster ${mftCluster}`,
      };
    }
  }

  // 2. exFAT Boot Sector
  if (
    disk[offset + 510] === 0x55 &&
    disk[offset + 511] === 0xaa &&
    ascii(disk, offset + 3, 8) === 'EXFAT   '
  ) {
    const volLen = u64le(disk, offset + 72);
    const bps = 1 << disk[offset + 108];
    const spc = 1 << disk[offset + 109];
    return {
      filesystem: 'exFAT',
      label: 'exFAT Volume',
      oemOrVersion: 'EXFAT   ',
      bytesPerSector: bps,
      sectorsPerCluster: spc,
      totalSectors: volLen,
      details: `Cluster ${bps * spc} B`,
    };
  }

  // 3. FAT32 / FAT16 / FAT12 BPB
  if (
    disk[offset + 510] === 0x55 &&
    disk[offset + 511] === 0xaa &&
    (disk[offset] === 0xeb || disk[offset] === 0xe9)
  ) {
    const bps = u16le(disk, offset + 11);
    const spc = disk[offset + 13];
    const numFats = disk[offset + 16];
    const fatSz16 = u16le(disk, offset + 22);
    const tot16 = u16le(disk, offset + 19);
    const tot32 = u32le(disk, offset + 32);
    const totalSectors = tot16 > 0 ? tot16 : tot32;
    const sig32 = ascii(disk, offset + 82, 8).trim();
    const sig16 = ascii(disk, offset + 54, 8).trim();

    if ([512, 1024, 2048, 4096].includes(bps) && spc > 0 && numFats >= 1 && numFats <= 4 && totalSectors > 0) {
      if (fatSz16 === 0 && sig32.startsWith('FAT32')) {
        const label = ascii(disk, offset + 71, 11).trim() || 'FAT32';
        const oem = ascii(disk, offset + 3, 8).trim();
        return {
          filesystem: 'FAT32',
          label,
          oemOrVersion: oem || 'MSDOS5.0',
          bytesPerSector: bps,
          sectorsPerCluster: spc,
          totalSectors,
          details: `BPB FAT32 · Cluster ${bps * spc} B · OEM "${oem || 'MSDOS'}"`,
        };
      }
      if (sig16.startsWith('FAT16') || sig16.startsWith('FAT12') || sig16 === 'FAT') {
        const label = ascii(disk, offset + 43, 11).trim() || sig16;
        const oem = ascii(disk, offset + 3, 8).trim();
        return {
          filesystem: sig16.startsWith('FAT12') ? 'FAT12' : 'FAT16',
          label,
          oemOrVersion: oem || 'MSDOS5.0',
          bytesPerSector: bps,
          sectorsPerCluster: spc,
          totalSectors,
          details: `BPB ${sig16} · Cluster ${bps * spc} B`,
        };
      }
    }
  }

  // 4. Linux Ext2/Ext3/Ext4 Superblock (starts at partition offset + 1024)
  if (offset + 2048 <= disk.length) {
    const sb = offset + 1024;
    const magic = u16le(disk, sb + 0x38);
    if (magic === 0xef53) {
      const blocksCount = u32le(disk, sb + 0x04);
      const logBlockSize = u32le(disk, sb + 0x18);
      const blockSize = 1024 << Math.min(logBlockSize, 6);
      const compat = u32le(disk, sb + 0x5c);
      const incompat = u32le(disk, sb + 0x60);
      const hasJournal = (compat & 0x0004) !== 0;
      const hasExtents = (incompat & 0x0040) !== 0;
      const fsVer = hasExtents ? 'ext4' : hasJournal ? 'ext3' : 'ext2';
      const volName = ascii(disk, sb + 0x78, 16).replace(/\0/g, '').trim() || fsVer;
      const sectorsPerBlock = blockSize / 512;
      if (blocksCount > 0) {
        return {
          filesystem: fsVer,
          label: volName,
          oemOrVersion: `Linux ${fsVer}`,
          bytesPerSector: 512,
          sectorsPerCluster: sectorsPerBlock,
          totalSectors: blocksCount * sectorsPerBlock,
          details: `Superblock magic 0xEF53 · block ${blockSize} B · ${blocksCount} blocks`,
        };
      }
    }
  }

  return null;
}

export function analyzeDiskImage(diskName: string, disk: Uint8Array): DiskAnalysisResult {
  const sectorSize = 512;
  const totalSectors = Math.floor(disk.length / sectorSize);
  const warnings: string[] = [];

  if (disk.length < 512) {
    return {
      diskName,
      diskSizeBytes: disk.length,
      sectorSize,
      totalSectors,
      arch: 'None (Unpartitioned)',
      mbrSignatureValid: false,
      mbrDiskSignature: '0x00000000',
      partitions: [],
      warnings: ['Image is smaller than 512 bytes (1 sector).'],
    };
  }

  const mbrSigValid = disk[510] === 0x55 && disk[511] === 0xaa;
  const mbrDiskSig = `0x${u32le(disk, 0x1b8).toString(16).padStart(8, '0').toUpperCase()}`;

  // Check GPT Protective MBR (type 0xEE) or LBA 1 "EFI PART"
  let isGpt = false;
  let gptHeader: GptHeaderInfo | undefined;
  const mbrEntries: PartitionEntry[] = [];

  if (mbrSigValid) {
    for (let i = 0; i < 4; i++) {
      const off = 0x1be + i * 16;
      const bootInd = disk[off];
      const sysInd = disk[off + 4];
      const startLba = u32le(disk, off + 8);
      const sectors = u32le(disk, off + 12);
      if (sysInd === 0xee) {
        isGpt = true;
      }
      if (sysInd !== 0 && sectors > 0) {
        const detectedFs = probeFilesystemAtOffset(disk, startLba * sectorSize) ?? undefined;
        mbrEntries.push({
          id: `mbr-${i + 1}`,
          order: i + 1,
          bootable: bootInd === 0x80,
          status: bootInd === 0x80 ? 'Active' : 'Primary',
          typeCode: `0x${sysInd.toString(16).padStart(2, '0').toUpperCase()}`,
          typeName: MBR_TYPE_NAMES[sysInd] ?? 'Unknown',
          startLba,
          endLba: startLba + sectors - 1,
          sectors,
          sizeBytes: sectors * sectorSize,
          startOffset: startLba * sectorSize,
          name: detectedFs?.label || MBR_TYPE_NAMES[sysInd] || `Partition ${i + 1}`,
          detectedFs,
          selectedForRestore: true,
        });
      }
    }
  } else {
    warnings.push('Sector 0 does not end with 0x55AA MBR boot signature.');
  }

  const gptPartitions: PartitionEntry[] = [];
  if (disk.length >= 1024 && ascii(disk, 512, 8) === 'EFI PART') {
    isGpt = true;
    const revRaw = u32le(disk, 512 + 8);
    const revision = `${revRaw >>> 16}.${revRaw & 0xffff}`;
    const headerSize = u32le(disk, 512 + 12);
    const headerCrcStored = u32le(disk, 512 + 16);
    const headerCopy = disk.slice(512, 512 + Math.min(headerSize, 512));
    headerCopy[16] = 0;
    headerCopy[17] = 0;
    headerCopy[18] = 0;
    headerCopy[19] = 0;
    const headerCrcComputed = computeCrc32(headerCopy);

    const currentLba = u64le(disk, 512 + 24);
    const backupLba = u64le(disk, 512 + 32);
    const firstUsableLba = u64le(disk, 512 + 40);
    const lastUsableLba = u64le(disk, 512 + 48);
    const diskGuid = formatGuid(disk, 512 + 56);
    const partitionEntriesLba = u64le(disk, 512 + 72);
    const numPartitionEntries = u32le(disk, 512 + 80);
    const sizeOfPartitionEntry = u32le(disk, 512 + 84);
    const entriesCrcStored = u32le(disk, 512 + 88);

    const tableOffset = partitionEntriesLba * sectorSize;
    const tableByteLen = numPartitionEntries * sizeOfPartitionEntry;
    const entriesCrcComputed =
      tableOffset + tableByteLen <= disk.length
        ? computeCrc32(disk, tableOffset, tableByteLen)
        : 0;

    gptHeader = {
      signatureValid: true,
      revision,
      headerSize,
      headerCrcStored,
      headerCrcComputed,
      headerCrcValid: headerCrcStored === headerCrcComputed,
      currentLba,
      backupLba,
      firstUsableLba,
      lastUsableLba,
      diskGuid,
      partitionEntriesLba,
      numPartitionEntries,
      sizeOfPartitionEntry,
      entriesCrcStored,
      entriesCrcComputed,
      entriesCrcValid: entriesCrcStored === entriesCrcComputed,
    };

    if (!gptHeader.headerCrcValid) {
      warnings.push('GPT Header CRC32 mismatch — header may be corrupted.');
    }

    const maxScan = Math.min(numPartitionEntries, 128);
    for (let i = 0; i < maxScan; i++) {
      const eOff = tableOffset + i * sizeOfPartitionEntry;
      if (eOff + 128 > disk.length) break;
      const typeGuid = formatGuid(disk, eOff);
      if (typeGuid === '00000000-0000-0000-0000-000000000000') continue;
      const partGuid = formatGuid(disk, eOff + 16);
      const startLba = u64le(disk, eOff + 32);
      const endLba = u64le(disk, eOff + 40);
      const sectors = endLba >= startLba ? endLba - startLba + 1 : 0;
      const partName = decodeUtf16Le(disk, eOff + 56, 72);
      const mapped = GPT_TYPE_NAMES[typeGuid];
      const detectedFs = probeFilesystemAtOffset(disk, startLba * sectorSize) ?? undefined;

      gptPartitions.push({
        id: `gpt-${i + 1}`,
        order: i + 1,
        bootable: false,
        status: 'Primary',
        typeCode: typeGuid.slice(0, 8),
        typeName: mapped?.name ?? 'GPT Partition',
        startLba,
        endLba,
        sectors,
        sizeBytes: sectors * sectorSize,
        startOffset: startLba * sectorSize,
        name: partName || detectedFs?.label || mapped?.name || `GPT ${i + 1}`,
        guid: partGuid,
        detectedFs,
        selectedForRestore: true,
      });
    }
  }

  const basePartitions = isGpt && gptPartitions.length > 0 ? gptPartitions : mbrEntries;

  // TestDisk "Analyse" deep sector scan for deleted / unmapped filesystems
  const discoveredLost: PartitionEntry[] = [];
  for (let lba = 1; lba < totalSectors; lba++) {
    const offset = lba * sectorSize;
    const probe = probeFilesystemAtOffset(disk, offset);
    if (!probe) continue;

    // Check if this LBA matches an already-known partition start
    const alreadyKnown = basePartitions.some((p) => p.startLba === lba);
    if (!alreadyKnown) {
      const clampedSectors = Math.min(probe.totalSectors || 64, totalSectors - lba);
      const typeMap: Record<string, { code: string; name: string }> = {
        FAT32: { code: '0x0C', name: 'FAT32 LBA' },
        FAT16: { code: '0x06', name: 'FAT16' },
        FAT12: { code: '0x01', name: 'FAT12' },
        NTFS: { code: '0x07', name: 'HPFS - NTFS' },
        exFAT: { code: '0x07', name: 'exFAT' },
        ext2: { code: '0x83', name: 'Linux' },
        ext3: { code: '0x83', name: 'Linux' },
        ext4: { code: '0x83', name: 'Linux' },
      };
      const t = typeMap[probe.filesystem] ?? { code: '0x83', name: probe.filesystem };
      discoveredLost.push({
        id: `lost-${lba}`,
        order: null,
        bootable: false,
        status: 'Deleted / Lost',
        typeCode: t.code,
        typeName: t.name,
        startLba: lba,
        endLba: lba + clampedSectors - 1,
        sectors: clampedSectors,
        sizeBytes: clampedSectors * sectorSize,
        startOffset: offset,
        name: probe.label,
        detectedFs: probe,
        selectedForRestore: true,
      });
    }
  }

  const allPartitions = [...basePartitions, ...discoveredLost].sort(
    (a, b) => a.startLba - b.startLba,
  );

  if (discoveredLost.length > 0) {
    warnings.push(
      `Found ${discoveredLost.length} unmapped filesystem${discoveredLost.length > 1 ? 's' : ''} outside the active partition table (eligible for recovery).`,
    );
  }

  const bitlockerParts = allPartitions.filter((p) => p.detectedFs?.encrypted === 'BitLocker');
  if (bitlockerParts.length > 0) {
    warnings.push(
      `Detected ${bitlockerParts.length} BitLocker-encrypted volume (-FVE-FS-). Unlock the drive in Windows before scanning sectors.`,
    );
  }

  const arch: PartitionArch = isGpt
    ? 'EFI GPT'
    : mbrSigValid && mbrEntries.length > 0
      ? 'Intel/MBR'
      : mbrSigValid
        ? 'Intel/MBR'
        : 'None (Unpartitioned)';

  return {
    diskName,
    diskSizeBytes: disk.length,
    sectorSize,
    totalSectors,
    arch,
    mbrSignatureValid: mbrSigValid,
    mbrDiskSignature: mbrDiskSig,
    gptHeader,
    partitions: allPartitions,
    warnings,
  };
}

/**
 * Writes selected partitions (up to 4 primary) back into Sector 0 MBR (TestDisk "Write" equivalent)
 * and returns a patched Uint8Array copy ready for download or re-analysis.
 */
export function writeMbrPartitionTable(
  originalDisk: Uint8Array,
  selectedPartitions: PartitionEntry[],
): Uint8Array {
  const patched = originalDisk.slice();
  // Clear 4 MBR partition slots (0x1BE .. 0x1FD)
  for (let i = 0x1be; i < 0x1fe; i++) {
    patched[i] = 0;
  }

  const toWrite = selectedPartitions.slice(0, 4);
  const view = new DataView(patched.buffer);
  toWrite.forEach((part, idx) => {
    const off = 0x1be + idx * 16;
    const sysInd = parseInt(part.typeCode, 16) || 0x83;
    patched[off] = part.bootable ? 0x80 : 0x00;
    patched[off + 1] = 0xfe;
    patched[off + 2] = 0xff;
    patched[off + 3] = 0xff;
    patched[off + 4] = sysInd & 0xff;
    patched[off + 5] = 0xfe;
    patched[off + 6] = 0xff;
    patched[off + 7] = 0xff;
    view.setUint32(off + 8, part.startLba >>> 0, true);
    view.setUint32(off + 12, part.sectors >>> 0, true);
  });

  patched[510] = 0x55;
  patched[511] = 0xaa;
  return patched;
}
