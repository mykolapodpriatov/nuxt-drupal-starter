import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Scan the built client bundle for anything that should never have left the
 * server.
 *
 * `test/runtime-config.spec.ts` asserts the *intent* — that no Drupal setting
 * appears under `runtimeConfig.public`. This asserts the *outcome*, against the
 * bytes actually shipped to a browser, because the two can diverge:
 *
 * - a component reading `useRuntimeConfig().drupal` instead of `.public` gets
 *   the value inlined at build time;
 * - a `server/` module imported from `app/` drags its constants into the client
 *   chunk;
 * - a value interpolated into a template literal survives even when the import
 *   that produced it is tree-shaken away.
 *
 * None of these produce a type error, a lint warning or a failed build. They
 * produce a credential in a JavaScript file on a CDN.
 *
 * Run from its own config (`vitest.scan.config.ts`) in the `build` CI job,
 * after there is something to inspect. It is deliberately not part of the main
 * suite: run without a build it would find no files and every assertion would
 * pass vacuously, which reads on a green CI as coverage that does not exist.
 *
 * For the same reason a missing bundle is a failure here, not a skip.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Where Nuxt writes the client bundle. */
const CLIENT_DIRS = [
  join(ROOT, '.output/public/_nuxt'),
  join(ROOT, 'node_modules/.cache/nuxt/.nuxt/dist/client/_nuxt'),
];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Every file under `dir`, recursively. */
async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
}

async function clientFiles(): Promise<string[]> {
  for (const dir of CLIENT_DIRS) {
    if (await exists(dir)) return (await walk(dir)).filter((f) => /\.(js|mjs|css)$/.test(f));
  }
  return [];
}

describe('built client bundle', () => {
  it('exists — without it every assertion below is vacuous', async () => {
    const files = await clientFiles();
    expect(
      files.length,
      'No client bundle found. Run `pnpm build` before `pnpm test:scan`.',
    ).toBeGreaterThan(0);
  });

  /**
   * Names of server-only runtime config keys.
   *
   * Nuxt inlines `runtimeConfig` values reachable from client code at build
   * time, so the *key name* appearing in a chunk means the object was reached
   * from the client — which is the mistake, whether or not the value was set.
   */
  it('contains no server-only runtime config keys', async () => {
    const files = await clientFiles();
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const key of ['previewSecret', 'revalidateSecret']) {
        if (source.includes(key)) offenders.push(`${file}: ${key}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('contains no environment variable names for secrets', async () => {
    const files = await clientFiles();
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const name of [
        'NUXT_DRUPAL_TOKEN',
        'NUXT_DRUPAL_PREVIEW_SECRET',
        'NUXT_DRUPAL_REVALIDATE_SECRET',
      ]) {
        if (source.includes(name)) offenders.push(`${file}: ${name}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('contains no Authorization header construction', async () => {
    // The client talks to this app's own server routes, never to Drupal, so
    // nothing in the browser has any reason to build a bearer header. If one
    // appears, a server module has been imported from `app/`.
    const files = await clientFiles();
    const offenders = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (/Bearer\s*\$\{|["'`]Bearer /.test(source)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });

  it('contains no JSON:API paths — the browser never talks to Drupal directly', async () => {
    // Every Drupal call goes through a server route. A `/jsonapi/` string in a
    // client chunk means that boundary was crossed.
    const files = await clientFiles();
    const offenders = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (source.includes('/jsonapi/')) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });

  it('contains no development secrets from the reference backend', async () => {
    // `drupal/setup.sh` writes these into settings.php. They are development
    // values, but a test that catches them would also catch a real one that
    // reached the same place.
    const files = await clientFiles();
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const secret of ['test-preview-secret', 'test-revalidate-secret']) {
        if (source.includes(secret)) offenders.push(`${file}: ${secret}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
