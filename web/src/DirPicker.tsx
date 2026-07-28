import { useEffect, useState } from 'react';
import { VibeRemoteRest, type MachineConfig, type DirEntry, type DirListing } from '@vibe-remote/core';

// 浏览远程机器的目录（受 workdir 白名单 + realpath 约束）。用于「+ 选目录开聊」。
// 复用 rest.listDir（GET /api/v1/fs?path=...）。
export function DirPicker({ machine, initialPath, onPick, onCancel }: {
  machine: MachineConfig;
  initialPath?: string;
  onPick: (path: string) => void;
  onCancel: () => void;
}) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState<string | undefined>(initialPath);

  useEffect(() => {
    setError(null);
    setListing(null);
    new VibeRemoteRest(machine)
      .listDir(path)
      .then(setListing)
      .catch((e) => setError((e as Error).message));
  }, [machine, path]);

  return (
    <div className="web-dirpicker">
      <div className="web-dirpicker-head">
        <button onClick={onCancel}>取消</button>
        <span className="web-dirpicker-path">{listing?.path ?? path ?? '(loading)'}</span>
        <button onClick={() => listing && onPick(listing.path)} disabled={!listing}>选此目录</button>
      </div>
      {error && <div className="web-dirpicker-error">{error}</div>}
      <ul className="web-dirpicker-list">
        {listing?.entries.map((e: DirEntry) => (
          <li key={e.path}>
            <button onClick={() => setPath(e.path)}>📁 {e.name}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
