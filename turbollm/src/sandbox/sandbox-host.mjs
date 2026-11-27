// The Python sandbox's host (GitHub #52): runs inside Deno, loads Pyodide from the installed runtime, and runs the
// code the daemon sends. Plain JS with no imports, run straight from the package (dist/sandbox-host.mjs once built):
// Deno loads its main module without a read grant, and everything else it reads is the Pyodide folder it is granted.
//
// Started by sandbox-process.ts with no network, no env, no writes and no subprocesses:
//   deno run --no-prompt --no-config --no-npm --no-remote --unstable-detect-cjs --allow-read=<pyodide>
//     --v8-flags=--wasm-max-mem-pages=8192 sandbox-host.mjs <pyodide>
//
// The daemon treats this whole process as hostile, its stdout included (sandboxed code can reach Deno.stdout through a
// JS escape). This file only has to be correct, not trusted: frames are checked on the daemon side (sandbox-frames.ts).
//
// Frames, both ways: a 4-byte big-endian header length, the header as UTF-8 JSON, then `size` raw bytes.
//   daemon → host  { t: 'run', size, code, files: [{ name, size }] }   payload: the files' bytes, in order
//   host → daemon  { t: 'ready', size: 0 }                            once Pyodide has loaded
//                  { t: 'result', size, ok, error?, stdout, stderr, files: [{ name, size }] }
//                                                                    payload: stdout, stderr, then each file's bytes
//                  { t: 'fatal', size: 0, error }                     start-up failed; the process exits after it

const [pyodideDir] = Deno.args
const WORK = '/work'
const TEXT_LIMIT = 64 * 1024
const OUTPUT_TYPES = /\.(png|jpe?g|csv|json|txt|py)$/i
const MAX_OUTPUT_FILES = 20
const MAX_OUTPUT_FILE = 25 * 1024 * 1024
const MAX_OUTPUT_TOTAL = 100 * 1024 * 1024

// Anything printed to stdout outside a frame breaks the stream, so nothing here may print. Pyodide's own messages
// ("Loading numpy") go to callbacks below; console is silenced for whatever else would reach it.
for (const k of ['log', 'info', 'warn', 'error', 'debug', 'trace']) console[k] = () => {}

const enc = new TextEncoder()
const dec = new TextDecoder()

async function writeAll(bytes) {
  let off = 0
  while (off < bytes.length) off += await Deno.stdout.write(bytes.subarray(off))
}

async function send(header, parts = []) {
  const h = enc.encode(JSON.stringify(header))
  const len = new Uint8Array(4)
  new DataView(len.buffer).setUint32(0, h.length)
  await writeAll(len)
  await writeAll(h)
  for (const p of parts) await writeAll(p)
}

// Reads frames from stdin. Yields { header, payload }.
async function* frames() {
  // Chunks are kept as they arrive and joined once per take, so a large input is copied once, not once per chunk.
  const reader = Deno.stdin.readable.getReader()
  const chunks = []
  let have = 0
  const need = async (n) => {
    while (have < n) {
      const { value, done } = await reader.read()
      if (done) return false
      chunks.push(value)
      have += value.length
    }
    return true
  }
  const take = (n) => {
    const out = new Uint8Array(n)
    let filled = 0
    while (filled < n) {
      const c = chunks[0]
      const k = Math.min(c.length, n - filled)
      out.set(c.subarray(0, k), filled)
      filled += k
      if (k === c.length) chunks.shift()
      else chunks[0] = c.subarray(k)
    }
    have -= n
    return out
  }
  for (;;) {
    if (!(await need(4))) return
    const hlen = new DataView(take(4).buffer).getUint32(0)
    if (!(await need(hlen))) return
    const header = JSON.parse(dec.decode(take(hlen)))
    if (!(await need(header.size))) return
    yield { header, payload: take(header.size) }
  }
}

// The daemon refuses a whole result over one name it does not accept (sandbox-process.ts OUTPUT_NAME, MAX_SKIPPED),
// so an honest result fits its rules: `Umsätze.png` goes as `Umsatze.png`, a 200-letter name is shortened.
const OUTPUT_NAME_CHARS = /[^A-Za-z0-9._ ()-]/g
const MAX_NAME = 128
const MAX_SKIPPED = 200

function sendableName(name, used) {
  const dot = name.lastIndexOf('.')
  const ext = name.slice(dot) // OUTPUT_TYPES matched it: a plain ASCII extension
  const base = name.slice(0, dot).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(OUTPUT_NAME_CHARS, '_').slice(0, MAX_NAME - ext.length - 4) || 'file'
  let out = base + ext
  for (let k = 2; used.has(out.toLowerCase()); k++) out = `${base}-${k}${ext}`
  used.add(out.toLowerCase())
  return out
}

// The code's own name goes along (`as`) when the sendable one differs, so a fresh sandbox gets the file back under it:
// only a name that passes the daemon's rule (sandbox-process.ts isSandboxName), else none and the result still stands.
function sandboxName(name, sent) {
  if (name === sent || name.length > MAX_NAME || name === '.' || name === '..' || /[/\\\p{C}\p{Zl}\p{Zp}]/u.test(name)) return undefined
  return name
}

