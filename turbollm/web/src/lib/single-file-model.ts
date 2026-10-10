// The single-file model formats the UI treats as directly downloadable — one definition
// for the whole web app, so the import dialog, copy and any future surface can't drift
// apart.

/** A `.gguf` (llama.cpp family) or a `.litertlm` (LiteRT-LM) bundle — the two formats
 *  that are a COMPLETE model in one file, which is what makes a direct URL download
 *  loadable. A bare `.safetensors` is deliberately excluded: without its
 *  config/tokenizer siblings it is a file no engine can load (those models belong to the
 *  repo view, which downloads the whole directory).
 *
 *  This mirrors the daemon's download guard — `SINGLE_FILE_MODEL_RE` in
 *  src/downloads/downloads.ts, also reused by the Turbo Link façade's repo-file check —
 *  so the client never promises a file the server would reject. The two packages are
 *  built separately, so the regex cannot be imported across; instead
 *  single-file-model.test.ts reads the daemon source and FAILS when the definitions
 *  diverge. If you change one, change the other. */
export const SINGLE_FILE_MODEL_RE = /\.(gguf|litertlm)$/i
