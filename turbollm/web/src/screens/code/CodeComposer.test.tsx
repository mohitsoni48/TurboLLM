import { useRef, useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CodeComposer, type CodeComposerProps, type PendingImage, type RepoPickerState } from './CodeComposer'
import { AGENT_MODES } from './code-mock'
import { steerOutcomeMessage } from '../../lib/code-api'
import { toast } from '../../components/ui/sonner'

// Deterministic + inspectable: real sonner needs a mounted <Toaster/> to do anything visible,
// and the size-cap test below asserts a toast actually fired.
vi.mock('../../components/ui/sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

// The `@`-mention file index (ADR-259) walks the repo via the same local-only `browseFs`
// FsBrowser/"Add context" already use (see CodeComposer.tsx's header comment on the walk) —
// mock only that one export so every other real export (types, other helpers) still works if
// anything else in the render tree happens to touch this module.
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    browseFs: vi.fn(async (path?: string) => {
      if (path === '/repo' || path === undefined) {
        return {
          path: '/repo',
          parent: null,
          entries: [
            { name: 'CodeComposer.tsx', path: '/repo/CodeComposer.tsx', isDir: false },
            { name: 'CodeSessionScreen.tsx', path: '/repo/CodeSessionScreen.tsx', isDir: false },
            { name: 'lib', path: '/repo/lib', isDir: true },
          ],
        }
      }
      if (path === '/repo/lib') {
        return {
          path: '/repo/lib',
          parent: '/repo',
          entries: [{ name: 'utils.ts', path: '/repo/lib/utils.ts', isDir: false }],
        }
      }
      return { path: path ?? '/repo', parent: null, entries: [] }
    }),
  }
})

/** Minimal RepoPickerState — enough to render the pre-session repo/worktree row without
 *  crashing; individual fields overridden per-test where the exact displayed text matters. */
function makeRepo(overrides: Partial<RepoPickerState> = {}): RepoPickerState {
  return {
    repoPath: '/repo', recentRepos: [], onChoose: () => {}, onBrowse: () => {},
    branchLabel: 'main', branchTitle: 'main', useWorktree: false, onWorktreeChange: () => {},
    branchName: '', onBranchNameChange: () => {}, branchNamePlaceholder: '',
    baseBranch: 'main', onBaseBranchChange: () => {}, repoBranches: [], currentBranch: 'main',
    ...overrides,
  }
}

/** Minimal stateful wrapper — CodeComposer is a controlled component (value/onValueChange), so
 *  a real harness needs to actually apply the callback back into `value` for typing/selecting
 *  to behave like it does in the app, not just record calls. */
function Harness({
  repoRoot, repo, repoBranch, onSubmit = () => {}, onImagesChange, onStop,
  mode = AGENT_MODES[0], ctxUsed = 0, ctxMax = 0, live, textareaDisabled, slashCommands,
  thinkingBudget = -1, loadedName = null, lastPromptTokens, lastGenTokens,
}: {
  repoRoot?: string
  repo?: RepoPickerState
  repoBranch?: string
  onSubmit?: () => void
  onImagesChange?: (images: PendingImage[]) => void
  onStop?: () => void
  mode?: (typeof AGENT_MODES)[number]
  ctxUsed?: number
  ctxMax?: number
  live?: boolean
  textareaDisabled?: boolean
  slashCommands?: { id: string; description: string }[]
  thinkingBudget?: number
  loadedName?: string | null
  lastPromptTokens?: number
  lastGenTokens?: number
}) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  return (
    <CodeComposer
      inputRef={inputRef}
      value={value}
      onValueChange={setValue}
      onSubmit={onSubmit}
      placeholder="Describe a task…"
      repoRoot={repoRoot}
      repo={repo}
      repoBranch={repoBranch}
      mode={mode}
      onModeChange={() => {}}
      models={[]}
      loadedKey={loadedName ? 'k1' : null}
      loadedName={loadedName}
      modelPending={false}
      ejecting={false}
      onLoadModel={() => {}}
      onEjectModel={() => {}}
      ctxUsed={ctxUsed}
      ctxMax={ctxMax}
      live={live}
      onStop={onStop}
      textareaDisabled={textareaDisabled}
      sendDisabled={false}
      hintText="Enter to send"
      thinkingBudget={thinkingBudget}
      onThinkingBudgetChange={() => {}}
      onImagesChange={onImagesChange}
      slashCommands={slashCommands}
      lastPromptTokens={lastPromptTokens}
      lastGenTokens={lastGenTokens}
    />
  )
}

