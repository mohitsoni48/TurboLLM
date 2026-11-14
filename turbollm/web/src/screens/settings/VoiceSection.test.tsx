import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SttModel, VoiceStatus } from '@contract/voice'
import { useVoiceStore } from '../../stores/voice'
import { VoiceSection, formatSize } from './VoiceSection'

const MB = 1024 ** 2
const mutations = {
  installServer: { mutate: vi.fn() },
  cancelInstall: { mutate: vi.fn() },
  removeServer: { mutate: vi.fn() },
  downloadModel: { mutate: vi.fn() },
  cancelDownload: { mutate: vi.fn() },
  deleteModel: { mutate: vi.fn() },
}
const voice: { data: VoiceStatus | undefined; isError: boolean } = { data: undefined, isError: false }
const save = { mutate: vi.fn(), isPending: false }
const settings: { speechToText?: { model: string; language: string; serverPath: string; gpu: boolean } } = {}
const tts = { available: true, voices: [] as { id: string; name: string; lang: string; local: boolean }[], speaking: null as string | null }
const speaker = { speak: vi.fn(), stop: vi.fn() }
const installer = { fn: null as (() => void) | null }

vi.mock('../../lib/voice/voice-queries', () => ({
  useVoiceStatus: () => voice,
  useVoiceSetup: () => mutations,
}))
vi.mock('../../lib/queries', () => ({
  useSettings: () => ({ query: { data: settings }, save }),
}))
vi.mock('../../lib/voice/use-tts', () => ({
  useTtsAvailable: () => tts.available,
  useAllTtsVoices: () => tts.voices,
  useSpeakingId: () => tts.speaking,
  // The real one: it reads the voice store the tests set.
  readAloudOptions: () => {
    const { ttsVoice, ttsRate, onlineVoices } = useVoiceStore.getState()
    return { voiceId: ttsVoice, rate: ttsRate, allowOnline: onlineVoices }
  },
}))
vi.mock('../../lib/voice/tts', () => ({
  speaker: { speak: (...a: unknown[]) => speaker.speak(...a), stop: () => speaker.stop() },
  ttsVoiceInstaller: () => installer.fn,
}))
vi.mock('../../components/ui/sonner', () => ({ toast: { error: vi.fn() } }))

const model = (id: string, o: Partial<SttModel> = {}): SttModel => ({
  id, label: id.toUpperCase(), sizeBytes: 100 * MB, multilingual: true, note: 'fast', installed: false, ...o,
})

