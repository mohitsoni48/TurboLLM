#!/usr/bin/env python3
"""Upload the built CUDA engine bundle to a HuggingFace repo so future runs (and other
people) reuse it instead of recompiling for ~40 min.

The HF *write* token is read from a Kaggle Secret named HF_TOKEN (Add-ons -> Secrets),
so it never appears in this code, in the notebook, or in any output. Falls back to the
HF_TOKEN environment variable off-Kaggle.

  python3 deploy/kaggle/publish_hf.py <hf-owner>/turboquant-cuda-t4
"""
import os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.environ.get("KAGGLE_WORKING", "/kaggle/working")
TARBALL = os.path.join(WORK, "turboquant-cuda-t4.tar.gz")


def get_token():
    try:
        from kaggle_secrets import UserSecretsClient
        return UserSecretsClient().get_secret("HF_TOKEN")
    except Exception:
        return os.environ.get("HF_TOKEN")


def main():
    if len(sys.argv) < 2 or "/" not in sys.argv[1]:
        print("usage: publish_hf.py <owner>/<repo>   (e.g. yourname/turboquant-cuda-t4)", file=sys.stderr)
        sys.exit(2)
    repo = sys.argv[1]

    if not os.path.exists(TARBALL):
        print("Bundle not found — building it with publish_engine.sh …")
        subprocess.run(["bash", os.path.join(HERE, "publish_engine.sh")], check=True)

    token = get_token()
    if not token:
        print("No HF token found. Add a Kaggle Secret named HF_TOKEN (Add-ons -> Secrets) "
              "holding an HF *write* token, then re-run.", file=sys.stderr)
        sys.exit(1)

    try:
        from huggingface_hub import HfApi, create_repo
    except Exception:
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", "huggingface_hub"], check=True)
        from huggingface_hub import HfApi, create_repo

    create_repo(repo, repo_type="model", exist_ok=True, token=token)
    print(f"Uploading {TARBALL} ({os.path.getsize(TARBALL)//(1024*1024)} MB) -> {repo} …")
    HfApi().upload_file(
        path_or_fileobj=TARBALL,
        path_in_repo="turboquant-cuda-t4.tar.gz",
        repo_id=repo,
        token=token,
    )
    url = f"https://huggingface.co/{repo}/resolve/main/turboquant-cuda-t4.tar.gz"
    print("\nUploaded. Future runs skip the build with:")
    print(f"  TURBOLLM_ENGINE_URL={url} bash deploy/kaggle/setup.sh")


if __name__ == "__main__":
    main()
