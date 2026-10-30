// The Code agent's grep and find (search-tools.ts) run rg and fd through util/tether.ts. pi's own tools spawned them
// raw, so a daemon that died during a search left rg or fd running, parented to init (a search with no match writes
// nothing, so it never died at a write). TurboLLM's execute is a port of pi 0.80.6's, so these tests run pi's own tool
// and TurboLLM's on the same fixtures and require the same result, then show the search ends with a SIGKILLed daemon
// and with a Stop. Also here: a repository's own pi extensions no longer load into the daemon.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { after, test } from 'node:test'
import {
  createAgentSession,
  createBashTool,
  createFindToolDefinition,
  createGrepToolDefinition,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { createSearchToolDefinitions, findSearchTool, searchToolsFor } from './search-tools'
import { toolsForMode } from './persona'
import { renameWithRetry } from '../engines/download'
import { stopTethered } from '../util/tether'
import { isGone, killRecorded, pidWrittenTo, record, srcUrl, startStandInDaemon, waitGone } from '../test-support/stand-in-daemon'
import { tmpGitRepo } from '../test-support/git-repo'
import { tmpDir } from '../test-support/tmp'

const POSIX = process.platform === 'win32' ? 'POSIX stand-ins and a FIFO' : false
const noRg = findSearchTool('rg') === null ? 'ripgrep (rg) is not installed (CI installs it)' : false
const noFd = findSearchTool('fd') === null ? 'fd is not installed (CI installs it)' : false
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const ctx = undefined as never

/** A tree with hidden, gitignored, long-line, many-match and nested files. */
function fixture(root: string): string {
  mkdirSync(join(root, 'src', 'deep'), { recursive: true })
  mkdirSync(join(root, '.hidden'), { recursive: true })
  writeFileSync(join(root, 'a.ts'), 'const foo = 1\nconst Foo = 2\nfunction bar() { return foo }\n// a.b and axb\n')
  writeFileSync(join(root, 'notes.md'), 'line one\nfoo in notes\nline three\nline four\nfoo again\nlast\n')
  writeFileSync(join(root, 'src', 'b.spec.ts'), 'describe("foo", () => {})\n')
  writeFileSync(join(root, 'src', 'deep', 'c.spec.ts'), 'it("FOO bar")\n')
  writeFileSync(join(root, 'src', 'c.js'), 'module.exports = { foo: true }\r\nwindows line\r\n')
  writeFileSync(join(root, '.hidden', 'h.txt'), 'foo hidden\n')
  writeFileSync(join(root, 'ignored.log'), 'foo ignored\n')
  writeFileSync(join(root, '.gitignore'), '*.log\n')
  writeFileSync(join(root, 'long.txt'), `start ${'x'.repeat(700)} foo ${'y'.repeat(50)}\n`)
  writeFileSync(join(root, 'many.txt'), Array.from({ length: 150 }, (_, i) => `foo ${i}`).join('\n') + '\n')
  return root
}

/** rg searches files on several threads, so the order of its matches differs from run to run. Both tools spawn rg
 *  with the daemon's environment, so a config file sorting by path makes both deterministic, and the same. */
function sortedRg(): () => void {
  const config = join(tmpDir('tllm-rg-config-'), 'rgrc')
  writeFileSync(config, '--sort=path\n')
  const before = process.env.RIPGREP_CONFIG_PATH
  process.env.RIPGREP_CONFIG_PATH = config
  return () => {
    if (before === undefined) delete process.env.RIPGREP_CONFIG_PATH
    else process.env.RIPGREP_CONFIG_PATH = before
  }
}

async function outcome<T>(p: Promise<T>): Promise<T | { rejected: string }> {
  try {
    return await p
  } catch (e) {
    return { rejected: (e as Error).message }
  }
}

/** `p`, or a rejection naming `what` once `ms` have passed. Every wait in this file is bounded, so a search that never
 *  settles fails its case instead of holding the file, and every file after it, open: CI's macOS job hung for hours
 *  here, behind a Stop case that never found its rg and so never stopped it (pidsOf). */
function within<T>(p: Promise<T>, what: string, ms = 30_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: not settled within ${ms} ms`)), ms) })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

// Whatever a failed case left running through the tether here (an rg or fd still searching), ended, so this file's
// process can exit and report.
after(() => stopTethered(1000))

test('grep returns exactly what pi\'s own grep returns, on every case of the fixture', { skip: noRg }, async () => {
  const restore = sortedRg()
  try {
    const outside = fixture(tmpDir('tllm-grep-outside-'))
    const repo = fixture(tmpGitRepo('tllm-grep-repo-'))
    const other = fixture(tmpDir('tllm-grep-other-'))
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['regex', outside, { pattern: 'fo+' }],
      ['literal', outside, { pattern: 'a.b', literal: true }],
      ['regex dot', outside, { pattern: 'a.b' }],
      ['ignoreCase', outside, { pattern: 'FOO', ignoreCase: true }],
      ['glob', outside, { pattern: 'foo', glob: '*.ts' }],
      ['glob with a path', outside, { pattern: 'foo', glob: '**/*.spec.ts', ignoreCase: true }],
      ['context 0', outside, { pattern: 'foo', path: 'notes.md', context: 0 }],
      ['context 2', outside, { pattern: 'foo', path: 'notes.md', context: 2 }],
      ['context 2 over a CRLF file', outside, { pattern: 'foo', path: 'src', context: 2 }],
      ['hit limit', outside, { pattern: 'foo', limit: 5 }],
      ['the default limit', outside, { pattern: 'foo', path: 'many.txt' }],
      ['no match', outside, { pattern: 'zz_never_matches_zz' }],
      ['a file path', outside, { pattern: 'foo', path: 'a.ts' }],
      ['a path outside the cwd', outside, { pattern: 'foo', path: join(other, 'src') }],
      ['a path that does not exist', outside, { pattern: 'foo', path: 'missing' }],
      ['a long line', outside, { pattern: 'foo', path: 'long.txt' }],
      // rg's --glob overrides ignore files, so these name no glob.
      ['gitignored and hidden files, in a git repo', repo, { pattern: 'foo (hidden|ignored)' }],
      ['gitignored and hidden files, outside one', outside, { pattern: 'foo (hidden|ignored)' }],
      ['a bad regex', outside, { pattern: '(' }],
      ['a path with a leading @', outside, { pattern: 'foo', path: '@src/deep', ignoreCase: true }],
    ]
    for (const [name, cwd, params] of cases) {
      const pi = await outcome(within(createGrepToolDefinition(cwd).execute('t', params as never, undefined, undefined, ctx), `pi's grep: ${name}`))
      const ours = await outcome(within(createSearchToolDefinitions(cwd).grep.execute('t', params as never, undefined, undefined, ctx), `grep: ${name}`))
      assert.deepEqual(ours, pi, `grep: ${name}`)
    }
  } finally {
    restore()
  }
})

