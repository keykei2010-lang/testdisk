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
      className="w-3.5 h-3.5 rounded border-[#3B4963] bg-[#11151C] text-[#2E7CF6] focus:ring-[#2E7CF6] disabled:opacity-30 shrink-0 cursor-pointer"
    />
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
    () => new Set(['Pictures', 'Documents', 'Audio']),
  );
  const [diskExpanded, setDiskExpanded] = useState<boolean>(true);

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

  return (
    <aside className="w-64 lg:w-72 shrink-0 bg-[#181E29] border-r border-[#2A3446] flex flex-col select-none">
      {/* Path | Type Switcher (matching screenshots) */}
      <div className="p-3 border-b border-[#2A3446]">
        <div className="grid grid-cols-2 bg-[#11151C] p-1 rounded-md border border-[#2A3446]">
          <button
            type="button"
            onClick={() => onChangeTreeMode('path')}
            className={`py-1.5 text-xs font-medium rounded transition-colors ${
              treeMode === 'path'
                ? 'bg-[#283244] text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Path
          </button>
          <button
            type="button"
            onClick={() => onChangeTreeMode('type')}
            className={`py-1.5 text-xs font-medium rounded transition-colors ${
              treeMode === 'type'
                ? 'bg-[#283244] text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Type
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1 text-xs">
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
                    className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-[#283244] text-white'
                        : 'text-slate-300 hover:bg-[#1F2735]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFamilyExpand(family);
                      }}
                      className="p-0.5 text-slate-400 hover:text-slate-200"
                      aria-label={`Toggle ${family}`}
                    >
                      {exts.length > 0 ? (
                        isExpanded ? (
                          <ChevronDown className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5" />
                        )
                      ) : (
                        <span className="inline-block w-3.5" />
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
                    <span className="flex-1 truncate font-medium">{family}</span>
                    <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                      {famState.count}
                    </span>
                  </div>

                  {isExpanded && exts.length > 0 && (
                    <div className="ml-6 mt-0.5 space-y-0.5 border-l border-[#2A3446] pl-2">
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
                            className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors ${
                              isExtSel
                                ? 'bg-[#283244] text-white'
                                : 'text-slate-300 hover:bg-[#1F2735]'
                            }`}
                          >
                            <TriCheckbox
                              checked={extState.checked}
                              indeterminate={extState.indeterminate}
                              onChange={(next) => onToggleNodeCheck(extNode, next)}
                              label={`Select ${ext} files`}
                            />
                            <Folder className="w-3.5 h-3.5 text-[#38BDF8] shrink-0" />
                            <span className="flex-1 truncate font-mono">{ext}</span>
                            <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                              {count}
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
          <div className="space-y-1">
            {/* Root Disk Node */}
            {(() => {
              const rootNode: SelectedTreeNode = { kind: 'disk-root' };
              const rootState = getCheckState(rootNode);
              const isRootSel = selectedKey === treeNodeKey(rootNode);
              return (
                <div>
                  <div
                    onClick={() => onSelectNode(rootNode)}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors ${
                      isRootSel
                        ? 'bg-[#283244] text-white'
                        : 'text-slate-200 hover:bg-[#1F2735]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDiskExpanded((v) => !v);
                      }}
                      className="p-0.5 text-slate-400 hover:text-slate-200"
                      aria-label="Toggle disk partitions"
                    >
                      {diskExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5" />
                      )}
                    </button>
                    <TriCheckbox
                      checked={rootState.checked}
                      indeterminate={rootState.indeterminate}
                      disabled={rootState.count === 0}
                      onChange={(next) => onToggleNodeCheck(rootNode, next)}
                      label="Select all disk files"
                    />
                    <HardDrive className="w-4 h-4 text-[#38BDF8] shrink-0" />
                    <span className="flex-1 truncate font-medium">{analysis.diskName}</span>
                    <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                      {rootState.count}
                    </span>
                  </div>

                  {diskExpanded && (
                    <div className="ml-5 mt-1 space-y-0.5 border-l border-[#2A3446] pl-2">
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

                        return (
                          <div
                            key={part.id}
                            onClick={() => onSelectNode(partNode)}
                            className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors ${
                              isPartSel
                                ? 'bg-[#283244] text-white'
                                : 'text-slate-300 hover:bg-[#1F2735]'
                            }`}
                          >
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
                              <Folder className="w-3.5 h-3.5 text-[#38BDF8] shrink-0" />
                            )}
                            <span
                              className={`flex-1 truncate ${
                                isLost ? 'text-amber-300 font-medium' : ''
                              }`}
                              title={labelText}
                            >
                              {labelText}
                            </span>
                            <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                              {partState.count}
                            </span>
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
                            className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors ${
                              isMftSel
                                ? 'bg-[#283244] text-white'
                                : 'text-slate-300 hover:bg-[#1F2735]'
                            }`}
                          >
                            <TriCheckbox
                              checked={mftState.checked}
                              indeterminate={mftState.indeterminate}
                              onChange={(next) => onToggleNodeCheck(mftNode, next)}
                              label="Select deleted NTFS MFT files"
                            />
                            <Folder className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                            <span className="flex-1 truncate text-emerald-300 font-medium">
                              Deleted NTFS ($MFT)
                            </span>
                            <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                              {mftState.count}
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
                            className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors ${
                              isUnSel
                                ? 'bg-[#283244] text-white'
                                : 'text-slate-300 hover:bg-[#1F2735]'
                            }`}
                          >
                            <TriCheckbox
                              checked={unState.checked}
                              indeterminate={unState.indeterminate}
                              onChange={(next) => onToggleNodeCheck(unNode, next)}
                              label="Select reconstructed files"
                            />
                            <Folder className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            <span className="flex-1 truncate">Reconstructed</span>
                            <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                              {unState.count}
                            </span>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Windows Common Locations: Recycle Bin & Scanned Folder */}
            {recycleCount > 0 && (() => {
              const binNode: SelectedTreeNode = { kind: 'recycle-bin' };
              const binState = getCheckState(binNode);
              const isBinSel = selectedKey === treeNodeKey(binNode);
              return (
                <div
                  onClick={() => onSelectNode(binNode)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors mt-2 ${
                    isBinSel
                      ? 'bg-[#283244] text-white'
                      : 'text-slate-300 hover:bg-[#1F2735]'
                  }`}
                >
                  <span className="inline-block w-4" />
                  <TriCheckbox
                    checked={binState.checked}
                    indeterminate={binState.indeterminate}
                    onChange={(next) => onToggleNodeCheck(binNode, next)}
                    label="Select Recycle Bin files"
                  />
                  <Trash2 className="w-4 h-4 text-amber-400 shrink-0" />
                  <span className="flex-1 truncate font-medium">Recycle Bin ($Recycle.Bin)</span>
                  <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                    {binState.count}
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
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors mt-1 ${
                    isFldSel
                      ? 'bg-[#283244] text-white'
                      : 'text-slate-300 hover:bg-[#1F2735]'
                  }`}
                >
                  <span className="inline-block w-4" />
                  <TriCheckbox
                    checked={fldState.checked}
                    indeterminate={fldState.indeterminate}
                    onChange={(next) => onToggleNodeCheck(fldNode, next)}
                    label="Select scanned folder files"
                  />
                  <FolderSearch className="w-4 h-4 text-[#38BDF8] shrink-0" />
                  <span className="flex-1 truncate font-medium">Scanned Folder</span>
                  <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                    {fldState.count}
                  </span>
                </div>
              );
            })()}

            {/* Unknown Files (fidentify) Node */}
            {(() => {
              const fidNode: SelectedTreeNode = { kind: 'fidentify' };
              const fidState = getCheckState(fidNode);
              const isFidSel = selectedKey === treeNodeKey(fidNode);
              return (
                <div
                  onClick={() => onSelectNode(fidNode)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors mt-1 ${
                    isFidSel
                      ? 'bg-[#283244] text-white'
                      : 'text-slate-300 hover:bg-[#1F2735]'
                  }`}
                >
                  <span className="inline-block w-4" />
                  <TriCheckbox
                    checked={fidState.checked}
                    indeterminate={fidState.indeterminate}
                    disabled={fidState.count === 0}
                    onChange={(next) => onToggleNodeCheck(fidNode, next)}
                    label="Select identified unknown files"
                  />
                  <FileQuestion className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span className="flex-1 truncate font-medium">Unknown Files (fidentify)</span>
                  <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                    {fidState.count}
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
