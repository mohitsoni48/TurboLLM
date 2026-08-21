#!/usr/bin/env python3
"""Auto-tune vs chat tok/s — the core dual-GPU investigation.

Reproduces the consumer complaint ("chat is much slower than the tok/s auto-tune
reported") end-to-end against a running TurboLLM daemon:

  1. run the built-in auto-tune (POST /api/v1/bench) and capture the winner's tok/s
  2. save the winner as the model's profile (POST /api/v1/bench/save)
  3. load that model for chat (POST /api/v1/engine/start)
  4. measure REAL decode tok/s at the SAME depth the tuner used, on both the engine
     and the daemon, so the numbers are actually comparable
  5. sample nvidia-smi across the stream → confirm BOTH T4s are actually used
  6. diff winner.params vs the profile chat actually loaded

MEASURING THIS HONESTLY IS THE POINT, and the obvious way to do it is wrong. Auto-tune
does not time a short "hello": bench.ts builds the real Default-agent system prompt plus
filler turns out to ~0.75x ctx (capped at BENCH_MAX_PROMPT_TOKENS = 32k), generates 128
tokens from THAT depth, talks to the engine's own port, and reports llama.cpp's
`timings.predicted_per_second`. That design is deliberate — it was validated to track
real chat within ~5% at 22k depth.

So the comparison is only fair when depth, endpoint and transport are held fixed. This
script measures three legs and prints the delta between them, which is what turns "chat
is slower" into an attributable number:

  B  engine, non-streaming, 128 tok   → reproduces what auto-tune reported
  C  engine, streaming                → adds streaming + wall-clock timing
  D  daemon, streaming                → adds the daemon's proxy hop (what a user gets)

An earlier version of this script passed --ctx 8192 and timed a ~30-token prompt against
the daemon. That compared a 6k-deep bench against a near-zero-depth chat on a different
endpoint, and the resulting "chat is 45% of auto-tune" was an artifact of the harness,
not a property of the product.

Stdlib only (urllib) so it runs on Kaggle with no pip install.

  python3 deploy/kaggle/bench_vs_chat.py [--model KEY] [--ctx N] [--base URL]
"""
import argparse, json, subprocess, sys, threading, time, urllib.request, urllib.error

# Mirrors bench.ts — keep in sync with BENCH_CTX_FRACTION / BENCH_MAX_PROMPT_TOKENS / CHARS_PER_TOKEN.
BENCH_CTX_FRACTION = 0.75
BENCH_MAX_PROMPT_TOKENS = 32_000
CHARS_PER_TOKEN = 4

def bench_prompt_tokens(ctx):
    """benchPromptTokens() from bench.ts: 0.75x ctx, capped at 32k, floored at 256."""
    return max(256, min(BENCH_MAX_PROMPT_TOKENS, int(ctx * BENCH_CTX_FRACTION)))

FILLER_TOPICS = [
    "database indexing", "message queues", "caching strategies", "load balancing",
    "container orchestration", "observability", "schema migrations", "rate limiting",
]
QUESTION = ("Write a detailed, step-by-step explanation of how a transformer "
            "language model generates text, from tokenization to sampling.")

def build_deep_messages(ctx):
    """Filler conversation padded to the depth auto-tune benches at, so the chat legs run
    against a comparably-filled KV cache instead of an empty one."""
    target_chars = bench_prompt_tokens(ctx) * CHARS_PER_TOKEN
    system = ("You are a helpful assistant. Answer accurately and concisely, and say when "
              "you are unsure rather than guessing.")
    msgs = [{"role": "system", "content": system}]
    chars = len(system)
    rnd = 0
    while chars < target_chars:
        topic = FILLER_TOPICS[rnd % len(FILLER_TOPICS)]
        q = f"Can you explain {topic}?"
        a = (f"Regarding {topic} (pass {rnd // len(FILLER_TOPICS) + 1}), the underlying tradeoffs "
             "depend heavily on the specific workload, the scale of the system, and the operational "
             "constraints the team is working under, which is why experienced engineers tend to "
             "reach for established patterns before inventing something bespoke. ") * 3
        msgs.append({"role": "user", "content": q})
        msgs.append({"role": "assistant", "content": a})
        chars += len(q) + len(a)
        rnd += 1
    msgs.append({"role": "user", "content": QUESTION})
    return msgs

def call(base, path, method="GET", body=None, timeout=1200):
    url = base + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode()
    return json.loads(raw) if raw.strip() else {}

