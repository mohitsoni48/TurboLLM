# TurboLLM on RunPod (Cloud Launch, ADR-045/152) — v1 scope: official upstream
# llama.cpp only (not TurboQuant/vLLM/other forks/engines). "Official llama.cpp" on
# an NVIDIA Linux box means the **Vulkan** build, not CUDA: upstream llama.cpp
# publishes no Linux CUDA prebuilt at all (turbollm/src/engines/download.ts), so
# TurboLLM's own auto-recommendation (ADR-025) picks Vulkan for NVIDIA-on-Linux. This
# base image is still an NVIDIA CUDA one (matches RunPod's own official-template
# convention and keeps the door open for CUDA-needing engines like vLLM later) — but
# it needs the Vulkan loader added explicitly, since Vulkan and CUDA are unrelated
# APIs and the CUDA runtime image doesn't include one.
#
# Runtime-only base (not -devel/full toolkit): this image RUNS a prebuilt binary, it
# never compiles anything.
FROM nvidia/cuda:12.6.3-runtime-ubuntu22.04

# Node >= 22 (TurboLLM's own requirement) via NodeSource — Ubuntu 22.04's apt-default
# Node is far too old. libvulkan1 is the Vulkan loader the Vulkan backend needs (the
# NVIDIA Vulkan ICD itself comes from the driver RunPod's container runtime mounts in
# at pod start, not from anything installed here); libgomp1 (GNU OpenMP) is a real
# runtime dependency of the llama.cpp binaries themselves — without it the server
# fails to even start ("error while loading shared libraries: libgomp.so.1"),
# caught by actually building and running this image locally before shipping it.
# tini (Ubuntu jammy universe, installed at build time) is the container's PID 1:
# see the ENTRYPOINT below.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates libvulkan1 libgomp1 tini \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g turbollm

# npm treats a failed fetch of an optional dependency as a warning, so an install that missed the native core
# (@turbollm/core-linux-x64-gnu) still succeeds, and every pod would then stop with exit 69 at start. Load it here
# instead and fail the build (rust-core plan T23d, QA PG-10). The global install is not on require's search path,
# hence the require rooted at $(npm root -g)/turbollm.
RUN turbollm --version \
  && node -e "const r=require('module').createRequire(process.argv[1]);const p=r.resolve('@turbollm/core-linux-x64-gnu');const m={exports:{}};process.dlopen(m,p);console.log('core',m.exports.coreInfo().version)" "$(npm root -g)/turbollm/package.json"

# Pre-bake the Vulkan engine (TurboLLM's own first-run seed, ADR-024/025) into the
# image so a per-hour-billed pod doesn't eat that download on its first request.
# TURBOLLM_SEED_BACKEND forces Vulkan rather than trusting the seed's live GPU
# detection: `docker build` never has GPU passthrough (true on any machine, not just
# this one), so live detection here would always see "no GPU" and pre-bake the CPU
# backend instead — silently defeating the whole point on hardware this image is
# explicitly built for. Caught by actually running this build and reading its output,
# not assumed. Still reuses the real startup path (start the daemon, wait for it to
# self-seed, stop it) rather than reaching into TurboLLM's internals directly.
ENV TURBOLLM_SEED_BACKEND=vulkan
RUN (turbollm --no-open --port 6996 &) \
    && for i in $(seq 1 60); do \
      node -e "process.exit((()=>{try{return JSON.parse(require('fs').readFileSync(process.env.HOME+'/.turbollm/config.json','utf8')).engines.length>0}catch{return false}})()?0:1)" && break; \
      sleep 3; \
    done \
    && turbollm --stop || true

# Kept only as a secondary/debug path — see README: RunPod's own HTTP proxy has a
# ~100s idle/response timeout that risks 524s on slow prefill/cold model loads, so
# --tunnel (cloudflared) is the primary, reliable access method (ENTRYPOINT below).
# Docker's EXPOSE only takes tcp/udp (not RunPod's own "6996/http" template-port
# notation, which belongs in the RunPod Template's ports config, not here).
EXPOSE 6996/tcp

# tini is PID 1: it reaps every orphan TurboLLM leaves (each tethered child's watcher is
# one, and on a GPU pod the usage monitor's nvidia-smi poll makes one a second while the
# UI is open) and forwards `docker stop`'s SIGTERM to the daemon, which shuts down
# gracefully. With `npx` as PID 1 every one of them stayed a zombie, and under a pids
# limit TurboLLM could no longer start a process. -s: tini is a subreaper when it is not
# PID 1 itself (docker run --init). The daemon warns at boot when nothing reaps them
# (turbollm/src/util/pid1.ts). `turbollm` is the bin `npm install -g` put on PATH above
# (the seeding step runs it too): no npm and sh layers between tini and the daemon.
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "turbollm", "--tunnel", "--no-open"]
