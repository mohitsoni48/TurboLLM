import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execRunCode, resolveSearchQuery } from './builtin'

// ── resolveSearchQuery ────────────────────────────────────────────────────────
// Regression: a model emitting `queries: [...]` instead of the schema's `query` used to
// resolve to '', which surfaced as a literal "undefined" in the approval dialog (tool-explain.ts
// mirrors this same fallback) and an empty search server-side.

test('resolveSearchQuery: reads the schema-correct singular query', () => {
  assert.equal(resolveSearchQuery({ query: 'latest stable Node.js version' }), 'latest stable Node.js version')
})

test('resolveSearchQuery: falls back to the first entry of a plural queries array', () => {
  assert.equal(resolveSearchQuery({ queries: ['latest stable Node.js version', 'second query'] }), 'latest stable Node.js version')
})

test('resolveSearchQuery: query takes precedence when both are present', () => {
  assert.equal(resolveSearchQuery({ query: 'a', queries: ['b'] }), 'a')
})

test('resolveSearchQuery: empty when neither shape is present', () => {
  assert.equal(resolveSearchQuery({}), '')
})

test('resolveSearchQuery: empty when queries is present but not an array of strings', () => {
  assert.equal(resolveSearchQuery({ queries: [42] }), '')
  assert.equal(resolveSearchQuery({ queries: 'not-an-array' }), '')
})

// ── execRunCode ──────────────────────────────────────────────────────────────
// Security regression suite for a real, demonstrated vm sandbox escape: the previous
// implementation passed HOST-realm Math/JSON/Array/Object/String/Number/Boolean/Date/RegExp into
// the sandbox object handed to `runInNewContext`, overwriting the fresh context's own safe
// versions of those globals. Because the host's `Object.constructor` is the host's `Function`
// constructor, sandboxed code could do `Object.constructor('return process')()` to obtain the
// REAL host `process` object — full `process.env` access (every secret/config value visible to
// the daemon) and, via `process.getBuiltinModule('child_process').execSync(...)`, arbitrary OS
// command execution as the daemon's own user. Reproduced end-to-end against this exact codebase
// before the fix. Every SECURITY test below passes against the shipped implementation; most also
// fail against the pre-fix one (genuine regression coverage) — the three that don't (":no ambient
// process identifier", ":via other intrinsics", ":no free-variable leak") assert invariants that
// happened to already hold pre-fix too (process/RUN_CODE_TIMEOUT_MS were never injected either
// way; array/string literals resolve via the executing realm's own intrinsics regardless of what
// the *global* Array/String bindings point to) — kept because they're still true and still worth
// locking in, not because they'd have caught the original bug. The read-back-escape test below is
// the one that would have caught the actual regression that nearly shipped in this same fix (see
// run-code-sandbox.ts's SECURITY comment) — an escape relocated to the console-output read-back
// path, caught in review before merge, not by any test that existed until this one was added.
//
// execRunCode itself is now async (see builtin.ts): it runs the sandbox in a node:worker_threads
// Worker rather than on this process's own thread, so a hang or a crash is contained to that
// worker instead of taking down whatever process runs the tests (or the daemon, in production).
// The last two tests below exercise that containment directly.

test('execRunCode: legitimate calculations, JSON, arrays, dates, regex, console.log all still work', async () => {
  assert.equal(await execRunCode({ code: 'return Math.sqrt(16)' }), '4')
  assert.equal(await execRunCode({ code: 'return JSON.stringify({a:1})' }), '{"a":1}')
  assert.equal(await execRunCode({ code: 'return [1,2,3].map(x => x*2)' }), JSON.stringify([2, 4, 6], null, 2))
  assert.equal(await execRunCode({ code: 'return new Date(2020,0,1).getFullYear()' }), '2020')
  assert.equal(await execRunCode({ code: 'return "abc".replace(/b/, "X")' }), 'aXc')
  assert.equal(await execRunCode({ code: 'return isNaN(parseInt("abc"))' }), 'true')
  assert.equal(await execRunCode({ code: 'return encodeURIComponent("a b")' }), 'a%20b')
})

