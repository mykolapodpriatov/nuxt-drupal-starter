/**
 * The transport → domain boundary.
 *
 * JSON:API answers with a normalised graph: the article is in `data`, its image
 * is a `{type, id}` pointer, and the object that pointer refers to is somewhere
 * in a flat `included` array — as is the file that image wraps. Rendering an
 * article's hero image therefore means walking two hops through an array by
 * identity.
 *
 * Doing that walk inside a component is what couples templates to Drupal's
 * storage model. Doing it here, once, is what lets `field_image` be renamed in
 * the CMS without touching a single `.vue` file.
 *
 * ## Degrade, do not throw
 *
 * `validate.ts` has already rejected anything structurally broken. What is left
 * is the ordinary messiness of a live content model: an article with no image,
 * a media entity whose file was deleted, a body field an editor left empty, an
 * image style that is configured on staging but not production.
 *
 * None of those should blank a page. Every mapper here fills a sensible default
 * and carries on — an `Article` always has a `title` and a `bodyHtml`, even if
 * both are empty strings. The type system then guarantees templates never need
 * a null check for them, which is the actual benefit: optionality that survives
 * to the UI is optionality every component has to handle forever.
 *
 * The one thing that is *not* softened is the published flag. Defaulting an
 * unknown `status` to "published" would leak drafts, so it defaults to `false`.
 */
import type {
  DrupalArticleResource,
  DrupalFileResource,
  DrupalMediaImageResource,
  DrupalTextField,
  Relationship,
  ResourceIdentifier,
  ResourceObject,
} from './transport.js';
import type { Article, ArticleSummary, DomainImage } from '../../shared/domain.js';

/**
 * Index of `included` resources by `type:id`.
 *
 * Built once per document. A linear scan per lookup is O(n) and an article
 * listing with fifty items and three relationships each turns that into
 * thousands of comparisons for no reason.
 */
export type IncludedIndex = Map<string, ResourceObject>;

const identityKey = (type: string, id: string): string => `${type}:${id}`;

/** Build the lookup index for a document's `included` array. */
export function indexIncluded(included: ResourceObject[] | undefined): IncludedIndex {
  const index: IncludedIndex = new Map();
  for (const resource of included ?? []) {
    index.set(identityKey(resource.type, resource.id), resource);
  }
  return index;
}

/**
 * Resolve a to-one relationship to the resource it points at.
 *
 * Returns `null` for every ordinary reason a pointer does not resolve: the
 * field is empty, the relationship was not requested with `?include=`, or the
 * referenced entity was deleted and Drupal left a dangling pointer. Callers
 * treat all three the same way, so the distinction is not surfaced.
 */
export function resolveOne(
  relationship: Relationship | undefined,
  index: IncludedIndex,
): ResourceObject | null {
  const data = relationship?.data;
  if (!data || Array.isArray(data)) return null;
  return index.get(identityKey(data.type, data.id)) ?? null;
}

/** Resolve a to-many relationship, dropping pointers that do not resolve. */
export function resolveMany(
  relationship: Relationship | undefined,
  index: IncludedIndex,
): ResourceObject[] {
  const data = relationship?.data;
  if (!data) return [];
  const identifiers: ResourceIdentifier[] = Array.isArray(data) ? data : [data];
  const resolved: ResourceObject[] = [];
  for (const identifier of identifiers) {
    const resource = index.get(identityKey(identifier.type, identifier.id));
    if (resource) resolved.push(resource);
  }
  return resolved;
}

/**
 * Normalise Drupal's image-style derivative URLs.
 *
 * Drupal serialises `image_style_uri` inconsistently depending on version and
 * module configuration: sometimes an object of `{styleName: url}`, sometimes an
 * array containing one such object. Both appear in the wild against the same
 * codebase, so both are accepted here rather than at every call site.
 */
function readImageStyles(raw: unknown): Record<string, string> {
  const source = Array.isArray(raw) ? raw[0] : raw;
  if (typeof source !== 'object' || source === null) return {};
  const styles: Record<string, string> = {};
  for (const [name, url] of Object.entries(source)) {
    if (typeof url === 'string' && url) styles[name] = url;
  }
  return styles;
}