/** fd walks the tree on several threads and has no config file, so the order of its lines differs from run to run:
 *  compare them sorted (the notice, after a blank line, stays last). */
function sortFindText(r: unknown): unknown {
  const x = r as { content?: Array<{ type: string; text: string }>; details?: unknown }
  if (!x.content) return r
  return {
    ...x,
    content: x.content.map((c) => {
      const [body, ...notice] = c.text.split('\n\n')
      return { ...c, text: [body.split('\n').sort().join('\n'), ...notice].join('\n\n') }
    }),
  }
}

test('find returns exactly what pi\'s own find returns, on every case of the fixture', { skip: noFd }, async () => {
  const outside = fixture(tmpDir('tllm-find-outside-'))
  const repo = fixture(tmpGitRepo('tllm-find-repo-'))
  const other = fixture(tmpDir('tllm-find-other-'))
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['a name glob', outside, { pattern: '*.ts' }],
    ['a path glob', outside, { pattern: 'src/**/*.spec.ts' }],
    ['a path glob from **/', outside, { pattern: '**/*.spec.ts' }],
    ['no match', outside, { pattern: '*.nothing' }],
    ['hidden files', outside, { pattern: '*.txt' }],
    ['gitignored files, in a git repo', repo, { pattern: '*.log' }],
    ['gitignored files, outside one', outside, { pattern: '*.log' }],
    ['a path outside the cwd', outside, { pattern: '*.js', path: other }],
    ['a path that does not exist', outside, { pattern: '*.ts', path: 'missing' }],
    ['a subdirectory', outside, { pattern: '*', path: 'src' }],
  ]
  for (const [name, cwd, params] of cases) {
    const pi = await outcome(within(createFindToolDefinition(cwd).execute('t', params as never, undefined, undefined, ctx), `pi's find: ${name}`))
    const ours = await outcome(within(createSearchToolDefinitions(cwd).find.execute('t', params as never, undefined, undefined, ctx), `find: ${name}`))
    assert.deepEqual(sortFindText(ours), sortFindText(pi), `find: ${name}`)
  }
  // A limit picks whichever files fd reaches first: the same count, notice and details, each line a real match.
  const all = new Set(((await within(createFindToolDefinition(outside).execute('t', { pattern: '*' }, undefined, undefined, ctx), 'pi\'s find: all')).content[0] as { text: string }).text.split('\n'))
  const pi = await within(createFindToolDefinition(outside).execute('t', { pattern: '*', limit: 3 }, undefined, undefined, ctx), 'pi\'s find: a limit')
  const ours = await within(createSearchToolDefinitions(outside).find.execute('t', { pattern: '*', limit: 3 }, undefined, undefined, ctx), 'find: a limit')
  assert.deepEqual(ours.details, pi.details)
  const [oursBody, oursNotice] = (ours.content[0] as { text: string }).text.split('\n\n')
  const [piBody, piNotice] = (pi.content[0] as { text: string }).text.split('\n\n')
  assert.equal(oursNotice, piNotice)
  assert.equal(oursBody.split('\n').length, piBody.split('\n').length)
  for (const line of oursBody.split('\n')) assert.ok(all.has(line), `${line} is a real match`)
})

