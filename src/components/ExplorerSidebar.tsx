import React, { useMemo, useState } from 'react';
import {
  Archive,
  ChevronDown,
  ChevronRight,
  FileQuestion,
  FileText,
  Film,
  Folder,
  FolderSearch,
  HardDrive,
  Image as ImageIcon,
  Layers,
  Music,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { DiskAnalysisResult } from '../engine/partitions';
import { FileFamily } from '../engine/signatures';
import {
  ExplorerFileItem,
  SelectedTreeNode,
  TreeMode,
  itemMatchesNode,
  treeNodeKey,
} from '../engine/explorerTypes';
import { buildFolderTreeForPartition, FolderTreeNode } from '../engine/folderTree';
import { formatCompactCount } from '../engine/recoveryHealth';

interface ExplorerSidebarProps {
  treeMode: TreeMode;
  onChangeTreeMode: (mode: TreeMode) => void;
  selectedNode: SelectedTreeNode;
  onSelectNode: (node: SelectedTreeNode) => void;
  analysis: DiskAnalysisResult;
  allItems: ExplorerFileItem[];
  checkedIds: Set<string>;
  onToggleNodeCheck: (node: SelectedTreeNode, check: boolean) => void;
}

const FAMILY_ORDER: FileFamily[] = [
  'Pictures',
  'Videos',
  'Documents',
  'Audio',
  'Archives',
  'Others',
];

function FamilyIcon({ family }: { family: FileFamily }) {
  switch (family) {
    case 'Pictures':
      return <ImageIcon className="w-4 h-4 text-amber-400 shrink-0" />;
    case 'Videos':
      return <Film className="w-4 h-4 text-violet-400 shrink-0" />;
    case 'Documents':
      return <FileText className="w-4 h-4 text-sky-400 shrink-0" />;
    case 'Audio':
      return <Music className="w-4 h-4 text-rose-400 shrink-0" />;
    case 'Archives':
      return <Archive className="w-4 h-4 text-emerald-400 shrink-0" />;
    case 'Others':
      return <Layers className="w-4 h-4 text-slate-400 shrink-0" />;
  }
}

interface TriCheckboxProps {
  checked: boolean;
  indeterminate: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
}

const TriCheckbox: React.FC<TriCheckboxProps> = ({
  checked,
  indeterminate,
  disabled,
  onChange,
  label,
}) => {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
      aria-label={label}
      className="w-3.5 h-3.5 rounded-xs border-[#464E5E] bg-[#16181F] text-[#3A7AFE] focus:ring-[#3A7AFE] disabled:opacity-30 shrink-0 cursor-pointer"
    />
  );
};

interface FolderSubtreeProps {
  nodes: FolderTreeNode[];
  depth: number;
  selectedKey: string;
  expandedFolders: Set<string>;
  onToggleExpand: (key: string) => void;
  onSelectNode: (node: SelectedTreeNode) => void;
  getCheckState: (node: SelectedTreeNode) => {
    checked: boolean;
    indeterminate: boolean;
    count: number;
  };
  onToggleNodeCheck: (node: SelectedTreeNode, check: boolean) => void;
}

