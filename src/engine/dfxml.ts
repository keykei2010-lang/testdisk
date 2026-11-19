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
    '<dfxml version="1.2">',
    '  <metadata xmlns="http://www.forensicswiki.org/wiki/Category:Digital_Forensics_XML">',
    '    <dc:type>Recovery &amp; Carving Report</dc:type>',
    '  </metadata>',
    '  <creator>',
    '    <program>TestDisk &amp; PhotoRec Recovery Suite</program>',
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
    lines.push(`      <mtime>${new Date(item.modifiedAt).toISOString()}</mtime>`);
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
      for (const r of item.sourceRef.runs) {
        lines.push(`        <byte_run file_offset="0" fs_offset="${r.offset}" len="${r.length}" />`);
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
