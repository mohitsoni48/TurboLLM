// The daemon's source as one program in the order it runs, for the wiring guards that are still source scans (the
// ones whose subject is process-level ordering a test daemon cannot show: boot.test.ts and the boot.*-wiring tests
// boot a real one for the rest). cli.ts with its `const daemon = await bootDaemon({…})` statement replaced by the body
// of boot.ts's bootDaemon, dedented to column 0: it reads as cli.ts did before the boot was extracted, so a guard can
// still check that one step comes before another across the two files.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('..', import.meta.url))

/** A source file under src/, line endings normalized (a CRLF checkout reads the same). */
export function source(relative: string): string {
  return readFileSync(`${SRC}${relative}`, 'utf8').replace(/\r\n/g, '\n')
}

/** The body of bootDaemon, dedented to column 0. */
export function bootBody(): string {
  const boot = source('boot.ts')
  const open = 'export async function bootDaemon(opts: BootOptions): Promise<BootedDaemon> {\n'
  const start = boot.indexOf(open)
  const end = boot.lastIndexOf('\n}\n')
  if (start < 0 || end < start) throw new Error('boot.ts must define bootDaemon, ending at a column-0 brace')
  return boot.slice(start + open.length, end + 1).replace(/^ {2}/gm, '')
}

export function daemonSourceInBootOrder(): string {
  const cli = source('cli.ts')
  const start = cli.indexOf('const daemon = await bootDaemon({')
  const end = cli.indexOf('\n})\n', start)
  if (start < 0 || end < start) throw new Error('cli.ts must boot the daemon with `const daemon = await bootDaemon({…})`')
  return cli.slice(0, start) + bootBody() + cli.slice(end + '\n})\n'.length)
}
