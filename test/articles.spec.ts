import { describe, expect, it, vi } from 'vitest';
import { getArticle, getArticleByPath, listArticles } from '../server/drupal/articles.js';
import { createClientForSettings } from '../server/drupal/index.js';
import { DrupalResponseError } from '../server/drupal/validate.js';
import type { DrupalClient, DrupalQuery } from '../server/drupal/client.js';

const SITE = 'https://cms.example.test';

/** The fixture-backed client the application uses when no backend is set. */
function fixtureClient(): DrupalClient {
  return createClientForSettings({ baseUrl: '', token: '', timeoutMs: 5000 }).client;
}

/** A client that records the queries it was asked to run. */
function recordingClient(
  overrides: Partial<DrupalClient> = {},
): { client: DrupalClient; queries: DrupalQuery[] } {
  const queries: DrupalQuery[] = [];
  const client: DrupalClient = {
    getCollection: (_type, query) => {
      queries.push(query ?? {});
      return Promise.resolve({ data: [] });
    },
    getResource: (_type, _id, query) => {
      queries.push(query ?? {});
      return Promise.resolve({ data: { type: 'node--article', id: 'x' } });
    },
    getJson: () => Promise.resolve({}),
    request: () => Promise.resolve({}),
    ...overrides,
  };
  return { client, queries };
}

describe('listArticles', () => {
  it('returns mapped summaries from the captured snapshot', async () => {
    const page = await listArticles(fixtureClient(), SITE);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items[0]).toHaveProperty('title');
    expect(page.items[0]).not.toHaveProperty('bodyHtml');
  });

  it('asks Drupal for published content only', async () => {
    // The single most consequential line in the file: without it, every draft
    // in the CMS is on the public listing.
    const { client, queries } = recordingClient();
    await listArticles(client, SITE);
    expect(queries[0]?.filter).toEqual({ 'status.value': '1' });
  });

  it('orders newest first', async () => {
    const { client, queries } = recordingClient();
    await listArticles(client, SITE);
    expect(queries[0]?.sort).toEqual(['-created']);
  });

  it('passes the page size through', async () => {
    const { client, queries } = recordingClient();
    await listArticles(client, SITE, { limit: 3 });
    expect(queries[0]?.limit).toBe(3);
  });

  it('omits the offset entirely on the first page', async () => {
    // `page[offset]=undefined` is a real request Drupal rejects.
    const { client, queries } = recordingClient();
    await listArticles(client, SITE);
    expect(queries[0]).not.toHaveProperty('offset');
  });

  it('carries the cursor for the next page', async () => {
    const page = await listArticles(fixtureClient(), SITE, { limit: 2 });
    expect(page.nextCursor).toBe('2');
  });

  it('reports no cursor on the last page', async () => {
    const page = await listArticles(fixtureClient(), SITE, { limit: 50 });
    expect(page.nextCursor).toBeNull();
  });

  describe('include fallback', () => {
    it('starts with the deepest include path', async () => {
      const { client, queries } = recordingClient();
      await listArticles(client, SITE);
      expect(queries[0]?.include).toEqual(['field_image', 'field_image.field_media_image']);
    });

    it('falls back when Drupal rejects the include path', async () => {
      // A plain image field has no `field_media_image` to traverse, and Drupal
      // answers 400. That is information about the content model, not a
      // failure — the next shallower shape is the right one.
      const seen: (string[] | undefined)[] = [];
      let attempt = 0;
      const { client } = recordingClient({
        getCollection: (_type, query) => {
          seen.push(query?.include);
          attempt += 1;
          return attempt === 1
            ? Promise.reject(new DrupalResponseError('Drupal returned 400', 'http-error'))
            : Promise.resolve({ data: [] });
        },
      });

      await listArticles(client, SITE);
      expect(seen).toEqual([['field_image', 'field_image.field_media_image'], ['field_image']]);
    });

    it('does not retry a timeout as if it were a bad include path', async () => {
      // Retrying three times and then reporting "no such field" would turn a
      // slow backend into a confusing content-model error.
      const getCollection = vi.fn(() =>
        Promise.reject(new DrupalResponseError('timed out', 'malformed')),
      );
      const { client } = recordingClient({ getCollection });

      await expect(listArticles(client, SITE)).rejects.toThrow('timed out');
      expect(getCollection).toHaveBeenCalledTimes(1);
    });
  });
});

