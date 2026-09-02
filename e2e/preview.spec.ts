import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';

/**
 * Preview, exercised through a browser rather than through the API.
 *
 * The signature scheme is unit-tested, including the forgeries. What this adds
 * is the part that only exists once a page renders: that a valid link produces
 * a page which says it is a draft, and that an invalid one produces a 404
 * rather than a login prompt or a stack trace.
 */

const SECRET = 'e2e-preview-secret';

/** Reproduces what Drupal's FrontendSigner emits. */
function issueToken(payload: string, ttlSeconds = 600): string {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const encoded = Buffer.from(payload, 'utf8').toString('base64url');
  const signature = createHmac('sha256', SECRET)
    .update(`${payload}:${expiresAt}`)
    .digest('base64url');
  return `${encoded}.${expiresAt}.${signature}`;
}

test.describe('preview', () => {
  test('a valid link renders the content and says it is a preview', async ({
    page,
    request,
  }) => {
    const listing = await (await request.get('/api/articles')).json();
    const id = listing.items[0].id as string;

    const response = await page.goto(`/preview/${id}?token=${issueToken(id)}`);
    expect(response?.status()).toBe(200);

    // Scoped to the banner: `<NuxtRouteAnnouncer>` is also a `role="status"`
    // live region, so an unscoped query matches two elements. Both are wanted —
    // the announcer names the page, the banner names the state.
    await expect(page.locator('p[role="status"].banner')).toContainText('Preview');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('a preview is never cached and never indexed', async ({ page, request }) => {
    const listing = await (await request.get('/api/articles')).json();
    const id = listing.items[0].id as string;

    const response = await page.goto(`/preview/${id}?token=${issueToken(id)}`);
    const headers = response?.headers() ?? {};

    expect(headers['cache-control']).toContain('no-store');
    expect(headers['x-robots-tag']).toContain('noindex');
    // A meta tag as well as the header: indexing a draft is not reversible on
    // any timescale anyone cares about.
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      'content',
      /noindex/,
    );
  });

  test('a forged token is a 404, not an invitation to try again', async ({
    page,
    request,
  }) => {
    const listing = await (await request.get('/api/articles')).json();
    const id = listing.items[0].id as string;

    // 401 would confirm something exists at the address and only the credential
    // is missing. For draft content that confirmation is itself the leak.
    const response = await page.goto(`/preview/${id}?token=forged-nonsense`);
    expect(response?.status()).toBe(404);
  });

  test('a token issued for a different article does not open this one', async ({
    page,
    request,
  }) => {
    const listing = await (await request.get('/api/articles')).json();
    const [first, second] = listing.items as { id: string }[];

    // Without the payload check, one preview link grants preview of every
    // draft in the CMS.
    const response = await page.goto(`/preview/${first.id}?token=${issueToken(second.id)}`);
    expect(response?.status()).toBe(404);
  });

  test('preview is excluded in robots.txt', async ({ request }) => {
    const body = await (await request.get('/robots.txt')).text();
    expect(body).toContain('Disallow: /preview/');
  });
});
