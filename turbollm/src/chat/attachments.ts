// Chat attachments as files: images, and voice clips (scalability review 2.7, docs/plans/2026-10-31-scalability-review.md).
//
// The web client sends an image as a base64 data URL. Stored inline in messages.attachments, a chat with a few dozen
// phone photos made every open and every send read, parse and ship hundreds of megabytes, and on Android it bloated
// the sql.js database that is re-exported whole on each flush. Now each image is written once to
// <dataDir>/attachments/<sha256 of its bytes>.<ext>, and the row keeps `attachment:<that file name>`. A voice clip sent
// to a model that hears audio is kept the same way: a minute of speech is two megabytes of WAV.
//
// The reference is a plain string on purpose: messages.attachments stays the `string[]` every reader already knows, a
// row may mix references and data URLs (rows written before this, images kept inline below), and the file name alone
// gives everything else back — the mime type and whether it is an image or a clip from its extension, the bytes from
// the file.
//
// An attachment is converted only when the data URL rebuilt from its file is the exact string it came from (a mime
// type in MIME_BY_EXT, canonical base64), so an engine is sent byte for byte what it was sent before. Anything else
// stays inline. SVG is never converted: served from the daemon's own origin, its scripts would run there.
//
// Files are shared by every row that names them (the same picture sent twice is one file). Nothing deletes a file when
// a row goes; collectGarbage removes files no row names any more (attachment-janitor.ts).
//
// The store also keeps the CSV, JSON, text and Python files a run_python call made, for the user to download (GitHub
// #52). They come in only through saveFile, never through save: a message's images and clips, and the janitor's
// backfill, can only ever store media. They are never inlined (they are not media an engine takes) and are served only
// as downloads (chat-routes.ts).
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, statSync, unlinkSync, utimesSync } from 'node:fs'
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const REF_PREFIX = 'attachment:'
/** The audio a clip may be: what the engines that hear audio decode (llama.cpp reads WAV and MP3; the page records
 *  WAV). The extension is also the `format` the clip's `input_audio` part names. */
const AUDIO_MIME_BY_EXT: Record<string, string> = { wav: 'audio/wav', mp3: 'audio/mpeg' }
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
}
const MIME_BY_EXT: Record<string, string> = { ...IMAGE_MIME_BY_EXT, ...AUDIO_MIME_BY_EXT }
/** Files made for download (run_python's outputs, GitHub #52). Kept apart from MIME_BY_EXT, which EXT_BY_MIME and so
 *  save() are built from: no data URL a client sends can become one of these. */
const DOWNLOAD_MIME_BY_EXT: Record<string, string> = {
  csv: 'text/csv; charset=utf-8', json: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8',
  py: 'text/x-python; charset=utf-8',
}
const FILE_MIME_BY_EXT: Record<string, string> = { ...MIME_BY_EXT, ...DOWNLOAD_MIME_BY_EXT }
const EXT_BY_MIME = Object.fromEntries(Object.entries(MIME_BY_EXT).map(([ext, mime]) => [mime, ext]))
const ID_PATTERN = /^[0-9a-f]{64}\.(png|jpg|gif|webp|bmp|avif|wav|mp3|csv|json|txt|py)$/
/** The longest name a download is saved under. */
const MAX_DOWNLOAD_NAME = 128
const AUDIO_DATA_URL_PATTERN = /^data:(audio\/[a-z0-9.+-]+);base64,/
const DATA_URL_PATTERN = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/
const TEMP_SUFFIX = '.tmp'

/** Whether `attachment` is a stored reference (`attachment:<id>`), not an inline data URL. */
export function isAttachmentRef(attachment: string): boolean {
  return attachmentRefId(attachment) !== null
}

/** The file id a reference names, or null when `attachment` is not a well-formed reference. */
export function attachmentRefId(attachment: string): string | null {
  if (!attachment.startsWith(REF_PREFIX)) return null
  const id = attachment.slice(REF_PREFIX.length)
  return ID_PATTERN.test(id) ? id : null
}

/** Whether `attachment` is a stored reference to an image: not a voice clip, and not any other file the store keeps.
 *  Only these may stand where an image goes (a message's `images`, an engine's `image_url` part). */
export function isImageAttachmentRef(attachment: string): boolean {
  const id = attachmentRefId(attachment)
  return id !== null && Object.hasOwn(IMAGE_MIME_BY_EXT, id.slice(id.lastIndexOf('.') + 1))
}

/** Whether `attachment` is a stored reference to a file made for download (a CSV, JSON, text or Python file). */
export function isDownloadAttachmentRef(attachment: string): boolean {
  const id = attachmentRefId(attachment)
  return id !== null && Object.hasOwn(DOWNLOAD_MIME_BY_EXT, id.slice(id.lastIndexOf('.') + 1))
}

/** The file extensions saveFile takes. */
export function isDownloadExtension(ext: string): boolean {
  return Object.hasOwn(DOWNLOAD_MIME_BY_EXT, ext)
}

