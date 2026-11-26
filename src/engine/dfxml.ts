import { ExplorerFileItem } from './explorerTypes';

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generates a DFXML (Digital Forensics XML) report compatible with digler & forensic pipelines.
 */
export function buildDfxmlReport(params: {
  diskName: string;
  diskSizeBytes: number;
  items: ExplorerFileItem[];
}): string {
  const { diskName, diskSizeBytes, items } = params;
  const nowIso = new Date().toISOString();

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<dfxml version="1.2" xmlns="http://www.forensicswiki.org/wiki/Category:Digital_Forensics_XML" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    '  <metadata>',
    '    <dc:type>Recovery &amp; Carving Report</dc:type>',
    '  </metadata>',
    '  <creator>',
    '    <program>Disk &amp; Partition Recovery Explorer</program>',
    `    <execution_environment><start_time>${nowIso}</start_time></execution_environment>`,
    '  </creator>',
    '  <source>',
    `    <image_filename>${escapeXml(diskName)}</image_filename>`,
    `    <image_size>${diskSizeBytes}</image_size>`,
    '  </source>',
    `  <volume offset="0">`,
  ];

  for (const item of items) {
    lines.push('    <fileobject>');
    lines.push(`      <filename>${escapeXml(item.originalPath || item.filename)}</filename>`);
    lines.push(`      <partition>${escapeXml(item.partitionName)}</partition>`);
    lines.push(`      <filesize>${item.size}</filesize>`);
    if (typeof item.modifiedAt === 'number' && Number.isFinite(item.modifiedAt) && item.modifiedAt > 0) {
      lines.push(`      <mtime>${new Date(item.modifiedAt).toISOString()}</mtime>`);
    }
    lines.push(`      <meta_type>${escapeXml(item.sourceKind)}</meta_type>`);
    lines.push(`      <libmagic>${escapeXml(item.description)}</libmagic>`);
    if (item.metadata.camera) {
      lines.push(`      <camera_model>${escapeXml(item.metadata.camera)}</camera_model>`);
    }
    lines.push(
      `      <recovery_likelihood tier="${item.recoveryTier}">${item.recoveryChance}</recovery_likelihood>`,
    );
    if (item.sourceRef?.runs && item.sourceRef.runs.length > 0) {
      lines.push('      <byte_runs>');
      let fileOffset = 0;
      for (const r of item.sourceRef.runs) {
        if (r.offset < 0) {
          lines.push(`        <byte_run file_offset="${fileOffset}" fill="0" len="${r.length}" />`);
        } else {
          lines.push(`        <byte_run file_offset="${fileOffset}" fs_offset="${r.offset}" len="${r.length}" />`);
        }
        fileOffset += r.length;
      }
      lines.push('      </byte_runs>');
    } else if (item.offset > 0 || item.sourceKind === 'carved') {
      lines.push('      <byte_runs>');
      lines.push(
        `        <byte_run file_offset="0" img_offset="${item.offset}" len="${item.size}" />`,
      );
      lines.push('      </byte_runs>');
    }
    lines.push('    </fileobject>');
  }

  lines.push('  </volume>');
  lines.push('</dfxml>');
  return lines.join('\n');
}
