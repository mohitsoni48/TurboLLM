// Generated from the hashes verified on 2026-11-10: each Deno zip against Deno's published .sha256sum, each Pyodide core
// file against the npm pyodide@0.29.5 package, each wheel against pyodide-lock.json. To bump a version, re-run that
// check and replace every entry; never take a hash from the host that serves the file.

/** One file the sandbox runtime downloads. `sha256` is pinned here, in the package, never fetched. */
export interface RuntimeFile {
  url: string
  /** Path inside the runtime folder. */
  path: string
  size: number
  sha256: string
}

export const DENO_VERSION = '2.9.6'
export const PYODIDE_VERSION = '0.29.5'

const DENO_BASE = `https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/`
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`

const denoZip = (name: string, size: number, sha256: string): RuntimeFile => ({ url: `${DENO_BASE}${name}`, path: name, size, sha256 })
const pyodide = (name: string, size: number, sha256: string): RuntimeFile => ({ url: `${PYODIDE_BASE}${name}`, path: name, size, sha256 })

/** The Deno release zip per `${process.platform}-${process.arch}`. Linux builds are glibc; musl (Alpine) is not covered. */
export const DENO_ZIPS: Readonly<Record<string, RuntimeFile>> = {
  'win32-x64': denoZip('deno-x86_64-pc-windows-msvc.zip', 42601047, '15e5300b0ba3c3695a7621d90160a746ec9e710228cee639afa9d580f6e3cd11'),
  'win32-arm64': denoZip('deno-aarch64-pc-windows-msvc.zip', 40835259, 'acb014afe2299847764e232b4993e162e3946cdeec36603e3f1a0b548cd1ea55'),
  'darwin-x64': denoZip('deno-x86_64-apple-darwin.zip', 42264433, '7d4524b82bcc557fe020a1a5b56956ed42b992ae5b28026e8ad5d17329533f5f'),
  'darwin-arm64': denoZip('deno-aarch64-apple-darwin.zip', 38446106, '213a2f304f04d3c9cb5220669afad138f60a5aab1fe80962abdeb8f35807a472'),
  'linux-x64': denoZip('deno-x86_64-unknown-linux-gnu.zip', 41582794, '394f07f4da2bebe6ce6f1e7ce0fa16429b29b08c35e3fac3fe25972676dff4b2'),
  'linux-arm64': denoZip('deno-aarch64-unknown-linux-gnu.zip', 39818676, '9a46afc6c392c7cd2ff71a31558935545b46408d0e87f7a86908c712721c046e'),
}

/** Pyodide core files and the 15 wheels (numpy, pandas, matplotlib, Pillow, sympy and what they depend on). */
export const PYODIDE_FILES: readonly RuntimeFile[] = [
  pyodide('pyodide.asm.wasm', 8647684, '54309a5a2cfd757b1f0fdbc9093c92503f7b341500110329d932487183912718'),
  pyodide('pyodide.asm.js', 1074322, '356c42f69e1695397e9d8670bd3c2e678248cde76e18bdae1731e848537b47d7'),
  pyodide('pyodide.mjs', 17616, '510ca14305230018f50c40fb81be673afd68080e70ce7733fcce6600dd6a1714'),
  pyodide('python_stdlib.zip', 2424003, '831fd1e535084b972f87c6a35275de3d236efd5166f5e77ce89497710635e73c'),
  pyodide('pyodide-lock.json', 122027, '14d2c2dba101277999e17135e653d8f15389ad1437f53eae213bf0c3cdff723d'),
  pyodide('contourpy-1.3.1-cp313-cp313-pyemscripten_2025_0_wasm32.whl', 117168, '65f63bc91d211c5d44e2e81dab7397b2da5f195688cf2785586be3cba6d732a7'),
  pyodide('cycler-0.12.1-py3-none-any.whl', 8321, '6eedeaff76b9be1d5e5b759fa9b84c3b384b3684cabea98defd97e974112865f'),
  pyodide('fonttools-4.56.0-py3-none-any.whl', 1089800, '30d4590e0bac3ef0445a4e0fa25600e8b4fff54bb028b02666013c26fde42965'),
  pyodide('kiwisolver-1.4.8-cp313-cp313-pyemscripten_2025_0_wasm32.whl', 37068, '23e3ec0666ab7e747f902c18f9009103b094c8424458aaeeb2504338dac9100f'),
  pyodide('matplotlib-3.8.4-cp313-cp313-pyemscripten_2025_0_wasm32.whl', 6664081, 'b919d426f1703c055b3c12a06871af40b8eb07d82339f4f9d7e45279fd93e81f'),
  pyodide('mpmath-1.3.0-py3-none-any.whl', 418000, 'a6a52e89fcce4f80c3ef7c55dcca5d8c0a5b51a16e4541086b93892877040af6'),
  pyodide('numpy-2.2.5-cp313-cp313-pyemscripten_2025_0_wasm32.whl', 2823762, '800c98edc0c864dfa49f07005680c699b4b42b84eae1f8cb19d35b3634e7f05c'),
  pyodide('packaging-26.2-py3-none-any.whl', 100225, '7a0e80a4de677fefa2782ea4d34063708a3ac3d54469298f22cedcc4c7bebb4b'),
  pyodide('pandas-2.3.3-cp313-cp313-pyemscripten_2025_0_wasm32.whl', 4493372, '2579a3d8e9f040421836365ccf7886fc4054c87381d4d481840a97785cd78923'),
  pyodide('pillow-11.3.0-cp313-cp313-pyemscripten_2025_0_wasm32.whl', 1037865, '57d88e2ac283c21830b4ee920cb73fbbf5c46df62d967089fce5fec46548bd7b'),
  pyodide('pyparsing-3.2.1-py3-none-any.whl', 107717, '67a97ce758343bf6e651a1cc63731f19fd6720a2d6617eab71528021552ee3dc'),
  pyodide('python_dateutil-2.9.0.post0-py2.py3-none-any.whl', 229892, '1fe3a0346ef21bc85b295227256d6aed72aa8116178b019fc5ae5d57fbd213cf'),
  pyodide('pytz-2025.2-py2.py3-none-any.whl', 509225, 'd7fb2f11cf7f8dd17e652d5494189f520ee086e9fc71aef4cbb978f5dcfc2878'),
  pyodide('six-1.17.0-py2.py3-none-any.whl', 11050, 'bc830cfdc71a224b6d0e4337183a87ea53f21b6623deca5771ee3bc866fd8da2'),
  pyodide('sympy-1.13.3-py3-none-any.whl', 4119974, '87a5b10d3ce6001fe5db3634e73ecfdf1475478bc0dbc114ce5b8c6e7959485f'),
]