test('execRunCode: console.log/warn/error output is captured and returned', async () => {
  const out = await execRunCode({ code: 'console.log("hi"); console.warn("careful"); console.error("bad"); return 1' })
  assert.match(out, /^hi\nWARN: careful\nERROR: bad\n1$/)
})

test('execRunCode: empty code is rejected without ever reaching the sandbox', async () => {
  assert.equal(await execRunCode({ code: '' }), 'Error: code is required.')
  assert.equal(await execRunCode({ code: '   ' }), 'Error: code is required.')
})

test('execRunCode: a syntax error surfaces as a clean Error string, not a thrown exception', async () => {
  const out = await execRunCode({ code: 'return (' })
  assert.match(out, /^Error:/)
})

test('SECURITY: Object.constructor("return process")() no longer reaches the real host process', async () => {
  const out = await execRunCode({ code: `
    try {
      const p = Object.constructor('return process')();
      return 'LEAKED:' + typeof p;
    } catch (e) {
      return 'BLOCKED:' + e.message;
    }
  ` })
  assert.match(out, /^BLOCKED:/, `expected the escape to throw inside the sandbox, got: ${out}`)
  assert.doesNotMatch(out, /LEAKED/)
})

test('SECURITY: the full documented exploit chain (process -> child_process -> execSync) is blocked', async () => {
  const out = await execRunCode({ code: `
    const proc = Object.constructor('return process')();
    return proc.getBuiltinModule('child_process').execSync('whoami').toString();
  ` })
  // Must fail closed (an Error: string) — must NEVER return a real command's output.
  assert.match(out, /^Error:/)
  assert.doesNotMatch(out, new RegExp(process.env.USERNAME ?? process.env.USER ?? '\\x00NEVER\\x00'))
})

test('SECURITY: process.env (the real host environment, i.e. secrets/config) is not reachable', async () => {
  const out = await execRunCode({ code: `
    const proc = Object.constructor('return process')();
    return Object.keys(proc.env).length;
  ` })
  assert.match(out, /^Error:/)
})

test('SECURITY: the sandbox has no ambient "process" identifier at all, not even undefined-but-present', async () => {
  const out = await execRunCode({ code: `return typeof process` })
  assert.equal(out, 'undefined')
})

test('SECURITY: bare "this" cannot reach the host via its own prototype chain (createContext backing object)', async () => {
  // This is the one that actually mattered: every OTHER escape test in this suite probes a named
  // global (Object/Array/String/...) — vm.createContext freshly re-creates those regardless of
  // what backing object you pass it, so those always came back blocked even with the vulnerable
  // `createContext({})`. Top-level `this` inside the wrapped script is that SAME backing object,
  // though, and a plain `{}` literal keeps the HOST's Object.prototype in its own [[Prototype]]
  // chain — so `this.constructor.constructor(...)` reached the real host process even after every
  // named-global vector above was already closed, and none of the tests above would have caught
  // it. Caught in review, reproduced live, fixed by using Object.create(null) as the backing
  // object instead of `{}` (see run-code-sandbox.ts).
  const out = await execRunCode({ code: `
    try {
      const p = this.constructor.constructor('return process')();
      return 'ESCAPED:' + typeof p + ':pid=' + p.pid;
    } catch (e) {
      return 'BLOCKED:' + e.message;
    }
  ` })
  assert.match(out, /^BLOCKED:/, `expected this.constructor.constructor to be blocked, got: ${out}`)
  assert.doesNotMatch(out, /ESCAPED/)
  assert.doesNotMatch(out, new RegExp(String(process.pid)))
})

