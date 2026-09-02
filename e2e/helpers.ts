import type { Page } from '@playwright/test';

/**
 * Navigate and wait until Vue has hydrated.
 *
 * Server-rendered markup is interactive-looking well before it is interactive.
 * Clicking a button in that window gets the browser's native behaviour rather
 * than the Vue handler — for a form, a full page submit and reload, which
 * presents as "validation did not fire" and, being timing-dependent, as flake.
 *
 * `app.vue` sets `data-hydrated` in `onMounted`, so this waits on a real
 * signal instead of an arbitrary delay.
 */
export async function gotoHydrated(page: Page, path: string): Promise<void> {
  await page.goto(path);
  // `attached`, not the default `visible`: Playwright does not consider the
  // <html> element visible, so the default state waits forever.
  await page.waitForSelector('html[data-hydrated="true"]', {
    state: 'attached',
    timeout: 15_000,
  });
}
