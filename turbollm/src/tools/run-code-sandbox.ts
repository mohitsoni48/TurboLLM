import { createContext, runInContext, type Context } from 'node:vm'

// The pure, synchronous vm-sandbox logic behind the `run_code` tool. Lives in its own module so
// it can be imported both by the worker entry point (run-code-worker.ts) that actually executes
// it in an isolated thread, and directly by tests that only care about the realm-escape logic
// itself, without the overhead of spinning up a real worker_threads Worker per assertion.
//
// SECURITY: this function executes model-authored JavaScript in a Node `vm` context. The
// invariant that makes it safe is simple to state and easy to violate by accident: nothing may
// cross from the sandboxed context back into the caller except a value that is ALREADY a
// primitive string/number/boolean/undefined the instant it leaves `runInContext`. Handing a
// sandbox-realm value a HOST-realm function as an argument — even something as innocuous-looking
// as `sandboxArray.map(String)` — is enough to escape: if the sandboxed script shadowed `.map`
// with its own function, that call invokes SANDBOX code with the HOST's `String` as an argument,
// and `String.constructor` is the HOST's real `Function` constructor. A function built via the
// host's `Function` constructor closes over the HOST's global scope, so the sandboxed code ends
// up holding the real `process` object — full `process.env` plus, via
// `process.getBuiltinModule('child_process').execSync(...)`, arbitrary OS command execution as
// whatever process this code runs in. (An earlier draft of this fix closed the injection side —
// no more host globals copied into the sandbox object — but reopened exactly this on the
// read-back side via `capturedArray.map(String)`. Caught in review before it shipped.)
//
// Every join, stringify, and message-coercion step below runs INSIDE the context via
// `runInContext`, using that context's OWN `Array.prototype`/`JSON`/`String` invoked with `.call`
// so a sandbox-owned array's shadowed `.map`/`.join`/`.toString` can never be reached from caller
// code — the only thing that ever crosses the boundary is a finished string.
//
// `createContext(Object.create(null))` — NOT `createContext({})` — is equally load-bearing and
// far easier to get wrong than it looks: named globals (`Object`/`Array`/`Math`/`JSON`/...) are
// freshly created by `vm.createContext` regardless of what backing object you pass it, so a naive
// probe via those names always comes back blocked either way. The gap only `Object.create(null)`
// closes is bare `this`: `vm.createContext(sandbox)` makes `sandbox` itself the context's global
// object, and a plain `{}` literal still carries the HOST's `Object.prototype` in its own
// [[Prototype]] chain — so `this.constructor.constructor("return process")()` reached the real
// host process through a `createContext({})` backing object, verified live, even after every
// named-global escape above was already closed. See runCodeInSandbox below for the fix.
//
// `vm` is still not a documented security boundary (per Node's own `vm` docs) — a sufficiently
// sophisticated payload or a V8/Node bug could in principle still find a way out. This is why
// run-code-worker.ts runs this function inside a node:worker_threads Worker rather than calling
// it directly on the daemon's own main thread: `vm`'s `{ timeout }` only bounds *synchronous*
// execution — a microtask loop (`Promise.resolve().then(loop)`), an allocation bomb, or a thrown
// value with an infinitely-looping `message` getter can all still hang or crash whichever thread
// this function runs on. Running it in a dedicated worker means that thread, and only that
// thread, pays for a hang or a crash — the host can always force it away with `.terminate()` (see
// execRunCode in builtin.ts), and `resourceLimits` on the worker bounds the memory it can take
// down with it. None of those denial-of-service vectors reach `process` or the filesystem; they
// are an availability concern for whichever thread runs this, not a confidentiality/integrity one.

export const RUN_CODE_TIMEOUT_MS = 5_000
export const RUN_CODE_SETUP_TIMEOUT_MS = 1_000 // fixed, non-attacker-controlled scripts — should be instant

