import { describe, expect, it, vi } from 'vitest';
import { fetchMenu, toMenuItems } from '../server/drupal/menu.js';
import { createClientForSettings, fixtureSet } from '../server/drupal/index.js';

describe('toMenuItems', () => {
  it('maps a flat list', () => {
    const items = toMenuItems([
      { id: 'a', title: 'Articles', url: '/articles', children: [] },
      { id: 'b', title: 'Contact', url: '/contact', children: [] },
    ]);
    expect(items.map((item) => item.title)).toEqual(['Articles', 'Contact']);
  });

  it('preserves nesting built by the endpoint', () => {
    // Ordering and nesting are Drupal's job — it knows the weights and the
    // access rules. This is a shape translation, not a tree build.
    const items = toMenuItems([
      {
        id: 'about',
        title: 'About',
        url: '/about',
        children: [{ id: 'team', title: 'Our team', url: '/about/team', children: [] }],
      },
    ]);
    expect(items[0]?.children[0]?.title).toBe('Our team');
  });

  it('nests to arbitrary depth', () => {
    const items = toMenuItems([
      {
        id: 'a',
        title: 'A',
        url: '/a',
        children: [
          {
            id: 'b',
            title: 'B',
            url: '/a/b',
            children: [{ id: 'c', title: 'C', url: '/a/b/c', children: [] }],
          },
        ],
      },
    ]);
    expect(items[0]?.children[0]?.children[0]?.title).toBe('C');
  });

  it('drops an item with no title but keeps its children', () => {
    // An unlabelled navigation entry is worse than a missing one, but losing a
    // label should not cost a whole branch.
    const items = toMenuItems([
      {
        id: 'broken',
        title: '',
        url: '/broken',
        children: [{ id: 'kept', title: 'Kept', url: '/kept', children: [] }],
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Kept');
  });

  it('drops an item with no URL', () => {
    expect(toMenuItems([{ id: 'a', title: 'No link', url: '', children: [] }])).toEqual([]);
  });

  it('treats a whitespace-only title as missing', () => {
    expect(toMenuItems([{ id: 'a', title: '   ', url: '/a', children: [] }])).toEqual([]);
  });

  it('falls back to the URL when the endpoint omits an id', () => {
    // The id only has to be unique enough for a `:key`; the URL always is.
    expect(toMenuItems([{ title: 'A', url: '/a' }])[0]?.id).toBe('/a');
  });

  it('defaults missing children to an empty array', () => {
    // Templates iterate `item.children` unconditionally, so it is never
    // optional in the domain model.
    expect(toMenuItems([{ id: 'a', title: 'A', url: '/a' }])[0]?.children).toEqual([]);
  });

  it.each([
    ['a non-array payload', { items: [] }],
    ['null', null],
    ['a string', 'nope'],
    ['undefined', undefined],
  ])('returns an empty list for %s', (_label, value) => {
    expect(toMenuItems(value)).toEqual([]);
  });

  it('skips non-object entries', () => {
    expect(toMenuItems([null, 'x', 42, { id: 'a', title: 'A', url: '/a' }])).toHaveLength(1);
  });
});

describe('fetchMenu', () => {
  it('requests the endpoint for the named menu', async () => {
    const getJson = vi.fn(() => Promise.resolve({ menu: 'footer', items: [] }));
    await fetchMenu({ getJson }, 'footer');
    expect(getJson).toHaveBeenCalledWith('/api/menu/footer');
  });

  it('encodes the menu name', async () => {
    const getJson = vi.fn(() => Promise.resolve({ items: [] }));
    await fetchMenu({ getJson }, 'main menu');
    expect(getJson).toHaveBeenCalledWith('/api/menu/main%20menu');
  });

  it('returns an empty list when the endpoint answers with nothing usable', async () => {
    const getJson = vi.fn(() => Promise.resolve('not an object'));
    await expect(fetchMenu({ getJson }, 'main')).resolves.toEqual([]);
  });

  it('propagates a transport failure to the caller', async () => {
    // The server route decides whether an unreachable menu is fatal; the mapper
    // does not get to swallow it silently.
    const getJson = vi.fn(() => Promise.reject(new Error('offline')));
    await expect(fetchMenu({ getJson }, 'main')).rejects.toThrow('offline');
  });
});

/**
 * The captured menu, run through the same path the application uses.
 *
 * Worth asserting rather than assuming, because this fixture proves something
 * the JSON:API route could not have: it contains `standard.front_page`, a menu
 * link defined in code by a module rather than stored as a `menu_link_content`
 * entity. JSON:API serves entities, so that link — the "Home" item on a stock
 * Drupal — is invisible to it entirely. A consumer reading `menu_link_content`
 * would render a navigation quietly missing items nobody thought to check.
 */
describe('captured menu fixture', () => {
  it('is served through the fixture transport', async () => {
    const { client } = createClientForSettings({ baseUrl: '', token: '', timeoutMs: 5000 });
    const items = await fetchMenu(client, 'main');
    expect(items.length).toBeGreaterThan(0);
  });

  it('includes a code-defined link that JSON:API cannot expose', () => {
    const captured = fixtureSet.raw?.['/api/menu/main'];
    const items = toMenuItems((captured as { items?: unknown }).items);
    const ids = items.map((item) => item.id);
    expect(ids.some((id) => !id.startsWith('menu_link_content:'))).toBe(true);
  });

  it('preserves the hierarchy an editor built', () => {
    const captured = fixtureSet.raw?.['/api/menu/main'];
    const items = toMenuItems((captured as { items?: unknown }).items);
    expect(items.some((item) => item.children.length > 0)).toBe(true);
  });

  it('gives every item a usable href and a non-empty label', () => {
    const captured = fixtureSet.raw?.['/api/menu/main'];
    const walk = (items: ReturnType<typeof toMenuItems>): void => {
      for (const item of items) {
        expect(item.title.length).toBeGreaterThan(0);
        expect(item.url.length).toBeGreaterThan(0);
        walk(item.children);
      }
    };
    walk(toMenuItems((captured as { items?: unknown }).items));
  });

  it('leaks no hostname from the capturing machine', () => {
    const serialized = JSON.stringify(fixtureSet.raw?.['/api/menu/main']);
    expect(serialized).not.toMatch(/ddev\.site|127\.0\.0\.1|localhost/);
  });
});
