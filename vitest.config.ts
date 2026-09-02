import { defineVitestConfig } from '@nuxt/test-utils/config';

export default defineVitestConfig({
  test: {
    globals: true,
    include: ['test/**/*.spec.ts'],
    // Most of this repo's logic is plain functions over JSON:API payloads —
    // the normalizer, the validators, the cache key. Those run far faster in
    // node than in a DOM, so the Nuxt environment is opted into per file via
    // `// @vitest-environment nuxt` instead of being the global default.
    environment: 'node',
    // `@nuxt/test-utils` registers `test/nuxt/**` as a second Vitest project
    // and treats *every* file there as a test — a stray `.gitkeep` or
    // `README.md` fails the run. Keep that directory free of non-spec files.
    coverage: {
      provider: 'v8',
      include: ['server/**/*.ts', 'shared/**/*.ts', 'app/composables/**/*.ts'],
      reporter: ['text', 'lcov'],
    },
  },
});
