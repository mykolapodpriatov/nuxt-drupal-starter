<?php

declare(strict_types=1);

namespace Drupal\nuxt_menu\Controller;

use Drupal\Core\Cache\CacheableJsonResponse;
use Drupal\Core\Cache\CacheableMetadata;
use Drupal\Core\Controller\ControllerBase;
use Drupal\Core\Menu\MenuLinkTreeElement;
use Drupal\Core\Menu\MenuLinkTreeInterface;
use Drupal\Core\Menu\MenuTreeParameters;
use Drupal\Core\Url;
use Symfony\Component\DependencyInjection\ContainerInterface;

/**
 * Serves a menu as a nested, access-checked tree for a decoupled front end.
 *
 * Core's JSON:API exposes `menu_link_content`, but reading it requires the
 * `administer menu` permission. An anonymous consumer therefore gets HTTP 200,
 * an empty `data` array, and the explanation buried in `meta.omitted` — the
 * quietest failure the API has. The symptom is an empty navigation with nothing
 * in the status code or the logs to suggest a permission problem.
 *
 * Granting an API consumer `administer menu` to work around it would hand that
 * consumer write access to every menu on the site. That is a very large trade
 * for the ability to render a list of links.
 *
 * This endpoint is the narrow alternative:
 *
 * - **Read-only.** GET only; there is no write path to secure.
 * - **`access content`**, the permission a site already grants anonymous users
 *   to read published nodes. Reading navigation is the same class of operation.
 * - **Access-checked per link.** The menu tree service applies each link's own
 *   access rules, so a link to a node the current user cannot view does not
 *   appear. Reading `menu_link_content` entities directly would not do this.
 * - **Only the links core would render.** Disabled links are excluded by the
 *   tree parameters, exactly as they are for the site's own menu blocks.
 *
 * The response carries cacheability metadata, so Drupal's page cache and the
 * front end's cache invalidation both work: editing a menu invalidates the
 * `config:system.menu.<name>` tag and the next request re-renders.
 */
final class MenuTreeController extends ControllerBase {

  public function __construct(
    private readonly MenuLinkTreeInterface $menuTree,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container): self {
    return new self($container->get('menu.link_tree'));
  }

  /**
   * Return the tree for one menu.
   *
   * @param string $menu
   *   Machine name of the menu, e.g. `main`.
   */
  public function tree(string $menu): CacheableJsonResponse {
    $parameters = new MenuTreeParameters();
    // Disabled links never render on the site itself, so they must not reach a
    // consumer that is meant to mirror the site's navigation.
    $parameters->onlyEnabledLinks();

    $tree = $this->menuTree->load($menu, $parameters);

    // `checkAccess` is the manipulator that makes this endpoint safe: it runs
    // each link's own access callback, so a link pointing at a node the current
    // user cannot view is filtered out. `generateIndexAndSort` applies the
    // editorial weight ordering.
    $tree = $this->menuTree->transform($tree, [
      ['callable' => 'menu.default_tree_manipulators:checkAccess'],
      ['callable' => 'menu.default_tree_manipulators:generateIndexAndSort'],
    ]);

    $cacheability = new CacheableMetadata();
    // Editing the menu must invalidate this response. Without the config tag a
    // decoupled front end serves the old navigation until its own TTL expires.
    $cacheability->addCacheTags(['config:system.menu.' . $menu]);
    // The tree is access-filtered, so two users can legitimately see different
    // links. Varying by permissions keeps one user's tree out of another's.
    $cacheability->addCacheContexts(['user.permissions', 'route.menu_active_trails:' . $menu]);

    $items = $this->buildItems($tree, $cacheability);

    $response = new CacheableJsonResponse([
      'menu' => $menu,
      'items' => $items,
    ]);
    $response->addCacheableDependency($cacheability);

    return $response;
  }

  /**
   * Convert menu tree elements into plain nested arrays.
   *
   * @param array<string, MenuLinkTreeElement> $tree
   *   The transformed menu tree.
   * @param \Drupal\Core\Cache\CacheableMetadata $cacheability
   *   Collects the cacheability of every URL generated along the way.
   *
   * @return array<int, array<string, mixed>>
   *   Items in editorial order, each with a nested `children` array.
   */
  private function buildItems(array $tree, CacheableMetadata $cacheability): array {
    $items = [];

    foreach ($tree as $element) {
      $link = $element->link;

      $url = $link->getUrlObject();
      // Generating the URL can attach cache metadata of its own — a path alias,
      // for instance, whose change must invalidate this response too.
      $generated = $url->toString(TRUE);
      $cacheability->addCacheableDependency($generated);

      $items[] = [
        'id' => $link->getPluginId(),
        'title' => (string) $link->getTitle(),
        // Already resolved to something usable in an `href`: an internal path
        // for routed links, the absolute URL for external ones. The front end
        // should not have to understand Drupal's `internal:` / `entity:` URI
        // scheme.
        'url' => $generated->getGeneratedUrl(),
        'external' => $url->isExternal(),
        'description' => (string) $link->getDescription(),
        // Whether the editor asked for this item to be expanded by default.
        'expanded' => $link->isExpanded(),
        'children' => $element->subtree
          ? $this->buildItems($element->subtree, $cacheability)
          : [],
      ];
    }

    return $items;
  }

}
