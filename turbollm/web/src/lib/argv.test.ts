import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tokenizeExtraArgs } from './argv'

// GitHub #221. This mirrors the daemon-side suite in src/models/profile.gen.test.ts —
// the two implementations must stay in sync, so the same cases are asserted on both.
describe('tokenizeExtraArgs', () => {
  it('splits a flag and value typed as one entry (the issue #221 report)', () => {
    assert.deepEqual(tokenizeExtraArgs(['--load-mode dio']), ['--load-mode', 'dio'])
  })

  it('keeps a quoted value containing spaces as one token, quotes stripped', () => {
    assert.deepEqual(tokenizeExtraArgs(['--chat-template-file "C:\\my path\\t.jinja"']), [
      '--chat-template-file',
      'C:\\my path\\t.jinja',
    ])
    assert.deepEqual(tokenizeExtraArgs(["--grammar 'a b c'"]), ['--grammar', 'a b c'])
  })

  it('is idempotent — a second pass is a no-op', () => {
    const once = tokenizeExtraArgs(['--load-mode dio', '--chat-template-file "C:\\my path\\t.jinja"', '-dio', '--foo="a b"'])
    assert.deepEqual(tokenizeExtraArgs(once), once)
    assert.ok(once.includes('C:\\my path\\t.jinja'))
  })

  it('leaves an already-correct single-token entry untouched', () => {
    assert.deepEqual(tokenizeExtraArgs(['--no-mmap', '-dio', '--n-cpu-moe', '12']), ['--no-mmap', '-dio', '--n-cpu-moe', '12'])
  })

  it('preserves duplicate tokens — argv is a sequence, not a set', () => {
    assert.deepEqual(tokenizeExtraArgs(['--lora a.gguf --lora b.gguf']), ['--lora', 'a.gguf', '--lora', 'b.gguf'])
  })

  it('drops empty and whitespace-only entries', () => {
    assert.deepEqual(tokenizeExtraArgs(['', '   ', '--flash-attn on']), ['--flash-attn', 'on'])
    assert.deepEqual(tokenizeExtraArgs(undefined), [])
  })

  it('does not split a bare value entry that contains spaces', () => {
    assert.deepEqual(tokenizeExtraArgs(['--chat-template-file', 'C:\\my path\\t.jinja']), [
      '--chat-template-file',
      'C:\\my path\\t.jinja',
    ])
  })

  it('does not split a stop-string-shaped value (the control ChipListInput must not tokenize)', () => {
    // Guard for the ChipListInput regression this fix could introduce: stop strings go
    // through the NON-tokenizing path, but even if one reached here it must survive —
    // it does not start with '-'.
    assert.deepEqual(tokenizeExtraArgs(['END OF LINE']), ['END OF LINE'])
  })
})
