<?php

declare(strict_types=1);

namespace Drupal\nuxt_router\Controller;

use Drupal\Core\Cache\CacheableJsonResponse;
use Drupal\Core\Cache\CacheableMetadata;
use Drupal\Core\Controller\ControllerBase;
use Drupal\Core\Entity\EntityInterface;
use Drupal\Core\Entity\EntityRepositoryInterface;
use Drupal\Core\Url;
use Drupal\path_alias\AliasManagerInterface;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\RequestStack;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Resolves a public URL path to the entity behind it.
 *
 * Drupal owns the site's URL structure: an editor sets an alias and an article
 * lives at `/blog/hello`. A decoupled front end therefore cannot route by
 * pattern — it has to ask what is at a given path.
 *
 * JSON:API cannot answer that. `path` is a *computed* field, so filtering on it
 * is not merely unsupported, it errors:
 *
 * ```
 * GET /jsonapi/node/article?filter[path.alias]=/blog/hello
 * → 500  "'path' not found"
 *
 * GET /jsonapi/node/article?filter[path][alias]=/blog/hello
 * → 400  "You must provide a valid filter condition."
 * ```
 *
 * `drupal/decoupled_router` is the usual answer and, like
 * `jsonapi_menu_items`, has no stable Drupal 11 release. This does the same job
 * in about fifty lines, using Drupal's own alias manager and router — which
 * means aliases, redirects to canonical paths and language prefixes all behave
 * the way they do for the site itself, rather than the way a regex would.
 *
 * The response deliberately carries only an identity — entity type, bundle and
 * UUID. The front end then requests the entity over JSON:API as normal, so
 * there is exactly one code path that turns a Drupal resource into a domain
 * model, and this endpoint does not become a second, divergent serialiser.
 */
final class PathResolveController extends ControllerBase {

  public function __construct(
    private readonly AliasManagerInterface $aliasManager,
    private readonly EntityRepositoryInterface $entityRepository,
    private readonly RequestStack $requestStack,
  ) {}

  /**
   * {@inheritdoc}
   *
   * The language manager is not injected: `ControllerBase` already declares a
   * `$languageManager` property, and a promoted readonly property of the same
   * name is a fatal error rather than an override. Its `languageManager()`
   * accessor is used instead.
   */
  public static function create(ContainerInterface $container): self {
    return new self(
      $container->get('path_alias.manager'),
      $container->get('entity.repository'),
      $container->get('request_stack'),
    );
  }

  /**
   * Answer "what is at this path".
   */
  public function resolve(): CacheableJsonResponse {
    $requested = (string) ($this->requestStack->getCurrentRequest()?->query->get('path') ?? '');
    if ($requested === '') {
      throw new NotFoundHttpException('A path query parameter is required.');
    }

    // Half of Drupal's aliases are stored with a leading slash and half are
    // requested without one.
    $alias = str_starts_with($requested, '/') ? $requested : '/' . $requested;

    $cacheability = new CacheableMetadata();
    // The answer depends on the alias table and on who is asking.
    $cacheability->addCacheContexts(['url.query_args:path', 'user.permissions']);

    $langcode = $this->languageManager()->getCurrentLanguage()->getId();
    $internal = $this->aliasManager->getPathByAlias($alias, $langcode);

    // `getPathByAlias` returns its input unchanged when nothing matches, which
    // is also what it returns for a path that was never aliased. Either way the
    // internal path is what the router has to be asked about.
    $entity = $this->entityForPath($internal);

    if ($entity === NULL) {
      $response = new CacheableJsonResponse(['found' => FALSE], 404);
      $response->addCacheableDependency($cacheability);
      return $response;
    }

    // The entity's own access rules decide whether this path exists *for this
    // user*. Without the check, an unpublished node's alias would confirm that
    // the node exists — a small leak, but a real one.
    $access = $entity->access('view', NULL, TRUE);
    $cacheability->addCacheableDependency($access);
    $cacheability->addCacheableDependency($entity);

    if (!$access->isAllowed()) {
      $response = new CacheableJsonResponse(['found' => FALSE], 404);
      $response->addCacheableDependency($cacheability);
      return $response;
    }

    $response = new CacheableJsonResponse([
      'found' => TRUE,
      'entity' => [
        'type' => $entity->getEntityTypeId(),
        'bundle' => $entity->bundle(),
        'uuid' => $entity->uuid(),
        // The JSON:API resource type, so the consumer does not have to
        // reconstruct Drupal's `entity--bundle` convention itself.
        'resourceType' => $entity->getEntityTypeId() . '--' . $entity->bundle(),
        'langcode' => $langcode,
      ],
    ]);
    $response->addCacheableDependency($cacheability);

    return $response;
  }

  /**
   * Load the entity an internal path points at, if any.
   *
   * Uses the router rather than pattern-matching `/node/12`: a site can route
   * taxonomy terms, users, media and custom entities, and each has its own
   * canonical route parameter.
   */
  private function entityForPath(string $internal): ?EntityInterface {
    try {
      $url = Url::fromUri('internal:' . $internal);
      if (!$url->isRouted()) {
        return NULL;
      }
      $parameters = $url->getRouteParameters();
    }
    catch (\Exception) {
      // An unroutable or malformed path is a 404, not a 500 — a crawler
      // requesting nonsense must not page anybody.
      return NULL;
    }

    // A canonical entity route has exactly one parameter, named after the
    // entity type: `entity.node.canonical` carries `node`.
    foreach ($parameters as $entityTypeId => $id) {
      if (!$this->entityTypeManager()->hasDefinition($entityTypeId)) {
        continue;
      }
      $entity = $this->entityTypeManager()
        ->getStorage($entityTypeId)
        ->load((string) $id);

      if ($entity instanceof EntityInterface) {
        // Return the translation matching the current language, so a resolved
        // path on a multilingual site does not answer with the source language.
        return $this->entityRepository->getTranslationFromContext($entity);
      }
    }

    return NULL;
  }

}
