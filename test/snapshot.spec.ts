import { describe, expect, it } from 'vitest';
import { createClientForSettings, fixtureSet } from '../server/drupal/index.js';
import { indexIncluded, toArticle } from '../server/drupal/normalize.js';

/**
 * The committed snapshot, run through the real pipeline.
 *
 * Every other spec in this repository builds its own input, which means every
 * other spec can only ever confirm that the code agrees with what its author
 * expected Drupal to send. This one starts from bytes an actual Drupal 11
 * instance produced — captured by `scripts/snapshot-content.ts` — and pushes
 * them through the client, the validators and the mappers unchanged.
 *
 * It exists because that distinction already paid for itself. Writing the
 * mappers from the specification produced two wrong assumptions that no
 * hand-written fixture would have caught, because a hand-written fixture would
 * have been written from the same wrong assumptions:
 *
 * 1. `field_image` on core's article content type is a **plain image field**
 *    pointing straight at `file--file`, not a media reference. The mapper only
 *    handled `media--image → file--file`, so every image silently vanished.
 * 2. Alt text, width and height live in the **relationship's `meta`**, on the
 *    pointer — not on the file resource. Reading the file's attributes produced
 *    empty alt on every image.
 *
 * Both failures render as "the article has no image", which is
 * indistinguishable from an article that genuinely has none.
 */
describe('committed snapshot', () => {
  const document = fixtureSet.collections['node/article'];
  const resources = Array.isArray(document?.data) ? document.data : [];

  it('contains articles', () => {
    expect(resources.length).toBeGreaterThan(0);
  });

  it('is a valid JSON:API document the client accepts', async () => {
    // Not a structural spot-check: this runs the snapshot back through the
    // same validation the live path uses.
    const { client } = createClientForSettings({ baseUrl: '', token: '', timeoutMs: 5000 });
    const collection = await client.getCollection('node/article');
    expect(collection.data.length).toBe(resources.length);
  });

  it('leaks no hostname from the machine it was captured on', () => {
    // The capture replaces the capturing origin with a placeholder. A real
    // hostname here would be committed to a public repository.
    const serialized = JSON.stringify(document);
    expect(serialized).not.toMatch(/ddev\.site/);
    expect(serialized).not.toMatch(/127\.0\.0\.1/);
    expect(serialized).not.toMatch(/localhost/);
  });

  it('carries no per-request metadata or version churn', () => {
    // `links`, `meta` and `resourceVersion` change on every save; left in, a
    // re-capture is one enormous diff of link noise.
    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain('resourceVersion');
    expect(serialized).not.toContain('"links"');
  });

  it('maps every captured article without throwing', () => {
    const index = indexIncluded(document?.included);
    for (const resource of resources) {
      const article = toArticle(resource, index, 'https://cms.example.test');
      // The domain contract: these are non-optional whatever Drupal sent.
      expect(article.id).toBeTruthy();
      expect(article.path.startsWith('/')).toBe(true);
      expect(typeof article.title).toBe('string');
      expect(typeof article.bodyHtml).toBe('string');
      expect(typeof article.summary).toBe('string');
    }
  });

  it('resolves at least one real image end to end', () => {
    // Guards the two assumptions above. If either regresses, every article
    // maps to `image: null` and this is the only test that notices.
    const index = indexIncluded(document?.included);
    const withImages = resources
      .map((resource) => toArticle(resource, index, 'https://cms.example.test'))
      .filter((article) => article.image !== null);

    expect(withImages.length).toBeGreaterThan(0);
    const image = withImages[0]!.image!;
    expect(image.url).toMatch(/^https:\/\/cms\.example\.test\/.+\.(jpe?g|png|webp|avif)$/);
    // Alt comes from the relationship meta; empty here would mean the mapper
    // is reading the file resource again.
    expect(image.alt.length).toBeGreaterThan(0);
    expect(image.width).toBeGreaterThan(0);
    expect(image.height).toBeGreaterThan(0);
  });

  it('includes an article with no image, because that case must be covered', () => {
    const index = indexIncluded(document?.included);
    const withoutImage = resources
      .map((resource) => toArticle(resource, index, 'https://cms.example.test'))
      .filter((article) => article.image === null);
    expect(withoutImage.length).toBeGreaterThan(0);
  });

  it('contains only published content', () => {
    // The snapshot is captured anonymously, so Drupal's own access control
    // excluded the draft. Worth asserting: a snapshot taken with a privileged
    // token would quietly commit unpublished content to a public repository.
    const index = indexIncluded(document?.included);
    for (const resource of resources) {
      expect(toArticle(resource, index, 'https://cms.example.test').published).toBe(true);
    }
  });

  it('resolves image URLs against the configured site origin', () => {
    const index = indexIncluded(document?.included);
    const article = resources
      .map((resource) => toArticle(resource, index, 'https://front.example.test'))
      .find((candidate) => candidate.image !== null);
    expect(article?.image?.url.startsWith('https://front.example.test/')).toBe(true);
  });
});
