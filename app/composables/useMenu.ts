import type { MenuItem } from '../../shared/domain';

/**
 * Load a Drupal menu.
 *
 * `useFetch` rather than a plain fetch so the request happens during SSR and
 * the result is serialised into the payload — navigation that only appears
 * after hydration is a layout shift on every page load, and it is invisible to
 * a crawler.
 *
 * Keyed by menu name so two components asking for the same menu share one
 * request instead of racing.
 */
export function useMenu(name = 'main') {
  return useFetch<{ items: MenuItem[] }>(`/api/menu/${name}`, {
    key: `menu-${name}`,
    // An unreachable menu must not blank the page: the layout renders whatever
    // this resolves to, and an empty list is a site with no navigation rather
    // than a site that failed.
    default: () => ({ items: [] }),
  });
}
