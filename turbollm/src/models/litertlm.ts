// LiteRT-LM models in the library. A `.litertlm` file is one self-contained bundle (weights, tokenizer, and for
// multimodal models the vision/audio encoders) that Google's LiteRT-LM runtime loads directly, so the library holds it
// the way it holds a GGUF: one file, one entry, deleted as a file. Unlike a GGUF it carries no header TurboLLM can read
// cheaply (the metadata is a FlatBuffer), so the entry is built from the file name and the 8-byte magic.
import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ModelEntry } from './scanner'

/** The first 8 bytes of every LiteRT-LM file (litert_lm_builder's HEADER_MAGIC_BYTES). */
const MAGIC = 'LITERTLM'

/** Unlike a GGUF a .litertlm can be tiny (small test bundles), so only the magic below gates it, not a size floor. */
export function isLitertlmFileName(name: string): boolean {
  return name.toLowerCase().endsWith('.litertlm')
}

/** True when the file really is a LiteRT-LM bundle — keeps a renamed HTML error page or a truncated download out of
 *  the library, where it would otherwise fail at load time with a native-runtime message. */
export async function hasLitertlmMagic(path: string): Promise<boolean> {
  let fh: Awaited<ReturnType<typeof open>> | null = null
  try {
    fh = await open(path, 'r')
    const head = Buffer.alloc(MAGIC.length)
    const { bytesRead } = await fh.read(head, 0, MAGIC.length, 0)
    return bytesRead === MAGIC.length && head.toString('latin1') === MAGIC
  } catch {
    return false
  } finally {
    await fh?.close().catch(() => {})
  }
}

// litert-community names its files by precision (`-int4`, `_q8`, `-fp16`). Anchored on separators, and the last match
// wins, for the same reason quantFromName's does (a model name can contain a number-letter run of its own).
const QUANT_RE = /(?:^|[-_. ])(int[248]|fp16|f16|fp32|bf16|q[48])(?=$|[-_. ])/gi

/** The precision label from the file name, '?' when it states none. */
export function litertlmQuantFromName(fileName: string): string {
  const matches = [...fileName.matchAll(QUANT_RE)]
  return matches.length > 0 ? matches[matches.length - 1][1].toUpperCase() : '?'
}

/** `ekv4096` in a litert-community name is the KV-cache length the bundle was exported with, which is the longest
 *  context the runtime can give it — the nearest thing to a native context the file name declares. 0 = not declared. */
export function litertlmNativeCtxFromName(fileName: string): number {
  const m = /(?:^|[-_. ])ekv(\d{3,6})(?=$|[-_. ])/i.exec(fileName)
  return m ? Number(m[1]) : 0
}

function cleanName(fileName: string): string {
  return fileName
    .replace(/\.litertlm$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The library entry for a `.litertlm` file. Its format is 'litertlm' (a single file, deleted as a file); compat.ts
 *  gives it to the LiteRT-LM engine and to no other. Vision/audio stay false: the bundle declares them only in the
 *  FlatBuffer header, and claiming a capability the file may lack would put an image button on a text-only model. */
export function litertlmEntryFor(path: string, dir: string, sizeBytes: number, mtimeMs: number): ModelEntry {
  const fileName = basename(path)
  const name = cleanName(fileName)
  const quant = litertlmQuantFromName(fileName)
  return {
    key: `${name.toLowerCase()}|${quant}|${sizeBytes}`,
    name,
    path,
    dir,
    format: 'litertlm',
    sizeBytes,
    sizeLabel: '',
    arch: 'litertlm',
    quant,
    nativeCtx: litertlmNativeCtxFromName(fileName),
    blockCount: 0,
    headCountKv: 0,
    headDim: 0,
    moe: false,
    expertCount: 0,
    nextnLayers: 0,
    vision: false,
    audio: false,
    mmprojPath: null,
    mmprojSizeBytes: 0,
    hasChatTemplate: true, // the bundle embeds its own template; the runtime applies it
    reasoningEffort: false,
    embedding: false,
    incomplete: sizeBytes === 0,
    parseError: null,
    loaded: false,
    hasProfile: false,
    benchTps: null,
    mtime: new Date(mtimeMs || Date.now()).toISOString(),
  }
}