def gpus_snapshot():
    """Per-GPU (index, mem_used_MiB, util_%) via nvidia-smi; [] if unavailable."""
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=index,memory.used,utilization.gpu",
             "--format=csv,noheader,nounits"], text=True, timeout=10)
    except Exception:
        return []
    rows = []
    for line in out.strip().splitlines():
        idx, mem, util = (x.strip() for x in line.split(","))
        rows.append({"gpu": int(idx), "mem_mb": int(mem), "util": int(util)})
    return rows

def fmt_gpu(g):
    """The split strategy, spelled out. Omitting this made `configs match` a lie: bench and chat
    can pick DIFFERENT splitMode/mainGpu for the same ctx/ngl/nCpuMoe and still compare equal,
    which hides the very mismatch this script exists to catch."""
    if not g: return "split=(none reported)"
    ts = g.get("tensorSplit") or []
    return (f"split={g.get('splitMode')} mainGpu={g.get('mainGpu')}"
            + (f" tensorSplit={ts}" if ts else ""))

def fmt_params(p):
    if not p: return "(none)"
    ngl = "fit" if p.get("nglFit") else p.get("ngl")
    ncm = "fit" if p.get("nCpuMoeFit") else p.get("nCpuMoe")
    return (f"ctx={p.get('ctx')} ngl={ngl} nCpuMoe={ncm} parallel={p.get('parallel')} "
            f"kvTypeK={p.get('kvTypeK')} flashAttn={p.get('flashAttn')} {fmt_gpu(p.get('gpu'))}")

def ensure_idle(base, timeout=90):
    """Auto-tune 409s while a model is loaded or a bench is running (single-server guard). Clear
    both, then POLL until the engine is actually stopped."""
    def state():
        try:
            s = call(base, "/api/v1/status")
        except Exception:
            return None, None
        return (s.get("engine") or {}).get("state"), (s.get("bench") or {}).get("running")
    eng, bench = state()
    if eng in (None, "stopped", "idle", "") and not bench:
        return
    print(f"Engine busy (state={eng}, bench={bench}) — stopping it before auto-tune…", flush=True)
    for path in ("/api/v1/bench/cancel", "/api/v1/engine/stop"):
        try: call(base, path, "POST")
        except Exception: pass
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(2)
        eng, bench = state()
        if eng in (None, "stopped", "idle", "") and not bench:
            print(f"  engine now {eng!r}, bench idle — proceeding", flush=True)
            return
    print(f"  warning: engine still {eng!r} after {timeout}s — trying the bench anyway", flush=True)

def run_bench(base, model_key, ctx):
    body = {"modelKey": model_key}
    if ctx:
        body["base"] = {"ctx": ctx}
    print(f"\n== Auto-tune (POST /api/v1/bench) modelKey={model_key} "
          f"{'ctx='+str(ctx)+' (FORCED)' if ctx else '(model default ctx)'} ==", flush=True)
    call(base, "/api/v1/bench", "POST", body)
    last = ""
    while True:
        time.sleep(3)
        st = call(base, "/api/v1/status").get("bench", {}) or {}
        step = st.get("step", "")
        best = st.get("bestTps")
        line = f"  running={st.get('running')} step={step!r} bestTps={best}"
        if line != last:
            print(line, flush=True); last = line
        if not st.get("running") and (st.get("done") or st.get("error")):
            if st.get("error"):
                print(f"  bench error: {st['error']}", flush=True)
            break
    log = call(base, "/api/v1/bench/log")
    return log.get("winner")

def measure_nonstream(base, model_key, messages, max_tokens):
    """The engine's OWN decode rate — exactly what auto-tune records (bench.ts reads
    timings.predicted_per_second off a non-streaming request with temp 0 / seed 42 /
    cache_prompt false)."""
    body = {"model": model_key, "stream": False, "max_tokens": max_tokens, "temperature": 0,
            "seed": 42, "cache_prompt": False, "messages": messages}
    req = urllib.request.Request(base + "/v1/chat/completions", data=json.dumps(body).encode(),
                                 method="POST", headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=1800) as r:
        d = json.loads(r.read().decode())
    t = d.get("timings") or {}
    return t.get("predicted_per_second"), t.get("prompt_per_second"), t.get("prompt_ms")

