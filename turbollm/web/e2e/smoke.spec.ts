import { test, expect } from '@playwright/test'

test('app shell renders at the root', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle('TurboLLM')
  await expect(page.getByRole('link', { name: 'Workspace' })).toBeVisible()
})