function makeImageFile(name: string, sizeBytes = 1024): File {
  const file = new File([new Uint8Array(1)], name, { type: 'image/png' })
  Object.defineProperty(file, 'size', { value: sizeBytes, configurable: true })
  return file
}

/** jsdom doesn't emulate real OS clipboard paste, so `clipboardData` is built by hand — same
 *  shape the component reads (`items[].kind`/`.type`/`.getAsFile()`). */
function pasteFiles(textarea: HTMLElement, files: File[]) {
  fireEvent.paste(textarea, {
    clipboardData: { items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })) },
  })
}

describe('CodeComposer @-mention popover', () => {
  it('opens on "@", lists repo files (recursively, via the existing fs/browse endpoint), and narrows as you type', async () => {
    const user = userEvent.setup()
    render(<Harness repoRoot="/repo" />)
    const textarea = screen.getByPlaceholderText('Describe a task…')

    await user.type(textarea, '@')
    await waitFor(() => expect(screen.getByText('CodeComposer.tsx')).toBeInTheDocument())
    expect(screen.getByText('CodeSessionScreen.tsx')).toBeInTheDocument()
    // The nested file (repo/lib/utils.ts) is included with its relative path — confirms the
    // walk actually recurses into subdirectories, not just the root listing.
    expect(screen.getByText('lib/utils.ts')).toBeInTheDocument()

    await user.type(textarea, 'comp')
    await waitFor(() => {
      expect(screen.getByText('CodeComposer.tsx')).toBeInTheDocument()
      expect(screen.queryByText('CodeSessionScreen.tsx')).not.toBeInTheDocument()
      expect(screen.queryByText('lib/utils.ts')).not.toBeInTheDocument()
    })
  })

  it('inserts the selected file as "@<relative path> " at the mention position, not a whole-value replace', async () => {
    const user = userEvent.setup()
    render(<Harness repoRoot="/repo" />)
    const textarea = screen.getByPlaceholderText('Describe a task…') as HTMLTextAreaElement

    await user.type(textarea, 'fix the bug in @comp')
    await waitFor(() => expect(screen.getByText('CodeComposer.tsx')).toBeInTheDocument())
    await user.click(screen.getByText('CodeComposer.tsx'))

    await waitFor(() => expect(textarea.value).toBe('fix the bug in @CodeComposer.tsx '))
  })

  it('renders no popover at all when repoRoot is omitted (no data source wired)', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const textarea = screen.getByPlaceholderText('Describe a task…')

    await user.type(textarea, '@comp')
    expect(screen.queryByText('CodeComposer.tsx')).not.toBeInTheDocument()
  })
})

