/**
 * Fixture-backed transport: the same client, with no Drupal behind it.
 *
 * The problem this solves is evaluation cost. A decoupled starter that requires
 * a running CMS before it will render anything asks a reviewer to install PHP,
 * Composer, a database and a content model just to see the home page — and asks
 * CI to do the same on every run. Most people will not, so the repository is
 * judged on its README.
 *
 * So the transport is swappable. `createFixtureFetch` returns something with
 * `fetch`'s signature that answers from JSON committed under `fixtures/drupal/`.
 * The client, the validators and the mappers above it are the exact same code
 * paths that run against a live site — which is the point. A fake that bypassed
 * the client would test nothing; this one exercises URL construction, response
 * validation and normalisation for real, and only the socket is missing.
 *
 * The fixtures themselves are captured from an actual Drupal instance by
 * `scripts/snapshot-content.ts`, not written by hand. Hand-written fixtures
 * drift towards what the code expects rather than what the CMS emits, and the
 * inconsistencies worth defending against — `image_style_uri` serialised two
 * different ways, relationships that point at deleted entities — are exactly
 * the ones nobody invents from memory.
 *
 * See docs/adr/002-fixture-snapshot-vs-live-backend.md.
 */
import type { JsonApiDocument, ResourceObject } from './transport.js';

/** One captured response, keyed by the JSON:API path that produced it. */
export interface FixtureSet {
  /**
   * Map of `resourceType` → captured collection document.
   * Keys are JSON:API paths without the prefix, e.g. `node/article`.
   */
  collections: Record<string, JsonApiDocument>;
  /**
   * Captured responses from endpoints outside JSON:API, keyed by full path —
   * `/api/menu/main`, for instance.
   *
   * Menus need this because they are not a JSON:API resource here: core cannot
   * expose them to an unprivileged consumer, so they come from a purpose-built
   * module. See ADR-003.
   */
  raw?: Record<string, unknown>;
}

export interface FixtureFetchOptions {
  /** The captured responses to serve. */
  fixtures: FixtureSet;
  /**
   * Simulated latency in milliseconds. Zero by default so tests stay fast; a
   * non-zero value is useful when developing loading states, which otherwise
   * never render against an instant backend.
   */
  latencyMs?: number;
}

/** Everything a JSON:API document's `data` can hold, as an array. */
function asArray(data: JsonApiDocument['data']): ResourceObject[] {
  return Array.isArray(data) ? data : [data];
}

/**
 * Reduce a captured collection to the single resource at `id`.
 *
 * `included` is filtered rather than copied wholesale: serving the entire
 * captured `included` array for a single article would hand the client every
 * other article's media too, which is not what Drupal does and would let a
 * normalizer bug — resolving a pointer against the wrong document — pass
 * unnoticed.
 */
function extractResource(
  document: JsonApiDocument,
  id: string,
): JsonApiDocument | null {
  const resource = asArray(document.data).find((item) => item.id === id);
  if (!resource) return null;

  const wanted = new Set<string>();
  for (const relationship of Object.values(resource.relationships ?? {})) {
    const data = relationship?.data;
    if (!data) continue;
    for (const identifier of Array.isArray(data) ? data : [data]) {
      wanted.add(`${identifier.type}:${identifier.id}`);
    }
  }

  // Walk transitively: an article points at a media entity, which points at a
  // file. Stopping at depth one would drop the file and silently produce
  // imageless articles.
  const included: ResourceObject[] = [];
  const pool = document.included ?? [];
  const seen = new Set<string>();
  const queue = [...wanted];

  while (queue.length > 0) {
    const key = queue.shift();
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    const match = pool.find((item) => `${item.type}:${item.id}` === key);
    if (!match) continue;
    included.push(match);
    for (const relationship of Object.values(match.relationships ?? {})) {
      const data = relationship?.data;
      if (!data) continue;
      for (const identifier of Array.isArray(data) ? data : [data]) {
        queue.push(`${identifier.type}:${identifier.id}`);
      }
    }
  }

  return { data: resource, included };
}

