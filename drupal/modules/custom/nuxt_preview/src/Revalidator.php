<?php

declare(strict_types=1);

namespace Drupal\nuxt_preview;

use Drupal\Core\Logger\LoggerChannelFactoryInterface;
use Drupal\Core\Site\Settings;
use Drupal\node\NodeInterface;
use GuzzleHttp\ClientInterface;
use GuzzleHttp\Exception\GuzzleException;

/**
 * Tells the front end which paths to drop from its cache.
 *
 * Without this the choice is between stale pages and no caching at all. The
 * front end's `swr` rules mean an editor's change appears within the TTL; this
 * makes it appear immediately, which is the difference between a CMS that feels
 * live and one that feels broken.
 *
 * Three properties matter more than the mechanism:
 *
 * - **A failure here must never block a save.** An editor pressing Save is not
 *   responsible for the front end being reachable. Every failure is logged and
 *   swallowed; the worst case is a page that stays cached for its normal TTL.
 * - **The request is signed**, so the endpoint can be public without handing
 *   the internet a cache-eviction primitive.
 * - **Both the old and new paths are purged.** Changing an alias leaves the old
 *   URL cached and serving content that has moved, which is the failure nobody
 *   tests for.
 */
final class Revalidator {

  public function __construct(
    private readonly ClientInterface $httpClient,
    private readonly Settings $settings,
    private readonly LoggerChannelFactoryInterface $loggerFactory,
    private readonly FrontendSigner $signer,
  ) {}

  /**
   * Purge the front end's cache for a node's paths.
   *
   * @param string[] $extraPaths
   *   Paths beyond the node's own — the previous alias when it changed, and the
   *   listings the node appears on.
   */
  public function revalidateNode(NodeInterface $node, array $extraPaths = []): void {
    $frontend = $this->signer->frontendUrl();
    if ($frontend === NULL) {
      // Not configured is not an error: a Drupal instance with no decoupled
      // front end in front of it is a perfectly ordinary Drupal instance.
      return;
    }

    $paths = array_values(array_unique(array_filter(array_merge(
      [
        // The listings the article appears on go stale the moment it is saved,
        // not only when its own page changes.
        '/',
        '/articles',
        $node->toUrl()->toString(),
      ],
      $extraPaths,
    ))));

    $body = json_encode(['paths' => $paths], JSON_UNESCAPED_SLASHES);
    if ($body === FALSE) {
      return;
    }

    $signature = $this->signer->bodySignature($body);
    if ($signature === NULL) {
      $this->logger()->warning(
        'Skipping revalidation: nuxt_revalidate_secret is not set in settings.php.',
      );
      return;
    }

    try {
      $this->httpClient->request('POST', $frontend . '/api/revalidate', [
        'headers' => [
          'Content-Type' => 'application/json',
          'X-Drupal-Signature' => $signature,
        ],
        'body' => $body,
        // A slow front end must not hold an editor's save open. Two seconds is
        // generous for a local cache eviction and short enough to be invisible.
        'timeout' => 2,
        'connect_timeout' => 2,
        // A non-2xx is information to log, not an exception to propagate into
        // the save pipeline.
        'http_errors' => FALSE,
      ]);
    }
    catch (GuzzleException $e) {
      // Deliberately swallowed. An unreachable front end is an operational
      // problem, not a reason to refuse an editor's edit.
      $this->logger()->warning('Revalidation request failed: @message', [
        '@message' => $e->getMessage(),
      ]);
    }
  }

  private function logger(): \Psr\Log\LoggerInterface {
    return $this->loggerFactory->get('nuxt_preview');
  }

}
