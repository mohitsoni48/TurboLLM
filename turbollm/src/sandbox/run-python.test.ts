import test from 'node:test'
import assert from 'node:assert/strict'
import { chatFilesBytes, csvHasFormulaCells, describeRun, documentsFrom, filesFor, imageType, pythonError, RESULT_MAX_CHARS, resultBudget, RUN_PYTHON_TOOL, safeName, sandboxTurn, turnFiles } from './run-python'
import type { SandboxManager } from './sandbox-manager'
import { SandboxError, type SandboxFile, type SandboxRunResult } from './sandbox-process'

const PNG = Buffer.from('89504e470d0a1a0a', 'hex')
/** Stored files by reference, for the fake store's read. */
const STORED: Record<string, Buffer> = {}
const store = {
  read: async (a: string) => STORED[a] ?? null,
  inline: async (a: string) => (a === 'attachment:abc.png' ? `data:image/png;base64,${PNG.toString('base64')}` : a.startsWith('data:') ? a : null),
  save: async (urls: string[]) => urls.map((u) => (u.startsWith('data:image/') ? `attachment:${'0'.repeat(64)}.png` : u)),
  saveFile: async (_bytes: Buffer, ext: string) => `attachment:${'1'.repeat(64)}.${ext}`,
  size: () => 0,
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

test('turnFiles: images and text documents, under unique names; other formats stay out', async () => {
  const files = await turnFiles([{
    attachments: ['attachment:abc.png', 'attachment:gone.png'],
    textAttachments: ['data.csv', 'report.pdf', 'Data.csv'],
    docContext: '[Attached: data.csv]\na\n\n[Attached: report.pdf]\nextracted\n\n[Attached: Data.csv]\nb',
  }], store)
  assert.deepEqual(files.map((f) => f.name), ['image-1.png', 'data.csv', 'Data-2.csv'])
  assert.deepEqual(files[0].bytes, PNG)
  assert.equal(files[1].bytes.toString(), 'a')
  assert.deepEqual(await turnFiles([], store), [])
})

test('turnFiles: across the chat, a name sent again is the newer file, and images are numbered in order', async () => {
  const files = await turnFiles([
    { attachments: ['attachment:abc.png'], textAttachments: ['sales.csv', 'notes.txt'], docContext: '[Attached: sales.csv]\nold\n\n[Attached: notes.txt]\nn' },
    { attachments: [], textAttachments: [], docContext: undefined },
    { attachments: ['attachment:abc.png'], textAttachments: ['sales.csv'], docContext: '[Attached: sales.csv]\nnew' },
  ], store)
  assert.deepEqual(files.map((f) => f.name), ['image-1.png', 'notes.txt', 'image-2.png', 'sales.csv'])
  assert.equal(files.find((f) => f.name === 'sales.csv')!.bytes.toString(), 'new')
})

test('turnFiles: over 20 files, the newest are the ones sent', async () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ attachments: [], textAttachments: [`f${i}.txt`], docContext: `[Attached: f${i}.txt]\n${i}` }))
  const names = (await turnFiles(rows, store)).map((f) => f.name)
  assert.equal(names.length, 20)
  assert.equal(names[0], 'f5.txt')
  assert.equal(names[19], 'f24.txt')
})

const user = (name: string) => ({ role: 'user' as const, toolCalls: [], attachments: [], textAttachments: [name], docContext: `[Attached: ${name}]\nx` })
const reply = (ran: boolean) => ({ role: 'assistant' as const, toolCalls: ran ? [{ id: 't', name: 'run_python', args: {} }] : [], attachments: [], textAttachments: [] })