// Builds console.log/warn/error INSIDE the sandbox, appending to a plain array of strings on the
// context's own global object. Never references anything from the host realm — every identifier
// here (`globalThis`, `Array`, `String`) resolves against the CONTEXT's own intrinsics once this
// script is executed via runInContext, not this module's. Uses `Array.prototype.map.call` (not
// `arguments.map`) so a later shadow of `Array.prototype` can't affect logging.
const RUN_CODE_CONSOLE_SETUP = `
  globalThis.__out = [];
  globalThis.console = {
    log: function () { globalThis.__out.push(Array.prototype.map.call(arguments, String).join(' ')) },
    error: function () { globalThis.__out.push('ERROR: ' + Array.prototype.map.call(arguments, String).join(' ')) },
    warn: function () { globalThis.__out.push('WARN: ' + Array.prototype.map.call(arguments, String).join(' ')) },
  };
`

// Joins captured console output into one string, evaluated ENTIRELY inside the context: explicit
// `Array.prototype.map/join.call(...)` bypasses whatever the script's own `.map`/`.join` own
// properties on `globalThis.__out` might have been reassigned to, and `String` here resolves to
// the context's own — never the caller's. Only ever produces a plain string.
const RUN_CODE_JOIN_OUTPUT = `
  Array.isArray(globalThis.__out)
    ? Array.prototype.join.call(Array.prototype.map.call(globalThis.__out, String), '\\n')
    : ''
`

// The Worker's `resourceLimits` (see builtin.ts) bounds the V8 JS heap ONLY. ArrayBuffer/typed-
// array/SharedArrayBuffer/WebAssembly.Memory backing stores are external ("off-heap") memory that
// those limits do not cover — a tight allocation loop using any of them can commit gigabytes of
// real host RSS in under a second, fast enough to OOM-kill the whole daemon well before the vm
// timeout even fires. Verified live: an ArrayBuffer loop drove host RSS from 59MB to several GB in
// under a second against an otherwise-identical context. None of these are needed for the tool's
// stated purpose (calculations, data transformation, JSON/string/date/regex logic), so they're
// deleted outright rather than merely left unbounded. Deleting a standard global here works
// because built-in global bindings are `configurable: true` by spec; verified this doesn't affect
// any other standard global (Object/Array/Math/JSON/String/... are untouched).
//
// Walks the shared `%TypedArray%` intermediate prototype STRUCTURALLY rather than naming each
// concrete class: an earlier version of this hardcoded `Uint8Array`/`Float64Array`/etc. by name
// and missed `Float16Array` (a standard global as of Node 24+, not on that list) — verified live,
// the exact same ArrayBuffer-class bomb still drove host RSS to gigabytes through it alone,
// silently defeating this entire mitigation. Every current AND FUTURE typed-array constructor
// shares that one prototype, so matching on it closes the whole class instead of one snapshot of
// its members.
const RUN_CODE_DENY_EXTERNAL_MEMORY = `
  (function () {
    var g = globalThis, TypedArrayProto = null, names = Object.getOwnPropertyNames(g);
    for (var i = 0; i < names.length; i++) {
      var v; try { v = g[names[i]] } catch (e) { continue }
      if (typeof v === 'function' && /Array$/.test(names[i]) && v !== Array) {
        var p = Object.getPrototypeOf(v);
        if (typeof p === 'function' && p.name === 'TypedArray') { TypedArrayProto = p; break }
      }
    }
    for (var j = 0; j < names.length; j++) {
      var n = names[j], val; try { val = g[n] } catch (e) { continue }
      if (n === 'ArrayBuffer' || n === 'SharedArrayBuffer' || n === 'DataView' || n === 'WebAssembly' || n === 'Atomics'
        || (typeof val === 'function' && TypedArrayProto && Object.getPrototypeOf(val) === TypedArrayProto)) {
        delete g[n]
      }
    }
  })();
`

