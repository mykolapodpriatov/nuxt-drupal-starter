import { expect, test } from '@playwright/test';

/**
 * The reading path, end to end against a built application.
 *
 * These are deliberately few. Unit tests already cover the mappers, the
 * validators and the signature scheme exhaustively and in milliseconds; what
 * they cannot tell you is whether the pieces, assembled and built, actually
 * render a page. That is the only question this file asks.
 */

test.describe('reading', () => {
  test('the home page lists articles from Drupal', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Latest articles');
    // At least one article card, each linking to the alias Drupal gave it.
    const links = page.locator('article a[href^="/blog/"]');
    await expect(links.first()).toBeVisible();
  });

  test('navigation is rendered server-side, before any JavaScript runs', async ({
    browser,
  }) => {
    // The point of SSR here: navigation that only appears after hydration is a
    // layout shift on every load and invisible to a crawler. Disabling
    // JavaScript is the only honest way to assert it.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto('/');

    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav.getByRole('link', { name: 'Articles' })).toBeVisible();
    // A code-defined Drupal menu link, which JSON:API cannot expose at all —
    // see ADR-003. Its presence is the proof the custom endpoint is in use.
    await expect(nav.getByRole('link', { name: 'Home' })).toBeVisible();

    await context.close();
  });

  test('an article opens at the alias its editor chose', async ({ page }) => {
    await page.goto('/');

    const firstArticle = page.locator('article a[href^="/blog/"]').first();
    const href = await firstArticle.getAttribute('href');
    expect(href).toMatch(/^\/blog\//);

    await firstArticle.click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('.body')).not.toBeEmpty();
  });

  test('an article page carries the metadata a crawler needs', async ({ page }) => {
    await page.goto('/');
    await page.locator('article a[href^="/blog/"]').first().click();

    await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
    await expect(page.locator('meta[property="og:title"]')).toHaveCount(1);
    // Structured data, so the article is eligible for a rich result rather
    // than leaving a search engine to infer the headline from the markup.
    const ld = await page.locator('script[type="application/ld+json"]').textContent();
    expect(JSON.parse(ld ?? '{}')).toMatchObject({ '@type': 'Article' });
  });

  test('the archive paginates without losing its place', async ({ page }) => {
    await page.goto('/articles');

    const pager = page.getByRole('navigation', { name: 'Pagination' });
    // Disabled rather than hidden: a control that disappears moves the one
    // beside it under the reader's cursor.
    await expect(pager.getByRole('button', { name: /Newer/ })).toBeDisabled();
  });

  test('an unknown path is a real 404, not an empty page', async ({ page }) => {
    // A 200 with an empty body is how dead URLs stay indexed.
    const response = await page.goto('/blog/this-was-never-published');
    expect(response?.status()).toBe(404);
  });

  test('the sitemap lists the articles Drupal published', async ({ request }) => {
    const response = await request.get('/sitemap.xml');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('xml');

    const body = await response.text();
    expect(body).toContain('<urlset');
    expect(body.match(/<url>/g)?.length ?? 0).toBeGreaterThan(2);
  });

  test('every response carries the security headers', async ({ page }) => {
    const response = await page.goto('/');
    const headers = response?.headers() ?? {};

    const csp = headers['content-security-policy'] ?? '';
    // The directive that carries the value: no inline script, no eval.
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-(inline|eval)/);
    expect(csp).toContain("frame-ancestors 'none'");

    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });
});
