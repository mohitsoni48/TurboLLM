# Changelog

All notable changes to **TurboLLM** are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## How releases work

We tie one **git tag** to every **npm publish**, and accumulate changes under
`[Unreleased]` between publishes. To cut a release:

1. Move the `[Unreleased]` notes into a new `## [x.y.z] - YYYY-MM-DD` section.
2. Bump `version` in `package.json` to `x.y.z`.
3. Commit: `chore(release): vx.y.z`.
4. Tag it: `git tag vx.y.z` (matches the npm version, prefixed with `v`).
5. `npm publish`, then `git push && git push --tags`.
6. (Optional) Create a GitHub Release from the tag, pasting that section's notes.

So "what's new since the last publish" is always the `[Unreleased]` section, and every
published version on npm has a matching `vX.Y.Z` tag in git.

---

## [Unreleased]

_Nothing yet._

## [1.9.1] - 2026-07-29

**Run Claude Code itself inside a Code session, on your local model — plus Docker deployment for NVIDIA/AMD GPUs, and a batch of gateway fixes.**

### Added
- **Claude Code runs inside Code.** Pick `claude` as your Code agent (Settings → Code agent) and a
  session opens it in a full-screen terminal on your local model, in your project folder. The
  model picker, context ring, thinking-budget slider and stats row all keep working around it —
  the CLI replaces the transcript, not the controls. This needs an optional native terminal
  component; where it can't be installed, TurboLLM runs normally and simply doesn't offer the
  agent.
- **The CLI starts in the mode you picked.** Auto, Plan first, or Ask each step now carries over to
  Claude Code's own permission mode instead of it always starting on its default.
- **Terminal sessions survive a daemon restart.** Restarting TurboLLM no longer loses the
  conversation — reopening the session resumes that exact conversation, not whichever one happened
  to be most recent in the folder.
- **The thinking-budget slider applies to the CLI live**, per request, with no restart.
- **Switching models keeps your scrollback.** Choosing a different model drives the CLI's own
  `/model` command instead of killing and relaunching the terminal.