test('filesFor: a fresh sandbox gets every row, replies included; a warm one only the user rows since the last run_python call', () => {
  // The real chat this came from: sales.csv in turn 1, a run, and a follow-up with no attachment after the sandbox
  // closed when idle. The follow-up's run must still find sales.csv.
  const rows = [user('sales.csv'), reply(true), user('extra.csv'), reply(false), user('q.txt')] as never[]
  const names = (r: ReturnType<typeof filesFor>) => r.map((x) => (x.role === 'user' ? x.textAttachments![0] : `reply:${x.toolCalls.length}`))
  assert.deepEqual(names(filesFor(rows, true)), ['sales.csv', 'reply:1', 'extra.csv', 'reply:0', 'q.txt'])
  assert.deepEqual(names(filesFor(rows, false)), ['extra.csv', 'q.txt'])
  assert.deepEqual(names(filesFor([user('a.csv')] as never[], false)), ['a.csv'])
})

// A file earlier code made (cleaned.csv) was lost when the sandbox closed: the next run's code could not open it.
test('turnFiles: a fresh sandbox gets back the files earlier runs made, the newest version of each name winning', async () => {
  const ref = (c: string, ext: string) => `attachment:${c.repeat(64)}.${ext}`
  STORED[ref('2', 'csv')] = Buffer.from('v1')
  STORED[ref('3', 'csv')] = Buffer.from('v2')
  STORED[ref('4', 'png')] = PNG
  STORED[ref('5', 'json')] = Buffer.from('{}')
  const ran = (outputs: Array<{ name: string; file: string }>, name = 'run_python') =>
    ({ id: 't', name, args: {}, outputs: outputs.map((o) => ({ ...o, size: 1 })) })
  const rows = [
    user('sales.csv'),
    { role: 'assistant' as const, attachments: [ref('4', 'png')], textAttachments: [], toolCalls: [
      ran([{ name: 'cleaned.csv', file: ref('2', 'csv') }, { name: 'chart.png', file: ref('4', 'png') }]),
      ran([{ name: 'cleaned.csv', file: ref('3', 'csv') }, { name: '../evil/sales.csv', file: ref('5', 'json') }]),
      ran([{ name: 'other.json', file: ref('5', 'json') }], 'web_search'),
      ran([{ name: 'gone.txt', file: ref('6', 'txt') }]),
    ] },
  ] as never[]
  const files = await turnFiles(rows, store)
  assert.deepEqual(files.map((f) => [f.name, f.bytes.toString('hex')]), [
    ['chart.png', PNG.toString('hex')],
    ['cleaned.csv', Buffer.from('v2').toString('hex')],
    ['sales.csv', Buffer.from('{}').toString('hex')],
  ], 'the second run\'s cleaned.csv; the code\'s sales.csv (no folders) over the user\'s older one; not another tool\'s; a gone file left out; the chart not counted as image-1')
  // A user who attaches a new version after the run wins it back.
  const again = await turnFiles([...rows, user('cleaned.csv')] as never[], store)
  assert.equal(again.find((f) => f.name === 'cleaned.csv')!.bytes.toString(), 'x')
})

const result = (over: Partial<SandboxRunResult>): SandboxRunResult => ({ ok: true, stdout: '', stderr: '', files: [], skipped: [], ...over })

test('describeRun: images shown, text files given to download and back to the model, the rest named', async () => {
  const big = 'x'.repeat(9000)
  const r = await describeRun(result({
    stdout: '12\n',
    files: [{ name: 'chart.png', bytes: PNG }, { name: 'out.csv', bytes: Buffer.from('a,b') }, { name: 'big.txt', bytes: Buffer.from(big) }],
    skipped: ['evil.exe'],
  }), store)
  assert.deepEqual(r.files, [`attachment:${'0'.repeat(64)}.png`, `attachment:${'1'.repeat(64)}.csv`, `attachment:${'1'.repeat(64)}.txt`])
  assert.deepEqual(r.outputs, [
    { name: 'chart.png', file: `attachment:${'0'.repeat(64)}.png`, size: PNG.length },
    { name: 'out.csv', file: `attachment:${'1'.repeat(64)}.csv`, size: 3 },
    { name: 'big.txt', file: `attachment:${'1'.repeat(64)}.txt`, size: 9000 },
  ])
  assert.match(r.result, /Given to the user to download: out\.csv, big\.txt/)
  assert.match(r.result, /^Output:\n12/)
  assert.match(r.result, /out\.csv:\na,b/)
  assert.match(r.result, /\[cut off: 9000 characters in all\]/)
  assert.match(r.result, /Shown to the user in the chat: chart\.png/)
  assert.match(r.result, /Not returned .*evil\.exe/)
})

