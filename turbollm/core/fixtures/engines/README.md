# Engine test models

The real-native engine tests load two small public models. Neither is committed: CI downloads each one by its
pinned commit into `actions/cache` and checks the sha256 below; a local run points the environment at a copy on disk.

| File | Hugging Face repo | Commit | Size (bytes) | sha256 |
|---|---|---|---|---|
| `Qwen3-0.6B-Q4_K_M.gguf` | `unsloth/Qwen3-0.6B-GGUF` | `50968a4468ef4233ed78cd7c3de230dd1d61a56b` | 396705472 | `ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a` |
| `Qwen3-0.6B.litertlm` | `litert-community/Qwen3-0.6B` | `8d42ab5f1db14cad987fac57aeb17d070f9e180d` | 613722264 | `c5f39b4191926786c3e6668b62af4d6eb15248dfc7a5348252a9b406f33f2108` |

Download URL: `https://huggingface.co/<repo>/resolve/<commit>/<file>`. Both repos are ungated. The commits are the
repos' `sha` from `https://huggingface.co/api/models/<repo>` on 2026-11-24; at each commit the file's LFS oid and
size (`/api/models/<repo>/paths-info/<commit>`) equal the values above, which are also the sha256 of the copies the
Android SDK's instrumented tests used.

## Where the tests find them

| Test | Model | Library |
|---|---|---|
| Rust, `turbollm-engine-llama` (`tests/abi_smoke.rs`, `tests/real_llama.rs`) | env `TURBOLLM_TEST_GGUF` | env `TURBOLLM_LLAMA_LIB_DIR` (the folder `cargo xtask build-llama --host` writes, `core/target/llama/<host-triple>/`; a relative path is read from `core/`) |
| Rust, LiteRT-LM | env `TURBOLLM_TEST_LITERTLM` | env `TURBOLLM_LITERT_LIB` |
| Android instrumented tests | instrumentation arg `turbollmTestGguf` | packaged in the APK |
| Android instrumented tests | instrumentation arg `turbollmTestLitertlm` | packaged in the APK |

Without the environment the Rust tests print why they skipped, except when `CI=true`, where a missing variable fails
the test. Run the real-native tests one at a time against the model:

```
cargo test -p turbollm-engine-llama --test real_llama -- --test-threads=1
```
