// The run_python chat tool (GitHub #52): its definition, the files a run starts with, and what a run hands back.
//
// Who may reach it is decided elsewhere and fails closed: only a live chat turn whose caller may act on the host gets
// a SandboxTurn (chat-routes.ts runGeneration), only a turn with one is offered the tool (tool-registry.ts), and only
// an interactive call with one runs it (execute-with-approval.ts). Every run asks first, with Allow once only
// (tool-policy.ts, and the approve route refuses the standing approvals).
//
// Files in: the images and documents attached in the chat, and in a fresh sandbox the files earlier runs handed back
// (turnFiles). Documents arrive as the text the web client extracted (ChatScreen.tsx joins them as
// `[Attached: <name>]\n<text>`), so only text formats go in.
// Files out: PNG and JPEG are shown in the chat; CSV, JSON, text and Python are given to the user to download and come
// back to the model as text. All go to the chat's attachment store (chat/attachments.ts) and are named on the reply's
// own row, which is what keeps the attachment janitor from collecting them and what frees them when the chat is
// deleted. A chat keeps at most MAX_CHAT_FILES_BYTES of them.
import type { ToolDefinition } from '../tools/tool-registry'
import { attachmentRefId, type AttachmentStore } from '../chat/attachments'
import type { Message, ToolCallRecord, ToolOutput } from '../chat/db'
import type { SandboxManager } from './sandbox-manager'
import { SandboxError, RUN_TIMEOUT_MS, type SandboxFile, type SandboxRunResult } from './sandbox-process'

export const RUN_PYTHON = 'run_python'

/** The packages the runtime ships (runtime-manifest.ts), as the model is told them. */
const PACKAGES = 'numpy, pandas, matplotlib, Pillow and sympy'

/** Fixed, never built per chat: a description that changed per chat would break the prompt cache. */
export const RUN_PYTHON_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: RUN_PYTHON,
    description:
      `Run Python 3 code in a sandbox on this computer (Pyodide). ${PACKAGES} are available, and nothing else can be `
      + 'installed. There is no network and no access to the user\'s own files. Files the user attached in this chat '
      + 'are in the current folder: read them from there, never type their contents into the code. To give the user a file, save it to the current folder: png and jpg files '
      + 'are shown in the chat; csv, json, txt and py files are given to the user to download, and come back to you as text. Use print() to see values. '
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
// What the model reads of a run. Capped part by part, a run once came back as 230,000 characters; capped at fetch_url's
// 20,000 (builtin.ts FETCH_URL_MAX_CHARS), it still did not fit an 8,192-token context: text like "x,y\n" is about two
// characters a token. The engine refused the request both times and the reply came back empty.
export const RESULT_MAX_CHARS = 20_000

/** The characters a run's result may take for a model with `ctxTokens` of context: half of it, so at two characters a
 *  token at most a quarter of the context, and never more than fetch_url's 20,000. */
export function resultBudget(ctxTokens?: number | null): number {
  return ctxTokens && ctxTokens > 0 ? Math.max(2_000, Math.min(RESULT_MAX_CHARS, Math.floor(ctxTokens / 2))) : RESULT_MAX_CHARS
}
const MAX_INPUT_TOTAL = 100 * 1024 * 1024
const MAX_INPUT_FILES = 20