// Found attacking run_python by hand: 10 MB printed and 25 CSVs of 1 MB each came back as 230,000 characters, the engine
// refused the request (171,235 tokens against an 8,192 context) and the reply was empty.
test('describeRun: the whole result stays within 20,000 characters, and files that did not fit are named', async () => {
  const csv = Buffer.from('x,y\n'.repeat(250_000))
  const r = await describeRun(result({
    stdout: `${'A'.repeat(64 * 1024)}\n[output cut off]\n`,
    files: Array.from({ length: 20 }, (_, i) => ({ name: `part${i}.csv`, bytes: csv })),
    skipped: ['part20.csv', 'huge.png'],
  }), store)
  assert.ok(r.result.length <= 20_000 + 60, `${r.result.length} characters`)
  assert.match(r.result, /^Output:\nA{8000}\n\[cut off: more than 65536 characters in all\]/)
  assert.match(r.result, /part0\.csv:\nx,y/)
  assert.match(r.result, /Not included, the result would be too long: (part\d+\.csv, )*part19\.csv\. Read what you need from them in another run and print it\./)
  assert.match(r.result, /Not returned \(.*25 MB each\): part20\.csv, huge\.png$/)
})

// The same run capped at 20,000 characters still did not fit Gemma's 8,192-token context: 16,620 characters of "A"s and
// "x,y" came to 11,514 tokens with the chat. The budget follows the loaded model's context.
test('resultBudget: half the context in characters, at most 20,000; and an 8K model gets a result that fits', async () => {
  assert.equal(resultBudget(8192), 4096)
  assert.equal(resultBudget(32_768), 16_384)
  assert.equal(resultBudget(131_072), 20_000)
  assert.equal(resultBudget(undefined), 20_000)
  assert.equal(resultBudget(1024), 2000)
  const csv = Buffer.from('x,y\n'.repeat(250_000))
  const r = await describeRun(result({
    stdout: `${'A'.repeat(64 * 1024)}\n[output cut off]\n`,
    files: Array.from({ length: 20 }, (_, i) => ({ name: `part${i}.csv`, bytes: csv })),
    skipped: ['part20.csv', 'huge.png'],
  }), store, resultBudget(8192))
  assert.ok(r.result.length <= 4096 + 60, `${r.result.length} characters`)
  assert.match(r.result, /Not included, the result would be too long/)
})

// Found attacking run_python by hand: 10,000,001 characters printed reached the model as "[cut off: 65553 characters
// in all]", the length of what the host kept plus its own note.
test('describeRun: printed text the host already cut is said to be longer than what was kept, not that long', async () => {
  const hostCut = (s: string) => result({ stdout: `${s}\n[output cut off]\n`, stderr: `${s}\n[output cut off]\n` })
  const big = await describeRun(hostCut('A'.repeat(64 * 1024)), store)
  assert.match(big.result, /^Output:\nA{8000}\n\[cut off: more than 65536 characters in all\]/)
  assert.match(big.result, /Warnings:\nA{2000}\n\[cut off: more than 65536 characters in all\]/)
  assert.doesNotMatch(big.result, /65553/)
  // Kept whole when it fits: the host's own note then tells the model.
  assert.match((await describeRun(hostCut('A'.repeat(100)), store)).result, /^Output:\nA{100}\n\[output cut off\]/)
  // A file is never cut by the host, so a file ending with that note keeps its exact length.
  const file = Buffer.from(`${'x'.repeat(9000)}\n[output cut off]`)
  const f = await describeRun(result({ files: [{ name: 'log.txt', bytes: file }] }), store)
  assert.match(f.result, new RegExp(`\\[cut off: ${file.length} characters in all\\]`))
})

