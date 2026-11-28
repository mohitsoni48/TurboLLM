"""Prepare the selected GGUF with the pinned Strata release and own its foreground server."""
import hashlib
import os
from pathlib import Path
import subprocess
import sys


def main():
    mode, root, selected, port, context = sys.argv[1:]
    control = Path(root).resolve()
    model = Path(selected).resolve()
    if model.suffix.lower() != ".gguf" or not model.is_file():
        raise ValueError("Select the first GGUF shard of a local DeepSeek V4.1 Flash model.")
    # Never import code from a model folder. All modules below come from the verified control archive.
    sys.path.insert(0, str(control))
    import setup
    from strata_control import models

    plan = models.plan_import(str(model))
    candidate = plan.get("candidate_selection") or {}
    if plan["file_set_status"] != "plausible" or candidate.get("family") != "deepseek41":
        details = plan.get("plain_issues") or plan.get("missing_shards") or []
        raise ValueError("Strata needs a supported DeepSeek V4.1 Flash GGUF set. " + " ".join(details))
    variant = candidate["model"]
    family = setup.MULTI_FILE_FAMILIES["deepseek41"]
    spec = family["models"][variant]
    first_names = {name for shards in (spec["shards"], spec.get("shards6")) if shards
                   for name in (shards[0], setup.DSV41_LEGACY_NAMES.get(shards[0]))}
    if model.name not in first_names:
        raise ValueError("Select the first model shard, not a lookup table or continuation shard.")
    # One preparation directory per library file. The config can start executables, so only ever read our own.
    identity = hashlib.sha256(os.fsencode(model)).hexdigest()
    state = control.parent.parent / "models" / identity
    missing = setup.dsv41_shared_missing(variant, state / "models", model.parent, vision=False)
    if missing:
        raise ValueError("Missing or incomplete Strata companion files: " + ", ".join(name for name, _ in missing))
    if mode == "check":
        return
    state.mkdir(parents=True, exist_ok=True)
    engine = control.parent / "engine" / ("strata-dsv41.exe" if os.name == "nt" else "strata-dsv41")
    if not engine.is_file():
        raise ValueError("The installed Strata engine is missing. Reinstall Strata from Engines.")
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(("STRATA_", "PYTHON"))}
    env.update(STRATA_CONTROL_INSTALL="1", STRATA_INSTALL_DIR=str(state), STRATA_DSV41_EXE=str(engine),
               PYTHONUTF8="1", PYTHONNOUSERSITE="1")
    subprocess.run([sys.executable, str(control / "setup.py"), "--setup", "--yes", "--no-start",
                    "--family", "deepseek41", "--model", variant, "--gguf-dir", str(model.parent),
                    "--data-dir", str(state), "--vision", "no", "--context", context, "--no-browser"],
                   env=env, cwd=control, check=True)
    config = state / ("strata-" + (family["tag"] + variant).lower() + ".json")
    env["STRATA_API_KEY"] = os.environ["STRATA_API_KEY"]
    serve = [sys.executable, str(control / "strata.py"), "serve", "--profile", str(config),
             "--host", "127.0.0.1", "--port", port, "--offline", "--shutdown-timeout", "2"]
    if os.name == "posix":
        os.chdir(control)
        os.execve(sys.executable, serve, env)
    subprocess.run(serve, env=env, cwd=control, check=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.exit(str(error))
