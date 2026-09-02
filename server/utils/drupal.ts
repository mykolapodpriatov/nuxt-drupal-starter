import type { H3Event } from 'h3';
import { createClientForSettings } from '../drupal';
import type { DrupalClient } from '../drupal/client';

/**
 * The client and the canonical site URL, for a request.
 *
 * Every route needs both and neither should be assembled by hand: reading
 * `runtimeConfig` per route is how one of them ends up with a different
 * timeout, and building image URLs against the wrong origin is how a staging
 * host leaks into production markup.
 */
export function useDrupal(event: H3Event): { client: DrupalClient; siteUrl: string } {
  const { drupal, public: publicConfig } = useRuntimeConfig(event);
  const { client } = createClientForSettings({
    baseUrl: drupal.baseUrl,
    token: drupal.token,
    timeoutMs: drupal.timeoutMs,
  });

  return {
    client,
    // Image URLs in fixture mode are already absolute against the placeholder
    // origin baked into the snapshot; in live mode Drupal returns site-relative
    // paths that have to be resolved against the CMS, not against the front
    // end. The base URL is the right origin in both cases.
    siteUrl: drupal.baseUrl || publicConfig.siteUrl,
  };
}