test('a daemon SIGKILLed during a search takes rg with it', { skip: POSIX || noRg }, async () => {
  // A search with no match writes nothing until it ends: rg reading a FIFO no one writes to never ends.
  const dir = tmpDir('tllm-grep-tether-')
  mkfifo(join(dir, 'never-written'))
  const d = await startStandInDaemon(`
import { createSearchToolDefinitions } from ${srcUrl('code/search-tools.ts')}
void createSearchToolDefinitions(${JSON.stringify(dir)}).grep.execute('t', { pattern: 'zz_never_zz', path: 'never-written' }, undefined, undefined, undefined as never).catch(() => {})
report({ started: true })
setInterval(() => {}, 1e9)
`)
  try {
    await d.next()
    const rg = await rgUnder(d.pid, dir)
    record(rg)
    await d.kill('SIGKILL')
    assert.deepEqual(await waitGone([rg], 1000), [], 'rg is gone within 1 s of the daemon')
  } finally {
    killRecorded(d.pid)
  }
})

test('a daemon SIGKILLed during a find takes fd with it', { skip: POSIX }, async () => {
  const dir = tmpDir('tllm-find-tether-')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const pidFile = join(dir, 'fd.pid')
  writeFileSync(join(bin, 'fd'), `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 300\n`)
  chmodSync(join(bin, 'fd'), 0o755)
  const d = await startStandInDaemon(`
import { createSearchToolDefinitions } from ${srcUrl('code/search-tools.ts')}
void createSearchToolDefinitions(${JSON.stringify(dir)}, { binDir: () => ${JSON.stringify(bin)} }).find.execute('t', { pattern: '*' }, undefined, undefined, undefined as never).catch(() => {})
report({ started: true })
setInterval(() => {}, 1e9)
`)
  try {
    await d.next()
    const fd = await pidWrittenTo(pidFile)
    record(fd)
    await d.kill('SIGKILL')
    assert.deepEqual(await waitGone([fd], 1000), [], 'fd is gone within 1 s of the daemon')
  } finally {
    killRecorded(d.pid)
  }
})

