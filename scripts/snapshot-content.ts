/**
 * Capture JSON:API responses from a live Drupal instance into
 * `fixtures/drupal/`, so the front end can run with no backend at all.
 *
 * Run it against the DDEV site once the reference content exists:
 *
 * ```bash
 * NUXT_DRUPAL_BASE_URL="$(cd drupal && ddev describe -j | jq -r '.raw.primary_url')" \
 *   pnpm snapshot:content
 * ```
 *
 * The output is committed. That is deliberate: the fixtures are the difference
 * between a reviewer seeing a rendered page in thirty seconds and a reviewer
 * installing PHP, Composer, a database and a content model first. It also means
 * CI exercises the client, validators and mappers on every run without
 * provisioning a CMS.
 *
 * Captured rather than hand-written, because hand-written fixtures drift
 * towards what the code expects instead of what Drupal emits. The
 * inconsistencies worth defending against — `image_style_uri` serialised as an
 * object in one configuration and an array in another, relationships pointing
 * at entities that were deleted — are precisely the ones nobody invents from
 * memory. See docs/adr/002.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDrupalClient, type DrupalQuery } from '../server/drupal/client.js';

const OUTPUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/drupal');

/**
 * What to capture, and how.
 *
 * `include` is a list of *candidates*, tried deepest-first. Drupal rejects an
 * include path that does not exist on the field with a 400, and which path is
 * valid depends on how the site was built: `field_image` on a plain image field
 * points straight at `file--file` and has no `field_media_image` to traverse,
 * while a media-reference field needs exactly that second hop. Capturing only
 * the shallow path against a media field produces fixtures whose images never
 * resolve — and "no image" looks like correct behaviour rather than a truncated
 * snapshot, so the failure is silent.
 */
const TARGETS: {
  resourceType: string;
  file: string;
  query: DrupalQuery;
  includeCandidates: string[][];
}[] = [
  {
    resourceType: 'node/article',
    file: 'node--article.json',
    query: { sort: ['-created'], limit: 20 },
    includeCandidates: [
      // Media reference field (media library).
      ['field_image', 'field_image.field_media_image'],
      // Plain image field (core's article_content_type recipe).
      ['field_image'],
      // Field absent entirely.
      [],
    ],
  },
  // Menus are deliberately absent.
  //
  // Core JSON:API exposes `menu_link_content`, but reading it requires the
  // `administer menu` permission — so an anonymous consumer gets HTTP 200, an
  // empty `data` array, and the explanation buried in `meta.omitted`. Granting
  // an API consumer `administer menu` to work around that would hand it write
  // access to every menu on the site, which is not a trade a starter should
  // recommend.
  //
  // `drupal/jsonapi_menu_items` is the usual community answer, but it has no
  // stable Drupal 11 release, and an unstable contrib dependency is not
  // something to put in a starter's critical path either.
  //
  // The endpoint therefore lands with the menu feature itself: a small
  // read-only, access-checked module in `drupal/modules/custom/`. Until then
  // the front end has no menu source and none is pretended.
];

/**
 * Strip values that should not live in a public repository or that would make
 * the snapshot churn on every capture.
 *
 * Two separate concerns, both real:
 *
 * - **Secrets.** Drupal embeds absolute URLs containing the site host, and — if
 *   the snapshot is taken authenticated — can include `meta` blocks describing
 *   the requesting session. Neither belongs in git.
 * - **Noise.** JSON:API emits `self` links and `resourceVersion` query strings
 *   that change on every save. Left in, every re-capture produces a diff that
 *   is entirely link churn, and the actual content change is invisible.
 *
 * `meta` needs care rather than a blanket rule, and getting it wrong is silent.
 * Document-level `meta` is per-request noise and goes. But the `meta` block on
 * a **resource identifier** — the `{type, id, meta}` pointer inside a
 * relationship — is where Drupal stores an image's alt text, width and height.
 * Stripping that leaves fixtures whose images resolve to a URL with empty alt,
 * which looks like a mapper bug rather than a capture bug. The distinguishing
 * feature is the sibling `type` and `id`.
 */
function sanitize(value: unknown, siteOrigin: string): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitize(item, siteOrigin));

  if (typeof value === 'string') {
    // Replace the capturing site's origin with a stable placeholder so the
    // fixtures do not leak a hostname and do not change when captured from a
    // different environment.
    return value.split(siteOrigin).join('https://cms.example.test');
  }

  if (typeof value !== 'object' || value === null) return value;

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  // A resource identifier carries `type` and `id` alongside its `meta`; that
  // `meta` is content, not request metadata, and must survive.
  const isResourceIdentifier =
    typeof source.type === 'string' && typeof source.id === 'string';

  for (const [key, entry] of Object.entries(source)) {
    // `links` is pure addressing noise for a fixture; the pagination link the
    // fixture transport needs is synthesised rather than replayed.
    if (key === 'links') continue;
    if (key === 'resourceVersion') continue;
    // Drupal's per-request metadata: consumer ids, session info, counts that
    // depend on who asked. Kept on identifiers, dropped everywhere else.
    if (key === 'meta' && !isResourceIdentifier && !Array.isArray(entry)) continue;
    result[key] = sanitize(entry, siteOrigin);
  }

  return result;
}

async function main(): Promise<void> {
  const baseUrl = process.env.NUXT_DRUPAL_BASE_URL?.replace(/\/+$/, '');
  if (!baseUrl) {
    console.error(
      'NUXT_DRUPAL_BASE_URL is required.\n' +
        'Start the reference backend and pass its URL:\n' +
        "  NUXT_DRUPAL_BASE_URL=\"$(cd drupal && ddev describe -j | jq -r '.raw.primary_url')\" pnpm snapshot:content",
    );
    process.exitCode = 1;
    return;
  }

  const client = createDrupalClient({
    baseUrl,
    ...(process.env.NUXT_DRUPAL_TOKEN ? { token: process.env.NUXT_DRUPAL_TOKEN } : {}),
    timeoutMs: 30_000,
  });

  await mkdir(OUTPUT_DIR, { recursive: true });

  for (const target of TARGETS) {
    process.stdout.write(`Capturing ${target.resourceType} … `);

    let captured: Awaited<ReturnType<typeof client.getCollection>> | null = null;
    let usedInclude: string[] = [];
    let lastError: unknown = null;

    for (const include of target.includeCandidates) {
      try {
        captured = await client.getCollection(target.resourceType, {
          ...target.query,
          ...(include.length ? { include } : {}),
        });
        usedInclude = include;
        break;
      } catch (error: unknown) {
        // A 400 here means "that include path does not exist on this site",
        // which is information, not a failure — try the next shape.
        lastError = error;
      }
    }

    if (!captured) {
      // One missing resource type must not abandon the whole capture: a site
      // without a menu still has articles worth snapshotting.
      console.error(
        `failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
      process.exitCode = 1;
      continue;
    }

    const cleaned = sanitize(captured, baseUrl);
    const path = resolve(OUTPUT_DIR, target.file);
    // Trailing newline and two-space indent so the committed diff is
    // reviewable rather than one enormous line.
    await writeFile(path, `${JSON.stringify(cleaned, null, 2)}\n`, 'utf8');

    const count = Array.isArray(captured.data) ? captured.data.length : 1;
    const included = captured.included?.length ?? 0;
    const shape = usedInclude.length ? `include=${usedInclude.join(',')}` : 'no includes';
    console.log(`${count} resources, ${included} included (${shape}) → ${target.file}`);
  }
}

await main();
