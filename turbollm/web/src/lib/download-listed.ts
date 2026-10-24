import { toast } from '../components/ui/sonner'
import type { EnqueueResult } from './queries'

/** Says so when a download request queued nothing new because the download list already holds
 *  the file: "Resumed <name>" when its row was paused (the enqueue mutation resumes it), else
 *  "Already downloading <name>". A re-import of a URL used to close Import from URL without a
 *  word, and the quant dialog said "Downloading" for a row that stayed paused. Nothing when the
 *  request created a row, or matched none. */
export function sayIfAlreadyListed(out: EnqueueResult): void {
  if (out.downloads.length > 0) return
  const row = out.resumed[0] ?? out.existing[0]
  if (!row) return
  if (out.resumed.length > 0) toast.success(`Resumed ${row.name}`)
  else toast.info(`Already downloading ${row.name}`)
}
