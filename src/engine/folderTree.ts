import { ExplorerFileItem, extractFolderSegments } from './explorerTypes';

export interface FolderTreeNode {
  name: string;
  folderPath: string;
  partitionId: string;
  fileCount: number;
  children: FolderTreeNode[];
}

interface MutableFolderNode {
  name: string;
  folderPath: string;
  partitionId: string;
  fileCount: number;
  childMap: Map<string, MutableFolderNode>;
}

/**
 * Builds a deterministic hierarchical directory tree from reconstructed file paths
 * (NTFS $MFT, FAT32, exFAT, $Recycle.Bin, or Scanned Folder) for a given partition.
 */
export function buildFolderTreeForPartition(
  items: ExplorerFileItem[],
  partitionId: string,
): FolderTreeNode[] {
  const roots = new Map<string, MutableFolderNode>();

  for (const item of items) {
    if (item.partitionId !== partitionId) continue;
    const segments = extractFolderSegments(item.originalPath);
    if (segments.length === 0) continue;

    let currentMap = roots;
    let builtPath = '';
    for (const seg of segments) {
      builtPath = builtPath ? `${builtPath}/${seg}` : seg;
      let node = currentMap.get(seg);
      if (!node) {
        node = {
          name: seg,
          folderPath: builtPath,
          partitionId,
          fileCount: 0,
          childMap: new Map(),
        };
        currentMap.set(seg, node);
      }
      node.fileCount++;
      currentMap = node.childMap;
    }
  }

  const freeze = (map: Map<string, MutableFolderNode>): FolderTreeNode[] =>
    Array.from(map.values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((n) => ({
        name: n.name,
        folderPath: n.folderPath,
        partitionId: n.partitionId,
        fileCount: n.fileCount,
        children: freeze(n.childMap),
      }));

  return freeze(roots);
}
