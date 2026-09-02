import { defineNuxtConfig } from 'nuxt/config';

/**
 * Two things in here are worth reading rather than skimming.
 *
 * `runtimeConfig`: everything Drupal-related lives at the top level, which
 * Nuxt keeps server-only. Nothing about the backend — base URL, client id,
 * secret, preview key — is exposed under `public`, so none of it can end up in
 * the client bundle. A test asserts this rather than trusting the convention.
 *
 * `routeRules`: content pages are cached and revalidated in the background;
 * preview must never be. See docs/adr/003 for why preview is forced to plain
 * SSR instead of being cached with a short TTL.
 */
export default defineNuxtConfig({
  compatibilityDate: '2026-09-02',

  modules: ['@nuxt/eslint', '@nuxt/test-utils/module'],

  future: { compatibilityVersion: 4 },

  typescript: {
    strict: true,
    // Typechecking runs as its own parallel CI job (`pnpm typecheck`), so the
    // dev server and the build stay fast.
    typeCheck: false,
    tsConfig: {
      compilerOptions: {
        // `strict: true` alone leaves the three checks that actually catch
        // bugs in this codebase switched off. Indexing into a JSON:API
        // `included` array returns `T | undefined`, and an optional field that
        // is *absent* is not the same as one explicitly set to `undefined` —
        // a distinction that matters when mapping Drupal resources.
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        useUnknownInCatchVariables: true,
        noImplicitOverride: true,
        noImplicitReturns: true,
        noFallthroughCasesInSwitch: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
      },
    },
  },

  eslint: {
    config: {
      // Formatting is Prettier's job, so the stylistic rule set stays off.
      stylistic: false,
      // `standalone: false` would mean "I bring my own typescript-eslint and
      // eslint-plugin-vue base configs". We want Nuxt's, so this stays true
      // (the default) — otherwise rule overrides below reference plugins that
      // no config object owns, and ESLint refuses to start.
      standalone: true,
    },
  },

  runtimeConfig: {
    drupal: {
      /**
       * Base URL of the Drupal site, e.g. `https://cms.example.com`.
       * Left empty on purpose: with no value the app serves the committed
       * fixture snapshot, so the repository can be evaluated with no backend
       * at all. See docs/adr/002.
       */
      baseUrl: '',
      /** Optional bearer token for authenticated JSON:API reads. */
      token: '',
      /** Shared secret the preview link is signed with. */
      previewSecret: '',
      /** Shared secret Drupal signs cache-invalidation webhooks with. */
      revalidateSecret: '',
      /** Per-request timeout in milliseconds for calls to Drupal. */
      timeoutMs: 10_000,
    },
    public: {
      /** Canonical front-end origin — used for SEO tags and sitemap URLs. */
      siteUrl: 'http://localhost:3000',
    },
  },

  routeRules: {
    // Editorial content: serve from cache, revalidate in the background.
    // `swr` is Nuxt's own terminology — this is not Next.js ISR, and calling
    // it that in the docs would be wrong.
    '/': { swr: 600 },
    '/articles': { swr: 600 },
    '/articles/**': { swr: 3600 },
    // Preview renders unpublished content for one authenticated editor.
    // Caching it, at any TTL, risks serving a draft to the public.
    '/preview/**': {
      ssr: true,
      headers: {
        'cache-control': 'no-store',
        // Keep drafts out of search indexes. `X-Robots-Tag` is the mechanism
        // itself rather than a module option, so it works with no extra
        // dependency and applies to non-HTML responses too.
        'x-robots-tag': 'noindex, nofollow',
      },
    },
    '/api/**': { headers: { 'cache-control': 'no-store' } },
  },

  nitro: {
    // Nothing is prerendered, deliberately.
    //
    // A prerendered route is served by the static handler, so Nitro's render
    // hooks never run for it — which meant the security headers were absent on
    // exactly the page most likely to be public. And a per-request CSP nonce
    // baked into a static file at build time is a constant, which is the same
    // as having no nonce.
    //
    // The `swr` route rules already give cached responses without either
    // problem: the first request renders, the rest are served from cache, and
    // every one of them goes through the response pipeline.
    prerender: { crawlLinks: false, routes: [] },
  },

  app: {
    head: {
      htmlAttrs: { lang: 'en' },
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ],
    },
  },
});
