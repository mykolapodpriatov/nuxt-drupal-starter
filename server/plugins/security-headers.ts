import { buildPolicy, drupalOriginFor } from '../utils/csp';

/**
 * Security headers, set once for every response.
 *
 * A Nitro plugin rather than route rules, because these have to apply to
 * everything — pages, API routes, the sitemap, error responses — and a header
 * that is missing from exactly one route is a header that does not exist.
 *
 * The policy itself lives in `server/utils/csp.ts`; this file is the wiring.
 *
 * Registered with `defineNitroPlugin` rather than a bare default export: Nitro
 * discovers plugins by that wrapper, and an unwrapped function is loaded
 * without its hooks ever firing — every header silently missing, with nothing
 * in the build output to say so. Found by checking the response, not by
 * reading the code.
 */
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('render:response', (response, { event }) => {
    const { drupal } = useRuntimeConfig(event);
    const headers = (response.headers ??= {});

    headers['content-security-policy'] = buildPolicy(drupalOriginFor(drupal.baseUrl));

    // Stops a browser from second-guessing a declared Content-Type, which is
    // how a user-uploaded file ends up executed as script.
    headers['x-content-type-options'] = 'nosniff';

    // Send the origin cross-site, the full path same-site. A preview URL
    // carries a signed token in its query string, and the default policy would
    // hand that token to every third-party asset the page loads.
    headers['referrer-policy'] = 'strict-origin-when-cross-origin';

    // Nothing here needs a camera, a microphone or a location.
    headers['permissions-policy'] = 'camera=(), microphone=(), geolocation=(), payment=()';

    // Redundant alongside `frame-ancestors 'none'`, and kept for the browsers
    // that honour one and not the other.
    headers['x-frame-options'] = 'DENY';
  });
});
