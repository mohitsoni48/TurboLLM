// LiteRT-LM is a Python engine launched as a module with a --config file; its child env is the shared Python one.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter as pathDelimiter, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { ConfigStore, type Engine } from '../config/config'
import { engineCommand, pyEngineEnv, Manager, type StartOpts } from './manager'
import { litertLmConfigPath } from './litert-lm'
import { freePort } from '../test-support/stand-in-engine'
import { tmpDir } from '../test-support/tmp'

const engine = { id: 'lrt', kind: 'litert-lm', binPath: '/venv/bin/python', capabilities: { flags: [], kvTypes: [] } } as unknown as Engine

test('engineCommand: litert-lm launches the CLI module with the config path, loopback host and the port', () => {
  const opts = { engine, modelPath: '/models/m.litertlm', extraArgs: ['--verbose'] } as unknown as StartOpts
  assert.deepEqual(engineCommand(opts, 8090, undefined, '/data/engines/litert-lm/config-8090.json'), {
    cmd: '/venv/bin/python',
    args: ['-m', 'litert_lm_cli.main', 'serve', '--config', '/data/engines/litert-lm/config-8090.json', '--host', '127.0.0.1', '--port', '8090', '--verbose'],
  })
})

test('engineCommand: the model path is not a launch argument (it travels in each request)', () => {
  const opts = { engine, modelPath: '/models/m.litertlm', extraArgs: [] } as unknown as StartOpts
  const { args } = engineCommand(opts, 8090, undefined, 'c.json')
  assert.ok(!args.includes('/models/m.litertlm'))
})

test('pyEngineEnv: a LiteRT-LM child gets the Python-engine env (offline Hub, venv on PATH), not the native-engine one', (t: TestContext) => {
  const dataDir = tmpDir('turbollm-litert-env-')
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const python = join(dataDir, 'engines', 'litert-lm', 'venv', 'bin', 'python')
  const env = pyEngineEnv('litert-lm', dataDir, python)
  assert.equal(env?.HF_HUB_OFFLINE, '1')
  assert.equal(env?.HF_HOME, join(dataDir, 'hf-cache'))
  assert.ok(env?.PATH?.startsWith(join(dataDir, 'engines', 'litert-lm', 'venv', 'bin')))
  assert.equal(env?.LD_LIBRARY_PATH, process.env.LD_LIBRARY_PATH)
})

// ── the warm-up load failure must survive the exit handler (PR #271 review) ──────────
// readiness() diagnoses a bad model as model_load_failed and SIGKILLs the child; onTerminated
// used to protect only readiness_timeout, so the child's own 'close' event overwrote the
// actionable litertLmLoadFailureMessage with a generic "The engine process exited
// unexpectedly." This drives the REAL Manager end to end: preflight (fake litert_lm on
// PYTHONPATH) → spawn (fake `litert_lm_cli.main serve`, plain http.server) → /health ready →
// warm-up 500 → model_load_failed → SIGKILL → onTerminated, asserting the diagnosis survives.

const HAS_PYTHON = (() => {
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); return true } catch { return false }
})()

/** A stand-in `litert_lm_cli.main`: an HTTP server that is "ready" (/health, /v1/models → 200)
 *  but fails the first chat request, with the runtime's message in the 500's reason phrase. */
const FAKE_SERVE_PY = `
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[sys.argv.index('--port') + 1])

class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def _reply(self, code, reason, body):
        self.send_response_only(code, reason)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        self._reply(200, 'OK', b'{}')
    def do_POST(self):
        n = int(self.headers.get('content-length') or 0)
        if n:
            self.rfile.read(n)
        self._reply(500, 'Failed to load engine: bad bundle (fake)', b'{}')
    def log_message(self, *a):
        pass

HTTPServer(('127.0.0.1', PORT), H).serve_forever()
`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitForState(m: Manager, want: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (m.status().state === want) return
    await sleep(50)
  }
  throw new Error(`state never became "${want}" (last: ${m.status().state})`)
}

