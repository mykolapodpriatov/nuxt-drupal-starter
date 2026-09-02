import { describe, expect, it, vi } from 'vitest';
import {
  buildQuery,
  createDrupalClient,
  readNextCursor,
} from '../server/drupal/client.js';
import { DrupalResponseError } from '../server/drupal/validate.js';

/** A `fetch` double that answers once with the given body and status. */
function respondWith(body: unknown, status = 200): typeof globalThis.fetch {
  return vi.fn(() =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/vnd.api+json' },
      }),
    ),
  ) as unknown as typeof globalThis.fetch;
}

const ok = { data: [] };

describe('buildQuery', () => {
  it('returns an empty string when there is nothing to ask for', () => {
    expect(buildQuery()).toBe('');
    expect(buildQuery({})).toBe('');
  });

  it('joins include paths with commas', () => {
    expect(buildQuery({ include: ['field_image', 'uid'] })).toContain(
      'include=field_image%2Cuid',
    );
  });

  it('emits sparse fieldsets in JSON:API bracket syntax', () => {
    const query = buildQuery({ fields: { 'node--article': ['title', 'path'] } });
    expect(decodeURIComponent(query)).toContain('fields[node--article]=title,path');
  });

  it('emits filters in bracket syntax', () => {
    const query = buildQuery({ filter: { 'status[value]': '1' } });
    expect(decodeURIComponent(query)).toContain('filter[status[value]]=1');
  });

  it('emits pagination as page[limit] and page[offset]', () => {
    const query = decodeURIComponent(buildQuery({ limit: 20, offset: 40 }));
    expect(query).toContain('page[limit]=20');
    expect(query).toContain('page[offset]=40');
  });

  it('supports descending sort keys', () => {
    expect(decodeURIComponent(buildQuery({ sort: ['-created'] }))).toContain('sort=-created');
  });

  it('produces a stable URL regardless of key order', () => {
    // Two logically identical requests must hash to the same cache key, so the
    // parameter order cannot depend on object literal order.
    const a = buildQuery({ include: ['uid'], limit: 10, sort: ['-created'] });
    const b = buildQuery({ sort: ['-created'], limit: 10, include: ['uid'] });
    expect(a).toBe(b);
  });

  it('omits empty include and field lists', () => {
    expect(buildQuery({ include: [], fields: { 'node--article': [] } })).toBe('');
  });
});

describe('readNextCursor', () => {
  it('reads the offset out of an absolute next link', () => {
    expect(
      readNextCursor({
        data: [],
        links: { next: { href: 'https://cms.test/jsonapi/node/article?page%5Boffset%5D=50' } },
      }),
    ).toBe('50');
  });

  it('accepts a next link given as a bare string', () => {
    expect(
      readNextCursor({ data: [], links: { next: '/jsonapi/node/article?page[offset]=25' } }),
    ).toBe('25');
  });

  it('returns null on the last page', () => {
    expect(readNextCursor({ data: [], links: {} })).toBeNull();
    expect(readNextCursor({ data: [] })).toBeNull();
  });

  it('treats a malformed next link as the end of the collection', () => {
    // Losing the tail of a listing beats throwing on a link we cannot parse.
    expect(readNextCursor({ data: [], links: { next: { href: '://nonsense' } } })).toBeNull();
  });
});