function status(o: { server?: Partial<VoiceStatus['stt']['server']> } & Partial<Omit<VoiceStatus['stt'], 'server'>> = {}): VoiceStatus {
  const { server, ...rest } = o
  return {
    stt: {
      available: false, state: 'stopped', error: null,
      server: { source: null, version: '', installable: false, hint: null, customMissing: false, gpu: true, gpuError: null, installing: null, installError: null, ...server },
      model: 'tiny',
      models: [model('tiny', { installed: true }), model('base', { recommended: true }), model('small')],
      downloading: null, downloadError: null,
      ...rest,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  voice.data = status()
  voice.isError = false
  delete settings.speechToText
  tts.available = true
  tts.voices = []
  tts.speaking = null
  installer.fn = null
  useVoiceStore.setState({ audioMode: 'ask', autoSend: false, autoStop: true, readAloud: 'off', ttsVoice: '', ttsRate: 1, onlineVoices: false })
})

describe('formatSize', () => {
  it('uses whole MB below 1 GB and one-decimal GB above', () => {
    expect(formatSize(148 * MB)).toBe('148 MB')
    expect(formatSize(1024 ** 3)).toBe('1.0 GB')
    expect(formatSize(1.55 * 1024 ** 3)).toBe('1.6 GB')
  })
})

describe('VoiceSection engine', () => {
  it('installs whisper.cpp when nothing is installed and it can be', async () => {
    voice.data = status({ server: { installable: true } })
    render(<VoiceSection />)
    expect(screen.getByText('Not installed')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Install whisper.cpp' }))
    expect(mutations.installServer.mutate).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['android', /This build of the app was made without speech-to-text\./],
    ['build', /no ready-made build for this machine/],
    ['homebrew', /no ready-made macOS build/],
  ] as const)('shows the %s hint and no Install button', (hint, text) => {
    voice.data = status({ server: { hint } })
    render(<VoiceSection />)
    expect(screen.getByText(text)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Install whisper.cpp' })).toBeNull()
    expect(!!screen.queryByText('brew install whisper.cpp')).toBe(hint === 'homebrew')
  })

  it('shows install progress and cancels it', async () => {
    voice.data = status({ server: { installing: { phase: 'downloading', pct: 0.42 } } })
    render(<VoiceSection />)
    expect(screen.getByText('Downloading whisper.cpp…')).toBeTruthy()
    expect(screen.getByText('42%')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(mutations.cancelInstall.mutate).toHaveBeenCalledTimes(1)
  })

  it('says Unpacking with no percentage while extracting', () => {
    voice.data = status({ server: { installing: { phase: 'extracting', pct: -1 } } })
    render(<VoiceSection />)
    expect(screen.getByText('Unpacking…')).toBeTruthy()
    expect(screen.queryByText(/%/)).toBeNull()
  })

  it('shows a managed install with its build and removes it', async () => {
    voice.data = status({ server: { source: 'managed', version: 'b4567' } })
    render(<VoiceSection />)
    expect(screen.getByText('Installed by TurboLLM · build b4567')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(mutations.removeServer.mutate).toHaveBeenCalledTimes(1)
  })

  it('describes the other sources', () => {
    voice.data = status({ server: { source: 'system' } })
    const { unmount } = render(<VoiceSection />)
    expect(screen.getByText('Found on this machine')).toBeTruthy()
    unmount()
    voice.data = status({ server: { source: 'bundled' } })
    render(<VoiceSection />)
    expect(screen.getByText('Included with the app')).toBeTruthy()
  })

  it('shows an install error and a missing custom path', () => {
    voice.data = status({ server: { installError: 'Disk full', customMissing: true } })
    render(<VoiceSection />)
    expect(screen.getByText('Disk full')).toBeTruthy()
    expect(screen.getByText('There is no file at the path set below.')).toBeTruthy()
  })

  it('says it cannot be set up when the status is unreadable, with no model list', () => {
    voice.data = undefined
    voice.isError = true
    render(<VoiceSection />)
    expect(screen.getByText('Speech-to-text cannot be set up from this device.')).toBeTruthy()
    expect(screen.queryByText('Model')).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Spoken language' })).toBeNull()
  })

  it('shows Loading… before the first answer', () => {
    voice.data = undefined
    render(<VoiceSection />)
    expect(screen.getByText('Loading…')).toBeTruthy()
  })

  it('shows the last problem and the loading state', () => {
    voice.data = status({ error: 'Port busy', state: 'starting' })
    render(<VoiceSection />)
    expect(screen.getByText('Last problem: Port busy')).toBeTruthy()
    expect(screen.getByText('Loading the speech model…')).toBeTruthy()
  })
})

describe('VoiceSection models', () => {
  it('lists size and note, says English-only for a file of the user\'s own, with badges', () => {
    voice.data = status({
      models: [
        // A catalog model's name and note already say it is English only: the suffix would say it a third time.
        model('tiny', { installed: true, multilingual: false, note: 'English, and nothing else.' }),
        model('base', { recommended: true }),
        model('mine.bin', { installed: true, custom: true, multilingual: false, sizeBytes: 1.5 * 1024 ** 3, note: '' }),
      ],
    })
    render(<VoiceSection />)
    expect(screen.getByText('100 MB · English, and nothing else.')).toBeTruthy()
    expect(screen.getByText('100 MB · fast')).toBeTruthy()
    expect(screen.getByText('1.5 GB · English only')).toBeTruthy()
    expect(screen.getByText('Recommended')).toBeTruthy()
    expect(screen.getByText('Your file')).toBeTruthy()
  })

  it('downloads a model', async () => {
    render(<VoiceSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Download BASE' }))
    expect(mutations.downloadModel.mutate).toHaveBeenCalledWith('base', expect.anything())
  })

  it('disables the other Download buttons while one downloads, and cancels that one', async () => {
    voice.data = status({ downloading: { model: 'base', phase: 'downloading', pct: 0.5 } })
    render(<VoiceSection />)
    expect((screen.getByRole('button', { name: 'Download SMALL' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Download BASE' })).toBeNull()
    expect(screen.getByText('50%')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel downloading BASE' }))
    expect(mutations.cancelDownload.mutate).toHaveBeenCalledWith('base', expect.anything())
  })

  it('shows radios for installed models, checked for the one in use, and saves a new choice', async () => {
    voice.data = status({ models: [model('tiny', { installed: true }), model('base', { installed: true }), model('small')], model: 'tiny' })
    render(<VoiceSection />)
    expect((screen.getByRole('radio', { name: 'Use TINY' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('radio', { name: 'Use BASE' }) as HTMLInputElement).checked).toBe(false)
    expect(screen.queryByRole('radio', { name: 'Use SMALL' })).toBeNull()
    await userEvent.click(screen.getByRole('radio', { name: 'Use BASE' }))
    expect(save.mutate.mock.calls[0][0]).toEqual({ speechToText: { model: 'base' } })
  })

  it('deletes an installed model', async () => {
    render(<VoiceSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Delete TINY' }))
    expect(mutations.deleteModel.mutate).toHaveBeenCalledWith('tiny', expect.anything())
  })

  it('shows a download error under its own row only', () => {
    voice.data = status({ downloadError: { model: 'base', message: 'Checksum mismatch' } })
    render(<VoiceSection />)
    const rows = screen.getAllByRole('listitem')
    const withError = rows.filter((r) => within(r).queryByText('Checksum mismatch'))
    expect(withError).toHaveLength(1)
    expect(within(withError[0]).getByText('BASE')).toBeTruthy()
  })
})

describe('VoiceSection language, GPU and own binary', () => {
  it('lists Auto-detect first and saves a language', async () => {
    render(<VoiceSection />)
    const select = screen.getByRole('combobox', { name: 'Spoken language' }) as HTMLSelectElement
    expect(select.value).toBe('auto')
    expect(select.options[0].textContent).toBe('Auto-detect')
    expect(select.options[1].textContent).toBe('Afrikaans')
    await userEvent.selectOptions(select, 'de')
    expect(save.mutate.mock.calls[0][0]).toEqual({ speechToText: { language: 'de' } })
  })

  it('reflects the saved language', () => {
    settings.speechToText = { model: '', language: 'fr', serverPath: '', gpu: false }
    render(<VoiceSection />)
    expect((screen.getByRole('combobox', { name: 'Spoken language' }) as HTMLSelectElement).value).toBe('fr')
  })

  it('saves the GPU choice', async () => {
    render(<VoiceSection />)
    const box = screen.getByRole('checkbox', { name: /Use the GPU/ }) as HTMLInputElement
    expect(box.checked).toBe(false)
    await userEvent.click(box)
    expect(save.mutate.mock.calls[0][0]).toEqual({ speechToText: { gpu: true } })
  })

  it('keeps the own-binary panel closed by default, and Save disabled until the path changes', async () => {
    render(<VoiceSection />)
    expect(screen.queryByLabelText('Path to whisper-server')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Use my own whisper-server' }))
    const save1 = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save1.disabled).toBe(true)
    await userEvent.type(screen.getByLabelText('Path to whisper-server'), '  /opt/whisper-server ')
    expect(save1.disabled).toBe(false)
    await userEvent.click(save1)
    expect(save.mutate.mock.calls[0][0]).toEqual({ speechToText: { serverPath: '/opt/whisper-server' } })
  })

  it('opens the panel by default when a path is saved', () => {
    settings.speechToText = { model: '', language: 'auto', serverPath: '/usr/bin/ws', gpu: false }
    render(<VoiceSection />)
    const input = screen.getByLabelText('Path to whisper-server') as HTMLInputElement
    expect(input.value).toBe('/usr/bin/ws')
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('opens the panel when the custom path is missing', () => {
    voice.data = status({ server: { customMissing: true } })
    render(<VoiceSection />)
    expect(screen.getByLabelText('Path to whisper-server')).toBeTruthy()
  })
})

describe('VoiceSection voice messages', () => {
  it('updates the store from the select and both checkboxes', async () => {
    render(<VoiceSection />)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'When the model can hear audio' }), 'text')
    expect(useVoiceStore.getState().audioMode).toBe('text')
    await userEvent.click(screen.getByRole('checkbox', { name: /Stop recording when I stop talking/ }))
    expect(useVoiceStore.getState().autoStop).toBe(false)
    await userEvent.click(screen.getByRole('checkbox', { name: /Send as soon as I finish/ }))
    expect(useVoiceStore.getState().autoSend).toBe(true)
  })
})

describe('VoiceSection read aloud', () => {
  it('explains and disables the controls when the device has no voice', () => {
    tts.available = false
    render(<VoiceSection />)
    expect(screen.getByText(/no speech voice the browser can use/)).toBeTruthy()
    for (const name of ['Read replies aloud', 'Voice', 'Speed']) {
      expect((screen.getByLabelText(name) as HTMLInputElement).disabled).toBe(true)
    }
    expect((screen.getByRole('button', { name: 'Play a sample' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('lists voices and stores the chosen one', async () => {
    tts.voices = [{ id: 'v1', name: 'Anna', lang: 'de-DE', local: true }, { id: 'v2', name: 'Bob', lang: 'en-US', local: true }]
    render(<VoiceSection />)
    const select = screen.getByRole('combobox', { name: 'Voice' }) as HTMLSelectElement
    expect(select.value).toBe('')
    expect(within(select).getByText('Anna (de-DE)')).toBeTruthy()
    await userEvent.selectOptions(select, 'v2')
    expect(useVoiceStore.getState().ttsVoice).toBe('v2')
  })

  it('shows Automatic for a saved voice that is not in the list', () => {
    useVoiceStore.setState({ ttsVoice: 'gone' })
    tts.voices = [{ id: 'v1', name: 'Anna', lang: 'de-DE', local: true }]
    render(<VoiceSection />)
    expect((screen.getByRole('combobox', { name: 'Voice' }) as HTMLSelectElement).value).toBe('')
  })

  it('updates the read-aloud mode and the speed', async () => {
    render(<VoiceSection />)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Read replies aloud' }), 'always')
    expect(useVoiceStore.getState().readAloud).toBe('always')
    expect(screen.getByText('1.0×')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Speed'), { target: { value: '1.5' } })
    expect(useVoiceStore.getState().ttsRate).toBe(1.5)
  })

  it('plays a sample with the chosen voice and rate, and offers Stop while it speaks', async () => {
    useVoiceStore.setState({ ttsVoice: 'v1', ttsRate: 1.2 })
    tts.voices = [{ id: 'v1', name: 'Anna', lang: 'de-DE', local: true }]
    const { rerender } = render(<VoiceSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Play a sample' }))
    expect(speaker.speak).toHaveBeenCalledWith('voice-sample', 'So klingen die Antworten.', { voiceId: 'v1', rate: 1.2, allowOnline: false, language: 'de' })
    tts.speaking = 'voice-sample'
    rerender(<VoiceSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(speaker.stop).toHaveBeenCalledTimes(1)
  })
  it('lists, in the voice list, the online voices with a suffix once they are allowed', async () => {
    tts.voices = [
      { id: 'v1', name: 'Anna', lang: 'de-DE', local: true },
      { id: 'v2', name: 'Kyoko', lang: 'ja-JP', local: false },
    ]
    render(<VoiceSection />)
    const select = screen.getByRole('combobox', { name: 'Voice' }) as HTMLSelectElement
    expect(within(select).queryByText(/Kyoko/)).toBeNull()
    await userEvent.click(screen.getByRole('checkbox', { name: /Allow online voices/ }))
    expect(useVoiceStore.getState().onlineVoices).toBe(true)
    expect(localStorage.getItem('tllm.voice.onlineVoices')).toBe('true')
    expect(within(select).getByText('Kyoko (ja-JP) · online')).toBeTruthy()
    expect(within(select).getByText('Anna (de-DE)')).toBeTruthy()
  })

  it('offers "Allow online voices" only when the device lists both local and online voices', () => {
    const allow = () => screen.queryByRole('checkbox', { name: /Allow online voices/ })
    tts.voices = [{ id: 'v1', name: 'Anna', lang: 'de-DE', local: true }]
    const a = render(<VoiceSection />)
    expect(allow()).toBeNull()
    a.unmount()
    tts.voices = [{ id: 'v2', name: 'Kyoko', lang: 'ja-JP', local: false }]
    const b = render(<VoiceSection />)
    expect(allow()).toBeNull()
    b.unmount()
    tts.voices = [{ id: 'v1', name: 'Anna', lang: 'de-DE', local: true }, { id: 'v2', name: 'Kyoko', lang: 'ja-JP', local: false }]
    render(<VoiceSection />)
    expect(allow()).toBeTruthy()
  })

  it('says which languages this device can read, by name, counting online ones only when allowed', () => {
    tts.voices = [
      { id: 'v1', name: 'Anna', lang: 'de-DE', local: true },
      { id: 'v2', name: 'Bob', lang: 'en-US', local: true },
      { id: 'v3', name: 'Carl', lang: 'en-GB', local: true },
      { id: 'v4', name: 'Kyoko', lang: 'ja-JP', local: false },
    ]
    render(<VoiceSection />)
    expect(screen.getByText(/This device can read English, German\./)).toBeTruthy()
    expect(screen.queryByText(/Japanese/, { selector: 'p' })).toBeNull()
  })

  it('names at most ten languages and counts the rest', () => {
    const langs = ['de', 'en', 'es', 'fr', 'it', 'pt', 'nl', 'pl', 'sv', 'tr', 'ru', 'ja']
    tts.voices = langs.map((l) => ({ id: l, name: l, lang: l, local: true }))
    render(<VoiceSection />)
    const line = screen.getByText(/This device can read/)
    expect(line.textContent).toMatch(/and 2 more\.$/)
    expect(line.textContent?.split(',').length).toBe(10)
  })

  it('shows no "can read" line when the voices name no language', () => {
    tts.voices = [{ id: 'v1', name: 'Anna', lang: '', local: true }]
    render(<VoiceSection />)
    expect(screen.queryByText(/This device can read/)).toBeNull()
    expect(screen.getByText('Anna (language not given)')).toBeTruthy()
  })

  it('offers "Get voices" only where the app can open voice downloads, and asks it to', async () => {
    const { unmount } = render(<VoiceSection />)
    expect(screen.queryByRole('button', { name: 'Get voices' })).toBeNull()
    expect(screen.getByText(/Voices come from this device/)).toBeTruthy()
    unmount()
    installer.fn = vi.fn()
    render(<VoiceSection />)
    expect(screen.getByText(/downloaded in your phone/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Get voices' }))
    expect(installer.fn).toHaveBeenCalledTimes(1)
  })

  it('plays a sample in the user\'s own language when no voice is chosen, and in English for one with no sample', async () => {
    tts.voices = [{ id: 'v1', name: 'Anna', lang: 'de-DE', local: true }]
    const { unmount } = render(<VoiceSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Play a sample' }))
    expect(speaker.speak).toHaveBeenLastCalledWith('voice-sample', 'This is how replies will sound.', expect.objectContaining({ language: 'en' }))
    unmount()
    useVoiceStore.setState({ ttsVoice: 'v9' })
    tts.voices = [{ id: 'v9', name: 'Zed', lang: 'xx-XX', local: true }]
    render(<VoiceSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Play a sample' }))
    expect(speaker.speak).toHaveBeenLastCalledWith('voice-sample', 'This is how replies will sound.', expect.objectContaining({ language: 'en' }))
  })

  it('plays the Portuguese sample, with its language, for a chosen pt-BR voice', async () => {
    useVoiceStore.setState({ ttsVoice: 'v1', onlineVoices: true })
    tts.voices = [{ id: 'v1', name: 'Luciana', lang: 'pt-BR', local: true }]
    render(<VoiceSection />)
    await userEvent.click(screen.getByRole('button', { name: 'Play a sample' }))
    expect(speaker.speak).toHaveBeenCalledWith('voice-sample', 'É assim que as respostas vão soar.', { voiceId: 'v1', rate: 1, allowOnline: true, language: 'pt' })
  })
})

describe('VoiceSection in the Android app', () => {
  const gpu = () => screen.queryByRole('checkbox', { name: /Use the GPU/ })
  const own = () => screen.queryByRole('button', { name: 'Use my own whisper-server' })
  const VULKAN = /Runs whisper on the phone.s GPU through Vulkan\./
  const DESKTOP = /Faster with the larger models, but it takes video memory from the chat model\./

  it('hides the own-binary choice for the bundled server and for the android hint', () => {
    voice.data = status({ server: { source: 'bundled' } })
    const a = render(<VoiceSection />)
    expect(own()).toBeNull()
    a.unmount()
    voice.data = status({ server: { hint: 'android', gpu: false } })
    render(<VoiceSection />)
    expect(own()).toBeNull()
  })

  it('hides the GPU row for a bundled server that cannot use the GPU', () => {
    voice.data = status({ server: { source: 'bundled', gpu: false } })
    render(<VoiceSection />)
    expect(gpu()).toBeNull()
  })

  it('shows the GPU row with the Vulkan description for a bundled server that can, and saves the choice', async () => {
    voice.data = status({ server: { source: 'bundled', gpu: true } })
    render(<VoiceSection />)
    const box = gpu() as HTMLInputElement
    expect(box).toBeTruthy()
    expect(box.checked).toBe(false)
    expect(screen.getByText(VULKAN)).toBeTruthy()
    expect(screen.queryByText(DESKTOP)).toBeNull()
    await userEvent.click(box)
    expect(save.mutate.mock.calls[0][0]).toEqual({ speechToText: { gpu: true } })
  })

  it('shows the GPU row with the video-memory description for a desktop install that can use it', () => {
    voice.data = status({ server: { source: 'managed', version: 'b1', gpu: true } })
    render(<VoiceSection />)
    expect(gpu()).toBeTruthy()
    expect(screen.getByText(DESKTOP)).toBeTruthy()
    expect(screen.queryByText(VULKAN)).toBeNull()
    expect(own()).toBeTruthy()
  })

  it.each(['managed', 'system', 'custom', 'bundled', null] as const)('has no GPU row when the server cannot use it (source %s)', (source) => {
    voice.data = status({ server: { source, gpu: false } })
    render(<VoiceSection />)
    expect(gpu()).toBeNull()
  })

  it('shows why the GPU was given up on, under the row, and nothing when there is no reason', () => {
    const why = 'whisper could not run on this device\'s GPU (boom). Speech-to-text is using the CPU.'
    voice.data = status({ server: { source: 'bundled', gpu: true, gpuError: why } })
    const a = render(<VoiceSection />)
    expect(screen.getByText(why)).toBeTruthy()
    a.unmount()
    voice.data = status({ server: { source: 'bundled', gpu: true, gpuError: null } })
    render(<VoiceSection />)
    expect(screen.queryByText(/could not run on this device/)).toBeNull()
  })

  it('keeps "Use my own whisper-server" for a bundled server when a path was saved, so it can be cleared', () => {
    voice.data = status({ server: { source: 'bundled', gpu: false } })
    settings.speechToText = { model: '', language: 'auto', serverPath: '/old/ws', gpu: false }
    render(<VoiceSection />)
    expect(own()).toBeTruthy()
    expect((screen.getByLabelText('Path to whisper-server') as HTMLInputElement).value).toBe('/old/ws')
    expect(gpu()).toBeNull()
  })
})
