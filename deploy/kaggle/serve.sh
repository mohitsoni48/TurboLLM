#!/usr/bin/env bash
# Run the TurboLLM daemon from source (tsx) on Kaggle + register/activate the native
# CUDA TurboQuant engine + open a public cloudflared tunnel to the web GUI.
#
#   bash deploy/kaggle/serve.sh start     # (re)start daemon, register engine, print URL+token
#   bash deploy/kaggle/serve.sh stop
#   bash deploy/kaggle/serve.sh restart   # after a `git pull` + `npm run build:web`
#   bash deploy/kaggle/serve.sh status
#
# Loopback API calls need no key (auth bypasses loopback); only the public tunnel URL
# does — that Token is printed on start.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TLLM_DIR="$REPO_DIR/turbollm"
WORK="${KAGGLE_WORKING:-/kaggle/working}"
ENGINE_BIN="$WORK/turboquant/build/bin/llama-server"
ENGINE_DIR="$(dirname "$ENGINE_BIN")"
MODELS_DIR="$WORK/models"
TQ_REPO="https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant"
PORT="${TURBOLLM_PORT:-6996}"
BASE="http://localhost:$PORT"
LOG="$WORK/turbollm-daemon.log"

# The engine binary and the daemon's spawned llama-server both need the bundled CUDA
# runtime libs next to the binary on the loader path.
export LD_LIBRARY_PATH="$ENGINE_DIR:${LD_LIBRARY_PATH:-}"

log() { echo -e "\n\033[1;36m== $* ==\033[0m"; }

stop_daemon() {
  log "Stopping daemon"
  ( cd "$TLLM_DIR" && node_modules/.bin/tsx src/cli.ts --stop --port "$PORT" ) 2>/dev/null || true
  # Fallback: kill whatever still holds the port (a source-run daemon writes its own
  # pidfile so --stop usually suffices, but never leave a public tunnel dangling).
  local pid
  pid="$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)"
  [ -n "${pid:-}" ] && { echo "force-killing pid $pid on :$PORT"; kill -9 "$pid" 2>/dev/null || true; }
}

start_daemon() {
  [ -x "$ENGINE_BIN" ] || { echo "Engine binary missing ($ENGINE_BIN) — run setup.sh first" >&2; exit 1; }
  stop_daemon
  log "Starting daemon (source, tsx) on :$PORT with a public tunnel"
  : > "$LOG"
  # setsid detaches the daemon into its own session so it survives this script + the
  # notebook cell returning. Real backgrounding lives inside this bash script, so Jupyter's
  # "no background processes" block on `!cmd &` doesn't apply.
  ( cd "$TLLM_DIR" && setsid nohup node_modules/.bin/tsx src/cli.ts \
      --port "$PORT" --tunnel --no-open >>"$LOG" 2>&1 < /dev/null & )

  log "Waiting for daemon to become ready"
  for _ in $(seq 1 60); do
    if curl -sf "$BASE/api/v1/status" >/dev/null 2>&1; then break; fi
    sleep 2
  done
  curl -sf "$BASE/api/v1/status" >/dev/null 2>&1 || { echo "daemon did not come up — tail of $LOG:"; tail -30 "$LOG"; exit 1; }

  register_engine
  print_access
}

register_engine() {
  log "Registering model dir + CUDA engine (idempotent)"
  curl -s -X POST "$BASE/api/v1/modeldirs" -H 'content-type: application/json' \
    -d "{\"path\":\"$MODELS_DIR\"}" >/dev/null || true
  # Add the engine; if the name/binary is already registered, fall back to looking it up
  # by binPath. Either way we end with its id and activate it.
  local add id
  add="$(curl -s -X POST "$BASE/api/v1/engines" -H 'content-type: application/json' \
    -d "{\"name\":\"TurboQuant CUDA (T4)\",\"binPath\":\"$ENGINE_BIN\",\"sourceRepo\":\"$TQ_REPO\"}")"
  id="$(BIN="$ENGINE_BIN" node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{const j=JSON.parse(s);if(j&&j.id)return console.log(j.id)}catch{}
      process.exit(1)
    })' <<<"$add" 2>/dev/null)"
  if [ -z "${id:-}" ]; then
    id="$(BIN="$ENGINE_BIN" BASE="$BASE" node -e '
      (async()=>{const r=await fetch(process.env.BASE+"/api/v1/engines");const j=await r.json();
        const e=(j.engines||[]).find(e=>e.binPath===process.env.BIN);if(e)console.log(e.id);else process.exit(1)})()
      ' 2>/dev/null)"
  fi
  [ -z "${id:-}" ] && { echo "could not register/find the CUDA engine. add-response was:"; echo "$add"; return 1; }
  curl -s -X POST "$BASE/api/v1/engines/$id/activate" >/dev/null || true
  echo "active engine id: $id"
}

print_access() {
  log "Public access"
  grep -iE 'trycloudflare\.com|Token:|https://' "$LOG" | tail -8 || true
  echo
  echo "Local API base (from inside this notebook, no key needed): $BASE"
  echo "Daemon log: $LOG"
}

case "${1:-start}" in
  start)   start_daemon ;;
  stop)    stop_daemon ;;
  restart) start_daemon ;;
  status)  curl -s "$BASE/api/v1/status" | (node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.stringify(JSON.parse(s),null,2))}catch{console.log(s)}})' 2>/dev/null || cat) ;;
  *) echo "usage: serve.sh [start|stop|restart|status]" >&2; exit 2 ;;
esac