describe('getArticle', () => {
  it('returns a published article from the snapshot', async () => {
    const page = await listArticles(fixtureClient(), SITE);
    const first = page.items[0]!;
    const article = await getArticle(fixtureClient(), SITE, first.id);
    expect(article?.title).toBe(first.title);
    expect(article?.bodyHtml).toBeTypeOf('string');
  });

  it('returns null rather than an unpublished article', async () => {
    // Defence in depth. Drupal's own access control is the first lock; this is
    // the second, for a front end configured with a token that can see drafts.
    const { client } = recordingClient({
      getResource: () =>
        Promise.resolve({
          data: {
            type: 'node--article',
            id: 'draft',
            attributes: { title: 'Draft', status: false },
          },
        }),
    });
    await expect(getArticle(client, SITE, 'draft')).resolves.toBeNull();
  });

  it('propagates a not-found error from Drupal', async () => {
    await expect(getArticle(fixtureClient(), SITE, 'nope')).rejects.toThrow();
  });
});

describe('getArticleByPath', () => {
  /**
   * Resolution is a separate request, not a JSON:API filter, because Drupal
   * cannot filter on `path` at all — it is a computed field, and the two
   * plausible spellings fail differently:
   *
   *   filter[path.alias]=…   → 500 "'path' not found"
   *   filter[path][alias]=…  → 400 "You must provide a valid filter condition."
   *
   * Both verified against a live Drupal 11 instance. See ADR-004.
   */
  function resolvingClient(
    resolve: (path: string) => Promise<unknown>,
    article: unknown = {
      type: 'node--article',
      id: 'a-1',
      attributes: { title: 'Resolved', status: true },
    },
  ): { client: DrupalClient; paths: string[] } {
    const paths: string[] = [];
    const { client } = recordingClient({
      getJson: (path: string) => {
        paths.push(path);
        return resolve(path);
      },
      getResource: () => Promise.resolve({ data: article as never }),
    });
    return { client, paths };
  }

  const found = (uuid = 'a-1', resourceType = 'node--article') =>
    Promise.resolve({
      found: true,
      entity: { type: 'node', bundle: 'article', uuid, resourceType, langcode: 'en' },
    });

  it('asks the resolver endpoint rather than filtering JSON:API', async () => {
    const { client, paths } = resolvingClient(() => found());
    await getArticleByPath(client, SITE, '/blog/hello');
    expect(paths[0]).toBe('/api/resolve?path=%2Fblog%2Fhello');
  });

  it('normalises a path with no leading slash', async () => {
    const { client, paths } = resolvingClient(() => found());
    await getArticleByPath(client, SITE, 'blog/hello');
    expect(decodeURIComponent(paths[0]!)).toContain('path=/blog/hello');
  });

  it('fetches the resolved entity and maps it', async () => {
    const { client } = resolvingClient(() => found('uuid-42'));
    const article = await getArticleByPath(client, SITE, '/blog/hello');
    expect(article?.title).toBe('Resolved');
  });

  it('returns null when the resolver reports nothing at the path', async () => {
    // The resolver answers 404 both for an unknown path and for one whose
    // entity the current user may not view. Both mean "no such page" here.
    const { client } = resolvingClient(() =>
      Promise.reject(new DrupalResponseError('Drupal returned 404', 'http-error')),
    );
    await expect(getArticleByPath(client, SITE, '/gone')).resolves.toBeNull();
  });

  it('returns null for a resolved entity that is not an article', async () => {
    // A taxonomy term is a real entity at a real path. Rendering it through the
    // article template would be worse than reporting nothing.
    const { client } = resolvingClient(() => found('term-1', 'taxonomy_term--tags'));
    await expect(getArticleByPath(client, SITE, '/tags/vue')).resolves.toBeNull();
  });

  it('returns null when the resolver answers without an entity', async () => {
    const { client } = resolvingClient(() => Promise.resolve({ found: false }));
    await expect(getArticleByPath(client, SITE, '/gone')).resolves.toBeNull();
  });

  it('propagates a transport failure rather than reporting a missing page', async () => {
    // A timeout is not a 404. Swallowing it would turn an outage into a site
    // that quietly claims none of its content exists.
    const { client } = resolvingClient(() =>
      Promise.reject(new DrupalResponseError('timed out', 'malformed')),
    );
    await expect(getArticleByPath(client, SITE, '/blog/hello')).rejects.toThrow('timed out');
  });

  it('resolves a real alias end to end against the captured snapshot', async () => {
    // The fixture transport derives resolution from the aliases already in the
    // captured articles, so this exercises the same two-step path the live
    // backend takes.
    const page = await listArticles(fixtureClient(), SITE);
    const target = page.items.find((item) => item.path.startsWith('/blog/'));
    expect(target).toBeDefined();

    const article = await getArticleByPath(fixtureClient(), SITE, target!.path);
    expect(article?.id).toBe(target!.id);
    expect(article?.bodyHtml).toBeTypeOf('string');
  });

  it('returns null for a path the snapshot has nothing at', async () => {
    await expect(
      getArticleByPath(fixtureClient(), SITE, '/blog/never-existed'),
    ).resolves.toBeNull();
  });
});
