// Per-file download subdirectory for a multi-file (safetensors) model download — Jev
// checkpoints (ADR-434 (h)) and Laya's own nested repo layout share this same rule.
//
// The server stores each queued file at `<subdir>/<basename>` (downloads enqueue.ts). A repo
// whose files sit in more than one directory — Laya ships 'model.safetensors' at the root
// alongside 'encoder/config.json' and 'multilingual/encoder/config.json' — would flatten every
// file to its basename under ONE subdir, so 'encoder/config.json' and
// 'multilingual/encoder/config.json' would both land at '<subdir>/config.json' and overwrite
// each other. Computing the subdir PER FILE from its own repo-relative path keeps the repo's
// folder structure intact underneath the model's own folder.
//
// Pure, so HfRepoDialog's queueInto can call it once per file with no component state.

/** Where one file of a multi-file download lands under the model's own folder.
 *  `filePath` is the file's repo-relative path exactly as the daemon reports it (POSIX '/').
 *  A root-level file (no '/') goes straight into `<repoName>`; a file inside a repo subfolder
 *  keeps that same subfolder under `<repoName>`. */
export function downloadSubdir(repoName: string, filePath: string): string {
  const cut = filePath.lastIndexOf('/')
  return cut === -1 ? repoName : `${repoName}/${filePath.slice(0, cut)}`
}
