import { verifyBodySignature } from '../utils/signature';

/**
 * Purge cached pages when Drupal says the content behind them changed.
 *
 * Without this, the choice is between stale pages and no caching at all. The
 * `swr` route rules in `nuxt.config.ts` mean an editor's change appears within
 * the TTL; this makes it appear immediately, which is the difference between a
 * CMS that feels live and one that feels broken.
 *
 * The endpoint is unauthenticated in the session sense — Drupal is a server,
 * not a user — so the signature is the whole of the security:
 *
 * - **The raw body is signed, not the parsed object.** Two JSON documents that
 *   parse equal can serialise differently, so signing the parsed form lets
 *   sender and receiver disagree about what was signed.
 * - **A missing secret rejects everything.** An unset
 *   `NUXT_DRUPAL_REVALIDATE_SECRET` must not mean "anyone may purge the cache",
 *   which is a denial-of-service primitive handed to the internet.
 * - **Paths are validated before use.** A cache key is derived from the path,
 *   and an unvalidated one is an invitation to purge or address something the
 *   caller should not reach.
 *
 * Replay is not defended against, deliberately: the worst a replayed purge does
 * is evict a cache entry that will be repopulated on the next request. Adding a
 * nonce store to prevent that would cost more than the attack.
 */
export default defineEventHandler(async (event) => {
  const { drupal } = useRuntimeConfig(event);

  // Read the body as text before parsing: the signature covers these exact
  // bytes, and `readBody` would hand back an object that has already lost them.
  const raw = await readRawBody(event, 'utf8');
  if (!raw) {
    throw createError({ statusCode: 400, statusMessage: 'Empty body' });
  }

  const signature = getHeader(event, 'x-drupal-signature') ?? '';

  if (!verifyBodySignature(raw, signature, drupal.revalidateSecret)) {
    // 401 rather than 404 here, unlike preview: this address is documented and
    // its existence is not a secret, so there is nothing to conceal — and a
    // clear status makes a misconfigured webhook debuggable from Drupal's logs.
    console.warn('[revalidate] rejected a request with an invalid signature');
    throw createError({ statusCode: 401, statusMessage: 'Invalid signature' });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'Body is not JSON' });
  }

  const requested = (payload as { paths?: unknown } | null)?.paths;
  if (!Array.isArray(requested)) {
    throw createError({ statusCode: 400, statusMessage: 'Expected a `paths` array' });
  }

  const paths = requested.filter(isSafePath);

  const storage = useStorage('cache');
  const purged: string[] = [];

  for (const path of paths) {
    // Nitro keys rendered pages under `nitro:handlers:_:…`; the route cache for
    // our own API handlers lives under the name given to
    // `defineCachedEventHandler`. Both are cleared, because a stale menu is as
    // visible as a stale page.
    const keys = await storage.getKeys();
    const normalised = path === '/' ? 'index' : path.replace(/^\/+|\/+$/g, '').replace(/\//g, ':');

    for (const key of keys) {
      if (key.includes(normalised)) {
        await storage.removeItem(key);
        purged.push(key);
      }
    }
  }

  // Menus are read on every page, so a content change that alters navigation
  // has to drop them too. Cheap to rebuild, expensive to serve stale.
  const menuKeys = (await storage.getKeys()).filter((key) => key.includes('drupal-menu'));
  for (const key of menuKeys) {
    await storage.removeItem(key);
    purged.push(key);
  }

  return {
    revalidated: paths,
    // Reported so a misconfigured webhook is diagnosable: "accepted 3 paths,
    // purged 0 entries" says the paths did not match anything cached, which is
    // a different problem from a rejected signature.
    purgedKeys: purged.length,
    ...(paths.length !== requested.length
      ? { rejected: requested.length - paths.length }
      : {}),
  };
});

/**
 * Accept only a site-relative path.
 *
 * Rejects absolute URLs (`https://elsewhere/`), protocol-relative ones
 * (`//elsewhere`), and traversal (`../`). A cache key is derived from this
 * value, so an unvalidated path is a way to address entries the caller has no
 * business touching.
 */
function isSafePath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//')) return false;
  if (value.includes('..')) return false;
  if (value.length > 2048) return false;
  return true;
}
