/**
 * The HTTP layer between Nitro and Drupal.
 *
 * This module is the only place that holds a Drupal credential, and the only
 * place that knows Drupal's base URL. It runs exclusively on the server: Nuxt
 * keeps top-level `runtimeConfig` keys out of the client bundle, and
 * `test/runtime-config.spec.ts` asserts that none of them have drifted under
 * `public`.
 *
 * Three things it does that a bare `$fetch` does not:
 *
 * - **Bounds every request.** An unbounded `fetch` to a CMS that has stopped
 *   answering holds an SSR render open until the platform kills it, turning a
 *   slow backend into a completely unavailable front end. Every call carries an
 *   `AbortSignal` on a timeout.
 * - **Treats a 200 with an `errors` array as a failure.** Drupal answers that
 *   way for partially access-denied collections, and trusting the status code
 *   renders an empty page with no explanation.
 * - **Distinguishes "not found" from "broken".** A missing article should be a
 *   404 page; an unparseable response should be a 500 and an alert. Both arrive
 *   here as exceptions, so `DrupalResponseError.kind` carries the difference.
 */
import {
  assertCollection,
  assertSingleResource,
  describeOmitted,
  DrupalResponseError,
} from './validate.js';
import type { JsonApiDocument, ResourceObject } from './transport.js';

export interface DrupalClientOptions {
  /** Base URL of the Drupal site, without a trailing slash. */
  baseUrl: string;
  /** Optional bearer token for authenticated reads. */
  token?: string;
  /** Per-request budget in milliseconds. */
  timeoutMs?: number;
  /** Path JSON:API is mounted at. Drupal's default is `/jsonapi`. */
  apiPrefix?: string;
  /**
   * Fetch implementation. Overridden in tests, and by the fixture-backed mode
   * that lets this repository run with no Drupal at all.
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Called when Drupal answers 200 but `meta.omitted` shows access control
   * withheld resources.
   *
   * This is the quietest failure the API has — an empty `data` array with the
   * explanation tucked into metadata nothing is obliged to read — so it is
   * surfaced rather than swallowed. Defaults to a `console.warn`, because
   * silence is what makes it expensive.
   */
  onOmitted?: OmittedHandler;
}

/** Query parameters, in JSON:API's bracketed vocabulary. */
export interface DrupalQuery {
  /** Relationship paths to side-load, e.g. `['field_image.field_media_image']`. */
  include?: string[];
  /** Sparse fieldsets keyed by resource type. */
  fields?: Record<string, string[]>;
  /**
   * Filters, keyed by a dotted field path.
   *
   * Dots become bracket segments, which is what JSON:API expects:
   * `'status'` → `filter[status]=1` (the shorthand form), and
   * `'status.value'` → `filter[status][value]=1` (the long form).
   *
   * Writing the brackets by hand is how `filter[status[value]]` gets emitted —
   * syntactically plausible, silently ignored by Drupal, and the request comes
   * back with every article including the unpublished ones.
   */
  filter?: Record<string, string>;
  /** Sort keys; prefix with `-` for descending. */
  sort?: string[];
  /** Page size. */
  limit?: number;
  /** Offset, or an opaque cursor previously returned as `nextCursor`. */
  offset?: number;
}

/**
 * Build the query string for a JSON:API request.
 *
 * Kept separate and exported because it is pure, and because getting
 * `filter[status][value]=1` subtly wrong is the kind of bug that silently
 * returns every article instead of only the published ones — which is exactly
 * the sort of thing that deserves its own test rather than a manual check.
 */
