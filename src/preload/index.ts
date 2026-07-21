// Phase 0 placeholder — replaced by Task 2.1 with the full window.api bridge.
import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('api', {})