test('a Stop during a search kills rg and rejects as pi\'s grep does', { skip: POSIX || noRg }, async () => {
  const dir = tmpDir('tllm-grep-abort-')
  mkfifo(join(dir, 'never-written'))
  const ac = new AbortController()
  const before = new Set(rgPidsWithArg(dir))
  const p = outcome(createSearchToolDefinitions(dir).grep.execute('t', { pattern: 'zz', path: 'never-written' }, ac.signal, undefined, ctx))
  let rg = 0
  try {
    const deadline = Date.now() + 5000
    while (!rg && Date.now() < deadline) {
      rg = rgPidsWithArg(dir).find((x) => !before.has(x)) ?? 0
      if (!rg) await sleep(25)
    }
    assert.ok(rg > 0, 'rg started')
    record(rg)
    ac.abort()
    assert.deepEqual(await within(p, 'the stopped search', 5000), { rejected: 'Operation aborted' })
    assert.deepEqual(await waitGone([rg], 1000), [], 'rg is gone')
  } finally {
    // Whatever failed above, the search is stopped: its rg, reading a FIFO no one writes to, would never end, and
    // would hold this file's process open.
    ac.abort()
    await within(p, 'the stopped search', 5000).catch(() => {})
    killRecorded(rg)
  }
})

test('the lookup prefers pi\'s bin dir, then PATH, takes fdfind as fd, and warms up only when neither has one', { skip: POSIX }, () => {
  const dir = tmpDir('tllm-search-lookup-')
  const binDir = join(dir, 'pi-bin')
  const pathDir = join(dir, 'path')
  mkdirSync(binDir)
  mkdirSync(pathDir)
  const exe = (p: string) => { writeFileSync(p, '#!/bin/sh\n'); chmodSync(p, 0o755) }
  const deps = { binDir: () => binDir, env: { PATH: pathDir } }
  assert.equal(findSearchTool('rg', deps), null)
  assert.equal(findSearchTool('fd', deps), null)
  exe(join(pathDir, 'rg'))
  exe(join(pathDir, 'fdfind'))
  assert.equal(findSearchTool('rg', deps), 'rg', 'on PATH: the bare name, as pi returns it')
  assert.equal(findSearchTool('fd', deps), 'fdfind', 'Debian\'s name for fd')
  exe(join(pathDir, 'fd'))
  assert.equal(findSearchTool('fd', deps), 'fd', 'fd before fdfind')
  exe(join(binDir, 'rg'))
  exe(join(binDir, 'fd'))
  assert.equal(findSearchTool('rg', deps), join(binDir, 'rg'), 'pi\'s managed copy first')
  assert.equal(findSearchTool('fd', deps), join(binDir, 'fd'))
})

