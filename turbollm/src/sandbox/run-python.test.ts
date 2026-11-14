import test from 'node:test'
import assert from 'node:assert/strict'
import { describeRun, documentsFrom, RUN_PYTHON_TOOL, safeName, sandboxTurn, turnFiles } from './run-python'
import type { SandboxManager } from './sandbox-manager'
import { SandboxError, type SandboxFile, type SandboxRunResult } from './sandbox-process'

const PNG = Buffer.from('89504e470d0a1a0a', 'hex')
const store = {
  inline: async (a: string) => (a === 'attachment:abc.png' ? `data:image/png;base64,${PNG.toString('base64')}` : a.startsWith('data:') ? a : null),
  save: async (urls: string[]) => urls.map((u) => (u.startsWith('data:image/') ? `attachment:${'0'.repeat(64)}.png` : u)),
}

test('run_python: its description is fixed text (the prompt cache)', () => {
  assert.equal(RUN_PYTHON_TOOL.function.name, 'run_python')
  assert.match(RUN_PYTHON_TOOL.function.description!, /no network/)
  assert.deepEqual((RUN_PYTHON_TOOL.function.parameters as { required: string[] }).required, ['code'])
})

test('documentsFrom: splits the web client\'s [Attached: name] blocks back into files', () => {
  const ctx = '[Attached: a.csv]\nx,y\n1,2\n\n[Attached: notes.txt]\nhello\n\nworld'
  assert.deepEqual(documentsFrom(ctx, ['a.csv', 'notes.txt']), [{ name: 'a.csv', text: 'x,y\n1,2' }, { name: 'notes.txt', text: 'hello\n\nworld' }])
  // Not the shape the client writes: nothing is guessed.
  assert.deepEqual(documentsFrom('free text', ['a.csv']), [])
  assert.deepEqual(documentsFrom('[Attached: a.csv]\nx', ['a.csv', 'b.csv']), [])
  assert.deepEqual(documentsFrom(undefined, ['a.csv']), [])
})

test('safeName: no folders, no odd characters, never empty', () => {
  assert.equal(safeName('../../etc/passwd', 'f'), 'passwd')
  assert.equal(safeName('C:\\Users\\me\\sales Q1.csv', 'f'), 'sales Q1.csv')
  assert.equal(safeName('...hidden', 'f'), 'hidden')
  assert.equal(safeName('a;b|c.csv', 'f'), 'a_b_c.csv')
  assert.equal(safeName('', 'fallback.txt'), 'fallback.txt')
})

test('turnFiles: the turn\'s images and text documents, under unique names; other formats stay out', async () => {
  const files = await turnFiles({
    attachments: ['attachment:abc.png', 'attachment:gone.png'],
    textAttachments: ['data.csv', 'report.pdf', 'Data.csv'],
    docContext: '[Attached: data.csv]\na\n\n[Attached: report.pdf]\nextracted\n\n[Attached: Data.csv]\nb',
  }, store)
  assert.deepEqual(files.map((f) => f.name), ['image-1.png', 'data.csv', 'Data-2.csv'])
  assert.deepEqual(files[0].bytes, PNG)
  assert.equal(files[1].bytes.toString(), 'a')
  assert.deepEqual(await turnFiles(undefined, store), [])
})

const result = (over: Partial<SandboxRunResult>): SandboxRunResult => ({ ok: true, stdout: '', stderr: '', files: [], skipped: [], ...over })

test('describeRun: images to the store and the reply, text files back to the model, the rest named', async () => {
  const big = 'x'.repeat(9000)
  const r = await describeRun(result({
    stdout: '12\n',
    files: [{ name: 'chart.png', bytes: PNG }, { name: 'out.csv', bytes: Buffer.from('a,b') }, { name: 'big.txt', bytes: Buffer.from(big) }],
    skipped: ['evil.exe'],
  }), store)
  assert.deepEqual(r.files, [`attachment:${'0'.repeat(64)}.png`])
  assert.match(r.result, /^Output:\n12/)
  assert.match(r.result, /out\.csv:\na,b/)
  assert.match(r.result, /\[cut off: 9000 bytes in all\]/)
  assert.match(r.result, /Shown to the user in the chat: chart\.png/)
  assert.match(r.result, /Not returned .*evil\.exe/)
})

test('describeRun: a Python error, and a run with nothing to say', async () => {
  assert.match((await describeRun(result({ ok: false, error: 'ZeroDivisionError: division by zero' }), store)).result, /Python error:\nZeroDivisionError/)
  assert.match((await describeRun(result({}), store)).result, /no output; use print\(\)/)
})

test('describeRun: an image the store could not keep is not claimed as shown', async () => {
  const r = await describeRun(result({ files: [{ name: 'c.png', bytes: PNG }] }), { save: async (u: string[]) => u })
  assert.deepEqual(r.files, [])
  assert.match(r.result, /could not be saved/)
})

test('sandboxTurn: the turn\'s files go in with its first run only, and again into a fresh sandbox', async () => {
  const calls: SandboxFile[][] = []
  let warm = false
  const manager = {
    has: () => warm,
    run: async (_c: string, _code: string, files: SandboxFile[]) => { calls.push(files); warm = true; return result({ stdout: 'ok' }) },
  } as unknown as SandboxManager
  const turn = sandboxTurn({ convId: 'c1', manager, store, userMessage: () => ({ attachments: ['attachment:abc.png'], textAttachments: [], docContext: undefined }) })
  const ac = new AbortController()
  await turn.run({ code: 'a' }, ac.signal)
  await turn.run({ code: 'b' }, ac.signal)
  warm = false // the sandbox was killed (a timeout)
  await turn.run({ code: 'c' }, ac.signal)
  assert.deepEqual(calls.map((f) => f.length), [1, 0, 1])
})

test('sandboxTurn: empty code, and a sandbox failure, come back as the tool\'s error text', async () => {
  const manager = { has: () => false, run: async () => { throw new SandboxError('timeout', 'The code ran longer than 60 seconds and was stopped.') } } as unknown as SandboxManager
  const turn = sandboxTurn({ convId: 'c1', manager, store, userMessage: () => undefined })
  const ac = new AbortController()
  assert.match((await turn.run({}, ac.signal)).result, /needs a non-empty `code`/)
  assert.match((await turn.run({ code: 'while True: pass' }, ac.signal)).result, /^Error: The code ran longer .* Variables from earlier runs are gone\.$/)
})
