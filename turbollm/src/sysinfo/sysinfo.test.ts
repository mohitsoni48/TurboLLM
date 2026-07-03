import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRocmSmi } from './sysinfo'

// rocm-smi --showmeminfo vram --json output for an RX 7900 XTX (24GB). The WMI
// AdapterRAM fallback would cap this at ~4GB; rocm-smi reports the true total.
const memJson = JSON.stringify({
  card0: {
    'VRAM Total Memory (B)': '25753026560',
    'VRAM Total Used Memory (B)': '1234567890',
  },
})
const nameJson = JSON.stringify({
  card0: { 'Card Series': 'Radeon RX 7900 XTX', 'Card Model': '0x744c' },
})

test('parseRocmSmi: single AMD card reports true 24GB VRAM', () => {
  const gpus = parseRocmSmi(memJson, nameJson)
  assert.equal(gpus.length, 1)
  assert.equal(gpus[0].vendor, 'amd')
  assert.equal(gpus[0].name, 'Radeon RX 7900 XTX')
  // 25753026560 bytes / 1e6 ≈ 25753 MB (~24 GiB), NOT the 4GB WMI cap.
  assert.equal(gpus[0].vramMb, 25753)
  assert.ok(gpus[0].vramMb > 20000, 'must be well above the 4GB AdapterRAM cap')
})

test('parseRocmSmi: falls back to a generic name when productname is absent', () => {
  const gpus = parseRocmSmi(memJson)
  assert.equal(gpus.length, 1)
  assert.equal(gpus[0].vendor, 'amd')
  assert.equal(gpus[0].name, 'AMD Radeon GPU')
  assert.equal(gpus[0].vramMb, 25753)
})

test('parseRocmSmi: multiple AMD cards each parse', () => {
  const multiMem = JSON.stringify({
    card0: { 'VRAM Total Memory (B)': '25753026560' },
    card1: { 'VRAM Total Memory (B)': '25753026560' },
  })
  const gpus = parseRocmSmi(multiMem)
  assert.equal(gpus.length, 2)
  assert.equal(gpus[0].vramMb, 25753)
  assert.equal(gpus[1].vramMb, 25753)
  assert.ok(gpus.every((g) => g.vendor === 'amd'))
})

test('parseRocmSmi: cards reporting zero/unknown VRAM are skipped', () => {
  const badMem = JSON.stringify({
    card0: { 'VRAM Total Memory (B)': '0' },
    card1: { 'Some Other Field': 'x' },
  })
  assert.equal(parseRocmSmi(badMem).length, 0)
})
