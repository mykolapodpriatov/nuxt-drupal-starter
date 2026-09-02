import { describe, expect, it } from 'vitest';
import {
  indexIncluded,
  readProcessedText,
  resolveMany,
  resolveOne,
  toArticle,
  toArticlePath,
  toArticleSummary,
  toDomainImage,
  toPlainText,
} from '../server/drupal/normalize.js';
import type { ResourceObject } from '../server/drupal/transport.js';

const SITE = 'https://cms.example.test';

/** A `file--file` as Drupal serialises it, with optional style derivatives. */
function file(id: string, url: string, styles?: Record<string, string>): ResourceObject {
  return {
    type: 'file--file',
    id,
    attributes: {
      uri: { value: `public://${url.split('/').pop()}`, url },
      filemime: 'image/jpeg',
      ...(styles ? { image_style_uri: styles } : {}),
    },
  };
}

/** A `media--image` wrapping a file. */
function media(id: string, fileId: string, name = 'Hero image'): ResourceObject {
  return {
    type: 'media--image',
    id,
    attributes: { name },
    relationships: { field_media_image: { data: { type: 'file--file', id: fileId } } },
  };
}

function article(overrides: Partial<ResourceObject> = {}): ResourceObject {
  return {
    type: 'node--article',
    id: 'a-1',
    attributes: {
      title: 'Decoupling Drupal',
      path: { alias: '/blog/decoupling-drupal' },
      body: {
        value: '<script>raw</script><p>Body</p>',
        processed: '<p>Body</p>',
        format: 'basic_html',
      },
      created: '2026-01-15T10:00:00+00:00',
      changed: '2026-02-01T12:30:00+00:00',
      status: true,
    },
    ...overrides,
  };
}

describe('indexIncluded / resolveOne / resolveMany', () => {
  it('resolves a to-one pointer through the included array', () => {
    const index = indexIncluded([media('m-1', 'f-1'), file('f-1', '/sites/a.jpg')]);
    const resolved = resolveOne({ data: { type: 'media--image', id: 'm-1' } }, index);
    expect(resolved?.id).toBe('m-1');
  });

  it('distinguishes resources that share an id across types', () => {
    // JSON:API ids are only unique within a type, so an index keyed on id alone
    // silently returns the wrong entity.
    const index = indexIncluded([
      { type: 'media--image', id: 'same' },
      { type: 'file--file', id: 'same' },
    ]);
    expect(resolveOne({ data: { type: 'file--file', id: 'same' } }, index)?.type).toBe(
      'file--file',
    );
  });

  it('returns null for an empty to-one relationship', () => {
    expect(resolveOne({ data: null }, indexIncluded([]))).toBeNull();
  });

  it('returns null when the relationship was never requested', () => {
    expect(resolveOne(undefined, indexIncluded([]))).toBeNull();
  });

  it('returns null for a pointer with nothing behind it', () => {
    // A dangling pointer is what a deleted entity leaves behind.
    const index = indexIncluded([]);
    expect(resolveOne({ data: { type: 'media--image', id: 'gone' } }, index)).toBeNull();
  });

  it('drops unresolvable members of a to-many relationship', () => {
    const index = indexIncluded([{ type: 'taxonomy_term--tags', id: 't-1' }]);
    const resolved = resolveMany(
      {
        data: [
          { type: 'taxonomy_term--tags', id: 't-1' },
          { type: 'taxonomy_term--tags', id: 'deleted' },
        ],
      },
      index,
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.id).toBe('t-1');
  });

  it('accepts a to-one shape where a to-many was expected', () => {
    // Making a field multi-value in Drupal changes `data` from an object to an
    // array. Handling both keeps that from being a breaking change.
    const index = indexIncluded([{ type: 'taxonomy_term--tags', id: 't-1' }]);
    expect(resolveMany({ data: { type: 'taxonomy_term--tags', id: 't-1' } }, index)).toHaveLength(
      1,
    );
  });
});

describe('readProcessedText', () => {
  it('returns the processed output', () => {
    expect(readProcessedText({ value: 'raw', processed: '<p>done</p>' })).toBe('<p>done</p>');
  });

  it('never falls back to the unfiltered raw value', () => {
    // `value` has not been through the text format's filters. Falling back to
    // it would let an editor restricted to a basic format emit markup that
    // format exists to strip.
    expect(readProcessedText({ value: '<script>alert(1)</script>' })).toBe('');
  });

  it('returns an empty string for a missing field', () => {
    expect(readProcessedText(undefined)).toBe('');
  });
});

describe('toPlainText', () => {
  it('strips markup and collapses whitespace', () => {
    expect(toPlainText('<p>Hello   <em>there</em></p>\n<p>friend</p>')).toBe(
      'Hello there friend',
    );
  });

  it('decodes the entities Drupal emits', () => {
    expect(toPlainText('<p>Tom &amp; Jerry &lt;3 &quot;quotes&quot;</p>')).toBe(
      'Tom & Jerry <3 "quotes"',
    );
  });

  it('truncates on a word boundary', () => {
    const long = `<p>${'word '.repeat(80)}</p>`;
    const result = toPlainText(long, 50);
    expect(result.length).toBeLessThanOrEqual(51);
    expect(result.endsWith('…')).toBe(true);
    expect(result).not.toMatch(/wor…$/);
  });

  it('leaves short text untouched', () => {
    expect(toPlainText('<p>Short</p>', 50)).toBe('Short');
  });
});

