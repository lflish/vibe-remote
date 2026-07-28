import { contextBridge, ipcRenderer } from 'electron';
import type { MachineConfig } from '../shared/protocol';

// Expose a safe API to the renderer process
contextBridge.exposeInMainWorld('vibeRemote', {
  getMachines: (): Promise<MachineConfig[]> => ipcRenderer.invoke('get-machines'),
  saveMachines: (machines: MachineConfig[]): Promise<boolean> =>
    ipcRenderer.invoke('save-machines', machines),
  getWorkdirs: (machineKey: string): Promise<string[]> =>
    ipcRenderer.invoke('workdirs:get', machineKey),
  addWorkdir: (machineKey: string, dir: string): Promise<void> =>
    ipcRenderer.invoke('workdirs:add', { machineKey, dir }),
});
