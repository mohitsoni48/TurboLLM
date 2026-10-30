// Whether anything reaps the processes TurboLLM leaves behind as orphans. Every tethered child's watcher
// (util/tether.ts) is double-forked, so it is adopted by PID 1 (or the nearest subreaper) and must be reaped by it
// once it exits; so must every child of a tethered program that outlives it. In a container whose PID 1 is node
// itself (the images used to run `ENTRYPOINT ["node", …]`), or one that does not reap (GitHub Actions' `container:`
// jobs run `tail -f /dev/null` as PID 1), each of them stayed a zombie: measured, 5 after five short tethered
// commands, and under a pids limit the wrapper's own fork then fails. The images now start tini (Dockerfile.amd,
// Dockerfile.nvidia, the RunPod image's deploy/runpod/Dockerfile, and the test images Dockerfile.test,
// Dockerfile.test.gpu and Dockerfile.test-port), and this check catches every other setup, a list of init names never
// could: it makes one orphan and watches whether whoever adopts it, exactly whoever adopts the watchers, reaps it.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** How long the orphan may stay a zombie before the check says nothing reaps. This sandbox's own PID 1 took about
 *  1.9 s; tini and systemd reap at once. */
export const REAP_TIMEOUT_MS = 10_000

function stat(pid: number): { state: string; comm: string } | null {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return { state: s.slice(s.lastIndexOf(')') + 2).split(' ')[0], comm: s.slice(s.indexOf('(') + 1, s.lastIndexOf(')')) }
  } catch {
    return null
  }
}

function pid1Comm(): string {
  try {
    return readFileSync('/proc/1/comm', 'utf8').trim()
  } catch {
    return '?'
  }
}

/** Make one orphan (a `sh -c "unset TMOUT; read line <&3; exit 0" &` from a `sh` that exits at once) and watch it.
 *  'reaped' when it is gone (or its pid holds another process by then) within `timeoutMs`; 'not-reaped' when it is
 *  still a zombie, and then the warning is logged once. 'skipped' off Linux (Android included: the app's own process
 *  is reaped by zygote, and Termux runs under it) or when the probe could not run. Off the boot path: cli.ts does not
 *  await it. */
export async function checkOrphansReaped(o: { timeoutMs?: number; log?: (line: string) => void; platform?: NodeJS.Platform } = {}): Promise<'reaped' | 'not-reaped' | 'skipped'> {
  if ((o.platform ?? process.platform) !== 'linux') return 'skipped'
  const timeoutMs = o.timeoutMs ?? REAP_TIMEOUT_MS
  const log = o.log ?? ((line: string) => console.warn(line))
  const orphan = await new Promise<number>((resolve) => {
    let out = ''
    let sh: ReturnType<typeof spawn>
    // The orphan must outlive the sh that starts it: one that exits first is reaped by that sh (dash reaps on its
    // SIGCHLD, before it exits), never reaches PID 1, and the check said 'reaped' under a PID 1 that reaps nothing.
    // On a busy machine that was 1 run in 3. So the orphan blocks reading fd 3, a pipe whose other end only this
    // process holds, and is let go (that end closed) once the sh has exited, when the kernel has already handed the
    // orphan to PID 1 or the nearest subreaper. Its stdout is /dev/null, not our pipe, or that pipe would not close
    // before it exits. Should the daemon die first, its end closes with it and the orphan exits all the same. Where
    // that `sh` is bash (Fedora, Arch), its read takes an exported TMOUT for a timeout, and one shorter than the
    // first sh took to exit let the orphan go first all the same: the orphan unsets it.
    try {
      sh = spawn('/bin/sh', ['-c', 'sh -c "unset TMOUT; read line <&3; exit 0" >/dev/null 2>&1 & echo $!'], { stdio: ['ignore', 'pipe', 'ignore', 'pipe'] })
    } catch {
      resolve(0)
      return
    }
    let exited = false
    let read = false
    const letGo = () => {
      if (!exited || !read) return
      sh.stdio[3]?.destroy()
      resolve(Number(out.trim()) || 0)
    }
    sh.on('error', () => {
      sh.stdio[3]?.destroy()
      resolve(0)
    })
    sh.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    sh.stdout?.on('close', () => { read = true; letGo() })
    sh.on('exit', () => { exited = true; letGo() })
  })
  if (!orphan) return 'skipped'
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const s = stat(orphan)
    // Gone: reaped. Not a zombie of `sh`: still running its `exit 0`, or reaped already and its pid reused.
    if (!s) return 'reaped'
    if (Date.now() >= deadline) {
      if (s.state === 'Z' && s.comm === 'sh') {
        log(`TurboLLM's orphaned processes are not being reaped (PID 1 is '${pid1Comm()}' and reaped nothing within ${Math.round(timeoutMs / 1000)} s): ` +
          'every process TurboLLM ends would stay a zombie. Run the image as shipped (it starts tini), or add --init.')
        return 'not-reaped'
      }
      return 'reaped'
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