export function buildQuery(query: DrupalQuery = {}): string {
  const params = new URLSearchParams();

  if (query.include?.length) params.set('include', query.include.join(','));

  for (const [type, fields] of Object.entries(query.fields ?? {})) {
    if (fields.length) params.set(`fields[${type}]`, fields.join(','));
  }

  for (const [path, value] of Object.entries(query.filter ?? {})) {
    const brackets = path
      .split('.')
      .map((segment) => `[${segment}]`)
      .join('');
    params.set(`filter${brackets}`, value);
  }

  if (query.sort?.length) params.set('sort', query.sort.join(','));
  if (query.limit !== undefined) params.set('page[limit]', String(query.limit));
  if (query.offset !== undefined) params.set('page[offset]', String(query.offset));

  // Sorted so the same logical request always produces the same URL — which is
  // what makes the response cacheable by key rather than by luck.
  params.sort();

  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

/** Extract the `page[offset]` of the next page, if there is one. */
export function readNextCursor(document: JsonApiDocument): string | null {
  const next = document.links?.next;
  const href = typeof next === 'string' ? next : next?.href;
  if (!href) return null;
  try {
    // The link is absolute in Drupal's output, but a relative one is legal.
    const url = new URL(href, 'https://placeholder.invalid');
    return url.searchParams.get('page[offset]');
  } catch {
    // A malformed pagination link means "no more pages" rather than a crash:
    // losing the tail of a listing is better than losing the listing.
    return null;
  }
}

export interface DrupalClient {
  /** Fetch a collection and return the raw document plus its `included` array. */
  getCollection: (
    resourceType: string,
    query?: DrupalQuery,
  ) => Promise<JsonApiDocument & { data: ResourceObject[] }>;
  /** Fetch one resource by UUID. */
  getResource: (
    resourceType: string,
    id: string,
    query?: DrupalQuery,
  ) => Promise<JsonApiDocument & { data: ResourceObject }>;
  /** Escape hatch for endpoints this client does not model yet. */
  request: (path: string, init?: RequestInit) => Promise<unknown>;
}

/** Notified when access control silently withheld part of a response. */
export type OmittedHandler = (reason: string, context: { path: string }) => void;

export function createDrupalClient(options: DrupalClientOptions): DrupalClient {
  const {
    baseUrl,
    token,
    timeoutMs = 10_000,
    apiPrefix = '/jsonapi',
    fetch: fetchImpl = globalThis.fetch,
    onOmitted = (reason, { path }) =>
      console.warn(`[drupal] ${apiPrefix}${path}: ${reason}`),
  } = options;

  if (!baseUrl) {
    throw new Error('createDrupalClient: baseUrl is required');
  }

  const origin = baseUrl.replace(/\/+$/, '');

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const url = `${origin}${apiPrefix}${path}`;

    // A CMS that has stopped answering must not be able to hold an SSR render
    // open indefinitely. `AbortSignal.timeout` gives every request a ceiling.
    const signal = init.signal ?? AbortSignal.timeout(timeoutMs);

    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/vnd.api+json');
    if (token) headers.set('Authorization', `Bearer ${token}`);

    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, headers, signal });
    } catch (error: unknown) {
      const aborted =
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        ((error as { name?: unknown }).name === 'TimeoutError' ||
          (error as { name?: unknown }).name === 'AbortError');
      throw new DrupalResponseError(
        aborted
          ? `Drupal did not respond within ${timeoutMs}ms`
          : `Could not reach Drupal at ${origin}`,
        'http-error',
        error,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error: unknown) {
      throw new DrupalResponseError(
        `Drupal returned ${response.status} with a body that is not JSON`,
        response.ok ? 'malformed' : 'http-error',
        error,
      );
    }

    if (!response.ok) {
      // Prefer Drupal's own error text over the bare status code — it is the
      // difference between "403" and "The 'access content' permission is
      // required", which is the difference between an hour of debugging and a
      // minute.
      throw new DrupalResponseError(
        `Drupal returned ${response.status} for ${apiPrefix}${path}`,
        'http-error',
        payload,
      );
    }

    // A 200 whose `meta.omitted` names withheld resources is the failure mode
    // that renders an empty page with nothing in the logs. Report it.
    const omitted = describeOmitted(payload);
    if (omitted) onOmitted(omitted, { path });

    return payload;
  }

  return {
    request,

    async getCollection(resourceType, query) {
      const payload = await request(`/${resourceType}${buildQuery(query)}`);
      return assertCollection(payload);
    },

    async getResource(resourceType, id, query) {
      const payload = await request(`/${resourceType}/${id}${buildQuery(query)}`);
      return assertSingleResource(payload);
    },
  };
}
