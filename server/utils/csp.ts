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
 */

/**
 * Directives shared by every response.
 *
 * `'unsafe-inline'` for styles is a deliberate, narrow concession: Vue's scoped
 * styles and the inline `<style>` Nuxt emits during SSR both require it, and
 * removing it would mean either giving up scoped styles or hashing every
 * generated block on every render. Scripts get no such concession.
 *
 * `img-src` allows the Drupal origin at runtime, since that is where every
 * article image is served from — see `buildImageSources`.
 */
export function buildPolicy(drupalOrigin: string | null): string {
  const imageSources = ["'self'", 'data:', 'blob:'];
  if (drupalOrigin) imageSources.push(drupalOrigin);

  return [
    "default-src 'self'",
    // No 'unsafe-inline' and no 'unsafe-eval'. Nuxt's hydration payload is a
    // JSON script tag, not executable code, so it does not need either.
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imageSources.join(' ')}`,
    "font-src 'self' data:",
    // The front end talks to its own server routes; the browser never reaches
    // Drupal directly, which is what keeps the credentials server-side.
    "connect-src 'self'",
    // Nothing in this app is a plugin host or a frame parent.
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    // Any absolute http:// URL an editor pasted into body HTML is upgraded
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
