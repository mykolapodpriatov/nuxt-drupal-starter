import { describe, expect, it } from 'vitest';
import config from '../nuxt.config';

/**
 * The single rule this starter cannot afford to get wrong: nothing that
 * authenticates against Drupal may reach the browser.
 *
 * Nuxt keeps top-level `runtimeConfig` keys server-only and exposes everything
 * under `runtimeConfig.public` to the client bundle. That boundary is one
 * indentation level wide — moving `token` two spaces to the right ships a
 * credential to every visitor, and nothing in the type system objects.
 *
 * So it is asserted instead of assumed. A build-output scan in PR 6 checks the
 * emitted bundle as well; this catches the mistake at the config level, where
 * the failure message actually names the offending key.
 */
describe('runtime config boundary', () => {
  const publicConfig = config.runtimeConfig?.public ?? {};
  const publicKeys = Object.keys(publicConfig);

  it('keeps every Drupal setting server-side', () => {
    expect(publicKeys).not.toContain('drupal');
  });

  it('exposes no key whose name suggests a credential', () => {
    const serialized = JSON.stringify(publicConfig).toLowerCase();
    for (const forbidden of ['token', 'secret', 'password', 'apikey', 'api_key']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('declares the Drupal settings the server code depends on', () => {
    // Guards against a rename silently turning a configured value into
    // `undefined` at runtime, which would look like "Drupal is down".
    expect(config.runtimeConfig?.drupal).toMatchObject({
      baseUrl: expect.any(String),
      token: expect.any(String),
      previewSecret: expect.any(String),
      revalidateSecret: expect.any(String),
      timeoutMs: expect.any(Number),
    });
  });

  it('ships no real credentials in the committed defaults', () => {
    // The defaults must be empty strings: a value here would be a secret in
    // git history, and would also mask a missing environment variable.
    const drupal = config.runtimeConfig?.drupal as Record<string, unknown>;
    expect(drupal.baseUrl).toBe('');
    expect(drupal.token).toBe('');
    expect(drupal.previewSecret).toBe('');
    expect(drupal.revalidateSecret).toBe('');
  });
});

/**
 * Preview renders unpublished, editor-only content. Caching it at any TTL
 * risks handing a draft to the public, so the route rules are asserted rather
 * than left to review discipline.
 */
describe('route rules', () => {
  const rules = config.routeRules ?? {};

  it('never caches preview responses', () => {
    const preview = rules['/preview/**'];
    expect(preview?.headers?.['cache-control']).toBe('no-store');
    expect(preview).not.toHaveProperty('swr');
    expect(preview).not.toHaveProperty('isr');
  });

  it('keeps preview out of search results', () => {
    expect(rules['/preview/**']?.headers?.['x-robots-tag']).toContain('noindex');
  });

  it('revalidates editorial routes in the background', () => {
    expect(rules['/articles/**']?.swr).toBeTypeOf('number');
  });
});
