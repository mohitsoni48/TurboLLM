// The run_python chat tool (GitHub #52): its definition, the files a run starts with, and what a run hands back.
//
// Who may reach it is decided elsewhere and fails closed: only a live chat turn whose caller may act on the host gets
// a SandboxTurn (chat-routes.ts runGeneration), only a turn with one is offered the tool (tool-registry.ts), and only
// an interactive call with one runs it (execute-with-approval.ts). Every run asks first, with Allow once only
// (tool-policy.ts, and the approve route refuses the standing approvals).
//
// Files in: the images and documents attached to the message this turn answers. Documents arrive as the text the web
// client extracted (ChatScreen.tsx joins them as `[Attached: <name>]\n<text>`), so only text formats go in.
// Files out: PNG and JPEG go to the chat's image store (chat/attachments.ts) and are named on the reply's own row,
// which is what keeps the attachment janitor from collecting them and what frees them when the chat is deleted. CSV,
// JSON, text and Python come back to the model as text until chat files land (PR 3).
import type { ToolDefinition } from '../tools/tool-registry'
import type { AttachmentStore } from '../chat/attachments'
import type { Message } from '../chat/db'
import type { SandboxManager } from './sandbox-manager'
import { SandboxError, RUN_TIMEOUT_MS, type SandboxFile, type SandboxRunResult } from './sandbox-process'

export const RUN_PYTHON = 'run_python'

/** Fixed, never built per chat: a description that changed per chat would break the prompt cache. */
export const RUN_PYTHON_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: RUN_PYTHON,
    description:
      'Run Python 3 code in a sandbox on this computer (Pyodide). numpy, pandas, matplotlib, Pillow and sympy are '
      + 'available. There is no network and no access to the user\'s own files. Files the user attached to their '
      + 'message are in the current folder. To give the user a file, save it to the current folder: png and jpg files '
      + 'are shown in the chat; csv, json, txt and py files come back to you as text. Use print() to see values. '
      + 'Variables and files stay between runs in this chat until it has been idle for 10 minutes. Each run may take '
      + `${RUN_TIMEOUT_MS / 1000} seconds and about 512 MB of memory. The user approves every run before it starts.`,
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'The Python code to run.' } },
      required: ['code'],
    },
  },
}

/** Why run_python did not run on a surface that does not offer it (a model can call a tool it was not offered). */
export const RUN_PYTHON_UNAVAILABLE = 'Error: run_python is only available in a chat on this computer with the Python sandbox switched on (Settings → Experimental).'

const DOCUMENT_TYPES = /\.(csv|tsv|txt|json|jsonl|md|py|xml|ya?ml|log|sql|html?)$/i
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }
const TEXT_BACK_LIMIT = 8 * 1024
const MAX_INPUT_TOTAL = 100 * 1024 * 1024

/** What a chat turn hands the tool: runs code in this chat's sandbox. */
export interface SandboxTurn {
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<{ result: string; files: string[] }>
}

/** A file name the sandbox can take: no folders, nothing outside a plain set of characters. */
export function safeName(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const clean = base.replace(/[^A-Za-z0-9._ ()-]/g, '_').replace(/^\.+/, '').slice(0, 128)
  return clean || fallback
}

/** The documents in a user row's docContext, split back into files by the names in textAttachments. Empty when the
 *  text does not have the shape the web client writes (nothing is guessed). */
export function documentsFrom(docContext: string | undefined, names: string[]): Array<{ name: string; text: string }> {
  if (!docContext || names.length === 0) return []
  const out: Array<{ name: string; text: string }> = []
  let at = 0
  for (let i = 0; i < names.length; i++) {
    const head = `[Attached: ${names[i]}]\n`
    if (!docContext.startsWith(head, at)) return []
    const start = at + head.length
    const nextHead = i + 1 < names.length ? `\n\n[Attached: ${names[i + 1]}]\n` : null
    const end = nextHead ? docContext.indexOf(nextHead, start) : docContext.length
    if (end < 0) return []
    out.push({ name: names[i], text: docContext.slice(start, end) })
    at = end + 2
  }
  return out
}