/** The name a download of `id` is saved under: `name` as the user or the code gave it, without any folder, control
 *  character or quote, at most MAX_DOWNLOAD_NAME characters, and always ending in the stored file's own extension (a
 *  CSV is never saved as `page.html`, which a browser would open as a page). Invisible format characters go too (a
 *  right-to-left override shows `report‮fdp.csv` as `reportvsc.pdf`; a zero-width space hides in a name), and line
 *  and paragraph separators. `file.<ext>` when nothing is left. */
export function downloadFileName(name: string, id: string): string {
  const ext = id.slice(id.lastIndexOf('.') + 1)
  let base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)
  const unsafe = (ch: string) => ch < ' ' || ch === '\u007f' || '"*:<>?|'.includes(ch) || /[\p{Cf}\p{Zl}\p{Zp}]/u.test(ch)
  base = Array.from(base, (ch) => (unsafe(ch) ? '_' : ch)).join('').replace(/[.\s]+$/, '')
  if (base.toLowerCase().endsWith(`.${ext}`)) base = base.slice(0, -(ext.length + 1))
  base = base.slice(0, MAX_DOWNLOAD_NAME - ext.length - 1).replace(/^[.\s]+|[.\s]+$/g, '')
  return `${base || 'file'}.${ext}`
}

/** The audio format of a voice clip attachment (`wav`, `mp3`): a stored reference by its extension, a data URL by its
 *  mime type. Null for anything else, an image included. */
export function audioAttachmentFormat(attachment: string): string | null {
  const id = attachmentRefId(attachment)
  if (id !== null) {
    const ext = id.slice(id.lastIndexOf('.') + 1)
    return Object.hasOwn(AUDIO_MIME_BY_EXT, ext) ? ext : null
  }
  const mime = AUDIO_DATA_URL_PATTERN.exec(attachment)?.[1]
  const ext = mime === undefined ? undefined : EXT_BY_MIME[mime]
  return ext !== undefined && Object.hasOwn(AUDIO_MIME_BY_EXT, ext) ? ext : null
}

/** Whether an attachment is a voice clip rather than an image. */
export function isAudioAttachment(attachment: string): boolean {
  return audioAttachmentFormat(attachment) !== null
}

/** A data URL's payload: the base64 after the comma. */
function dataUrlPayload(url: string): string {
  return url.slice(url.indexOf(',') + 1)
}

/** Whether `url` is a data URL whose base64 is canonical, the only kind this store can turn into a file. Anything
 *  else (garbage, line breaks, odd padding) would stay inline in the message row. */
export function isCanonicalDataUrl(url: string): boolean {
  return parseConvertible(url) !== null
}

/** An image or clip data URL this store can keep as a file, or null to keep it inline. */
function parseConvertible(url: string): { ext: string; bytes: Buffer } | null {
  const m = DATA_URL_PATTERN.exec(url)
  if (!m) return null
  const ext = EXT_BY_MIME[m[1]]
  if (!ext) return null
  const bytes = Buffer.from(m[2], 'base64')
  return bytes.toString('base64') === m[2] ? { ext, bytes } : null
}

type ContentPart = { type?: unknown; image_url?: { url?: unknown }; input_audio?: { data?: unknown; format?: unknown } }

export class AttachmentStore {
  /** Null for an in-memory database, whose images stay inline (nothing on disk to outlive it). */
  private readonly folder: string | null

  // db.ts's IN_MEMORY_DATA_DIR, spelled out: db.ts imports this module.
  constructor(dataDir: string) {
    this.folder = dataDir === ':memory:' ? null : join(dataDir, 'attachments')
  }

  get enabled(): boolean {
    return this.folder !== null
  }

  /** Each image data URL written to its file and replaced by its reference; everything else unchanged. Writes finish
   *  before this resolves, so a row saved with the result never names a file that is not there. */
  async save(attachments: string[]): Promise<string[]> {
    const out: string[] = []
    for (const attachment of attachments) out.push(await this.saveOne(attachment))
    return out
  }

  private async saveOne(attachment: string): Promise<string> {
    if (!this.folder) return attachment
    const parsed = parseConvertible(attachment)
    if (!parsed) return attachment
    const id = `${createHash('sha256').update(parsed.bytes).digest('hex')}.${parsed.ext}`
    const path = join(this.folder, id)
    if (this.touch(path)) return `${REF_PREFIX}${id}`
    try {
      await this.writeOnce(path, parsed.bytes)
    } catch {
      return attachment // a full disk or an unwritable folder: kept inline, as every image was before
    }
    return `${REF_PREFIX}${id}`
  }

  /** Stores a file made for download (`ext` one of csv, json, txt, py) and returns its reference, or null when `ext`
   *  is not one of those or the file could not be written. Same content-addressed name and write as save. */
  async saveFile(bytes: Buffer, ext: string): Promise<string | null> {
    if (!this.folder || !isDownloadExtension(ext)) return null
    const id = `${createHash('sha256').update(bytes).digest('hex')}.${ext}`
    const path = join(this.folder, id)
    if (this.touch(path)) return `${REF_PREFIX}${id}`
    try {
      await this.writeOnce(path, bytes)
    } catch {
      return null
    }
    return `${REF_PREFIX}${id}`
  }

