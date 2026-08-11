import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// Deep E2E coverage past Welcome/Profile (spec 25 §10.3) — the shallow wizard.spec.ts
// never reaches Model/Load/Payoff because doing so needs a real, loadable engine, and
// the CPU-only harness has none by default. Registers turbollm's own real, shipped
// "point at your own engine binary" API (POST /api/v1/engines) with
// test/fixtures/stub-llama-server.mjs — a fake llama-server that answers --version/--help
// for probe() and /health for manager.ts's readiness() — so ModelStep's real download and
// LoadStep's real load-and-poll actually succeed here, no production provisioning code
// touched to make that happen. It must also be ACTIVATED, not just registered: the
// daemon's own auto-provisioning already downloads and activates a REAL cpu llama-server
// during boot (before this file's beforeAll ever runs), and that real binary cannot load
// the fixture HF server's fake tiny GGUF — found by an actual failed run, not predicted.
//
// This container is CPU-only, so every recommendation resolves T0 (spec 25 §6.2) and
// tune-offer never applies for any profile — that's real, correct behavior (see
// registry.test.ts for the order/T0-suppression assertions unit-tested directly, since
// they need a non-T0 context this container can never produce).
//
// A blessed catalog entry (ModelStep's "Download this") ALWAYS carries a real HF sha256 —
// downloading it against the fixture's fake bytes will ALWAYS fail checksum verification.
// That is correct, expected behavior (downloads.ts only skips the check when no sha256 is
// recorded) — found live by actually running this suite, not predicted, and it's what
// exposed a real LoadStep bug (see the first test below). The happy-path download→load
// tests instead enqueue a raw, checksum-less file directly (mirrors a real Discover pick,
// which downloads.ts also never checksum-verifies without a known hash) — same technique
// real Discover downloads without a pre-known hash already use in production.
//
// TEST ORDER ACROSS FILES IS LOAD-BEARING, same gotcha 01-wizard.spec.ts's header
// documents: `everLoadedModel` is server-authoritative, set permanently true by a REAL
// successful load, with no API to reset it — this file's `01-`/`02-` filename prefix must
// keep 01-wizard.spec.ts running first.
//
// WITHIN this file, order mostly doesn't matter — but not entirely, and an earlier version
// of this comment overclaimed that it did. `OnboardingScreenInner`'s own redirect logic
// checks only `status` (which `resetOnboarding()` genuinely resets before every test), so
// most tests are safe in any order relative to each other regardless of an earlier real
// load. The ONE real exception, found live: `App.tsx`'s `shouldOnboard` — the gate behind
// its `useResumeOnboardingAfterDiscoverDownload` auto-navigate hook — additionally requires
// `!everLoadedModel`. The "mid-onboarding Discover download" test below is the only test in
// this file whose own pass/fail depends on that hook actually firing, so it MUST run before
// any test that achieves a real completed load (every "use a model I already have" test
// below does). Putting a real-load test before it breaks it deterministically: the hook's
// polling effect short-circuits (`if (!shouldOnboard) return`) before it can ever observe
// the download finishing.

async function registerAndActivateStubEngine(request: APIRequestContext) {
  const existing = await request.get('/api/v1/engines')
  const body = await existing.json().catch(() => ({ engines: [] }))
  let stub = body.engines?.find((e: { name: string }) => e.name === 'stub-e2e')
  if (!stub) {
    const res = await request.post('/api/v1/engines', {
      data: { name: 'stub-e2e', binPath: '/fixtures/stub-llama-server.mjs' },
    })
    expect(res.ok(), await res.text()).toBe(true)
    // POST /api/v1/engines spreads the Engine's fields at the response's top level
    // ({...engine, warning}), not nested under an `engine` key.
    stub = await res.json()
  }
  const activateRes = await request.post(`/api/v1/engines/${stub.id}/activate`)
  expect(activateRes.ok(), await activateRes.text()).toBe(true)
}

