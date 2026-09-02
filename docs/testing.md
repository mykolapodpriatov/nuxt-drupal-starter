# Testing

Three layers, each answering a different question.

## `test/*.spec.ts` — node environment

Plain functions over data: the JSON:API normalizer, the response validators,
the cache-key builder, the runtime-config boundary. No DOM, no Nuxt runtime, so
the whole layer finishes in milliseconds and is the right place for exhaustive
edge-case coverage.

This directory carries its own `tsconfig.json`. Nuxt generates four TypeScript
projects and maps `test/nuxt/**` into the app project, but plain specs sitting
directly in `test/` land in none of them — which makes type-aware ESLint refuse
to parse them. The local project fixes that without editing generated files.

## `test/nuxt/*.spec.ts` — Nuxt environment

Anything that needs auto-imports, `useRuntimeConfig()` or the component
registry. Opt a file in with a docblock pragma:

```ts
// @vitest-environment nuxt
```

`@nuxt/test-utils` registers this directory as its own Vitest project, and
Nuxt's generated `tsconfig.app.json` already includes it — no extra
configuration either way.

Note that the module's project picks up **every** file in this directory, not
only `*.spec.ts`. A stray `README.md` here is treated as a test file and fails
the run; documentation belongs in `docs/`.

## `e2e/` — Playwright

Whole flows against a built application: home → article → preview → form
submission, plus an axe pass on the main screens. Slow, few, and reserved for
behaviour that only exists once the pieces are assembled.

## Running

```bash
pnpm test            # node + nuxt projects
pnpm test:coverage   # same, with a coverage report
pnpm test:e2e        # Playwright
pnpm verify          # lint + typecheck + test + build, as CI runs it
```
