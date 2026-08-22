/** Qualified remote model id: `<machine>/<modelKey>` (ADR-376 §1 decision 7).
 *
 *  Local ids are UNCHANGED — no migration, nothing renamed — so the qualifier is the
 *  only signal that a request is remote. Split on the FIRST slash only: model keys
 *  routinely contain slashes (`unsloth/Qwen3-35B-GGUF/Q4_K_M.gguf`), and a naive
 *  split('/') would mangle every Hugging Face model in the catalog. */
export function formatRemoteId(machineName: string, modelKey: string): string {
  return `${machineName}/${modelKey}`
}

export function parseRemoteId(id: string): { machine: string; model: string } | null {
  const i = id.indexOf('/')
  if (i <= 0) return null            // no slash, or a leading slash
  const machine = id.slice(0, i)
  const model = id.slice(i + 1)
  if (!machine || !model) return null // trailing slash
  return { machine, model }
}

export function isQualifiedId(id: string): boolean {
  return parseRemoteId(id) !== null
}