async function resetOnboarding(request: APIRequestContext) {
  const res = await request.put('/api/v1/onboarding', { data: { status: 'pending' } })
  expect(res.ok()).toBe(true)
}

/** Clears the wizard's own client-side step-position cache. Must run AFTER a real
 *  navigation — localStorage has no origin to attach to on Playwright's initial
 *  about:blank page (SecurityError otherwise) — and a SECOND goto is what actually
 *  makes the app re-mount and re-read the now-empty key. */
async function freshWizardVisit(page: Page) {
  await page.goto('/onboarding')
  await page.evaluate(() => localStorage.clear())
  await page.goto('/onboarding')
}

/** Enqueues a raw, checksum-less download directly against the fixture (no HF search UI
 *  involved — this is a test-only shortcut for "a Discover download just finished", not a
 *  claim that this is how real users pick files) and waits for it to land 'done'. Used
 *  wherever a test needs an actual model FILE present without hitting the blessed
 *  catalog's real-sha256 checksum wall (see header comment). */
async function seedRealDownload(request: APIRequestContext, rfilename: string) {
  const res = await request.post('/api/v1/downloads', {
    data: { repo: 'fixture/e2e-repo', rfilename },
  })
  expect(res.ok(), await res.text()).toBe(true)
  for (let i = 0; i < 100; i++) {
    const dl = await (await request.get('/api/v1/downloads')).json()
    const rec = dl.downloads.find((d: { name: string }) => d.name === rfilename)
    if (rec?.status === 'done') return
    if (rec?.status === 'error') throw new Error(`seed download errored: ${rec.error}`)
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('seed download never reached done within 10s')
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ request }) => {
  await registerAndActivateStubEngine(request)
})