describe('CodeComposer image paste', () => {
  it('attaches a pasted image as a thumbnail + name, reported via onImagesChange', async () => {
    const onImagesChange = vi.fn()
    render(<Harness onImagesChange={onImagesChange} />)
    const textarea = screen.getByPlaceholderText('Describe a task…')

    pasteFiles(textarea, [makeImageFile('screenshot.png')])

    await waitFor(() => expect(screen.getByText('screenshot.png')).toBeInTheDocument())
    await waitFor(() => expect(onImagesChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ name: 'screenshot.png', dataUrl: expect.stringMatching(/^data:/) }),
    ]))
  })

  it('attaches multiple images pasted in a single paste event', async () => {
    render(<Harness />)
    const textarea = screen.getByPlaceholderText('Describe a task…')

    pasteFiles(textarea, [makeImageFile('one.png'), makeImageFile('two.png')])

    await waitFor(() => {
      expect(screen.getByText('one.png')).toBeInTheDocument()
      expect(screen.getByText('two.png')).toBeInTheDocument()
    })
  })

  it('removing an attached image drops it from the preview and notifies onImagesChange', async () => {
    const user = userEvent.setup()
    const onImagesChange = vi.fn()
    render(<Harness onImagesChange={onImagesChange} />)
    const textarea = screen.getByPlaceholderText('Describe a task…')

    pasteFiles(textarea, [makeImageFile('screenshot.png')])
    await waitFor(() => expect(screen.getByText('screenshot.png')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Remove screenshot.png' }))

    expect(screen.queryByText('screenshot.png')).not.toBeInTheDocument()
    expect(onImagesChange).toHaveBeenLastCalledWith([])
  })

  it('rejects an oversized image with a toast and does not attach it', async () => {
    render(<Harness />)
    const textarea = screen.getByPlaceholderText('Describe a task…')

    pasteFiles(textarea, [makeImageFile('huge.png', 9 * 1024 * 1024)])

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('huge.png')).not.toBeInTheDocument()
  })

  it('clears attached images once submit fires (optimistic, same convention as the text value)', async () => {
    const user = userEvent.setup()
    const handleSubmit = vi.fn()
    render(<Harness onSubmit={handleSubmit} />)
    const textarea = screen.getByPlaceholderText('Describe a task…')

    pasteFiles(textarea, [makeImageFile('screenshot.png')])
    await waitFor(() => expect(screen.getByText('screenshot.png')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Send' }))

    expect(handleSubmit).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('screenshot.png')).not.toBeInTheDocument()
  })

  it('leaves a text-only paste untouched (no image items means no interception)', async () => {
    render(<Harness />)
    const textarea = screen.getByPlaceholderText('Describe a task…')
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.assign(event, { clipboardData: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] } })

    const notPrevented = textarea.dispatchEvent(event)

    // dispatchEvent returns true when the event was NOT canceled — the component must not have
    // called preventDefault() for a plain-text paste, or normal typing/paste would break.
    expect(notPrevented).toBe(true)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})

