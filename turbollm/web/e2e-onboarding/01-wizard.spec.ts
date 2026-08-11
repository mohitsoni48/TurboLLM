import { test, expect } from '@playwright/test'

// Real end-to-end verification of the onboarding wizard (spec 25), driven
// against the actual built daemon inside docker-compose.test.yaml's
// container — a fresh tmpfs ~/.turbollm on every run, so every test starts
// from a genuinely unonboarded install, not a mock.
//
// The tmpfs is fresh once, at CONTAINER start — not once per TEST, and not once per
// FILE either. Every spec file in this directory shares the same daemon/tmpfs for the
// whole Playwright run (single worker, see playwright.docker.config.ts). Two separate
// gotchas fall out of that, both found live, not predicted:
//  1. Within this file: a test that skips or completes onboarding (a real, permanent
//     server-side mutation) poisons every test declared after it unless something
//     resets between them — this file's own beforeEach handles that.
//  2. Across files: `everLoadedModel` (App.tsx's onboarding gate) is server-authoritative
//     and can ONLY ever be set true by a REAL successful model load in cli.ts — there is
//     deliberately no API to reset it back to false. The moment ANY test anywhere in the
//     run achieves a real load, EVERY test after it that expects to be onboarding-eligible
//     breaks, correctly — the app is right that onboarding is genuinely no longer needed.
//     02-deep-flow.spec.ts's tests do real loads; this file's don't. The `01`/`02` name
//     prefixes are load-bearing, not cosmetic: Playwright runs spec files in filesystem
//     order, and this file MUST run first for its tests' fresh-install assumptions to hold.
test.beforeEach(async ({ request }) => {
  const res = await request.put('/api/v1/onboarding', { data: { status: 'pending' } })
  expect(res.ok()).toBe(true)
})

test('a fresh install lands on /onboarding, not /workspace/chat', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/onboarding$/)
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible()
})

test('skip is present and works on the very first step', async ({ page }) => {
  await page.goto('/onboarding')
  // Two skip affordances exist (spec 25 §3.1): the top-bar "Skip onboarding" and the
  // bottom-of-card "I don't need onboarding" — both must always be present, on every step.
  const skip = page.getByRole('button', { name: 'Skip onboarding' })
  await expect(skip).toBeVisible()
  await expect(skip).toBeEnabled()
  await expect(page.getByText("I don't need onboarding")).toBeVisible()
})