test('on Windows the lookup searches as libuv\'s spawn does: the cwd first, then PATH, quoted and relative entries too, each name as .com or .exe', () => {
  // Windows' rules on any OS: the platform and the daemon's cwd are injected, and the files are empty (only their
  // names count to the lookup). The next test checks the same rules against libuv itself, on Windows.
  const dir = tmpDir('tllm-search-winlookup-')
  const cwd = join(dir, 'cwd')
  const plain = join(dir, 'plain')
  const quoted = join(dir, 'one;two')
  for (const d of [join(cwd, 'rel'), plain, quoted, join(dir, 'pi-bin')]) mkdirSync(d, { recursive: true })
  const win = (env: NodeJS.ProcessEnv) => ({ platform: 'win32' as const, binDir: () => join(dir, 'pi-bin'), env, daemonCwd: () => cwd })
  assert.equal(findSearchTool('rg', win({ Path: plain })), null)
  writeFileSync(join(plain, 'rg'), '')
  assert.equal(findSearchTool('rg', win({ Path: plain })), null, 'a bare name is tried only as .com and .exe')
  writeFileSync(join(cwd, 'rg.exe'), '')
  assert.equal(findSearchTool('rg', win({ Path: plain })), 'rg', 'the daemon\'s cwd, before PATH')
  assert.equal(findSearchTool('rg', win({ Path: plain, NoDefaultCurrentDirectoryInExePath: '1' })), null, 'not when Windows is told to skip it')
  rmSync(join(cwd, 'rg.exe'))
  writeFileSync(join(quoted, 'rg.exe'), '')
  assert.equal(findSearchTool('rg', win({ Path: `${plain};"${quoted}"` })), 'rg', 'a quoted entry, with a ; inside')
  assert.equal(findSearchTool('rg', win({ PATH: `'${quoted}';${plain}` })), 'rg', 'single quotes, and PATH in any case')
  assert.equal(findSearchTool('rg', win({ Path: `${plain};${quoted}` })), null, 'unquoted, the ; splits it')
  writeFileSync(join(cwd, 'rel', 'fdfind.com'), '')
  assert.equal(findSearchTool('fd', win({ Path: `;${plain};;rel;` })), 'fdfind', 'a relative entry is taken from the cwd; .com counts')
  mkdirSync(join(plain, 'fd.exe'))
  assert.equal(findSearchTool('fd', win({ Path: plain })), null, 'a directory named fd.exe is not a program')
  writeFileSync(join(dir, 'pi-bin', 'rg.exe'), '')
  assert.equal(findSearchTool('rg', win({ Path: '' })), join(dir, 'pi-bin', 'rg.exe'), 'pi\'s managed copy first, as rg.exe')
})

test('on Windows the lookup finds a program exactly when libuv\'s own spawn does', { skip: process.platform === 'win32' ? false : 'libuv\'s Windows search' }, async () => {
  // pi asks by running `<name> --version` (its commandExists): a copy of node.exe answers it. Each layout puts that
  // one program in one place; the lookup and libuv must agree on it, for both PATH values.
  const dir = tmpDir('tllm-search-libuv-')
  const cwd = join(dir, 'cwd')
  const plain = join(dir, 'plain')
  const quoted = join(dir, 'one;two')
  for (const d of [join(cwd, 'rel'), plain, quoted]) mkdirSync(d, { recursive: true })
  let program = join(dir, 'node.exe')
  try {
    linkSync(process.execPath, program)
  } catch {
    copyFileSync(process.execPath, program)
  }
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'))
  const layouts = [join(cwd, 'rg.exe'), join(plain, 'rg.com'), join(quoted, 'rg.exe'), join(cwd, 'rel', 'rg.exe'), join(plain, 'rg'), join(dir, 'rg.exe')]
  const paths = [`${plain};"${quoted}";rel`, `${plain};${quoted}`]
  const noCwd = process.env.NoDefaultCurrentDirectoryInExePath
  try {
    for (const skipCwd of [false, true]) {
      // NeedCurrentDirectoryForExePathW reads the daemon's own environment, so this sets it for the test process.
      if (skipCwd) process.env.NoDefaultCurrentDirectoryInExePath = '1'
      for (const at of layouts) {
        // The program has just run, and hard-linked it is node.exe itself, which every node process of this job runs.
        // Windows refuses a rename while another process holds the file open without FILE_SHARE_DELETE (EBUSY; EPERM
        // or EACCES likewise), as a scanner or any other reader of a just-started program may for a moment (CI's
        // Windows job saw it once). renameWithRetry waits that out, as the daemon's own installs do; a rename never
        // allowed still fails here.
        await renameWithRetry(program, at)
        program = at
        for (const PATH of paths) {
          const env = { ...base, PATH, ...(skipCwd ? { NoDefaultCurrentDirectoryInExePath: '1' } : {}) }
          const ours = findSearchTool('rg', { platform: 'win32', binDir: () => join(dir, 'none'), env, daemonCwd: () => cwd }) !== null
          const libuv = spawnSync('rg', ['--version'], { cwd, env, stdio: 'ignore', windowsHide: true, timeout: 10_000 }).error === undefined
          assert.equal(ours, libuv, `rg at ${at}, PATH=${PATH}${skipCwd ? ', NoDefaultCurrentDirectoryInExePath set' : ''}`)
        }
      }
    }
  } finally {
    if (noCwd === undefined) delete process.env.NoDefaultCurrentDirectoryInExePath
    else process.env.NoDefaultCurrentDirectoryInExePath = noCwd
  }
})

