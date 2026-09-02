import { randomBytes } from 'node:crypto';
import { buildPolicy, drupalOriginFor } from '../utils/csp';

/**
 * Security headers, set once for every response.
 *
 * A Nitro plugin rather than route rules, because these have to apply to
 * everything — pages, API routes, the sitemap, error responses — and a header
 * that is missing from exactly one route is a header that does not exist.
 *
 * Split across two hooks for that reason. `beforeResponse` fires for every
 * response, including JSON from the API routes and the XML sitemap, and
 * carries the headers that do not depend on the rendered HTML. `render:html`
 * and `render:response` handle the CSP, which needs a nonce that only exists
 * for a rendered page.
 *
 * The policy itself lives in `server/utils/csp.ts`; this file is the wiring,
 * and the wiring has two halves that have to agree:
 *
 * - `render:html` stamps a nonce onto the inline scripts Nuxt emits;
 * - `render:response` names that same nonce in the policy.
 *
 * They communicate through `event.context`. A nonce that differs between the
 * two blocks every script — which is exactly the failure this mechanism exists
 * to fix, so the coupling is deliberate and worth stating.
 *
 * Registered with `defineNitroPlugin` rather than a bare default export: Nitro
 * discovers plugins by that wrapper, and an unwrapped function is loaded
 * without its hooks ever firing — every header silently missing, with nothing
 * in the build output to say so. Found by reading the response, not the code.
 */
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('render:html', (html, { event }) => {
    // A fresh nonce per request. Reusing one would let anyone who saw a single
    // page reuse its nonce indefinitely, which is the same as not having one.
    const nonce = randomBytes(16).toString('base64');
    event.context.cspNonce = nonce;

    // Nuxt puts its bootstrap and hydration payload in `bodyAppend`, and can
    // put config and preload scripts in `head`. Both are stamped: an inline
    // script without the nonce is blocked, and a blocked bootstrap means the
    // page renders and is never interactive.
    const stamp = (fragments: string[]): string[] =>
      fragments.map((fragment) =>
        fragment.replace(/<script(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`),
      );

    html.head = stamp(html.head);
    html.bodyPrepend = stamp(html.bodyPrepend);
    html.bodyAppend = stamp(html.bodyAppend);
  });

  nitroApp.hooks.hook('render:response', (response, { event }) => {
    const { drupal } = useRuntimeConfig(event);
    const headers = (response.headers ??= {});

    const nonce = event.context.cspNonce as string | undefined;
    headers['content-security-policy'] = buildPolicy(
      drupalOriginFor(drupal.baseUrl),
      nonce,
    );
  });

  // Everything that does not depend on the rendered document. `beforeResponse`
  // fires for API JSON and the sitemap too, which `render:response` does not.
  nitroApp.hooks.hook('beforeResponse', (event) => {
    // Stops a browser from second-guessing a declared Content-Type, which is
    // how a user-uploaded file ends up executed as script.
    setHeader(event, 'x-content-type-options', 'nosniff');

    // Send the origin cross-site, the full path same-site. A preview URL
    // carries a signed token in its query string, and the default policy would
    // hand that token to every third-party asset the page loads.
    setHeader(event, 'referrer-policy', 'strict-origin-when-cross-origin');

    // Nothing here needs a camera, a microphone or a location.
    setHeader(event, 'permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');

    // Redundant alongside `frame-ancestors 'none'`, and kept for the browsers
    // that honour one and not the other.
    setHeader(event, 'x-frame-options', 'DENY');
  });
});
