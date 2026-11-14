import type { MachineConfig } from './protocol';

export interface VibeRemoteApi {
  getMachines(): Promise<MachineConfig[]>;
  saveMachines(machines: MachineConfig[]): Promise<boolean>;
  readClipboardText(): Promise<string>;
  writeClipboardText(text: string): Promise<boolean>;
  /** Native notification, or a Dock bounce + badge where native ones fail (unsigned builds). */
  notify(title: string, body: string): Promise<'shown' | 'fallback'>;
  /** Opens an http(s)/mailto link in the system browser; other schemes are refused. */
  openExternal(url: string): Promise<boolean>;
}

declare global {
  interface Window {
    vibeRemote: VibeRemoteApi;
  }
}

export {};