/** What a chat turn hands the tool: runs code in this chat's sandbox. */
export interface SandboxTurn {
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<{ result: string; files: string[]; outputs?: ToolOutput[] }>
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

type UserFiles = Pick<Message, 'attachments' | 'textAttachments' | 'docContext'>
/** A row of the chat before the turn's reply, as the run reads it. */
export type ChatRow = Pick<Message, 'role' | 'toolCalls'> & UserFiles

/** The files a run starts with, oldest row first: from a user row, its images (`image-N`, numbered across the chat)
 *  and text documents; from a reply, the files its run_python calls handed back (ToolCallRecord.outputs), under the
 *  names the code gave them. All under safe names. A name a newer row has again is the newer file (the user sent a new
 *  version, or later code wrote it again); two files with one name in the same user message keep both (`-2`), and in
 *  one reply the last run's file wins. Newest first under the caps. */
export async function turnFiles(rows: Array<UserFiles & Partial<Pick<ChatRow, 'role' | 'toolCalls'>>>, store: Pick<AttachmentStore, 'inline' | 'read'>): Promise<SandboxFile[]> {
  const perRow: Array<Array<{ name: string; bytes: Buffer }>> = []
  let img = 0
  for (const row of rows) {
    if (row.role === 'assistant') {
      perRow.push(await outputsOf(row.toolCalls ?? [], store))
      continue
    }
    const mine: Array<{ name: string; bytes: Buffer }> = []
    for (const a of row.attachments ?? []) {
      const url = await store.inline(a)
      const m = url ? /^data:image\/(png|jpeg|gif|webp|bmp|avif);base64,(.*)$/.exec(url) : null
      if (!m) continue
      img++
      mine.push({ name: `image-${img}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`, bytes: Buffer.from(m[2], 'base64') })
    }
    for (const doc of documentsFrom(row.docContext, row.textAttachments ?? [])) {
      if (DOCUMENT_TYPES.test(doc.name)) mine.push({ name: safeName(doc.name, 'document.txt'), bytes: Buffer.from(doc.text, 'utf8') })
    }
    perRow.push(mine)
  }
  // Chosen newest message first (that is who wins a name and the caps), handed over oldest first.
  const chosen: SandboxFile[][] = perRow.map(() => [])
  const taken = new Set<string>()
  let count = 0
  let total = 0
  for (let i = perRow.length - 1; i >= 0; i--) {
    const here = new Set<string>()
    for (const f of perRow[i]) {
      if (taken.has(f.name.toLowerCase())) continue // a newer message has this name
      let n = f.name
      for (let k = 2; here.has(n.toLowerCase()); k++) n = f.name.replace(/(\.[^.]*)?$/, (ext) => `-${k}${ext}`)
      if (count >= MAX_INPUT_FILES || total + f.bytes.length > MAX_INPUT_TOTAL) continue
      here.add(n.toLowerCase())
      chosen[i].push({ name: n, bytes: f.bytes })
      count++
      total += f.bytes.length
    }
    for (const n of here) taken.add(n)
  }
  return chosen.flat()
}

/** The files a reply's run_python calls handed back, by name, the last call's file winning a name. A file that is gone
 *  is left out. */
async function outputsOf(calls: ToolCallRecord[], store: Pick<AttachmentStore, 'read'>): Promise<Array<{ name: string; bytes: Buffer }>> {
  const byName = new Map<string, { name: string; file: string }>()
  for (const call of calls) {
    if (call.name !== RUN_PYTHON) continue
    for (const o of call.outputs ?? []) {
      const name = safeName(o.name, 'output')
      byName.delete(name.toLowerCase()) // re-added at the end: the last write is the newest
      byName.set(name.toLowerCase(), { name, file: o.file })
    }
  }
  const out: Array<{ name: string; bytes: Buffer }> = []
  for (const { name, file } of byName.values()) {
    const bytes = await store.read(file)
    if (bytes) out.push({ name, bytes })
  }
  return out
}

/** Which rows' files a run starts with. A fresh sandbox gets every file of the chat, the user's and the ones earlier
 *  code made, so a follow-up question after the sandbox closed still finds them. A warm one has them already, perhaps
 *  changed by earlier code: it gets only the user rows since the chat's last run_python call, the ones it has not been
 *  sent. */
export function filesFor(rows: ChatRow[], fresh: boolean): ChatRow[] {
  const users = (from: number) => rows.slice(from).filter((r) => r.role === 'user')
  if (fresh) return rows.filter((r) => r.role === 'user' || r.role === 'assistant')
  const lastRun = rows.findLastIndex((r) => r.role === 'assistant' && (r.toolCalls ?? []).some((t) => t.name === RUN_PYTHON))
  return users(lastRun + 1)
}

/** A missing module, said as what it is here. Pyodide's own message ends with how to install the package
 *  (`micropip.install`, `loadPackage`), which needs the network the sandbox does not have: a model that follows it
 *  tries again with the same import. Seen with a real model asking for scipy. */
export function pythonError(error: string): string {
  const missing = /ModuleNotFoundError: No module named '([^']+)'/.exec(error)
  if (!missing) return error
  const kept = error.slice(0, missing.index + missing[0].length)
  return `${kept}\n'${missing[1].split('.')[0]}' cannot be installed: the sandbox has no network. Only the Python standard `
    + `library and ${PACKAGES} are available; write the code with those.`
}

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')

/** image/png or image/jpeg by the file's own first bytes, or null when it is neither. */
export function imageType(bytes: Buffer): 'image/png' | 'image/jpeg' | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  return null
}

/** A cell a spreadsheet may run as a formula: one starting with = + - @, a tab or a carriage return (OWASP's CSV
 *  injection list), unless it is a plain number such as -5 or +3.2, or that one character alone. */
function formulaCell(cell: string): boolean {
  return cell.length > 1 && /^[=+\-@\t\r]/.test(cell) && !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(cell)
}

/** Whether a CSV has a cell a spreadsheet may run as a formula. Quoted fields are read unquoted ("=1" is a formula
 *  cell too); a field with a quote that is never closed runs to the end of the text, as a spreadsheet would read it. */
