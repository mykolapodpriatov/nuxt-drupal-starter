/**
 * Fetching content the public cannot see.
 *
 * Preview is the one place this front end deliberately reads unpublished
 * content, and it is therefore the one place where getting the guard wrong
 * publishes drafts. Two independent conditions have to hold, and neither is
 * sufficient alone:
 *
 * 1. **The request carries a valid, unexpired signature.** Verified before any
 *    call to Drupal happens, so an unsigned request costs nothing and reveals
 *    nothing — not even whether the node exists.
 * 2. **The front end is configured with a Drupal token that may see drafts.**
 *    Without one, Drupal's own access control withholds the node and preview
 *    simply does not work. That is the correct failure: the CMS remains the
 *    authority on who may read what, and this app cannot grant itself access it
 *    was not given.
 */
import type { DrupalClient } from './client.js';
import { indexIncluded, toArticle } from './normalize.js';
import type { Article } from '../../shared/domain.js';

/**
 * Fetch an article regardless of its published state.
 *
 * Unlike `getArticle`, this does *not* filter on `published` — that is the
 * entire point. The caller is responsible for having verified the preview
 * signature first.
 */
export async function getArticleForPreview(
  client: DrupalClient,
  siteUrl: string,
  id: string,
): Promise<Article | null> {
  try {
    const document = await client.getResource('node/article', id, {
      include: ['field_image'],
    });
    return toArticle(document.data, indexIncluded(document.included), siteUrl);
  } catch (error: unknown) {
    // A draft the configured token cannot see is indistinguishable from a node
    // that does not exist, and should stay that way: reporting "exists but
    // forbidden" would confirm the id to anyone holding a valid signature for a
    // different node.
    const kind = (error as { kind?: string } | null)?.kind;
    if (kind === 'http-error' || kind === 'api-error') return null;
    throw error;
  }
}
