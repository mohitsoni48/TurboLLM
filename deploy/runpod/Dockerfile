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
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates libvulkan1 libgomp1 \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g turbollm

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

ENTRYPOINT ["npx", "turbollm", "--tunnel", "--no-open"]
