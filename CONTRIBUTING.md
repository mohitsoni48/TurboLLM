# Contributing to TurboLLM

Thanks for wanting to help. TurboLLM is built by a solo maintainer, so well-shaped
contributions genuinely move the project.

## The short version

- **Bug reports** — open an issue with your OS, GPU, Node version (`node --version`), the
  engine + model you were loading, steps to reproduce, and what you expected. Anything that
  failed to load usually leaves a useful error in the Engines screen's log — paste it.
- **Small fixes** (typos, docs, clear one-file bugs) — open a PR straight away.
- **Features or bigger changes** — open an issue (or ask in
  [Discord](https://discord.gg/v6kRbV7nC)) *first*, so we agree on the direction before you
  invest real time. PRs for undiscussed large features may be declined even when the code is
  good — sorry in advance; it keeps the product coherent.

## Dev setup

The product code lives in `turbollm/` (Node ≥22):

```bash
cd turbollm
npm install                  # daemon deps
cd web && npm install && cd ..

npm run build:web            # build the React UI -> src/webdist
npm run build:core           # build the native core (needs Rust, see below)
npm run start                # run the daemon in dev (hot TS via tsx) -> :6996
```

Frontend hot-reload: `cd web && npm run dev` (proxies `/api` and `/v1` to the daemon on
`:6996`).

**Stack:** Node ≥22.13 · TypeScript · Hono · `node:sqlite` · tsup — with a React 19 +
Tailwind v4 + shadcn/ui frontend, and a Rust core (`turbollm/core/`).

### The Rust core

**A Rust toolchain is required to run the daemon from source or run its tests.** The daemon
loads a native core (today: the GGUF header parser) and has no TypeScript fallback. Install
[rustup](https://rustup.rs); `turbollm/core/rust-toolchain.toml` pins Rust 1.100.0 and rustup
installs it on the first `cargo` command. On Windows you also need the MSVC build tools. Then,
from `turbollm/`:

```bash
npm run build:core           # builds the addon for this machine; rerun after any Rust change
```

Without it the daemon stops at startup with "TurboLLM's native core is not available for this
system". On Linux, `cargo xtask` also needs `libssl-dev` and `pkg-config`. The engine
crates (`turbollm-engine*`) load llama.cpp and LiteRT-LM at run time and sit behind the
off-by-default `engines`/`llama`/`litert` features, so building the addon needs no C++ toolchain
and no native engine library; only `cargo xtask build-llama` needs CMake. Real-native engine tests
skip locally when `TURBOLLM_LLAMA_LIB_DIR`, `TURBOLLM_TEST_GGUF`, `TURBOLLM_LITERT_LIB` or
`TURBOLLM_TEST_LITERTLM` is unset, and fail on CI; how to set them is in the core README. Rust tests, the Android library, goldens, versioning and releases are described in
[`turbollm/core/README.md`](turbollm/core/README.md).

## Before you open a PR

From `turbollm/`:

```bash
npm run typecheck            # must be clean
npm test                     # backend test suite must pass
```

If you changed anything under `turbollm/core/`, also run from `turbollm/core/`:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo xtask check-version    # core version must equal turbollm/package.json
```

Never hand-edit a file in `turbollm/core/fixtures/gguf/golden/`.

- Target `main` via a pull request — no direct pushes.
- Keep each PR focused on one change; small PRs get reviewed fast.
- **Cross-platform is a hard rule.** Everything must work on Windows, macOS, and Linux —
  use `path.join`, never hardcode path separators or platform-specific binary names without
  a `process.platform` guard.
- Match the surrounding code's style; don't reformat files you aren't changing.

## License

TurboLLM is source-available under the Functional Source License 1.1 with an Apache-2.0
future grant (SPDX `FSL-1.1-ALv2`) — see [LICENSE.md](turbollm/LICENSE.md). By contributing,
you agree that your contributions are licensed under the same terms, including the
Apache-2.0 future grant.

## Community

Questions, ideas, show-and-tell: [Discord](https://discord.gg/v6kRbV7nC).
