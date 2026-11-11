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
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, statSync, unlinkSync, utimesSync } from 'node:fs'
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const REF_PREFIX = 'attachment:'
/** The audio a clip may be: what the engines that hear audio decode (llama.cpp reads WAV and MP3; the page records
 *  WAV). The extension is also the `format` the clip's `input_audio` part names. */
const AUDIO_MIME_BY_EXT: Record<string, string> = { wav: 'audio/wav', mp3: 'audio/mpeg' }
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
  ...AUDIO_MIME_BY_EXT,
}
const EXT_BY_MIME = Object.fromEntries(Object.entries(MIME_BY_EXT).map(([ext, mime]) => [mime, ext]))
const ID_PATTERN = /^[0-9a-f]{64}\.(png|jpg|gif|webp|bmp|avif|wav|mp3)$/
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

  /** The data URL a reference was saved from; any other attachment unchanged; null when its file is gone. */
  async inline(attachment: string): Promise<string | null> {
    const id = attachmentRefId(attachment)
    if (id === null) return attachment
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
      if (typeof url !== 'string' || !isAttachmentRef(url)) return part
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

  /** The file behind `id`, or null when `id` is not exactly a name this store writes (so never a path elsewhere). */
  file(id: string): { path: string; mime: string } | null {
    if (!this.folder || !ID_PATTERN.test(id)) return null
    return { path: join(this.folder, id), mime: MIME_BY_EXT[id.slice(id.lastIndexOf('.') + 1)] }
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
