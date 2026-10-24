// The scanner behind raw-spawn-guard.test.ts: every place in src that starts a process without util/tether.ts.
//
// It reads each non-test source file with the TypeScript compiler API (a devDependency) and finds every binding of
// `child_process` / `node:child_process` and of `node-pty`, by every route a module can be reached: a static
// import (named, default, namespace), `import()`, `require()`, a `createRequire(...)` function, and
// `process.getBuiltinModule()`; a `promisify(...)` of a spawn function and a plain alias count as bindings too.
// Each value use of a spawn function through one of them (a call, or the function passed on as a value) is a site,
// keyed `<file>#<enclosing function>:<callee>`. Types (`typeof spawn`, `import('node-pty').IPty`) are not uses.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'

/** The functions of child_process that start a process. */
const SPAWNERS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
const CHILD_PROCESS = new Set(['child_process', 'node:child_process'])
const PTY = 'node-pty'

/** Directories that are not the daemon: built web assets and the tests' own helpers (cli.ts never imports them). */
const SKIPPED_DIRS = new Set(['node_modules', 'webdist', 'test-support'])

export function sourceFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : sourceFilesUnder(path)
    if (!/\.(ts|mts|mjs|cjs)$/.test(entry.name) || /\.test\.(ts|mts|mjs|cjs)$/.test(entry.name) || entry.name.endsWith('.d.ts')) return []
    return [path]
  })
}

type Binding = { kind: 'fn'; name: string } | { kind: 'ns'; module: 'cp' | 'pty' } | { kind: 'require' } | { kind: 'class' }

function moduleOf(spec: string): 'cp' | 'pty' | null {
  if (CHILD_PROCESS.has(spec)) return 'cp'
  if (spec === PTY) return 'pty'
  return null
}

function unwrap(e: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression
    else return e
  }
}

/** The enclosing named function of `node`, as `Class.method`, `name`, `obj.prop` or `<module>`. */
function enclosingName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text
    if ((ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)) && ts.isIdentifier(n.name)) {
      const cls = n.parent && ts.isClassLike(n.parent) && n.parent.name ? `${n.parent.name.text}.` : ''
      return `${cls}${n.name.text}`
    }
    if (ts.isConstructorDeclaration(n) && n.parent.name) return `${n.parent.name.text}.constructor`
    if (ts.isFunctionExpression(n) || ts.isArrowFunction(n)) {
      if (ts.isFunctionExpression(n) && n.name) return n.name.text
      const p = n.parent
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
      if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return p.name.text
      if (ts.isPropertyDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
      if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) return p.left.getText()
    }
  }
  return '<module>'
}

function inType(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isTypeNode(n) || ts.isImportTypeNode(n)) return true
    if (ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n)) return true
    if (ts.isStatement(n) || ts.isBlock(n)) return false
  }
  return false
}

/** True when `e` loads child_process or node-pty: `import(m)`, `require(m)`, `<createRequire fn>(m)`,
 *  `process.getBuiltinModule(m)`. */
function loads(e: ts.Expression, requires: Set<string>): 'cp' | 'pty' | null {
  e = unwrap(e)
  if (!ts.isCallExpression(e) || e.arguments.length < 1 || !ts.isStringLiteralLike(e.arguments[0])) return null
  const spec = e.arguments[0].text
  const callee = e.expression
  const isImport = callee.kind === ts.SyntaxKind.ImportKeyword
  const isRequire = ts.isIdentifier(callee) && (callee.text === 'require' || requires.has(callee.text))
  const isBuiltin = ts.isPropertyAccessExpression(callee) && callee.name.text === 'getBuiltinModule'
  return isImport || isRequire || isBuiltin ? moduleOf(spec) : null
}

