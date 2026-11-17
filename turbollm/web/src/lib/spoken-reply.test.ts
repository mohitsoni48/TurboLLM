// When a send asks for its reply as speech: a recording sent as audio, to this machine's own model, which answers aloud.
import { describe, expect, it } from 'vitest'
import { asksForSpokenReply, MAX_SPOKEN_TURN_MS } from './spoken-reply'

describe('asksForSpokenReply', () => {
  it('is true only when the model answers aloud, the model is local, and the message carries a recording sent as audio', () => {
    expect(asksForSpokenReply({ audioOut: true }, false, ['data:audio/wav;base64,AA'])).toBe(true)
    expect(asksForSpokenReply({ audioOut: true }, false, [...Array(3)].map(() => 'data:audio/wav;base64,AA'))).toBe(true)
  })

  it('is false without a recording: a typed message is the ordinary text turn', () => {
    expect(asksForSpokenReply({ audioOut: true }, false, [])).toBe(false)
  })

  it('is false for a model that does not answer aloud, however it is described, and for no model', () => {
    expect(asksForSpokenReply({}, false, ['data:audio/wav;base64,AA'])).toBe(false)
    expect(asksForSpokenReply({ audioOut: false }, false, ['data:audio/wav;base64,AA'])).toBe(false)
    expect(asksForSpokenReply(undefined, false, ['data:audio/wav;base64,AA'])).toBe(false)
    expect(asksForSpokenReply(null, false, ['data:audio/wav;base64,AA'])).toBe(false)
  })

  it('is false when the daemon would refuse a spoken reply: an image beside the recording, or a clip that is not a WAV', () => {
    expect(asksForSpokenReply({ audioOut: true }, false, ['data:audio/wav;base64,AA'], ['data:image/png;base64,AA'])).toBe(false)
    expect(asksForSpokenReply({ audioOut: true }, false, ['data:audio/mpeg;base64,AA'])).toBe(false)
    expect(asksForSpokenReply({ audioOut: true }, false, ['data:audio/wav;base64,AA', 'data:audio/mpeg;base64,AA'])).toBe(false)
  })

  it('is false when the recordings total more than the daemon reads in one turn, and true up to it', () => {
    const clips = ['data:audio/wav;base64,AA', 'data:audio/wav;base64,AA']
    expect(asksForSpokenReply({ audioOut: true }, false, clips, [], MAX_SPOKEN_TURN_MS)).toBe(true)
    expect(asksForSpokenReply({ audioOut: true }, false, clips, [], MAX_SPOKEN_TURN_MS + 1)).toBe(false)
    expect(asksForSpokenReply({ audioOut: true }, false, clips, [], 6 * 60_000)).toBe(false)
    // A recorder that ran to its own five-minute stop sends a clip a little over it, which is still answered.
    expect(asksForSpokenReply({ audioOut: true }, false, ['data:audio/wav;base64,AA'], [], 300_400)).toBe(true)
  })

  it('is false for a linked machine\'s model, which this machine\'s status says nothing about', () => {
    expect(asksForSpokenReply({ audioOut: true }, true, ['data:audio/wav;base64,AA'])).toBe(false)
  })
})
