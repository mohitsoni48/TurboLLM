// A chat reply as text worth saying aloud, and cut into pieces a speech engine handles well.
//
// A reply is Markdown. Read as it is, a voice says "asterisk asterisk", spells out URLs and recites code character by
// character. So the markup is taken off, what cannot be spoken usefully (code blocks, tables' rules, images) is left
// out, and the rest is split at sentence ends: speech engines stall or cut off on long inputs (Chrome's stops after
// about fifteen seconds of one utterance), and short pieces are also what lets a reply be spoken while it is still
// being written.
//
// PURE: strings in, strings out.

/** Markdown as plain prose, one paragraph or list item per line. */
export function speakableText(markdown: string): string {
  let text = markdown
    // Reasoning a model wrote inline, closed or still open at the end of a reply in progress.
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, ' ')
    // Fenced code, closed or still open: nobody wants a for-loop read to them.
    .replace(/(^|\n)[ \t]*(```|~~~)[\s\S]*?(\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    .replace(/https?:\/\/[^\s)>\]]+/g, spokenUrl)
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/`([^`\n]*)`/g, '$1')
    // Citation marks: [1], [^note], 【3†source】.
    .replace(/\[\^?\d+\]|【[^】]*】/g, '')
  text = text
    .split('\n')
    .map(spokenLine)
    .filter((line) => line !== null)
    .join('\n')
  return text
    .replace(/(\*\*|__|~~)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/(^|[\s(])[*_](?=\S)([^\n*_]*?\S)[*_](?=$|[\s).,;:!?])/gm, '$1$2')
    .replace(/\*\*|~~/g, '')
    .replace(/\p{Extended_Pictographic}️?/gu, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** A line without its block markup; null for a line that is only markup (a rule, a table's divider). */
function spokenLine(line: string): string | null {
  const trimmed = line.trim()
  if (/^([-*_] ?){3,}$/.test(trimmed) || /^\|?[\s:|-]*-{3,}[\s:|-]*\|?$/.test(trimmed)) return null
  let out = trimmed
    .replace(/^(>\s?)+/, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')
  // A table row: its cells, with a pause between them.
  if (/^\|.*\|$/.test(out)) out = out.slice(1, -1).split('|').map((cell) => cell.trim()).filter(Boolean).join(', ')
  return out
}

/** A link said as where it goes, not letter by letter. */
function spokenUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** A piece is kept under this many characters where sentences allow: a few seconds of speech. */
const PIECE_CHARS = 220

// The end of a sentence: closing punctuation, any closing quote or bracket, then space or the end. The CJK marks
// need no space after them.
const SENTENCE_END = /([.!?…]+["'”’)\]]*(?=\s|$)|[。！？]+["”’）」』]*)\s*/g

/** How much of `text`, from its start, is complete sentences (or whole lines): text that is still arriving is spoken
 *  up to here, and the rest waits for its sentence to finish. */
export function completeLength(text: string): number {
  let end = text.lastIndexOf('\n') + 1
  SENTENCE_END.lastIndex = 0
  for (let m = SENTENCE_END.exec(text); m !== null; m = SENTENCE_END.exec(text)) {
    const after = m.index + m[0].length
    // A mark at the very end of what has arrived may be the middle of "3.14" or "e.g.": wait for what follows.
    if (after < text.length) end = Math.max(end, after)
  }
  return end
}

/** Prose as pieces to speak in turn: sentences, with short ones joined up to {@link PIECE_CHARS} and a sentence
 *  longer than that cut at a comma or a space. Lines are never joined: a new line is a pause. */
export function speechPieces(text: string): string[] {
  const pieces: string[] = []
  for (const line of text.split('\n')) {
    let piece = ''
    for (const sentence of sentencesOf(line)) {
      if (piece && piece.length + sentence.length + 1 > PIECE_CHARS) {
        pieces.push(piece)
        piece = ''
      }
      piece = piece ? `${piece} ${sentence}` : sentence
      while (piece.length > PIECE_CHARS) {
        const cut = breakPoint(piece)
        pieces.push(piece.slice(0, cut).trim())
        piece = piece.slice(cut).trim()
      }
    }
    if (piece) pieces.push(piece)
  }
  return pieces
}

function sentencesOf(line: string): string[] {
  const out: string[] = []
  let start = 0
  SENTENCE_END.lastIndex = 0
  for (let m = SENTENCE_END.exec(line); m !== null; m = SENTENCE_END.exec(line)) {
    const end = m.index + m[0].length
    const sentence = line.slice(start, end).trim()
    if (sentence) out.push(sentence)
    start = end
  }
  const rest = line.slice(start).trim()
  if (rest) out.push(rest)
  return out
}

/** Where to cut a piece that is too long: after the last comma-like mark inside the limit, else the last space, else
 *  at the limit. */
function breakPoint(piece: string): number {
  const window = piece.slice(0, PIECE_CHARS)
  const soft = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '), window.lastIndexOf('、'), window.lastIndexOf('，'))
  if (soft > PIECE_CHARS / 3) return soft + 1
  const space = window.lastIndexOf(' ')
  return space > PIECE_CHARS / 3 ? space : PIECE_CHARS
}
