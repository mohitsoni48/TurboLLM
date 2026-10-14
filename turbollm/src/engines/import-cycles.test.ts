// Guards the engine-install import graph against cycles. The release-install flow wires
// download.ts, scan.ts, zip-install.ts and update.ts together; a cycle through any of them
// surfaces as an undefined binding at module load, not as a type error. Only VALUE imports
// count (`import type` is erased), so the graph is built from the source text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const WATCHED = [
  'engines/download.ts',
  'engines/scan.ts',
  'engines/zip-install.ts',
  'engines/zip-reader.ts',
  'engines/github-repo.ts',
  'engines/release-assets.ts',
  'engines/release-install.ts',
  'engines/update.ts',
  'engines/update-apply.ts',
]

const LEAVES = ['engines/zip-reader.ts', 'engines/github-repo.ts']

/** Pre-existing cycles through a watched file, each as the sorted member list joined by ' > '.
 *  Add an entry only with a comment saying why it is not this change's to fix. */
const ALLOWED_CYCLES: string[] = []

const NAMED_CLAUSE = String.raw`\{[^}]*\}`
const NAMESPACE_CLAUSE = String.raw`\*(?:\s+as\s+\w+)?`
const IMPORT_CLAUSE = String.raw`(?:\w+\s*,\s*(?:${NAMED_CLAUSE}|${NAMESPACE_CLAUSE})|\w+|${NAMED_CLAUSE}|${NAMESPACE_CLAUSE})`
const EXPORT_CLAUSE = String.raw`(?:${NAMED_CLAUSE}|${NAMESPACE_CLAUSE})`
const VALUE_IMPORT = new RegExp(
  String.raw`^[ \t]*(?:import\s+${IMPORT_CLAUSE}|export\s+${EXPORT_CLAUSE}|import)\s*(?:from\s*)?['"](\.[^'"]+)['"]`,
  'gm',
)

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return entry === 'test-support' ? [] : sourceFiles(full)
    return full.endsWith('.ts') && !full.endsWith('.test.ts') && !full.endsWith('.d.ts') ? [full] : []
  })
}

function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec)
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) if (existsSync(candidate)) return candidate
  return null
}

function relativeValueImports(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const targets = [...text.matchAll(VALUE_IMPORT)].map((m) => resolveRelative(file, m[1]!))
  return targets.filter((t): t is string => t !== null)
}

function buildGraph(): Map<string, string[]> {
  return new Map(sourceFiles(SRC_ROOT).map((file) => [file, relativeValueImports(file)]))
}

/** Strongly connected components with more than one member, plus self-loops (Tarjan). */
function cyclicComponents(graph: Map<string, string[]>): string[][] {
  let counter = 0
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const found: string[][] = []

  const visit = (node: string): void => {
    index.set(node, counter)
    low.set(node, counter)
    counter++
    stack.push(node)
    onStack.add(node)
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next)
        low.set(node, Math.min(low.get(node)!, low.get(next)!))
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, index.get(next)!))
      }
    }
    if (low.get(node) !== index.get(node)) return
    const component: string[] = []
    let member: string
    do {
      member = stack.pop()!
      onStack.delete(member)
      component.push(member)
    } while (member !== node)
    if (component.length > 1 || (graph.get(node) ?? []).includes(node)) found.push(component)
  }

  for (const node of graph.keys()) if (!index.has(node)) visit(node)
  return found
}

const asSrcPath = (file: string): string => file.slice(SRC_ROOT.length + 1).split(sep).join('/')

test('leaf modules import nothing relative by value', () => {
  for (const leaf of LEAVES) {
    const file = join(SRC_ROOT, leaf)
    if (!existsSync(file)) continue
    assert.deepEqual(relativeValueImports(file).map(asSrcPath), [], `${leaf} must stay a leaf`)
  }
})

test('no import cycle runs through the engine-install modules', () => {
  const watched = new Set(WATCHED.map((w) => join(SRC_ROOT, w)))
  const offending = cyclicComponents(buildGraph())
    .filter((component) => component.some((file) => watched.has(file)))
    .map((component) => component.map(asSrcPath).sort().join(' > '))
    .filter((cycle) => !ALLOWED_CYCLES.includes(cycle))
  assert.deepEqual(offending, [])
})

test('the graph sees a known value import', () => {
  const graph = buildGraph()
  const edgesOf = (file: string): string[] => (graph.get(join(SRC_ROOT, file)) ?? []).map(asSrcPath)
  assert.ok(edgesOf('engines/scan.ts').includes('engines/download.ts'), 'scan.ts imports findFile from download.ts')
})
