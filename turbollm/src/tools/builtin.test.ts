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
// builtin.ts's execRunCode comment) — an escape relocated to the console-output read-back path,
// caught in review before merge, not by any test that existed until this one was added.

test('execRunCode: legitimate calculations, JSON, arrays, dates, regex, console.log all still work', () => {
  assert.equal(execRunCode({ code: 'return Math.sqrt(16)' }), '4')
  assert.equal(execRunCode({ code: 'return JSON.stringify({a:1})' }), '{"a":1}')
  assert.equal(execRunCode({ code: 'return [1,2,3].map(x => x*2)' }), JSON.stringify([2, 4, 6], null, 2))
  assert.equal(execRunCode({ code: 'return new Date(2020,0,1).getFullYear()' }), '2020')
  assert.equal(execRunCode({ code: 'return "abc".replace(/b/, "X")' }), 'aXc')
  assert.equal(execRunCode({ code: 'return isNaN(parseInt("abc"))' }), 'true')
  assert.equal(execRunCode({ code: 'return encodeURIComponent("a b")' }), 'a%20b')
})

test('execRunCode: console.log/warn/error output is captured and returned', () => {
  const out = execRunCode({ code: 'console.log("hi"); console.warn("careful"); console.error("bad"); return 1' })
  assert.match(out, /^hi\nWARN: careful\nERROR: bad\n1$/)
})

test('execRunCode: empty code is rejected without ever reaching the sandbox', () => {
  assert.equal(execRunCode({ code: '' }), 'Error: code is required.')
  assert.equal(execRunCode({ code: '   ' }), 'Error: code is required.')
})

test('execRunCode: a syntax error surfaces as a clean Error string, not a thrown exception', () => {
  const out = execRunCode({ code: 'return (' })
  assert.match(out, /^Error:/)
})

test('SECURITY: Object.constructor("return process")() no longer reaches the real host process', () => {
  const out = execRunCode({ code: `
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

test('SECURITY: the full documented exploit chain (process -> child_process -> execSync) is blocked', () => {
  const out = execRunCode({ code: `
    const proc = Object.constructor('return process')();
    return proc.getBuiltinModule('child_process').execSync('whoami').toString();
  ` })
  // Must fail closed (an Error: string) — must NEVER return a real command's output.
  assert.match(out, /^Error:/)
  assert.doesNotMatch(out, new RegExp(process.env.USERNAME ?? process.env.USER ?? '\\x00NEVER\\x00'))
})

test('SECURITY: process.env (the real host environment, i.e. secrets/config) is not reachable', () => {
  const out = execRunCode({ code: `
    const proc = Object.constructor('return process')();
    return Object.keys(proc.env).length;
  ` })
  assert.match(out, /^Error:/)
})

test('SECURITY: the sandbox has no ambient "process" identifier at all, not even undefined-but-present', () => {
  const out = execRunCode({ code: `return typeof process` })
  assert.equal(out, 'undefined')
})

test('SECURITY: constructing a Function via other intrinsics (Array/String) does not escape either', () => {
  // A denylist-style fix that only special-cased `Object.constructor` would still leak via any
  // other intrinsic's shared Function constructor. Realm isolation closes the whole class at once.
  const viaArray = execRunCode({ code: `
    try { return typeof [].constructor.constructor('return process')(); }
    catch (e) { return 'BLOCKED:' + e.message; }
  ` })
  assert.match(viaArray, /^BLOCKED:/)

  const viaString = execRunCode({ code: `
    try { return typeof ''.constructor.constructor('return process')(); }
    catch (e) { return 'BLOCKED:' + e.message; }
  ` })
  assert.match(viaString, /^BLOCKED:/)
})

test('SECURITY: the sandbox cannot reach this module\'s own closures either (no free-variable leak)', () => {
  // A subtler failure mode than the host-realm-object leak: if the executed script somehow closed
  // over a variable from execRunCode's own scope (it should not, since the script text is the
  // ENTIRE program run in the foreign context, not a closure created in this file), that would
  // leak host-side state a different way. Confirms the code has no visibility into this module.
  const out = execRunCode({ code: `return typeof RUN_CODE_TIMEOUT_MS !== 'undefined' ? 'LEAKED' : 'ok'` })
  assert.equal(out, 'ok')
})

test('SECURITY: shadowing globalThis.__out.map cannot smuggle a host function into the console-output read-back', () => {
  // This is the regression: an earlier draft of the fix above read captured console output back
  // with `capturedArray.map(String)` — a HOST call passing the HOST's `String` into a SANDBOX
  // array's (possibly attacker-shadowed) `.map`. That reopened the exact same escape the rest of
  // this suite exists to close, just relocated. The fix reads output back via
  // Array.prototype.map/join.call(...) evaluated entirely inside the context, which must bypass
  // this shadow entirely — the malicious override below should never even be invoked.
  const out = execRunCode({ code: `
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

test('SECURITY: a thrown value with a throwing "message" getter degrades to an Error string, not an uncaught throw', () => {
  const out = execRunCode({ code: `
    throw Object.defineProperty(new Error('x'), 'message', { get() { throw new Error('getter blew up') } })
  ` })
  assert.match(out, /^Error:/)
})

test('SECURITY: a returned object with a hostile toJSON cannot run host-side JSON.stringify', () => {
  // toJSON runs during stringification of the return value. If that stringification ever moved
  // back onto the host stack (e.g. `JSON.stringify(result, null, 2)` on the returned object
  // itself), a hostile toJSON would run there, outside any vm timeout, given a host-realm
  // JSON.stringify/Function to climb through. Confirms it stays bounded and inert either way.
  const out = execRunCode({ code: `
    return { toJSON() { return Object.constructor('return process')().pid } }
  ` })
  assert.doesNotMatch(out, new RegExp(String(process.pid)))
})

test('returning a plain object still serializes exactly as before (in-context JSON.stringify)', () => {
  assert.equal(execRunCode({ code: 'return {a: 1, b: [2, 3]}' }), JSON.stringify({ a: 1, b: [2, 3] }, null, 2))
})