test('describeRun: a Python error, and a run with nothing to say', async () => {
  assert.match((await describeRun(result({ ok: false, error: 'ZeroDivisionError: division by zero' }), store)).result, /Python error:\nZeroDivisionError/)
  assert.match((await describeRun(result({}), store)).result, /no output; use print\(\)/)
})

// The exact text Pyodide 0.29.5 gave Gemma 4 E4B for `from scipy.stats import linregress` in a real chat.
test('describeRun: a module the runtime does not ship is not sent to micropip', async () => {
  const error = [
    '    coroutine = eval(self.code, globals, locals)',
    '  File "<exec>", line 4, in <module>',
    "ModuleNotFoundError: No module named 'scipy'",
    "The module 'scipy' is included in the Pyodide distribution, but it is not installed.",
    'You can install it by calling:',
    '  await micropip.install("scipy") in Python, or',
    '  await pyodide.loadPackage("scipy") in JavaScript',
  ].join('\n')
  const r = (await describeRun(result({ ok: false, error }), store)).result
  assert.match(r, /No module named 'scipy'\n'scipy' cannot be installed: the sandbox has no network/)
  assert.match(r, /numpy, pandas, matplotlib, Pillow and sympy/)
  assert.doesNotMatch(r, /micropip|loadPackage/)
  assert.match(pythonError("ModuleNotFoundError: No module named 'sklearn.linear_model'"), /'sklearn' cannot be installed/)
  assert.equal(pythonError('ZeroDivisionError: division by zero'), 'ZeroDivisionError: division by zero')
})

