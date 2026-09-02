import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { gotoHydrated } from './helpers';

/**
 * Automated accessibility checks on every page a visitor can reach.
 *
 * Worth being honest about what this does and does not prove. Automated tooling
 * catches perhaps a third of real accessibility problems — the mechanical ones:
 * missing labels, insufficient contrast, unnamed landmarks, broken heading
 * order. It cannot tell you whether the focus order makes sense, whether an
 * error message is comprehensible, or whether the page is usable at all with a
 * screen reader.
 *
 * So this is a floor, not a certificate. The judgement-dependent parts are
 * asserted individually below and in the contact-form suite: focus moving to
 * the first invalid field, state conveyed by more than colour, the skip link
 * being genuinely first.
 */

/** WCAG 2.1 AA — the level most procurement and most legislation asks for. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function scan(page: Page) {
  return new AxeBuilder({ page }).withTags(TAGS).analyze();
}

test.describe('accessibility', () => {
  test('home page has no automatically detectable violations', async ({ page }) => {
    await page.goto('/');
    const results = await scan(page);
    expect(results.violations).toEqual([]);
  });

  test('article listing has no automatically detectable violations', async ({ page }) => {
    await page.goto('/articles');
    expect((await scan(page)).violations).toEqual([]);
  });

  test('article page has no automatically detectable violations', async ({ page }) => {
    await page.goto('/');
    await page.locator('article a[href^="/blog/"]').first().click();
    expect((await scan(page)).violations).toEqual([]);
  });

  test('contact form has no automatically detectable violations', async ({ page }) => {
    await page.goto('/contact');
    expect((await scan(page)).violations).toEqual([]);
  });

  test('contact form in its error state has none either', async ({ page }) => {
    // The error state is a different page as far as accessibility is concerned,
    // and it is the state nobody remembers to check.
    await gotoHydrated(page, '/contact');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByLabel('Name')).toHaveAttribute('aria-invalid', 'true');

    expect((await scan(page)).violations).toEqual([]);
  });

  test('the 404 page has none either', async ({ page }) => {
    await page.goto('/blog/nothing-is-here');
    expect((await scan(page)).violations).toEqual([]);
  });

  test('the skip link is the first thing a keyboard reaches', async ({ page }) => {
    // Not something axe can judge. Without it, a keyboard user tabs through the
    // whole navigation on every single page before reaching the content.
    await page.goto('/');
    await page.keyboard.press('Tab');

    const focused = page.locator(':focus');
    await expect(focused).toHaveText('Skip to content');
    // And it has to become visible when focused — off-screen but focusable is
    // the correct pattern; off-screen and invisible is a trap.
    await expect(focused).toBeInViewport();
  });

  test('the skip link moves focus past the navigation', async ({ page }) => {
    await gotoHydrated(page, '/');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');

    await expect(page.locator('#main')).toBeFocused();
  });

  test('the current page is marked, not merely coloured', async ({ page }) => {
    // Styling the active link without `aria-current` conveys the state by
    // colour alone — exactly what the baseline exists to prevent.
    await page.goto('/articles');
    const current = page.getByRole('navigation', { name: 'Primary' }).locator(
      '[aria-current="page"]',
    );
    await expect(current).toHaveCount(1);
  });

  test('each page has exactly one level-1 heading', async ({ page }) => {
    // Heading structure is how a screen reader user skims. Two h1s, or none,
    // makes the page an undifferentiated wall.
    for (const path of ['/', '/articles', '/contact']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    }
  });
});
