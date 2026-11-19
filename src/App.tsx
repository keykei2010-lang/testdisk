import React, { useMemo, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { analyzeDiskImage, PartitionEntry } from './engine/partitions';
import { buildSampleDiskImage } from './engine/sampleDisk';
import { PartitionAnalyzer } from './components/PartitionAnalyzer';
import { PhotoRecCarver } from './components/PhotoRecCarver';
import { FileIdentifier } from './components/FileIdentifier';

type ActiveView = 'testdisk' | 'photorec' | 'fidentify';

export const App: React.FC = () => {
  const initialSample = useMemo(() => buildSampleDiskImage(), []);
  const [diskName, setDiskName] = useState<string>(initialSample.name);
  const [diskBytes, setDiskBytes] = useState<Uint8Array>(initialSample.bytes);
  const [analysisNonce, setAnalysisNonce] = useState<number>(0);
  const [activeView, setActiveView] = useState<ActiveView>('testdisk');
  const [photoRecInitialPartition, setPhotoRecInitialPartition] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const analysis = useMemo(() => {
    void analysisNonce;
    return analyzeDiskImage(diskName, diskBytes);
  }, [diskName, diskBytes, analysisNonce]);

  const handleOpenDiskImage = async (file: File | undefined) => {
    if (!file) return;
    setLoadError(null);
    if (file.size > 256 * 1024 * 1024) {
      setLoadError(
        `Image "${file.name}" exceeds the 256 MiB browser memory limit. Please select a smaller raw disk or partition image (.img, .dd, .raw).`,
      );
      return;
    }
    const buffer = await file.arrayBuffer();
    setDiskName(file.name);
    setDiskBytes(new Uint8Array(buffer));
    setPhotoRecInitialPartition(null);
  };

  const handleResetSample = () => {
    const sample = buildSampleDiskImage();
    setLoadError(null);
    setDiskName(sample.name);
    setDiskBytes(sample.bytes);
    setPhotoRecInitialPartition(null);
  };

  const handleOpenInPhotoRec = (partition: PartitionEntry) => {
    setPhotoRecInitialPartition(partition.id);
    setActiveView('photorec');
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Three-Zone Top Bar */}
      <header className="sticky top-0 z-30 bg-white border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between gap-8">
          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              setActiveView('testdisk');
            }}
            className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            TestDisk &amp; PhotoRec
          </a>

          <nav aria-label="Recovery modules" className="flex items-center gap-6">
            <button
              type="button"
              onClick={() => setActiveView('testdisk')}
              className={`py-5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                activeView === 'testdisk'
                  ? 'border-slate-900 text-slate-900'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              Partition Recovery
            </button>
            <button
              type="button"
              onClick={() => setActiveView('photorec')}
              className={`py-5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                activeView === 'photorec'
                  ? 'border-slate-900 text-slate-900'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              PhotoRec Carver
            </button>
            <button
              type="button"
              onClick={() => setActiveView('fidentify')}
              className={`py-5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                activeView === 'fidentify'
                  ? 'border-slate-900 text-slate-900'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              fidentify Lab
            </button>
          </nav>

          <div className="shrink-0">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-md transition-colors whitespace-nowrap shrink-0"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              Open Disk Image
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".img,.dd,.raw,.iso,.bin,.dmg"
              className="hidden"
              onChange={(e) => {
                void handleOpenDiskImage(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-8 space-y-6">
        {loadError && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg px-4 py-3 text-xs">
            {loadError}
          </div>
        )}

        {activeView === 'testdisk' && (
          <PartitionAnalyzer
            key={`${diskName}-${analysisNonce}-${analysis.partitions.length}`}
            diskName={diskName}
            diskBytes={diskBytes}
            analysis={analysis}
            onUpdateDiskBytes={(newBytes, newName) => {
              setDiskBytes(newBytes);
              if (newName) setDiskName(newName);
            }}
            onReanalyze={() => setAnalysisNonce((n) => n + 1)}
            onLoadSampleDisk={handleResetSample}
            onOpenInPhotoRec={handleOpenInPhotoRec}
          />
        )}

        {activeView === 'photorec' && (
          <PhotoRecCarver
            key={`${diskName}-${diskBytes.byteLength}-${photoRecInitialPartition ?? 'whole'}`}
            diskBytes={diskBytes}
            analysis={analysis}
            initialPartitionId={photoRecInitialPartition}
          />
        )}

        {activeView === 'fidentify' && <FileIdentifier />}
      </main>

      <footer className="border-t border-slate-200 bg-white mt-auto">
        <div className="max-w-7xl mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-500">
          <span>TestDisk &amp; PhotoRec Recovery Suite · Client-side binary disk &amp; file carving workspace</span>
          <span>Licensed under GNU GPL v2+ · Original C/C++ architecture by Christophe Grenier (CGSecurity)</span>
        </div>
      </footer>
    </div>
  );
};

export default App;
