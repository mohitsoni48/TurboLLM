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
  py.runPython("import os\nos.environ['MPLBACKEND'] = 'Agg'")
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
  let total = 0
  for (const [name, stamp] of listWork()) {
    if (before.get(name) === stamp) continue
    if (!OUTPUT_TYPES.test(name)) { skipped.push(name); continue }
    const bytes = py.FS.readFile(`${WORK}/${name}`)
    if (files.length >= MAX_OUTPUT_FILES || bytes.length > MAX_OUTPUT_FILE || total + bytes.length > MAX_OUTPUT_TOTAL) { skipped.push(name); continue }
    files.push({ name, size: bytes.length })
    parts.push(bytes)
    total += bytes.length
  }
  const out = capped(stdout)
  const err = capped(stderr)
  await send({ t: 'result', size: out.length + err.length + total, ok, error, stdout: out.length, stderr: err.length, files, skipped }, [out, err, ...parts])
}
