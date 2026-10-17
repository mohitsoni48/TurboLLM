// The generated gate node, run in a real Python interpreter against a stand-in ComfyUI (PromptQueue and
// model_management) and a stand-in TurboLLM that keeps ComfyGuard's `held` flag: an acquire while held
// returns at once, and a release reloads the model.
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { gateNodeSource } from './gate-template'
import { tmpDir } from '../test-support/tmp'

const PYTHON = process.platform === 'win32' ? 'python' : 'python3'
const HAS_PYTHON = (() => {
  try {
    execFileSync(PYTHON, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const FAKE_EXECUTION_PY = `
import threading

class PromptQueue:
    def __init__(self):
        self.mutex = threading.RLock()
        self.queue = []
        self.running = 0

    def put(self, item):
        with self.mutex:
            self.queue.append(item)

    def get(self):
        with self.mutex:
            self.running += 1
            return self.queue.pop(0)

    def task_done(self, item):
        with self.mutex:
            self.running -= 1

    def get_tasks_remaining(self):
        with self.mutex:
            return len(self.queue) + self.running
`

// ComfyUI's own free takes a while: that is the window a racing put lands in.
const FAKE_MODEL_MANAGEMENT_PY = `
import time

def unload_all_models():
    time.sleep(0.5)

def soft_empty_cache():
    pass
`

// job1 runs and finishes, so the queue drains and the release follows ComfyUI's own free; job2 is
// queued 100 ms in (ComfyUI's auto-queue resubmits on the queue-drained status message).
const DRIVER_PY = `
import sys, threading, time
sys.path.insert(0, sys.argv[1])
import execution
import turbollm_gate

q = execution.PromptQueue()
q.put("job1")
q.get()
drain = threading.Thread(target=q.task_done, args=("job1",))
drain.start()
time.sleep(0.1)
q.put("job2")
drain.join()
`

test('a prompt queued while the queue drains is enqueued only after TurboLLM unloads its model again', {
  skip: !HAS_PYTHON && `needs ${PYTHON}`,
}, async (t) => {
  let held = false
  const calls: string[] = []
  const turbollm = createServer((req, res) => {
    if (req.url === '/api/v1/comfyui/acquire') {
      calls.push(held ? 'acquire (already held: answered at once)' : 'acquire')
      held = true
    } else if (req.url === '/api/v1/comfyui/release') {
      calls.push('release')
      held = false
    }
    req.resume()
    res.end('{}')
  })
  await new Promise<void>((r) => turbollm.listen(0, '127.0.0.1', r))
  t.after(() => turbollm.close())
  const dir = tmpDir('tllm-gate-')
  mkdirSync(join(dir, 'comfy'))
  writeFileSync(join(dir, 'comfy', '__init__.py'), '')
  writeFileSync(join(dir, 'comfy', 'model_management.py'), FAKE_MODEL_MANAGEMENT_PY)
  writeFileSync(join(dir, 'execution.py'), FAKE_EXECUTION_PY)
  writeFileSync(join(dir, 'turbollm_gate.py'), gateNodeSource(`http://127.0.0.1:${(turbollm.address() as AddressInfo).port}`))
  writeFileSync(join(dir, 'drive.py'), DRIVER_PY)

  await promisify(execFile)(PYTHON, [join(dir, 'drive.py'), dir], {
    env: { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' },
  })

  assert.deepEqual(calls, ['acquire', 'release', 'acquire'])
  assert.equal(held, true, "job2 is queued with TurboLLM's model unloaded")
})

// Three prompts queued at once and rendered one after another. The node used to acquire only on the queue's first
// prompt, so TurboLLM's crash-recovery lease (30 min by default) ran out mid-queue on a long batch and reloaded the LLM
// under a render. It now acquires again after every prompt that leaves more queued, which re-arms the lease.
const BATCH_DRIVER_PY = `
import sys
sys.path.insert(0, sys.argv[1])
import execution
import turbollm_gate

q = execution.PromptQueue()
for job in ("job1", "job2", "job3"):
    q.put(job)
for _ in range(3):
    job = q.get()
    q.task_done(job)
`

test('a long queue refreshes the lease after every prompt that leaves more queued, then releases once', {
  skip: !HAS_PYTHON && `needs ${PYTHON}`,
}, async (t) => {
  let held = false
  const calls: string[] = []
  const turbollm = createServer((req, res) => {
    if (req.url === '/api/v1/comfyui/acquire') {
      calls.push(held ? 'acquire (already held: answered at once)' : 'acquire')
      held = true
    } else if (req.url === '/api/v1/comfyui/release') {
      calls.push('release')
      held = false
    }
    req.resume()
    res.end('{}')
  })
  await new Promise<void>((r) => turbollm.listen(0, '127.0.0.1', r))
  t.after(() => turbollm.close())
  const dir = tmpDir('tllm-gate-')
  mkdirSync(join(dir, 'comfy'))
  writeFileSync(join(dir, 'comfy', '__init__.py'), '')
  writeFileSync(join(dir, 'comfy', 'model_management.py'), 'def unload_all_models():\n    pass\n\ndef soft_empty_cache():\n    pass\n')
  writeFileSync(join(dir, 'execution.py'), FAKE_EXECUTION_PY)
  writeFileSync(join(dir, 'turbollm_gate.py'), gateNodeSource(`http://127.0.0.1:${(turbollm.address() as AddressInfo).port}`))
  writeFileSync(join(dir, 'drive.py'), BATCH_DRIVER_PY)

  await promisify(execFile)(PYTHON, [join(dir, 'drive.py'), dir], {
    env: { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' },
  })

  assert.deepEqual(calls, [
    'acquire',
    'acquire (already held: answered at once)',
    'acquire (already held: answered at once)',
    'release',
  ])
})

// TurboLLM is on the same machine, but urllib.request.urlopen sends through whatever proxy the environment configures
// (HTTP_PROXY, or the system settings on Windows and macOS) unless NO_PROXY lists the host. A ComfyUI started with a
// proxy set (common behind a corporate proxy, or to download models) sent every acquire and release to that proxy,
// which cannot reach this machine's loopback, so the gate did nothing.
test('the node calls TurboLLM directly, never through a configured HTTP proxy', {
  skip: !HAS_PYTHON && `needs ${PYTHON}`,
}, async (t) => {
  const calls: string[] = []
  const turbollm = createServer((req, res) => {
    calls.push(req.url ?? '')
    req.resume()
    res.end('{}')
  })
  const proxied: string[] = []
  const proxy = createServer((req, res) => {
    proxied.push(req.url ?? '')
    req.resume()
    res.end('{}')
  })
  await new Promise<void>((r) => turbollm.listen(0, '127.0.0.1', r))
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
  t.after(() => turbollm.close())
  t.after(() => proxy.close())
  const dir = tmpDir('tllm-gate-proxy-')
  mkdirSync(join(dir, 'comfy'))
  writeFileSync(join(dir, 'comfy', '__init__.py'), '')
  writeFileSync(join(dir, 'comfy', 'model_management.py'), 'def unload_all_models():\n    pass\n\ndef soft_empty_cache():\n    pass\n')
  writeFileSync(join(dir, 'execution.py'), FAKE_EXECUTION_PY)
  writeFileSync(join(dir, 'turbollm_gate.py'), gateNodeSource(`http://127.0.0.1:${(turbollm.address() as AddressInfo).port}`))
  writeFileSync(join(dir, 'drive.py'), BATCH_DRIVER_PY)

  const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
  const env: NodeJS.ProcessEnv = { ...process.env, HTTP_PROXY: proxyUrl, http_proxy: proxyUrl }
  delete env.NO_PROXY
  delete env.no_proxy
  await promisify(execFile)(PYTHON, [join(dir, 'drive.py'), dir], { env })

  assert.deepEqual(proxied, [])
  assert.deepEqual(calls, ['/api/v1/comfyui/acquire', '/api/v1/comfyui/acquire', '/api/v1/comfyui/acquire', '/api/v1/comfyui/release'])
})
