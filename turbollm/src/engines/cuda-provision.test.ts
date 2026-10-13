import { test } from 'node:test'
import assert from 'node:assert/strict'
import { majorMinor, cmpMajorMinor, pickCudaVersion } from './cuda-provision'
import { parseComputeCaps, parseDriverMaxCuda } from './nvidia-smi'

test('parseComputeCaps: one value per GPU line, junk skipped', () => {
  assert.deepEqual(parseComputeCaps('12.0\n'), [12])
  assert.deepEqual(parseComputeCaps('8.9\r\n6.1\r\n'), [8.9, 6.1])
  assert.deepEqual(parseComputeCaps('[N/A]\n'), [])
})

test('parseDriverMaxCuda: reads both the classic and the 600-series nvidia-smi header', () => {
  assert.equal(parseDriverMaxCuda('| NVIDIA-SMI 580.95.05   Driver Version: 580.95.05   CUDA Version: 13.0 |'), '13.0')
  assert.equal(parseDriverMaxCuda('| NVIDIA-SMI 615.71.09   KMD Version: 615.71.09   CUDA UMD Version: 13.4 |'), '13.4')
  assert.equal(parseDriverMaxCuda('NVIDIA-SMI has failed because it could not communicate with the driver'), null)
})

test('majorMinor: takes the first two components', () => {
  assert.equal(majorMinor('13.0.1'), '13.0')
  assert.equal(majorMinor('12.6.85'), '12.6')
  assert.equal(majorMinor('13'), '13.0')
})

test('cmpMajorMinor: orders by major then minor', () => {
  assert.ok(cmpMajorMinor('12.8', '13.0') < 0)
  assert.ok(cmpMajorMinor('13.0', '12.8') > 0)
  assert.equal(cmpMajorMinor('12.6', '12.6'), 0)
  assert.ok(cmpMajorMinor('12.6', '12.8') < 0)
})

const KNOWN = ['13.0.1', '13.0.0', '12.8.1', '12.6.3', '12.4.1']

test('pickCudaVersion: newest version the driver supports', () => {
  // Driver maxes at 13.0 → newest 13.0.x is fine.
  assert.equal(pickCudaVersion('13.0', KNOWN), '13.0.1')
  // Driver maxes at 12.8 → skip the 13.0 entries, take 12.8.1.
  assert.equal(pickCudaVersion('12.8', KNOWN), '12.8.1')
  // Driver maxes at 12.6 → 12.6.3.
  assert.equal(pickCudaVersion('12.6', KNOWN), '12.6.3')
})

test('pickCudaVersion: handles a driver newer than anything we know (takes newest known)', () => {
  assert.equal(pickCudaVersion('99.9', KNOWN), '13.0.1')
})

test('pickCudaVersion: driver older than all known → oldest known (best effort)', () => {
  assert.equal(pickCudaVersion('11.0', KNOWN), '12.4.1')
})

test('pickCudaVersion: unknown driver → newest known', () => {
  assert.equal(pickCudaVersion(null, KNOWN), '13.0.1')
})

test('pickCudaVersion: accepts a full driver-max like "13.0.88"', () => {
  assert.equal(pickCudaVersion('13.0.88', KNOWN), '13.0.1')
})
