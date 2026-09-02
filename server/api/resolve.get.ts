import { getArticleByPath } from '../drupal/articles';
import { useDrupal } from '../utils/drupal';

/**
 * Resolve a public URL path to the content behind it.
 *
 * Drupal owns the site's URL structure: an editor sets an alias and the article
 * lives at `/blog/hello`, not at a path the front end invented. So the front
 * end cannot route by pattern — it has to ask what is at a given path, which is
 * what makes a catch-all route the correct shape for a decoupled site rather
 * than a lazy one.
 *
 * A path with nothing behind it is a 404 here, so the page can render Drupal's
 * absence as an absence rather than as an empty article.
 */
export default defineEventHandler(async (event) => {
  const { path } = getQuery(event);
  if (typeof path !== 'string' || !path) {
    throw createError({ statusCode: 400, statusMessage: 'Missing path' });
  }

  const { client, siteUrl } = useDrupal(event);
  const article = await getArticleByPath(client, siteUrl, path);

  if (!article) throw createError({ statusCode: 404, statusMessage: 'Not found' });

  // A discriminator, so a catch-all page can branch on content type once this
  // resolves more than articles.
  return { type: 'article' as const, article };
});
