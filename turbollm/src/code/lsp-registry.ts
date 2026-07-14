// Language → LSP server registry (founder-reported gap, 2026-07-13, item 3: "for a new code, it
// should 1st analyse the coding language and install its lsp and always use lsp whenever making a
// code change in a file... bundle lsp urls in code so it is like a tool call to install a lsp").
//
// Scoped to TypeScript/JavaScript and Python for v1 — both install on demand via `npx` (no global
// install, no separate toolchain like a JDK for Kotlin or a Rust toolchain for rust-analyzer),
// which keeps this reliable across any user's machine without extra setup, matching the repo's
// cross-platform-by-default rule. Extending to Go/Rust/Kotlin/etc later is adding a registry entry
// (and, for non-npm-installable servers, a different install strategy) — not a redesign. TS/JS
// share ONE `typescript-language-server` process per session (it natively handles both), keyed by
// the same `language` id below so lsp-client.ts's session-level client map dedupes correctly.

export interface LspServerSpec {
  /** Cache key for the session's client map — servers that handle multiple extensions (TS/JS)
   *  share one running process keyed by this. */
  language: string
  /** LSP textDocument.languageId sent in didOpen/didChange. */
  languageId: string
  /** Full argv passed to `npx` to run the server in --stdio mode. `-y` skips the install
   *  confirmation prompt; `-p` pins the package(s) actually needed (typescript-language-server
   *  needs the `typescript` package itself present to resolve the compiler). */
  npxArgs: string[]
}

const TS_NPX_ARGS = ['-y', '-p', 'typescript', '-p', 'typescript-language-server', 'typescript-language-server', '--stdio']
const PY_NPX_ARGS = ['-y', '-p', 'pyright', 'pyright-langserver', '--stdio']

const REGISTRY_BY_EXT: Record<string, LspServerSpec> = {
  '.ts': { language: 'typescript', languageId: 'typescript', npxArgs: TS_NPX_ARGS },
  '.tsx': { language: 'typescript', languageId: 'typescriptreact', npxArgs: TS_NPX_ARGS },
  '.mts': { language: 'typescript', languageId: 'typescript', npxArgs: TS_NPX_ARGS },
  '.cts': { language: 'typescript', languageId: 'typescript', npxArgs: TS_NPX_ARGS },
  '.js': { language: 'typescript', languageId: 'javascript', npxArgs: TS_NPX_ARGS },
  '.jsx': { language: 'typescript', languageId: 'javascriptreact', npxArgs: TS_NPX_ARGS },
  '.mjs': { language: 'typescript', languageId: 'javascript', npxArgs: TS_NPX_ARGS },
  '.cjs': { language: 'typescript', languageId: 'javascript', npxArgs: TS_NPX_ARGS },
  '.py': { language: 'python', languageId: 'python', npxArgs: PY_NPX_ARGS },
}

/** All language ids in the registry, for the `install_lsp` tool's parameter description and for
 *  validating an explicit `language` argument against a real, supported entry. */
export const SUPPORTED_LSP_LANGUAGES = [...new Set(Object.values(REGISTRY_BY_EXT).map((s) => s.language))]

/** Extension → spec lookup, case-insensitive. Returns null for anything not in the v1 registry —
 *  callers must treat that as "no LSP available for this file", not an error. */
export function lspSpecForPath(path: string): LspServerSpec | null {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return null
  const ext = path.slice(dot).toLowerCase()
  return REGISTRY_BY_EXT[ext] ?? null
}

/** Looks up a spec by its `language` key directly (used by the `install_lsp` tool, which takes a
 *  language name rather than a file path). */
export function lspSpecForLanguage(language: string): LspServerSpec | null {
  const norm = language.trim().toLowerCase()
  return Object.values(REGISTRY_BY_EXT).find((s) => s.language === norm) ?? null
}
