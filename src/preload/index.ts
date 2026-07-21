import { contextBridge, ipcRenderer } from 'electron';
import { CH } from '../shared/ipc';
import type { Api } from '../shared/ipc';

const api: Api = {
  fsList: (p) => ipcRenderer.invoke(CH.fsList, p),
  fsHome: () => ipcRenderer.invoke(CH.fsHome),
  recentsList: () => ipcRenderer.invoke(CH.recentsList),
  recentsAdd: (p) => ipcRenderer.invoke(CH.recentsAdd, p),
  sessionsList: (p) => ipcRenderer.invoke(CH.sessionsList, p),
  externalOpen: (p) => ipcRenderer.invoke(CH.externalOpen, p),
  ptySpawn: (o) => ipcRenderer.invoke(CH.ptySpawn, o),
  ptyWrite: (id, d) => ipcRenderer.send(CH.ptyWrite, id, d),
  ptyResize: (id, c, r) => ipcRenderer.send(CH.ptyResize, id, c, r),
  ptyKill: (id) => ipcRenderer.send(CH.ptyKill, id),
  onPtyData: (cb) => {
    const h = (_e: unknown, id: string, d: string) => cb(id, d);
    ipcRenderer.on(CH.ptyData, h);
    return () => ipcRenderer.off(CH.ptyData, h);
  },
  onPtyExit: (cb) => {
    const h = (_e: unknown, id: string, c: number) => cb(id, c);
    ipcRenderer.on(CH.ptyExit, h);
    return () => ipcRenderer.off(CH.ptyExit, h);
  },
};

contextBridge.exposeInMainWorld('api', api);