/** Apply the subset of JSON:API query semantics the fixture mode supports. */
function applyQuery(document: JsonApiDocument, params: URLSearchParams): JsonApiDocument {
  let items = asArray(document.data);

  // The one filter the app issues, and the one whose absence publishes drafts.
  // Both JSON:API spellings are accepted, because both are legal and a caller
  // that used the shorthand should not silently get unfiltered results.
  const statusFilter =
    params.get('filter[status][value]') ?? params.get('filter[status]');
  if (statusFilter !== null) {
    const wantPublished = statusFilter === '1' || statusFilter === 'true';
    items = items.filter((item) => {
      const status = (item.attributes as { status?: unknown } | undefined)?.status;
      return status === wantPublished;
    });
  }

  const sort = params.get('sort');
  if (sort) {
    const descending = sort.startsWith('-');
    const key = descending ? sort.slice(1) : sort;
    items = [...items].sort((a, b) => {
      const left = String((a.attributes as Record<string, unknown> | undefined)?.[key] ?? '');
      const right = String((b.attributes as Record<string, unknown> | undefined)?.[key] ?? '');
      return descending ? right.localeCompare(left) : left.localeCompare(right);
    });
  }

  const limit = Number(params.get('page[limit]') ?? Number.NaN);
  const offset = Number(params.get('page[offset]') ?? 0);
  const start = Number.isFinite(offset) ? offset : 0;
  const page = Number.isFinite(limit) ? items.slice(start, start + limit) : items.slice(start);

  const hasMore = Number.isFinite(limit) && start + limit < items.length;

  return {
    data: page,
    included: document.included ?? [],
    ...(hasMore
      ? { links: { next: { href: `?page%5Boffset%5D=${start + limit}` } } }
      : {}),
  };
}

/**
 * Build a `fetch`-compatible function that answers from captured fixtures.
 *
 * Unknown paths produce a JSON:API 404 document rather than a thrown error, so
 * the client's own error handling — including the "resource not found" branch —
 * is exercised exactly as it would be against Drupal.
 */
export function createFixtureFetch(options: FixtureFetchOptions): typeof globalThis.fetch {
  const { fixtures, latencyMs = 0 } = options;

  const notFound = (detail: string): Response =>
    new Response(
      JSON.stringify({ errors: [{ status: '404', title: 'Not Found', detail }] }),
      { status: 404, headers: { 'content-type': 'application/vnd.api+json' } },
    );

  const ok = (document: JsonApiDocument): Response =>
    new Response(JSON.stringify(document), {
      status: 200,
      headers: { 'content-type': 'application/vnd.api+json' },
    });

  return (async (input: RequestInfo | URL): Promise<Response> => {
    if (latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, latencyMs));
    }

    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'https://fixtures.invalid');

    // Path resolution is derived rather than captured. Drupal answers it from
    // the alias table; here the same answer is computed from the aliases
    // already present in the captured articles, so the two cannot drift and
    // there is no second fixture to keep current.
    if (url.pathname === '/api/resolve') {
      const requested = url.searchParams.get('path') ?? '';
      const match = asArray(fixtures.collections['node/article']?.data ?? []).find(
        (item) =>
          (item.attributes as { path?: { alias?: unknown } } | undefined)?.path?.alias ===
          requested,
      );
      if (!match) return notFound(`Nothing at ${requested}`);
      return new Response(
        JSON.stringify({
          found: true,
          entity: {
            type: 'node',
            bundle: 'article',
            uuid: match.id,
            resourceType: match.type,
            langcode: 'en',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    // Other non-JSON:API endpoints are served verbatim from the `raw` map: they
    // have no collection semantics to emulate, so filtering and pagination do
    // not apply.
    if (!url.pathname.startsWith('/jsonapi')) {
      const captured = fixtures.raw?.[url.pathname];
      if (captured === undefined) return notFound(`No fixture for ${url.pathname}`);
      return new Response(JSON.stringify(captured), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Strip the JSON:API prefix to get `node/article` or `node/article/{uuid}`.
    const path = url.pathname.replace(/^\/jsonapi\/?/, '').replace(/^\/+|\/+$/g, '');

    const segments = path.split('/').filter(Boolean);

    // Drupal resource types are `entity/bundle`, so a two-segment path is a
    // collection and a three-segment path is a single resource.
    if (segments.length === 3) {
      const [entity, bundle, id] = segments;
      const document = fixtures.collections[`${entity}/${bundle}`];
      if (!document) return notFound(`No fixture for ${entity}/${bundle}`);
      const single = extractResource(document, id!);
      return single ? ok(single) : notFound(`No fixture resource with id ${id}`);
    }

    if (segments.length === 2) {
      const key = segments.join('/');
      const document = fixtures.collections[key];
      if (!document) return notFound(`No fixture for ${key}`);
      return ok(applyQuery(document, url.searchParams));
    }

    return notFound(`Unsupported fixture path: ${path || '/'}`);
  }) as unknown as typeof globalThis.fetch;
}
