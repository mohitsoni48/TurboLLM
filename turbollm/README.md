<p align="center">
  <img src="https://raw.githubusercontent.com/mohitsoni48/TurboLLM/main/turbollm/web/public/brand/turbollm-icon-512.jpeg?v=2" width="92" height="92" alt="TurboLLM" />
</p>

<h1 align="center">TurboLLM</h1>

<p align="center">
  <strong>Run <em>any</em> local LLM engine, auto-tuned to your GPU — with a polished web UI
  and an OpenAI/Anthropic-compatible API.</strong><br/>
  Bring your own llama.cpp fork. No compiling. No Electron. No Python. Point Claude Code at
  your own machine in one command — fully offline.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/turbollm"><img src="https://img.shields.io/npm/v/turbollm.svg?color=e2552e" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/turbollm"><img src="https://img.shields.io/npm/dm/turbollm.svg?color=e2552e" alt="npm downloads" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522-3c873a.svg" alt="node >= 22" />
  <img src="https://img.shields.io/badge/license-FSL--1.1--ALv2-blue.svg" alt="license" />
  <img src="https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-555.svg" alt="platforms" />
  <a href="https://ko-fi.com/mohitsoni"><img src="https://img.shields.io/badge/Ko--fi-support%20us-FF5E5B?logo=kofi&logoColor=white" alt="Ko-fi" /></a>
  <a href="https://github.com/sponsors/mohitsoni48"><img src="https://img.shields.io/badge/GitHub%20Sponsors-support%20us-EA4AAA?logo=githubsponsors&logoColor=white" alt="GitHub Sponsors" /></a>
  <a href="https://discord.gg/v6kRbV7nC"><img src="https://img.shields.io/badge/Discord-join%20chat-5865F2?logo=discord&logoColor=white" alt="Discord" /></a>
</p>

<!-- Brand: shipped app icon web/public/brand/turbollm-icon-512.jpeg · high-res masters web/brand-assets/ (unshipped) · in-app mark web/src/components/Logo.tsx · favicon web/public/favicon.svg -->

```bash
npx turbollm
```

That one command starts a local daemon, opens a browser UI, and serves your models over an
API any tool can talk to. TurboLLM is the **performance & bleeding-edge layer for local
LLMs** — built for people who today hand-compile forks and hunt forums for the right flags.

<p align="center">
  <img src="https://raw.githubusercontent.com/mohitsoni48/TurboLLM/main/assets/how-it-works.svg?v=2" width="860" alt="How TurboLLM works: clients -> one lightweight daemon -> any engine on your GPU" />
</p>

---

## Contents