def measure_stream(base, model_key, messages, max_tokens, sample_gpus=False):
    """Wall-clock decode tok/s off the SSE stream — what a user actually experiences.
    Returns (ttft_ms, decode_tps, n_tokens, gpu_peaks)."""
    peaks, stop = {}, threading.Event()
    def sampler():
        while not stop.is_set():
            for g in gpus_snapshot():
                p = peaks.setdefault(g["gpu"], {"mem_mb": 0, "util": 0})
                p["mem_mb"] = max(p["mem_mb"], g["mem_mb"])
                p["util"] = max(p["util"], g["util"])
            stop.wait(0.25)
    body = {"model": model_key, "stream": True, "max_tokens": max_tokens, "messages": messages}
    req = urllib.request.Request(base + "/v1/chat/completions",
                                 data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json"})
    t0 = time.time(); t_first = None; n = 0
    th = None
    if sample_gpus:
        th = threading.Thread(target=sampler, daemon=True); th.start()
    try:
        with urllib.request.urlopen(req, timeout=1800) as r:
            for raw in r:
                line = raw.decode("utf-8", "ignore").strip()
                if not line.startswith("data:"): continue
                payload = line[5:].strip()
                if payload == "[DONE]": break
                try:
                    delta = json.loads(payload)["choices"][0].get("delta", {})
                except Exception:
                    continue
                # Count decoded tokens on EITHER channel: a reasoning model (Qwen3.6, Gemma-4)
                # streams its thinking as `reasoning_content` and only the final answer as
                # `content`. Decode throughput is the same rate regardless of channel.
                if delta.get("content") or delta.get("reasoning_content"):
                    if t_first is None: t_first = time.time()
                    n += 1
    finally:
        stop.set()
        if th: th.join(timeout=1)
    t_end = time.time()
    ttft_ms = (t_first - t0) * 1000 if t_first else None
    decode_tps = (n - 1) / (t_end - t_first) if (t_first and n > 1) else None
    return ttft_ms, decode_tps, n, peaks

def rel(a, b):
    return f"{a / b * 100:.0f}%" if (a and b) else "n/a"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:6996")
    ap.add_argument("--model", default=None, help="model key (default: first GGUF)")
    ap.add_argument("--ctx", type=int, default=0,
                    help="force a context for bench+chat. DEFAULT 0 = the model's own ctx, which is "
                         "what you want: auto-tune sizes its bench prompt at 0.75x ctx (capped at "
                         "32k), so forcing a small ctx benches at a shallow depth the design "
                         "deliberately avoids, and inflates the reported tok/s.")
    ap.add_argument("--max-tokens", type=int, default=200)
    args = ap.parse_args()
    B = args.base.rstrip("/")
    if args.ctx and args.ctx < 16384:
        print(f"WARNING: --ctx {args.ctx} benches at ~{bench_prompt_tokens(args.ctx)} tokens of depth. "
              f"Auto-tune is designed around ~0.75x ctx capped at {BENCH_MAX_PROMPT_TOKENS}; a shallow "
              f"depth reports an optimistic tok/s that real chat will not reproduce.\n", flush=True)

    def size_of(m):
        s = m.get("sizeBytes")
        if isinstance(s, (int, float)) and s:
            return s
        try:  # model keys look like "qwen3.6-27b|Q4_K_M|<sizeBytes>"
            return int(str(m.get("key", "")).split("|")[-1])
        except Exception:
            return 0
    def list_ggufs():
        ms = call(B, "/api/v1/models").get("models", [])
        return [m for m in ms if m.get("format") == "gguf" and not m.get("incomplete")]
    ggufs = list_ggufs()
    if not ggufs:
        print("No models yet — rescanning model dirs…")
        try: call(B, "/api/v1/models/rescan", "POST")
        except Exception: pass
        for _ in range(30):
            time.sleep(2)
            ggufs = list_ggufs()
            if ggufs:
                break
    if not ggufs:
        print("No complete GGUF models found — register a model dir first.", file=sys.stderr); sys.exit(1)
    ggufs.sort(key=size_of, reverse=True)  # prefer the highest-quant (largest) complete model
    key = args.model or ggufs[0]["key"]
    print(f"Models: {[m['key'] for m in ggufs]}\nUsing model key: {key}")

    print("\n== Hardware (GET /api/v1/sysinfo) ==")
    sys_gpus = call(B, "/api/v1/sysinfo").get("gpus", [])
    for g in sys_gpus:
        print(f"  {g.get('name')}  {round(g.get('vramMb',0)/1024)} GB  vendor={g.get('vendor')}")
    print(f"  -> {len(sys_gpus)} GPU(s) detected")
    eng = call(B, "/api/v1/engines")
    active = next((e for e in eng.get("engines", []) if e.get("id") == eng.get("activeEngineId")), None)
    print(f"  active engine: {active.get('name') if active else '(none)'}")

    ensure_idle(B)
    winner = run_bench(B, key, args.ctx)
    if not winner:
        print("No winner from auto-tune — cannot compare.", file=sys.stderr); sys.exit(1)
    print(f"\n== Auto-tune WINNER ==\n  tps(decode)={winner['tps']}  prefillTps={winner.get('prefillTps')}"
          f"  ttftMs={winner.get('ttftMs')}  vramMb={winner.get('vramMb')}\n  params: {fmt_params(winner['params'])}")

    call(B, "/api/v1/bench/save", "POST")
    loaded = call(B, f"/api/v1/models/{key}").get("profile", {})
    print(f"\n== Saved model profile (what chat will load) ==\n  {fmt_params(loaded)}")

    print("\n== Loading model for chat (POST /api/v1/engine/start) ==", flush=True)
    call(B, "/api/v1/engine/start", "POST", {"modelKey": key})
    engine_port = None
    for _ in range(120):
        stt = call(B, "/api/v1/status").get("engine", {})
        if stt.get("state") == "running":
            engine_port = stt.get("port")
            break
        if stt.get("state") == "error":
            print(f"  engine load error: {stt.get('error')}", file=sys.stderr); sys.exit(1)
        time.sleep(2)

    # Depth has to match what auto-tune benched at or the comparison means nothing.
    ctx = (loaded or {}).get("ctx") or args.ctx or 8192
    depth = bench_prompt_tokens(ctx)
    messages = build_deep_messages(ctx)
    E = f"http://127.0.0.1:{engine_port}" if engine_port else None
    print(f"\n== Comparable-depth chat ==\n  ctx={ctx} → bench prompt depth ~{depth} tokens "
          f"(0.75x ctx, capped at {BENCH_MAX_PROMPT_TOKENS})")
    print(f"  engine: {E or '(port unknown — engine legs skipped)'}   daemon: {B}")

    b_tps = c_tps = d_tps = None
    peaks = {}
    if E:
        print("\n  [B] engine, non-streaming, 128 tok — reproduces auto-tune's own number…", flush=True)
        try:
            b_tps, b_prefill, b_prompt_ms = measure_nonstream(E, key, messages, 128)
            print(f"      {b_tps and round(b_tps,2)} tok/s   (prefill {b_prefill and round(b_prefill)} tok/s, "
                  f"prompt {b_prompt_ms and round(b_prompt_ms)} ms)")
        except Exception as e:
            print(f"      failed: {e}")
        print("\n  [C] engine, streaming — adds streaming + wall-clock timing…", flush=True)
        try:
            _, c_tps, c_n, _ = measure_stream(E, key, messages, args.max_tokens)
            print(f"      {c_tps and round(c_tps,2)} tok/s   ({c_n} tokens)")
        except Exception as e:
            print(f"      failed: {e}")

    print("\n  [D] daemon, streaming — the proxy hop a real user goes through…", flush=True)
    _, d_tps, d_n, peaks = measure_stream(B, key, messages, args.max_tokens, sample_gpus=True)
    print(f"      {d_tps and round(d_tps,2)} tok/s   ({d_n} tokens)")

    print("\n" + "=" * 70)
    print("RESULT — auto-tune vs chat, every leg at the same depth")
    print("=" * 70)
    print(f"  A auto-tune reported          : {winner['tps']:.1f} tok/s")
    if b_tps: print(f"  B engine, non-streaming, 128  : {b_tps:.1f} tok/s   ({rel(b_tps, winner['tps'])} of A — run-to-run)")
    if c_tps: print(f"  C engine, streaming           : {c_tps:.1f} tok/s   ({rel(c_tps, b_tps or winner['tps'])} of B — streaming cost)")
    if d_tps: print(f"  D daemon, streaming           : {d_tps:.1f} tok/s   ({rel(d_tps, c_tps or b_tps or winner['tps'])} of C — daemon proxy cost)")
    if d_tps: print(f"\n  end to end (D vs A)           : {rel(d_tps, winner['tps'])}")
    print(f"\n  winner params : {fmt_params(winner['params'])}")
    print(f"  loaded params : {fmt_params(loaded)}")
    # The winner record carries no gpu block (BenchCandidate.params has no `gpu` field), so the
    # split that actually won is unrecorded and CANNOT be compared against what chat loaded.
    if not (winner['params'] or {}).get('gpu'):
        rest = lambda p: fmt_params(p).rsplit(' split=', 1)[0]
        agree = rest(winner['params']) == rest(loaded)
        print(f"  configs match : {'YES' if agree else 'NO'} on ctx/ngl/nCpuMoe/parallel/kv/flashAttn; "
              f"split UNKNOWN — the bench winner record has no gpu block")
    else:
        same = fmt_params(winner['params']) == fmt_params(loaded)
        print(f"  configs match : {'YES' if same else 'NO  <-- mismatch is the likely cause'}")
    print("\n  per-GPU peak during chat (both should be non-zero on a dual-GPU load):")
    for gpu in sorted(peaks):
        print(f"    GPU {gpu}: mem {peaks[gpu]['mem_mb']} MiB, util {peaks[gpu]['util']}%")
    print("=" * 70)

if __name__ == "__main__":
    main()