function capped(text) {
  const bytes = enc.encode(text)
  if (bytes.length <= TEXT_LIMIT) return bytes
  return enc.encode(dec.decode(bytes.subarray(0, TEXT_LIMIT)) + '\n[output cut off]')
}

let py
try {
  const { loadPyodide } = await import((Deno.build.os === 'windows' ? 'file:///' : 'file://') + pyodideDir.replace(/\\/g, '/') + '/pyodide.mjs')
  py = await loadPyodide({ indexURL: pyodideDir.replace(/\\/g, '/') + '/', stdout: () => {}, stderr: () => {} })
  py.FS.mkdirTree(WORK)
  py.FS.chdir(WORK)
  // os.system and friends would leave the run waiting on a process that can never start; with nothing else pending,
  // Deno ends the whole sandbox ("Top-level await promise never resolved"). Fail them the way subprocess already does.
  py.runPython([
    'import os',
    "os.environ['MPLBACKEND'] = 'Agg'",
    'def _no_programs(*args, **kwargs):',
    "    raise OSError(138, 'starting programs is not supported in this sandbox')",
    "for _name in ('system', 'popen', 'fork', 'forkpty', 'posix_spawn', 'posix_spawnp', 'execv', 'execve', 'execvp', 'execvpe', 'execl', 'execle', 'execlp', 'execlpe', 'spawnv', 'spawnve', 'spawnvp', 'spawnvpe', 'spawnl', 'spawnle', 'spawnlp', 'spawnlpe'):",
    '    if hasattr(os, _name):',
    '        setattr(os, _name, _no_programs)',
    'del _name, _no_programs',
  ].join('\n'))
  // Nothing here uses Workers, and a Worker asking for Deno permissions ends the process outright (an unstable option
  // Deno refuses by exiting, not by throwing). Out of the sandboxed code's reach; the polite Stop (PR 4) will keep a
  // private reference for its own worker before this runs.
  delete globalThis.Worker
} catch (e) {
  await send({ t: 'fatal', size: 0, error: String(e?.message ?? e).split('\n')[0].slice(0, 500) })
  Deno.exit(1)
}
await send({ t: 'ready', size: 0 })

function listWork() {
  const out = new Map()
  for (const name of py.FS.readdir(WORK)) {
    if (name === '.' || name === '..') continue
    const st = py.FS.stat(`${WORK}/${name}`)
    if (py.FS.isFile(st.mode)) out.set(name, `${st.size}:${st.mtime instanceof Date ? st.mtime.getTime() : st.mtime}`)
  }
  return out
}

for await (const { header, payload } of frames()) {
  if (header.t !== 'run') continue
  let off = 0
  for (const f of header.files) {
    py.FS.writeFile(`${WORK}/${f.name}`, payload.subarray(off, off + f.size))
    off += f.size
  }
  const before = listWork()
  let stdout = ''
  let stderr = ''
  py.setStdout({ batched: (s) => { if (stdout.length <= TEXT_LIMIT) stdout += s + '\n' } })
  py.setStderr({ batched: (s) => { if (stderr.length <= TEXT_LIMIT) stderr += s + '\n' } })
  let ok = true
  let error
  try {
    await py.loadPackagesFromImports(header.code, { messageCallback: () => {}, errorCallback: () => {} })
    await py.runPythonAsync(header.code)
  } catch (e) {
    ok = false
    error = String(e?.message ?? e).split('\n').filter(Boolean).slice(-8).join('\n').slice(0, 4000)
  }
  // New or changed files of the allowed types, newest rules first: over a limit, the rest are named but not sent.
  const files = []
  const parts = []
  const skipped = []
  let unnamed = 0
  const skip = (name) => { if (skipped.length < MAX_SKIPPED - 1) skipped.push(name.slice(0, 256)); else unnamed++ }
  const used = new Set()
  let total = 0
  for (const [name, stamp] of listWork()) {
    if (before.get(name) === stamp) continue
    if (!OUTPUT_TYPES.test(name)) { skip(name); continue }
    const bytes = py.FS.readFile(`${WORK}/${name}`)
    if (files.length >= MAX_OUTPUT_FILES || bytes.length > MAX_OUTPUT_FILE || total + bytes.length > MAX_OUTPUT_TOTAL) { skip(name); continue }
    const sent = sendableName(name, used)
    const as = sandboxName(name, sent)
    files.push({ name: sent, size: bytes.length, ...(as === undefined ? {} : { as }) })
    parts.push(bytes)
    total += bytes.length
  }
  if (unnamed) skipped.push(`…and ${unnamed} more`)
  const out = capped(stdout)
  const err = capped(stderr)
  await send({ t: 'result', size: out.length + err.length + total, ok, error, stdout: out.length, stderr: err.length, files, skipped }, [out, err, ...parts])
}
