#!/usr/bin/env python3
"""Auto-tune vs chat tok/s — the core dual-GPU investigation.

Reproduces the consumer complaint ("chat is much slower than the tok/s auto-tune
reported") end-to-end against a running TurboLLM daemon:

  1. run the built-in auto-tune (POST /api/v1/bench) and capture the winner's tok/s
  2. save the winner as the model's profile (POST /api/v1/bench/save)
  3. load that model for chat (POST /api/v1/engine/start)
  4. measure REAL streaming decode tok/s the way the chat UI does
  5. sample nvidia-smi across the stream → confirm BOTH T4s are actually used
  6. diff winner.params vs the profile chat actually loaded — the usual culprit

Stdlib only (urllib) so it runs on Kaggle with no pip install.

  python3 deploy/kaggle/bench_vs_chat.py [--model KEY] [--ctx N] [--base URL]
"""
import argparse, json, subprocess, sys, threading, time, urllib.request, urllib.error

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

def fmt_params(p):
    if not p: return "(none)"
    ngl = "fit" if p.get("nglFit") else p.get("ngl")
    ncm = "fit" if p.get("nCpuMoeFit") else p.get("nCpuMoe")
    return (f"ctx={p.get('ctx')} ngl={ngl} nCpuMoe={ncm} parallel={p.get('parallel')} "
            f"kvTypeK={p.get('kvTypeK')} flashAttn={p.get('flashAttn')}")

def run_bench(base, model_key, ctx):
    body = {"modelKey": model_key}
    if ctx:
        body["base"] = {"ctx": ctx}
    print(f"\n== Auto-tune (POST /api/v1/bench) modelKey={model_key} "
          f"{'ctx='+str(ctx) if ctx else '(default ctx)'} ==", flush=True)
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

def measure_chat(base, model_key, prompt, max_tokens):
    """Streaming /v1/chat/completions. Returns (ttft_ms, decode_tps, n_tokens, gpu_peaks)."""
    peaks, stop = {}, threading.Event()
    def sampler():
        while not stop.is_set():
            for g in gpus_snapshot():
                p = peaks.setdefault(g["gpu"], {"mem_mb": 0, "util": 0})
                p["mem_mb"] = max(p["mem_mb"], g["mem_mb"])
                p["util"] = max(p["util"], g["util"])
            stop.wait(0.25)
    body = {"model": model_key, "stream": True, "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": prompt}]}
    req = urllib.request.Request(base + "/v1/chat/completions",
                                 data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json"})
    t0 = time.time(); t_first = None; n = 0
    th = threading.Thread(target=sampler, daemon=True); th.start()
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            for raw in r:
                line = raw.decode("utf-8", "ignore").strip()
                if not line.startswith("data:"): continue
                payload = line[5:].strip()
                if payload == "[DONE]": break
                try:
                    delta = json.loads(payload)["choices"][0].get("delta", {})
                except Exception:
                    continue
                if delta.get("content"):
                    if t_first is None: t_first = time.time()
                    n += 1
    finally:
        stop.set(); th.join(timeout=1)
    t_end = time.time()
    ttft_ms = (t_first - t0) * 1000 if t_first else None
    decode_tps = (n - 1) / (t_end - t_first) if (t_first and n > 1) else None
    return ttft_ms, decode_tps, n, peaks

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:6996")
    ap.add_argument("--model", default=None, help="model key (default: first GGUF)")
    ap.add_argument("--ctx", type=int, default=0, help="fix context for bench+chat (0=daemon default)")
    ap.add_argument("--max-tokens", type=int, default=200)
    args = ap.parse_args()
    B = args.base.rstrip("/")

    def size_of(m):
        s = m.get("sizeBytes")
        if isinstance(s, (int, float)) and s:
            return s
        try:  # model keys look like "qwen3.6-27b|Q4_K_M|<sizeBytes>"
            return int(str(m.get("key", "")).split("|")[-1])
        except Exception:
            return 0
    models = call(B, "/api/v1/models").get("models", [])
    ggufs = [m for m in models if m.get("format") == "gguf" and not m.get("incomplete")]
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
    for _ in range(120):
        stt = call(B, "/api/v1/status").get("engine", {})
        if stt.get("state") == "running": break
        if stt.get("state") == "error":
            print(f"  engine load error: {stt.get('error')}", file=sys.stderr); sys.exit(1)
        time.sleep(2)

    prompt = ("Write a detailed, step-by-step explanation of how a transformer "
              "language model generates text, from tokenization to sampling.")
    # warm-up (loads KV / caches) then the measured run
    measure_chat(B, key, "Say hello.", 16)
    ttft_ms, decode_tps, n, peaks = measure_chat(B, key, prompt, args.max_tokens)

    print("\n" + "=" * 64)
    print("RESULT — auto-tune vs chat")
    print("=" * 64)
    print(f"  auto-tune decode tps : {winner['tps']:.1f}")
    print(f"  chat      decode tps : {decode_tps:.1f}" if decode_tps else "  chat decode tps: n/a")
    if decode_tps and winner['tps']:
        print(f"  chat / auto-tune     : {decode_tps/winner['tps']*100:.0f}%   "
              f"(TTFT {ttft_ms:.0f} ms, {n} tokens)")
    print(f"\n  winner params : {fmt_params(winner['params'])}")
    print(f"  loaded params : {fmt_params(loaded)}")
    same = fmt_params(winner['params']) == fmt_params(loaded)
    print(f"  configs match : {'YES' if same else 'NO  <-- mismatch is the likely cause'}")
    print("\n  per-GPU peak during chat (both should be non-zero on a dual-GPU load):")
    for gpu in sorted(peaks):
        print(f"    GPU {gpu}: mem {peaks[gpu]['mem_mb']} MiB, util {peaks[gpu]['util']}%")
    print("=" * 64)

if __name__ == "__main__":
    main()
