import { describe, it, expect } from 'vitest'
import { highlightToHtml, langForPath } from '../src/renderer/highlight'

// Guards the Shiki wiring itself (fine-grained core + JS engine + lazy grammar +
// dual themes). These are the calls that silently change across Shiki majors.
describe('highlightToHtml', () => {
  it('emits BOTH theme colours as custom properties, never a hard-coded palette', async () => {
    const html = await highlightToHtml('const x: number = 1\n', 'tsx')
    expect(html).not.toBeNull()
    // defaultColor:false is what lets index.css pick the mode.
    expect(html).toContain('--shiki-light:')
    expect(html).toContain('--shiki-dark:')
    // No baked-in `color:#...`, which would defeat the CSS-variable theming.
    expect(html).not.toMatch(/style="[^"]*(?<!-)color:#/)
  })

  it('produces the pre.shiki > code > span.line shape the plain fallback mimics', async () => {
    const html = await highlightToHtml('a\nb\n', 'tsx')
    expect(html).toMatch(/<pre class="shiki/)
    expect(html).toContain('<code>')
    expect(html).toContain('class="line"')
  })

  it('actually tokenizes — a keyword is coloured differently from an identifier', async () => {
    const html = (await highlightToHtml('const x = 1', 'tsx'))!
    const colours = [...html.matchAll(/--shiki-light:(#[0-9a-fA-F]+)/g)].map((m) => m[1])
    expect(new Set(colours).size).toBeGreaterThan(1)
  })

  it('loads a second grammar lazily without disturbing the first', async () => {
    expect(await highlightToHtml('key: value', 'yaml')).toContain('class="line"')
    expect(await highlightToHtml('{"a":1}', 'json')).toContain('class="line"')
    expect(await highlightToHtml('const x = 1', 'tsx')).toContain('class="line"')
  })
})

describe('langForPath', () => {
  it('collapses the whole TS/JS family onto two grammars', () => {
    // ts/tsx/js/jsx are four independent ~185KB grammars; we ship two.
    for (const p of ['a.ts', 'a.tsx', 'a.mts', 'a.cts']) {
      expect(langForPath(`C:\\repo\\${p}`)).toBe('tsx')
    }
    for (const p of ['a.js', 'a.jsx', 'a.mjs', 'a.cjs']) {
      expect(langForPath(`C:\\repo\\${p}`)).toBe('javascript')
    }
  })

  it('maps the remaining project languages', () => {
    expect(langForPath('C:\\a\\pkg.json')).toBe('json')
    expect(langForPath('C:\\a\\index.css')).toBe('css')
    expect(langForPath('C:\\a\\index.html')).toBe('html')
    expect(langForPath('C:\\a\\README.md')).toBe('markdown')
    expect(langForPath('C:\\a\\run.sh')).toBe('shellscript')
    expect(langForPath('C:\\a\\build.ps1')).toBe('powershell')
    expect(langForPath('C:\\a\\ci.yml')).toBe('yaml')
    expect(langForPath('C:\\a\\cfg.toml')).toBe('toml')
  })

  it('is case-insensitive on the extension', () => {
    expect(langForPath('C:\\a\\README.MD')).toBe('markdown')
    expect(langForPath('C:\\a\\Build.PS1')).toBe('powershell')
  })

  it('reads only the LAST extension of a multi-dot name', () => {
    // Discriminating: a greedy `\..+$` would yield "eslintrc.json" and miss.
    expect(langForPath('C:\\repo\\.eslintrc.json')).toBe('json')
    expect(langForPath('C:\\repo\\vite.config.ts')).toBe('tsx')
    expect(langForPath('C:\\repo\\app.min.css')).toBe('css')
  })

  it('returns null for rc-dotfiles, extensionless and unknown files', () => {
    expect(langForPath('C:\\repo\\.gitignore')).toBeNull()
    expect(langForPath('C:\\repo\\LICENSE')).toBeNull()
    expect(langForPath('C:\\repo\\photo.png')).toBeNull()
  })

  it('matches on the basename, so a dotted FOLDER never sets the language', () => {
    // Discriminating: matching the raw path would let the folder ".md" win.
    expect(langForPath('C:\\notes.md\\LICENSE')).toBeNull()
    expect(langForPath('C:\\notes.md\\run.ps1')).toBe('powershell')
  })
})