// Error stack traces built inside the context include real file paths (this repo's on-disk
// location, node:vm internals, and — since paths embed it — the host OS username), disclosed to
// whoever reads a run_code error string. Low severity (this tool is reachable only via the same
// model already operating on this user's own machine, not external network input) but cheap to
// close: overriding `Error.prepareStackTrace` INSIDE the context means `.stack` on any
// context-realm Error resolves to just "Name: message", with no file/line info, for every error
// the sandboxed script sees or throws — including the ones this module's own error path below
// reads via `.message` (unaffected, since that's a different property).
const RUN_CODE_SANITIZE_STACK_TRACES = `
  Error.prepareStackTrace = function (err) { return err.name + ': ' + err.message };
`

export function runCodeInSandbox(code: string): string {
  // A NULL-PROTOTYPE backing object, not `{}`. This is not stylistic: `vm.createContext(sandbox)`
  // makes `sandbox` itself the context's global object, and a plain `{}` literal — created in
  // THIS host module — still carries the HOST's `Object.prototype` in its own [[Prototype]]
  // chain. `Object`/`Array`/etc. as bare identifiers DO resolve to the context's own fresh globals
  // either way (which is why every other realm-escape test in this suite passes) — but bare `this`
  // at the top of the wrapped script below is that SAME backing object, and `this.constructor`
  // walks its inherited prototype chain, landing on the HOST's `Object`, whose `.constructor` is
  // the HOST's `Function`. `this.constructor.constructor("return process")()` reached the real
  // host process this way — caught in review, verified live, before this line ever shipped.
  // `Object.create(null)` has no [[Prototype]] at all, severing that chain completely, while
  // every standard global the context needs (Object/Array/Math/JSON/...) is still installed fresh
  // by vm.createContext regardless of what the backing object's own prototype is.
  const context: Context = createContext(Object.create(null))

  let result: unknown
  try {
    runInContext(RUN_CODE_CONSOLE_SETUP, context, { timeout: RUN_CODE_SETUP_TIMEOUT_MS })
    runInContext(RUN_CODE_DENY_EXTERNAL_MEMORY, context, { timeout: RUN_CODE_SETUP_TIMEOUT_MS })
    runInContext(RUN_CODE_SANITIZE_STACK_TRACES, context, { timeout: RUN_CODE_SETUP_TIMEOUT_MS })
    // The user script's return value is stringified INSIDE this same runInContext call — same
    // realm, same timeout — so a hostile toJSON/toString/getter on whatever it returns runs under
    // RUN_CODE_TIMEOUT_MS like the rest of the script, and only a string or undefined ever
    // crosses back to the caller (never JSON.stringify'd or String()'d out here).
    result = runInContext(
      `(function(){
        const __result = (function(){${code}})();
        if (__result === undefined) return undefined;
        if (typeof __result === 'string') return __result;
        try { return JSON.stringify(__result, null, 2); }
        catch (e) { try { return String(__result); } catch (e2) { return '[unstringifiable result]'; } }
      })()`,
      context,
      { timeout: RUN_CODE_TIMEOUT_MS },
    )
  } catch (e) {
    let message = 'unknown error'
    try {
      message = String((e as Error)?.message ?? e)
    } catch {
      /* a hostile getter on the thrown value's own .message — fall back rather than propagate */
    }
    return `Error: ${message}`
  }

  // Best-effort read-back of captured console output, joined entirely inside the context (see
  // RUN_CODE_JOIN_OUTPUT) — a script that deleted, reassigned, or booby-trapped its own
  // globalThis.__out only loses its own captured output, never anything belonging to the caller.
  let output = ''
  try {
    const joined = runInContext(RUN_CODE_JOIN_OUTPUT, context, { timeout: RUN_CODE_SETUP_TIMEOUT_MS })
    if (typeof joined === 'string') output = joined
  } catch {
    /* best-effort only */
  }

  const parts: string[] = []
  if (output) parts.push(output)
  if (typeof result === 'string') parts.push(result)
  return parts.join('\n') || '(no output)'
}