test('the app nav is hidden while onboarding, restored once finished', async ({ page }) => {
  await page.goto('/onboarding')
  // Every nav link is an escape hatch the wizard never asked for — Skip already covers
  // leaving on purpose (spec 25 §3.1). Found live: the rail rendered right alongside the
  // wizard with no wizard-side awareness of a click wandering off mid-flow.
  await expect(page.getByRole('link', { name: 'Models' })).not.toBeVisible()
  await expect(page.getByRole('link', { name: 'Settings' })).not.toBeVisible()

  await page.getByText("I don't need onboarding").click()
  await expect(page).toHaveURL(/\/workspace\/chat/)
  await expect(page.getByRole('link', { name: 'Models' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible()
})

test('casual profile: selecting a card advances and persists across reload', async ({ page }) => {
  await page.goto('/onboarding')
  await page.getByRole('button', { name: 'Continue' }).click() // past Welcome
  await page.getByRole('radio', { name: /Casual/ }).click()
  await expect(page.getByRole('radio', { name: /Casual/ })).toHaveAttribute('aria-checked', 'true')

  // Reload mid-wizard: resume must come from server truth, not be lost.
  await page.reload()
  await expect(page.getByRole('radio', { name: /Casual/ })).toHaveAttribute('aria-checked', 'true')
})

test('pro profile: the model step hands off to Discover, never shows a recommendation card', async ({ page }) => {
  await page.goto('/onboarding')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('radio', { name: /Pro/ }).click()
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page.getByRole('heading', { name: 'Pick your own model' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open Discover' })).toBeVisible()
  await page.getByRole('button', { name: 'Open Discover' }).click()
  await expect(page).toHaveURL(/\/models\?tab=discover/)
})

test('finishing onboarding (skip) never shows the wizard again on reload', async ({ page }) => {
  await page.goto('/onboarding')
  await page.getByText("I don't need onboarding").click()
  await expect(page).toHaveURL(/\/workspace\/chat/)

  await page.goto('/')
  await expect(page).not.toHaveURL(/\/onboarding/)
})

test('a deep link to /onboarding after a genuinely completed install redirects away, not just after skip', async ({ page, request }) => {
  // applyOnboardingPatch (onboarding-routes.ts) accepts status directly with no validation
  // against having actually walked the flow — a real completion (Done's completeOnboarding())
  // sets exactly this, so PUTting it straight is a faithful stand-in without needing a real
  // model load. The skip case is covered above; 'completed' is a structurally different
  // status value and deserves its own check, not an assumption it behaves the same.
  const res = await request.put('/api/v1/onboarding', { data: { status: 'completed' } })
  expect(res.ok()).toBe(true)

  await page.goto('/onboarding')
  await expect(page).not.toHaveURL(/\/onboarding$/)
})

test('Back returns to the previous step without losing the profile selection', async ({ page }) => {
  await page.goto('/onboarding')
  await page.getByRole('button', { name: 'Continue' }).click() // past Welcome
  await page.getByRole('radio', { name: /Enthusiast/ }).click()

  await page.getByRole('button', { name: '← Back' }).click()
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible()

  // Forward again: the earlier selection must still be there, not reset by the round trip.
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('radio', { name: /Enthusiast/ })).toHaveAttribute('aria-checked', 'true')
})

test('Back is disabled on the very first step — nothing to go back to', async ({ page }) => {
  await page.goto('/onboarding')
  await expect(page.getByRole('button', { name: '← Back' })).toBeDisabled()
})

test('resuming after a Discover browse with no download offers a real way back, not a stuck spinner forever', async ({ page }) => {
  // The exact shape adversarial QA found broken: ADR-338 Decision 6b's "highest-value E2E
  // case" (Discover-handoff-and-resume) but where the user only BROWSED — never downloaded
  // anything — then came back. LoadStep used to have no branch for "nothing is in flight and
  // nothing ever loaded," so it sat on a permanently frozen "Loading your model" spinner.
  await page.goto('/onboarding')
  await page.getByRole('button', { name: 'Continue' }).click() // past Welcome
  await page.getByRole('radio', { name: /Enthusiast/ }).click()
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page.getByRole('heading', { name: 'Choose a model' })).toBeVisible()
  await page.getByRole('button', { name: 'Pick a different model' }).click()
  await expect(page).toHaveURL(/\/models\?tab=discover/)

  // Simulate returning without ever downloading anything (the ModelsScreen "Resume setup"
  // banner does exactly this navigation).
  await page.goto('/onboarding')

  // Enthusiast has no profile-extra step, so Personalize (which still applies while
  // !downloadDone) is the only thing between Model and Load.
  await expect(page.getByRole('heading', { name: 'Personalize', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page.getByRole('heading', { name: 'Nothing to load yet' })).toBeVisible()
  await page.getByRole('button', { name: 'Choose a model' }).click()
  await expect(page.getByRole('heading', { name: 'Choose a model' })).toBeVisible()
})

// MUST run last in this file (and, by extension, last in the whole suite before
// 02-deep-flow.spec.ts's tests — see this file's header for why filename order matters
// across files too). LoadStep's `resumedWithNoTrail` check the test above depends on
// (`!activeDownload && !finishedDownload && !erroredDownload`) is unscoped to "this
// wizard run" — it matches ANY download anywhere in the container's whole history, not
// just ones this test created. A download this test enqueues and leaves behind as
// 'done' would make every LATER test's `!finishedDownload` check false forever, breaking
// the "Nothing to load yet" test above in a way that has nothing to do with what it's
// actually testing — found live, by this exact test breaking that one on first write.
test('skip never destroys a download in flight', async ({ page, request }) => {
  // Spec 25 §3.1 ("Skip never destroys work in flight"), the §10.3 coverage matrix, and AC4
  // all name this combination explicitly — a skeptical PM audit found it had zero coverage
  // at any layer despite that. `handleSkip`'s real implementation only ever PUTs the
  // onboarding status (see `useOnboardingMachine.tsx`'s `skip()`) and never touches the
  // downloads subsystem, so this is really proving an absence of interaction — the download
  // must reach its own natural terminal state (here: 'done', against the fixture) rather
  // than ever being cancelled or having its record removed by the skip click.
  const enqueueRes = await request.post('/api/v1/downloads', {
    data: { repo: 'fixture/e2e-repo', rfilename: 'e2e-skip-survives-download.gguf' },
  })
  expect(enqueueRes.ok(), await enqueueRes.text()).toBe(true)

  await page.goto('/onboarding')
  await page.getByText("I don't need onboarding").click()
  await expect(page).toHaveURL(/\/workspace\/chat/)

  let final
  for (let i = 0; i < 100; i++) {
    const dl = await (await request.get('/api/v1/downloads')).json()
    final = dl.downloads.find((d) => d.name === 'e2e-skip-survives-download.gguf')
    if (final?.status === 'done' || final?.status === 'error') break
    await new Promise((r) => setTimeout(r, 100))
  }
  expect(final?.status, 'skip must never cancel or drop a download that was in flight').toBe('done')
})