test('SECURITY: constructing a Function via other intrinsics (Array/String) does not escape either', async () => {
  // A denylist-style fix that only special-cased `Object.constructor` would still leak via any
  // other intrinsic's shared Function constructor. Realm isolation closes the whole class at once.
  const viaArray = await execRunCode({ code: `
    try { return typeof [].constructor.constructor('return process')(); }
    catch (e) { return 'BLOCKED:' + e.message; }
  ` })
  assert.match(viaArray, /^BLOCKED:/)

  const viaString = await execRunCode({ code: `
    try { return typeof ''.constructor.constructor('return process')(); }
    catch (e) { return 'BLOCKED:' + e.message; }
  ` })
  assert.match(viaString, /^BLOCKED:/)
})

test('SECURITY: the sandbox cannot reach this module\'s own closures either (no free-variable leak)', async () => {
  // A subtler failure mode than the host-realm-object leak: if the executed script somehow closed
  // over a variable from execRunCode's own scope (it should not, since the script text is the
  // ENTIRE program run in the foreign context, not a closure created in this file), that would
  // leak host-side state a different way. Confirms the code has no visibility into this module.
  const out = await execRunCode({ code: `return typeof RUN_CODE_TIMEOUT_MS !== 'undefined' ? 'LEAKED' : 'ok'` })
  assert.equal(out, 'ok')
})

test('SECURITY: shadowing globalThis.__out.map cannot smuggle a host function into the console-output read-back', async () => {
  // This is the regression: an earlier draft of the fix above read captured console output back
  // with `capturedArray.map(String)` — a HOST call passing the HOST's `String` into a SANDBOX
  // array's (possibly attacker-shadowed) `.map`. That reopened the exact same escape the rest of
  // this suite exists to close, just relocated. The fix reads output back via
  // Array.prototype.map/join.call(...) evaluated entirely inside the context, which must bypass
  // this shadow entirely — the malicious override below should never even be invoked.
  const out = await execRunCode({ code: `
    globalThis.__out.map = function (f) {
      try {
        const p = f.constructor('return process')();
        return ['ESCAPED:' + typeof p + ':pid=' + p.pid];
      } catch (e) {
        return ['BLOCKED:' + e.message];
      }
    };
    return 'main-script-done';
  ` })
  assert.doesNotMatch(out, /ESCAPED/, `expected the shadowed .map to never run, got: ${out}`)
  assert.doesNotMatch(out, new RegExp(String(process.pid)))
  assert.match(out, /main-script-done/)
})

test('SECURITY: a thrown value with a throwing "message" getter degrades to an Error string, not an uncaught throw', async () => {
  const out = await execRunCode({ code: `
    throw Object.defineProperty(new Error('x'), 'message', { get() { throw new Error('getter blew up') } })
  ` })
  assert.match(out, /^Error:/)
})

test('SECURITY: a returned object with a hostile toJSON cannot run host-side JSON.stringify', async () => {
  // toJSON runs during stringification of the return value. If that stringification ever moved
  // back onto the host stack (e.g. `JSON.stringify(result, null, 2)` on the returned object
  // itself), a hostile toJSON would run there, outside any vm timeout, given a host-realm
  // JSON.stringify/Function to climb through. Confirms it stays bounded and inert either way.
  const out = await execRunCode({ code: `
    return { toJSON() { return Object.constructor('return process')().pid } }
  ` })
  assert.doesNotMatch(out, new RegExp(String(process.pid)))
})

test('returning a plain object still serializes exactly as before (in-context JSON.stringify)', async () => {
  assert.equal(await execRunCode({ code: 'return {a: 1, b: [2, 3]}' }), JSON.stringify({ a: 1, b: [2, 3] }, null, 2))
})

// ── worker isolation (DoS containment) ────────────────────────────────────────
// These exercise what vm's own `{ timeout }` cannot cover on its own, because it only interrupts
// *synchronous* execution — see builtin.ts's execRunCode comment. Only the looping-getter case is
// slow by nature (it genuinely waits out the host watchdog); the other two resolve fast because
// worker isolation contains the damage without needing the watchdog at all.