test('with no rg anywhere, pi\'s warm-up runs once and the search uses what it installed; its failure is pi\'s error', { skip: POSIX }, async () => {
  const dir = tmpDir('tllm-search-warmup-')
  const binDir = join(dir, 'pi-bin')
  mkdirSync(binDir)
  const warmed: string[] = []
  const installing = {
    binDir: () => binDir,
    env: { PATH: join(dir, 'empty') },
    warmUp: async (tool: 'rg' | 'fd') => {
      warmed.push(tool)
      // What pi's ensureTool leaves behind: a managed rg that prints one match as rg --json does.
      writeFileSync(join(binDir, tool), `#!/bin/sh\nprintf '%s\\n' '{"type":"match","data":{"path":{"text":"${join(dir, 'f.txt')}"},"line_number":1,"lines":{"text":"hit\\n"}}}'\n`)
      chmodSync(join(binDir, tool), 0o755)
    },
  }
  writeFileSync(join(dir, 'f.txt'), 'hit\n')
  const r = await within(createSearchToolDefinitions(dir, installing).grep.execute('t', { pattern: 'hit' }, undefined, undefined, ctx), 'grep after the warm-up')
  assert.deepEqual(warmed, ['rg'])
  assert.deepEqual(r.content, [{ type: 'text', text: 'f.txt:1: hit' }])
  await within(createSearchToolDefinitions(dir, installing).grep.execute('t', { pattern: 'hit' }, undefined, undefined, ctx), 'grep, found the second time')
  assert.deepEqual(warmed, ['rg'], 'found the second time: no warm-up')

  const failing = { binDir: () => join(dir, 'none'), env: { PATH: join(dir, 'empty') }, warmUp: async () => { throw new Error('ripgrep (rg) is not available and could not be downloaded') } }
  assert.deepEqual(await outcome(within(createSearchToolDefinitions(dir, failing).grep.execute('t', { pattern: 'x' }, undefined, undefined, ctx), 'grep, a failed warm-up')),
    { rejected: 'ripgrep (rg) is not available and could not be downloaded' })
  const silent = { ...failing, warmUp: async () => {} }
  assert.deepEqual(await outcome(within(createSearchToolDefinitions(dir, silent).find.execute('t', { pattern: 'x' }, undefined, undefined, ctx), 'find, a silent warm-up')),
    { rejected: 'fd is not available and could not be downloaded' })
})

test('plan mode gets the tethered grep and find; auto and ask mode\'s tools are as they were', async () => {
  const cwd = tmpDir('tllm-search-modes-')
  assert.deepEqual(searchToolsFor(cwd, toolsForMode('auto')), [], 'no allowlist: pi would activate every custom tool')
  const session = async (tools: string[] | undefined) => {
    const agentDir = join(cwd, 'agent')
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true })
    await within(resourceLoader.reload(), 'the resource loader')
    const { session: s } = await within(createAgentSession({
      cwd, agentDir, resourceLoader, sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory(),
      customTools: [createBashTool(cwd), ...searchToolsFor(cwd, tools)], ...(tools ? { tools } : {}),
    }), 'createAgentSession')
    return s
  }
  const auto = await session(toolsForMode('auto'))
  assert.deepEqual(auto.getActiveToolNames(), ['read', 'bash', 'edit', 'write'])
  const plan = await session(toolsForMode('plan'))
  assert.ok(plan.getActiveToolNames().includes('grep') && plan.getActiveToolNames().includes('find'))
  const registered = searchToolsFor(cwd, toolsForMode('plan'))
  assert.deepEqual(registered.map((t) => t.name), ['grep', 'find'])
  assert.notEqual(registered[0].execute, createGrepToolDefinition(cwd).execute, 'TurboLLM\'s execute, not pi\'s')
  assert.equal(registered[0].description, createGrepToolDefinition(cwd).description, 'pi\'s definition otherwise')
})

