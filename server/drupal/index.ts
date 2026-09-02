/**
 * The one place that decides where content comes from.
 *
 * Server code asks for `useDrupal(event)` and gets a client. Whether that
 * client talks to a Drupal instance over HTTP or answers from committed
 * fixtures is settled here, by whether `NUXT_DRUPAL_BASE_URL` is set — and
 * nowhere else. No route, composable or component branches on it.
 *
 * That single switch is what makes `pnpm dev` work on a machine with no PHP
 * installed, and what lets CI exercise the real client, validators and mappers
 * without provisioning a CMS. Both modes run identical code above the socket.
 */
import { createDrupalClient, type DrupalClient } from './client.js';
import { createFixtureFetch, type FixtureSet } from './fixtures.js';
import articles from '../../fixtures/drupal/node--article.json' with { type: 'json' };
import type { JsonApiDocument } from './transport.js';

/** Which backend the current process is talking to. */
export type DrupalMode = 'live' | 'fixtures';

/**
 * The committed snapshot, assembled into the shape the fixture transport wants.
 *
 * Captured from a real Drupal instance by `scripts/snapshot-content.ts` — see
 * ADR-002 for why these are not written by hand.
 */
export const fixtureSet: FixtureSet = {
  collections: {
    'node/article': articles as unknown as JsonApiDocument,
    // No menu fixture: core JSON:API cannot expose menus to an anonymous
    // consumer without over-privileging it. See scripts/snapshot-content.ts.
  },
};

export interface DrupalRuntimeSettings {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

/**
 * `fixtures` unless a base URL is configured.
 *
 * Deliberately the safe default: a deployment that forgets to set
 * `NUXT_DRUPAL_BASE_URL` serves the sample content and is obviously wrong,
 * rather than erroring in a way that looks like an outage.
 */
export function resolveMode(settings: Pick<DrupalRuntimeSettings, 'baseUrl'>): DrupalMode {
  return settings.baseUrl.trim() ? 'live' : 'fixtures';
}

export interface CreateClientResult {
  client: DrupalClient;
  mode: DrupalMode;
}

/**
 * Build the client for the given settings.
 *
 * Exported separately from the Nitro-facing helper so tests can construct a
 * client without an H3 event.
 */
export function createClientForSettings(
  settings: DrupalRuntimeSettings,
): CreateClientResult {
  const mode = resolveMode(settings);

  if (mode === 'fixtures') {
    return {
      mode,
      client: createDrupalClient({
        // A placeholder origin: the fixture transport never opens a socket, but
        // the client refuses to be constructed without one, and that check is
        // worth keeping for the live path.
        baseUrl: 'https://fixtures.invalid',
        fetch: createFixtureFetch({ fixtures: fixtureSet }),
      }),
    };
  }

  return {
    mode,
    client: createDrupalClient({
      baseUrl: settings.baseUrl,
      ...(settings.token ? { token: settings.token } : {}),
      timeoutMs: settings.timeoutMs,
    }),
  };
}