export function csvHasFormulaCells(text: string): boolean {
  let i = 0
  while (i <= text.length) {
    let cell = ''
    if (text[i] === '"') {
      i++
      while (i < text.length) {
        if (text[i] === '"' && text[i + 1] === '"') { cell += '"'; i += 2 }
        else if (text[i] === '"') { i++; break }
        else cell += text[i++]
      }
      while (i < text.length && text[i] !== ',' && text[i] !== '\n') cell += text[i++]
    } else {
      while (i < text.length && text[i] !== ',' && text[i] !== '\n') cell += text[i++]
      if (cell.endsWith('\r') && text[i] === '\n') cell = cell.slice(0, -1)
    }
    if (formulaCell(cell)) return true
    i++
  }
  return false
}

/** The files a chat may keep, all its rows together (GitHub #52): images and files for download. */
export const MAX_CHAT_FILES_BYTES = 500 * 1024 * 1024

/** What a run hands back: the tool result the model reads, the references the reply row keeps, and each file as the
 *  code named it. */
export interface DescribedRun {
  result: string
  files: string[]
  outputs: ToolOutput[]
}

/** The tool result the model reads, and the files the reply row keeps. `room` is the bytes the chat may still keep
 *  (MAX_CHAT_FILES_BYTES less what its rows already name): a file that does not fit is not kept, and both the model
 *  and the user are told. */
export async function describeRun(r: SandboxRunResult, store: Pick<AttachmentStore, 'save' | 'saveFile'>, budget = RESULT_MAX_CHARS, room = MAX_CHAT_FILES_BYTES): Promise<DescribedRun> {
  // Shares of the budget: printed output, warnings, each text file, and the lists that come last.
  const OUTPUT_BACK_LIMIT = Math.floor(budget * 0.4)
  const WARNINGS_BACK_LIMIT = Math.floor(budget * 0.1)
  const TEXT_BACK_LIMIT = Math.floor(budget * 0.2)
  const RESULT_TAIL_RESERVE = Math.floor(budget * 0.15)
  const lines: string[] = []
  const refs: string[] = []
  if (r.stdout.trim()) lines.push(`Output:\n${cutPrinted(r.stdout.trimEnd(), OUTPUT_BACK_LIMIT)}`)
  if (r.stderr.trim()) lines.push(`Warnings:\n${cutPrinted(r.stderr.trimEnd(), WARNINGS_BACK_LIMIT)}`)
  if (!r.ok) lines.push(`Python error:\n${pythonError(r.error ?? 'unknown error')}`)
  const outputs: ToolOutput[] = []
  const shown: string[] = []
  const given: string[] = []
  const noRoom: string[] = []
  const texts: Array<{ name: string; text: string }> = []
  let left = room
  for (const f of r.files) {
    const ext = f.name.slice(f.name.lastIndexOf('.') + 1).toLowerCase()
    const image = Boolean(IMAGE_MIME[ext])
    // The bytes decide, not the name: a "chart.png" that is really a web page or an SVG with a script is not kept.
    // The store would serve it as image/png with nosniff, which browsers obey; this keeps it out of the store anyway.
    const mime = image ? imageType(f.bytes) : null
    if (image && !mime) {
      lines.push(`${f.name} is not a PNG or JPEG image, so it was not shown.`)
      continue
    }
    if (!image) texts.push({ name: f.name, text: f.bytes.toString('utf8') })
    if (f.bytes.length > left) {
      noRoom.push(f.name)
      continue
    }
    const saved = image
      ? (await store.save([`data:${mime};base64,${f.bytes.toString('base64')}`]))[0]
      : await store.saveFile(f.bytes, ext)
    if (!saved?.startsWith('attachment:')) {
      lines.push(`${f.name} could not be saved, so the user cannot ${image ? 'see' : 'download'} it.`)
      continue
    }
    left -= f.bytes.length
    refs.push(saved)
    ;(image ? shown : given).push(f.name)
    const formulaCells = ext === 'csv' && csvHasFormulaCells(f.bytes.toString('utf8'))
    outputs.push({ name: f.name, file: saved, size: f.bytes.length, ...(formulaCells ? { formulaCells: true as const } : {}) })
  }
  // Text files come back while the result's budget lasts; the rest are named, so the model can read what it needs in
  // another run.
  const leftOut: string[] = []
  let used = lines.reduce((n, l) => n + l.length + 2, 0)
  for (const t of texts) {
    const piece = `${t.name}:\n${cut(t.text, TEXT_BACK_LIMIT)}`
    if (used + piece.length + 2 > budget - RESULT_TAIL_RESERVE) { leftOut.push(t.name); continue }
    lines.push(piece)
    used += piece.length + 2
  }
  if (leftOut.length) lines.push(`Not included, the result would be too long: ${leftOut.join(', ')}. Read what you need from them in another run and print it.`)
  if (shown.length) lines.push(`Shown to the user in the chat: ${shown.join(', ')}`)
  if (given.length) lines.push(`Given to the user to download: ${given.join(', ')}`)
  if (noRoom.length) lines.push(`Not kept for the user, this chat's files have reached ${MAX_CHAT_FILES_BYTES / 1024 / 1024} MB: ${noRoom.join(', ')}. Deleting older messages with files makes room.`)
  if (r.skipped.length) lines.push(`Not returned (only png, jpg, csv, json, txt and py files are, up to 20 per run and 25 MB each): ${r.skipped.slice(0, 20).join(', ')}${r.skipped.length > 20 ? `, and ${r.skipped.length - 20} more` : ''}`)
  if (!lines.length) lines.push('(no output; use print() to see values)')
  return { result: cut(lines.join('\n\n'), budget), files: refs, outputs }
}

