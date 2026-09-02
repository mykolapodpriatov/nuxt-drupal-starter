/**
 * Runtime validation of JSON:API responses.
 *
 * A `type` annotation on a fetch result is a promise the compiler cannot keep.
 * The bytes come from another system over a network, and in this system's case
 * that other system is a CMS whose content model is edited through a web UI by
 * people who are not looking at this repository. A field can be removed, a
 * relationship can be made multi-value, a module can be disabled — and none of
 * it produces a type error. It produces `undefined is not an object` at render
 * time, in production, on a page nobody tested.
 *
 * So responses are validated at the boundary and rejected with a message that
 * names what was wrong. The alternative is not "less code": it is the same
 * checks scattered through the normalizer as defensive `?.` chains that
 * silently render an empty page instead of reporting a broken contract.
 *
 * Validation here is structural, not exhaustive. It confirms the document is a
 * JSON:API document and that the resources are resource-shaped; per-field
 * expectations belong to the mappers, which can degrade gracefully on a single
 * missing attribute. Anything the mapper genuinely cannot work without is
 * asserted in this module instead.
 */
import type {
  JsonApiDocument,
  JsonApiErrorDocument,
  ResourceObject,
} from './transport.js';

/**
 * Raised when Drupal's response is not something the mappers can consume.
 *
 * Carries the offending payload so a failure can be diagnosed from the logs
 * without reproducing it, and a `kind` so callers can distinguish "the CMS said
 * no" (`api-error`) from "the CMS said something incomprehensible"
 * (`malformed`). The two want different responses: the first is often a 404
 * that should surface as a 404, the second is always a bug or an outage.
 */
export class DrupalResponseError extends Error {
  constructor(
    message: string,
    readonly kind: 'malformed' | 'api-error' | 'http-error',
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'DrupalResponseError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Describe the resources Drupal silently withheld, if any.
 *
 * This is the quietest failure JSON:API has. When access control denies some
 * of the resources a collection request matched, Drupal answers **HTTP 200
 * with an empty `data` array** and explains itself in `meta.omitted` — which
 * nothing is obliged to read. The caller sees a successful response containing
 * no content and renders an empty page.
 *
 * It is not hypothetical: `menu_link_content` requires the `administer menu`
 * permission, so a front end reading menus over core JSON:API as an anonymous
 * consumer gets exactly this. The symptom is "the navigation is empty", and
 * there is nothing in the logs, the status code or the payload's shape to
 * suggest a permission problem.
 *
 * Returning the detail here lets callers decide: a partially-filtered article
 * listing is usually fine to render, while an entirely omitted menu is a
 * misconfiguration worth surfacing.
 *
 * @returns the human-readable reason, or `null` when nothing was withheld.
 */
export function describeOmitted(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const meta = payload.meta;
  if (!isRecord(meta)) return null;
  const omitted = meta.omitted;
  if (!isRecord(omitted)) return null;

  const detail = typeof omitted.detail === 'string' ? omitted.detail : 'Resources were omitted';

  // The per-item reasons are the useful part — they name the missing
  // permission — but there is one per withheld resource, so only the first
  // distinct reason is worth surfacing.
  const links = isRecord(omitted.links) ? Object.values(omitted.links) : [];
  for (const link of links) {
    if (!isRecord(link)) continue;
    const linkMeta = link.meta;
    if (isRecord(linkMeta) && typeof linkMeta.detail === 'string') {
      return `${detail} ${linkMeta.detail}`;
    }
  }

  return detail;
}

/**
 * `true` when the payload is a JSON:API error document.
 *
 * Checked before the success path because Drupal can answer with HTTP 200 and
 * an `errors` array — most often for a partially-denied collection request,
 * where some resources were filtered out by access control. Trusting the status
 * code alone turns that into an empty page with no explanation.
 */
export function isErrorDocument(payload: unknown): payload is JsonApiErrorDocument {
  return isRecord(payload) && Array.isArray(payload.errors);
}

/** Flatten a JSON:API error document into one readable line. */
export function describeErrors(document: JsonApiErrorDocument): string {
  const parts = document.errors.map((error) => {
    const status = error.status ? `${error.status} ` : '';
    return `${status}${error.title ?? 'Error'}${error.detail ? `: ${error.detail}` : ''}`;
  });
  return parts.join('; ') || 'Unknown JSON:API error';
}

/** `true` when `value` has the `{type, id}` shape every resource must have. */
export function isResourceObject(value: unknown): value is ResourceObject {
  return (
    isRecord(value) && typeof value.type === 'string' && typeof value.id === 'string'
  );
}

/**
 * Narrow an arbitrary parsed body to a JSON:API document, or throw.
 *
 * Accepts both a single resource and a collection, because the same endpoint
 * shape is used for `/node/article` and `/node/article/{uuid}` and forcing
 * callers to pick the right validator just moves the branch.
 */
export function assertJsonApiDocument(payload: unknown): JsonApiDocument {
  if (isErrorDocument(payload)) {
    throw new DrupalResponseError(describeErrors(payload), 'api-error', payload.errors);
  }

  if (!isRecord(payload)) {
    throw new DrupalResponseError(
      `Expected a JSON:API document, received ${typeof payload}`,
      'malformed',
      payload,
    );
  }

  if (!('data' in payload)) {
    throw new DrupalResponseError(
      'JSON:API document has no `data` member',
      'malformed',
      Object.keys(payload),
    );
  }

  const { data } = payload;

  if (data === null) {
    // A to-one relationship that points at nothing is legal, but a document
    // whose primary data is null means "the resource you asked for does not
    // exist" — the caller must handle that rather than map it.
    throw new DrupalResponseError(
      'JSON:API document `data` is null — resource not found',
      'api-error',
      null,
    );
  }

  if (Array.isArray(data)) {
    const offender = data.findIndex((item) => !isResourceObject(item));
    if (offender !== -1) {
      throw new DrupalResponseError(
        `JSON:API collection item at index ${offender} is not a resource object`,
        'malformed',
        data[offender],
      );
    }
  } else if (!isResourceObject(data)) {
    throw new DrupalResponseError(
      'JSON:API document `data` is not a resource object',
      'malformed',
      data,
    );
  }

  if ('included' in payload && payload.included !== undefined) {
    if (!Array.isArray(payload.included)) {
      throw new DrupalResponseError(
        'JSON:API `included` is present but not an array',
        'malformed',
        payload.included,
      );
    }
    const offender = payload.included.findIndex((item) => !isResourceObject(item));
    if (offender !== -1) {
      throw new DrupalResponseError(
        `JSON:API \`included\` item at index ${offender} is not a resource object`,
        'malformed',
        payload.included[offender],
      );
    }
  }

  return payload as unknown as JsonApiDocument;
}

/** Narrow to a document whose primary data is a single resource. */
export function assertSingleResource(payload: unknown): JsonApiDocument & {
  data: ResourceObject;
} {
  const document = assertJsonApiDocument(payload);
  if (Array.isArray(document.data)) {
    throw new DrupalResponseError(
      'Expected a single resource, received a collection',
      'malformed',
      { count: document.data.length },
    );
  }
  return document as JsonApiDocument & { data: ResourceObject };
}

/** Narrow to a document whose primary data is a collection. */
export function assertCollection(payload: unknown): JsonApiDocument & {
  data: ResourceObject[];
} {
  const document = assertJsonApiDocument(payload);
  if (!Array.isArray(document.data)) {
    throw new DrupalResponseError(
      'Expected a collection, received a single resource',
      'malformed',
      { type: document.data.type },
    );
  }
  return document as JsonApiDocument & { data: ResourceObject[] };
}