- [Why TurboLLM](#why-turbollm)
- [Speed: TurboLLM vs LM Studio](#speed-turbollm-vs-lm-studio)
- [Features](#features)
- [Quick start](#quick-start)
- [⭐ Bring any engine — the headline feature](#-bring-any-engine--the-headline-feature)
- [Run Claude Code on your own GPU](#run-claude-code-on-your-own-gpu)
- [Use it from any device on your network](#use-it-from-any-device-on-your-network)
- [Command-line reference](#command-line-reference)
- [Configuration & data](#configuration--data)
- [Requirements](#requirements)
- [Privacy](#privacy)
- [How TurboLLM compares](#how-turbollm-compares)
- [Troubleshooting](#troubleshooting)
- [Develop from source](#develop-from-source)
- [Community](#community)
- [License](#license)

---

## Why TurboLLM

Local-LLM tools make two choices for you, and both cost you performance:

1. **They pick the engine.** LM Studio ships one blessed runtime; Ollama hides the engine
   entirely. The fastest community innovations — new quant formats, speculative decoding,
   low-bit KV cache — land in **forks** first, and you can't use them without compiling.
2. **They don't tell you what speed to expect**, and they don't tune the dozens of launch
   flags (`-c`, `-ngl`, `--n-cpu-moe`, KV type, threads, flash-attn, draft models) that make
   the difference between 20 and 80 tokens/sec on the *same* hardware.

TurboLLM does the opposite:

- **🔌 Any engine, including forks.** Point it at any `llama-server`-compatible binary — a
  build you compiled, a community fork, or the one it auto-provisions for your GPU. It probes
  the binary's real capabilities and adapts the UI to them. **This is the whole point.**
- **⚡ Auto-tuned to your hardware.** It benchmarks on load, derives fast defaults, and shows
  a **VRAM-fit verdict before you load** — no more flag guessing.
- **📊 Real tokens/sec, never faked.** Speed in the model list is *measured on your machine*
  from actual generation — live while you chat, and remembered per model.
- **🪶 Lightweight.** A ~7 MB npm package on Node — **no Electron, no bundled Chromium, no
  Python**. It downloads only the engine your GPU actually needs (Vulkan ≈ 38 MB).
- **🔌 Drop-in APIs.** OpenAI **and** Anthropic-compatible — so Claude Code and every existing
  tool work unchanged.
- **🔀 A gateway that loads models for you.** Name any model in your API request and TurboLLM
  loads it on demand, keeping your favorites hot in a small pool — so an agent that hops between
  models just works, with nothing to pre-wire.
- **🔒 Offline-first & private.** No account, no backend, no internet, **no telemetry.**

---

## Speed: TurboLLM vs LM Studio

Same GPU (RTX 5070 Ti 16 GB), same model, same 200K context — measured generation speed.
**TurboLLM is faster than LM Studio on the very same official llama.cpp, and faster still when you
run a community fork LM Studio can't.**

**① On official llama.cpp, TurboLLM is faster.** It auto-provisions a GPU-native engine build (CUDA
13 for Blackwell here) and tunes expert-offload to the layer, so at the *same* KV-cache quant it
beats LM Studio's bundled runtime:

| Qwen3.6-35B-A3B · 200K | TurboLLM | LM Studio | Speed-up |
|---|:---:|:---:|:---:|
| official llama.cpp — `q4_0` | **74.7 t/s** | 61.0 t/s | **1.2×** |
| official llama.cpp — `q8_0` | **72.3 t/s** | ~66 t/s\* | **1.1×** |

**② Run a faster engine and pull far ahead.** Because TurboLLM runs *any* engine, you can drop in
the **TurboQuant** fork — a llama.cpp fork with a low-bit `turbo4` KV cache that LM Studio simply
can't load — in one click. On a large-KV model it delivers `q8_0`-level quality at **more than
double the speed**:

| Qwen3.6-27B · 200K · matched quality | TurboLLM&nbsp;+&nbsp;TurboQuant | LM Studio | Speed-up |
|---|:---:|:---:|:---:|
| `turbo4` vs `q8_0` | **24.6 t/s** | 11.4 t/s | **2.2×** |

Same run, **1.7× faster prefill** too (1288 vs 757 tok/s).

<sub>\*LM Studio's `q8_0` mildly spilled VRAM at its best offload. A low-bit KV cache helps most
when the cache is large; TurboLLM's auto-tuner and on-screen measured t/s pick the fastest engine +
config for each model, so you don't have to.</sub>

---

## Features

The headline — **[running any engine, including community forks](#-bring-any-engine--the-headline-feature)** —
has its own section below. Everything else is grouped here; each summary is the gist, expand for
the detail:

<details>
<summary><strong>📦 Models — bring your own, or browse Hugging Face</strong></summary>

<br/>

- **Use the folders you already have.** Point TurboLLM at any directory of GGUFs — your
  existing LM Studio / Ollama / manual downloads — **no re-downloading.** It parses GGUF
  metadata (arch, params, quant, context, vision) for every file.
- **Browse & download from Hugging Face**, in-app: a live, sortable list (trending / downloads
  / likes / recently updated / newest) alongside a permanent detail pane — pick a quant, read
  the **rendered model card**, and download with **resume + SHA-256 verification**. Each model
  lands in its own folder (mirroring Hugging Face's own layout) with its **vision projector and
  every shard of a split/multipart quant fetched alongside it automatically**. Gated models
  (Llama, Gemma) work via your own HF token, which **never leaves your machine**.
- **Import from any URL** — not just Hugging Face. Paste a direct `.gguf` link (model-author
  sites, mirrors, private servers) and it disk-space-checks and downloads through the same
  manager; paste a Hugging Face **model page** link instead and it opens that repo's quant
  picker so you can choose which one to download.
- **Quant recommendation per GPU** and a **VRAM-fit verdict** so you pick a quant that
  actually fits before you commit.
- **Primary download folder**, real-time **measured t/s per model**, **delete-from-disk**, and
  **pin your favourites to the top of the list**.

</details>

<details>
<summary><strong>⚡ Auto-tuning &amp; performance</strong></summary>

<br/>

- **Auto-benchmark on load** derives fast defaults for your exact GPU.
- **Recommended sampling from Hugging Face** — auto-tune checks a repo's structured params /
  `generation_config.json` sidecar first when the quantizer publishes one (exact values, no
  guessing), then falls back to reading the model's card (and the original model behind a
  requant) and prefills the author's recommended `temperature / top_k / top_p / min_p`. No
  recommendation → your sampling is left untouched.
- **Real measured tokens/sec** in the model list — **live** while generating, **last-session**
  when idle (never a synthetic estimate).
- **Full load-parameter UI**, a superset of what other tools expose: context length, GPU offload
  (`-ngl`), **MoE CPU-offload (`--n-cpu-moe`)**, parallel slots, **KV-cache quant type** (incl.
  low-bit on supporting forks), CPU threads, flash attention, and **speculative decoding (NextN /
  MTP / draft, with a configurable draft min/max window)**.
- **Auto-fit GPU layers / MoE offload** — an optional toggle (off by default) that hands the
  GPU/CPU split decision to llama.cpp's own memory-fitting logic at load time instead of a fixed
  number, honored by Auto-tune too. Useful when a large context or model doesn't fit your usual
  fixed setting.
- **Fast by default:** flash attention on, NextN self-speculative decoding on for models that
  carry a draft head, threads auto — safely gated to what your engine actually accepts.
- **Multi-GPU, per model** — split a model across cards (layer/row split + main-GPU pick on
  llama.cpp, tensor-parallel on vLLM). Defaults are no-ops, so single-GPU rigs are untouched.
- **Saved per-model profiles, per engine** — tune once per (model, engine) pair, so
  switching engines (or between two installs of the same engine, e.g. a fork) never
  overwrites another engine's tuning for the same model.
- **Configurable VRAM headroom** (Settings → Models & loading → Advanced, 300 MB–2 GB, default
  1 GB) — tell auto-tune how much VRAM to keep free for other GPU workloads instead of a fixed margin.

</details>

<details>
<summary><strong>💬 Chat &amp; agentic tools — a genuinely good UI, not an afterthought</strong></summary>

<br/>

- **Streaming** with a **stop** button, **live tokens/sec**, **prompt-processing %** and
  **prefill t/s**, **time-to-first-token**, **total time**, exact **token counts**, and a
  **context-usage meter** (filled / max) on every reply.
- **Thinking control** — toggle reasoning **off** for a direct answer, or leave it **on** with
  collapsible, timed "thought for N s" blocks.
- **Markdown + syntax-highlighted code** with one-click copy — plus **inline Unicode charts**
  the model draws when a comparison, trend, or hierarchy is genuinely worth a visual.
- **Live artifacts** — `html`, `svg`, and `mermaid` replies render as **sandboxed, offline
  previews** shown as an image, with one-click export to **PNG / JPEG / SVG / animated GIF / HTML**.
- **Agents** — pick a style (Default · **Designer** · Concise · Detailed · Blunt · Formal · Tutor ·
  Creative · Research · **Lite** · **Code**) per conversation, no prompt-wrangling required. The
  **Designer** persona produces polished, self-contained, previewable designs by default; **Lite**
  strips the hidden prompt to the bare minimum for the fastest responses. See below for editing
  built-ins or creating your own.
- **Edit or regenerate any message without losing history** — both branch instead of
  overwriting, with a **‹ 1/2 › switcher** to flip between versions (including nested branch
  points); delete and copy still work as before. **Persistent, searchable conversations** with
  rename, delete, and **auto-generated titles**, organized into **drag-resizable, collapsible
  folders** you create/rename/move conversations into.
- **Switching chats never cancels a reply** — an in-flight generation keeps running in the
  background and saves normally; the sidebar shows a live indicator on any chat still generating,
  and a dot on one that finished while you were elsewhere.
- **Preserve thinking across turns** (on by default) — the model's past reasoning is resent on
  later turns, not just its final answers, so follow-ups have real context to work with.
- **Per-chat system prompt** and **per-chat sampling** overrides — temperature, top-p/k, min-p,
  repeat/presence/frequency penalties, and **stop strings** — prefilled from the loaded model's
  own recommended values, available even before you send the first message.
- **Image input** for vision models, **PDF and code/text attachments** (real extracted text,
  not raw bytes), and **TurboLLM Expert** — a built-in assistant that knows the app and your
  hardware for onboarding and troubleshooting without leaving the UI.
- **Agentic tools** — built-in `web_search` (Tavily), `fetch_url`, and sandboxed `run_code`, plus
  an **MCP marketplace** in Customize: one-click connect for hosted MCPs (GitHub, Linear, Stripe,
  Atlassian, Neon, Supabase, Cloudflare, Zapier, Apify, Mixpanel) and open-source local MCPs
  (filesystem, git, postgres, playwright, …), plus your own custom servers. Connected tools appear
  in every chat with no restart. A **Research** persona forces multi-step web search and cites sources inline.
- **Tool-call approval gate** — every tool call asks for your approval by default before it runs,
  with **Deny**, **Allow**, **Allow for this chat**, or **Always Allow** on an inline bar above the
  composer. Set per-tool defaults globally from Settings → Tools & safety.
- **Usage dashboard** — a GitHub-style activity heatmap of your local generation history (adaptive
  1h/12h/24h boxes for the 7-day/30-day/all-time views), streaks, peak hour, a per-model
  breakdown, and a lifetime token-milestone tracker.
- **Auto-memory** *(experimental, off by default)* — silently extracts durable facts you mention
  in chat (name, preferences, hardware) using your own loaded model, and carries them into future
  new conversations. Nothing leaves your device; the full fact list is reviewable and deletable
  from Settings → Memory, and turning the toggle off stops new chats from seeing it immediately.
- **Thinking-budget control** — a graduated slider, not just on/off: cap reasoning to a specific
  token count, disable it entirely, or leave it unlimited. Works in Chat and Code alike.

</details>

<details>
<summary><strong>🧑‍💻 Code — a local coding agent, in a real project directory</strong></summary>
<em>(experimental, off by default — Settings → Experimental)</em>

<br/>

Workspace → Code hands a task to an agent running on the same model you already have loaded —
point it at a repo folder, describe what you want, and it reads, edits, and runs commands to get
there. Entirely local; nothing leaves your machine.

- **Real repo access** — plans and edits end-to-end (or asks before mutating, or plan-only,
  depending on mode), with an optional isolated git worktree so your actual checkout stays
  untouched, and a real diff summary of what changed.
- **Persistent sessions** — archive/filter past runs, revert to any earlier message (with
  optional real file-edit reversal), attach files as context, and a "Coding activity" dashboard
  (sessions, tasks shipped, files touched, diff shipped, streaks) built from real history, not
  mock data.
- **Real LSP integration** for TypeScript/JavaScript and Python — detects the language, installs
  the language server if needed, and uses it for edits.
- **The same tools Chat gets from Customize** — any connected MCP server, plus the sandboxed
  `run_code` tool — are available to Code too, alongside honest skill invocation and
  `AGENTS.md`/`agents.md` support.
- **Independent access control** — gated behind its own API key on non-host devices, separate
  from Chat's gate, and hidden entirely until you opt in from Settings → Experimental.

</details>

<details>
<summary><strong>🤖 Customize → Agents — edit any built-in, or build your own</strong></summary>

<br/>

- **Edit any built-in agent in place** — system prompt, which shared skills it uses, and which
  tools it may call — with a one-click **Reset** back to the original.
- **Create your own agent** from scratch: a name, description, and system prompt, plus a
  checklist of which shared skills and which tools it's allowed to use (everything on by
  default). Pick it from the same in-chat agent picker as the built-ins.
- **MCP tools grouped by server** in the tool checklist — one toggle selects or deselects an
  entire server's tools at once, or expand it to pick individually.

</details>

<details>
<summary><strong>🔌 APIs &amp; integrations — OpenAI + Anthropic, plus a model-loading gateway</strong></summary>

<br/>

With a model loaded, TurboLLM serves two compatible APIs on the same port:

```bash
# OpenAI-compatible
curl http://127.0.0.1:6996/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"local","messages":[{"role":"user","content":"hello"}]}'
```

- **OpenAI-compatible** `/v1/chat/completions`, `/v1/embeddings`, … — point any OpenAI client
  or tool at it. Embedding models are auto-detected and pooled separately, so a RAG pipeline and
  a chat model can stay loaded side by side.
- **Anthropic-compatible** `/v1/messages` — including **tool use and streaming** — which powers
  Claude Code below. No other local host offers this.
- **Structured output** — constrain any response to a **GBNF grammar** (or JSON shape).
- **API-key auth** you can require when sharing over a LAN (Settings → Network & sharing).

**The gateway loads models for you.** Most local hosts make you load a model first, then call it.
TurboLLM's gateway reads the `model` field of any incoming request, **fuzzy-matches it to your
library, and loads it on the fly** if it isn't already running — then keeps up to **four models
hot** in an LRU pool so the next switch is instant. An agent (or Claude Code) that hops between a
coding model, a vision model, and an embedder just names each one and it works — no pre-wiring.

**One command wires up more than just Claude Code.** `turbollm launch <cli>` also supports
`opencode`, `kilo`, `openclaw`, and `hermes` — each gets pointed at TurboLLM the way that tool
expects (config file merge, or its own CLI command) instead of a manual copy-paste setup. Inside
Claude Code, `/model` lists your local models directly (with **Auto Model Swap** on in Settings →
Models & loading) so you can switch mid-session instead of only at launch.

</details>

<details>
<summary><strong>🎨 Share the GPU with ComfyUI</strong></summary>

<br/>

If you run **ComfyUI** on the same GPU, an LLM holding VRAM while ComfyUI renders means both
fight for memory (and one usually OOMs). TurboLLM can hand the GPU over automatically:

- The instant ComfyUI starts a render, TurboLLM **unloads its model and pauses new loads**.
- When ComfyUI's queue drains, TurboLLM **reloads the exact model it unloaded**.

It's **push-based, not polling** — ComfyUI signals TurboLLM the moment a job starts/ends, so the
handoff is immediate and deterministic (the model is gone *before* ComfyUI executes).

**One-time setup** (Settings → Network & sharing → ComfyUI): turn on **Pause for ComfyUI**, enter your ComfyUI folder
(the one containing `custom_nodes`), click **Install gate** (it writes a small custom node wired to
this daemon), then **restart ComfyUI** once. The panel shows a live indicator (rendering / idle /
connected); **Remove** undoes it.

</details>

<details>
<summary><strong>🪶 Platform — tiny, offline, private</strong></summary>

<br/>

- A **~7 MB npm package** on Node — no Electron, no bundled Chromium, no Python.
- **Offline-first** — no account, no backend, no internet, no telemetry.
- **Windows · macOS · Linux**, with a CPU fallback when there's no GPU.

</details>

---

## Quick start

```bash
# run without installing (recommended for first try)
npx turbollm

# or install globally
npm install -g turbollm
turbollm
```

**On first run** the daemon:

1. Detects your GPU and **downloads a matching `llama-server` build** (CUDA for NVIDIA, ROCm
   for AMD, Metal for Apple, SYCL for Intel, Vulkan otherwise — with a CPU fallback).
2. Starts on <http://127.0.0.1:6996> and opens your browser.
3. Drops you on the **Chat** screen, ready to load a model.

Then open **Models**, download or pick a GGUF, click **Load**, and start chatting. Stop the
daemon any time with **Ctrl+C**.

---

## ⭐ Bring any engine — the headline feature

No other local-LLM app lets you run **whatever inference engine you want**. TurboLLM treats
the engine as a swappable component.

**Add a custom engine** (Engines screen → **Add your own engine**):

1. Compile or download any `llama-server`-compatible binary — stock
   [llama.cpp](https://github.com/ggml-org/llama.cpp), a community fork, or your own build.
2. Point TurboLLM at the **folder** — it scans for the `llama-server` binary, runs a
   **capability probe**, and learns exactly which flags and features that build supports.
   *(Optional: paste the source repo URL so TurboLLM flags when a newer build ships.)*
3. Activate it. The load-parameter UI **adapts to that engine** — features the build doesn't
   support are hidden; ones it adds (e.g. low-bit KV cache, NextN) light up.

No prebuilt for your OS? The **build-from-source guide** checks your toolchain (git / CMake /
CUDA / a compiler — MSVC on Windows, gcc/clang on Linux), hands you the exact build commands
(or a 1-click **"Build it for me"** on Windows and Linux), then drops you into the folder scan
above.

**Or skip the manual clone entirely** — Engines screen → **Add via git repo**: paste any
llama.cpp-compatible fork's git URL (+ optional branch, defaults to the repo's own default) and
build it in-app with the same 1-click flow, no separate "point at a folder" step needed.

**Auto-provisioned default.** Don't want to fetch anything? On first run TurboLLM downloads
the right upstream prebuilt for your GPU automatically — and a **backend picker** lets you
switch between CUDA / ROCm / Metal / SYCL / Vulkan / CPU at any time (it downloads the variant
you choose, LM Studio-style).

**Engine types.** **llama.cpp / GGUF**, **KoboldCpp** and **llamafile** (GGUF, every OS),
**MLX** (macOS), and **vLLM** (Linux + NVIDIA) are all first-class engine kinds — install from
the curated catalog, pick the right one per model, and switch from a single dropdown.

**Fully supervised.** Every engine runs under a real state machine: health-gated readiness,
graceful stop, an **idle auto-stop** watchdog, and **live logs + clear error surfacing** in
the UI when something fails to load.

> Why it matters: fork-exclusive features — **speculative decoding (NextN / MTP / draft)**,
> low-bit KV cache, new quant formats — are usable on day 0, with **zero compiler knowledge**
> on your part beyond producing the binary (and often not even that).

---

## Run Claude Code on your own GPU

TurboLLM's Anthropic-compatible endpoint means [Claude
Code](https://www.npmjs.com/package/@anthropic-ai/claude-code) can run against whatever model
you've loaded — no cloud key, fully offline. One command wires it up:

```bash
turbollm launch claude               # auto-loads a model if none is running, then opens Claude Code
turbollm launch claude --model qwen3-8b   # load a specific model first, then launch
```

It sets Claude Code's `ANTHROPIC_BASE_URL` and pins `ANTHROPIC_MODEL` to whatever model is
loaded (so the status line, `/status`, and context-window sizing all reflect the real model),
then execs `claude`; extra args are forwarded. If no model is loaded it auto-loads your
last-used one (or the first in your library); `--model` picks a specific one by key or name.
If `claude` isn't installed, it tells you how.

Other coding CLIs work too — `turbollm launch opencode`, `turbollm launch kilo`, and
`turbollm launch openclaw` write a `turbollm` provider into that tool's own config file
(preserving anything you already configured) and then launch it. If an existing config can't
be parsed, TurboLLM refuses to overwrite it and prints how to add the provider by hand.
`turbollm launch hermes` does the equivalent for [Hermes Agent](https://github.com/NousResearch/hermes-agent)
via its own `hermes config set` command (its config is YAML, so we drive its CLI instead of
hand-editing that file). The in-app **Developer** screen also shows copy-paste snippets for
any OpenAI- or Anthropic-compatible tool (Open WebUI, Kilo Code, opencode, …).

---

## Use it from any device on your network

The UI runs in the browser, so any phone, tablet, or laptop on your LAN can use the model on
your GPU box — every screen is responsive down to phone widths, with the desktop layout
untouched:

```bash
turbollm --addr 0.0.0.0:6996    # bind all interfaces, then open http://<your-ip>:6996
```

Turn on **Require API key** in Settings → Network & sharing when you expose it.

---

## Command-line reference

```bash
turbollm                        # start on :6996, open browser
turbollm --port 9000            # listen on a specific port
turbollm --no-open              # start without opening a browser
turbollm --addr 0.0.0.0:6996    # bind all interfaces (LAN sharing)
turbollm --stop                 # stop a running daemon (any terminal)
turbollm launch claude          # start Claude Code (auto-loads a model if none is running)
turbollm launch claude --model qwen3-8b   # load a specific model, then launch
turbollm launch opencode        # wire opencode (or kilo / openclaw) to TurboLLM, then launch
```

| Flag | Description |
|------|-------------|
| `--port <n>` | Listen on a specific port (default: `6996`) |
| `--addr <host:port>` | Full host:port override, e.g. `0.0.0.0:6996` for LAN sharing |
| `--no-open` | Start without opening a browser window |
| `--config <file>` | Path to a custom config file |
| `--stop` | Stop a running TurboLLM daemon (reads `~/.turbollm/daemon.pid`) and exit |
| `--help`, `-h` | Show usage and exit |

`turbollm launch claude` also accepts `--model <key|name>` to load a specific model before
launching; without it, an already-loaded model is used, or the last-used / first model is
auto-loaded. The same command works with `opencode`, `kilo`, and `openclaw` — each gets a
`turbollm` provider merged into its own config file before it starts — and with `hermes`,
which gets configured via its own `hermes config set` command instead.

---

## Configuration & data

Everything lives under **`~/.turbollm/`** on every OS — `config.json`, the SQLite chat
database, downloaded engines, models cache, and logs. Back it up or delete it to reset.
Use `--config <file>` to point at an alternate config (its directory becomes the data dir).

---

## Requirements

- **Node.js 22.13.0 or newer** — enforced at startup with a clear message. <https://nodejs.org>
- **Windows, macOS, or Linux.**
- A GPU is recommended but **not required** — a CPU build is provisioned as a fallback.
- On Windows, the first time the auto-downloaded `llama-server` runs, SmartScreen/Defender may
  prompt (it's an upstream binary). Allow it once.

---

## Privacy

TurboLLM is **offline-first**: core local use needs no account, no backend, and no internet.
**No analytics or telemetry are collected.** Your prompts, chats, files, and keys never leave
your machine.

---

## How TurboLLM compares

Focused on the differences that matter — all four are good tools, and the others move fast.
Marks reflect mid-2026; verify the moving rows against each tool's current docs.

| | **TurboLLM** | LM Studio | Ollama | Open WebUI |
|---|:---:|:---:|:---:|:---:|
| Run **any engine / community forks** | ✅ | ❌ llama.cpp/MLX only | ❌ hidden | ❌ frontend |
| **Benchmark-based auto-tune** of launch flags | ✅ | ◐ basic offload | ◐ basic offload | ❌ |
| **Measured** t/s in the model list | ✅ | ◐ per-run | ◐ `--verbose` | ❌ |
| **Anthropic** API (`/v1/messages`) → Claude Code | ✅ | ✅ 0.4.1+ | ✅ v0.14+ | ❌ |
| OpenAI-compatible API | ✅ | ✅ | ✅ | ◐ proxy |
| Auto-load the requested model / multi-model pool | ✅ | ✅ JIT | ✅ | ❌ |
| Use existing model folders (no re-download) | ✅ | ◐ import | ◐ import | ❌ frontend |
| Speculative decoding (draft / MTP) | ✅ | ✅ | ◐ env flag | ❌ |
| Web UI from any LAN device | ✅ | ❌ | ❌ | ✅ |
| **Lightweight** (no Electron / no Python) | ✅ npm | ❌ Electron | ✅ Go | ❌ Python |
| Offline-first · **no telemetry** | ✅ | ◐ analytics on by default | ✅ | ✅ |

LM Studio and Ollama both added Anthropic `/v1/messages` endpoints in 2026, so the API rows are
now parity — Claude Code works against any of them. TurboLLM's durable edges are **any engine
including community forks**, **benchmark-based auto-tuning with a VRAM-fit verdict + measured t/s
before you commit**, and **zero telemetry**.

Prefer Open WebUI's chat breadth? It works great pointed at TurboLLM's OpenAI endpoint.

---

## Troubleshooting

- **`TurboLLM requires Node.js 22.13.0 or newer`** — upgrade Node: <https://nodejs.org>.
- **Model won't load / OOM** — pick a smaller quant (the VRAM verdict warns you), lower GPU
  offload, or close other GPU apps. Failures surface in the Engines screen with the engine log.
- **Windows Defender / SmartScreen prompt** — that's the upstream `llama-server` binary on
  first run; allow it once.
- **Port already in use** — `turbollm --port 9000`.
- **Slow generation** — open the model's load params; ensure GPU offload is high and flash
  attention / NextN are on for supported models.

---

## Develop from source

```bash
npm install                  # daemon deps
cd web && npm install && cd ..

npm run build:web            # build the React UI -> src/webdist
npm run start                # run the daemon in dev (hot TS via tsx) -> :6996

npm run build                # production bundle -> dist/cli.js (web assets included)
node dist/cli.js --port 6996
```

Frontend hot-reload: `cd web && npm run dev` (proxies `/api` and `/v1` to the daemon on
:6996).

**Stack:** Node ≥22.13 · TypeScript · Hono · `node:sqlite` · tsup — and a React 19 + Tailwind v4 +
shadcn/ui frontend. One TypeScript codebase, shipped as an npm package.

---

## Community

Questions, ideas, and show-and-tell — join the [Discord](https://discord.gg/v6kRbV7nC).

---

## License

Source-available under the **Functional Source License 1.1 (Apache-2.0 future grant)** — SPDX
**`FSL-1.1-ALv2`**. Free for personal use, internal business use, education, and research; the
only restriction is shipping a competing product. Each release converts to Apache-2.0 two
years after it's published. Full text: [LICENSE.md](https://github.com/mohitsoni48/TurboLLM/blob/main/turbollm/LICENSE.md).

<p align="center"><sub>Built for people who refuse to wait for the mainstream to bless the fast path. ⚡</sub></p>