/** `text` up to `max` characters, with a note of how long it was when it is cut. */
function cut(text: string, max: number, total = `${text.length}`): string {
  return text.length > max ? `${text.slice(0, max)}\n[cut off: ${total} characters in all]` : text
}

/** What sandbox-host.mjs ends printed text with when the run printed more than it keeps. */
const HOST_CUT_NOTE = '\n[output cut off]'

/** Printed text cut like `cut`. Text the host already cut is only the start of what was printed, so its length is
 *  given as "more than", never as the whole. */
function cutPrinted(text: string, max: number): string {
  if (!text.endsWith(HOST_CUT_NOTE)) return cut(text, max)
  const kept = text.slice(0, -HOST_CUT_NOTE.length)
  return kept.length > max ? cut(kept, max, `more than ${kept.length}`) : text
}

/** The bytes of the stored files a chat's rows name (each file once, however many rows name it), with `more`
 *  references not on a row yet. A file that is gone counts nothing. */
export function chatFilesBytes(rows: Array<Pick<Message, 'attachments'>>, more: Iterable<string>, store: Pick<AttachmentStore, 'size'>): number {
  const ids = new Set<string>()
  for (const a of [...rows.flatMap((r) => r.attachments ?? []), ...more]) {
    const id = attachmentRefId(a)
    if (id) ids.add(id)
  }
  let total = 0
  for (const id of ids) total += store.size(id) ?? 0
  return total
}

/** The SandboxTurn for one live chat turn. `history` is read at the call: the chat's active rows before the turn's
 *  reply, oldest first. */
export function sandboxTurn(o: {
  convId: string
  manager: SandboxManager
  store: Pick<AttachmentStore, 'inline' | 'read' | 'save' | 'saveFile' | 'size'>
  history: () => ChatRow[]
  /** The characters a result may take (resultBudget of the loaded model's context), read at each run. */
  resultChars?: () => number
}): SandboxTurn {
  // Files go in with the turn's first run, and into any fresh sandbox (closed when idle, or after a timeout): a later
  // run of the same turn in a warm sandbox must not overwrite what the code changed in them.
  let sent = false
  let ranHere = false
  // Files this turn's runs kept: the reply row names them only once the turn ends, and they count toward the chat's
  // limit from the moment they are kept.
  const keptThisTurn = new Set<string>()
  return {
    async run(args, signal) {
      const code = typeof args.code === 'string' ? args.code : ''
      if (!code.trim()) return { result: 'Error: run_python needs a non-empty `code` string.', files: [] }
      try {
        const fresh = !o.manager.has(o.convId)
        const rows = fresh || !sent ? o.history() : []
        const files = fresh || !sent ? await turnFiles(filesFor(rows, fresh), o.store) : []
        // A new sandbox after earlier runs in this chat: the model may count on variables that are gone.
        const ranBefore = ranHere || rows.some((r) => r.role === 'assistant' && (r.toolCalls ?? []).some((t) => t.name === RUN_PYTHON))
        sent = true
        ranHere = true
        const r = await o.manager.run(o.convId, code, files, signal)
        const room = MAX_CHAT_FILES_BYTES - chatFilesBytes(rows.length ? rows : o.history(), keptThisTurn, o.store)
        const done = await describeRun(r, o.store, o.resultChars?.() ?? RESULT_MAX_CHARS, Math.max(0, room))
        for (const f of done.files) keptThisTurn.add(f)
        if (!fresh || !ranBefore) return done
        const back = files.length ? ` The files of this chat are back in the folder: ${files.map((f) => f.name).join(', ')}.` : ''
        return { ...done, result: `This run started a new sandbox: variables from earlier runs are gone.${back}\n\n${done.result}` }
      } catch (e) {
        // Each of these ended the process: the next run starts a new sandbox.
        const gone = e instanceof SandboxError && (e.code === 'timeout' || e.code === 'crashed' || e.code === 'violation')
        if (e instanceof SandboxError) return { result: `Error: ${e.message}${gone ? ' Variables from earlier runs are gone.' : ''}`, files: [] }
        throw e
      }
    },
  }
}