describe('toArticlePath', () => {
  it('prefers the Drupal URL alias', () => {
    expect(toArticlePath(article())).toBe('/blog/decoupling-drupal');
  });

  it('normalises an alias stored without a leading slash', () => {
    const resource = article({ attributes: { path: { alias: 'blog/no-slash' } } });
    expect(toArticlePath(resource)).toBe('/blog/no-slash');
  });

  it('falls back to a UUID route when no alias is set', () => {
    // `/node/{uuid}` is Drupal's canonical path but not a useful public URL.
    const resource = article({ attributes: { path: { alias: null } } });
    expect(toArticlePath(resource)).toBe('/articles/a-1');
  });

  it('ignores a whitespace-only alias', () => {
    const resource = article({ attributes: { path: { alias: '   ' } } });
    expect(toArticlePath(resource)).toBe('/articles/a-1');
  });
});

describe('toDomainImage', () => {
  /** Relationship pointer with the meta block Drupal actually sends. */
  const pointer = (
    type: string,
    id: string,
    meta?: Record<string, unknown>,
  ) => ({ data: { type, id, ...(meta ? { meta } : {}) } });

  describe('plain image field (core article recipe)', () => {
    it('resolves a file relationship directly', () => {
      // `field_image` on core's article content type is an image field, not a
      // media reference — it points straight at file--file.
      const index = indexIncluded([file('f-1', '/sites/default/files/cover.jpg')]);
      const image = toDomainImage(
        pointer('file--file', 'f-1', { alt: 'A cover', width: 1200, height: 630 }),
        index,
        SITE,
      );
      expect(image?.url).toBe(`${SITE}/sites/default/files/cover.jpg`);
      expect(image?.alt).toBe('A cover');
      expect(image?.width).toBe(1200);
      expect(image?.height).toBe(630);
    });

    it('reads alt from the relationship meta, not the file', () => {
      // Drupal records alt on the pointer, so the same file reused on two nodes
      // can carry different alt text. Reading the file's attributes instead
      // renders every image with empty alt.
      const index = indexIncluded([file('f-1', '/a.jpg')]);
      const image = toDomainImage(pointer('file--file', 'f-1', { alt: 'From meta' }), index, SITE);
      expect(image?.alt).toBe('From meta');
    });

    it('marks the image decorative when alt is absent', () => {
      const index = indexIncluded([file('f-1', '/a.jpg')]);
      expect(toDomainImage(pointer('file--file', 'f-1'), index, SITE)?.alt).toBe('');
    });

    it('omits width and height when Drupal did not supply them', () => {
      const index = indexIncluded([file('f-1', '/a.jpg')]);
      const image = toDomainImage(pointer('file--file', 'f-1', { alt: 'x' }), index, SITE);
      expect(image).not.toHaveProperty('width');
    });
  });

  describe('media reference field (media library)', () => {
    it('hops through the media entity to its file', () => {
      const index = indexIncluded([media('m-1', 'f-1'), file('f-1', '/sites/default/a.jpg')]);
      const image = toDomainImage(pointer('media--image', 'm-1'), index, SITE);
      expect(image?.url).toBe(`${SITE}/sites/default/a.jpg`);
    });

    it('takes alt from the inner field_media_image relationship', () => {
      const withMeta: ResourceObject = {
        type: 'media--image',
        id: 'm-1',
        attributes: { name: 'Admin-facing media name' },
        relationships: {
          field_media_image: {
            data: { type: 'file--file', id: 'f-1', meta: { alt: 'Real alt text' } },
          },
        },
      };
      const index = indexIncluded([withMeta, file('f-1', '/a.jpg')]);
      const image = toDomainImage(pointer('media--image', 'm-1'), index, SITE);
      // The media entity's `name` is an admin label, not alt text.
      expect(image?.alt).toBe('Real alt text');
    });

    it('returns null when the file behind the media entity is gone', () => {
      // A media entity routinely outlives its file; rendering it would produce
      // a broken <img>.
      const index = indexIncluded([media('m-1', 'missing')]);
      expect(toDomainImage(pointer('media--image', 'm-1'), index, SITE)).toBeNull();
    });
  });

  describe('absence', () => {
    it('returns null for an empty relationship', () => {
      expect(toDomainImage({ data: null }, indexIncluded([]), SITE)).toBeNull();
    });

    it('returns null when the field was never requested', () => {
      expect(toDomainImage(undefined, indexIncluded([]), SITE)).toBeNull();
    });

    it('returns null for a dangling pointer', () => {
      expect(
        toDomainImage(pointer('file--file', 'deleted'), indexIncluded([]), SITE),
      ).toBeNull();
    });

    it('returns null for a multi-value relationship', () => {
      // A field made multi-value in Drupal flips `data` to an array. Rendering
      // an arbitrary member would be a guess; the caller should ask for a list.
      const index = indexIncluded([file('f-1', '/a.jpg')]);
      expect(
        toDomainImage({ data: [{ type: 'file--file', id: 'f-1' }] }, index, SITE),
      ).toBeNull();
    });

    it('returns null when the file has no resolvable URL', () => {
      const brokenFile: ResourceObject = {
        type: 'file--file',
        id: 'f-1',
        attributes: { uri: { value: 'public://a.jpg' } },
      };
      const index = indexIncluded([brokenFile]);
      expect(toDomainImage(pointer('file--file', 'f-1'), index, SITE)).toBeNull();
    });
  });

  describe('URLs and image styles', () => {
    it('leaves an already absolute file URL alone', () => {
      const index = indexIncluded([file('f-1', 'https://cdn.example.test/a.jpg')]);
      expect(toDomainImage(pointer('file--file', 'f-1'), index, SITE)?.url).toBe(
        'https://cdn.example.test/a.jpg',
      );
    });

    it('yields an empty styles map when consumer_image_styles is not installed', () => {
      // Which is the default: a stock Drupal emits no `image_style_uri` at all.
      const index = indexIncluded([file('f-1', '/a.jpg')]);
      expect(toDomainImage(pointer('file--file', 'f-1'), index, SITE)?.styles).toEqual({});
    });

    it('reads image styles served as an object', () => {
      const index = indexIncluded([
        file('f-1', '/a.jpg', { wide: '/styles/wide/a.jpg', thumb: '/styles/thumb/a.jpg' }),
      ]);
      expect(toDomainImage(pointer('file--file', 'f-1'), index, SITE)?.styles).toEqual({
        wide: '/styles/wide/a.jpg',
        thumb: '/styles/thumb/a.jpg',
      });
    });

    it('reads image styles served as an array-wrapped object', () => {
      // Drupal serialises this field both ways depending on version and module
      // configuration, against the same codebase.
      const wrapped: ResourceObject = {
        type: 'file--file',
        id: 'f-1',
        attributes: { uri: { url: '/a.jpg' }, image_style_uri: [{ wide: '/styles/wide/a.jpg' }] },
      };
      const index = indexIncluded([wrapped]);
      expect(toDomainImage(pointer('file--file', 'f-1'), index, SITE)?.styles).toEqual({
        wide: '/styles/wide/a.jpg',
      });
    });
  });
});