/** Absolute URL for a file resource, preferring Drupal's resolved `url`. */
function readFileUrl(file: DrupalFileResource, siteUrl: string): string | null {
  const uri = file.attributes?.uri;
  // `uri.url` is the site-relative path Drupal resolved; `uri.value` is the
  // raw stream wrapper (`public://foo.jpg`), which is not fetchable.
  const relative = uri?.url;
  if (typeof relative !== 'string' || !relative) return null;
  if (/^https?:\/\//i.test(relative)) return relative;
  return `${siteUrl.replace(/\/+$/, '')}${relative.startsWith('/') ? '' : '/'}${relative}`;
}

/**
 * Resolve an image relationship to something renderable.
 *
 * Drupal exposes images through two different field types, and a starter has to
 * survive both because which one a site uses is a decision made by whoever
 * built it:
 *
 * ```
 * plain image field      field_image ──────────────────────► file--file
 * media reference        field_image ──► media--image ──► field_media_image ──► file--file
 * ```
 *
 * Core's `article_content_type` recipe produces the first. The media library —
 * the modern default for anything reused across nodes — produces the second.
 * Handling only one of them means the images silently vanish on half of all
 * Drupal sites, and "no image" looks exactly like an article that has none.
 *
 * ## Where the alt text lives
 *
 * Not on the file. Drupal puts `alt`, `title`, `width` and `height` in the
 * **relationship's `meta`** block — on the pointer, not on the resource it
 * points at. That is defensible (the same file reused on two nodes can carry
 * different alt text per usage) and it is also the single detail most likely to
 * be missed, because every instinct says to look at the file. A mapper that
 * reads the file's attributes renders every image with empty alt and no
 * intrinsic dimensions.
 *
 * Verified against a live Drupal 11 instance; see `fixtures/drupal/`.
 */
export function toDomainImage(
  relationship: Relationship | undefined,
  index: IncludedIndex,
  siteUrl: string,
): DomainImage | null {
  const pointer = relationship?.data;
  if (!pointer || Array.isArray(pointer)) return null;

  const target = index.get(identityKey(pointer.type, pointer.id));
  if (!target) return null;

  // Media reference: hop through the media entity to the file it wraps, and
  // take the metadata from *that* inner relationship, which is where Drupal
  // records alt text for a media image.
  // Declared without an initialiser: both branches below assign it, and a
  // placeholder `null` here would just be dead.
  let file: DrupalFileResource | null;
  let meta = pointer.meta;

  if (target.type === 'file--file') {
    file = target as DrupalFileResource;
  } else {
    const media = target as DrupalMediaImageResource;
    const inner = media.relationships?.field_media_image;
    const innerPointer = inner?.data;
    if (innerPointer && !Array.isArray(innerPointer)) {
      meta = innerPointer.meta ?? meta;
    }
    file = resolveOne(inner, index) as DrupalFileResource | null;
  }

  // The media entity can outlive the file behind it. Rendering that produces a
  // broken <img>, so it counts as no image.
  if (!file) return null;

  const url = readFileUrl(file, siteUrl);
  if (!url) return null;

  return {
    url,
    // An empty string marks the image decorative, which is the correct
    // accessible default — and better than inventing alt text from a filename.
    alt: typeof meta?.alt === 'string' ? meta.alt : '',
    // Only present when the `consumer_image_styles` module is installed; an
    // empty map lets callers write `styles.wide ?? url` with no null check.
    styles: readImageStyles(file.attributes?.image_style_uri),
    ...(typeof meta?.width === 'number' ? { width: meta.width } : {}),
    ...(typeof meta?.height === 'number' ? { height: meta.height } : {}),
  };
}

/**
 * Read a processed-text field.
 *
 * Only `processed` is returned. `value` holds the editor's raw input before
 * Drupal ran the text format's filters over it, so rendering it would let
 * someone restricted to a basic format emit markup that format exists to strip.
 */
export function readProcessedText(field: DrupalTextField | undefined): string {
  return typeof field?.processed === 'string' ? field.processed : '';
}

/** Strip tags and collapse whitespace, for summaries and meta descriptions. */
export function toPlainText(html: string, maxLength = 200): string {
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length <= maxLength) return text;
  // Cut on a word boundary so the ellipsis does not land mid-word.
  const clipped = text.slice(0, maxLength);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${lastSpace > maxLength * 0.6 ? clipped.slice(0, lastSpace) : clipped}…`;
}

/**
 * Derive the path an article lives at.
 *
 * Drupal's URL alias is authoritative when set. Without one, the canonical
 * fallback is the entity path — but `/node/{uuid}` is not a useful public URL,
 * so this starter routes by UUID under `/articles/` instead. Either way the
 * result is leading-slash normalised, because half of Drupal's aliases arrive
 * with one and half without.
 */
export function toArticlePath(resource: DrupalArticleResource): string {
  const alias = resource.attributes?.path?.alias;
  if (typeof alias === 'string' && alias.trim()) {
    return alias.startsWith('/') ? alias : `/${alias}`;
  }
  return `/articles/${resource.id}`;
}

/** Map a `node--article` resource to the domain `Article`. */
export function toArticle(
  resource: ResourceObject,
  index: IncludedIndex,
  siteUrl: string,
): Article {
  const article = resource as DrupalArticleResource;
  const body = article.attributes?.body;
  const bodyHtml = readProcessedText(body);

  return {
    id: article.id,
    path: toArticlePath(article),
    title: typeof article.attributes?.title === 'string' ? article.attributes.title : '',
    bodyHtml,
    // Drupal's own summary wins when an editor wrote one; otherwise derive it.
    summary:
      typeof body?.summary === 'string' && body.summary.trim()
        ? toPlainText(body.summary)
        : toPlainText(bodyHtml),
    createdAt: typeof article.attributes?.created === 'string' ? article.attributes.created : null,
    updatedAt: typeof article.attributes?.changed === 'string' ? article.attributes.changed : null,
    // Defaults to false on purpose: an unknown status must never be treated as
    // publicly visible, or a draft leaks the first time the field is renamed.
    published: article.attributes?.status === true,
    image: toDomainImage(article.relationships?.field_image, index, siteUrl),
  };
}

/** Map a `node--article` resource to the lighter listing shape. */
export function toArticleSummary(
  resource: ResourceObject,
  index: IncludedIndex,
  siteUrl: string,
): ArticleSummary {
  const { id, path, title, summary, createdAt, image } = toArticle(resource, index, siteUrl);
  return { id, path, title, summary, createdAt, image };
}
