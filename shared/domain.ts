/**
 * Domain models — the shape the UI wants.
 *
 * These are deliberately not a renaming of Drupal's JSON:API resources. They
 * describe what a template needs in order to render, and nothing else: flat,
 * non-optional where the UI cannot cope with absence, and free of any
 * vocabulary that only makes sense inside Drupal (`attributes`, `included`,
 * `field_`, `--`).
 *
 * The rule that keeps this honest: **nothing under `app/` may import from
 * `server/drupal/transport.ts`.** If a component needs a new piece of data, the
 * change lands in the domain model and its mapper, not in the component's
 * knowledge of Drupal.
 *
 * Two consequences worth stating, because they are the reason the indirection
 * pays for itself:
 *
 * - Renaming `field_image` to `field_hero` in Drupal touches one mapper.
 *   Without the split it touches every template that rendered an image.
 * - Swapping the backend — to a different CMS, or to fixtures — means writing
 *   another mapper to the same target type. That is exactly how this repo's
 *   backend-free mode works.
 *
 * These types live in `shared/` because both the Nitro server and the Vue app
 * legitimately need them; Nuxt makes that directory available to both.
 */

/** A renderable image, already resolved to concrete URLs. */
export interface DomainImage {
  /** Absolute URL of the original file. */
  url: string;
  /** Alternative text. Empty string means decorative — never `undefined`. */
  alt: string;
  /**
   * Derivative URLs keyed by Drupal image style name, when the backend exposes
   * them. Empty when it does not, so callers can fall back to `url` without a
   * null check.
   */
  styles: Record<string, string>;
  width?: number;
  height?: number;
}

/** An article, ready to render. */
export interface Article {
  id: string;
  /** URL path this article lives at, always leading-slash normalised. */
  path: string;
  title: string;
  /**
   * Body HTML, taken from Drupal's `processed` output only.
   *
   * `processed` is the result of running the raw input through the text
   * format's filters. The raw `value` never reaches this field: rendering it
   * would let an editor restricted to a basic text format emit markup that
   * format is configured to strip.
   */
  bodyHtml: string;
  /** Plain-text summary for listings and meta description. */
  summary: string;
  /** ISO-8601. Absent when Drupal did not supply a creation date. */
  createdAt: string | null;
  updatedAt: string | null;
  /** `false` for content visible only through the preview route. */
  published: boolean;
  image: DomainImage | null;
}

/** An article reduced to what a listing card needs. */
export type ArticleSummary = Pick<
  Article,
  'id' | 'path' | 'title' | 'summary' | 'createdAt' | 'image'
>;

/** One entry in a navigation menu, with its children already nested. */
export interface MenuItem {
  id: string;
  title: string;
  /** Internal path or absolute URL, exactly as it should appear in `href`. */
  url: string;
  children: MenuItem[];
}

/** A page of results plus the cursor needed to ask for the next one. */
export interface Paginated<T> {
  items: T[];
  /**
   * Opaque cursor for the following page, or `null` on the last page.
   * Deliberately opaque: JSON:API pagination is a URL, and callers should not
   * be constructing offsets by hand.
   */
  nextCursor: string | null;
}
