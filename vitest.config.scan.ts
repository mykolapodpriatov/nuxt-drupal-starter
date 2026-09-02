import { defineConfig } from 'vitest/config';

/**
 * The build-output scan, which needs a built bundle to inspect.
 *
 * A separate config rather than an entry in the main suite: run without a
 * build, the scan finds no files and every assertion passes vacuously — which
 * reads on a green CI as coverage that does not exist. Isolating it means it
 * runs exactly once, in the `build` job, after there is something to look at,
 * and it fails outright if there is not.
 *
 * Named `vitest.config.scan.ts` rather than `vitest.scan.config.ts` so it
 * matches the `../vitest.config.*` glob in Nuxt's generated node tsconfig —
 * otherwise it belongs to no TypeScript project and type-aware linting cannot
 * parse it.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/build-output.scan.ts'],
  },
});