test('casual: a blessed download that fails checksum against the fixture shows a real error, and Retry works', async ({ page, request }) => {
  await resetOnboarding(request)
  await freshWizardVisit(page)

  await page.getByRole('button', { name: 'Continue' }).click() // past Welcome
  await page.getByRole('radio', { name: /Casual/ }).click()
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page.getByRole('heading', { name: 'Choose a model' })).toBeVisible()
  // The blessed entry carries a real HF sha256; the fixture can only ever serve fake
  // bytes, so this is DETERMINISTICALLY a checksum failure, not flaky.
  await page.getByRole('button', { name: 'Download this' }).click()

  // `ctx.downloadDone` only ever flips true on a 'done' download (LoadStep's own effect)
  // — never on 'error' — so Personalize (which applies while `!downloadDone`, to "fill
  // otherwise-dead download time") still applies and the wizard lands there first, not on
  // Load directly. Not a bug on its own (the user isn't blocked — Continue is right
  // there), just not where a SUCCESSFUL download would go; found live running this test.
  await expect(page.getByRole('heading', { name: 'Personalize', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()

  // LoadStep's real bug, found live: an 'error' download used to match the same
  // `!== 'done' && !== 'cancelled'` filter as a genuinely in-flight one, so this heading
  // never appeared at all — the screen just sat on a frozen "Downloading…" forever.
  await expect(page.getByRole('heading', { name: "The download didn't finish" })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/checksum/i)).toBeVisible()

  // Retry calls the real resume-a-failed-download API (same one DownloadsPanel's own
  // "Resume" button uses) — it will fail checksum again (same fake bytes: there is no
  // network latency against the local fixture, so the transient "Retrying…" pending
  // state resolves faster than Playwright can reliably observe it). Asserting the real
  // request actually fires is the robust signal that the button does something rather
  // than being decorative — a frozen/dead button would leave this hanging until timeout.
  const resumeResponse = page.waitForResponse((r) => /\/api\/v1\/downloads\/.+\/resume/.test(r.url()))
  await page.getByRole('button', { name: 'Retry' }).click()
  expect((await resumeResponse).ok()).toBe(true)
})

test('mid-onboarding Discover download returns the user to the wizard, and the real pipeline finishes onboarding', async ({ page, request }) => {
  await resetOnboarding(request)
  await freshWizardVisit(page)

  await page.getByRole('button', { name: 'Continue' }).click() // past Welcome
  await page.getByRole('radio', { name: /Enthusiast/ }).click()
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page.getByRole('heading', { name: 'Choose a model' })).toBeVisible()
  // "Pick a different model" is ModelStep's Discover handoff for every profile, not just
  // Pro's dedicated screen — it's the exact detour the founder reported getting stranded in.
  await page.getByRole('button', { name: 'Pick a different model' }).click()
  await expect(page).toHaveURL(/\/models\?tab=discover/)

  // Simulate what finishing a real Discover download looks like from the daemon's side
  // (driving the actual HF search UI here would just be re-testing Discover itself, not
  // the resume behavior this test exists for) — enqueue against the fixture server exactly
  // as HfRepoDialog's real "Download" button does (no sha256 — real Discover downloads
  // without a pre-known hash skip the check the same way; see header comment), then wait
  // for it to land 'done'.
  const enqueueRes = await request.post('/api/v1/downloads', {
    data: { repo: 'fixture/e2e-repo', rfilename: 'e2e-discover-resume.gguf' },
  })
  expect(enqueueRes.ok(), await enqueueRes.text()).toBe(true)

  await expect(page).toHaveURL(/\/onboarding$/, { timeout: 15_000 })

  // The resumed wizard's ctx starts fresh (INITIAL_CTX — only the step ID itself survives
  // via localStorage; see useOnboardingMachine.tsx's own header comment) and lands back on
  // whatever step was saved right when "Pick a different model" navigated away —
  // 'personalize', since ctx.downloadDone hasn't been set true yet at that point. Same
  // "not a bug, just not where a same-session success would land" gap as the checksum
  // test above, confirmed live running this test.
  await expect(page.getByRole('heading', { name: 'Personalize', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()

  // Enthusiast has no tune-offer suppressed only on T0 (registry.ts) — and this
  // container IS T0, so Load goes straight to Payoff, proving the resumed wizard
  // actually drives the real download all the way through a real load.
  // level:3 picks PayoffStep's OWN heading, not the wizard shell's h2 step title (still
  // "Try it", registry.ts) — the two are deliberately different text now.
  await expect(page.getByRole('heading', { name: "You're set up", level: 3 })).toBeVisible({ timeout: 15_000 })
  // "Start chatting" creates the real conversation, completes onboarding, and navigates
  // straight there — one click, no intermediate "You're set up" screen (that used to be a
  // separate step; merged after a reported abrupt extra click between "Start chatting"
  // and actually chatting — see PayoffStep's own header comment).
  await page.getByRole('button', { name: 'Start chatting' }).click()
  await expect(page).toHaveURL(/\/workspace\/chat\//, { timeout: 10_000 })

  const onboardingRes = await request.get('/api/v1/onboarding')
  const onboarding = await onboardingRes.json()
  expect(onboarding.status).toBe('completed')
})

// MUST run after the "mid-onboarding Discover download" test above — that test is the
// ONLY one in this file whose own resume mechanism (App.tsx's `useResumeOnboardingAfter
// DiscoverDownload`) depends on `shouldOnboard`, which requires `!everLoadedModel`
// (App.tsx line ~130). Found live: putting this test before it broke the Discover-resume
// test deterministically — once ANY test (this one included) achieves a real completed
// load, `everLoadedModel` flips permanently true server-side (no reset API), `shouldOnboard`
// goes false, and the Discover-resume hook's own polling effect short-circuits
// (`if (!shouldOnboard) return`) before it ever gets the chance to observe the download
// finishing and navigate back. Every OTHER test in this file navigates to /onboarding
// directly rather than relying on that specific hook, so they're unaffected by ordering —
// this dependency is real but narrow, not the "nothing depends on it" claim an earlier
// version of this file's header comment made after only checking the redirect gate, not
// this hook.
test('a download that is still in flight when Load first mounts still gets picked up once it finishes (real download-timing race)', async ({
  page,
  request,
}) => {
  // The exact bug a real user hit manually testing this against real HuggingFace, and
  // that NOTHING in this suite caught before now: a download that is genuinely still in
  // progress — not pre-seeded, not already scanned — the moment LoadStep first mounts.
  //
  // Root cause: `useModels()`'s `refetchInterval` predicate (web/src/lib/queries.ts) only
  // keeps polling while a scan is actively running, a model is already loaded, or the
  // engine is starting. None of those are true at the exact instant LoadStep first mounts
  // for a download that hasn't produced a file yet — so polling disabled itself before the
  // model ever existed to be scanned, and (before the fix) never resumed once the download
  // later finished and got scanned. The daemon's own logs never showed a single
  // `POST /api/v1/engine/start` — the client just silently gave up waiting.
  //
  // Every OTHER test in this suite structurally sidesteps this: the checksum test above
  // makes the download FAIL (never scans successfully); every "use a model I already have"
  // test pre-seeds the model as already-done+scanned via `seedRealDownload` BEFORE the
  // wizard ever starts polling; the "mid-onboarding Discover download" test above only
  // navigates back to `/onboarding` AFTER `useResumeOnboardingAfterDiscoverDownload`'s own
  // independent polling has already confirmed the download finished, by which point the
  // scan is already well underway (`scanning: true` keeps the OLD code polling correctly
  // in that narrower window too). None of them exercise a download that is still genuinely
  // in flight the moment Load mounts — which is the single most common real-world path:
  // download the recommended model, then wait.
  //
  // Reproduced here via the fixture's opt-in `/delay-<ms>ms/` path (see hf-server.mjs) on
  // a raw enqueue, navigating to Load fast enough (real UI clicks, no artificial wait) that
  // the 3s delay guarantees LoadStep's first `useModels()`/`useDownloads()` polls land well
  // before the download has produced a file at all — the same wide race window
  // `ModelStep.tsx`'s real `startDownload()` creates by calling `onContinue()` immediately
  // after kicking off the enqueue, never waiting for it.
  //
  // MUST run after "mid-onboarding Discover download" above (same reason every other real-
  // load test in this file does) — this test itself reaches a real completed load too.
  await resetOnboarding(request)
  const enqueueRes = await request.post('/api/v1/downloads', {
    data: { url: 'http://127.0.0.1:8080/delay-3000ms/fixture/e2e-repo/e2e-slow-timing-download.gguf' },
  })
  expect(enqueueRes.ok(), await enqueueRes.text()).toBe(true)

  await freshWizardVisit(page)
  await page.getByRole('button', { name: 'Continue' }).click() // past Welcome
  await page.getByRole('radio', { name: /Enthusiast/ }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Choose a model' })).toBeVisible()
  // "Pick a different model" advances past Model immediately (onContinue(), same as the
  // real "Download this" button does) without waiting for anything — exactly the timing
  // this test needs, reached without needing the blessed catalog (which can never
  // checksum-pass against this fixture, see the checksum test above).
  await page.getByRole('button', { name: 'Pick a different model' }).click()
  await expect(page).toHaveURL(/\/models\?tab=discover/)
  // Navigate back immediately ourselves — do NOT wait for the app's own Discover-resume
  // hook to detect completion first, which would only fire once the download (and likely
  // its scan) already finished, sidestepping the exact race under test.
  await page.goto('/onboarding')
  await expect(page.getByRole('heading', { name: 'Personalize', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()

  // Real regression proof: without the `useModels()` polling fix, this hangs here
  // forever — "Loading your model" text, nothing happening — even though the download
  // genuinely finishes ~3s later and scans correctly server-side the whole time.
  await expect(page.getByRole('heading', { name: "You're set up", level: 3 })).toBeVisible({ timeout: 20_000 })

  // Not enough on its own to trust: `matchedEntry`'s "most recent finished download"
  // heuristic can be satisfied by an OLDER, unrelated, already-loaded model from an
  // earlier test in this same file if this test doesn't wait for its OWN download —
  // found live, this exact test silently passed for the wrong reason once before, in
  // under a second, by matching the previous test's leftover loaded model instead of
  // actually waiting out the 3s delay. Assert the model that's ACTUALLY loaded is the one
  // THIS test downloaded, not a stale leftover.
  const statusRes = await request.get('/api/v1/status')
  const status = await statusRes.json()
  expect(status.model?.name).toBe('e2e slow timing download')
})

test('casual: "use a model I already have" reaches a real completed load, Payoff, and Done', async ({ page, request }) => {
  // Closes a real gap a skeptical PM audit found: Casual is the shortest, most common path
  // in the spec (§4: "the whole path is 4 clicks"), but no test had ever driven it through a
  // real completed load — because the ONLY way to trigger a real download from ModelStep's
  // primary "Download this" CTA is against a blessed catalog entry, and a blessed entry's
  // real HF sha256 can never checksum-pass against this fixture's fake bytes (see the
  // checksum test above). The existing-model path is the same route Developer/Pro already
  // use to get around that wall — Casual gets the identical "use a model I already have"
  // section (it's not gated by profile, see ModelStep.tsx), just never had a test exercise it.
  await resetOnboarding(request)
  await seedRealDownload(request, 'e2e-casual-existing-model.gguf')
  await freshWizardVisit(page)

  await page.getByRole('button', { name: 'Continue' }).click() // past Welcome
  await page.getByRole('radio', { name: /Casual/ }).click()
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page.getByRole('heading', { name: 'Choose a model' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Use a model I already have' })).toBeVisible()
  // Select by VALUE (the exact model key ModelStep.tsx builds from the scan, `name|quant|
  // bytes` — quant is always the documented "?" unknown-placeholder for these fixture files,
  // and every fixture download is a fixed 1048600 bytes, see TINY_GGUF), never by blind
  // `index: 1`. This suite accumulates real downloaded models across ALL prior tests on the
  // shared container filesystem — by the time later tests run, the dropdown has many options,
  // and `index: 1` silently grabs whichever OTHER test's leftover model happens to sort
  // first, not the one THIS test just seeded. Found live: that exact mismatch produced two
  // simultaneous, DIFFERENT `POST /api/v1/engine/start` calls (one from this handler's own
  // `loadModel()`, one from LoadStep's independent `matchedEntry` effect matching the real
  // seeded download) — `ctx.expectedModelKey` ended up set to the wrong one, so `isLoaded`
  // could never match the model that actually finished loading, hanging forever.
  await page.getByRole('combobox').selectOption({ value: 'e2e casual existing model|?|1048600' })
  await page.getByRole('button', { name: 'Use this model' }).click()

  // Casual never gets tune-offer regardless of hardware (registry.ts excludes it entirely
  // for this profile), so Load goes straight to Payoff here too.
  await expect(page.getByRole('heading', { name: "You're set up", level: 3 })).toBeVisible({ timeout: 15_000 })
  // One click: creates the conversation, completes onboarding, navigates straight there.
  await page.getByRole('button', { name: 'Start chatting' }).click()
  await expect(page).toHaveURL(/\/workspace\/chat\//, { timeout: 10_000 })

  const onboardingRes2 = await request.get('/api/v1/onboarding')
  const onboarding2 = await onboardingRes2.json()
  expect(onboarding2.status).toBe('completed')
})

test('a stale, unrelated errored download does not block a different, ready-to-load model from loading', async ({ page, request }) => {
  // Real regression the final adversarial QA pass on this session's other 4 fixes found live,
  // driving the actual API: LoadStep's `erroredDownload` branch used to short-circuit
  // unconditionally, before ever checking whether a DIFFERENT, fully-downloaded model was
  // sitting in the same download history and ready to load. Realistic trigger: the blessed
  // recommendation genuinely fails checksum (deterministic against this fixture, see the
  // casual checksum test above), the user fixes it via a different download, and the wizard
  // must still recognize the good one instead of getting stuck on the stale failure forever.
  await resetOnboarding(request)

  // 1) Make the blessed entry fail for real — same deterministic checksum mismatch the casual
  // test above documents (a blessed entry always carries a real HF sha256; the fixture can
  // only ever serve fake bytes).
  const recRes = await request.get('/api/v1/onboarding/recommendation?profile=casual')
  const rec = (await recRes.json()).recommendation
  const failRes = await request.post('/api/v1/downloads', {
    data: { repo: rec.entry.repo, rfilename: rec.entry.file, excludeMmproj: true },
  })
  expect(failRes.ok(), await failRes.text()).toBe(true)
  for (let i = 0; i < 100; i++) {
    const dl = await (await request.get('/api/v1/downloads')).json()
    const stale = dl.downloads.find((d) => d.name === rec.entry.file)
    if (stale?.status === 'error') break
    await new Promise((r) => setTimeout(r, 100))
  }

  // 2) A genuinely different, unrelated download completes successfully — the ready model the
  // stale error must not hide.
  await seedRealDownload(request, 'e2e-recovery-ready-model.gguf')

  // 3) Walk the wizard to Load the same way a real resumed session would (Discover-handoff
  // detour, same as the test above — the download in step 2 stands in for "the user fixed it
  // via a different pick" rather than re-testing Discover's own UI here).
  await freshWizardVisit(page)
  await page.getByRole('button', { name: 'Continue' }).click() // past Welcome
  await page.getByRole('radio', { name: /Enthusiast/ }).click()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('heading', { name: 'Choose a model' })).toBeVisible()
  await page.getByRole('button', { name: 'Pick a different model' }).click()
  await expect(page).toHaveURL(/\/models\?tab=discover/)
  await page.goto('/onboarding')
  await expect(page.getByRole('heading', { name: 'Personalize', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()

  // The pre-fix bug is COSMETIC-BUT-MISLEADING, not a permanent freeze: LoadStep's
  // load-triggering effect runs unconditionally regardless of which branch is rendered, so
  // the ready model loads correctly in the background even while the wrong heading is shown
  // — and once it finishes, the auto-advance effect moves on to Payoff anyway, masking the
  // bug from a final-state-only check. A plain `.not.toBeVisible()` snapshot right after the
  // click is equally blind to it (nothing has rendered yet at that instant either way) — the
  // only way to actually catch this is to watch for the wrong heading appearing at ANY point
  // during the real transition, not just check the end state.
  const badHeadingAppeared = await page
    .getByRole('heading', { name: "The download didn't finish" })
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false)
  expect(badHeadingAppeared, 'a stale errored download must never surface once a different download is ready to load').toBe(false)

  // Post-fix: the ready download wins and the real load pipeline actually completes.
  await expect(page.getByRole('heading', { name: "You're set up", level: 3 })).toBeVisible({ timeout: 15_000 })
})

test('pro: model step offers Discover AND "use a model I already have" together, and the existing-model path actually works', async ({
  page,
  request,
}) => {
  await resetOnboarding(request)
  await seedRealDownload(request, 'e2e-pro-existing-model.gguf')
  await freshWizardVisit(page)

  await page.getByRole('button', { name: 'Continue' }).click() // past Welcome
  await page.getByRole('radio', { name: /Pro/ }).click()
  await page.getByRole('button', { name: 'Continue' }).click()

  // Both options must render together — ADR-338 Decision 6b: "still offered alongside
  // [Discover], so a Pro with a full model folder is never pushed into a download." A real
  // bug found live by adversarial QA: ModelStep used to give Pro its own early return with
  // ONLY the Discover-handoff card, so this section could never appear no matter how many
  // models were already on disk.
  await expect(page.getByRole('heading', { name: 'Pick your own model' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open Discover' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Use a model I already have' })).toBeVisible()

  // Select by exact model key, not blind index — see the Casual test above for why.
  await page.getByRole('combobox').selectOption({ value: 'e2e pro existing model|?|1048600' })
  await page.getByRole('button', { name: 'Use this model' }).click()

  // This container is CPU-only, so every recommendation resolves T0 (see header comment) —
  // tune-offer never applies for any profile, so Model → Load → Payoff directly here too.
  await expect(page.getByRole('heading', { name: "You're set up", level: 3 })).toBeVisible({ timeout: 15_000 })

  // Closes a gap a skeptical PM audit found: earlier versions of this test stopped at
  // Payoff, so Pro actually completing onboarding was only a unit-tested guarantee
  // (registry.ts's unconditional `appliesTo`), never actually observed live in a browser
  // the way Enthusiast/Developer/Casual all are elsewhere in this file. One click now
  // creates the conversation, completes onboarding, and navigates straight there.
  await page.getByRole('button', { name: 'Start chatting' }).click()
  await expect(page).toHaveURL(/\/workspace\/chat\//, { timeout: 10_000 })

  const onboardingRes = await request.get('/api/v1/onboarding')
  const onboarding = await onboardingRes.json()
  expect(onboarding.status).toBe('completed')
})

test('developer: "use a model I already have" → Payoff shows a coding-agent picker defaulted to claude', async ({ page, request }) => {
  await resetOnboarding(request)
  await seedRealDownload(request, 'e2e-existing-model.gguf')
  await freshWizardVisit(page)

  await page.getByRole('button', { name: 'Continue' }).click() // past Welcome
  await page.getByRole('radio', { name: /Developer/ }).click()
  await page.getByRole('button', { name: 'Continue' }).click()

  await expect(page.getByRole('heading', { name: 'Choose a model' })).toBeVisible()
  // Developer (coder role) has no T0 blessed entry at all — real, correct behavior
  // (profiles.ts's BLESSED list), confirmed live via the recommendation API directly:
  // {kind:'hf-search'} on this CPU-only hardware. Only the "use existing" section renders.
  await expect(page.getByRole('button', { name: 'Download this' })).toHaveCount(0)
  // Select by exact model key, not blind index — see the Casual test above for why.
  await page.getByRole('combobox').selectOption({ value: 'e2e existing model|?|1048600' })
  await page.getByRole('button', { name: 'Use this model' }).click()

  await expect(page.getByRole('heading', { name: "You're set up", level: 3 })).toBeVisible({ timeout: 15_000 })

  const statusRes = await request.get('/api/v1/status')
  const status = await statusRes.json()
  const terminalAvailable = status.terminalAvailable !== false

  const agentSelect = page.locator('#payoff-agent')
  if (terminalAvailable) {
    // The founder's explicit ask: a first Code session should default to showing off the
    // real CLI, not the built-in chat UI.
    await expect(agentSelect).toBeVisible()
    await expect(agentSelect).toHaveValue('claude')
  } else {
    // ADR-239: never offer an agent this install can't actually run — no picker at all,
    // silently falls back to the one agent that's always available.
    await expect(agentSelect).toHaveCount(0)
  }

  // "Open Code" completes onboarding and hands off to the REAL Code launchpad
  // (CodeHomeScreen) — it must NEVER fabricate a session with a guessed repo path and a
  // canned task itself. Reported live: the old version called createCodeSession({repoRoot:
  // '.', task: '<canned string>'}) directly, silently picking a repo the user never chose
  // (the daemon's own cwd) and a task nobody asked for. Assert both the exact
  // no-session-id destination AND that the real picker's own content actually renders —
  // a URL-only check wouldn't have caught a route that resolves but shows nothing real.
  await page.getByRole('button', { name: 'Open Code' }).click()
  await expect(page).toHaveURL(/\/workspace\/code$/, { timeout: 10_000 })
  await expect(page.getByRole('heading', { name: /What.s up next/ })).toBeVisible()
})
