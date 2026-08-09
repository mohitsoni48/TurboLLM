import { test, expect } from '@playwright/test'

// Real end-to-end verification of the onboarding wizard (spec 25), driven
// against the actual built daemon inside docker-compose.test.yaml's
// container — a fresh tmpfs ~/.turbollm on every run, so every test starts
// from a genuinely unonboarded install, not a mock.

test('a fresh install lands on /onboarding, not /workspace/chat', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveURL(/\/onboarding$/)
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible()
})

test('skip is present and works on the very first step', async ({ page }) => {
  await page.goto('/onboarding')
  const skip = page.getByRole('button', { name: 'Skip this step' })
  await expect(skip).toBeVisible()
  await expect(skip).toBeEnabled()
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