describe('CodeComposer real stats footer (ADR-262)', () => {
  // Format note (2026-07-29): the footer renders each stat as a separate label + value element
  // (CodeStatsFooter.tsx) instead of one run-on monospace string, so these assert the pair rather
  // than the old concatenations ('25%/100', 'Think: 4.0k').
  it('shows context % and max as real digits — genuinely new info, NOT a duplicate (ContextUsageRing never renders % as text)', () => {
    render(<Harness ctxUsed={25} ctxMax={100} />)
    expect(screen.getByText('Context')).toBeInTheDocument()
    expect(screen.getByText('25%')).toBeInTheDocument()
    expect(screen.getByText('of 100')).toBeInTheDocument()
  })

  it('omits the context segment entirely when ctxMax is 0 (no NaN%, matches ContextUsageRing\'s own guard)', () => {
    render(<Harness ctxUsed={0} ctxMax={0} />)
    expect(screen.queryByText('Context')).not.toBeInTheDocument()
    expect(screen.queryByText(/^\d+%$/)).not.toBeInTheDocument()
  })

  it('shows a compact thinking-effort readout — genuinely new info (the Brain icon never shows the value as text)', () => {
    const { rerender } = render(<Harness thinkingBudget={-1} />)
    expect(screen.getByText('Think')).toBeInTheDocument()
    expect(screen.getByText('Unlimited')).toBeInTheDocument()
    rerender(<Harness thinkingBudget={0} />)
    expect(screen.getByText('Off')).toBeInTheDocument()
    rerender(<Harness thinkingBudget={4000} />)
    expect(screen.getByText('4.0k')).toBeInTheDocument()
  })

  it('does NOT duplicate mode (toolbar button only) or model name (ModelLoadMenu trigger only)', () => {
    render(<Harness mode={AGENT_MODES[1]} loadedName="Qwen3.6-35B" ctxUsed={25} ctxMax={100} />)
    // "Plan first" appears exactly once — only the toolbar's mode-picker button, never repeated.
    expect(screen.getAllByText('Plan first')).toHaveLength(1)
    // Model name is ALREADY always-visible text via ModelLoadMenu — the footer must never repeat it,
    // even though ADR-262's own reference list mentions "model" (see CodeComposer.tsx's footer
    // doc comment for why this one specifically stays toolbar-only).
    expect(screen.getAllByText('Qwen3.6-35B')).toHaveLength(1)
  })

  it('shows branch/cwd ONLY mid-session (no `repo` prop) — pre-session, the repo-picker row already shows both', () => {
    const { rerender } = render(<Harness repoRoot="/Users/me/projects/my-app" repoBranch="feature/x" />)
    expect(screen.getByText('feature/x')).toBeInTheDocument()
    expect(screen.getByText('my-app', { exact: false })).toBeInTheDocument()

    // Pre-session: `repo` present → repo-picker row shows the folder name AND repo.branchLabel as
    // its own chip already, so the footer must suppress its own copy to avoid a real duplicate.
    rerender(<Harness repo={makeRepo({ repoPath: '/Users/me/projects/my-app', branchLabel: 'feature/x' })} repoBranch="feature/x" />)
    // "feature/x" still legitimately appears once (the repo row's chip) — assert it did NOT
    // become two after adding the footer's branch prop, i.e. the footer suppressed its own copy.
    expect(screen.getAllByText('feature/x')).toHaveLength(1)
  })

  it('omits tokens ↑/↓ when not wired (undefined props) — never fabricates 0/0', () => {
    render(<Harness />)
    expect(screen.queryByText(/↑/)).not.toBeInTheDocument()
    expect(screen.queryByText(/↓/)).not.toBeInTheDocument()
  })

  it('shows real tokens ↑/↓ once a caller passes them', () => {
    render(<Harness lastPromptTokens={4700} lastGenTokens={44} />)
    expect(screen.getByText('↑4.7k ↓44')).toBeInTheDocument()
  })

  it('never shows a cost figure — local models have no per-token cost, so it is omitted, not a misleading $0.00', () => {
    // ADR-249's own earlier finding, reaffirmed by ADR-262: cost stays out of scope regardless.
    const { container } = render(<Harness ctxUsed={25} ctxMax={100} lastPromptTokens={100} lastGenTokens={10} live />)
    expect(container.textContent).not.toContain('$')
  })

  it('shows the "/" and "@" hints only when those pickers are actually available', () => {
    const { rerender } = render(<Harness />) // no slashCommands, no repoRoot
    expect(screen.queryByText(/for commands/)).not.toBeInTheDocument()
    expect(screen.queryByText(/mention a file/)).not.toBeInTheDocument()

    rerender(<Harness repoRoot="/repo" slashCommands={[{ id: 'compact', description: 'x' }]} />)
    expect(screen.getByText(/for commands/)).toBeInTheDocument()
    expect(screen.getByText(/mention a file/)).toBeInTheDocument()
  })

  it('drops the "/" and "@" hints while a run is live (both pickers gate on !live), shows "Esc to stop" instead', () => {
    render(<Harness repoRoot="/repo" slashCommands={[{ id: 'compact', description: 'x' }]} live />)
    expect(screen.queryByText(/for commands/)).not.toBeInTheDocument()
    expect(screen.queryByText(/mention a file/)).not.toBeInTheDocument()
    expect(screen.getByText(/Esc to stop/)).toBeInTheDocument()
  })

  it('the footer stays visible while textareaDisabled (permanent now, no more hide-while-busy) — only the "Enter to send" clause specifically is dropped, since it would be wrong then', () => {
    render(<Harness textareaDisabled ctxUsed={25} ctxMax={100} />)
    expect(screen.queryByText('Enter to send')).not.toBeInTheDocument()
    // Stats stay put — this was the whole point of making the footer permanent.
    expect(screen.getByText('25%')).toBeInTheDocument()
  })

  it('keybind-hint honesty: the advertised "Enter to send" actually submits on Enter', async () => {
    // A stale hint (advertising a shortcut that does nothing) is the exact regression the test plan
    // calls out — tie the hint text to its real handler rather than just asserting it renders.
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} />)
    const textarea = screen.getByPlaceholderText('Describe a task…')
    await user.type(textarea, 'ship it')
    expect(screen.getByText(/Enter to send/)).toBeInTheDocument()
    await user.type(textarea, '{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('keybind-hint honesty: the advertised "Esc to stop" actually stops on Escape while live', async () => {
    const user = userEvent.setup()
    const onStop = vi.fn()
    render(<Harness live onStop={onStop} />)
    const textarea = screen.getByPlaceholderText('Describe a task…')
    expect(screen.getByText(/Esc to stop/)).toBeInTheDocument()
    textarea.focus()
    await user.keyboard('{Escape}')
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it('Escape does NOT stop when not live (no false claim, nothing to stop)', async () => {
    const user = userEvent.setup()
    const onStop = vi.fn()
    render(<Harness live={false} onStop={onStop} />)
    const textarea = screen.getByPlaceholderText('Describe a task…')
    textarea.focus()
    await user.keyboard('{Escape}')
    expect(onStop).not.toHaveBeenCalled()
  })
})

describe('CodeComposer steer/queue send affordance (ADR-246)', () => {
  // Self-contained props (not the shared Harness above, which hardcodes sendDisabled=false) so
  // the live + empty-field case can be exercised too.
  function steerProps(overrides: Partial<CodeComposerProps> = {}): CodeComposerProps {
    return {
      inputRef: { current: null },
      value: 'a follow-up',
      onValueChange: () => {},
      onSubmit: vi.fn(),
      placeholder: 'Describe a task…',
      mode: AGENT_MODES[0],
      onModeChange: () => {},
      models: [],
      loadedKey: null,
      loadedName: null,
      modelPending: false,
      ejecting: false,
      onLoadModel: () => {},
      onEjectModel: () => {},
      ctxUsed: 0,
      ctxMax: 0,
      sendDisabled: false,
      hintText: 'Enter to send',
      thinkingBudget: -1,
      onThinkingBudgetChange: () => {},
      onStop: () => {},
      ...overrides,
    }
  }

  it('shows only a single Send button when NOT live (no steer/queue choice)', () => {
    render(<CodeComposer {...steerProps({ live: false })} />)
    expect(screen.getByLabelText('Send')).toBeInTheDocument()
    expect(screen.queryByLabelText('Steer the current turn')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Queue follow-up')).not.toBeInTheDocument()
  })

  it('submits with NO kind (caller default) from the idle Send button', () => {
    const onSubmit = vi.fn()
    render(<CodeComposer {...steerProps({ live: false, onSubmit })} />)
    fireEvent.click(screen.getByLabelText('Send'))
    expect(onSubmit).toHaveBeenCalledWith(undefined)
  })

  it('shows Steer + Queue + Stop (and no plain Send) while live with text', () => {
    render(<CodeComposer {...steerProps({ live: true, sendDisabled: false })} />)
    expect(screen.getByLabelText('Steer the current turn')).toBeInTheDocument()
    expect(screen.getByLabelText('Queue follow-up')).toBeInTheDocument()
    // Real accessible name, not just a title tooltip (final gate, spec 16 §9 item 4 — this was
    // the one icon-only button in this describe block that had no aria-label until this gate).
    expect(screen.getByLabelText('Stop this run')).toBeInTheDocument()
    expect(screen.queryByLabelText('Send')).not.toBeInTheDocument()
  })

  it('submits with kind "steer" from the Steer button', () => {
    const onSubmit = vi.fn()
    render(<CodeComposer {...steerProps({ live: true, sendDisabled: false, onSubmit })} />)
    fireEvent.click(screen.getByLabelText('Steer the current turn'))
    expect(onSubmit).toHaveBeenCalledWith('steer')
  })

  it('submits with kind "followUp" from the Queue button', () => {
    const onSubmit = vi.fn()
    render(<CodeComposer {...steerProps({ live: true, sendDisabled: false, onSubmit })} />)
    fireEvent.click(screen.getByLabelText('Queue follow-up'))
    expect(onSubmit).toHaveBeenCalledWith('followUp')
  })

  it('hides both send actions (only Stop remains) when live with an empty field', () => {
    render(<CodeComposer {...steerProps({ live: true, sendDisabled: true })} />)
    expect(screen.queryByLabelText('Steer the current turn')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Queue follow-up')).not.toBeInTheDocument()
    // Real accessible name, not just a title tooltip (final gate, spec 16 §9 item 4 — this was
    // the one icon-only button in this describe block that had no aria-label until this gate).
    expect(screen.getByLabelText('Stop this run')).toBeInTheDocument()
  })

  it('Enter submits with no kind (queues by default) even while live', () => {
    const onSubmit = vi.fn()
    render(<CodeComposer {...steerProps({ live: true, sendDisabled: false, onSubmit })} />)
    fireEvent.keyDown(screen.getByPlaceholderText('Describe a task…'), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith(undefined)
  })
})

describe('steerOutcomeMessage', () => {
  it('confirms a landed steer when steered is true', () => {
    expect(steerOutcomeMessage(true)).toBe('Steered into the current turn.')
  })

  it('explains the queue fallback when steered is false', () => {
    expect(steerOutcomeMessage(false)).toContain('Queued to run next')
  })
})
