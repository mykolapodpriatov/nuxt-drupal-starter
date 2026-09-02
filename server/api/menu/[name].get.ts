import { fetchMenu } from '../../drupal/menu';
import { createClientForSettings } from '../../drupal';

/**
 * Serve one Drupal menu to the browser.
 *
 * The route exists so the browser never talks to Drupal directly. Everything
 * that authenticates against the CMS — base URL, bearer token — stays in
 * server-only runtime config, and the client sees a small stable shape instead
 * of whatever the backend happens to serve today.
 *
 * A failure here is deliberately not fatal. A site whose navigation cannot be
 * loaded should still render its content, so the route answers with an empty
 * menu and logs the reason rather than turning a menu outage into a 500 on
 * every page of the site.
 */
export default defineCachedEventHandler(
  async (event) => {
    const name = getRouterParam(event, 'name') ?? 'main';
    const { drupal } = useRuntimeConfig(event);

    const { client } = createClientForSettings({
      baseUrl: drupal.baseUrl,
      token: drupal.token,
      timeoutMs: drupal.timeoutMs,
    });

    try {
      return { items: await fetchMenu(client, name) };
    } catch (error: unknown) {
      console.error(
        `[menu] could not load "${name}":`,
        error instanceof Error ? error.message : error,
      );
      return { items: [] };
    }
  },
  {
    // Menus change rarely and are read on every page, which makes them the
    // clearest caching win in the app. The TTL is short enough that an
    // editor's change appears without a deploy; the invalidation webhook in a
    // later pull request makes it appear immediately.
    maxAge: 300,
    name: 'drupal-menu',
    getKey: (event) => getRouterParam(event, 'name') ?? 'main',
  },
);
