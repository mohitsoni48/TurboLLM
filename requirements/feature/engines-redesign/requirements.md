# Requirements — feature/engines-redesign

## Requirements

1. Install TurboLLM from local source on macOS (Apple M2 Pro, 32GB, macOS 26.5.2) and verify it
   runs correctly, fixing any Mac-specific issues found. — 2026-07-06
   - Acceptance: `npm link`ed build boots the daemon + web UI with no console/log errors.
   - Constraints: test the actual branch source, not the stale published npm package.

2. Search for and concretely test the most capable inference engines for Mac, one by one,
   starting with MLX. — 2026-07-06
   - Acceptance: each tested engine loads a real model and completes a real chat generation.
   - ~~Constraints: "Rapid-MLX" in the catalog is `comingSoon`/not wired up (needs the
     EngineKind descriptor refactor first) — user explicitly deferred it; test the already-working
     `MLX` engine instead. Do not build out Rapid-MLX support in this pass.~~ — **Superseded
     2026-07-06/07**: user explicitly reversed this after reviewing initial results ("you didn't
     add rapid mlx... do all of these"). Rapid-MLX was researched in depth and fully wired up as
     a real, installable, working engine — see Bug Fix 4 below.
   - **Updated 2026-07-07**: user further required *every* catalog engine applicable to Mac be
     concretely tested end-to-end (install → activate → load a real model → real chat
     completion), "no shortcuts". Completed for all of: llama.cpp (Metal), MLX, TurboQuant,
     ik_llama.cpp, Rapid-MLX, llamafile, KoboldCpp, vLLM, SGLang. See Bug Fixes 4–5 and the
     Non-Bugs section for per-engine outcomes.

6. Add real Rapid-MLX support (install/launch/readiness wiring), reversing the earlier deferral
   in Requirement 2. — 2026-07-06/07
   - Acceptance: installable from the Engines screen for real (not a "coming soon" placeholder),
     loads a real local MLX model, and serves a correct real chat completion.
   - Constraints: none given beyond "do all of these" — user does not want partial/placeholder
     work in this area anymore.

7. Test every remaining catalog engine end-to-end on Mac (TurboQuant, llamafile, KoboldCpp,
   vLLM, SGLang) — "no shortcuts", no questions to be asked before proceeding. — 2026-07-07
   - Acceptance: for each, attempt real install → activate → load a real model → real chat
     completion, and report pass/fail with verbatim evidence — a well-documented platform
     limitation counts as a valid, honestly-reported "fail", not something to skip or hide.

8. Test *every minor and major part of the whole app* on Mac, not just the engine subsystem —
   raised by the stop-hook after Requirement 7 was reported as "comprehensive" when it only
   covered engines. "No shortcuts allowed." — 2026-07-07
   - Acceptance: walk every screen/major feature area and exercise its core interactions for
     real (not just code review): Workspace/Chat (folders, search, move-to-folder, personas,
     thread settings, model settings, attachments, artifact rendering for mermaid/svg/html,
     skill toggles), Models (Library, Discover/HF search+download, ModelDirs, bench/auto-tune),
     Engines (already covered by Requirement 7), Customize (Agents/Skills already covered;
     MCP Servers — connect a real local server), Developer (API keys, tool permissions),
     Settings (theme, all setting sections, hardware detection, network/LAN, HF token, app
     update check). Fix any real bugs found; document non-bugs and out-of-scope findings.

9. User reported Rapid-MLX returning a 400 in real use; demanded every engine be re-tested with
   real chat *and* real long generations (500–3000 tokens), zero errors tolerated ("this is the
   question of my dignity"), and any bugs found be fixed. — 2026-07-07
   - Acceptance: for each of Rapid-MLX/MLX/llama.cpp-Metal/TurboQuant/KoboldCpp/llamafile —
     a real chat completion, a real long (500+ token) generation, and a real streaming request,
     all HTTP 200 with well-formed output. vLLM/SGLang given a genuine re-test (not just a
     re-read of prior notes) since the prior pass only tried vLLM with an incompatible model
     format. Any genuine TurboLLM code defect surfaced along the way must be fixed and verified;
     genuine upstream/third-party/model-data issues must be honestly distinguished and documented,
     not silently worked around.
   - Result: see Bug Fixes 7, 9, 10 (real, fixed) and the Non-Bugs section (real, but not
     TurboLLM's to fix) below. All six Metal/CPU-native engines passed chat + long-gen +
     streaming with zero technical errors after the fixes. Bug Fix 8's original diagnosis was
     wrong and is corrected in place rather than deleted — see its entry.

3. Add the missing "1-click build" (guided compile-from-source) feature for macOS. — 2026-07-06
   - Acceptance: the guided-build flow (prereq check → clone → cmake configure → compile →
     register) works end-to-end on darwin, using Metal instead of CUDA.
   - Constraints: don't touch the Windows/Linux + CUDA path's behavior or tests.

4. Test the new Agents and Skills features (added via PR #47 on `main`) on macOS. — 2026-07-06
   - Acceptance: built-in agent personas render (Customize → Agents); built-in skills render
     (Customize → Skills); the `/skill-id` chat activation mechanism enables a skill and its
     tools execute through the approval gate.
   - Constraints: this branch had forked before PR #47 landed and needed `main` merged in first
     (see Bug Fixes #1).

5. Produce a Mac vs Windows+CUDA capability parity summary. — 2026-07-06
   - Acceptance: a clear list of what was fixed, confirmed working, and any remaining
     platform gaps.

## Bug Fixes

1. `feature/engines-redesign` was 43 commits behind `origin/main`, missing the entire
   agents/skills rework (PR #47) — including the commit that deleted the old standalone
   `AgentsScreen.tsx` in favor of in-chat agents. This produced a stale, already-removed
   "Agent runs" UI when testing agents on this branch. — 2026-07-06
   - Root cause: branch divergence — engines-redesign work continued without periodically
     merging `main`.
   - Fix: committed in-flight Mac build-fix work first, then merged `origin/main` into
     `feature/engines-redesign` (clean merge, no conflicts). See commit `a14c25d`.

2. The in-app "1-click build" (guided compile-from-source, ADR-100) was hardcoded to
   Windows/Linux + CUDA only, across three separate gates: `build-prereqs.ts`
   (`checkBuildPrereqs` returned `supported:false` on darwin), `build-runner.ts`
   (`runBuild` threw "Windows or Linux (with CUDA) only"), and a route-level platform check in
   `routes.ts` (`POST /api/v1/build/run` returned 409 on non-win32/linux). — 2026-07-06
   - Root cause: the feature was built CUDA-first and macOS was explicitly "parked" rather
     than wired to the Metal backend it already ships prebuilt binaries for.
   - Fix criteria: macOS builds with `-DGGML_METAL=ON` instead of `-DGGML_CUDA=ON`, checks for
     git/cmake/clang++ (no GPU toolkit) instead of CUDA, and skips the CUDA-runtime-bundling
     post-build step (Metal is a system framework, nothing to bundle). Verified end-to-end:
     built upstream `ggml-org/llama.cpp` from source on this Mac, confirmed cmake picked up
     the Metal backend, and the resulting `llama-server` binary ran natively. See commit
     `2ed678d`.

3. The tool-call approval dialog rendered the literal string `"undefined"` for a `web_search`
   call when the model emitted `{"queries": [...]}` (plural array) instead of the schema's
   `{"query": "..."}`(singular) — reproduced with gemma-4B via MLX on this Mac. The same
   mismatch existed server-side in `execWebSearch`, which would have silently searched for an
   empty string. — 2026-07-06
   - Root cause: `describeToolCall` (web) and `execWebSearch` (backend) both read only
     `args.query`, with no fallback for the plural shape a small local model actually produced.
   - Fix criteria: extracted a `resolveSearchQuery()` helper (duplicated on both sides — the web
     bundle can't import Node backend code) that prefers `query` but falls back to `queries[0]`.
     Not platform-specific, but found and fixed while testing skills on Mac. See commit
     `e7650af`. **Note:** the user separately spawned a background task for this same fix in
     parallel — that task was already claimed/started by the time this session's fix landed, so
     there may be a duplicate/overlapping fix in flight elsewhere. Reconcile before merging.

4. The guided-build feature (Bug Fix 2) built `ik_llama.cpp` from source with `-DGGML_METAL=ON`
   and failed: its `src/llama-dflash.cpp` calls `ggml_backend_is_metal` /
   `ggml_backend_metal_set_n_cb`, but its vendored ggml doesn't implement them (matches its own
   catalog note "CPU + CUDA only, no ROCm/Metal" — genuinely incomplete upstream Metal support,
   not a TurboLLM bug). Reported directly by the user trying it themselves. — 2026-07-07
   - Root cause: the guided build always tried Metal first on macOS with no fallback when a
     fork's own Metal backend is broken/incomplete.
   - Fix criteria: detect this specific undefined-symbol compile-error signature
     (`isIncompleteMetalBackendError` in `build-runner.ts`) and automatically retry the same
     build as CPU-only (`-DGGML_METAL=OFF`) instead of failing outright. Verified end-to-end
     twice: reproduced the original failure, then confirmed the retry fires and produces a
     working CPU-only `ik_llama.cpp` binary (checked `GGML_METAL:BOOL=OFF` in the resulting
     `CMakeCache.txt`, ran the binary, confirmed `arm64 Mach-O`).

5. `llamafile` accepted a `POST /api/v1/engine/start` (202) but the process never actually
   spawned — `engine.state` stayed `"stopped"` indefinitely with no error surfaced anywhere in
   `/api/v1/status`; only a bare `console.warn` on the daemon's own stdout
   (`engine load failed: Error: spawn ENOEXEC`) hinted at the cause. Found while executing
   Requirement 7 (test every engine). — 2026-07-07
   - Root cause: llamafile ships as an "Actually Portable Executable" (Cosmopolitan libc)
     polyglot binary — its leading bytes look like a DOS/PE header, and a POSIX shell is what
     dispatches it to the right native format for the current OS. Node's `spawn()` calls
     `execve()` directly (no shell), which macOS/Linux reject with `ENOEXEC` for this format.
     Windows already recognizes the polyglot's MZ/PE header natively, so it wasn't affected.
     Confirmed directly: manually running the identical binary through a shell (which is what
     the Bash tool itself does) worked immediately with no changes.
   - Fix criteria: route llamafile specifically through `/bin/sh -c 'exec "$0" "$@"'` on
     non-Windows platforms — the standard safe shell-wrapping idiom (argv passed as separate
     array entries via `"$0"`/`"$@"`, so no manual quoting/escaping and no shell-injection risk
     from argument content, e.g. a model path containing spaces). Verified end-to-end: llamafile
     now loads a real GGUF model and serves a correct real chat completion on this Mac.

6. `ArtifactCard.tsx`'s `verifyWithVision()` (a self-check that screenshots a rendered artifact
   and asks the model "does this look right?") POSTed to `/api/v1/chat/completions` — that route
   doesn't exist (every other caller in the codebase correctly uses `/v1/chat/completions`, no
   `/api` prefix) — so the check always 404'd and silently fell through to `catch { return true }`,
   meaning this self-check has probably never actually run. Found while testing HTML artifact
   rendering with the Designer persona (which surfaced a real truncated-artifact case — see Non-
   Bugs below). — 2026-07-07
   - Root cause: a one-character-class typo (extra `/api` segment) inconsistent with the rest of
     the codebase's convention.
   - Fix criteria: correct the path to `/v1/chat/completions`. Fixed and verified the 404 is gone
     — but doing so surfaced a second, deeper, NOT-Mac-specific issue (the gateway route itself
     rejects `image_url` content with "Only 'text' content type is supported", so the self-check
     still can't succeed end-to-end) — flagged separately as a follow-up task, not fixed in this
     branch since it needs a design decision (extend the public gateway's vision support, or point
     this internal self-check at whichever endpoint the real chat-image-attachment feature uses).

7. `vllmProfileToArgs()` never emitted `--max-num-batched-tokens`, so vLLM always fell back to its
   own internal default (2048). vLLM's `SchedulerConfig` validator hard-rejects (refuses to start,
   `pydantic.ValidationError`, not a soft truncation) any launch where the effective
   `max-model-len` exceeds `max-num-batched-tokens` — so vLLM failed to start for *any* model whose
   context exceeds 2048, which is nearly every real model (reproduced live with a real HF-format
   SmolLM2-135M-Instruct download, native ctx 8192). This is a universal bug, not Mac-specific — it
   would reproduce identically on Linux+CUDA. Found while re-testing vLLM for Requirement 9 (the
   prior pass never got this far because it used an incompatible MLX-format model that failed
   earlier, at model-loading rather than scheduler-config time). — 2026-07-07
   - Root cause: the function only special-cased vLLM's *other* scheduler/memory flags, each
     emitted "only when it deviates from vLLM's own default" (F-027's design goal) — but no field
     existed for `max-num-batched-tokens` at all, so it was never emitted regardless of context
     size.
   - Fix criteria: emit `--max-num-batched-tokens` sized to the effective max-model-len (the
     explicit `vllm.maxModelLen` override when set, else `p.ctx` — which mirrors what vLLM itself
     derives from the model's `max_position_embeddings` when `--max-model-len` is left unset)
     whenever that exceeds vLLM's 2048 default. See `vllmProfileToArgs()` in
     `turbollm/src/models/profile.ts`. Updated `profile.vllm.test.ts`'s "default profile emits no
     flags" test (which encoded the buggy assumption) to use a tiny-context model, and added
     3 new tests for the fix. Verified end-to-end: the exact `SchedulerConfig` crash reproduced,
     then confirmed gone after the fix (vLLM progressed past scheduler-config into model/tokenizer
     loading on the next launch attempt).

8. **Superseded below (see Bug Fixes 9–10) — initial diagnosis was wrong.** ~~The Models Library
   never surfaced a model's `hasChatTemplate: false` flag anywhere in the UI... so it was a
   defective model download, not a Rapid-MLX defect... added a `NO CHAT TEMPLATE` tag to the
   Library list row.~~ — **Corrected 2026-07-07**: the user pushed back ("why does qwen say no
   chat template? it used to work earlier") — a real, specific, checkable claim, not a vague
   objection. It used to work: confirmed via the app's own conversation history (a real,
   substantive chat with this exact model on 2026-07-01, before Rapid-MLX existed). Chasing that
   down properly (below) found the actual bug — TurboLLM's own downloader was silently dropping
   a file — rather than stopping at "the download is defective," which was true but incomplete
   and wrongly implied nothing here was fixable. Keeping this entry (struck through, not deleted)
   as a reminder: a plausible-sounding root cause still needs to survive a direct challenge before
   it's trusted. The `NO CHAT TEMPLATE` badge (`ModelsScreen.tsx`) stays as a real, useful
   defense-in-depth warning for any model that reaches this state for other reasons — it just
   wasn't the actual fix for this case.

9. TurboLLM's own HF-repo file listing (`HfClient.getRepo()` in `hf.ts`) only matched
   `.safetensors`/`.json` files when building a safetensors/MLX repo's download list — silently
   excluding `chat_template.jinja`, the current HF convention for shipping a chat template as a
   standalone file (superseding the older convention of embedding it inside
   `tokenizer_config.json`, which mlx-lm/transformers no longer fall back to on its own). This
   left every such download (e.g. the user's "Qwen3.6 27B 3bit mlx", confirmed file-for-file
   identical to its real source `leonsarmiento/Qwen3.6-27B-3bit-mlx` except for this exact
   missing file) with no usable chat template. — 2026-07-07
   - Root cause: `getRepo()`'s safetensors-file regex predates the standalone-`.jinja`-file
     convention becoming common and was never updated to include it.
   - Fix criteria: added `/\.jinja$/i` to the file-inclusion pattern in `getRepo()`. Added
     `hf.repo.test.ts` (2 tests: the fix, and that nested/non-root files are still excluded).
     Verified end-to-end: manually downloaded the missing `chat_template.jinja` from the
     confirmed real source repo into the existing local model directory, then re-tested — see
     Bug Fix 10 for the full chain to a working chat.

10. Even with `chat_template.jinja` now present on disk, the Models Library still reported
    `hasChatTemplate: false` for the same model — `mlxEntryFor()` in `scanner.ts` only checked
    whether `tokenizer_config.json`'s raw text contained the substring `chat_template`, never
    checking for a standalone `chat_template.jinja` file's existence. Same blind spot as Bug Fix
    9, in a different function. — 2026-07-07
    - Fix criteria: `hasChatTemplate` is now true if either the embedded check passes OR
      `chat_template.jinja` exists in the model directory. Added 3 tests to
      `scanner.mlx.test.ts` (embedded-only, standalone-only, neither). Verified end-to-end: after
      this fix + a rescan, the model correctly reports `hasChatTemplate: true`, and loading it on
      **Rapid-MLX** (the engine the user actually reported the 400 on) now produces a real, clean
      chat completion (`finish_reason: "stop"`) and a real 559-token long generation — the exact
      failure the user reported is gone, with the exact model they hit it with, on the exact
      engine they hit it with.
    - Note on why "it used to work" and yet my first engine-parity check (misleadingly) seemed to
      reproduce the same 400 on plain MLX too: `mlx_lm.server`'s own code (`server.py`) has a
      graceful fallback — when `tokenizer.has_chat_template` is false, it manually formats the
      conversation instead of calling `apply_chat_template()` at all, so a missing template is
      *recoverable* there. Rapid-MLX runs on a completely different codebase (`vllm_mlx`, no such
      fallback) and hard-crashes instead. Re-tested carefully after this fix landed: plain MLX in
      fact returns a normal 200 for this exact model+request even *without* the chat_template.jinja
      fix (confirming the July 1 conversation's success), meaning my earlier claim of an
      "identical reproduction on plain MLX" was a testing mistake — most likely a race during an
      engine switch — not a real finding. Corrected here rather than left standing.

11. User: "I could not load gemma 4 in rapid mlx. Dont take shortcuts by proving yourself by
    downloading a bad model. These 2 must be ran. if they require another file download that
    and then dont show these files in list when engine is changed" — rejecting the earlier
    Non-Bugs classification of the Gemma4-on-Rapid-MLX failure as an unfixable third-party issue,
    demanding real investigation (not substituting an easy model to claim success), a download-a-
    missing-file fix if that's the actual cause (per Bug Fix 9's pattern), and — if genuinely
    unfixable — the model hidden from the list rather than shown as loadable. — 2026-07-07
    - Acceptance: determine conclusively whether this is a missing file (fixable like Bug Fix 9)
      or a genuine code-level bug; if the latter, do not patch the model file or the third-party
      library (user explicitly vetoed this — "we dont apply fix to models... I want that people
      can download any supported model from hf and use it. not patch it"); instead extend the
      real compatibility system so the model is hidden from the Library when the incompatible
      engine is active, with a clear error if loaded anyway.
    - Result: root-caused as a genuine `mlx_vlm` code bug (not a missing file) — see Bug Fix 12.
      Fixed by extending model/engine compatibility detection — see Bug Fix 13.

12. Root-caused the Gemma4-on-Rapid-MLX crash precisely, ruling out a missing-file explanation
    first: upgraded the Rapid-MLX venv's `mlx-vlm` from 0.6.3 to the latest available (0.6.4),
    which fixed the *original* error (`Received 126 parameters not in model` on
    `language_model.model.layers.24+`) but exposed a second, different one: `ValueError: Expected
    shape (128, 3, 3, 1) but received shape (128, 3, 1, 3) for parameter
    audio_tower.subsample_conv_projection.layer0.conv.weight`. Traced to
    `mlx_vlm/models/gemma4/gemma4.py`'s `sanitize()`, which unconditionally transposes this conv
    weight assuming a raw PyTorch-layout checkpoint (`v.transpose(0, 2, 3, 1)`) — but this MLX
    checkpoint's conversion had *already* stored it in MLX-native layout, so `load()` (which also
    calls `sanitize()`) double-transposes it. Confirmed via `mx.load()`: the on-disk tensor shape
    already matches what the Conv2d layer expects. This is a genuine upstream `mlx_vlm` bug
    (present even in the newest release), not a missing file, not something re-downloading fixes,
    and not a TurboLLM defect. — 2026-07-07
    - I verified a working repair was mathematically possible (pre-transposing the two affected
      tensors in the local checkpoint so mlx_vlm's buggy transpose lands back on the correct
      values — confirmed the exact round-trip on a synthetic tensor) and asked the user for
      permission before writing to their real model file. They declined on principle: TurboLLM
      should never require patching a downloaded model, since that only fixes one user's one
      local copy and contradicts "download any supported model from HF and use it." Correct
      call — the file was never modified (verified via checksum against the backup made before
      asking, which was then deleted unused).

13. Fixed via real, general compatibility detection instead of a model patch. Two prerequisite
    bugs, both in `scanner.ts`'s `mlxEntryFor()`: (a) `vision` was hardcoded `false` for every
    MLX-format model regardless of config.json — so no MLX vision model has ever shown up under
    the Models screen's "Vision" filter tab; (b) there was no `audio` detection at all. — 2026-07-07
    - Fix criteria: `vision` now reads `config.json`'s `vision_config` presence; new `audio` field
      reads `audio_config` presence (`ModelEntry.audio`, GGUF path always `false` — no observed
      need there yet). Added `engineRejectsAudioModel()` to `compat.ts` (true only for
      `'rapid-mlx'` — plain MLX never attempts VLM/audio loading at all and is unaffected; vision-
      only models with no audio tower are NOT excluded, since only the audio path is confirmed
      broken). Wired into both `compatibleWithActiveEngine` (list-hiding, `routes.ts`) and the
      `POST /api/v1/engine/start` load guard (a clear 409
      `"Rapid-MLX cannot load models with an audio tower (a confirmed upstream mlx-vlm bug) —
      switch to the MLX engine instead."` instead of a crashed engine process). Added 4 tests
      (`scanner.mlx.test.ts` ×3 for vision/audio detection, `compat.test.ts` ×1 for the new
      predicate). Verified end-to-end in the browser: with Rapid-MLX active, "gemma 4 E4B it MLX
      4bit" is hidden from the Library by default, shows `VISION` + `NEEDS MLX OR VLLM` badges
      with Load disabled under "Show all", and a direct API load attempt returns the clean 409 —
      no crashed process, no orphaned engine state. Confirmed the model still loads and chats
      normally on the plain MLX engine (unaffected, as expected).
    - **Follow-up (2026-07-07, same day)**: user reported gemma4 working on Rapid-MLX elsewhere
      ("i tried gemma 4 in turbollm with mlx and i tried gemma 4 in rapid mlx. that was a diff
      download" — on a different Mac, via the standalone Rapid-MLX app, not through TurboLLM).
      Investigated whether the blanket `engineRejectsAudioModel` rule was too broad — i.e.
      whether this is a per-*file* conversion-quality issue (some downloads broken, others fine,
      like Bug Fix 9's missing chat_template.jinja) rather than a universal one, which would mean
      a smarter per-file detector (reading the safetensors header to check the actual on-disk
      weight layout) should replace the blanket rule. Searched HF, found and downloaded a second,
      *independently converted* gemma4-E4B checkpoint from a different uploader
      (`mlx-community/gemma-4-e4b-it-4bit` — single-shard, different quantization, unrelated to
      the original `lmstudio-community` conversion already on disk) specifically to test this.
      Result: **identical crash**, same tensor, same shapes, same error, on the current mlx-vlm
      0.6.4. Also attempted installing an older `mlx-vlm` (0.6.0) in an isolated scratch venv to
      check whether a pre-audio-tower-support release would simply skip the module — blocked
      immediately by an unrelated import-time crash (same root class of bug as Bug Fix 7: no
      upper-bound `transformers` pin, so `uv pip install mlx-vlm==0.6.0` resolved the same
      unconstrained `transformers` release, whose `AutoTokenizer.register` API had already moved
      on). Conclusion: this is a **universal bug in the current mlx-vlm release**, not a
      per-download conversion-quality issue — every gemma4-E4B-with-audio MLX checkpoint hits it
      today, regardless of source. The proposed per-file detector would have been the wrong fix
      (there is no good/bad distinction to detect); the blanket `engineRejectsAudioModel` rule
      already built stands as correct. The user's other-Mac success is most plausibly explained by
      a different (older or newer, or altogether different) `mlx-vlm`/Rapid-MLX release on that
      machine, not by a better-converted file — outside what's reproducible or fixable here.

## Non-Bugs / Deliberate Behavior (documented so they aren't re-investigated as bugs)

- `filesystem` skill is deliberately excluded from chat (`CHAT_UNSUPPORTED_SKILLS` in
  `ChatScreen.tsx`) — it's meant for a different workspace/agent sandboxed-fs mode, not general
  chat. Typing `/filesystem` in chat correctly falls through as plain text.
- `ik_llama.cpp`'s own catalog entry documents "CPU + CUDA only (no ROCm/Metal)" — that
  upstream fork does not support Metal. The new macOS guided-build feature (Bug Fix #2) will
  still let a user build it from source on Mac, but only as a CPU build; do not treat a failed
  or CPU-only Metal build of this specific fork as a regression in Bug Fix #2's work.
- Two duplicate-looking engine registry entries ("Turbo Quant" / "TurboQuant", pointing at two
  different local build directories) are pre-existing local data from earlier manual testing
  sessions on this machine, not a catalog or code defect. Worth cleaning up locally, not a code
  fix.
- The local hardware-detection VRAM figure ("Apple M2 Pro · 22 GB") is lower than the machine's
  actual 32GB RAM — this is Apple Silicon's usable-for-GPU unified-memory figure (a real macOS/
  Metal constraint, not a detection bug); not investigated further in this pass.
- **vLLM on Mac (Requirement 7)**: installs and activates cleanly (CPU-only build, ~90s), but
  failed to load the local MLX-quantized Gemma model — a real `pydantic` `ValidationError`
  ("rope_scaling should have a 'rope_type' key") from vLLM's own config validator correctly
  rejecting an Apple-MLX-specific quantization format it was never meant to read. This is the
  expected outcome for vLLM's documented "macOS is CPU-only experimental" status, not a
  TurboLLM defect — vLLM itself works, it just needs a genuine HF-transformers-format
  safetensors model, not an MLX one.
- **SGLang on Mac (Requirement 7)**: install itself failed — `uv pip install sglang[all]` pulled
  in a pinned `outlines→numba→llvmlite==0.36.0` chain whose native build only supports Python
  <3.10, while TurboLLM's venv uses Python 3.12.9. Consistent with SGLang's own catalog note
  ("macOS and Windows are unsupported upstream"); the proximate failure is a pinned-dependency/
  Python-version conflict rather than a runtime platform check, but the practical outcome is the
  same — not installable on this Mac today. Not something to fix in TurboLLM (the incompatible
  pin lives in `sglang[all]`'s own dependency tree).
- Reasoning models (e.g. "Ornith 1.0 9B", used for the GGUF-format engine tests) spend their
  token budget on a `<think>` preamble before the final short-form answer — a caller using a
  small `max_tokens` (e.g. 30, a reasonable default for a one-word answer) sees an empty
  `content` field with the real answer only inside `reasoning_content`, cut off by
  `finish_reason: "length"`. This is model-usage behavior, not an engine or daemon defect;
  raising `max_tokens` (e.g. to 150) lets the trace finish and the correct final answer appears.
  Confirmed on TurboQuant, KoboldCpp, and llamafile — same model, same behavior on all three.
- **Settings screen has no dedicated "Telemetry" UI section** (backend has a telemetry system —
  `telemetryLevel` in status, `getTelemetryPreview` API — but no on/off toggle was found after
  scrolling the entire Settings page top to bottom). Likely CLI-only control; not investigated
  further since nothing appeared broken, just not surfaced in this screen.
- **Two duplicate-looking `Turbo Quant` / `TurboQuant` registry entries** (noted earlier) meant
  the app-wide engine test for Requirement 8 had to explicitly pick the correctly-named one — no
  functional impact, same pre-existing local-data note as before.
- ~~**Rapid-MLX + a Gemma4 vision-language checkpoint ("gemma 4 E4B it MLX 4bit")**: fails to load
  with `ValueError: Received 126 parameters not in model: language_model.model.layers.24...`.
  Root-caused to Rapid-MLX's bundled `mlx_vlm` 0.6.3 package... not something to patch here.~~ —
  **Superseded 2026-07-07** (Requirement 11 / Bug Fixes 12–13): user rejected "not our problem" as
  premature. Upgrading `mlx_vlm` to the latest release (0.6.4) *did* fix this exact error, proving
  it wasn't permanently unfixable — it exposed a second, different, still-live upstream bug
  instead (the audio-tower conv-weight double-transpose, Bug Fix 12). That second bug really is
  unfixable without patching either the model file or the third-party library, both of which the
  user explicitly ruled out. The real, general, non-patching fix — proper vision/audio detection
  + engine compatibility hiding — is Bug Fix 13. The model still loads and chats successfully on
  the plain MLX engine, unaffected either way.
- **TurboQuant "degenerate" reasoning output on a long-generation test**: at default (non-zero)
  temperature, Ornith 1.0 9B occasionally free-associates into a repetitive word-by-word
  numbering pattern inside its own `<think>` block instead of converging, burning the entire
  token budget on reasoning. Initially looked TurboQuant-specific; disproven by a controlled
  `temperature=0` re-run — TurboQuant produced byte-identical output (same `completion_tokens`,
  same `reasoning_content` length) to llama.cpp Metal on the identical prompt/model. Confirmed as
  inherent sampling variance in this reasoning model at higher temperatures, reproducible on any
  engine, not an engine defect.
- **vLLM on Mac, re-tested with a real HF-transformers-format model (Requirement 9)**: after
  Bug Fix 7 resolved the universal `max-num-batched-tokens` crash, a real download of
  `HuggingFaceTB/SmolLM2-135M-Instruct` (plain safetensors, not MLX) still failed one step later:
  `AttributeError: GPT2Tokenizer has no attribute all_special_tokens_extended` inside vLLM's own
  `get_cached_tokenizer()`. Root-caused directly in the vLLM venv: `vllm==0.11.0`'s own package
  metadata declares `transformers>=4.55.2` with **no upper bound**, so `uv pip install vllm`
  legitimately resolved the latest `transformers` (5.13.0) — whose tokenizer API vLLM 0.11.0's
  own code isn't compatible with (confirmed the same `AttributeError` occurs for every tokenizer
  class transformers 5.13.0 can produce for this model, not just the slow `GPT2Tokenizer` one its
  config happens to pin). This is a genuine, currently-live upstream vLLM packaging defect
  (under-constrained dependency metadata), not a TurboLLM bug — and not something to work around
  by force-pinning a third-party package's transitive dependency (fragile, would need ongoing
  maintenance as both projects move, and could silently break other models needing newer
  `transformers` features). vLLM on this Mac remains blocked, but for a different, deeper,
  non-TurboLLM reason than previously documented.
- **SGLang re-verified (Requirement 9)**: re-ran the install; identical failure as previously
  documented (`llvmlite==0.36.0` build failure via `sglang[all]`'s own pinned dependency chain,
  incompatible with Python 3.12). No regression, no change.

## Requirement 8 — App-wide test results (2026-07-07)

Screens/features exercised for real (not just code review), beyond the engine subsystem already
covered by Requirements 2/6/7:

- **Workspace/Chat**: new folder creation ✓, move-to-folder ✓, conversation search/filter ✓,
  persona switching (native `<select>`) ✓, thread settings dialog (system prompt, sampling
  sliders, skill checkboxes) ✓, model settings dialog (VRAM estimate, sampling, reload/save) ✓,
  mermaid artifact rendering ✓, SVG artifact rendering ✓, HTML artifact rendering (surfaced Bug
  Fix 6 + the truncation-warning finding below) — real inference throughout via MLX.
- **Models**: Library tab ✓, Discover tab live HF search ✓, real model download end-to-end
  (mlx-community/SmolLM2-135M-Instruct, appeared in the library immediately after) ✓, Auto-tune
  bench on a GGUF model via llama.cpp Metal — real measured sweep, real winning config (ngl=32,
  KV q8_0, flash attn on, 19.5 tok/s) ✓.
  - Not saved/persisted since I navigated away without clicking the bench-result dialog's Save —
    expected behavior (profile only persists on explicit Save), not a bug.
- **Customize → MCP Servers**: built-in web-search provider cards (Tavily/Kagi/SearXNG) render ✓;
  Local tab lists real local npx/uvx-based servers ✓; connected a real one (Memory,
  `npx -y @modelcontextprotocol/server-memory`) end-to-end — real process spawn, real MCP
  handshake, "Connected" badge + "Connected (1)" tab count confirmed ✓.
- **Developer**: API key creation (real key generated, shown once) ✓ and deletion ✓; Tool
  Permissions panel (per-tool Ask/Allow/Deny for `fetch_url`/`run_code`, matches the in-chat
  approval bar's "Always Allow") ✓; Available APIs reference list renders ✓.
- **Settings**: theme switch (Light/Dark/System, verified Light renders with correct contrast) ✓;
  every section reviewed top-to-bottom — Appearance, Engine, Model Defaults, Chat, Personalization,
  Startup, ComfyUI, Gateway, Network (real LAN IP detected: `192.168.29.98:6996`), Model folders,
  Models/HF token, Hardware (real detection: Apple M2 Pro · 22.3 GB VRAM · 10 cores · 34.4 GB RAM
  · darwin/arm64), Advanced (restart daemon), About (real npm-registry version check: "You're on
  the latest version"), Help.

New finding (not fixed — not Mac-specific, needs a product decision, spawned as a follow-up task):
an artifact whose generation is cut off by the token limit (`genTokens` hit an exact round-number
cap, e.g. 512) renders as a completely blank/empty box with **zero indication to the user** that
anything was truncated. Confirmed the srcdoc HTML was genuinely incomplete (missing `</head>`,
`<body>`, and the actual widget markup) rather than a rendering-engine problem. Settings confirms
"Max response tokens: 0 = unlimited" (TurboLLM itself imposes no cap), so the observed 512-token
cutoff comes from the underlying engine's (mlx-lm's) own default when no explicit `max_tokens` is
sent — worth the follow-up task investigating a better default AND, more importantly, adding a
"response was cut off" notice instead of a silent blank artifact.

## Dependency Graph

- Requirement 4 depended on Bug Fix 1 (had to merge `main` before agents/skills existed on this
  branch to test).
- Requirement 3 (1-click build) is independent of Requirements 2/4 but was verified using the
  same MLX-loaded chat session as Requirement 2.
- Bug Fix 3 was discovered as a side effect of Requirement 4's skills testing, not a pre-planned
  requirement.
- Bug Fixes 7 and 8 were both discovered as side effects of Requirement 9's exhaustive re-test,
  not pre-planned. Bug Fix 8 (the missing-chat-template UI badge) directly explains the user
  report that triggered Requirement 9 — the underlying model-data defect itself was not a code
  bug (confirmed identical on two different engines), but the app's total silence about it was.
