import { contextBridge, ipcRenderer } from 'electron';
import type { MachineConfig } from '../shared/protocol';

// Expose a safe API to the renderer process
contextBridge.exposeInMainWorld('vibeRemote', {
  getMachines: (): Promise<MachineConfig[]> => ipcRenderer.invoke('get-machines'),
  saveMachines: (machines: MachineConfig[]): Promise<boolean> =>
    ipcRenderer.invoke('save-machines', machines),
  readClipboardText: (): Promise<string> => ipcRenderer.invoke('clipboard-read-text'),
  writeClipboardText: (text: string): Promise<boolean> =>
    ipcRenderer.invoke('clipboard-write-text', text),
});