- **Docker deployment for NVIDIA (CUDA) and AMD (ROCm) GPUs** — ready-made `Dockerfile`s and
  `docker-compose` configurations that run TurboLLM in an isolated container while still reaching
  your GPU directly. Setup steps for both are in the README. (Thanks @ahmadteeb, #83.)

### Changed
- **The Code stats row is readable.** Each number is labelled (`Think 3.0k · Context 15% of 200.0k
  · Last turn ↑36.6k ↓36 · 2.0 tok/s`) instead of one run-on string, and it's now the same
  component whether you're using the built-in agent or a CLI.
- **The terminal pane** got the same side margins as the bar beneath it, and no longer shows a
  scrollbar over the CLI's own interface (wheel scrolling is unchanged).
- **The Code agent picker offers `turbollm` and `claude` only.** `pi` and `opencode` are withdrawn
  until their terminal integration is verified against a real binary — no half-working choices.

### Fixed
- **`400 Failed to initialize samplers: failed to parse grammar`** when using tools with some
  models — certain validation keywords in a tool's schema (length/size/range limits) blew
  llama.cpp's grammar limits and failed the *entire* request, not just the offending field.
- **Requests rejected by models with strict chat templates** ("System message must be at the
  beginning") — mid-conversation system messages are now folded into the leading one.
- **Engine errors are reported as they really are.** A bad request, an incompatible model, an
  overloaded engine and a crash used to arrive as the same generic 500 with no way to tell them
  apart.
- **Switching models while an agent was working could start a second engine** and load two models
  at once.
- **Android: GPU detection and the Engines tab.** GPU detection now works on Android, and the
  Engines tab renders correctly there instead of breaking. (Thanks @ciroprogamer, #80.)

### Discord
- You can now run **Claude Code itself inside TurboLLM's Code tab**, driven by your local model —
  in a real terminal, in your project folder, with the model picker and thinking-budget slider
  still right there. It picks up the mode you chose, and survives a restart of TurboLLM.
- Fixed the **`failed to parse grammar` error** that broke tool calls on some models, and requests
  being rejected outright by models with strict chat templates.
- Model errors now say what actually went wrong instead of a generic failure.
- **TurboLLM now runs in Docker**, with ready-made NVIDIA (CUDA) and AMD (ROCm) setups that still
  reach your GPU directly — thanks to @ahmadteeb. And on Android, GPU detection and the Engines
  tab are fixed — thanks to @ciroprogamer.

## [1.9.0] - 2026-07-25

**Code is now available to everyone by default, and can be exposed to other AI coding tools over MCP.**

### Added
- **Code is generally available.** No longer an opt-in experimental toggle — it's on for every
  install, no setup required.
- **`turbollm mcp-server`** — exposes Code as an MCP tool (`delegate_code_task`) so other
  MCP-compatible tools (Claude Desktop, Cursor, Windsurf, Cline, Claude Code, and more — not
  TurboLLM-specific) can hand off real coding tasks to your local model. A new "TurboLLM MCP"
  section in Developer walks through setup for any of them.
- **MCP marketplace:** added Context7 and Firecrawl to the built-in MCP server catalog.
- **AGENTS.md support is now configurable** — set your own project and global AGENTS.md file
  paths instead of only the default location.
- **Real token/sec stats for Code**, shown per turn instead of missing entirely.
- **Tool-call lines in Code now visually distinguish reads from writes**, so it's easier to see at
  a glance what the agent actually changed.

### Changed
- **Reverting further back in Code now just works**, instead of requiring you to resume first —
  a second revert cleanly supersedes the first.
- **The Developer pane's Server URL now shows your LAN address** when sharing is on, instead of
  `localhost` (which only works from this machine).

### Fixed
- **Two real security gaps closed in the Developer pane's API key management:** while LAN sharing
  is on and "Require an API key" is off, key management (viewing, creating, and revoking keys, and
  the per-CLI connect setup snippets that embed a live key) is now restricted to this machine only
  — previously any device on the network could reach it with no credential at all.
- **A rare crash during very long, continuous Code turns** — the daemon now proactively stops a
  turn just before it would hit the model's real context limit, instead of erroring out.
- **AGENTS.md/CLAUDE.md content was being sent to the model twice every turn** in Code — now sent
  once.

### Discord
- Code just graduated from "experimental" to on-by-default for everyone.
- You can now plug TurboLLM's Code agent into Claude Desktop, Cursor, Windsurf, Cline, or any other
  MCP-compatible tool — not just Claude Code — via a new `turbollm mcp-server` command. Setup
  instructions are right there in the Developer tab.
- Closed two real security holes: on an open, unauthenticated LAN, another device could previously
  view/create/revoke your API keys or grab a live one from the connect-setup snippets just by
  loading the page. Both now require you to be on the host machine (or have auth turned on).
- Reverting further back in a Code session now just works, instead of demanding you resume first.

## [1.8.7] - 2026-07-24

**Code feature: a denser, more familiar terminal-style redesign, a real prefill progress bar, and a fix for a rare stuck-loop bug.**

### Added
- **Real prefill progress bar in Code.** While the model is processing a large prompt, Code now
  shows live progress (processed/total tokens) by polling the local engine's `/slots` endpoint —
  independent of the underlying agent SDK, which doesn't expose this natively.
- **Consecutive similar terminal commands are now grouped** into a single expandable unit (e.g. a
  run of `git` commands) instead of each appearing as its own separate line.
- **A hard stop for tool-call loops.** If the model keeps repeating the exact same tool call after
  already being told to stop, the run is now aborted outright and reported as a stopped run,
  instead of silently repeating the same unhelpful nudge forever.

### Changed
- **Code's UI redesigned toward a denser, more familiar terminal feel** — closer to what users of
  tools like opencode/Claude Code CLI already expect: flat tool-call lines instead of cards, a
  persistent stats footer, a loaded-resources header (AGENTS.md/skills), and updated icons.

### Fixed
- User message cards in Code had an odd, hard-to-notice copy/revert button layout and low-contrast
  background in dark theme — buttons moved outside the card and background contrast increased.
- Terminal commands run by the agent now default to **collapsed** instead of expanded.
- Removed a duplicate stat ("Auto · 16% ctx") that was shown twice in the Code composer footer.
- A visual clipping bug on the "running" status banner's rounded corners.

### Discord
- Code now shows a live prefill progress bar while the model processes large prompts.
- Code's UI got a denser, more familiar terminal-style redesign — flat tool lines, a persistent
  stats footer, and grouped terminal commands.
- Fixed a rare bug where a stuck AI tool-call loop in Code could repeat forever instead of
  stopping.

## [1.8.6] - 2026-07-24

**New engine: Solar Open 2, via a checksum-verified patch build.**

### Added
- **Solar Open 2 (250B-A15B) engine catalog entry.** Its architecture isn't in mainline
  llama.cpp yet — this builds official llama.cpp at a pinned commit with a community patch
  applied, entirely through the existing "Build from source" 1-click flow. The patch is
  downloaded and verified against a pinned SHA-256 before it's ever applied; a mismatch hard-fails
  the build with no fallback.
- The 1-click build pipeline gained a general `patchUrl`/`patchSha256` capability — reusable by
  any future engine that needs a pre-compile patch, not specific to this one.

### Fixed
- **Building official llama.cpp from source could fail on Windows with "Filename too long."**
  `core.longpaths` was never set, so any repo with deeply-nested paths (llama.cpp's own
  `tools/ui` and `examples/llama.swiftui` included) broke the checkout. Not specific to any one
  engine — this affected every Windows "Build from source" flow against the official repo.
- **The Engines screen could misreport a catalog entry as already built.** The "is this already
  installed" check matched any registered build of the same repository URL, ignoring which
  commit/patch it was built from — so an existing plain llama.cpp build could make a
  differently-pinned entry (like Solar Open 2) falsely show as installed, handing out a binary
  that didn't actually have the needed support.

### Discord
- New engine: **Solar Open 2** (Upstage's 250B model) — 1-click build right from the Engines
  screen, patch verified automatically before it's applied.
- Fixed a Windows bug where building official llama.cpp from source could fail on repos with long
  file paths.

## [1.8.5] - 2026-07-23

**Three gateway bugs fixed, all affecting the Claude Code / Anthropic-protocol integration
(`turbollm launch claude`).**

### Fixed
- **The OpenAI-compatible `/v1/*` pass-through could return a bodyless 500.** A client
  disconnecting at just the wrong moment (before its engine request was sent) left `fetch()` an
  already-aborted signal, which throws immediately with no guard around it. Now caught and
  returned as a structured error distinguishing a client disconnect from a real engine-unreachable
  failure.
- **Claude Code's extended-thinking budget was never forwarded to the local model.** With no
  budget set, the model could spend its entire response budget on reasoning and never reach a
  visible answer — the request succeeded, it just looked like silence. Now forwarded to the
  engine (defaulting to a conservative share of the response budget when the client leaves it
  unset), and bounded so an explicit budget can't do the same thing when a server-side response
  cap is configured.
- **A hook-injected context message could get silently misread as something the assistant had
  already said**, which made the local model treat its turn as already finished and produce no
  visible response at all — the real root cause of `turbollm launch claude` intermittently
  producing nothing. Now mapped correctly.

### Discord
- Fixed a bug where `turbollm launch claude` could silently produce no response at all — no error, just silence.
- Local models used with Claude Code now budget their reasoning properly instead of occasionally spending the whole response on thinking.

## [1.8.4] - 2026-07-22

**Two new engine catalog entries, and downloads can now actually be resumed.**

### Added
- **Engine catalog: Prism and BeeLlama** — two llama.cpp forks, build-from-source (guided
  walkthrough). Prism specializes in 1-2 bit ternary/Bonsai models; BeeLlama adds
  variance-normalized KV-cache quantization (KVarN), a KV precision tail, and adaptive DFlash
  speculative decoding.

### Fixed
- **Interrupted downloads can now be resumed.** A download interrupted mid-transfer (e.g. a daemon
  restart) previously came back showing "Paused" with no way to continue it — Cancel was the only
  option. A Resume action now picks up exactly where it left off, byte-for-byte.

### Discord
- Two new engines in the catalog: **Prism** (great for 1-2 bit ternary models) and **BeeLlama**
  (better KV-cache compression + speculative decoding). Both build from source with a guided
  walkthrough — no manual setup.
- Fixed a real annoyance: an interrupted download used to be stuck forever with no way to continue
  it. Now it just resumes.

## [1.8.3] - 2026-07-22

**API token tracking, tool/model config batch, and two real bug fixes (mmproj pairing, an
`/api/*` CORS hole).**

### Added
- **Usage tracking now covers the gateway, not just in-app chat** — tokens hitting the
  OpenAI/Anthropic-compatible gateway from external tools (Claude Code, other CLIs/extensions)
  now count toward the Overview totals and lifetime milestone, with a dedicated API tab for the
  breakdown by source and model. (#71)
- **Auto-allow-all tools toggle** (Settings → Tools & safety) — skip the approval prompt for every
  tool set to Ask; a tool explicitly set to Deny still stays blocked.
- **Custom/raw engine flags** — a field in the model config panel to append arbitrary
  command-line flags to the launch command.
- **Per-model engine port** — pin a model's engine to a specific port instead of always
  auto-assigning the first free one.
- **Independent K/V cache quant** — the KV cache type is now two selects (K and V) instead of one
  combined dropdown, so you can e.g. keep K at full quality while quantizing V.
- **Copy launch command** — copies the exact command to run the loaded model standalone with
  llama.cpp/the fork directly, no TurboLLM required.

### Fixed
- **Security: `/api/*` had wildcard CORS**, letting any website silently read a loopback user's
  GPU/CPU/RAM via unauthenticated `/api/v1/sysinfo` while the daemon ran. Tightened to an origin
  allowlist; the OpenAI/Anthropic gateway (`/v1/*`) stays fully open, as it needs to be.
- **A folder with more than one vision model could load the wrong image projector** onto a model,
  which then failed to start. Projector pairing now matches by filename correlation, falling back
  to closest-modified-time, instead of always picking the directory's largest file.
- **VRAM estimate assumed the V cache quant always matched K** — now weighted independently, so an
  asymmetric K/V setting (e.g. K=q8_0, V=f16) reads correctly instead of over- or under-estimating.
- Two token-tracking gaps found while building the API tab above: a non-streaming OpenAI-compatible
  request could silently record zero usage, and a streaming one omitted usage entirely without an
  explicit opt-in flag.

### Discord
- New Usage → API tab shows how many tokens Claude Code and other external tools are pulling through TurboLLM — not just in-app chat.
- Auto-allow-all toggle to skip tool approval prompts when you want; Deny always still blocks.
- Model config: pin a model to a specific port, add custom launch flags, set K and V cache quant separately, and copy a ready-to-run llama.cpp command.
- Fixed a bug where a folder with more than one vision model could load the wrong image projector.
- Closed a security hole where any website could quietly read your GPU info while TurboLLM was running.

## [1.8.2] - 2026-07-21

**Research mode that works to stay current, correct VRAM estimates for modern models, and a batch
of chat-UI polish.**

### Fixed
- **Research mode no longer leans on stale training data.** A full overhaul of the research
  pipeline: it now reads each source's real publication date, prefers primary/official sources
  over "best of" listicles, discovers what's *current* before drilling into names it already
  remembers, hands the model far more of each page to read (not a one-sentence snippet),
  de-duplicates results, and searches more before composing an answer. Ask it something like "the
  best open models for my GPU" and it works to surface today's answer instead of last year's.
- **VRAM fit estimates were badly over-counting for modern models.** Recent Qwen (3.5 / 3.6 /
  Next) and Gemma (3 / 4) use attention designs where only some layers keep a growing KV cache, but
  TurboLLM counted every layer at full context — over-estimating KV-cache memory by up to ~18× and
  wrongly flagging models as "tight" or "won't fit." Estimates now read the model's real attention
  layout from the GGUF. Models whose layout isn't declared keep the previous conservative estimate.
- **Chat markdown now renders with proper styling** — headings, lists, tables, and code blocks
  (with a language label and syntax highlighting) were previously flat, unstyled text.
- **Low-contrast text fixed** — faint/secondary text now meets WCAG AA contrast in both dark and
  light themes.
- **Scroll position is preserved when switching between conversations** instead of jumping to the
  bottom.
- **Windows: discrete AMD/Intel GPUs no longer misreport as ~4 GB VRAM** when the registry read
  exits with a non-zero status — the valid 64-bit VRAM value is now kept. (Thanks @almshary, #69.)
- **Code: the agent no longer gets stuck repeating the same action.** A local model could fall
  into an infinite loop, calling the same tool with the same arguments over and over — the run
  never finished and Stop/queue couldn't take effect. It now detects a repeated identical call and
  automatically breaks the model out of the loop, and its built-in "stop retrying, look it up"
  guidance (which had been silently ineffective) works again.

### Discord
- Code no longer gets stuck in an infinite loop repeating the same action — it now detects when a local model keeps making the identical call and automatically breaks it out so the run can finish.
- Research mode got a big accuracy overhaul — it now checks how recent each source is, prefers official/primary sources over SEO "best of" listicles, and reads full pages instead of snippets, so it works to give you today's answer instead of last year's.
- VRAM fit estimates are now correct for modern Qwen and Gemma models — TurboLLM was massively over-counting KV-cache memory and wrongly saying big models "won't fit" when they actually do.
- Chat renders markdown properly now (headings, tables, code blocks with syntax highlighting), text contrast is fixed in dark and light themes, and your scroll position is kept when you switch chats.
- Windows fix: AMD/Intel GPUs that were showing 4 GB now report their real VRAM — thanks to contributor @almshary.

## [1.8.1] - 2026-07-17

**A large batch of reliability fixes — auto-tune accuracy, Code's revert-to-message and /compact,
and a real VRAM-detection bug — plus an opt-in MoE auto-tune "VRAM-spill" search.**

### Added
- **MoE auto-tune "VRAM-spill" search** (opt-in) — set VRAM headroom to 0 (Settings → Models &
  loading → Advanced) to let auto-tune keep pushing more experts onto the GPU past its normal
  safety margin, as long as both generation AND prompt-processing speed keep improving. Off by
  default; your configured headroom is otherwise always honored exactly as before.
- Auto-tune's results dialog now also shows prefill (prompt-processing) speed, not just generation
  speed.

### Fixed
- **Auto-tune vs. real chat speed gap** — the benchmark now uses a representative prompt and depth
  instead of a short generic one, so the tok/s it reports is much closer to what you'll actually
  see in a real conversation.
- **Auto-tune no longer picks the KV-cache type for you** — it tunes GPU/CPU offload on whichever
  KV type you already have selected, and shows an advisory note (not an automatic switch) when a
  faster type is available. Fixes a case where the "quality-preserving" pick auto-tune made was
  measurably slower and used more VRAM than a manual choice.
- Auto-tune wrongly skipped single-GPU placement whenever a model missed fitting fully on one card
  by even a hair, forcing a slower cross-GPU split even when the split had plenty of room to spare
  (#62). A related fix stops a noisy VRAM reading from silently ruling out a smaller KV-cache type.
- Auto-tune could lose an unsaved manual config edit when a run started, and Cancel could take up
  to 8 seconds to actually stop.
- **AMD/Intel dedicated GPUs on Windows could be reported as ~4 GB VRAM** regardless of their real
  size, due to a 32-bit limit in the Windows API used to read it (#63).
- **1-click engine build failed with a bare "Code 1"** for a repo that isn't a CMake project (e.g.
  exllamav3) — now fails fast with a clear explanation instead (#61).
- **Code: long sessions that ran out of context just failed** instead of compacting, with no way
  to continue; a related crash from a background language-server message race is also fixed (#60).
- **Code: revert-to-message was fundamentally broken** — reverting to an earlier message could
  leave it (and its reply) still showing, or in some cases hide the wrong part of the conversation
  entirely. Reverting now correctly discards the reverted message and everything after it, and
  `/resume` still brings it back exactly as before.
- **Code: manual `/compact` always said "nothing to compact,"** no matter how long the real
  conversation was — root-caused to how a session's most recent turn interacted with the
  underlying compaction logic. Also added a real "Compacting conversation…" indicator; previously
  the composer just went blank with no feedback while it worked.
- Code: Blank persona could still leak tool instructions into the model despite promising none; an
  aborted/empty message kept showing Copy/Edit controls; an interrupted generation could show 0
  tokens even though real output was saved; and hover-only actions in chat/Code were unreachable on
  touch devices — all fixed.
- Code: custom-added engines (via "Add via git repo" or a manual path) now get the same
  Disable/Enable/Delete/Rebuild controls a built-in catalog engine has.
- Sidebar conversation titles now update live without a page reload; an auto-generated title no
  longer gets derailed by injected memory facts on a brand-new chat.
- macOS engine parity fixes (Metal builds, Rapid-MLX, and other cross-engine fixes) (#50).

### Discord
- Fixed a real VRAM-detection bug that showed some AMD/Intel GPUs as ~4 GB regardless of their
  actual size.
- Auto-tune is noticeably more accurate now — it no longer silently picks a slower KV-cache type
  or skips single-GPU placement when it shouldn't, and its benchmark better matches real chat speed.
- Code's revert-to-message and manual `/compact` were both broken in ways that made long coding
  sessions painful — both are fixed, and `/compact` now shows real progress instead of going silent.
- New opt-in "VRAM-spill" search for MoE models — trade a configurable safety margin for extra
  speed, only if you turn it on.

## [1.8.0] - 2026-07-14

**Code — a local coding agent that reads, edits, and runs commands in a real project directory,
entirely on your own machine — plus graduated thinking-budget control and a new Experimental
settings section.**

### Added
- **Code** (Workspace → Code, opt-in via Settings → Experimental) — a local coding agent built on
  the same model you already have loaded. Point it at a real repo folder (optionally in an
  isolated git worktree so your checkout stays untouched), hand it a task, and it plans, edits
  files, runs shell commands, and reports a real diff — all local, nothing leaves your machine.
  - **Session workspace**: persistent sessions with archive/filters, revert-to-message (with
    optional real file-edit reversal), "Add context" file attachments, honest skill invocation,
    `AGENTS.md`/`agents.md` support, transcript copy, and a real "Coding activity" dashboard
    (sessions, tasks shipped, files touched, diff shipped, streaks) — no mock data.
  - **Real LSP integration** for TypeScript/JavaScript and Python — Code detects the language,
    installs the language server if needed, and uses it for edits.
  - **The same tools Chat gets from Customize** — any connected MCP server, plus the sandboxed
    `run_code` tool — are now available to Code sessions too.
  - **Independent API-key gating** on non-host devices, separate from Chat's own gate.
- **Graduated thinking-budget control** (Chat and Code) — a real token-budget slider, not just an
  on/off toggle: cap reasoning to a specific token count, turn it off entirely, or leave it
  unlimited.
- **Settings → Experimental** — a new opt-in section gating three still-in-progress features
  (Code, Memory, Cloud Launch/RunPod), off by default. Disabling Code removes its entry point
  entirely.

### Fixed
- macOS: Metal builds, Rapid-MLX, and other cross-engine parity fixes (#50).
- Multi-GPU: the auto-tuner now tunes the actual split across cards, not just offload + KV quant
  (#57).
- Code: a turn could truncate to almost no output (a single reasoning token, then a hard stop)
  whenever the prompt — system prompt plus the full tool-schema catalog — used a large enough
  share of the loaded model's context window. Every Code turn now generates until it naturally
  finishes or the context genuinely runs out, instead of stopping at a stale token ceiling fixed
  at model-load time.
- Code: context-usage % now updates live during a run and no longer drops to near-zero on an
  aborted turn or resets to 0% right after a completed turn.
- Code: message and tool-call order is now preserved exactly as it happened on completed turns.
- Code: a stop hit while a turn was queued behind another generation is now recorded as a clean
  interrupt instead of a cryptic failure.

### Discord
**Features**
- **Thinking-budget slider** — dial reasoning length up, down, or off, for both Chat and Code.

**Bugfix**
- macOS: Metal builds, Rapid-MLX, and other cross-engine parity fixes.
- Multi-GPU: the auto-tuner now tunes the actual split across cards, not just offload + KV quant.

**Experimental** *(Settings → Experimental, off by default)*
- **Code** — a local coding agent, right in TurboLLM. Point it at a project folder, describe a task, and it reads, edits, and runs commands to get it done — entirely on your own GPU.
- **Memory**'s on/off switch now lives here too (its settings stay in General).
- **Cloud Launch (RunPod)** — earliest stage, a toggle for what's coming.

## [1.7.7] - 2026-07-10

**Custom engine self-service, auto-fit GPU/MoE offload, and two real bug fixes.**

### Added
- **Custom engine: build from any git repo** — Engines → "Add via git repo" lets you point at
  any llama.cpp-compatible fork's URL (+ optional branch) and build it in-app with one click,
  reusing the existing build pipeline. No more manually cloning and adding the binary by hand.
- **Auto-fit GPU layers / MoE CPU offload** — new toggles in a model's Load settings (and
  honored by Auto-tune) that let llama.cpp decide the GPU/CPU split for you at load time,
  instead of a fixed number — useful when a large context or model doesn't fit the old fixed
  default. Off by default.

### Fixed
- A brief empty message bubble could appear above the real reply on a fresh chat send, with
  working Copy/Edit/Delete controls on it — a backend placeholder message racing the UI's
  optimistic refresh.
- On a machine with an integrated GPU, its VRAM was sometimes reported as if it were dedicated
  graphics memory, causing wrong model-quant defaults and false "won't fit" warnings.

### Discord
- Add a custom engine straight from a git repo URL and build it in one click — no more manual clone-and-point.
- New "Auto-fit" option for GPU layers and MoE offload: let TurboLLM figure out the best split automatically instead of guessing a number yourself.
- Fixed a rare empty-message flash in chat and a VRAM-reporting bug on integrated GPUs.

## [1.7.6] - 2026-07-09

**Token usage dashboard and an opt-in auto-memory feature.**

### Added
- **Usage dashboard** (new nav tab, replaces nothing — sits above Developer) — an adaptive
  GitHub-style activity heatmap (1-hour boxes for the 7-day view, 12-hour for 30-day, 1-day for
  all-time, always the same overall size), 8 stat tiles (sessions, messages, total tokens, active
  days, streaks, peak hour, favorite model), a per-model tab with a stacked usage chart and ranked
  legend, and a lifetime milestone ladder with a rotating "you've generated more tokens than X"
  comparison.
- **Auto-memory** (Settings → Memory, tagged **Experimental**, off by default) — silently extracts
  durable facts you mention in chat (name, preferences, hardware, projects) using the model you
  already have loaded, and adds them to future new conversations. Nothing leaves your device. A
  reviewable, deletable fact list lives right in the toggle section — turning it off immediately
  stops new facts from being injected into new chats.

### Discord
- Added a usage dashboard to show your tokens — input and output, per model, with a daily
  activity heatmap and streaks.
- Added an experimental auto-memory option (off by default): TurboLLM can remember things you
  mention, like your name or hardware, and bring them into new chats. Reviewable and deletable
  from Settings, and it never leaves your machine.

## [1.7.5] - 2026-07-09

**Chat branching, message editing, preserve-thinking, and a background-generation UX pass — plus a real CUDA fallback bug and a model-swap silent failure fixed.**

### Added
- **Chat branching** — editing a message or regenerating a reply no longer overwrites history:
  both create a branch, switchable via a ‹ 1/2 › control on the message, including nested branch
  points (branching inside an already-branched conversation).
- **In-place message editing for assistant replies** — fixes the text without triggering a new
  generation; shows an "Edited" tag.
- **Preserve thinking across turns** (Thread settings) — resends the model's past reasoning on
  later turns, not just its final answers. On by default for new conversations.
- **Thread settings usable on a blank chat** — reachable as soon as a model is loaded, even
  before the first message is sent.
- **Sampling sliders now default to the loaded model's own recommended values** instead of fixed
  generic constants.
- **Skills list in Thread settings is now collapsible** (collapsed by default) with a master
  on/off checkbox.
- **Pinned models now sort to the top of the chat model picker**, not just the Library list.
- **Background-generation sidebar indicators** — a live spinner on any conversation still
  generating in the background, and a dot on one that finished while you were elsewhere.

### Changed
- **Switching conversations no longer cancels an in-flight reply** — it keeps generating and
  saves normally; only an explicit Stop/Eject/delete cancels a generation now.
- Custom-added engines now render their own card in the engine gallery instead of being invisible
  next to auto-downloaded official builds.

### Fixed
- The CUDA backend could silently fall back to CPU if its cudart runtime bundle never finished
  downloading — a completeness check now catches this and backfills existing installs without
  forcing a re-download.
- Reloading the same model or switching models could sometimes leave nothing loaded, with no
  error shown — a slow engine stop could abandon the load silently.
- Engine directory scanning could crash on a permission-restricted subfolder.
- A streaming display bug could briefly show an empty "thinking" block.
- The Thread settings dialog could overflow off-screen with a lot of skills installed.
- `ConversationSettingsDialog` now uses an accessible dialog title (screen-reader fix).

### Discord
- Editing a message or regenerating a reply no longer wipes out what came after it — every version is saved, and you can flip between them.
- Chats now remember their own reasoning across turns by default, so follow-up questions actually build on what the model already figured out.
- Switching to a different chat mid-reply no longer kills the generation — it finishes in the background, and the sidebar shows you which chats are still working (and which ones just finished).
- Fixed a couple of real bugs: the CUDA backend silently falling back to CPU on some installs, and switching models sometimes leaving nothing loaded at all.

## [1.7.4] - 2026-07-07

**Engines, Library, Developer, and Settings redesigned, and every screen now works on mobile.**

### Added
- Mobile-responsive layouts across every screen (drawer navigation, stacked cards, horizontal
  tab strips, split panes that stack vertically) — the desktop/landscape layout is unchanged.
- **Library**: a dedicated Folders dialog with a real folder picker for managing model
  directories, plus name search and facet-aware filter chips (a chip only appears if at least
  one model has it).
- **Engines**: per-card hardware-fit indicators (green/amber/red: Compatible / runs after a
  build / incompatible + reason) and grounded pros/cons for every engine.
- The folder/file picker (used by model folders and "Add your own engine") gained an editable
  address bar — paste or type an absolute path and jump there directly, alongside click-to-browse.

### Changed
- **Library**: rows are now a column-aligned two-tier layout (name + one state signal + quiet
  capability chips, with aligned Quant/Size/Ctx/Speed columns); multi-quant models fold into one
  row with a quant dropdown instead of a collapsible group.
- **Engines**: the active-engine bar and hardware-fit selector merged into one panel with a
  run-state traffic light (green running / amber starting / red error / grey stopped); llama.cpp
  variants unified under one "Manage GPU builds" card; "Add your own engine" moved into a compact
  strip.
- **Developer**: narrowed to connecting external tools — a Connection panel, one-command CLI
  setup cards, and a collapsed API reference. Cloud Deploy (RunPod) moved behind an internal
  feature flag, off by default.
- **Settings**: reorganized into a two-pane, five-category layout (General · Models & loading ·
  Tools & safety · Network & sharing · System) with one sticky Save bar; expert knobs (GPU
  layers, VRAM headroom, image/response token caps) moved into a collapsible Advanced section.
  Tool permissions moved here from Developer (Settings → Tools & safety).
- "Add your own engine" filesystem browsing is local-only (same restriction as engine scanning)
  but can now browse the whole local filesystem, including other drives on Windows — previously
  confined to your home directory.

### Fixed
- Every dialog now keeps a gutter on narrow screens instead of rendering flush to the viewport edge.
- Assorted mobile overflow issues: chat header controls clipping on narrow screens, Library
  action buttons pushed off-screen, Settings controls clipped at the edge, and long Hugging Face
  repo names/inline code overflowing their containers.

### Discord
- New, clearer look for the Engines, Library, Developer, and Settings screens.
- The whole app now works properly in your phone's browser, not just on desktop.
- Picking a model folder or a custom engine now lets you paste in a path directly, or browse to any drive.

## [1.7.3] - 2026-07-06

**The standalone Agents screen is retired — replaced by a shared Skills library used directly in chat, plus a new Agents tab in Customize for editing personas and building your own.**

### Added
- **Skills.** A shared library of reusable instructions (Claude-style SKILL.md format) any
  conversation can enable — via the `/` picker in the composer (Tab-complete included) or a
  conversation's settings. Manage the library from Customize → Skills: upload a SKILL.md
  directly, or have TurboLLM learn one from a folder of docs or distill one from an existing
  conversation's transcript.
- **Agents in Customize.** A new Agents tab (alongside Skills and MCP Servers) lets you edit any
  built-in persona's system prompt, skills, and tool access in place — with a Reset button to
  restore the original — or create your own custom agent from scratch. Each agent gets a name,
  description, system prompt, and checklists for which shared skills and which tools it may use
  (everything on by default). MCP tools are grouped by server with one toggle to select or
  deselect all of a server's tools at once, or expand to pick individually.
- **Two new built-in agents.** **Lite** strips the hidden system prompt to the bare minimum for the
  fastest possible responses (every tool still available); **Code** is tuned for precise, idiomatic
  code with minimal narration.

### Removed
- **The standalone Agents screen** (background tasks running separately from chat) is gone. It's
  replaced by Skills used directly inside chat — the same idea, giving the model reusable extra
  capabilities, without a separate surface to launch into, reconnect to, or lose track of.

### Discord
- New: Skills — a shared library of reusable instructions you enable per chat with `/`, manage in
  Customize, upload, or have TurboLLM learn from a folder or an existing conversation.
- New: Customize → Agents — edit any built-in agent's prompt/skills/tools in place, or create your
  own from scratch, with a Reset button on the built-ins.
- New: Lite (fastest, bare-bones prompt) and Code (coding-focused) agents.
- Changed: the old standalone Agents screen (background tasks) is retired in favor of Skills in
  chat.

## [1.7.2] - 2026-07-06

**MTP / speculative-decoding models load and run correctly, the Windows install crash is fixed, and auto-tune now respects your MTP setting.**

### Added
- **Developer → Connect a CLI now covers every launch target.** `openclaw` and `hermes` have their
  own cards (previously missing), and opencode / kilo / openclaw / hermes each lead with the
  one-command `turbollm launch <cli>` setup, with the manual config kept as a fallback.

### Changed
- **Auto-tune respects your MTP setting.** Running auto-tune on an MTP / NextN model now tunes with
  speculative decoding active — so the chosen GPU/CPU offload leaves room for its real memory
  footprint — and keeps MTP enabled in the saved profile instead of silently turning it off.

### Fixed
- **Install no longer crashes on Node 22.5–22.12.** TurboLLM uses Node's built-in SQLite, which only
  works without an experimental flag on **Node 22.13.0+**. Below that, `npx turbollm` crashed with an
  obscure `node:sqlite` error; it now requires 22.13.0+ and says so clearly. ([#40](https://github.com/mohitsoni48/TurboLLM/issues/40))
- **MTP / speculative-decoding models load again.** A newer llama.cpp renamed its speculative-decoding
  flags; TurboLLM kept passing the removed ones, so any MTP model failed to load. It now detects and
  uses the current flags, and auto-corrects engines that were already installed. ([#43](https://github.com/mohitsoni48/TurboLLM/issues/43))
- **MTP no longer balloons system RAM.** Native MTP was loading a second full copy of the model into
  RAM (tens of GB on large models) and running *slower*; it now uses only a small amount of extra
  memory and runs faster, as intended.

### Discord
- Fixed: MTP / speculative-decoding models load again.
- New: auto-tune keeps your MTP setting on (and tunes with it active) instead of quietly switching it off.
- New: the Developer → Connect a CLI screen now shows one-command setup for opencode, kilo, openclaw, and hermes too.

## [1.7.1] - 2026-07-05

**Local coding CLIs: model pinning restored, `/model` now lists your local models, and four new launch targets.**

### Added
- **`turbollm launch opencode|kilo|openclaw|hermes`** — wire any of these coding CLIs to your
  local model with one command, the same way `turbollm launch claude` already does. opencode,
  kilo, and openclaw each get a `turbollm` provider merged into their own config file (an
  existing config — comments included — is preserved as-is if it's already pointed at
  TurboLLM); hermes is configured through its own `hermes config set` command instead, since its
  config file is YAML.
- **Claude Code's `/model` picker now lists your local models**, so you can switch mid-session
  instead of only at launch. Turn on **Auto Model Swap** in Settings → Gateway first — the
  picker only shows local models when a pick can actually load (otherwise it would silently do
  nothing).

### Changed
- **`turbollm launch claude` pins the loaded model again by default**, not just when you pass
  `--model`. Claude Code uses the model name for its status line, `/status`, and context-window
  sizing even when talking to a local model, so this keeps all three accurate instead of
  guessing a cloud default.

### Discord
- New: `turbollm launch opencode`, `kilo`, `openclaw`, and `hermes` wire those coding CLIs to your local model, same as `turbollm launch claude`.
- New: Claude Code's `/model` picker can now show and switch between your local models (turn on Auto Model Swap in Settings → Gateway first).

## [1.7.0] - 2026-07-04

**A configurable VRAM headroom, a real tool-call approval gate for chat, and engine build fixes.**

### Added
- **VRAM headroom slider** (Settings → Engine, 300 MB–2 GB, default 1 GB) — tell auto-tune how
  much VRAM to keep free for other GPU workloads (ComfyUI, a browser full of tabs, etc.)
  instead of the previous fixed 1 GB margin.
- **Tool-call approval gate for chat** — every tool call (web search, fetch URL, run code, MCP
  tools) now asks for your approval by default before it runs. A small bar appears above the
  message box with **Deny**, **Allow**, **Allow for this chat**, or **Always Allow**. Set
  per-tool defaults (Ask / Allow / Deny) globally from Developer → Tool permissions. Replaces the
  old `run_code`-only confirmation, which didn't actually work (it always ran anyway). Background
  agents are unaffected — a tool an agent is configured to use still runs without a prompt, since
  there's no one there to ask.

### Fixed
- **Dual-GPU systems no longer show the wrong VRAM total** on the Engines screen — the "Your
  hardware" hero card fell back to a single un-summed GPU's VRAM instead of the primary-vendor
  sum whenever the recommendation query hadn't resolved yet, which happened on effectively every
  page load.
- Source builds (CUDA engines) no longer fail configure with a `-- unsupported Microsoft Visual
  Studio version!` CMake error on newer VS releases (e.g. VS2026) that CUDA's nvcc doesn't yet
  recognize as a supported host compiler — cmake now passes nvcc's own `-allow-unsupported-
  compiler` escape hatch by default, for both the in-app 1-click build and the manual command
  list in the build guide.
- The build guide's manual command list no longer produces an engine that silently runs CPU-only:
  a source build doesn't bundle the CUDA runtime, so the commands now also copy the CUDA
  DLLs/shared libs next to the binary — matching what the 1-click build already does.
- The opencode connect snippet now uses the correct singular `provider` config key.

### Discord
- New: a VRAM headroom slider in Settings → Engine lets you tell auto-tune how much VRAM to keep free for other apps like ComfyUI.
- Tool calls in chat (web search, fetch, run code, MCP tools) now ask for your approval by default, with Deny, Allow, Allow for this chat, or Always Allow.
- Fixed dual-GPU systems showing the wrong total VRAM on the Engines screen.

## [1.6.5] - 2026-07-03

**Per-engine model config, chat folders, and a real fix for the MTP draft window.**

Closes out the remaining items from issue #35. The v1.6.4 "MTP control" and "per-engine
config" fixes shipped incomplete — this release fixes both for real, plus adds chat
folders and better file-attachment support.

### Added
- **Model settings are now saved per engine, not shared across every installed engine.**
  Previously, switching from one engine to another (or between two installs of the same
  engine) silently reused the same saved profile. Each engine now keeps its own tuning;
  an untuned engine falls back to whichever engine's profile you saved most recently.
- **Chat folders** — organize conversations into folders in the sidebar (create, rename,
  delete, move). Deleting a folder never deletes the conversations inside it — they move
  back to Uncategorized.
- **The chat sidebar's width is now drag-resizable.**
- **More file types are accepted as chat attachments** — JSON, YAML, log files, and common
  source-code extensions, alongside the existing text/PDF/image support.

### Fixed
- **MTP and NextN speculative decoding now actually honor the draft min/max settings** —
  v1.6.4 wired the control into the generic "draft" mode only, not the MTP/NextN modes the
  original request was actually about.
- **The model-load menu now shows a visible settings icon on every row**, instead of relying
  on an easy-to-miss "Alt+click to configure" hint (Alt+click still works as a shortcut).
- **PDF attachments now extract real text** instead of silently sending garbled binary —
  they were already accepted, but the content sent to the model was unusable.
- **Folder contents in the sidebar are now visually distinguishable** from conversations
  outside any folder (a clear indent guide, plus an explicit "Uncategorized" label).

### Discord
- Model settings now save per engine — switching engines (or forks like ik_llama.cpp) no longer overwrites your other engine's tuning.
- Added chat folders — organize your conversations, with a drag-resizable sidebar.
- Fixed MTP/NextN draft-window controls (they only worked for one speculative mode before).
- PDF attachments now actually work — previously the text sent to the model was garbled.

## [1.6.4] - 2026-07-03

**GPU VRAM detection, Windows build fixes, multi-part download fixes, and model list improvements.**

### Added
- **MTP / speculative-decoding draft window is now configurable** — set min/max drafted
  tokens per step directly in a model's Load settings, instead of a fixed 16/1.
- **Pin/favourite models** to the top of your library list with a star toggle.
- **Auto-tune now reads a model's recommended sampling settings from a structured params
  file** when the quantizer publishes one (e.g. unsloth's `gpt-oss-120b-GGUF`), instead of
  only scraping the README — more accurate, and no extra model reload needed to find it.

### Fixed
- **Multi-GPU VRAM is now summed correctly, and a non-primary GPU (e.g. an Intel iGPU
  alongside your NVIDIA/AMD card) is excluded from the total** — a dual-GPU box was
  under-reporting its real VRAM, and a laptop with an iGPU could over-report it.
- **AMD GPU VRAM is now detected correctly on Windows** via `rocm-smi` — previously capped
  at ~4GB by a Windows limitation, so a 24GB card could show as 4GB.
- **Windows engine builds no longer fail with `spawn cmd.exe ENOENT`** during a from-source
  build (e.g. `ik_llama.cpp`).
- **Multi-part GGUF downloads (e.g. `gpt-oss-120b`) no longer get wrongly flagged "missing
  parts"** when every shard actually downloaded correctly.
- **Deleting a conversation now asks for confirmation** (toggle in Settings), and warns if a
  response is still generating in it.
- **The Discover model page no longer closes itself** every time you click Download — stays
  open so you can queue another quant without losing your place.
- **The built-in web search options (Customize) now show their descriptions** — including
  that SearXNG needs no API key.

### Discord
- Model VRAM detection is more accurate now — multi-GPU setups and AMD cards report correctly.
- Fixed a Windows bug where building an engine from source could fail outright.
- Multi-part model downloads (like gpt-oss-120b) no longer get stuck saying files are missing.
- You can now pin your favorite models to the top of the list, and tune MTP draft settings per model.
- The model download page stays open after you hit Download, so you can grab another quant right after.

## [1.6.3] - 2026-07-02

**Download folder structure, mmproj, and multipart quant fixes.**

A bug-fix release for Discover downloads. GGUF models were landing flat in your model
folder, split/multipart quants only fetched their first shard, and a vision model's
mmproj projector had to be found and placed manually. All three are fixed.

### Fixed
- **Downloads now land in a per-model `<owner>/<repo>` folder**, mirroring Hugging Face's
  own layout, instead of flat in the model root.
- **A vision model's mmproj projector is now fetched automatically** alongside the GGUF,
  into the same folder — no more manually hunting it down and no more vision models that
  silently fail to see images because the projector was missing.
- **Split/multipart quants (e.g. `gpt-oss-120b-GGUF`) now download every shard**, not just
  the first, so they load as a single working model instead of an orphaned partial file.
- **Pasting a Hugging Face model page into "Import from URL"** now opens that repo's quant
  picker instead of a dead-end "not a .gguf" error — a repo has many quants, so picking one
  there gets the same folder/mmproj/shard handling as downloading through Discover.

### Discord
- Improved model downloads — models now save into proper folders like Hugging Face itself uses.
- Added support for multipart GGUF downloads (like gpt-oss-120b) — grabs every part now, not just the first.
- Vision models now auto-download their mmproj file too.

## [1.6.2] - 2026-07-01

**Live model discovery, Linux builds, and MCP marketplace fixes.**

### Added
- **Linux support for the 1-click build pipeline** — compile llama.cpp from source with CUDA
  on Linux (WSL2 included), not just Windows. Detects your compiler, bundles the CUDA runtime
  libraries next to the binary automatically. Verified end-to-end in WSL Ubuntu.
- **Discover now browses Hugging Face live** instead of a static "Featured" list — sortable by
  trending / downloads / likes / recently updated / newest, in a persistent list + detail
  layout (both panes are resizable) instead of a click-to-open panel.
- **Rendered model card READMEs** — headings, images, links, and layout now render properly
  instead of showing as raw markdown source, sanitized to stay safe against untrusted content.
- **Built-in web search (Tavily/Kagi/SearXNG) is now its own section** in Customize, separate
  from the MCP marketplace — selecting one configures just that provider instead of a shared
  3-way panel.

### Changed
- App-wide scrollbars are now consistently styled everywhere.
- The quant picker shows a green/yellow/red VRAM-fit indicator per option.

### Fixed
- **Connected MCP servers now show their real brand logo** in the Connected tab.
- **The LAN API-key prompt no longer gets wiped out by a flaky connection** — a network hiccup
  used to occasionally clear whatever key you were typing.
- **The recommended quant no longer defaults to the largest/unquantized file** when nothing
  fits your VRAM — it now picks the smallest viable one instead.

### Discord
- Discover now browses Hugging Face live with sorting (trending/downloads/likes/etc), not a fixed list — and model card READMEs actually render now (images, formatting, the works).
- 1-click engine builds work on Linux/WSL2 too, not just Windows.
- Fixed the LAN API-key box sometimes clearing itself while you were typing, plus a couple of MCP marketplace annoyances (Tavily/Kagi/SearXNG selection, missing logos).

## [1.6.1] - 2026-07-01

**Auto-tune no longer breaks vision models.**

A bug-fix release. Auto-tuning a vision-capable GGUF model used to leave it unable to
see images afterward (`500: image input is not supported`) — this is now fixed at the
root, and any model profile already broken by a past auto-tune run repairs itself
automatically, with no reset needed.

### Fixed
- **Auto-tune preserves vision (mmproj) after tuning** (#31, #32) — the offload/KV-cache
  sweep now runs with the vision projector resident exactly as configured, instead of
  excluding it and only restoring the setting afterward; the chosen offload now
  genuinely accounts for the projector's VRAM footprint. `useMmproj` is also now
  self-healing on every profile resolve — it has no UI control of its own, so any
  profile already stuck disabled by a prior auto-tune run recovers automatically.
- **Anthropic gateway no longer double-counts cached tokens** — `prompt_tokens` was
  reported as `input_tokens` AND its cached subset was reported again as
  `cache_read_input_tokens`, nearly doubling the context usage shown to clients on
  cache-heavy sessions (e.g. Claude Code).
- **Ctrl+C and other native shortcuts work again** — the nav-rail keyboard handler was
  swallowing any Ctrl/Cmd shortcut whose key wasn't a digit 1-9, killing native
  copy/paste.

### Discord
- Fixed a bug where auto-tuning a vision model (like a Gemma or Qwen-VL GGUF) could leave it unable to see images afterward. If that ever happened to you, it's now fixed automatically — just reload the model, no need to reset anything.
- Fixed copy/paste (Ctrl+C etc.) getting eaten in some spots.
- Fixed a token-count display bug that could show your context as much fuller than it actually was.

## [1.6.0] - 2026-06-29

**MCP marketplace — one-click tools in Customize.**

The Customize screen becomes a curated MCP marketplace. A **Cloud** tab lists hosted MCPs you connect with a single API key, a **Local** tab lists open-source stdio MCPs (spawned via `npx`/`uvx`) plus the three built-in web-search providers, and a **Connected** tab shows everything currently active. Every entry carries a brand logo and a one-click connect panel. The guiding rule: a service is only listed if it actually connects with a static key — OAuth-only services are deliberately excluded so nothing ever shows a fake "connected" state.

### Added
- **MCP marketplace** (ADR-124) in Customize — Cloud / Local / Connected tabs with brand logos (tree-shaken `simple-icons`) and one-click connect.
- **10 verified hosted (Cloud) MCPs**, each confirmed to connect with a static Bearer/API key against its official endpoint: GitHub, Linear, Stripe, Atlassian, Neon, Supabase, Cloudflare, Zapier, Apify, and **Mixpanel** (ADR-125). Mixpanel uses a service-account `Bearer Basic <base64>` token; the card tells you exactly what to paste.
- **19 open-source local MCPs** (filesystem, memory, git, postgres, sqlite, playwright, puppeteer, docker, kubernetes, and more) plus the three built-in web-search providers surfaced as in-marketplace cards.
- Hosted-MCP auth: a per-server API key is injected as `Authorization: Bearer …`; the key is **write-only** and never echoed back by the API.

### Changed
- Web-search provider configuration moved inline into the MCP section's built-in cards — one place to wire up tools.
- Connected MCP tools now refresh live after any add / edit / delete / toggle — no daemon restart needed.

### Fixed
- **Hosted MCPs now actually connect**: replaced the legacy SSE handshake with **Streamable HTTP** (MCP 2025-03-26) — the transport every modern hosted MCP (GitHub, Linear, Stripe, …) actually uses.
- **Local MCPs now spawn on Windows**: `npx`/`uvx` (`.cmd` wrappers) are launched through a shell, and catalog command strings are split into command + args correctly.
- **Memory MCP works with zero config**: `MEMORY_FILE_PATH` is auto-set to `~/.turbollm/mcp-memory.jsonl`, so the server no longer crashes trying to read a directory as a file.
- Excluded services that cannot connect with a static key (Notion, Figma, Sentry, Vercel, HubSpot, Amplitude, Slack — OAuth-only; Google Stitch — custom header + OAuth2-only; Motion — no confirmed endpoint) so the catalog never offers a connection that silently fails.
- Removed a Node `DEP0190` deprecation warning from MCP subprocess spawning.

### Discord
- **New: a one-click MCP marketplace.** Open **Customize** and connect tools like GitHub, Linear, Stripe, Notion-grade integrations, Mixpanel, and more — most take just an API key. There's also a Local tab for open-source tools (filesystem, git, Postgres, Playwright…) that run on your own machine.
- **It just works now** — hosted tools connect on the modern MCP transport, local tools launch correctly on Windows, and the Memory tool needs no setup. Connected tools show up in chat instantly, no restart.
- We only list tools that genuinely connect — if a service needs a browser login we don't yet support, it's left out rather than faking a connection.

## [1.5.4] - 2026-06-28

**Python engines + pixel-perfect artifact export.**

SGLang joins the engine catalog (Linux/WSL2, OpenAI-compatible, safetensors). Two real vLLM/SGLang bugs fixed: `ninja` no longer needs to be installed system-wide, and the `repetition_penalty` sampling key is now mapped correctly. Artifact PNG/JPEG export switched to headless Chrome (puppeteer-core) for a pixel-perfect result, plus a series of static-render fixes. `turbollm launch` auto-discovers the daemon port and no longer pins a model unless `--model` is passed.

### Added
- **SGLang engine** (ADR-120, Linux/WSL2 only). Faster vLLM-class inference — OpenAI-compatible, HuggingFace safetensors, Python ≥3.10, CUDA 12/13. Load settings: `context-length`, `mem-fraction-static`, `tp`, `served-model-name`, `api-key`, `disable-flashinfer`. Greyed on Windows with a "Linux/WSL2 only" explanation, matching vLLM's treatment.
- **GitHub Sponsors** badge added to README.

### Fixed
- **BUG-005** — vLLM and SGLang fail to start when `ninja` is not installed system-wide. FlashInfer JIT-compiles a CUDA kernel at startup and shells out to `ninja` via `PATH`; the venv ships `ninja` in `venv/bin` but it was never added to `PATH`. Fix: prepend the engine venv's `bin` / `Scripts` directory to PATH in `pyEngineEnv` — applies to vLLM, MLX, and SGLang.
- **BUG-006** — vLLM and SGLang reject `repeat_penalty` (llama.cpp name); both engines expect `repetition_penalty`. Sampling key mapping corrected for both engines.
- **Pixel-perfect artifact export** (puppeteer-core) — PNG/JPEG downloads now use headless Chrome instead of html2canvas. The exported image matches the on-screen render exactly. html2canvas is removed.
- **Artifact static rendering** — a series of fixes to the frozen-viewport live preview: captures at the correct desktop aspect ratio (16:10); eliminates the white band below the artifact and nav alignment regressions; vertically centers single-line button/pill text that html2canvas mis-placed.
- **`turbollm launch`** — auto-discovers the running daemon port (pidfile → config.json → shipped default); no longer pins `ANTHROPIC_MODEL` unless `--model` is passed, so Claude Code connects to whatever model the gateway currently has loaded instead of forcing an auto-swap.

### Discord
- **SGLang is now a supported engine** — a faster alternative to vLLM for Python-based inference on Linux/WSL2. Same one-click setup as vLLM.
- **Artifact exports are pixel-perfect** — switched to headless Chrome (puppeteer-core) for PNG/JPEG downloads. What you export now matches exactly what you see on screen.
- **vLLM and SGLang start reliably** — fixed a startup failure when `ninja` wasn't installed system-wide; TurboLLM now uses the one bundled inside the engine's own virtual environment.
- **`turbollm launch` is smarter** — auto-detects the daemon port and uses your currently loaded model by default, no flags needed.

## [1.5.3] - 2026-06-27

**Bug-fix — HF blob URL normalization on import.**

### Fixed
- **Import from URL now works with Hugging Face "blob" viewer links** ([#28](https://github.com/mohitsoni48/TurboLLM/pull/28)). HF file-viewer pages use `/blob/` in the path; pasting one would fail because HTTP clients receive the HTML page, not the binary. Both the dialog URL pre-processor and the backend download manager now rewrite `/blob/` → `/resolve/` automatically, so any URL copied directly from the HF file browser imports cleanly.

### Discord
- You can now paste any Hugging Face file page URL directly into **Import from URL** — no more errors when copying the link straight from the HF file browser.

## [1.5.2] - 2026-06-26

**Bug-fix + batch-size release — llama.cpp batch controls, artifact rendering overhaul,
import-URL fixes, and the deferred v1.5.0 review nits.**

### Added
- **llama.cpp `--batch-size` / `--ubatch-size` controls** (#26). Logical batch size and
  physical micro-batch size are now first-class load settings (shown alongside context and
  MoE options, not buried in Advanced), for tuning prefill throughput and load-time VRAM.
- **Import from URL accepts more Hugging Face link shapes** — `?show_file_info=<file>.gguf`
  page URLs and `hf://owner/repo/file.gguf` URIs are auto-converted to a direct download link.
- **Static ↔ Interactive artifact toggle.** HTML artifacts render a real, non-interactive
  browser preview by default (pixel-accurate, can't run scripts) and can be switched to a fully
  interactive view. Mermaid/SVG render a crisp rasterized image.

### Changed
- **Defaultable number inputs.** Fields that used a `0 = default` sentinel now show the real
  default as placeholder text with a one-click reset, instead of asking you to type `0`.
  Number-input spinner arrows are hidden globally.
- **Higher-resolution artifact exports** — PNG/JPEG now enforce a 2048px minimum on the
  shortest side.
- **Agent runner hygiene** (BUG-007): per-run buffers/emitters are freed on finish (fixes an
  unbounded daemon-lifetime memory leak); interrupt status no longer mislabeled as "cancelled";
  the artifact `fetch` is guarded to `data:` URLs; Mermaid `securityLevel` is set explicitly.

### Fixed
- **BUG-009: Import from URL no longer always errors** — the HF blob regex is tested against
  `origin + pathname` (so `?download=true` links work), with an inline "→ add a model folder"
  hint when no model folder is configured.
- **BUG-008: artifact PNG/JPEG exports fill the theme background** instead of exporting on a
  transparent (black-on-paste) canvas.
- **Mermaid/SVG artifact cards size consistently** (fit-to-height) instead of occasionally
  blowing out to full column width.
- **MLX venv recovery** (#18, external contributor) — re-installing recovers from a broken or
  incompatible MLX venv (uv 0.11+ `--clear`, pinned interpreter).

## [1.5.1] - 2026-06-25

**Bugfix / polish release — auto-tune run log, TurboLLM Expert persona improvements.**

### Added
- **Auto-tune run log.** A "Download run log" checkbox (checked by default) appears in the
  Save Results dialog after an auto-tune completes. Checking it downloads a structured JSON log
  of every probe — parameters, outcomes, VRAM readings, timestamps, hardware info, and the
  winning config.
- **TurboLLM Expert persona.** The Expert is now a first-class persona in the persona picker
  (alongside Default, Designer, Research, etc.) instead of a hidden launch from Settings. It
  carries a comprehensive built-in knowledge base covering every screen, load profile parameter,
  engine, auto-tune algorithm, gateway, built-in tools, and troubleshooting patterns, and is
  given your actual hardware (GPU, VRAM, RAM, OS) so it can suggest models that fit your machine.

### Changed
- Removed the "Launch TurboLLM Expert" section from Settings — use the persona picker instead.

### Fixed
- **Mermaid artifact image export.** Downloading a Mermaid diagram (e.g. a flowchart the model
  drew) as PNG or JPEG failed with "Couldn't export this artifact as an image." Mermaid rendered
  text labels as HTML `<foreignObject>`, which taints the export canvas in the browser. Labels are
  now rendered as native SVG text, so PNG/JPEG export works.

## [1.5.0] - 2026-06-25

**Feature release — background agents, inline artifacts, and a Designer persona.** Run agent
tasks in the background while you keep chatting, get HTML/SVG/Mermaid replies rendered as live
previews you can export as images, and a new persona that produces polished, self-contained
designs by default.

### Added
- **Background agents.** A new **Agents** screen launches long-running agent tasks that run in
  the daemon — independent of the chat tab. Each run has a live-streaming view, queues behind any
  active run, **reconnects** to in-progress output if you navigate away or reload, lets you pick
  per-run tool consent (web search / fetch URL / run code) at launch, and can be cancelled. Runs
  are persisted, so they survive a restart (in-flight runs are marked interrupted).
- **Inline artifacts.** Fenced ` ```html `, ` ```svg `, and ` ```mermaid ` blocks now render as
  **live, sandboxed previews** presented as an image, with one-click export to **PNG / JPEG / SVG /
  animated GIF / HTML**. The preview card fits to its content (capped at ~60% of the screen) with a
  fit-width / fit-height toggle. Everything renders **fully offline** — the sandbox blocks all
  network access.
- **Designer persona.** A senior front-end designer that turns a request into a beautiful,
  self-contained artifact you can preview — with strong built-in defaults for typography, color,
  layout, depth, and accessibility, and a hard offline constraint (no CDNs, all assets inline).

### Changed
- **Personas now guide artifact use.** The **Default** persona advertises diagram & preview
  capability, and every persona gets guidance to reach for `html` / `svg` / `mermaid` when a visual
  is genuinely useful — and to stay in prose otherwise (no over-rendering).
- **Artifacts read as results, not code.** They are shown purely as a rendered image — no language
  tag, no code/preview toggle — with downloads offered by output format.

## [1.4.2] - 2026-06-23

**Bugfix — vLLM (safetensors) models now load and chat correctly.** Three issues kept vLLM
models from working: chat failed outright, the model card mislabeled them as MLX, and the
context-length control was locked.

### Fixed
- **Chat on vLLM no longer fails with "Engine returned 400".** The chat path attached tool
  definitions (web search, run code, …) to every engine, but vLLM rejects a `tools` array
  unless it was launched with `--enable-auto-tool-choice` and a `--tool-call-parser`, so every
  vLLM chat turn 400'd. Tools are now sent only to engines that accept them (the llama.cpp
  family); vLLM chat works. Tool-calling on vLLM remains unsupported for now.
- **vLLM/safetensors models are classified correctly.** Compressed-tensors checkpoints were
  mislabeled as MLX `fp16`; the quantization is now read from `quantization_config` (e.g.
  `w4a16`), so the model card shows the real quant instead of "MLX".
- **The vLLM "Max model length" control is settable again.** Multimodal configs nest
  `max_position_embeddings` under `text_config`; the scanner now reads it, so a model's native
  context length is no longer reported as `0` (which had clamped the max-model-len input to 0).

## [1.4.1] - 2026-06-23

**Maintenance — brand-name consistency.** The GitHub repository was renamed `Turbo-LLM` →
`TurboLLM` so the name matches everywhere (product, npm package `turbollm`, and repo). No
runtime or behavior changes.

### Changed
- Repository renamed to `github.com/mohitsoni48/TurboLLM`; all in-repo links (package metadata,
  README badges/images, the in-app "Register your engine" issue link) updated to the new URL.
  Old links continue to redirect.

## [1.4.0] - 2026-06-23

**Hygiene release — the small gaps that made the tool feel unfinished: stop the daemon from the CLI, launch Claude Code without pre-loading a model, see gateway-loaded models as loaded, and import chats from ChatGPT/Claude JSON.**

### Added
- **`turbollm --stop`.** Gracefully stop a running daemon from any terminal (reads a pidfile
  at `~/.turbollm/daemon.pid`). Unix sends SIGTERM then escalates to SIGKILL; Windows uses
  `taskkill /T /F`. Before killing it confirms a TurboLLM daemon is actually answering on the
  recorded port, so a stale pidfile whose PID the OS reused is never mistaken for the daemon.
- **`turbollm launch claude --model <key|name>`.** Load a specific model, then launch Claude
  Code against it. Resolves by exact key, exact name, or partial/case-insensitive name.
- **`turbollm launch claude` auto-loads a model** when none is running — the last-used model
  if known, otherwise the first in your library — so you no longer have to load one first.
- **Import chats from OpenAI-format JSON.** The chat importer now also accepts a standard
  `[{role, content}]` array (or `{messages: [...]}`) exported from ChatGPT, Claude, LM Studio,
  etc., auto-detecting it alongside the existing `.turbollm-chat.json` format.

### Fixed
- **Models loaded by the gateway now show as loaded** on the Models page. With keep-N > 1 a
  model auto-swapped in by a client lived in a separate pool slot that the Models page didn't
  consult, so it appeared unloaded; the page now reflects the whole keep-N pool.

## [1.3.2] - 2026-06-22

**TurboQuant now installs on macOS end-to-end — the Gatekeeper quarantine block, the per-platform release scan, and the Metal first-run timeout are all fixed — plus a Linux build.**

### Added
- **CPU option on macOS.** The Apple-Silicon Metal binary also runs CPU-only, so it now appears
  as a separate CPU backend too — the engine recommender always has a CPU variant to fall back to.
- **TurboQuant on Linux.** Linux x64 (Vulkan) is now listed as installable in the engine catalog.

### Fixed
- **macOS Gatekeeper blocking engine binaries.** Downloaded engine binaries carry the
  `com.apple.quarantine` attribute, which Gatekeeper uses to block execution — so the engine
  probe timed out even after the right binary downloaded. TurboLLM now strips the quarantine
  attribute from every extracted engine on macOS (and on re-install). Thanks @manish026.
- **TurboQuant install/update failing on macOS** with `no_release_asset`. The resolver used
  GitHub's `/releases/latest`, but TurboQuant publishes one release per OS, so the latest tag was
  often Linux-only and Mac users got nothing. It now scans releases for the newest one carrying a
  binary for the current platform.
- **Metal engines timing out on first launch.** macOS Metal builds JIT-compile their shaders on
  first run (10–30 s), which overran the 10 s probe and failed the engine. The probe now allows
  60 s on macOS (15 s elsewhere).

### Changed
- Unified TurboQuant's install and update paths onto a single per-platform release resolver so
  they can't drift apart, and removed the now-dead duplicate code.

## [1.3.0] - 2026-06-22

**End-to-end engine builds — compile a CUDA llama.cpp (or any fork) from inside the app, downloading CUDA itself if you don't have it.**

### Added
- **1-click build from source (Windows + CUDA).** The build guide now compiles for you:
  clone → `cmake` configure → compile `llama-server` → bundle its CUDA runtime → auto-register
  + activate the result, with a live phase + streaming compiler log and a **success screen**
  when the engine is ready. No copy-pasting commands. The manual command path is kept as a
  fallback. Builds with **Ninja inside the MSVC dev environment** (driving `nvcc` directly), so
  a standalone / conda CUDA works where the Visual Studio generator can't.
- **Automatic CUDA download.** No CUDA Toolkit? Click **Download CUDA** — TurboLLM fetches
  NVIDIA's official build components (nvcc + cudart + cuBLAS + headers, ~0.5 GB) and assembles a
  toolkit for you, picking a version your GPU driver supports. No NVIDIA installer, no account.
- **Self-contained builds.** The built engine bundles the CUDA runtime DLLs next to its binary,
  so it runs even without a CUDA Toolkit on PATH (and is portable).
- **Build environment (PATH override).** If your CUDA Toolkit or compiler lives in a conda
  env or a custom location (so `nvcc` wasn't on the system PATH and showed as "not
  available"), add that folder under **Build environment** and hit **Re-check** — those
  dirs are prepended to PATH for both prerequisite detection and the actual build.
- **One-click rebuild.** The "newer source available" chip on source-built engines now
  recompiles at the latest commit in place, instead of just linking to the repo.

### Changed
- Compile-from-source is no longer guidance-only; the prerequisite checker and the build
  both honor the configured toolchain dirs.

## [1.2.1] - 2026-06-22

**Auto-tuning that knows the model, a roomier config panel, and a built-in update check.**
Bundles the work tracked internally as 1.1.0 + 1.2.0 + 1.2.1 into one release off 1.0.0.

### Added
- **Auto-tune reads the model card** — after a sweep, TurboLLM reads the model's Hugging Face
  card and prefills the profile's sampling (temperature / top_k / top_p / min_p) with the
  author's recommended values, shown in the results dialog and applied on Save. Hybrid
  extraction: a deterministic scan first, then the just-tuned model itself as a fallback for
  prose-only cards. No card / no recommendation → your sampling is left unchanged.
- **Base-model fallback for recommended sampling** — most local GGUFs are third-party requants
  whose card omits the recommendation, so TurboLLM resolves the original model (via HF
  `base_model`) and reads its card. Well-known models (Gemma, Qwen, GLM, …) now get their
  recommended sampling even from a bare requant repo. Gated bases (e.g. Gemma) need a
  configured HuggingFace token.
- **Complete tuned config as a table** in the auto-tune results dialog — runtime (GPU layers,
  MoE offload, context, KV cache, flash attention), the full sampling (values from the card
  tagged "from card"), and measured speed / VRAM / first-token latency.
- **App self-update check** — Settings → About shows the running version and, when a newer
  TurboLLM is published on npm, an "update available" chip with a copy-paste
  `npm i -g turbollm` command. Cached 24h; silent when offline; never auto-updates.

### Changed
- **Model config is now a resizable side panel** — load/tune settings open as a right-docked
  panel that resizes the page instead of overlaying it (drag the edge to resize; width is
  remembered), shared by the Models screen and the Chat header. On narrow screens it becomes
  a full-screen takeover.

### Fixed
- Card-sampling extraction now works on **reasoning models** (Gemma 4, Qwen3) — thinking is
  disabled for the extraction step, so they emit usable JSON instead of empty or truncated
  output.
- **Large model cards** (e.g. Qwen3.5, ~80–95k chars) — the recommended-settings block deep
  in the card is now within the extraction window; values inside usage code blocks are
  ignored so demo numbers aren't mistaken for recommendations.

## [1.0.0] - 2026-06-21

**The engine overhaul — TurboLLM 1.0.** Engines are now hardware-aware, self-updating, and
bring-your-own from any source, behind a redesigned, beginner-first Engines screen.

### Added
- **Hardware-aware recommendation** — detects your GPU + OS and labels each engine by fit
  ("Recommended for you"); engines that can't run here are greyed with the reason.
- **Unified, fit-labeled engine catalog** — llama.cpp, KoboldCpp, llamafile, MLX, vLLM, plus
  forks (ik_llama, TurboQuant) — install and manage from one place.
- **KoboldCpp** and **llamafile** as first-class engine kinds (GGUF, OpenAI-compatible),
  verified end-to-end.
- **Guided "Add your own engine"** — pick a folder; TurboLLM scans for the server binary,
  probes its version + capabilities, and pre-fills the name. Optional source-repo URL.
- **Build-from-source guide** (Windows + CUDA) — prerequisite checker (git / CMake / CUDA /
  MSVC) + the exact build commands, then a handoff to "Add your own engine".
- **Honest engine updates** — checks the real upstream release / commit (and PyPI for
  pip engines); per-engine **Off / Notify / Auto** policy (default Notify); rollback-safe
  apply; a **"Rebuild available"** chip for source builds.
- **"Register my engine"** — nominate a fork via a prefilled GitHub issue form.
- **HuggingFace cache as a default model folder** on first run — your existing HF models
  appear with zero configuration.
- Grouped engine selection — one engine dropdown; a version dropdown (with a "latest" badge)
  appears only when you have more than one build.

### Changed
- **Redesigned Engines screen** — three calm zones: a status hero (hardware + a "Running now"
  switcher) → the unified Install & manage catalog → a collapsed Advanced section (GPU build
  picker + backend management). Replaces the old two-level Engine→Build selector + help accordion.
- De-pinned official llama.cpp for updates — the pinned build is now the first-install default only.
- **Route-level code-splitting** — initial JS bundle ~1 MB → ~314 kB; screens load on demand.

### Fixed
- "You're on the latest" was misleading for official llama.cpp (it only checked the pinned build
  on disk) — it now checks the real upstream release.
- llamafile launch on current versions (`--no-webui`, replacing the removed `--nobrowser`).
- Cross-engine KV-cache-type bleed — a model tuned under TurboQuant (turbo2/3/4 KV) no longer
  crashes standard llama.cpp / llamafile; the KV type is gated to what the engine actually supports.

## [0.8.0] - 2026-06-19

### Added
- **Research v2** — pluggable web-search providers (Tavily / Kagi / SearXNG); a deterministic
  retrieval service with a confidence loop and a sources panel; and a heuristic referee that flags
  reply claims not supported by their cited sources.
- **Chat portability** — share a chat via a LAN link or a debug snapshot, and export/import chats
  as `.turbollm-chat.json` (imported chats are fully continuable).
- **Agentic tool security** — SSRF/RFC-1918 block on `fetch_url` and a confirmation gate on `run_code`.
- **vLLM load controls** — max model length, GPU memory utilization, max concurrent sequences,
  dtype, KV-cache dtype, enforce-eager, trust-remote-code.
- **Engine lifecycle** — 3-state engine rows (Install / Update / Disable / Enable / Delete) for both
  the catalog engines (vLLM / MLX / TurboQuant) and the llama.cpp backends.
- **"All" models view** — list models unfiltered by the active engine, with compatibility badges.
- **Auto-tune** — live prefill-% progress and a Save / Cancel results dialog.

### Changed
- **Auto-tune** rewritten — binary search over GPU offload, a realistic bench prompt
  (`min(50k, 0.75 × ctx)`), a 3-minute-per-test cap, GPU settle between candidates, and a
  spill-aware peak confirmation (a config that spills VRAM to system memory is PCIe-bottlenecked,
  so throughput peaks at the no-spill edge).
- Stop / restart / load now act as **kill switches** — they cancel a running auto-tune and abort
  in-flight chat generations.
- The model load dialog is driven by the active engine kind (vLLM shows its real controls, not MLX
  copy); slim custom scrollbar; real GPU-layer count instead of "99".
- `turbollm launch claude` raises the request timeout so slow local models don't trigger retries.

### Fixed
- Claude Code context meter and cache-hit now show real numbers (gateway maps engine token usage to
  the Anthropic usage block).
- Qwen tool-loop empty reply after web searches (forced final answer pass).
- vLLM now fails fast with a clear message where it can't run (e.g. Windows), instead of a raw crash.
- ComfyUI reverse-gate log noise when ComfyUI is configured but not running.
- A stale engine error now resets when you switch the active engine.

## [0.7.2] - 2026-06-19

### Fixed
- **Engine load lock** — a static `Manager.loadGate` gate (shared across every Manager
  instance, including the gateway keep-N pool) ensures at most one model load/reload is ever
  in flight at a time. New `load()` method is the single entry point: stops the current engine,
  runs the ComfyUI reverse gate, spawns, and awaits readiness — all as one atomic operation.
  Eliminates the double-VRAM-allocation race when gateway auto-swap and a concurrent HTTP load
  fire simultaneously.
- **Orphan-engine reaping** — each engine records a pidfile (`run/engine-{pid}.pid`) carrying
  its port and owner-daemon pid. On startup, `reapStaleEngines()` kills any engine whose port
  is still live but whose owner daemon is gone (terminal closed, killed, crashed). A sync
  `killTrackedEnginesSync()` on process `exit` covers exits that bypass signal handlers.
  Owner-aware: a restarting daemon never reaps engines owned by the incoming process.
- **Client-cancel propagation** — the gateway wires an `AbortController` into every upstream
  engine fetch (`/v1/messages` and the OpenAI passthrough). `stream.onAbort` fires `ac.abort()`
  so a cancelled Claude turn actually stops the engine generating instead of running to
  completion and clogging its queue slot. `streamToAnthropic` uses `reader.cancel()` (not
  `releaseLock()`) so the upstream body tears down on client disconnect.
- **Daemon crash on client disconnect** — guarded the final `writeSSE('done')` in chat routes
  with a try/catch; added an `unhandledRejection` handler in the CLI that swallows expected
  `AbortError`s. A disconnecting client can no longer crash the daemon and orphan the engine.
- **`SIGHUP` handled** — added to the graceful-shutdown signal set so daemon manager restarts
  don't leave engines running.
- **ModelRouter `waitReady` eliminated** — readiness is now awaited inside `Manager.load()`
  under the load lock; `ModelRouter` just reads `status().state` after `load()` resolves.

## [0.7.1] - 2026-06-18

### Fixed
- **MLX incomplete shard detection** — scanner reads `model.safetensors.index.json` and verifies
  every listed shard exists on disk; partial downloads now surface as `incomplete: true` (blocks
  load) instead of letting mlx-lm crash with `ValueError: Missing N parameters`.
- **GPT-OSS channel streaming** — 4-phase state machine (`initial → reasoning → skipFinal →
  content`) correctly routes `<|channel|>analysis<|message|>…<|end|>` to reasoning events and
  the final answer to delta events; fixes channel framing tokens leaking into chat when whitespace
  separates `<|end|>` from `<|start|>assistant…`.
- **`delta.reasoning` field** — mlx-lm's reasoning field (`delta.reasoning`) now handled
  alongside llama-server's `delta.reasoning_content`.
- **Re-download button for incomplete models** — `inferRepoFromPath` now accepts MLX directory
  paths (2 segments) so the HF repo dialog opens correctly instead of always falling back to
  name-search.

## [0.7.0] - 2026-06-18

### Added
- **Agentic tool loop** — native `finish_reason: tool_calls` detection with up to 10 iterations;
  streams live tool-call cards (pending → done/error) in the chat UI as tools execute.
- **Built-in tools** — `web_search` (Tavily REST API, `search_depth: advanced`), `fetch_url`
  (HTML-stripped page text), and `run_code` (sandboxed Node.js `vm` — no network/file access).
- **MCP host client** — connect any MCP server via stdio subprocess or SSE HTTP transport;
  tools from all connected servers appear automatically in the tool list.
- **Customize screen** — new `/customize` nav item (Puzzle icon) for Tavily API key management
  and MCP server add/edit/delete. Settings is now focused on engine/model/network/startup/persona.
- **Research persona** — always fires `web_search` before composing a reply; `tool_choice` is
  forced at the protocol level for the first two iterations, guaranteeing at least two distinct
  searches; system prompt mandates a 3–5 query strategy with source citation.
- **Current-date injection** — today's date is baked into every new conversation's system prompt
  so temporal queries use the correct year without extra user instruction.
- **DB migration v5+v6** — `tool_calls` column on messages (persists tool invocation history);
  `tool_policy` column on conversations (drives per-conversation tool-choice enforcement).

### Changed
- Settings screen no longer contains Tools or MCP sections — both moved to the new Customize screen.
- Persona count increased to 8 (added Research); persona descriptions updated.

## [0.3.0] - 2026-06-17

### Added
- **Configurable multi-GPU, per model** — new GPU controls on each model's load profile,
  shown (only when more than one GPU is detected) in the model's Load settings:
  - **llama.cpp / TurboQuant:** split mode (`layer` / `row` / `none`), an optional custom
    per-GPU split, and a main-GPU pick — mapped to `--split-mode` / `--tensor-split` /
    `--main-gpu`.
  - **vLLM:** a tensor-parallel size that shards the model across N GPUs
    (`--tensor-parallel-size`).

  Defaults are no-ops, so single-GPU machines and existing profiles are unchanged. The VRAM
  estimate now budgets across the GPUs the chosen split actually uses (previously it only
  counted the first GPU).
- **Reverse ComfyUI GPU gate** — the symmetric direction of the 0.2.0 GPU coordination:
  when you run a prompt in TurboLLM, it first asks ComfyUI to free its VRAM, then loads, so
  whichever app you're actively driving wins the GPU automatically — in both directions. An
  in-flight render is never interrupted. Enable in Settings → ComfyUI.

### Changed
- **Live prefill % is now co-located with the session stats on the engine card**, at a
  larger size and higher contrast, so the headline live-progress signal is legible at a
  glance while a prompt runs.

## [0.2.0] - 2026-06-15

### Added
- **Share the GPU with ComfyUI** — push-based GPU coordination. A one-time-installed
  ComfyUI custom node signals TurboLLM the instant a render starts/ends; TurboLLM unloads
  its model and blocks new loads while ComfyUI renders, then reloads the exact model when
  the queue drains. Installed from Settings → ComfyUI (no polling; deterministic handoff).
- **vLLM** and **MLX** engine backends alongside llama.cpp, with one-click install/switch
  and an engine catalog. Model content hashing for provenance/dedup.
- **Live prefill % + generated-token count on the engine card for gateway traffic** —
  Claude Code (and any external API client) now shows the same live prompt-processing %
  and running token count as in-app chat, instead of a quiet card mid-request.
- **Global max response-token limit** — a "Max response tokens" setting (0 = unlimited)
  that caps generation for in-app chat and clamps external (Claude Code) requests too,
  so nothing on the machine can exceed it.

### Fixed
- Chat now accepts an **image- or file-only message with no typed text** (the server no
  longer rejects attachments that arrive without `content`).

---

## [0.1.1]

Published to npm. (Baseline before this changelog was started; see git history.)

## [0.1.0] - tagged `v0.1.0`

Initial tagged release. (See git history for details.)
