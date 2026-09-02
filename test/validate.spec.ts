import { describe, expect, it } from 'vitest';
import {
  assertCollection,
  assertJsonApiDocument,
  assertSingleResource,
  describeErrors,
  describeOmitted,
  DrupalResponseError,
  isErrorDocument,
  isResourceObject,
} from '../server/drupal/validate.js';

describe('isResourceObject', () => {
  it('accepts the minimal {type, id} shape', () => {
    expect(isResourceObject({ type: 'node--article', id: 'a-1' })).toBe(true);
  });

  it.each([
    ['a missing id', { type: 'node--article' }],
    ['a numeric id', { type: 'node--article', id: 1 }],
    ['a missing type', { id: 'a-1' }],
    ['null', null],
    ['an array', []],
    ['a string', 'node--article'],
  ])('rejects %s', (_label, value) => {
    expect(isResourceObject(value)).toBe(false);
  });
});

describe('isErrorDocument / describeErrors', () => {
  it('detects an errors array', () => {
    expect(isErrorDocument({ errors: [{ title: 'Nope' }] })).toBe(true);
  });

  it('does not mistake a success document for an error', () => {
    expect(isErrorDocument({ data: [] })).toBe(false);
  });

  it('renders status, title and detail on one line', () => {
    expect(
      describeErrors({
        errors: [{ status: '403', title: 'Forbidden', detail: 'Permission required.' }],
      }),
    ).toBe('403 Forbidden: Permission required.');
  });

  it('joins multiple errors', () => {
    expect(
      describeErrors({ errors: [{ title: 'First' }, { title: 'Second' }] }),
    ).toBe('First; Second');
  });

  it('degrades to a usable message for an empty errors array', () => {
    expect(describeErrors({ errors: [] })).toBe('Unknown JSON:API error');
  });
});

describe('assertJsonApiDocument', () => {
  it('passes a well-formed single-resource document', () => {
    const document = assertJsonApiDocument({ data: { type: 'node--article', id: 'a-1' } });
    expect(document.data).toMatchObject({ id: 'a-1' });
  });

  it('passes a well-formed collection', () => {
    const document = assertJsonApiDocument({ data: [{ type: 'node--article', id: 'a-1' }] });
    expect(Array.isArray(document.data)).toBe(true);
  });

  it('passes an empty collection', () => {
    // No results is a legitimate answer, not a malformed one.
    expect(() => assertJsonApiDocument({ data: [] })).not.toThrow();
  });

  it('classifies an errors payload as api-error', () => {
    const error = (() => {
      try {
        assertJsonApiDocument({ errors: [{ title: 'Forbidden' }] });
      } catch (caught: unknown) {
        return caught;
      }
      return null;
    })();

    expect(error).toBeInstanceOf(DrupalResponseError);
    expect((error as DrupalResponseError).kind).toBe('api-error');
  });

  it('classifies null primary data as api-error, not malformed', () => {
    // `data: null` means "no such resource" — that should surface as a 404,
    // not as an alert about a broken CMS.
    expect(() => assertJsonApiDocument({ data: null })).toThrow(/resource not found/);
    try {
      assertJsonApiDocument({ data: null });
    } catch (caught: unknown) {
      expect((caught as DrupalResponseError).kind).toBe('api-error');
    }
  });

  it.each([
    ['a string body', 'not a document'],
    ['null', null],
    ['an array', []],
    ['a number', 42],
  ])('rejects %s as malformed', (_label, value) => {
    expect(() => assertJsonApiDocument(value)).toThrow(DrupalResponseError);
  });

  it('rejects a document with no data member', () => {
    expect(() => assertJsonApiDocument({ meta: {} })).toThrow(/no `data` member/);
  });

  it('names the index of a malformed collection item', () => {
    expect(() =>
      assertJsonApiDocument({
        data: [{ type: 'node--article', id: 'a-1' }, { type: 'node--article' }],
      }),
    ).toThrow(/index 1/);
  });

  it('rejects a non-array included member', () => {
    expect(() =>
      assertJsonApiDocument({ data: [], included: { type: 'x', id: 'y' } }),
    ).toThrow(/`included` is present but not an array/);
  });

  it('names the index of a malformed included item', () => {
    expect(() =>
      assertJsonApiDocument({ data: [], included: [{ type: 'media--image', id: 'm' }, {}] }),
    ).toThrow(/`included` item at index 1/);
  });

  it('accepts a document with no included array at all', () => {
    expect(() => assertJsonApiDocument({ data: [] })).not.toThrow();
  });

  it('carries the offending payload for diagnosis', () => {
    // A failure should be debuggable from the logs without reproducing it.
    try {
      assertJsonApiDocument({ meta: {} });
    } catch (caught: unknown) {
      expect((caught as DrupalResponseError).detail).toEqual(['meta']);
    }
  });
});

describe('assertSingleResource / assertCollection', () => {
  it('rejects a collection where a single resource was expected', () => {
    expect(() => assertSingleResource({ data: [] })).toThrow(/Expected a single resource/);
  });

  it('rejects a single resource where a collection was expected', () => {
    expect(() => assertCollection({ data: { type: 'node--article', id: 'a-1' } })).toThrow(
      /Expected a collection/,
    );
  });

  it('narrows a valid single resource', () => {
    expect(assertSingleResource({ data: { type: 'node--article', id: 'a-1' } }).data.id).toBe(
      'a-1',
    );
  });

  it('narrows a valid collection', () => {
    expect(assertCollection({ data: [{ type: 'node--article', id: 'a-1' }] }).data).toHaveLength(
      1,
    );
  });
});

describe('describeOmitted', () => {
  /**
   * The real shape, copied from a Drupal 11 response to
   * `/jsonapi/menu_link_content/menu_link_content` as an anonymous consumer.
   * HTTP 200, empty `data`, and the actual reason two levels deep in metadata.
   */
  const omittedResponse = {
    data: [],
    meta: {
      omitted: {
        detail: 'Some resources have been omitted because of insufficient authorization.',
        links: {
          help: { href: 'https://www.drupal.org/docs/8/modules/json-api/filtering' },
          'item--k6hAYrc': {
            href: 'https://cms.example.test/jsonapi/menu_link_content/menu_link_content/86f2',
            meta: {
              rel: 'item',
              detail:
                "The current user is not allowed to GET the selected resource. The 'administer menu' permission is required.",
            },
          },
        },
      },
    },
  };

  it('surfaces the permission that was actually missing', () => {
    // Without this, the symptom is "the navigation is empty" and there is
    // nothing in the status code, the payload shape or the logs to explain it.
    const reason = describeOmitted(omittedResponse);
    expect(reason).toContain('administer menu');
  });

  it('includes the summary detail alongside the specific reason', () => {
    expect(describeOmitted(omittedResponse)).toContain('insufficient authorization');
  });

  it('falls back to the summary when no per-item reason is given', () => {
    expect(
      describeOmitted({ data: [], meta: { omitted: { detail: 'Some were omitted.' } } }),
    ).toBe('Some were omitted.');
  });

  it('returns null for an ordinary successful response', () => {
    expect(describeOmitted({ data: [{ type: 'node--article', id: 'a-1' }] })).toBeNull();
  });

  it('returns null when meta carries no omitted block', () => {
    expect(describeOmitted({ data: [], meta: { count: 0 } })).toBeNull();
  });

  it.each([['null', null], ['a string', 'nope'], ['an array', []]])(
    'returns null for %s',
    (_label, value) => {
      expect(describeOmitted(value)).toBeNull();
    },
  );
});
