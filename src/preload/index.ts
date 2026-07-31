import { contextBridge, ipcRenderer, clipboard } from 'electron';
import { CH } from '../shared/ipc';
import type { Api } from '../shared/ipc';
import type { SearchHit, SearchDone, TrashWarn, ControlRequest } from '../shared/types';

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
  // --- v2 file operations ---
  fsRename: (from, to, confirm) => ipcRenderer.invoke(CH.fsRename, from, to, confirm),
  fsMkdir: (p, confirm) => ipcRenderer.invoke(CH.fsMkdir, p, confirm),
  fsNewFile: (p, confirm) => ipcRenderer.invoke(CH.fsNewFile, p, confirm),
  fsCopy: (src, dst, confirm) => ipcRenderer.invoke(CH.fsCopy, src, dst, confirm),
  fsMove: (src, dst, confirm) => ipcRenderer.invoke(CH.fsMove, src, dst, confirm),
  fsDelete: (paths, opts) => ipcRenderer.invoke(CH.fsDelete, paths, opts),
  fsRestore: (records, confirm) => ipcRenderer.invoke(CH.fsRestore, records, confirm),
  onTrashWarn: (cb) => {
    const h = (_e: unknown, warn: TrashWarn) => cb(warn);
    ipcRenderer.on(CH.trashWarn, h);
    return () => ipcRenderer.off(CH.trashWarn, h);
  },
  fsExists: (p) => ipcRenderer.invoke(CH.fsExists, p),
  openPath: (p) => ipcRenderer.invoke(CH.openPath, p),
  revealPath: (p) => ipcRenderer.invoke(CH.revealPath, p),
  recentsRemove: (p) => ipcRenderer.invoke(CH.recentsRemove, p),
  ideOpen: (p) => ipcRenderer.invoke(CH.ideOpen, p),
  settingsGet: () => ipcRenderer.invoke(CH.settingsGet),
  settingsSet: (patch) => ipcRenderer.invoke(CH.settingsSet, patch),
  clipboardReadText: () => clipboard.readText(),
  onMenuCommand: (cb) => {
    const h = (_e: unknown, cmd: string, arg?: string) => cb(cmd, arg);
    ipcRenderer.on(CH.menuCommand, h);
    return () => ipcRenderer.off(CH.menuCommand, h);
  },
  onMenuSession: (cb) => {
    const h = (_e: unknown, path: string, resumeId?: string) => cb(path, resumeId);
    ipcRenderer.on(CH.menuSession, h);
    return () => ipcRenderer.off(CH.menuSession, h);
  },
  // --- M2 viewer + diff (read-only) ---
  fsRead: (p) => ipcRenderer.invoke(CH.fsRead, p),
  gitStatus: (dir) => ipcRenderer.invoke(CH.gitStatus, dir),
  gitDiff: (p) => ipcRenderer.invoke(CH.gitDiff, p),
  // --- M3 search ---
  searchStart: (q) => ipcRenderer.invoke(CH.searchStart, q),
  searchCancel: (id) => ipcRenderer.send(CH.searchCancel, id),
  onSearchHits: (cb) => {
    const h = (_e: unknown, id: string, hits: SearchHit[]) => cb(id, hits);
    ipcRenderer.on(CH.searchHits, h);
    return () => ipcRenderer.off(CH.searchHits, h);
  },
  onSearchDone: (cb) => {
    const h = (_e: unknown, id: string, done: SearchDone) => cb(id, done);
    ipcRenderer.on(CH.searchDone, h);
    return () => ipcRenderer.off(CH.searchDone, h);
  },
  // --- M5 workspace ---
  workspaceGet: () => ipcRenderer.invoke(CH.workspaceGet),
  workspaceSet: (w) => ipcRenderer.invoke(CH.workspaceSet, w),
  // --- KAN-39 control channel ---
  onControlRequest: (cb) => {
    const h = (_e: unknown, req: ControlRequest) => cb(req);
    ipcRenderer.on(CH.controlRequest, h);
    return () => ipcRenderer.off(CH.controlRequest, h);
  },
  controlReply: (reply) => ipcRenderer.send(CH.controlReply, reply),
};

contextBridge.exposeInMainWorld('api', api);
