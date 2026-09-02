import { getArticle } from '../../drupal/articles';
import { useDrupal } from '../../utils/drupal';

/**
 * One published article by UUID.
 *
 * A missing or unpublished article is a 404, not an empty 200: the page needs
 * to render Drupal's absence as an absence, and a cached empty 200 would be
 * indistinguishable from a broken query.
 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id');
  if (!id) throw createError({ statusCode: 400, statusMessage: 'Missing article id' });

  const { client, siteUrl } = useDrupal(event);
  const article = await getArticle(client, siteUrl, id);

  if (!article) throw createError({ statusCode: 404, statusMessage: 'Article not found' });
  return article;
});
