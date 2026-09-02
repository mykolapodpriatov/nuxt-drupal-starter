import { getArticleForPreview } from '../../drupal/preview';
import { useDrupal } from '../../utils/drupal';
import { verifyToken } from '../../utils/signature';

/**
 * Serve an unpublished article to a holder of a valid preview link.
 *
 * The signature is checked before anything else happens, so an unsigned request
 * never reaches Drupal — it costs no backend round trip and reveals nothing
 * about whether the id exists.
 *
 * The token's payload is the node id it was issued for, and it is compared
 * against the id in the path. Without that comparison a preview link for one
 * draft would grant preview of every draft, which is the difference between a
 * link an editor can safely paste into a review thread and one that cannot
 * leave the building.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing article id' });

  const { token } = getQuery(event);
  const { drupal } = useRuntimeConfig(event);

  const result =
    typeof token === 'string' ? verifyToken(token, drupal.previewSecret) : null;

  if (!result?.valid || result.payload !== id) {
    // Deliberately a 404 rather than a 401: a 401 confirms that something
    // exists at this address and only the credential is missing. For draft
    // content that confirmation is itself the leak.
    if (result && !result.valid) {
      console.warn(`[preview] rejected token for ${id}: ${result.reason}`);
    }
    throw createError({ statusCode: 404, statusMessage: 'Not found' });
  }

  const { client, siteUrl } = useDrupal(event);
  const article = await getArticleForPreview(client, siteUrl, id);

  if (!article) throw createError({ statusCode: 404, statusMessage: 'Not found' });

  // Belt and braces: the route rules in nuxt.config already pin /preview/** to
  // no-store, but this response is served from /api and would otherwise be
  // eligible for an intermediary's cache.
  setHeader(event, 'cache-control', 'no-store, private');
  setHeader(event, 'x-robots-tag', 'noindex, nofollow');

  return article;
});
