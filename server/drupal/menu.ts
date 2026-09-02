/**
 * Reading Drupal's navigation.
 *
 * Menus are the one thing in this starter that does not come over JSON:API, and
 * the reason is worth stating because it looks like an omission otherwise.
 *
 * Core JSON:API does expose `menu_link_content` — but reading it requires the
 * `administer menu` permission, so an anonymous consumer gets HTTP 200, an
 * empty `data` array, and the explanation buried in `meta.omitted`. Granting an
 * API consumer `administer menu` to work around that hands it write access to
 * every menu on the site.
 *
 * And even with the permission the result would be wrong. JSON:API serves
 * *entities*, and only some menu links are entities: links defined in code by a
 * module — `standard.front_page`, the "Home" item on a stock Drupal — are
 * plugins, not `menu_link_content`, and never appear. A consumer would render a
 * navigation missing exactly the items nobody thought to check.
 *
 * So `drupal/modules/custom/nuxt_menu` serves an access-checked tree from
 * Drupal's own menu tree service, which is what the site's own menu blocks use.
 * Full reasoning in docs/adr/003-menu-endpoint.md.
 */
import type { MenuItem } from '../../shared/domain.js';

/** One item as `nuxt_menu` serialises it. */
interface MenuEndpointItem {
  id?: unknown;
  title?: unknown;
  url?: unknown;
  external?: unknown;
  description?: unknown;
  expanded?: unknown;
  children?: unknown;
}

/** The endpoint's response envelope. */
interface MenuEndpointResponse {
  menu?: unknown;
  items?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Map the endpoint's items into domain `MenuItem`s.
 *
 * The endpoint already nests and orders — that work belongs in Drupal, which
 * knows the weights and the access rules — so this is a shape translation, not
 * a tree build. It stays defensive anyway: the endpoint is a module that can be
 * out of date relative to this front end.
 *
 * An item with no usable title or URL is dropped rather than rendered as an
 * empty link, because an unlabelled navigation entry is worse than a missing
 * one. Its children are promoted, so a broken parent costs the menu its
 * nesting rather than a whole branch.
 */
export function toMenuItems(raw: unknown): MenuItem[] {
  if (!Array.isArray(raw)) return [];

  const items: MenuItem[] = [];

  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const item = entry as MenuEndpointItem;

    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    const children = toMenuItems(item.children);

    if (!title || !url) {
      // Promote the orphans: losing a label should not lose a branch.
      items.push(...children);
      continue;
    }

    items.push({
      id: typeof item.id === 'string' ? item.id : url,
      title,
      url,
      children,
    });
  }

  return items;
}

/** Fetch and map one menu. */
export async function fetchMenu(
  client: { getJson: (path: string) => Promise<unknown> },
  menuName: string,
): Promise<MenuItem[]> {
  const payload = await client.getJson(`/api/menu/${encodeURIComponent(menuName)}`);
  if (!isRecord(payload)) return [];
  return toMenuItems((payload as MenuEndpointResponse).items);
}
