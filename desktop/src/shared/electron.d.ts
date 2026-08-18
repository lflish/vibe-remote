import type { MachineConfig } from './protocol';

export interface VibeRemoteApi {
  getMachines(): Promise<MachineConfig[]>;
  saveMachines(machines: MachineConfig[]): Promise<boolean>;
  readClipboardText(): Promise<string>;
  writeClipboardText(text: string): Promise<boolean>;
}

declare global {
  interface Window {
    vibeRemote: VibeRemoteApi;
  }
}

export {};
