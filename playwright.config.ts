import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against a **built** application, not the dev server.
 *
 * Dev-only behaviour is different behaviour: the dev server has no route-rule
 * caching, different error pages and no minification. A suite that passes there
 * and fails in production is worse than no suite, because it is trusted.
 *
 * Fixture mode by default, so the tests need no Drupal — that is also what
 * makes them deterministic. Point NUXT_DRUPAL_BASE_URL at a live instance to
 * run the same suite against a real backend.
 */
export default defineConfig({
  testDir: './e2e',
  // A flaky end-to-end suite gets ignored, and an ignored suite is dead weight.
  // Failing on `.only` keeps a debugging shortcut from silently disabling the
  // rest of it in CI.
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',

  use: {
    // Not 3000. That port is whatever happened to be running on the developer's
    // machine, and Playwright will happily test it — the first run of this
    // suite passed its assertions against an unrelated application.
    baseURL: 'http://127.0.0.1:3210',
    // Artefacts only for failures: a green run should not cost storage.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: 'pnpm run build && node .output/server/index.mjs',
    url: 'http://127.0.0.1:3210',
    // Never reuse: an existing listener on this port is not necessarily this
    // application, and testing something else that answers is worse than
    // failing to start.
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      // Secrets the preview test signs with. Real values come from the
      // environment; these exist so the suite is self-contained.
      NUXT_DRUPAL_PREVIEW_SECRET: 'e2e-preview-secret',
      NUXT_DRUPAL_REVALIDATE_SECRET: 'e2e-revalidate-secret',
      NUXT_PUBLIC_SITE_URL: 'http://127.0.0.1:3210',
      HOST: '127.0.0.1',
      PORT: '3210',
    },
  },
});
