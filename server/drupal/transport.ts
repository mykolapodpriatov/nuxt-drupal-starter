/**
 * Transport types — the shape Drupal actually sends.
 *
 * These mirror the JSON:API specification and Drupal's serialisation of it,
 * warts included: attributes nested under `attributes`, relationships that are
 * bare `{type, id}` pointers, and the objects those pointers refer to sitting
 * in a sibling `included` array rather than inline.
 *
 * Nothing in `app/` imports from this file. Components consume the domain
 * models in `shared/domain.ts`, and `normalize.ts` is the only bridge between
 * the two. That is the whole point: when an editor renames a field or a site
 * builder changes a content type, exactly one mapper needs updating instead of
 * every template that touched the field.
 *
 * Everything here is typed as it arrives — which is to say, untrusted. The
 * validators in `validate.ts` are what turn a parsed response into something
 * these types may legitimately be applied to.
 */

/**
 * A `{type, id}` pointer into the `included` array.
 *
 * The `meta` block is not decoration. For an image field, Drupal puts the alt
 * text, title, width and height **here** — on the pointer — rather than on the
 * file resource it points at. That is arguably the correct model (the same file
 * reused on two nodes can carry different alt text) and it is also the detail
 * that makes a naive mapper render every image with empty alt.
 */
export interface ResourceIdentifier {
  type: string;
  id: string;
  meta?: {
    alt?: string;
    title?: string;
    width?: number;
    height?: number;
    [key: string]: unknown;
  };
}

/**
 * A relationship field. JSON:API uses `data: null` for an empty to-one
 * relationship and `data: []` for an empty to-many — the two are not
 * interchangeable, and collapsing them loses the field's cardinality.
 */
export interface Relationship {
  data: ResourceIdentifier | ResourceIdentifier[] | null;
}

/** Any JSON:API resource object, before we know which type it is. */
export interface ResourceObject {
  type: string;
  id: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, Relationship | undefined>;
  links?: Record<string, unknown>;
}

/** A successful JSON:API document. `data` is an array for collections. */
export interface JsonApiDocument<T extends ResourceObject = ResourceObject> {
  data: T | T[];
  included?: ResourceObject[];
  links?: {
    next?: { href: string } | string;
    prev?: { href: string } | string;
    self?: { href: string } | string;
  };
  meta?: Record<string, unknown>;
}

/**
 * A JSON:API error document. Drupal returns HTTP 200 with an `errors` array in
 * some configurations, so a non-error status code is not sufficient evidence
 * that a request succeeded.
 */
export interface JsonApiErrorDocument {
  errors: {
    status?: string;
    title?: string;
    detail?: string;
    code?: string;
  }[];
}

/**
 * Drupal's processed-text field. `value` is the raw input, `processed` is the
 * result of running it through the configured text format's filters.
 *
 * Only `processed` is ever rendered: `value` has not been through Drupal's
 * filter pipeline, so treating it as HTML would hand an editor with a
 * lower-privileged text format a way to inject markup the format forbids.
 */
export interface DrupalTextField {
  value?: string;
  processed?: string;
  format?: string;
  summary?: string;
}

/** Drupal's `file--file` resource, reachable through an image relationship. */
export interface DrupalFileResource extends ResourceObject {
  type: 'file--file';
  attributes?: {
    uri?: { value?: string; url?: string };
    filemime?: string;
    filesize?: number;
    /** Present when the consumer requested derivative URLs (image styles). */
    image_style_uri?: Record<string, string>[] | Record<string, string>;
  };
}

/** Drupal's `media--image` resource, wrapping a `file--file`. */
export interface DrupalMediaImageResource extends ResourceObject {
  type: 'media--image';
  attributes?: {
    name?: string;
  };
  relationships?: {
    field_media_image?: Relationship;
  };
}

/** `node--article` as this starter's Drupal recipe configures it. */
export interface DrupalArticleResource extends ResourceObject {
  type: 'node--article';
  attributes?: {
    title?: string;
    /** Drupal's URL alias, e.g. `{ alias: '/blog/hello' }`. */
    path?: { alias?: string | null };
    body?: DrupalTextField;
    created?: string;
    changed?: string;
    status?: boolean;
    /** Metatag values, when the metatag module exposes them over JSON:API. */
    metatag?: unknown;
  };
  relationships?: {
    field_image?: Relationship;
    uid?: Relationship;
  };
}

/** A single link in a Drupal menu, as `menu_link_content--menu_link_content`. */
export interface DrupalMenuLinkResource extends ResourceObject {
  type: string;
  attributes?: {
    title?: string;
    url?: string;
    weight?: number;
    enabled?: boolean;
    parent?: string | null;
  };
}
