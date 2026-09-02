/**
 * Capture the screenshots the README uses.
 *
 * Generated rather than hand-taken, so they can be regenerated after a change
 * instead of quietly describing a version of the UI that no longer exists — a
 * README illustrated with a stale screenshot is worse than one with none.
 *
 * Run against a build, with the fixture backend, so the output is
 * deterministic:
 *
 * ```bash
 * pnpm build && pnpm screenshots
 * ```
 */
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createHmac } from 'node:crypto';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../docs/screenshots');
const BASE = process.env.SCREENSHOT_BASE_URL ?? 'http://127.0.0.1:3210';
const PREVIEW_SECRET = process.env.NUXT_DRUPAL_PREVIEW_SECRET ?? 'e2e-preview-secret';

function issueToken(payload: string, ttlSeconds = 600): string {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const encoded = Buffer.from(payload, 'utf8').toString('base64url');
  const signature = createHmac('sha256', PREVIEW_SECRET)
    .update(`${payload}:${expiresAt}`)
    .digest('base64url');
  return `${encoded}.${expiresAt}.${signature}`;
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch();
  // A fixed viewport and DPR so a regenerated screenshot differs only where the
  // UI did — otherwise every capture is a full-image diff.
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
  });
  const page = await context.newPage();

  const shots: { name: string; path: string; fullPage?: boolean }[] = [
    { name: 'home', path: '/' },
    { name: 'articles', path: '/articles' },
    { name: 'contact', path: '/contact' },
  ];

  for (const shot of shots) {
    await page.goto(`${BASE}${shot.path}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('html[data-hydrated="true"]', { state: 'attached' });
    await page.screenshot({
      path: resolve(OUT, `${shot.name}.png`),
      fullPage: shot.fullPage ?? false,
    });
    console.log(`captured ${shot.name}.png`);
  }

  // An article, at the alias its editor chose.
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const href = await page.locator('article a[href^="/blog/"]').first().getAttribute('href');
  if (href) {
    await page.goto(`${BASE}${href}`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: resolve(OUT, 'article.png') });
    console.log('captured article.png');
  }

  // Preview mode, which is the screenshot that shows what this starter is for.
  const listing = (await (await fetch(`${BASE}/api/articles`)).json()) as {
    items: { id: string }[];
  };
  const id = listing.items[0]?.id;
  if (id) {
    await page.goto(`${BASE}/preview/${id}?token=${issueToken(id)}`, {
      waitUntil: 'networkidle',
    });
    await page.screenshot({ path: resolve(OUT, 'preview.png') });
    console.log('captured preview.png');
  }

  await browser.close();
}

await main();