/** The files a run starts with: the answered user message's images and text documents, under unique safe names. */
export async function turnFiles(userMsg: Pick<Message, 'attachments' | 'textAttachments' | 'docContext'> | undefined, store: Pick<AttachmentStore, 'inline'>): Promise<SandboxFile[]> {
  if (!userMsg) return []
  const files: SandboxFile[] = []
  const used = new Set<string>()
  let total = 0
  const add = (name: string, bytes: Buffer) => {
    if (total + bytes.length > MAX_INPUT_TOTAL) return
    let n = name
    for (let k = 2; used.has(n.toLowerCase()); k++) n = name.replace(/(\.[^.]*)?$/, (ext) => `-${k}${ext}`)
    used.add(n.toLowerCase())
    files.push({ name: n, bytes })
    total += bytes.length
  }
  let img = 0
  for (const a of userMsg.attachments ?? []) {
    const url = await store.inline(a)
    const m = url ? /^data:image\/(png|jpeg|gif|webp|bmp|avif);base64,(.*)$/.exec(url) : null
    if (!m) continue
    img++
    add(`image-${img}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`, Buffer.from(m[2], 'base64'))
  }
  for (const doc of documentsFrom(userMsg.docContext, userMsg.textAttachments ?? [])) {
    if (!DOCUMENT_TYPES.test(doc.name)) continue
    add(safeName(doc.name, 'document.txt'), Buffer.from(doc.text, 'utf8'))
  }
  return files
}

/** The tool result the model reads, and the image references the reply row keeps. */
export async function describeRun(r: SandboxRunResult, store: Pick<AttachmentStore, 'save'>): Promise<{ result: string; files: string[] }> {
  const lines: string[] = []
  const refs: string[] = []
  if (r.stdout.trim()) lines.push(`Output:\n${r.stdout.trimEnd()}`)
  if (r.stderr.trim()) lines.push(`Warnings:\n${r.stderr.trimEnd()}`)
  if (!r.ok) lines.push(`Python error:\n${r.error ?? 'unknown error'}`)
  const shown: string[] = []
  for (const f of r.files) {
    const ext = f.name.slice(f.name.lastIndexOf('.') + 1).toLowerCase()
    const mime = IMAGE_MIME[ext]
    if (mime) {
      const [saved] = await store.save([`data:${mime};base64,${f.bytes.toString('base64')}`])
      if (saved?.startsWith('attachment:')) {
        refs.push(saved)
        shown.push(f.name)
      } else {
        lines.push(`${f.name} could not be saved, so the user cannot see it.`)
      }
      continue
    }
    const text = f.bytes.toString('utf8')
    lines.push(`${f.name}:\n${text.length > TEXT_BACK_LIMIT ? `${text.slice(0, TEXT_BACK_LIMIT)}\n[cut off: ${f.bytes.length} bytes in all]` : text}`)
  }
  if (shown.length) lines.push(`Shown to the user in the chat: ${shown.join(', ')}`)
  if (r.skipped.length) lines.push(`Not returned (only png, jpg, csv, json, txt and py files are, up to 20 per run): ${r.skipped.slice(0, 20).join(', ')}`)
  if (!lines.length) lines.push('(no output; use print() to see values)')
  return { result: lines.join('\n\n'), files: refs }
}

/** The SandboxTurn for one live chat turn. `userMessage` is read at the call, so it is the row the turn answers. */
export function sandboxTurn(o: {
  convId: string
  manager: SandboxManager
  store: Pick<AttachmentStore, 'inline' | 'save'>
  userMessage: () => Pick<Message, 'attachments' | 'textAttachments' | 'docContext'> | undefined
}): SandboxTurn {
  // The turn's files go in with its first run, and again only into a fresh sandbox (after a timeout): a later run of
  // the same turn must not overwrite what the code changed in them.
  let sent = false
  return {
    async run(args, signal) {
      const code = typeof args.code === 'string' ? args.code : ''
      if (!code.trim()) return { result: 'Error: run_python needs a non-empty `code` string.', files: [] }
      try {
        const files = !sent || !o.manager.has(o.convId) ? await turnFiles(o.userMessage(), o.store) : []
        sent = true
        const r = await o.manager.run(o.convId, code, files, signal)
        return await describeRun(r, o.store)
      } catch (e) {
        if (e instanceof SandboxError) return { result: `Error: ${e.message}${e.code === 'timeout' ? ' Variables from earlier runs are gone.' : ''}`, files: [] }
        throw e
      }
    },
  }
}
