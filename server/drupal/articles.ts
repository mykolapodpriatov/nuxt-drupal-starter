/**
 * Article queries.
 *
 * The one place that decides which JSON:API request an article listing or an
 * article page makes. Keeping the query shapes here rather than in the route
 * handlers means the published filter, the include path and the sparse
 * fieldset are stated once — and the published filter in particular is the kind
 * of thing that must not be re-derived per call site.
 */
import type { DrupalClient } from './client.js';
import { indexIncluded, toArticle, toArticleSummary } from './normalize.js';
import { readNextCursor } from './client.js';
import type { Article, ArticleSummary, Paginated } from '../../shared/domain.js';

/**
 * Relationship paths to side-load.
 *
 * Two candidates, because which one is valid depends on how the site was built:
 * a media-reference field needs the second hop, a plain image field has no
 * `field_media_image` to traverse and rejects it with a 400. Same reason the
 * snapshot script probes rather than assumes — see ADR-002.
 */
const INCLUDE_CANDIDATES: string[][] = [
  ['field_image', 'field_image.field_media_image'],
  ['field_image'],
  [],
];

/**
 * Only published content ever reaches a public route.
 *
 * The dotted path expands to `filter[status][value]=1`. Writing the brackets by
 * hand produces `filter[status[value]]`, which Drupal silently ignores and
 * answers with every draft included.
 */
const PUBLISHED: Record<string, string> = { 'status.value': '1' };

/**
 * Run a request against each include candidate until one is accepted.
 *
 * A 400 here means "that include path does not exist on this site", which is
 * information rather than a failure. Anything else propagates: a timeout must
 * not be retried three times and then reported as a missing field.
 */
async function withIncludeFallback<T>(
  attempt: (include: string[]) => Promise<T>,
): Promise<T> {
  let lastError: unknown = null;
  for (const include of INCLUDE_CANDIDATES) {
    try {
      return await attempt(include);
    } catch (error: unknown) {
      const status = (error as { kind?: string } | null)?.kind;
      if (status !== 'http-error') throw error;
      lastError = error;
    }
  }
  throw lastError;
}

export interface ListArticlesOptions {
  limit?: number;
  /** Opaque cursor from a previous page's `nextCursor`. */
  offset?: number;
}

/** A page of published articles, newest first. */
export async function listArticles(
  client: DrupalClient,
  siteUrl: string,
  options: ListArticlesOptions = {},
): Promise<Paginated<ArticleSummary>> {
  const { limit = 10, offset } = options;

  const document = await withIncludeFallback((include) =>
    client.getCollection('node/article', {
      ...(include.length ? { include } : {}),
      filter: PUBLISHED,
      sort: ['-created'],
      limit,
      ...(offset !== undefined ? { offset } : {}),
    }),
  );

  const index = indexIncluded(document.included);
  return {
    items: document.data.map((resource) => toArticleSummary(resource, index, siteUrl)),
    nextCursor: readNextCursor(document),
  };
}

/**
 * One article by UUID.
 *
 * Published-only. Preview of unpublished content is a separate, authenticated
 * route — mixing the two here is how a draft ends up on a cached public URL.
 */
export async function getArticle(
  client: DrupalClient,
  siteUrl: string,
  id: string,
): Promise<Article | null> {
  const document = await withIncludeFallback((include) =>
    client.getResource('node/article', id, {
      ...(include.length ? { include } : {}),
    }),
  );

  const article = toArticle(document.data, indexIncluded(document.included), siteUrl);
  // Defence in depth: `getResource` addresses a node directly, so Drupal's own
  // access control is what actually withholds a draft from an anonymous
  // consumer. This is the second lock, for the case where the front end is
  // configured with a token that can see more than the public should.
  return article.published ? article : null;
}

/**
 * Resolve a public URL path to the article behind it.
 *
 * Not a JSON:API filter, because Drupal cannot do it. `path` is a *computed*
 * field, so the two plausible spellings both fail — and they fail differently,
 * which is why this took a live request to discover rather than a reading of
 * the docs:
 *
 * ```
 * filter[path.alias]=/blog/hello   → 500  "'path' not found"
 * filter[path][alias]=/blog/hello  → 400  "You must provide a valid filter condition."
 * ```
 *
 * So resolution is a separate step, served by
 * `drupal/modules/custom/nuxt_router`: ask Drupal what is at this path, then
 * fetch that entity over JSON:API as normal. Two requests instead of one, in
 * exchange for aliases, redirects and language prefixes behaving exactly as
 * they do for the site itself — and for a single code path turning a Drupal
 * resource into a domain model.
 *
 * See docs/adr/004-path-resolution.md.
 */
export async function getArticleByPath(
  client: DrupalClient,
  siteUrl: string,
  path: string,
): Promise<Article | null> {
  const alias = path.startsWith('/') ? path : `/${path}`;

  let resolved: unknown;
  try {
    resolved = await client.getJson(`/api/resolve?path=${encodeURIComponent(alias)}`);
  } catch (error: unknown) {
    // The resolver answers 404 for a path with nothing behind it, and for a
    // path whose entity the current user may not view. Both mean "no such
    // page" to the caller.
    if ((error as { kind?: string } | null)?.kind === 'http-error') return null;
    throw error;
  }

  const entity = (resolved as { found?: boolean; entity?: ResolvedEntity } | null)?.entity;
  if (!entity || typeof entity.uuid !== 'string') return null;

  // Only articles have a page in this starter. A resolved taxonomy term or user
  // is a real entity at a real path, and rendering it as an article would be
  // worse than reporting nothing.
  if (entity.resourceType !== 'node--article') return null;

  return getArticle(client, siteUrl, entity.uuid);
}

/** The identity `nuxt_router` returns for a resolved path. */
interface ResolvedEntity {
  type?: string;
  bundle?: string;
  uuid?: string;
  resourceType?: string;
  langcode?: string;
}
