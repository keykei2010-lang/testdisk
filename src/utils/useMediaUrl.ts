import { useEffect, useState } from 'react';

export interface MediaUrlInput {
  enabled: boolean;
  cacheKey: string;
  browserFile?: File;
  nativeKind?: string;
  devicePath?: string;
  data?: Uint8Array;
  mimeType?: string;
}

/**
 * StrictMode-safe object URL lifecycle hook.
 * Allocates and revokes Blob URLs strictly inside useEffect so React StrictMode's
 * simulated unmount + remount never leaves a component holding a revoked blob URL.
 */
export function useMediaUrl({
  enabled,
  cacheKey,
  browserFile,
  nativeKind,
  devicePath,
  data,
  mimeType,
}: MediaUrlInput): string | null {
  const [urlState, setUrlState] = useState<{ key: string; url: string | null }>({
    key: '',
    url: null,
  });

  useEffect(() => {
    if (!enabled) return;

    if (nativeKind === 'native-file' && devicePath) {
      const normalized = devicePath.replace(/\\/g, '/').replace(/^\/+/, '');
      const fileUrl = `file:///${normalized}`;
      let active = true;
      queueMicrotask(() => {
        if (active) setUrlState({ key: cacheKey, url: fileUrl });
      });
      return () => {
        active = false;
      };
    }

    const blob = browserFile
      ? browserFile
      : data && data.byteLength > 0
        ? new Blob([data.slice().buffer], { type: mimeType || 'application/octet-stream' })
        : null;
    if (!blob) return;

    const objectUrl = URL.createObjectURL(blob);
    let active = true;
    queueMicrotask(() => {
      if (active) {
        setUrlState({ key: cacheKey, url: objectUrl });
      }
    });

    return () => {
      active = false;
      URL.revokeObjectURL(objectUrl);
    };
  }, [enabled, cacheKey, browserFile, nativeKind, devicePath, data, mimeType]);

  if (!enabled) return null;
  return urlState.key === cacheKey ? urlState.url : null;
}