/** Every raw spawn site in `file`, keyed `<rel>#<function>:<callee>`. */
export function rawSpawnSites(file: string, root: string): Set<string> {
  const rel = relative(root, file).split(sep).join('/')
  const text = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.ts') || file.endsWith('.mts') ? ts.ScriptKind.TS : ts.ScriptKind.JS)
  const bindings = new Map<string, Binding>()
  const requires = new Set<string>()
  const sites = new Set<string>()
  const site = (node: ts.Node, callee: string) => sites.add(`${rel}#${enclosingName(node)}:${callee}`)

  // Pass 1: bindings. Repeated until nothing new is found, so an alias of an alias is seen.
  const bind = (name: string, b: Binding) => { if (!bindings.has(name)) { bindings.set(name, b); changed = true } }
  let changed = true
  while (changed) {
    changed = false
    const visit = (n: ts.Node): void => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && !n.importClause?.isTypeOnly) {
        const m = moduleOf(n.moduleSpecifier.text)
        const clause = n.importClause
        if (m && clause) {
          if (clause.name) bind(clause.name.text, { kind: 'ns', module: m })
          const nb = clause.namedBindings
          if (nb && ts.isNamespaceImport(nb)) bind(nb.name.text, { kind: 'ns', module: m })
          if (nb && ts.isNamedImports(nb)) {
            for (const el of nb.elements) {
              if (el.isTypeOnly) continue
              const imported = (el.propertyName ?? el.name).text
              if (m === 'cp' && SPAWNERS.has(imported)) bind(el.name.text, { kind: 'fn', name: imported })
              if (m === 'cp' && imported === 'ChildProcess') bind(el.name.text, { kind: 'class' })
              if (m === 'pty' && imported === 'spawn') bind(el.name.text, { kind: 'fn', name: 'pty.spawn' })
            }
          }
        }
        if (n.moduleSpecifier.text === 'node:module' || n.moduleSpecifier.text === 'module') {
          const nb = clause?.namedBindings
          if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if ((el.propertyName ?? el.name).text === 'createRequire') bind(el.name.text, { kind: 'fn', name: 'createRequire' })
        }
      }
      if (ts.isVariableDeclaration(n) && n.initializer) {
        const init = unwrap(n.initializer)
        // const require = createRequire(import.meta.url)
        if (ts.isIdentifier(n.name) && ts.isCallExpression(init) && ts.isIdentifier(init.expression)) {
          const b = bindings.get(init.expression.text)
          if (b?.kind === 'fn' && b.name === 'createRequire' && !requires.has(n.name.text)) { requires.add(n.name.text); changed = true }
        }
        const m = loads(init, requires)
        if (m && ts.isIdentifier(n.name)) bind(n.name.text, { kind: 'ns', module: m })
        if (m && ts.isObjectBindingPattern(n.name)) {
          for (const el of n.name.elements) {
            const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : ''
            if (!ts.isIdentifier(el.name)) continue
            if (m === 'cp' && SPAWNERS.has(prop)) bind(el.name.text, { kind: 'fn', name: prop })
            if (m === 'pty' && prop === 'spawn') bind(el.name.text, { kind: 'fn', name: 'pty.spawn' })
          }
        }
        // const run = promisify(execFile) / util.promisify(cp.execFile) / const s = spawn
        if (ts.isIdentifier(n.name)) {
          const wrapped = ts.isCallExpression(init) && init.arguments.length === 1 && /(^|\.)promisify$/.test(init.expression.getText()) ? unwrap(init.arguments[0]) : init
          if (ts.isIdentifier(wrapped) && bindings.get(wrapped.text)?.kind === 'fn' && (bindings.get(wrapped.text) as { name: string }).name !== 'createRequire') bind(n.name.text, { kind: 'fn', name: n.name.text })
          if (ts.isPropertyAccessExpression(wrapped) && ts.isIdentifier(wrapped.expression) && bindings.get(wrapped.expression.text)?.kind === 'ns' && SPAWNERS.has(wrapped.name.text)) bind(n.name.text, { kind: 'fn', name: n.name.text })
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }

  // Pass 2: uses.
  const visit = (n: ts.Node): void => {
    if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && moduleOf(n.moduleSpecifier.text)) site(n, 're-export')
    // A spawn function reached without a binding: `require('child_process').spawn(…)`, `(await import(m)).spawn`.
    if (ts.isPropertyAccessExpression(n) && SPAWNERS.has(n.name.text) && loads(n.expression, requires) && !inType(n)) site(n, n.name.text)
    if (ts.isIdentifier(n) && bindings.has(n.text) && !inType(n)) {
      const p = n.parent
      const declares = (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isBindingElement(p) ||
        ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isPropertyDeclaration(p) ||
        ts.isMethodDeclaration(p) || ts.isPropertyAssignment(p)) && (p as { name?: ts.Node }).name === n
      const isMember = ts.isPropertyAccessExpression(p) && p.name === n
      if (!declares && !isMember && !ts.isExportSpecifier(p)) {
        const b = bindings.get(n.text) as Binding
        if (b.kind === 'fn' && b.name !== 'createRequire') site(n, n.text)
        if (b.kind === 'ns' && ts.isPropertyAccessExpression(p) && p.expression === n && (SPAWNERS.has(p.name.text) || (b.module === 'pty' && p.name.text === 'spawn'))) {
          site(n, `${n.text}.${p.name.text}`)
        }
        if (b.kind === 'ns' && !(ts.isPropertyAccessExpression(p) && p.expression === n)) site(n, n.text) // the module object passed on
        if (b.kind === 'class' && ts.isPropertyAccessExpression(p) && p.expression === n && p.name.text === 'prototype') site(n, `${n.text}.prototype`)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return sites
}

/** Every raw spawn site under `srcRoot`. */
export function allRawSpawnSites(srcRoot: string): string[] {
  return sourceFilesUnder(srcRoot).flatMap((f) => [...rawSpawnSites(f, srcRoot)]).sort()
}

/** Of the listed sites (`<file>#<function>:<callee>`, as rawSpawnSites keys them), those where a call of `callee` in
 *  that function passes no `timeout` in an options object written at the call, or where no such call is found. For
 *  the guard's claim that each synchronous call is bounded by its own timeout. */
export function untimedCalls(srcRoot: string, sites: string[]): string[] {
  const out: string[] = []
  for (const key of sites) {
    const m = /^(.+)#(.+):(.+)$/.exec(key)
    if (!m) {
      out.push(key)
      continue
    }
    const [, rel, fn, callee] = m
    const file = join(srcRoot, ...rel.split('/'))
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    let calls = 0
    let timed = 0
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && n.expression.getText() === callee && enclosingName(n) === fn) {
        calls++
        const opts = n.arguments[n.arguments.length - 1]
        const hasTimeout = opts !== undefined && ts.isObjectLiteralExpression(opts) && opts.properties.some((p) =>
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name) && p.name.text === 'timeout')
        if (hasTimeout) timed++
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
    if (calls === 0 || timed < calls) out.push(key)
  }
  return out
}