const FolderSubtree: React.FC<FolderSubtreeProps> = ({
  nodes,
  depth,
  selectedKey,
  expandedFolders,
  onToggleExpand,
  onSelectNode,
  getCheckState,
  onToggleNodeCheck,
}) => {
  return (
    <div className="space-y-0.5">
      {nodes.map((folder) => {
        const dirNode: SelectedTreeNode = {
          kind: 'folder-node',
          partitionId: folder.partitionId,
          folderPath: folder.folderPath,
        };
        const dirKey = treeNodeKey(dirNode);
        const isSel = selectedKey === dirKey;
        const isExpanded = expandedFolders.has(dirKey);
        const state = getCheckState(dirNode);
        const hasKids = folder.children.length > 0;

        return (
          <div key={dirKey}>
            <div
              onClick={() => onSelectNode(dirNode)}
              style={{ paddingLeft: `${depth * 14 + 6}px` }}
              className={`flex items-center gap-1.5 pr-2.5 py-1.5 rounded cursor-pointer transition-colors ${
                isSel ? 'bg-[#2C3444] text-white' : 'text-slate-300 hover:bg-[#242833]'
              }`}
            >
              {hasKids ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleExpand(dirKey);
                  }}
                  className="p-0.5 text-slate-400 hover:text-slate-200 shrink-0"
                  aria-label={`Toggle folder ${folder.name}`}
                >
                  {isExpanded ? (
                    <ChevronDown className="w-3 h-3" />
                  ) : (
                    <ChevronRight className="w-3 h-3" />
                  )}
                </button>
              ) : (
                <span className="inline-block w-4 shrink-0" />
              )}
              <TriCheckbox
                checked={state.checked}
                indeterminate={state.indeterminate}
                disabled={state.count === 0}
                onChange={(next) => onToggleNodeCheck(dirNode, next)}
                label={`Select folder ${folder.name}`}
              />
              <Folder className="w-3.5 h-3.5 text-[#4C8DFF] fill-[#4C8DFF]/30 shrink-0" />
              <span className="flex-1 truncate" title={folder.folderPath}>
                {folder.name}
              </span>
              <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                {formatCompactCount(folder.fileCount)}
              </span>
            </div>

            {hasKids && isExpanded && (
              <FolderSubtree
                nodes={folder.children}
                depth={depth + 1}
                selectedKey={selectedKey}
                expandedFolders={expandedFolders}
                onToggleExpand={onToggleExpand}
                onSelectNode={onSelectNode}
                getCheckState={getCheckState}
                onToggleNodeCheck={onToggleNodeCheck}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};

export const ExplorerSidebar: React.FC<ExplorerSidebarProps> = ({
  treeMode,
  onChangeTreeMode,
  selectedNode,
  onSelectNode,
  analysis,
  allItems,
  checkedIds,
  onToggleNodeCheck,
}) => {
  const [expandedFamilies, setExpandedFamilies] = useState<Set<FileFamily>>(
    () => new Set(['Pictures', 'Documents']),
  );
  const [diskExpanded, setDiskExpanded] = useState<boolean>(true);
  const [expandedPartitions, setExpandedPartitions] = useState<Set<string>>(() => new Set());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set());

  const selectedKey = treeNodeKey(selectedNode);

  const typeStats = useMemo(() => {
    const byFamily = new Map<FileFamily, Map<string, number>>();
    for (const fam of FAMILY_ORDER) {
      byFamily.set(fam, new Map());
    }
    for (const item of allItems) {
      const extMap = byFamily.get(item.family);
      if (extMap) {
        extMap.set(item.extension, (extMap.get(item.extension) ?? 0) + 1);
      }
    }
    return byFamily;
  }, [allItems]);

  const folderTreesByPartition = useMemo(() => {
    const map = new Map<string, FolderTreeNode[]>();
    for (const part of analysis.partitions) {
      map.set(part.id, buildFolderTreeForPartition(allItems, part.id));
    }
    return map;
  }, [analysis.partitions, allItems]);

  const unallocatedCount = useMemo(
    () =>
      allItems.filter(
        (i) =>
          (i.sourceKind === 'carved' || i.sourceKind === 'ntfs-mft') &&
          i.partitionId === 'unallocated',
      ).length,
    [allItems],
  );
  const mftCount = useMemo(
    () => allItems.filter((i) => i.sourceKind === 'ntfs-mft').length,
    [allItems],
  );
  const recycleCount = useMemo(
    () => allItems.filter((i) => i.sourceKind === 'recycle-bin').length,
    [allItems],
  );
  const folderScanCount = useMemo(
    () => allItems.filter((i) => i.sourceKind === 'folder').length,
    [allItems],
  );

  const getCheckState = (node: SelectedTreeNode) => {
    const matching = allItems.filter((i) => itemMatchesNode(i, node));
    if (matching.length === 0) return { checked: false, indeterminate: false, count: 0 };
    const checkedCount = matching.filter((i) => checkedIds.has(i.id)).length;
    return {
      checked: checkedCount === matching.length,
      indeterminate: checkedCount > 0 && checkedCount < matching.length,
      count: matching.length,
    };
  };

  const toggleFamilyExpand = (fam: FileFamily) => {
    setExpandedFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(fam)) next.delete(fam);
      else next.add(fam);
      return next;
    });
  };

  const togglePartitionExpand = (partId: string) => {
    setExpandedPartitions((prev) => {
      const next = new Set(prev);
      if (next.has(partId)) next.delete(partId);
      else next.add(partId);
      return next;
    });
  };

  const toggleFolderExpand = (key: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <aside className="w-64 lg:w-[272px] shrink-0 bg-[#1E2129] border-r border-[#2A2E39] flex flex-col select-none">
      {/* EaseUS-style Path | Type Tabs */}
      <div className="p-2.5 pb-2 border-b border-[#2A2E39]">
        <div className="grid grid-cols-2 bg-[#16181F] rounded-md p-0.5 border border-[#2A2E39]">
          <button
            type="button"
            onClick={() => onChangeTreeMode('path')}
            className={`py-1.5 text-xs font-medium rounded-sm transition-colors ${
              treeMode === 'path'
                ? 'bg-[#262B36] text-[#4C8DFF]'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Path
          </button>
          <button
            type="button"
            onClick={() => onChangeTreeMode('type')}
            className={`py-1.5 text-xs font-medium rounded-sm transition-colors ${
              treeMode === 'type'
                ? 'bg-[#262B36] text-[#4C8DFF]'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Type
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5 text-xs">
        {treeMode === 'type' ? (
          <>
            {FAMILY_ORDER.map((family) => {
              const extMap = typeStats.get(family)!;
              const famNode: SelectedTreeNode = { kind: 'family', family };
              const famState = getCheckState(famNode);
              const isExpanded = expandedFamilies.has(family);
              const isSelected = selectedKey === treeNodeKey(famNode);
              const exts = Array.from(extMap.entries()).sort((a, b) => b[1] - a[1]);

              return (
                <div key={family}>
                  <div
                    onClick={() => onSelectNode(famNode)}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-[#2C3444] text-white'
                        : famState.count === 0
                          ? 'text-slate-500 hover:bg-[#242833]'
                          : 'text-slate-200 hover:bg-[#242833]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFamilyExpand(family);
                      }}
                      className="p-0.5 text-slate-400 hover:text-slate-200 shrink-0"
                      aria-label={`Toggle ${family}`}
                    >
                      {exts.length > 0 ? (
                        isExpanded ? (
                          <ChevronDown className="w-3 h-3" />
                        ) : (
                          <ChevronRight className="w-3 h-3" />
                        )
                      ) : (
                        <span className="inline-block w-3" />
                      )}
                    </button>
                    <TriCheckbox
                      checked={famState.checked}
                      indeterminate={famState.indeterminate}
                      disabled={famState.count === 0}
                      onChange={(next) => onToggleNodeCheck(famNode, next)}
                      label={`Select all ${family}`}
                    />
                    <FamilyIcon family={family} />
                    <span className="flex-1 truncate">{family}</span>
                    <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                      {formatCompactCount(famState.count)}
                    </span>
                  </div>

                  {isExpanded && exts.length > 0 && (
                    <div className="mt-0.5 space-y-0.5">
                      {exts.map(([ext, count]) => {
                        const extNode: SelectedTreeNode = {
                          kind: 'ext',
                          family,
                          extension: ext,
                        };
                        const extState = getCheckState(extNode);
                        const isExtSel = selectedKey === treeNodeKey(extNode);
                        return (
                          <div
                            key={ext}
                            onClick={() => onSelectNode(extNode)}
                            className={`flex items-center gap-2 pl-8 pr-2 py-1.5 rounded cursor-pointer transition-colors ${
                              isExtSel
                                ? 'bg-[#2C3444] text-white'
                                : 'text-slate-300 hover:bg-[#242833]'
                            }`}
                          >
                            <TriCheckbox
                              checked={extState.checked}
                              indeterminate={extState.indeterminate}
                              onChange={(next) => onToggleNodeCheck(extNode, next)}
                              label={`Select ${ext} files`}
                            />
                            <Folder className="w-3.5 h-3.5 text-[#4C8DFF] fill-[#4C8DFF]/30 shrink-0" />
                            <span className="flex-1 truncate">{ext}</span>
                            <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                              {formatCompactCount(count)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        ) : (
          <div className="space-y-0.5">
            {/* Root Disk Node */}
            {(() => {
              const rootNode: SelectedTreeNode = { kind: 'disk-root' };
              const rootState = getCheckState(rootNode);
              const isRootSel = selectedKey === treeNodeKey(rootNode);
              return (
                <div>
                  <div
                    onClick={() => onSelectNode(rootNode)}
                    className={`flex items-center gap-1.5 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                      isRootSel
                        ? 'bg-[#2C3444] text-white'
                        : 'text-slate-200 hover:bg-[#242833]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDiskExpanded((v) => !v);
                      }}
                      className="p-0.5 text-slate-400 hover:text-slate-200 shrink-0"
                      aria-label="Toggle disk partitions"
                    >
                      {diskExpanded ? (
                        <ChevronDown className="w-3 h-3" />
                      ) : (
                        <ChevronRight className="w-3 h-3" />
                      )}
                    </button>
                    <TriCheckbox
                      checked={rootState.checked}
                      indeterminate={rootState.indeterminate}
                      disabled={rootState.count === 0}
                      onChange={(next) => onToggleNodeCheck(rootNode, next)}
                      label="Select all disk files"
                    />
                    <HardDrive className="w-4 h-4 text-[#4C8DFF] shrink-0" />
                    <span className="flex-1 truncate font-medium">{analysis.diskName}</span>
                    <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                      {formatCompactCount(rootState.count)}
                    </span>
                  </div>

                  {diskExpanded && (
                    <div className="mt-0.5 space-y-0.5">
                      {analysis.partitions.map((part) => {
                        const partNode: SelectedTreeNode = {
                          kind: 'partition',
                          partitionId: part.id,
                        };
                        const partState = getCheckState(partNode);
                        const isPartSel = selectedKey === treeNodeKey(partNode);
                        const isLost = part.status === 'Deleted / Lost';
                        const fsLabel = part.detectedFs?.filesystem ?? part.typeName;
                        const labelText = isLost
                          ? `Lost Partition (${fsLabel})`
                          : `${fsLabel} · ${part.name}`;
                        const folderNodes = folderTreesByPartition.get(part.id) ?? [];
                        const isPartExpanded =
                          expandedPartitions.has(part.id) || folderNodes.length > 0;

                        return (
                          <div key={part.id}>
                            <div
                              onClick={() => onSelectNode(partNode)}
                              className={`flex items-center gap-1.5 pl-5 pr-2 py-1.5 rounded cursor-pointer transition-colors ${
                                isPartSel
                                  ? 'bg-[#2C3444] text-white'
                                  : 'text-slate-200 hover:bg-[#242833]'
                              }`}
                            >
                              {folderNodes.length > 0 ? (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    togglePartitionExpand(part.id);
                                  }}
                                  className="p-0.5 text-slate-400 hover:text-slate-200 shrink-0"
                                  aria-label={`Toggle ${labelText}`}
                                >
                                  {isPartExpanded ? (
                                    <ChevronDown className="w-3 h-3" />
                                  ) : (
                                    <ChevronRight className="w-3 h-3" />
                                  )}
                                </button>
                              ) : (
                                <span className="inline-block w-4 shrink-0" />
                              )}
                              <TriCheckbox
                                checked={partState.checked}
                                indeterminate={partState.indeterminate}
                                disabled={partState.count === 0}
                                onChange={(next) => onToggleNodeCheck(partNode, next)}
                                label={`Select ${labelText}`}
                              />
                              {isLost ? (
                                <ShieldAlert className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                              ) : (
                                <HardDrive className="w-3.5 h-3.5 text-slate-300 shrink-0" />
                              )}
                              <span
                                className={`flex-1 truncate ${
                                  isLost ? 'text-amber-200' : ''
                                }`}
                                title={labelText}
                              >
                                {labelText}
                              </span>
                              <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                                {formatCompactCount(partState.count)}
                              </span>
                            </div>

                            {folderNodes.length > 0 && isPartExpanded && (
                              <FolderSubtree
                                nodes={folderNodes}
                                depth={2}
                                selectedKey={selectedKey}
                                expandedFolders={expandedFolders}
                                onToggleExpand={toggleFolderExpand}
                                onSelectNode={onSelectNode}
                                getCheckState={getCheckState}
                                onToggleNodeCheck={onToggleNodeCheck}
                              />
                            )}
                          </div>
                        );
                      })}

                      {mftCount > 0 && (() => {
                        const mftNode: SelectedTreeNode = { kind: 'ntfs-mft' };
                        const mftState = getCheckState(mftNode);
                        const isMftSel = selectedKey === treeNodeKey(mftNode);
                        return (
                          <div
                            onClick={() => onSelectNode(mftNode)}
                            className={`flex items-center gap-1.5 pl-9 pr-2 py-1.5 rounded cursor-pointer transition-colors ${
                              isMftSel
                                ? 'bg-[#2C3444] text-white'
                                : 'text-slate-300 hover:bg-[#242833]'
                            }`}
                          >
                            <TriCheckbox
                              checked={mftState.checked}
                              indeterminate={mftState.indeterminate}
                              onChange={(next) => onToggleNodeCheck(mftNode, next)}
                              label="Select deleted filesystem files"
                            />
                            <Folder className="w-3.5 h-3.5 text-emerald-400 fill-emerald-400/20 shrink-0" />
                            <span className="flex-1 truncate text-emerald-300">
                              Deleted Filesystem ($MFT / FAT)
                            </span>
                            <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                              {formatCompactCount(mftState.count)}
                            </span>
                          </div>
                        );
                      })()}

                      {unallocatedCount > 0 && (() => {
                        const unNode: SelectedTreeNode = { kind: 'unallocated' };
                        const unState = getCheckState(unNode);
                        const isUnSel = selectedKey === treeNodeKey(unNode);
                        return (
                          <div
                            onClick={() => onSelectNode(unNode)}
                            className={`flex items-center gap-1.5 pl-9 pr-2 py-1.5 rounded cursor-pointer transition-colors ${
                              isUnSel
                                ? 'bg-[#2C3444] text-white'
                                : 'text-slate-300 hover:bg-[#242833]'
                            }`}
                          >
                            <TriCheckbox
                              checked={unState.checked}
                              indeterminate={unState.indeterminate}
                              onChange={(next) => onToggleNodeCheck(unNode, next)}
                              label="Select reconstructed files"
                            />
                            <Folder className="w-3.5 h-3.5 text-amber-400 fill-amber-400/30 shrink-0" />
                            <span className="flex-1 truncate">Reconstructed</span>
                            <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                              {formatCompactCount(unState.count)}
                            </span>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              );
            })()}

            {recycleCount > 0 && (() => {
              const rNode: SelectedTreeNode = { kind: 'recycle-bin' };
              const rState = getCheckState(rNode);
              const isRSel = selectedKey === treeNodeKey(rNode);
              return (
                <div
                  onClick={() => onSelectNode(rNode)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                    isRSel ? 'bg-[#2C3444] text-white' : 'text-slate-200 hover:bg-[#242833]'
                  }`}
                >
                  <TriCheckbox
                    checked={rState.checked}
                    indeterminate={rState.indeterminate}
                    onChange={(next) => onToggleNodeCheck(rNode, next)}
                    label="Select Recycle Bin files"
                  />
                  <Trash2 className="w-4 h-4 text-amber-400 shrink-0" />
                  <span className="flex-1 truncate">Recycle Bin ($Recycle.Bin)</span>
                  <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                    {formatCompactCount(rState.count)}
                  </span>
                </div>
              );
            })()}

            {folderScanCount > 0 && (() => {
              const fldNode: SelectedTreeNode = { kind: 'folder-scan' };
              const fldState = getCheckState(fldNode);
              const isFldSel = selectedKey === treeNodeKey(fldNode);
              return (
                <div
                  onClick={() => onSelectNode(fldNode)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                    isFldSel ? 'bg-[#2C3444] text-white' : 'text-slate-200 hover:bg-[#242833]'
                  }`}
                >
                  <TriCheckbox
                    checked={fldState.checked}
                    indeterminate={fldState.indeterminate}
                    onChange={(next) => onToggleNodeCheck(fldNode, next)}
                    label="Select scanned folder files"
                  />
                  <FolderSearch className="w-4 h-4 text-[#4C8DFF] shrink-0" />
                  <span className="flex-1 truncate">Scanned Folder</span>
                  <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                    {formatCompactCount(fldState.count)}
                  </span>
                </div>
              );
            })()}

            {(() => {
              const fidNode: SelectedTreeNode = { kind: 'fidentify' };
              const fidState = getCheckState(fidNode);
              const isFidSel = selectedKey === treeNodeKey(fidNode);
              return (
                <div
                  onClick={() => onSelectNode(fidNode)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                    isFidSel ? 'bg-[#2C3444] text-white' : 'text-slate-200 hover:bg-[#242833]'
                  }`}
                >
                  <TriCheckbox
                    checked={fidState.checked}
                    indeterminate={fidState.indeterminate}
                    disabled={fidState.count === 0}
                    onChange={(next) => onToggleNodeCheck(fidNode, next)}
                    label="Select identified unknown files"
                  />
                  <FileQuestion className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span className="flex-1 truncate">Unknown Files (fidentify)</span>
                  <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                    {formatCompactCount(fidState.count)}
                  </span>
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </aside>
  );
};
