import React from 'react';
import { Download, WifiOff } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../hooks/usePWAInstall';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, install } = usePWAInstall();

  if (isInstalled || !isInstallable) {
    return null;
  }

  return (
    <button
      type="button"
      onClick={() => void install()}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-[#1F2735] text-slate-200 border border-[#2A3446] hover:bg-[#283244] transition-colors whitespace-nowrap shrink-0"
      title="Pin as standalone offline desktop app in Windows Edge or Chrome"
    >
      <Download className="w-3.5 h-3.5 text-[#38BDF8]" />
      Launch Offline App
    </button>
  );
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 text-xs whitespace-nowrap shrink-0">
      <WifiOff className="w-3.5 h-3.5" />
      <span>Offline Mode</span>
    </div>
  );
};
