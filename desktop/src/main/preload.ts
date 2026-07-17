import { contextBridge, ipcRenderer } from 'electron';
import type { MachineConfig } from '../shared/protocol';

// Expose a safe API to the renderer process
contextBridge.exposeInMainWorld('ccdesk', {
  getMachines: (): Promise<MachineConfig[]> => ipcRenderer.invoke('get-machines'),
  saveMachines: (machines: MachineConfig[]): Promise<boolean> =>
    ipcRenderer.invoke('save-machines', machines),
});
