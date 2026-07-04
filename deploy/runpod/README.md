# TurboLLM on RunPod — one-click deploy (Cloud Launch, ADR-045/152)

Runs TurboLLM on a rented RunPod GPU pod, reachable over the internet via a
[`--tunnel`](../../docs/decisions/decision-log.md) cloudflared quick tunnel — the
provider-agnostic "Cloud Launch" mechanism (Colab/Kaggle/Paperspace/Lambda all use the
same flag; RunPod is the first concrete recipe).

## v1 scope

- **Official upstream llama.cpp only** — not TurboQuant, not vLLM, not any other
  engine/fork. On an NVIDIA Linux box this means the **Vulkan** build specifically:
  upstream llama.cpp ships no Linux CUDA prebuilt at all, so TurboLLM's own
  auto-recommendation (ADR-025) picks Vulkan for NVIDIA-on-Linux. This is expected,
  not a workaround — it's the same thing TurboLLM would auto-select on any bare Linux
  box with an NVIDIA GPU.
- Other engines (vLLM, SGLang, TurboQuant, …) are a natural follow-up template variant
  once this one is proven — not in scope here.

## What the image does

1. Ubuntu 22.04 + CUDA runtime base (matches RunPod's own official-template
   convention), Node ≥22, `libvulkan1` (the Vulkan loader the Vulkan backend needs —
   the actual NVIDIA Vulkan ICD comes from the driver RunPod's container runtime
   mounts in at pod start).
2. `npm install -g turbollm`.
3. **Pre-bakes** the recommended engine at image-build time (starts the daemon
   briefly, waits for it to self-seed, stops it) so a per-hour-billed pod doesn't eat
   a download on its first request.
4. On container start: `npx turbollm --tunnel --no-open` — binds loopback-only,
   spawns a cloudflared quick tunnel, and prints the public URL + a required access
   token to the container logs.

## Why `--tunnel` instead of RunPod's own HTTP proxy

RunPod already gives every pod a public proxy URL
(`https://<pod-id>-<port>.proxy.runpod.net`) with zero setup — but its docs and blog
both flag a **hard ~100-second idle/response timeout** enforced at Cloudflare's edge in
front of it. That's a real risk for an LLM server: a cold model load or a long-context
prefill can easily exceed 100s, and the proxy 524s before the first byte gets out.
cloudflared's own tunnel (what `--tunnel` uses) has no such ceiling, which is why it
stays the primary access path here — the image still `EXPOSE`s the port as a
secondary/debug route via RunPod's proxy, but don't rely on it for chat traffic.

## Who does what (the shared-template model)

Earlier drafts of this doc had every user build + push their own Docker image before
the "Deploy on RunPod" button did anything — too technical for a normal user, and
pointless duplicated work. The image build/push is now automated (below); only ONE
person (the maintainer) does the RunPod Template creation, ONCE, ever. Everyone else
just clicks a button in Developer → Cloud Deploy that already works.

### Automated (CI) — nobody does this by hand

`.github/workflows/runpod-image.yml` builds this Dockerfile and pushes it to
`ghcr.io/<repo-owner>/turbollm-runpod:latest` on every change to `deploy/runpod/`,
weekly (to pick up new `npm install -g turbollm` releases — the image has no version
pin), and on manual dispatch. Authenticates with GHCR via the workflow's built-in
`GITHUB_TOKEN` — no separate registry account or secret to configure.

**One-time setup after the workflow's first run**: GHCR packages default to private:
open the repo's Packages tab → `turbollm-runpod` → Package settings → change
visibility to Public (RunPod needs to be able to pull it without credentials).

### Maintainer, one-time only — creating the official RunPod Template

1. **Create a RunPod Template** via the console (Manage → Templates → New Template) —
   not scripted against the REST API, since RunPod's template field names have shifted
   as they migrated GraphQL → REST and the exact current schema wasn't independently
   confirmed while writing this:
   - Container image: `ghcr.io/<repo-owner>/turbollm-runpod:latest`
   - Exposed ports: `6996/http` (secondary/debug path only, see above)
   - Container disk: ~30 GB (model weights need real room)
   - Start command: leave as the image's `ENTRYPOINT` (no override needed)
   - Visibility: Public (so the deploy link below works for anyone)
2. **Take the resulting Template ID** and set it as `OFFICIAL_RUNPOD_TEMPLATE_ID` in
   `turbollm/web/src/screens/DeveloperScreen.tsx` — this is what makes the Developer
   screen's "Deploy on RunPod" button work with zero setup for every user from then on.
   (The Settings field there is only for someone deploying their own custom fork —
   it overrides the official default, it's never required.)

### Everyone else

Just click **Developer → Cloud Deploy → Deploy on RunPod** in the app. It opens:
```
https://runpod.io/console/deploy?template=<TEMPLATE_ID>
```
with the official template pre-selected — pick a GPU, hit Deploy, TurboLLM starts
automatically. Open the pod's logs in the RunPod console shortly after it starts —
TurboLLM prints:
```
  Tunnel:  https://xxxx.trycloudflare.com
  Token:   tllm-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
           (required for anyone using this tunnel URL)
```
Open the tunnel URL in a browser; when it asks for a key, paste the printed token.

## Known unknowns worth verifying on a real pod before wide use

- Whether the Vulkan ICD RunPod's container runtime mounts in is picked up correctly
  by `libvulkan1` out of the box, or needs an extra `VK_ICD_FILENAMES` env var — this
  couldn't be verified without an actual GPU pod (the dev box this was built on is a
  single-GPU Windows machine).
