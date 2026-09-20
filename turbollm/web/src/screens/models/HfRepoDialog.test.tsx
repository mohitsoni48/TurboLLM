// The VRAM-fit helpers this file owns, exercised directly (ADR-434 (h)).
//
// `CheckpointPicker` renders one fit dot per checkpoint folder using exactly these, so they
// are shared rather than reimplemented — these cases pin the two ends of the scale the picker
// depends on.
import { describe, it, expect } from 'vitest'
import { fileFit } from './HfRepoDialog'

describe('fileFit', () => {
  it('calls a file comfortably smaller than VRAM a fit', () => {
    expect(fileFit(8e9, 16000)).toBe('fits')
  })

  it('refuses to guess when the GPU VRAM is unknown', () => {
    expect(fileFit(1, undefined)).toBe('unknown')
  })
})
