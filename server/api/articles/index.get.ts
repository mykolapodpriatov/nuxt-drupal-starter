import { listArticles } from '../../drupal/articles';
import { useDrupal } from '../../utils/drupal';

/**
 * A page of published articles, newest first.
 *
 * Kept as a server route rather than fetched from the component so the Drupal
 * base URL and any token stay server-side, and so the browser sees a small
 * stable shape instead of a JSON:API document.
 */
export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const { client, siteUrl } = useDrupal(event);

  const limit = Number(query.limit ?? 10);
  const offset = Number(query.offset ?? Number.NaN);

  return listArticles(client, siteUrl, {
    // A hostile `?limit=100000` should not turn into a request that times out
    // against Drupal; clamp rather than trust.
    limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 50) : 10,
    ...(Number.isFinite(offset) ? { offset } : {}),
  });
});
