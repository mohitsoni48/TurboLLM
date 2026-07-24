import '@testing-library/jest-dom'

// Real localStorage polyfill — NOT covered by vite.config.ts's jsdom `url` option. That option
// fixes jsdom's OWN localStorage (which needs a non-opaque origin), but Node 22+'s experimental
// global `localStorage` shadows jsdom's entirely and can expose a getItem that IS a function but
// THROWS when invoked, without a `--localstorage-file` path configured (the `--localstorage-file
// was provided without a valid path` warning every test run prints is this same feature,
// half-wired). `execArgv: ['--no-experimental-webstorage']` in vite.config.ts's test block
// disables this Node feature on Vitest's worker processes, so this shouldn't fire in that
// configuration — but `localStorageWorks()` below PROBES by actually calling `getItem` rather
// than trusting a `typeof` check (which sees "function" and wrongly concludes the real
// implementation is usable even when it throws), so a future config/environment drift that
// re-exposes the throwing implementation gets caught here instead of crashing every component
// test at import time. stores/ui.ts's zustand store reads localStorage eagerly at MODULE-EVAL
// time (inside its top-level `create(...)` call), so a working implementation must be in place
// before ANY test file's imports resolve — setupFiles run before that, so a plain module-scope
// check here (no vi.hoisted needed) is early enough. `configurable: true` so an individual test
// can still override it (e.g. to assert on stored values) if needed.
function localStorageWorks(): boolean {
  try {
    const ls = globalThis.localStorage
    if (!ls || typeof ls.getItem !== 'function') return false
    ls.getItem('__setup_probe__')
    return true
  } catch {
    return false
  }
}

if (!localStorageWorks()) {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, String(v)) },
      removeItem: (k: string) => { store.delete(k) },
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size },
    },
  })
}

// jsdom never implements window.matchMedia (throws "not implemented" — unlike localStorage,
// there's no config flag that fixes this). stores/ui.ts's resolveDark() calls it for the
// 'system' theme, and main.tsx wires an OS-theme-change listener via
// matchMedia(...).addEventListener — both run at module init for any component that imports
// the ui store, so every component test needs a working stub, not just theme-focused ones. A
// fixed "always light" stub is enough: nothing in this suite exercises real OS theme switching.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}