describe('toArticle', () => {
  it('maps a fully populated article', () => {
    const index = indexIncluded([file('f-1', '/a.jpg')]);
    const resource = article({
      relationships: {
        field_image: { data: { type: 'file--file', id: 'f-1', meta: { alt: 'Cover' } } },
      },
    });
    const result = toArticle(resource, index, SITE);

    expect(result).toMatchObject({
      id: 'a-1',
      path: '/blog/decoupling-drupal',
      title: 'Decoupling Drupal',
      bodyHtml: '<p>Body</p>',
      summary: 'Body',
      published: true,
    });
    expect(result.image?.url).toBe(`${SITE}/a.jpg`);
  });

  it('never exposes the unfiltered body value', () => {
    const result = toArticle(article(), indexIncluded([]), SITE);
    expect(result.bodyHtml).not.toContain('<script>');
  });

  it('prefers an editor-written summary over a derived one', () => {
    const resource = article({
      attributes: {
        title: 'T',
        body: { processed: '<p>Long body text</p>', summary: 'Editor summary' },
      },
    });
    expect(toArticle(resource, indexIncluded([]), SITE).summary).toBe('Editor summary');
  });

  it('derives a summary when the editor left it blank', () => {
    const resource = article({
      attributes: { title: 'T', body: { processed: '<p>Derived from body</p>', summary: '  ' } },
    });
    expect(toArticle(resource, indexIncluded([]), SITE).summary).toBe('Derived from body');
  });

  it('treats an unknown status as unpublished', () => {
    // Defaulting the other way leaks drafts the first time the field is
    // renamed or omitted from a sparse fieldset.
    const resource = article({ attributes: { title: 'T' } });
    expect(toArticle(resource, indexIncluded([]), SITE).published).toBe(false);
  });

  it('fills every required field for an almost-empty resource', () => {
    // A page must render even when the content model has been gutted.
    const result = toArticle({ type: 'node--article', id: 'x' }, indexIncluded([]), SITE);
    expect(result).toEqual({
      id: 'x',
      path: '/articles/x',
      title: '',
      bodyHtml: '',
      summary: '',
      createdAt: null,
      updatedAt: null,
      published: false,
      image: null,
    });
  });
});

describe('toArticleSummary', () => {
  it('carries only the fields a listing card needs', () => {
    const summary = toArticleSummary(article(), indexIncluded([]), SITE);
    expect(Object.keys(summary).sort()).toEqual([
      'createdAt',
      'id',
      'image',
      'path',
      'summary',
      'title',
    ]);
  });
});