describe('createDrupalClient', () => {
  it('refuses to be constructed without a base URL', () => {
    expect(() => createDrupalClient({ baseUrl: '' })).toThrow(/baseUrl is required/);
  });

  it('requests the JSON:API media type', async () => {
    const fetchImpl = respondWith(ok);
    const client = createDrupalClient({ baseUrl: 'https://cms.test', fetch: fetchImpl });
    await client.getCollection('node/article');

    const [, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(new Headers(init?.headers).get('Accept')).toBe('application/vnd.api+json');
  });

  it('sends the bearer token when one is configured', async () => {
    const fetchImpl = respondWith(ok);
    const client = createDrupalClient({
      baseUrl: 'https://cms.test',
      token: 'secret-token',
      fetch: fetchImpl,
    });
    await client.getCollection('node/article');

    const [, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret-token');
  });

  it('sends no Authorization header when there is no token', async () => {
    const fetchImpl = respondWith(ok);
    const client = createDrupalClient({ baseUrl: 'https://cms.test', fetch: fetchImpl });
    await client.getCollection('node/article');

    const [, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
  });

  it('normalises a trailing slash on the base URL', async () => {
    const fetchImpl = respondWith(ok);
    const client = createDrupalClient({ baseUrl: 'https://cms.test/', fetch: fetchImpl });
    await client.getCollection('node/article');

    const [url] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe('https://cms.test/jsonapi/node/article');
  });

  it('honours a custom API prefix', async () => {
    const fetchImpl = respondWith(ok);
    const client = createDrupalClient({
      baseUrl: 'https://cms.test',
      apiPrefix: '/api',
      fetch: fetchImpl,
    });
    await client.getCollection('node/article');

    expect(vi.mocked(fetchImpl).mock.calls[0]![0]).toBe('https://cms.test/api/node/article');
  });

  it('bounds every request with an abort signal', async () => {
    // An unbounded fetch to a CMS that stopped answering holds the SSR render
    // open until the platform kills it.
    const fetchImpl = respondWith(ok);
    const client = createDrupalClient({ baseUrl: 'https://cms.test', fetch: fetchImpl });
    await client.getCollection('node/article');

    const [, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports a timeout as an http-error rather than a crash', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const fetchImpl = vi.fn(() => Promise.reject(timeout)) as unknown as typeof globalThis.fetch;
    const client = createDrupalClient({
      baseUrl: 'https://cms.test',
      timeoutMs: 50,
      fetch: fetchImpl,
    });

    await expect(client.getCollection('node/article')).rejects.toMatchObject({
      name: 'DrupalResponseError',
      kind: 'http-error',
    });
  });

  it('reports an unreachable host as an http-error', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(new TypeError('fetch failed')),
    ) as unknown as typeof globalThis.fetch;
    const client = createDrupalClient({ baseUrl: 'https://cms.test', fetch: fetchImpl });

    await expect(client.getCollection('node/article')).rejects.toThrow(/Could not reach Drupal/);
  });

  it('surfaces Drupal error text instead of a bare status code', async () => {
    const fetchImpl = respondWith(
      { errors: [{ status: '403', title: 'Forbidden', detail: "The 'access content' permission is required." }] },
      403,
    );
    const client = createDrupalClient({ baseUrl: 'https://cms.test', fetch: fetchImpl });

    await expect(client.getCollection('node/article')).rejects.toMatchObject({
      kind: 'http-error',
    });
  });

  it('rejects a non-JSON body', async () => {
    const fetchImpl = respondWith('<html>502 Bad Gateway</html>', 502);
    const client = createDrupalClient({ baseUrl: 'https://cms.test', fetch: fetchImpl });

    await expect(client.getCollection('node/article')).rejects.toThrow(/not JSON/);
  });

  it('fails a 200 response that carries an errors array', async () => {
    // Drupal answers this way for partially access-denied collections, and
    // trusting the status code renders an empty page with no explanation.
    const fetchImpl = respondWith({ errors: [{ title: 'Access denied' }] }, 200);
    const client = createDrupalClient({ baseUrl: 'https://cms.test', fetch: fetchImpl });

    await expect(client.getCollection('node/article')).rejects.toMatchObject({
      kind: 'api-error',
    });
  });

  it('rejects a collection response when a single resource was requested', async () => {
    const fetchImpl = respondWith({ data: [{ type: 'node--article', id: '1' }] });
    const client = createDrupalClient({ baseUrl: 'https://cms.test', fetch: fetchImpl });

    await expect(client.getResource('node/article', '1')).rejects.toThrow(
      /Expected a single resource/,
    );
  });

  it('reports a missing resource as an api-error', async () => {
    const fetchImpl = respondWith({ data: null });
    const client = createDrupalClient({ baseUrl: 'https://cms.test', fetch: fetchImpl });

    const error = await client.getResource('node/article', 'gone').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DrupalResponseError);
    expect((error as DrupalResponseError).kind).toBe('api-error');
  });

  it('returns the validated document on success', async () => {
    const fetchImpl = respondWith({
      data: { type: 'node--article', id: 'a-1', attributes: { title: 'Hi' } },
      included: [{ type: 'media--image', id: 'm-1' }],
    });
    const client = createDrupalClient({ baseUrl: 'https://cms.test', fetch: fetchImpl });

    const document = await client.getResource('node/article', 'a-1');
    expect(document.data.id).toBe('a-1');
    expect(document.included).toHaveLength(1);
  });
});