test('a repository\'s own pi extensions do not load into the daemon; the inline ones still do', async () => {
  const repo = tmpDir('tllm-pi-ext-repo-')
  const marker = join(tmpDir('tllm-pi-ext-marker-'), 'loaded')
  mkdirSync(join(repo, '.pi', 'extensions'), { recursive: true })
  writeFileSync(join(repo, '.pi', 'extensions', 'x.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran in the daemon'); module.exports = () => {}\n`)
  let inline = 0
  // The options every loader in code-session.ts passes (the guard test requires noExtensions at each one).
  const load = async (noExtensions: boolean) => {
    const loader = new DefaultResourceLoader({
      cwd: repo, agentDir: join(repo, 'agent'), settingsManager: SettingsManager.inMemory(),
      extensionFactories: [{ name: 'turbollm-code', factory: () => { inline++ } }],
      noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, noExtensions,
    })
    await within(loader.reload(), 'the resource loader')
    return loader
  }
  await load(true)
  assert.equal(existsSync(marker), false, 'the repo\'s extension never ran')
  assert.equal(inline, 1, 'the inline extension factory still loads')
  // The hole, for the record: without noExtensions the same repo's code runs in this process.
  await load(false)
  assert.equal(readFileSync(marker, 'utf8'), 'ran in the daemon')
})

/** A FIFO (Node has no mkfifo of its own). */
function mkfifo(p: string): void {
  const r = spawnSync('mkfifo', [p], { timeout: 10_000 })
  assert.equal(r.status, 0, `mkfifo ${p}: ${String(r.stderr)}`)
}

/** The rg the stand-in daemon `pid` started over `dir` (the program itself: the wrapper execs it in place). Found by
 *  the test's own directory in its arguments, so a concurrent run of this file cannot be taken for it. */
async function rgUnder(pid: number, dir: string): Promise<number> {
  const deadline = Date.now() + 5000
  for (;;) {
    const found = rgPidsWithArg(dir)
    if (found.length > 0) return found[0]
    if (Date.now() >= deadline) throw new Error(`no rg under the stand-in daemon ${pid}`)
    await sleep(25)
  }
}

/** Live rg processes whose command line contains `marker`. */
function rgPidsWithArg(marker: string): number[] {
  return pidsOf('rg', marker)
}

/** Live processes named `comm` whose command line contains `marker`: the command lines first, as ps's last column,
 *  then each match's name, alone in its own (macOS's `comm` is the executable's path). They were read in one
 *  `pid=,comm=,args=`, but macOS's ps cuts a column that is not the last to its width: Homebrew's rg read
 *  `/opt/homebrew/bi`, nothing matched, and the Stop case, failing at "rg started", left its search (and its rg)
 *  running, so this file never ended and CI's macOS job hung behind it. */
function pidsOf(comm: string, marker: string): number[] {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8', timeout: 10_000 })
  const out: number[] = []
  for (const line of String(r.stdout ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!m || !m[2].includes(marker)) continue
    const name = String(spawnSync('ps', ['-o', 'comm=', '-p', m[1]], { encoding: 'utf8', timeout: 10_000 }).stdout ?? '').trim()
    if (basename(name) === comm && !isGone(Number(m[1]))) out.push(Number(m[1]))
  }
  return out
}
