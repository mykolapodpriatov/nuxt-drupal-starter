import { describe, expect, it } from 'vitest';
import { createFixtureFetch, type FixtureSet } from '../server/drupal/fixtures.js';
import { createDrupalClient } from '../server/drupal/client.js';
import { indexIncluded, toArticle } from '../server/drupal/normalize.js';
import { createClientForSettings, resolveMode } from '../server/drupal/index.js';

const SITE = 'https://cms.example.test';

/**
 * A miniature snapshot with the two-hop relationship the real fixtures have:
 * article → media → file. Everything the fixture transport has to get right is
 * visible in this one object.
 */
const fixtures: FixtureSet = {
  collections: {
    'node/article': {
      data: [
        {
          type: 'node--article',
          id: 'a-1',
          attributes: {
            title: 'Published one',
            path: { alias: '/blog/one' },
            body: { processed: '<p>One</p>' },
            created: '2026-03-01T00:00:00+00:00',
            status: true,
          },
          relationships: {
            field_image: {
              data: { type: 'media--image', id: 'm-1', meta: { alt: 'Cover' } },
            },
          },
        },
        {
          type: 'node--article',
          id: 'a-2',
          attributes: {
            title: 'Published two',
            path: { alias: '/blog/two' },
            body: { processed: '<p>Two</p>' },
            created: '2026-01-01T00:00:00+00:00',
            status: true,
          },
        },
        {
          type: 'node--article',
          id: 'a-3',
          attributes: {
            title: 'A draft',
            path: { alias: '/blog/draft' },
            created: '2026-04-01T00:00:00+00:00',
            status: false,
          },
        },
      ],
      included: [
        {
          type: 'media--image',
          id: 'm-1',
          attributes: { name: 'Cover' },
          relationships: { field_media_image: { data: { type: 'file--file', id: 'f-1' } } },
        },
        {
          type: 'file--file',
          id: 'f-1',
          attributes: { uri: { url: '/sites/default/files/cover.jpg' } },
        },
        // Belongs to no article in this set — used to prove that a single
        // resource request does not hand over the whole pool.
        { type: 'media--image', id: 'm-orphan', attributes: { name: 'Unrelated' } },
      ],
    },
  },
};

function client() {
  return createDrupalClient({
    baseUrl: 'https://fixtures.invalid',
    fetch: createFixtureFetch({ fixtures }),
  });
}

describe('fixture transport', () => {
  it('serves a collection through the real client', async () => {
    // The point of the fixture mode is that the client, validators and mappers
    // above it are the same code that runs against Drupal. A double that
    // bypassed them would test nothing.
    const document = await client().getCollection('node/article');
    expect(document.data).toHaveLength(3);
  });

  it('serves a single resource by id', async () => {
    const document = await client().getResource('node/article', 'a-1');
    expect(document.data.id).toBe('a-1');
  });

  it('answers a JSON:API 404 for an unknown id', async () => {
    await expect(client().getResource('node/article', 'nope')).rejects.toMatchObject({
      kind: 'http-error',
    });
  });

  it('answers a JSON:API 404 for an unknown resource type', async () => {
    await expect(client().getCollection('node/recipe')).rejects.toMatchObject({
      kind: 'http-error',
    });
  });

  describe('included scoping', () => {
    it('walks relationships transitively', async () => {
      // Article → media → file. Stopping at depth one drops the file, and the
      // resulting imageless article looks like correct behaviour.
      const document = await client().getResource('node/article', 'a-1');
      const types = (document.included ?? []).map((item) => item.type).sort();
      expect(types).toEqual(['file--file', 'media--image']);
    });

    it('does not hand over unrelated included resources', async () => {
      // Serving the whole captured pool would let a normalizer bug — resolving
      // a pointer against the wrong document — pass unnoticed.
      const document = await client().getResource('node/article', 'a-1');
      expect(document.included?.some((item) => item.id === 'm-orphan')).toBe(false);
    });

    it('returns an empty included array for a resource with no relationships', async () => {
      const document = await client().getResource('node/article', 'a-2');
      expect(document.included).toEqual([]);
    });

    it('produces an article whose image resolves end to end', async () => {
      const document = await client().getResource('node/article', 'a-1');
      const article = toArticle(document.data, indexIncluded(document.included), SITE);
      expect(article.image?.url).toBe(`${SITE}/sites/default/files/cover.jpg`);
      expect(article.image?.alt).toBe('Cover');
    });
  });

  describe('query semantics', () => {
    it('applies the published filter', async () => {
      // The one filter the app issues, and the one whose absence publishes
      // drafts.
      const document = await client().getCollection('node/article', {
        filter: { 'status.value': '1' },
      });
      expect(document.data.map((item) => item.id)).toEqual(['a-1', 'a-2']);
    });

    it('can select only unpublished content', async () => {
      const document = await client().getCollection('node/article', {
        filter: { 'status.value': '0' },
      });
      expect(document.data.map((item) => item.id)).toEqual(['a-3']);
    });

    it('sorts descending', async () => {
      const document = await client().getCollection('node/article', { sort: ['-created'] });
      expect(document.data.map((item) => item.id)).toEqual(['a-3', 'a-1', 'a-2']);
    });

    it('sorts ascending', async () => {
      const document = await client().getCollection('node/article', { sort: ['created'] });
      expect(document.data.map((item) => item.id)).toEqual(['a-2', 'a-1', 'a-3']);
    });

    it('paginates and advertises a next link while more remain', async () => {
      const first = await client().getCollection('node/article', { limit: 2 });
      expect(first.data).toHaveLength(2);
      expect(first.links?.next).toBeDefined();
    });

    it('omits the next link on the last page', async () => {
      const last = await client().getCollection('node/article', { limit: 2, offset: 2 });
      expect(last.data).toHaveLength(1);
      expect(last.links?.next).toBeUndefined();
    });

    it('returns everything when no page size is given', async () => {
      const document = await client().getCollection('node/article');
      expect(document.data).toHaveLength(3);
    });
  });
});

describe('resolveMode', () => {
  it('uses fixtures when no base URL is configured', () => {
    expect(resolveMode({ baseUrl: '' })).toBe('fixtures');
  });

  it('treats a whitespace-only base URL as unconfigured', () => {
    expect(resolveMode({ baseUrl: '   ' })).toBe('fixtures');
  });

  it('goes live once a base URL is present', () => {
    expect(resolveMode({ baseUrl: 'https://cms.test' })).toBe('live');
  });
});

describe('createClientForSettings', () => {
  it('builds a working fixture client from empty settings', async () => {
    // A deployment that forgets NUXT_DRUPAL_BASE_URL should serve sample
    // content and be obviously wrong, rather than fail like an outage.
    const { client: drupal, mode } = createClientForSettings({
      baseUrl: '',
      token: '',
      timeoutMs: 10_000,
    });
    expect(mode).toBe('fixtures');

    const document = await drupal.getCollection('node/article');
    expect(Array.isArray(document.data)).toBe(true);
  });

  it('builds a live client when a base URL is configured', () => {
    const { mode } = createClientForSettings({
      baseUrl: 'https://cms.test',
      token: '',
      timeoutMs: 5_000,
    });
    expect(mode).toBe('live');
  });
});