// Found attacking run_python by hand: a "chart.png" holding a web page with a <script>, and a "logo.png" holding an SVG
// with onload, were stored and shown as images. Served as image/png with nosniff, nothing ran; they are no longer kept.
test('describeRun: a .png or .jpg that is not really one is not stored or shown', async () => {
  const saved: string[] = []
  const counting = { ...store, save: async (u: string[]) => { saved.push(...u); return u.map(() => `attachment:${'0'.repeat(64)}.png`) } }
  const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex')
  const r = await describeRun(result({ files: [
    { name: 'chart.png', bytes: Buffer.from("<html><body><script>alert('x')</script></body></html>") },
    { name: 'logo.png', bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>') },
    { name: 'photo.png', bytes: JPEG },
    { name: 'real.png', bytes: PNG },
  ] }), counting)
  assert.match(r.result, /chart\.png is not a PNG or JPEG image, so it was not shown\./)
  assert.match(r.result, /logo\.png is not a PNG or JPEG image/)
  assert.match(r.result, /Shown to the user in the chat: photo\.png, real\.png/)
  assert.deepEqual(saved.map((u) => u.slice(0, u.indexOf(';'))), ['data:image/jpeg', 'data:image/png'], 'the bytes decide the type, not the name')
  assert.equal(imageType(Buffer.from('89504e47', 'hex')), null, 'a cut-off signature is not a PNG')
})

test('describeRun: an image the store could not keep is not claimed as shown', async () => {
  const r = await describeRun(result({ files: [{ name: 'c.png', bytes: PNG }] }), { save: async (u: string[]) => u, saveFile: async () => null })
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
  const turn = sandboxTurn({ convId: 'c1', manager, store, history: () => [{ role: 'user', toolCalls: [], attachments: ['attachment:abc.png'], textAttachments: [], docContext: undefined }] })
  const ac = new AbortController()
  const first = await turn.run({ code: 'a' }, ac.signal)
  await turn.run({ code: 'b' }, ac.signal)
  warm = false // the sandbox was killed (a timeout)
  const after = await turn.run({ code: 'c' }, ac.signal)
  assert.deepEqual(calls.map((f) => f.length), [1, 0, 1])
  // The chat's first run is not a "new sandbox" to the model; the one after the kill is.
  assert.doesNotMatch(first.result, /new sandbox/)
  assert.match(after.result, /^This run started a new sandbox: variables from earlier runs are gone\. The files of this chat are back in the folder: image-1\.png\./)
})

test('sandboxTurn: a follow-up after the sandbox closed gets the chat\'s earlier files, and is told it is a new sandbox', async () => {
  const calls: SandboxFile[][] = []
  const manager = { has: () => false, run: async (_c: string, _code: string, files: SandboxFile[]) => { calls.push(files); return result({ stdout: '51800' }) } } as unknown as SandboxManager
  const history = [user('sales.csv'), reply(true), { role: 'user', toolCalls: [], attachments: [], textAttachments: [], docContext: undefined }] as never[]
  const r = await sandboxTurn({ convId: 'c1', manager, store, history: () => history }).run({ code: 'print(1)' }, new AbortController().signal)
  assert.deepEqual(calls[0].map((f) => f.name), ['sales.csv'])
  assert.match(r.result, /new sandbox.*back in the folder: sales\.csv\./)
})

test('sandboxTurn: empty code, and a sandbox failure, come back as the tool\'s error text', async () => {
  const manager = { has: () => false, run: async () => { throw new SandboxError('timeout', 'The code ran longer than 60 seconds and was stopped.') } } as unknown as SandboxManager
  const turn = sandboxTurn({ convId: 'c1', manager, store, history: () => [] })
  const ac = new AbortController()
  assert.match((await turn.run({}, ac.signal)).result, /needs a non-empty `code`/)
  assert.match((await turn.run({ code: 'while True: pass' }, ac.signal)).result, /^Error: The code ran longer .* Variables from earlier runs are gone\.$/)
  // A process that ended on its own (Deno.exit, a crash) says the same: the next run is a new sandbox.
  const crashed = { has: () => false, run: async () => { throw new SandboxError('crashed', 'The sandbox stopped unexpectedly.') } } as unknown as SandboxManager
  assert.match((await sandboxTurn({ convId: 'c1', manager: crashed, store, history: () => [] }).run({ code: 'x' }, ac.signal)).result, /^Error: The sandbox stopped unexpectedly\. Variables from earlier runs are gone\.$/)
})

test('csvHasFormulaCells: a cell a spreadsheet may run, quoted or not, but not a plain number', () => {
  for (const csv of ['a\n=SUM(A1)', 'a,@x', 'x,"=1"', 'a,b\r\n+cmd,1', 'a,\t=1', 'a,"say ""hi""",-x', '=HYPERLINK("http://x","y")', 'a,"=1'])
    assert.equal(csvHasFormulaCells(csv), true, JSON.stringify(csv))
  for (const csv of ['a,b\n1,2', 'n\n-5\n+3.2\n-1e5\n.5', 'a,-,+,=,@', 'x,"a=1"', '', 'note\n"hello, =world"', 'a,b\r\n1,2\r\n'])
    assert.equal(csvHasFormulaCells(csv), false, JSON.stringify(csv))
})

test('csvHasFormulaCells: a byte order mark before the first cell, and `;` as the separator, do not hide a formula', () => {
  for (const csv of ['﻿=1+1', '﻿a\n=1+1', 'a;=1+1', 'a;"=1"\n1;2', 'a,b;@x'])
    assert.equal(csvHasFormulaCells(csv), true, JSON.stringify(csv))
  for (const csv of ['﻿a,b\n1,2', 'a;b\n1;2', 'n;-5;+3.2', '"a;=1"'])
    assert.equal(csvHasFormulaCells(csv), false, JSON.stringify(csv))
})

test('describeRun: a CSV with formula cells is marked; JSON and text are never scanned', async () => {
  const r = await describeRun(result({ files: [
    { name: 'risky.csv', bytes: Buffer.from('a\n=1+1') },
    { name: 'safe.csv', bytes: Buffer.from('a\n-1') },
    { name: 'x.txt', bytes: Buffer.from('=1+1') },
  ] }), store)
  assert.deepEqual(r.outputs.map((o) => [o.name, o.formulaCells ?? false]), [['risky.csv', true], ['safe.csv', false], ['x.txt', false]])
})

test('describeRun: files beyond the chat\'s room are not kept, and both the model and the user are told', async () => {
  const r = await describeRun(result({ files: [
    { name: 'a.csv', bytes: Buffer.alloc(60, 'a') },
    { name: 'chart.png', bytes: Buffer.concat([PNG, Buffer.alloc(52)]) },
    { name: 'b.csv', bytes: Buffer.alloc(30, 'b') },
  ] }), store, RESULT_MAX_CHARS, 100)
  assert.deepEqual(r.outputs.map((o) => o.name), ['a.csv', 'b.csv'], 'the chart did not fit what was left; the smaller CSV after it did')
  assert.match(r.result, /Not kept for the user, this chat's files have reached 500 MB: chart\.png\. Deleting older messages with files makes room\./)
  assert.match(r.result, /a\.csv:\na{60}/, 'a CSV that was not kept still comes back to the model as text')
  const none = await describeRun(result({ files: [{ name: 'c.csv', bytes: Buffer.from('c') }] }), store, RESULT_MAX_CHARS, 0)
  assert.deepEqual(none.files, [])
  assert.match(none.result, /c\.csv:\nc/)
})

test('chatFilesBytes: each stored file once, however many rows name it, plus files not on a row yet', () => {
  const ref = (c: string, ext = 'png') => `attachment:${c.repeat(64)}.${ext}`
  const sizes: Record<string, number> = { [`${'a'.repeat(64)}.png`]: 10, [`${'b'.repeat(64)}.csv`]: 20, [`${'c'.repeat(64)}.json`]: 40 }
  const sized = { size: (id: string) => sizes[id] ?? null }
  const rows = [{ attachments: [ref('a'), 'data:image/png;base64,AAAA'] }, { attachments: [ref('a'), ref('b', 'csv')] }, { attachments: [ref('d')] }]
  assert.equal(chatFilesBytes(rows, [], sized), 30, 'a named twice counts once; an inline image and a gone file count nothing')
  assert.equal(chatFilesBytes(rows, [ref('c', 'json'), ref('b', 'csv')], sized), 70)
})

test('sandboxTurn: the chat\'s 500 MB counts what its rows name and what this turn already kept', async () => {
  const BIG = 300 * 1024 * 1024
  const old = `attachment:${'a'.repeat(64)}.png`
  const sized = { ...store, size: (id: string) => (id === old.slice('attachment:'.length) ? BIG : id.endsWith('.csv') ? BIG / 2 : null) }
  let warm = false
  const manager = {
    has: () => warm,
    run: async () => { warm = true; return result({ files: [{ name: 'out.csv', bytes: Buffer.alloc(8) }] }) },
  } as unknown as SandboxManager
  const turn = sandboxTurn({ convId: 'c1', manager, store: sized, history: () => [{ role: 'assistant', toolCalls: [], attachments: [old], textAttachments: [] }] })
  const first = await turn.run({ code: 'x' }, new AbortController().signal)
  assert.equal(first.files.length, 1, 'kept: 300 MB used, room left')
  const second = await turn.run({ code: 'x' }, new AbortController().signal)
  assert.equal(second.files.length, 1, 'the same bytes again: the store counts the stored CSV once')
  const full = { ...sized, saveFile: async (_b: Buffer, ext: string) => `attachment:${'e'.repeat(64)}.${ext}`, size: (id: string) => (id.startsWith('e') ? 250 * 1024 * 1024 : sized.size(id)) }
  const turn2 = sandboxTurn({ convId: 'c2', manager, store: full, history: () => [{ role: 'assistant', toolCalls: [], attachments: [old], textAttachments: [] }] })
  assert.equal((await turn2.run({ code: 'x' }, new AbortController().signal)).files.length, 1, '300 MB used: kept')
  const over = await turn2.run({ code: 'x' }, new AbortController().signal)
  assert.deepEqual(over.files, [], '300 MB on rows + 250 MB kept earlier this turn: no room')
  assert.match(over.result, /this chat's files have reached 500 MB: out\.csv/)
})
