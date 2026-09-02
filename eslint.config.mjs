// @nuxt/eslint generates a base config that already knows about auto-imports,
// the app/ vs server/ split and Nuxt's globals. Extending it is what keeps the
// linter from fighting the framework; everything below is the delta.
import withNuxt from './.nuxt/eslint.config.mjs';
import prettier from 'eslint-config-prettier';

export default withNuxt(
  {
    ignores: [
      '.nuxt/**',
      '.output/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      'fixtures/**',
    ],
  },

  // Type-aware linting, scoped to plain TypeScript.
  //
  // The rules worth having here — no-explicit-any, no-floating-promises,
  // no-misused-promises — all need type information, which @nuxt/eslint does
  // not switch on by default. Enabling it costs a TS program per lint run, so
  // it is applied where the type-sensitive logic actually lives: the Drupal
  // client, the normalizer, the validators, the server routes.
  //
  // `.vue` files are deliberately excluded. Typed linting through
  // vue-eslint-parser is brittle for SFC templates, and it buys little here:
  // `pnpm typecheck` runs vue-tsc over every component, so SFCs are still
  // fully type-checked — just not by ESLint.
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The transport/domain split only holds if raw JSON:API payloads stay
      // `unknown` until they have been validated. `any` erases exactly that.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      // A dropped await against Drupal turns a failed request into a page that
      // renders as if nothing happened.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },

  {
    rules: {
      // Server code swallows a few failures on purpose — a cache write, a
      // telemetry ping. Every such site carries a comment explaining why, so
      // the ban is on the silent empty block, not on the pattern.
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },

  // Prettier owns formatting; turn off every rule that would argue with it.
  prettier,
);
