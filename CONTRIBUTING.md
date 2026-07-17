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
npm run start                # run the daemon in dev (hot TS via tsx) -> :6996
```

Frontend hot-reload: `cd web && npm run dev` (proxies `/api` and `/v1` to the daemon on
`:6996`).

**Stack:** Node ≥22.13 · TypeScript · Hono · `node:sqlite` · tsup — with a React 19 +
Tailwind v4 + shadcn/ui frontend.

## Before you open a PR

From `turbollm/`:

```bash
npm run typecheck            # must be clean
npm test                     # backend test suite must pass
```

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
