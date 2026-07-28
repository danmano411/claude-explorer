import type { HighlighterCore } from 'shiki/core'
import { winBasename } from '../shared/pathutil'

/**
 * Syntax highlighting for the read-only viewer.
 *
 * Bundle discipline is the whole design here — Shiki's default bundle is tens of
 * megabytes, so every part of it is paid for only when actually used:
 *
 *  1. NO static `shiki` import. The core, the regex engine and the themes are
 *     reached through `import()` inside `getHighlighter()`, so they land in their
 *     own lazy chunk that costs nothing until the first file is highlighted.
 *     (`import type` above is erased at compile time and pulls in no runtime code.)
 *  2. Grammars are per-language dynamic imports, so opening a .json file never
 *     downloads the 185KB TypeScript grammar.
 *  3. The JavaScript regex engine, not Oniguruma: 4.5KB + 228KB of oniguruma-to-es
 *     against 638KB of JS *plus* a 466KB .wasm binary. Electron pins a modern
 *     Chromium, so the RegExp `v` flag the JS engine needs is always present.
 *
 * Keep this file free of top-level `shiki` imports, or the whole graph gets
 * pulled into the main renderer chunk and every point above is undone.
 */

/** Grammar loaders keyed by Shiki language id. Each becomes its own lazy chunk. */
const LANGS = {
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  json: () => import('@shikijs/langs/json'),
  css: () => import('@shikijs/langs/css'),
  html: () => import('@shikijs/langs/html'),
  markdown: () => import('@shikijs/langs/markdown'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  powershell: () => import('@shikijs/langs/powershell'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
} as const

export type Lang = keyof typeof LANGS

/**
 * Extension -> grammar.
 *
 * `tsx` covers the whole TypeScript family and `javascript` the JS one. Shiki
 * ships ts/tsx/js/jsx as four INDEPENDENT ~185KB grammars that share nothing, and
 * TSX is a syntactic superset of TS for highlighting purposes — so collapsing four
 * to two saves ~370KB for a difference nobody can see in a read-only viewer.
 * `html` already pulls `javascript` + `css` transitively, so neither is extra.
 */
const BY_EXT: Record<string, Lang> = {
  ts: 'tsx', tsx: 'tsx', mts: 'tsx', cts: 'tsx',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json',
  css: 'css',
  html: 'html', htm: 'html',
  md: 'markdown', markdown: 'markdown',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
}

/**
 * Grammar for a path, or null to render as plain text — which is a perfectly good
 * outcome, not a failure. Extensionless files (`LICENSE`) and rc-style dotfiles
 * (`.gitignore`) fall through to plain simply because they match no grammar.
 * Matches on the basename, so a dotted FOLDER never picks the language.
 */
export function langForPath(path: string): Lang | null {
  const ext = /\.([^.]+)$/.exec(winBasename(path))?.[1]
  return (ext && BY_EXT[ext.toLowerCase()]) || null
}

/**
 * Above this, tokenizing blocks the main thread long enough to feel like a hang.
 * The file still renders — just as plain text.
 * ponytail: fixed char cap. If big files need colour, move Shiki to a worker.
 */
export const HIGHLIGHT_MAX_CHARS = 200_000

let highlighterP: Promise<HighlighterCore> | null = null
const loaded = new Set<Lang>()

function getHighlighter(): Promise<HighlighterCore> {
  // Cache the promise, not the result: two tabs highlighting at once must share
  // one highlighter rather than each building their own.
  highlighterP ??= (async () => {
    const [core, engine, light, dark] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('@shikijs/themes/solarized-light'),
      import('@shikijs/themes/solarized-dark'),
    ])
    return core.createHighlighterCore({
      themes: [light.default, dark.default],
      langs: [],
      // `forgiving` degrades a grammar rule the JS engine cannot express into a
      // missed highlight instead of a thrown error.
      engine: engine.createJavaScriptRegexEngine({ forgiving: true }),
    })
  })()
  return highlighterP
}

/**
 * Highlight `code` to a Shiki `<pre>`. Returns null if anything goes wrong, which
 * the caller renders as plain text — highlighting is decoration, never a failure
 * state the user has to see.
 *
 * Solarized is the closest match to the Retro Claude palette (cream paper, and an
 * accent orange within a shade of --clay). Both themes are emitted at once as
 * `--shiki-light` / `--shiki-dark` custom properties and resolved in index.css, so
 * dark mode is a CSS concern and no second palette is introduced.
 */
export async function highlightToHtml(code: string, lang: Lang): Promise<string | null> {
  try {
    const hl = await getHighlighter()
    if (!loaded.has(lang)) {
      await hl.loadLanguage((await LANGS[lang]()).default)
      loaded.add(lang)
    }
    return hl.codeToHtml(code, {
      lang,
      themes: { light: 'solarized-light', dark: 'solarized-dark' },
      defaultColor: false,
    })
  } catch {
    return null
  }
}
