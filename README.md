# nuxt-drupal-starter

Production-oriented Nuxt starter for decoupled Drupal: typed JSON:API, preview
workflows, cache invalidation, Webform integration, media handling and
deployment-ready SSR.

[![ci](https://github.com/mykolapodpriatov/nuxt-drupal-starter/actions/workflows/ci.yml/badge.svg)](https://github.com/mykolapodpriatov/nuxt-drupal-starter/actions/workflows/ci.yml)
![Nuxt 4](https://img.shields.io/badge/Nuxt-4.5-00DC82)
![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178C6)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

> **Status: scaffold.** The toolchain, the runtime-config boundary and CI are in
> place. The Drupal content layer lands over the next pull requests — see
> [the roadmap](#roadmap).

---

## Why this exists

Pairing Drupal with a modern front end is a solved problem in theory and a
rebuilt-from-scratch problem in practice. Every project ends up writing the
same four things, and getting the same three of them subtly wrong:

- **JSON:API is a graph, not a view model.** Responses arrive normalised, with
  relationships spread across a top-level `included` array. Rendering straight
  from that shape couples every component to Drupal's storage model, so a field
  rename in the CMS breaks a template three layers away.
- **Preview needs to be authenticated and uncached, at the same time.** Editors
  expect to see unpublished content; the public must not. That means a server
  route holding a credential, and cache rules that cannot accidentally serve a
  draft.
- **Content changes must invalidate the right paths.** Without it you choose
  between stale pages and no caching at all.
- **The credentials must stay on the server.** In Nuxt, the boundary between a
  server-only secret and a value published to every visitor is one level of
  indentation in `runtimeConfig`.

This starter takes a position on each, and documents why in
[`docs/adr/`](./docs/adr).

## Architecture

```
┌─────────────────────┐
│       Drupal        │
│ JSON:API · Webform  │
└─────────┬───────────┘
          │  normalised graph, unpublished content, editorial menus
          ▼
┌─────────────────────┐
│ Nuxt server layer   │   credentials live here and nowhere else
│ auth · validation   │
│ cache · normalize   │
└─────────┬───────────┘
          │  validated, denormalised
          ▼
┌─────────────────────┐
│   Domain models     │   the shape the UI actually wants
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│    Vue UI · SSR     │
└─────────────────────┘
```

The transport DTO and the domain model are deliberately separate types. Drupal
describes `node--article` with an `attributes.body.processed` string; a template
wants `article.bodyHtml`. Keeping the two apart means a change to the content
model is absorbed by one mapper instead of rippling through components.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full picture.

## Quick start

No Drupal instance is required to run this repository. With `DRUPAL_BASE_URL`
unset, the app serves a committed fixture snapshot.

```bash
corepack enable
pnpm install
pnpm dev
```

Against a live backend:

```bash
cp .env.example .env
# set NUXT_DRUPAL_BASE_URL, then
pnpm dev
```

## Verification

```bash
pnpm verify   # lint + typecheck + tests + build — exactly what CI runs
```

CI runs lint, typecheck and tests as three parallel jobs, then builds from the
result. Tests run on Node 22 and 24.

## Roadmap

- [x] Scaffold: Nuxt 4, TypeScript strict, type-aware ESLint, Vitest, CI
- [ ] Typed JSON:API client, runtime validation, `included` normalizer
- [ ] Fixture snapshot and backend-free mode
- [ ] Pages, Drupal-driven menus, responsive media, SEO
- [ ] Preview route and cache invalidation webhook
- [ ] Webform, i18n, security headers, accessibility baseline
- [ ] Playwright end-to-end tests and a deployed demo

## Design notes

**Why `swr` and not "ISR".** Nuxt has its own rendering vocabulary — SSR,
prerender, `swr`, route rules — and provider-specific incremental regeneration
sits on top of it. Borrowing Next.js terminology one-for-one would describe
behaviour this app does not have. Route rules say what they mean:

```ts
'/articles/**': { swr: 3600 },       // cached, revalidated in the background
'/preview/**':  { ssr: true, headers: { 'cache-control': 'no-store' } },
```

**Why the runtime-config boundary is a test.** Nuxt exposes
`runtimeConfig.public` to the browser and keeps every other key server-side.
Moving `token` two spaces to the right ships a credential to every visitor, and
neither the type system nor the build objects. So it is asserted:
[`test/runtime-config.spec.ts`](./test/runtime-config.spec.ts) fails if any
Drupal setting appears under `public`, if a key name looks like a credential, or
if the preview route ever gains a cache rule.

**Why type-aware linting covers `.ts` but not `.vue`.** The rules worth having
— `no-explicit-any`, `no-floating-promises` — need type information, which is
brittle to obtain through `vue-eslint-parser` for SFC templates. Components are
still fully type-checked: `pnpm typecheck` runs `vue-tsc` across the whole
project. See [`docs/testing.md`](./docs/testing.md).

## License

[MIT](./LICENSE)
