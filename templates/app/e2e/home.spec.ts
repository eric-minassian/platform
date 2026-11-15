import { expect, test } from '@playwright/test';

// CI runs this suite against previews, which keep their data between runs, and
// against production after each deploy, so a test must leave nothing behind:
// only read, or remove what it writes. Deployed stages sign in through the real
// user pool, so tests there run signed out.
test('signed out, the home page offers sign-in', async ({ page }) => {
  const me = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/me');
  await page.goto('/');
  expect((await me).ok()).toBe(true);
  await expect(page.getByRole('heading', { name: 'template-app' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
});
