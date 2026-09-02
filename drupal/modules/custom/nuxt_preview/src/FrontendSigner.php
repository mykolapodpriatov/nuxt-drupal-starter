<?php

declare(strict_types=1);

namespace Drupal\nuxt_preview;

use Drupal\Core\Site\Settings;

/**
 * Produces the signatures the front end verifies.
 *
 * Must stay byte-compatible with `server/utils/signature.ts`. The shared shape
 * is deliberately small — HMAC-SHA256, base64url, expiry inside the signed
 * message — precisely so two implementations in two languages can agree without
 * a shared library.
 *
 * Secrets come from `settings.php`, not from configuration. Configuration is
 * exported to code and committed; a secret in `config/sync` is a secret in git.
 */
final class FrontendSigner {

  public function __construct(private readonly Settings $settings) {}

  /** Base URL of the decoupled front end, without a trailing slash. */
  public function frontendUrl(): ?string {
    $url = (string) $this->settings->get('nuxt_frontend_url', '');
    return $url === '' ? NULL : rtrim($url, '/');
  }

  /**
   * Sign a payload with an expiry, in the format the front end expects:
   * `base64url(payload).expiry.base64url(hmac("payload:expiry"))`.
   *
   * The expiry is part of the signed message rather than merely adjacent to it,
   * so the holder of a link cannot extend its life by editing the plain
   * component.
   */
  public function token(string $payload, string $secretKey, int $ttlSeconds): ?string {
    $secret = (string) $this->settings->get($secretKey, '');
    if ($secret === '') {
      return NULL;
    }

    $expiresAt = \Drupal::time()->getRequestTime() + $ttlSeconds;
    $signature = hash_hmac('sha256', $payload . ':' . $expiresAt, $secret, TRUE);

    return sprintf(
      '%s.%d.%s',
      self::base64Url($payload),
      $expiresAt,
      self::base64Url($signature),
    );
  }

  /** Sign a raw request body, for the revalidation webhook. */
  public function bodySignature(string $rawBody): ?string {
    $secret = (string) $this->settings->get('nuxt_revalidate_secret', '');
    if ($secret === '') {
      return NULL;
    }
    return self::base64Url(hash_hmac('sha256', $rawBody, $secret, TRUE));
  }

  /**
   * Base64url without padding — the encoding Node's `base64url` produces, and
   * the one that survives a query string without escaping.
   */
  private static function base64Url(string $value): string {
    return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
  }

}
