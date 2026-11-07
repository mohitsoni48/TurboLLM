// The bounded history a PTY session replays to a newly attached viewer.
//
// Chunks are kept as written, with a running length: an append is O(1), and an over-cap buffer drops whole
// chunks from the front. (A single string re-sliced on every chunk copied ~1 MB per chunk once full, and an agent
// CLI's TUI emits hundreds of chunks a second.) Only a replay joins the chunks, and trims that string to the
// newest `cap` characters, so a replay is exactly `cap` long once anything was dropped: the web client treats a
// shorter replay as the PTY's whole output (DAEMON_REPLAY_CAP in web/src/screens/code/TerminalView.tsx).

export class ScrollbackBuffer {
  private chunks: string[] = []
  private length = 0

  constructor(private readonly cap: number) {}

  append(chunk: string): void {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.length += chunk.length
    // Drop the oldest chunk only while the rest still holds a full cap.
    while (this.chunks.length > 1 && this.length - this.chunks[0].length >= this.cap) {
      this.length -= this.chunks.shift()!.length
    }
  }

  /** Characters held right now: at most one chunk beyond `cap`. */
  retainedLength(): number { return this.length }

  /** The newest `cap` characters written (everything, while fewer have been). */
  toString(): string {
    const all = this.chunks.join('')
    return all.length > this.cap ? all.slice(all.length - this.cap) : all
  }
}
