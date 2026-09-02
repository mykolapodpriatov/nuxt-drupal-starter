import { expect, test } from '@playwright/test';
import { gotoHydrated } from './helpers';

/**
 * The contact form, driven the way a person would drive it.
 *
 * The schema is already unit-tested exhaustively. What only a browser can
 * confirm is that an error reaches the field it belongs to, that focus lands
 * somewhere useful, and that the honeypot stays out of a human's way.
 */
test.describe('contact form', () => {
  test('reports errors on the fields they belong to', async ({ page }) => {
    await gotoHydrated(page, '/contact');
    await page.getByRole('button', { name: 'Send message' }).click();

    const name = page.getByLabel('Name');
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    // Tied to the input by aria-describedby, so it is read out *with* the
    // field rather than as a stray line of red text.
    const describedBy = await name.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    await expect(page.locator(`#${describedBy}`)).toContainText('name');
  });

  test('moves focus to the first invalid field', async ({ page }) => {
    // Without this a keyboard user is told the form failed and left standing
    // at the submit button, with no indication of where the problem is.
    await gotoHydrated(page, '/contact');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByLabel('Name')).toBeFocused();
  });

  test('rejects a malformed email before contacting the server', async ({ page }) => {
    await gotoHydrated(page, '/contact');
    await page.getByLabel('Name').fill('Ada');
    await page.getByLabel('Email').fill('not-an-email');
    await page.getByLabel('Subject').fill('Hello');
    await page.getByLabel('Message').fill('A message long enough to be accepted.');

    // No request should leave the browser: the client shares the schema
    // precisely so an obvious mistake costs no round trip.
    let requested = false;
    page.on('request', (request) => {
      if (request.url().includes('/api/contact')) requested = true;
    });

    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(requested).toBe(false);
  });

  test('keeps the honeypot away from humans', async ({ page }) => {
    await gotoHydrated(page, '/contact');
    const honeypot = page.locator('#website');

    await expect(honeypot).toHaveCount(1);
    // Visually hidden rather than display:none — which a bot detects trivially
    // — but out of the tab order and hidden from assistive technology, so no
    // person ever meets it.
    await expect(honeypot).not.toBeInViewport();
    await expect(honeypot).toHaveAttribute('tabindex', '-1');
    await expect(page.locator('[aria-hidden="true"] #website')).toHaveCount(1);
  });

  test('confirms a successful submission', async ({ page }) => {
    await gotoHydrated(page, '/contact');
    await page.getByLabel('Name').fill('Ada Lovelace');
    await page.getByLabel('Email').fill('ada@example.test');
    await page.getByLabel('Subject').fill('A question about the engine');
    await page.getByLabel('Message').fill('Could you tell me how the front end is decoupled?');

    await page.getByRole('button', { name: 'Send message' }).click();

    // Scoped for the same reason as in the preview suite: Nuxt's route
    // announcer is also a `role="status"` region.
    await expect(page.locator('p[role="status"].notice')).toContainText('Thank you');
  });
});
