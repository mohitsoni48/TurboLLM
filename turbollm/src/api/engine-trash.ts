// The purge trash: engine folders renamed aside by a purge or DELETE /engines/build, deleted in the background.
import { readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Remove the hidden `.<name>.purge-<ms>` folders a purge or DELETE /engines/build renamed aside in `parent` but
 *  could not delete (a Windows lock that outlasted the retries). Best effort and in the background
 *  (discardPurgeTrash); a folder whose delete is still running is left to it. Both routes run it before their own
 *  rename there. */
export function sweepPurgeTrash(parent: string): void {
  let names: string[]
  try {
    names = readdirSync(parent)
  } catch {
    return
  }
  for (const name of names) {
    if (/^\..+\.purge-\d+$/.test(name)) void discardPurgeTrash(join(parent, name))
  }
}

/** The purge-trash deletes still running, by folder. */
const purgeTrashDeletes = new Map<string, Promise<void>>()

/** Delete a folder a purge or DELETE /engines/build renamed aside, in the background with fs/promises rm, as
 *  discardParkedBuild does for the build a rebuild replaced. Both routes deleted it with a recursive rmSync, which
 *  held the daemon's only thread for as long as a multi-GB build tree took to delete, and with maxRetries also slept
 *  on that thread between retries (up to 1.5 s per locked entry). Now the routes reply first, and the waits on the
 *  disk (seconds with Windows Defender scanning each file) and the retry back-off leave the thread free. The rm's own
 *  callbacks still run on it: on a fast disk, a tree of tens of thousands of small files can hold it for about 0.3 s
 *  at a time, about as long as the rmSync took; only a worker thread would avoid that. It retries, as a Windows lock
 *  right after a Stop is brief. A folder already being deleted gets no second delete (a sweep finds it before its
 *  delete has ended): the running one is returned. Never rejects; whatever stays locked, or a daemon exit cut short,
 *  is swept by the next purge or delete in that folder. */
export function discardPurgeTrash(trash: string): Promise<void> {
  const running = purgeTrashDeletes.get(trash)
  if (running) return running
  const deleting: Promise<void> = rm(trash, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    .catch(() => {
      /* still locked: swept later */
    })
    .finally(() => purgeTrashDeletes.delete(trash))
  purgeTrashDeletes.set(trash, deleting)
  return deleting
}