  /** Marks an existing file as just used, so a collection already under way leaves it (it spares files younger than
   *  its grace period). Synchronous, like collectGarbage's stat and unlink: the two never interleave. False when the
   *  file does not exist. */
  private touch(path: string): boolean {
    const now = new Date()
    try {
      utimesSync(path, now, now)
      return true
    } catch {
      return false
    }
  }

  /** Temp file, then rename: a crash leaves no half-written image under its final name. Two saves of the same image
   *  write the same bytes, so a rename that loses to the other one is still a success. */
  private async writeOnce(path: string, bytes: Buffer): Promise<void> {
    mkdirSync(this.folder!, { recursive: true })
    const temp = `${path}.${randomUUID()}${TEMP_SUFFIX}`
    try {
      await writeFile(temp, bytes)
      await rename(temp, path)
    } catch (e) {
      await rm(temp, { force: true })
      if (!this.touch(path)) throw e
    }
  }

  /** The bytes of the stored file a reference names, of any type (run_python hands a fresh sandbox the files earlier
   *  runs made). Null when `attachment` is not a reference or its file is gone. */
  async read(attachment: string): Promise<Buffer | null> {
    const id = attachmentRefId(attachment)
    const file = id === null ? null : this.file(id)
    if (!file) return null
    try {
      return await readFile(file.path)
    } catch {
      return null
    }
  }

  /** The data URL a reference was saved from; any other attachment unchanged; null when its file is gone, and for a
   *  file made for download, which is no image or clip and is never sent inline (the External Chat API leaves it out). */
  async inline(attachment: string): Promise<string | null> {
    const id = attachmentRefId(attachment)
    if (id === null) return attachment
    if (isDownloadAttachmentRef(attachment)) return null
    const file = this.file(id)
    if (!file) return null
    try {
      return `data:${file.mime};base64,${(await readFile(file.path)).toString('base64')}`
    } catch {
      return null
    }
  }

  /** Engine messages with every stored attachment read back as the engine takes it: an image as the data URL it was
   *  always sent, a voice clip as the bare base64 an `input_audio` part carries (chat-compaction.ts userTurnContent
   *  builds both from the row's strings). One whose file is gone is left out rather than sent as a reference no
   *  engine understands. */
  async resolveMedia(messages: Array<{ content: unknown }>): Promise<void> {
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue
      const parts: ContentPart[] = []
      for (const part of message.content as ContentPart[]) {
        const resolved = await this.resolvePart(part)
        if (resolved !== null) parts.push(resolved)
      }
      message.content = parts
    }
  }

  private async resolvePart(part: ContentPart): Promise<ContentPart | null> {
    if (part?.type === 'image_url') {
      const url = part.image_url?.url
      if (typeof url !== 'string' || !url.startsWith(REF_PREFIX)) return part
      // A clip, any other stored file or a malformed reference is never sent as an image, nor as a reference no
      // engine understands.
      if (!isImageAttachmentRef(url)) return null
      const inlined = await this.inline(url)
      return inlined === null ? null : { ...part, image_url: { ...part.image_url, url: inlined } }
    }
    if (part?.type === 'input_audio') {
      const data = part.input_audio?.data
      if (typeof data !== 'string') return part
      // Not a reference and not a data URL: base64 already, as an API caller sends it.
      if (!isAttachmentRef(data) && !data.startsWith('data:')) return part
      const inlined = await this.inline(data)
      return inlined === null ? null : { ...part, input_audio: { ...part.input_audio, data: dataUrlPayload(inlined) } }
    }
    return part
  }

  /** The size in bytes of the file behind `id`, or null when there is none. */
  size(id: string): number | null {
    const file = this.file(id)
    if (!file) return null
    try {
      return statSync(file.path).size
    } catch {
      return null
    }
  }

  /** The file behind `id`, or null when `id` is not exactly a name this store writes (so never a path elsewhere). */
  file(id: string): { path: string; mime: string } | null {
    if (!this.folder || !ID_PATTERN.test(id)) return null
    return { path: join(this.folder, id), mime: FILE_MIME_BY_EXT[id.slice(id.lastIndexOf('.') + 1)] }
  }

  /** Deletes every file not in `referenced` (ids) and older than `graceMs`, and temp files a crashed write left. The
   *  grace period covers a save whose row is not written yet. Returns how many files were deleted. */
  async collectGarbage(referenced: ReadonlySet<string>, graceMs: number): Promise<number> {
    if (!this.folder) return 0
    let names: string[]
    try {
      names = await readdir(this.folder)
    } catch {
      return 0
    }
    const cutoff = Date.now() - graceMs
    let deleted = 0
    for (const name of names) {
      const collectable = name.endsWith(TEMP_SUFFIX) || (ID_PATTERN.test(name) && !referenced.has(name))
      if (collectable && this.removeIfOlder(join(this.folder, name), cutoff)) deleted++
    }
    return deleted
  }

  private removeIfOlder(path: string, cutoff: number): boolean {
    try {
      if (statSync(path).mtimeMs > cutoff) return false
      unlinkSync(path)
      return true
    } catch {
      return false
    }
  }

}
