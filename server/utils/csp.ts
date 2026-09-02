/**
 * The Content-Security-Policy this app serves, as pure functions.
 *
 * Separate from the Nitro plugin that applies them so the policy can be tested
 * directly. A plugin module cannot be imported from a plain node test —
 * `defineNitroPlugin` is a Nitro auto-import and is simply not defined there —
 * so keeping the logic here is what makes it reachable at all.
 *
 * It is also the better split on its own terms: this file decides what the
 * policy is, the plugin only decides when to attach it.
 *
 * ## Why there is a nonce
 *
 * The first version of this file used a flat `script-src 'self'`, on the
 * reasoning that Nuxt's hydration payload is data rather than code. That was
 * wrong, and wrong in the worst way: Nuxt emits inline `<script>` blocks to
 * bootstrap the client, the policy blocked them, and **the application never
 * hydrated**. Every page rendered and looked correct; nothing was interactive.
 *
 * Unit tests passed. The headers were present and looked right. Only a real
 * browser reported it, as `Executing inline script violates the following
 * Content Security Policy directive`. It is the clearest argument in this
 * repository for end-to-end tests that drive an actual browser against an
 * actual build.
 *
 * The fix is a per-request nonce rather than `'unsafe-inline'`. `'unsafe-inline'`
 * would work and would discard most of the value of having a CSP at all: any
 * injected `<script>` would then execute too. A nonce permits exactly the
 * scripts this server emitted.
 */

/**
 * Build the policy.
 *
 * @param drupalOrigin
 *   Origin serving article images, or `null` in fixture mode.
 * @param nonce
 *   Per-request nonce, applied to the inline scripts Nuxt emits. Omitting it
 *   produces a policy with no inline script allowance at all — correct for a
 *   response that carries no inline script, and fatal for one that does.
 */
export function buildPolicy(drupalOrigin: string | null, nonce?: string): string {
  const imageSources = ["'self'", 'data:', 'blob:'];
  if (drupalOrigin) imageSources.push(drupalOrigin);

  const scriptSources = ["'self'"];
  if (nonce) {
    scriptSources.push(`'nonce-${nonce}'`);
    // `strict-dynamic` lets a nonced script load the chunks it needs without
    // every one of them being enumerated here — which is what makes a nonce
    // workable alongside code splitting. Browsers that do not support it fall
    // back to the source list, so `'self'` stays as the safety net.
    scriptSources.push("'strict-dynamic'");
  }

  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(' ')}`,
    // Inline *styles* are allowed deliberately. Vue's scoped styles and the
    // inline <style> Nuxt emits during SSR both require it, and removing it
    // would mean giving up scoped styles or hashing every generated block on
    // every render. A style cannot execute; a script can.
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imageSources.join(' ')}`,
    "font-src 'self' data:",
    // The browser talks to this app's own server routes and never to Drupal,
    // which is what keeps the credentials server-side.
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    // An absolute http:// URL an editor pasted into body HTML is upgraded
    // rather than blocked, so mixed content does not silently break a page.
    'upgrade-insecure-requests',
  ].join('; ');
}

/**
 * The origin part of the Drupal base URL, or `null` when running on fixtures.
 *
 * Only the origin: putting a full URL with a path into a CSP source list is a
 * common way to write a directive that matches nothing.
 */
export function drupalOriginFor(baseUrl: string): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).origin;
  } catch {
    // A malformed base URL must not take the whole response down; the policy
    // is simply stricter than intended, which fails visibly rather than
    // silently.
    return null;
  }
}