test('a microtask loop that keeps rescheduling itself does not delay or corrupt the real result', async () => {
  const start = Date.now()
  const out = await execRunCode({ code: `
    function loop() { Promise.resolve().then(loop) }
    loop();
    return 'scheduled';
  ` })
  // The synchronous portion of the script (which computes and returns 'scheduled') completes and
  // is posted back BEFORE the microtask queue ever gets a chance to drain — so this resolves fast
  // with the correct answer. The worker's own thread is left spinning on the microtask queue
  // afterward, forever, if left alone — execRunCode's finish() terminates the worker immediately
  // upon receiving this message specifically so that spin never outlives the response. (An
  // earlier version of this test wrongly assumed the message itself would never arrive; measured
  // behavior says otherwise — verify before asserting a threat model, not just before a fix.)
  assert.equal(out, 'scheduled')
  assert.ok(Date.now() - start < 2_000, `expected a fast reply, not a wait for the watchdog; took ${Date.now() - start}ms`)
})

test('a thrown value with an infinitely-looping "message" getter is bounded by the host watchdog', { timeout: 15_000 }, async () => {
  // Unlike the throwing-getter test above, this getter never returns — it hangs the WORKER's own
  // thread synchronously (message access happens in the worker's plain top-level code, in the
  // catch block, outside any vm timeout) so the worker can never post a response at all. This is
  // exactly what the host-side watchdog in execRunCode (builtin.ts) exists to bound.
  const out = await execRunCode({ code: `
    throw Object.defineProperty(new Error('x'), 'message', { get() { while (true) {} } })
  ` })
  assert.match(out, /^Error:/)
})

test('an allocation bomb crashes only its own worker, not the test process running this suite', { timeout: 15_000 }, async () => {
  const out = await execRunCode({ code: `
    const a = [];
    while (true) { a.push(new Array(1_000_000).fill(7)) }
  ` })
  // If worker isolation didn't contain this, the OOM would crash the whole test process instead
  // of ever reaching this assertion at all.
  assert.match(out, /^Error:/)
})

test('SECURITY: ArrayBuffer/typed-array/WebAssembly allocation cannot bypass resourceLimits as unbounded external memory', { timeout: 15_000 }, async () => {
  // resourceLimits (builtin.ts) bounds only the V8 JS HEAP. An ArrayBuffer loop allocates external
  // memory that isn't charged against it — verified live: this exact payload drove host RSS from
  // 59MB to several GB in under a second before this fix denied the constructor outright. Must now
  // fail fast with a plain ReferenceError, not be merely slow to hit some other limit.
  const out = await execRunCode({ code: `
    const bufs = [];
    while (true) { bufs.push(new ArrayBuffer(100 * 1024 * 1024)) }
  ` })
  assert.match(out, /^Error:.*ArrayBuffer is not defined/)
})

test('SECURITY: Float16Array (or any other typed array not on a hardcoded name list) is also denied', async () => {
  // The deny-list in run-code-sandbox.ts used to name each typed-array class individually and
  // missed Float16Array (a standard global added in a later Node version than the original list
  // was written against) — verified live: the identical ArrayBuffer-class bomb still worked
  // through Float16Array alone, silently defeating the mitigation above. The fix matches the
  // shared %TypedArray% prototype structurally instead, so this covers whatever typed array
  // exists today AND whatever gets added to the language next.
  const out = await execRunCode({ code: `return typeof Float16Array` })
  assert.equal(out, 'undefined')
})

test('more concurrent calls than the worker cap all resolve correctly, none dropped or crossed', async () => {
  // Regression for the concurrency limiter in builtin.ts (RUN_CODE_MAX_CONCURRENT_WORKERS): a
  // flood of concurrent calls should queue past the cap, not error, deadlock, or hand one call's
  // result to another.
  const n = 10
  const results = await Promise.all(Array.from({ length: n }, (_, i) => execRunCode({ code: `return ${i}` })))
  assert.deepEqual(results, Array.from({ length: n }, (_, i) => String(i)))
})