test('a failed warm-up keeps its model_load_failed diagnosis through the exit handler', { skip: !HAS_PYTHON }, async (t: TestContext) => {
  // Fake packages the preflight and the launch both resolve through PYTHONPATH (the child env
  // inherits it via pyEngineEnv's spread of the daemon env).
  const fakeRoot = tmpDir('turbollm-litert-fakepkgs-')
  const dataDir = tmpDir('turbollm-litert-warmup-')
  const prevPyPath = process.env.PYTHONPATH
  let manager: Manager | undefined
  t.after(async () => {
    // Stop the Manager FIRST, even when an assertion below fails: if waitForState times out
    // with the state still 'starting', the fake `serve_forever` child keeps running after the
    // test (PR #271 review). stopAndWait is safe in any state — it only waits when something is
    // still running — and force kills outright instead of the graceful TERM path.
    await manager?.stopAndWait({ force: true })
    if (prevPyPath === undefined) delete process.env.PYTHONPATH
    else process.env.PYTHONPATH = prevPyPath
    rmSync(fakeRoot, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })
  mkdirSync(join(fakeRoot, 'litert_lm'), { recursive: true })
  writeFileSync(join(fakeRoot, 'litert_lm', '__init__.py'), '')
  writeFileSync(join(fakeRoot, 'litert_lm', '_ffi.py'), 'def _get_lib():\n    return object()\n')
  mkdirSync(join(fakeRoot, 'litert_lm_cli'), { recursive: true })
  writeFileSync(join(fakeRoot, 'litert_lm_cli', '__init__.py'), '')
  writeFileSync(join(fakeRoot, 'litert_lm_cli', 'main.py'), FAKE_SERVE_PY)
  // pathDelimiter, not ':': the PYTHONPATH separator is ';' on Windows, and a ':' join there
  // would hand the child one invalid merged entry (PR #271 review).
  process.env.PYTHONPATH = prevPyPath ? [fakeRoot, prevPyPath].join(pathDelimiter) : fakeRoot

  const store = ConfigStore.load(join(dataDir, 'config.json'))
  manager = new Manager(store)
  const port = await freePort()
  await manager.start({
    engine: {
      id: 'lrt-warm', name: 'LiteRT-LM (fake)', kind: 'litert-lm', binPath: 'python3',
      version: '', capabilities: { flags: [], kvTypes: [] }, addedAt: '',
    },
    model: { key: 'm', name: 'Fake Bundle', quant: 'Q4', ctx: 4096, vision: false },
    modelPath: '/models/fake-bundle.litertlm',
    extraArgs: [],
    // The fake server binds the port it is handed: pinned clear of the 8081+ walk, which a parallel test file's engine
    // can be handed too (it then died here with EADDRINUSE, engine_exited instead of model_load_failed).
    preferredPort: port,
  } as unknown as StartOpts)

  await waitForState(manager, 'error', 30_000)
  // Give the SIGKILLed child's 'close' event a moment to run onTerminated, then pin that it
  // did NOT clobber the diagnosis.
  await sleep(300)
  const st = manager.status()
  assert.equal(st.err?.code, 'model_load_failed', `err was: ${JSON.stringify(st.err)}`)
  assert.match(st.err?.message ?? '', /LiteRT-LM could not load this model/)
  assert.match(st.err?.message ?? '', /bad bundle/, 'the runtime message must ride through')
  assert.doesNotMatch(st.err?.message ?? '', /exited unexpectedly/, 'the exit handler must not overwrite the diagnosis')
  // Started without a LiteRT-LM config (a load by path): nothing is set, so the config names no backend (it named the
  // CPU, which a GPU-only bundle cannot run on), and with no backend chosen the hint does not blame one.
  assert.deepEqual(JSON.parse(readFileSync(litertLmConfigPath(dataDir, port), 'utf8')), { default: {} })
  assert.doesNotMatch(st.err?.message ?? '', /GPU|switch the Backend/)
})
