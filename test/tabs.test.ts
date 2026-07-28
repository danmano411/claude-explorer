import { describe, it, expect } from 'vitest'
import { newViewerTab, newFilesTab } from '../src/renderer/tabs'

describe('newViewerTab', () => {
  it('carries the file path and derives title + containing folder', () => {
    const t = newViewerTab('C:\\repo\\src\\main\\pty.ts')
    expect(t.view).toBe('viewer')
    expect(t.filePath).toBe('C:\\repo\\src\\main\\pty.ts')
    expect(t.title).toBe('pty.ts')
    expect(t.cwd).toBe('C:\\repo\\src\\main') // tab menu (Explorer/Terminal/IDE) acts here
  })

  it('defaults to file mode and accepts diff mode', () => {
    expect(newViewerTab('C:\\repo\\a.ts').viewerMode).toBe('file')
    expect(newViewerTab('C:\\repo\\a.ts', 'diff').viewerMode).toBe('diff')
  })

  it('gives every tab a distinct id', () => {
    expect(newViewerTab('C:\\a.ts').id).not.toBe(newFilesTab('C:\\').id)
  })
})
