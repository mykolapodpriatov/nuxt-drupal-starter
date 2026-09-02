# Architecture

This is the document for the engineer who read the README, got interested, and
wants to know whether the inside is as considered as the outside. The README
stays recruiter-facing; the reasoning lives here and in [`docs/adr/`](./docs/adr).

## Goals

In priority order, because they conflict:

1. **The CMS keeps its editorial capabilities.** Preview, aliases, menus and
   media are the parts a headless front end usually drops, and the parts editors
   notice first. A decoupled site that costs editors their workflow has traded
   the wrong thing.
2. **Credentials never reach the browser.** The boundary is one indentation
   level wide in Nuxt's config, so it is asserted twice — once against the
   config, once against the built bundle.
3. **The repository can be evaluated in two minutes.** `pnpm install && pnpm dev`
   renders real content with no PHP installed.
4. **Every decision is legible.** Six ADRs, each recording what was rejected and
   why. A starter whose choices cannot be audited is a starter you have to
   re-derive before trusting.

## Non-goals

- **A general-purpose Drupal client.** The JSON:API surface implemented here is
  the surface this application uses. Anything else returns a 404 rather than an
  approximation.
- **A CMS-agnostic front end.** The transport/domain split (ADR-001) means
  swapping backends is a matter of writing one mapper, but nothing here pretends
  to abstract over CMSs it has never seen.
- **Zero backend code.** Four small Drupal modules exist because the contrib
  ecosystem currently has no stable Drupal 11 equivalents. Pretending otherwise
  would mean either an unstable dependency or a broken feature.
- **A design system.** The styling is deliberately plain. The subject is the
  architecture.

## System boundaries

```
┌──────────────────────────────┐
│           Drupal             │
│                              │
│  JSON:API (read-only)        │  content
│  /api/menu/{menu}            │  navigation      ← nuxt_menu
│  /api/resolve?path=…         │  path → entity   ← nuxt_router
│  /api/contact                │  form writes     ← nuxt_contact
│  preview links, revalidate   │                  ← nuxt_preview
└──────────────┬───────────────┘
               │  server-only: base URL, token, two shared secrets
               ▼
┌──────────────────────────────┐
│      Nitro server layer      │
│  client · validate · map     │
│  cache · sign · rate-limit   │
└──────────────┬───────────────┘
               │  domain models only
               ▼
┌──────────────────────────────┐
│        Vue UI · SSR          │
│  talks only to /api/* here   │
└──────────────────────────────┘
```

The browser never contacts Drupal. That is not a convention — `connect-src 'self'`
enforces it in the CSP, and the bundle scan fails the build if a `/jsonapi/`
string appears in a client chunk.

## Data flow

**Reading an article.** The browser requests a path Drupal owns, say
`/blog/hello`. The catch-all page asks `/api/resolve`, which asks Drupal's
router what entity is at that alias. Drupal answers with an identity — type,
bundle, UUID — and the server then fetches that entity over JSON:API, validates
the response, maps it to a domain model and renders it.

Two round trips instead of one, because JSON:API cannot filter on `path`: it is
a computed field, and the two plausible spellings fail with a 500 and a 400
respectively (ADR-004).

**Rendering a menu.** `nuxt_menu` returns an access-checked, pre-nested tree from
Drupal's own menu tree service. Not JSON:API, which requires `administer menu`
to read `menu_link_content` and cannot see code-defined links at all (ADR-003).

**Previewing a draft.** Drupal signs a link with a shared secret; the front end
verifies it before contacting Drupal at all, compares the token's payload
against the requested id, and serves the result with `no-store` and `noindex`
(ADR-005).

## Failure modes

| What breaks | What happens |
|---|---|
| Drupal is unreachable | Every request is bounded by an `AbortSignal`, so a hung CMS cannot hold an SSR render open until the platform kills it |
| Drupal returns 200 with `meta.omitted` | Detected and reported. This is the quietest failure JSON:API has — a success status, an empty array, and the reason buried in metadata |
| A content field is renamed | The mapper degrades: `Article` always has a `title` and a `bodyHtml`, even if both are `''`. One mapper changes, not every template |
| The menu endpoint is down | The page renders without navigation rather than 500-ing. A menu outage is not a site outage |
| The revalidation webhook fails | Logged on the Drupal side and swallowed. An editor pressing Save is not responsible for the front end being reachable |
| A preview secret is unset | Verification fails closed. Preview does not work, rather than working for everyone |
| An image's file was deleted | `image` is `null` and the article renders without one |

Two failures are handled **badly on purpose**:

- **An unknown `status` is treated as unpublished.** Defaulting the other way
  leaks drafts the first time a field is renamed or dropped from a sparse
  fieldset. The restrictive default is the safe one.
- **A resolved entity that is not an article yields `null`.** A taxonomy term is
  a real entity at a real path; rendering it through the article template would
  be worse than reporting nothing.

## Performance considerations

Editorial content is cached and revalidated in the background — `swr` in
`routeRules`, which is Nuxt's own mechanism and not Next.js ISR. Menus are read
on every page and cached for five minutes. Preview is pinned to `no-store`,
because caching a draft at any TTL risks serving it to the public.

Nothing is prerendered. A prerendered route is served by the static handler, so
Nitro's render hooks never run for it — which meant the security headers were
absent on the most public page in the app, and a per-request CSP nonce baked
into a static file at build time is a constant. The `swr` rules give cached
responses without either problem.

Article images carry intrinsic `width`/`height` from the JSON:API relationship
metadata plus a CSS `aspect-ratio`, so a lazily-loaded listing does not shift as
images arrive.

Not measured: this application serves a handful of pages from a cached backend,
and there is no honest benchmark to report. The performance work that matters
here is the caching strategy, not rendering cost.

## Testing strategy

| Layer | Count | What it is for | What it cannot catch |
|---|---|---|---|
| Unit (`test/*.spec.ts`) | 256 | Mappers, validators, the signature scheme, the CSP | Whether the assembled app renders |
| Bundle scan (`test/*.scan.ts`) | 6 | Secrets in shipped JavaScript | Anything not in the client bundle |
| E2E (`e2e/`) | 28 | The built app in a real browser, including 6 axe passes | Judgement-dependent accessibility |

The split is deliberate. Unit tests are exhaustive because they are
milliseconds; end-to-end tests are few because they are slow and, when flaky,
get ignored — and an ignored suite is worse than none.

Two of them are worth singling out:

**The snapshot spec** runs bytes captured from a real Drupal 11 through the
whole pipeline. It exists because writing the mappers from the specification
produced two wrong assumptions, and hand-written fixtures would have been
written from the same wrong ones.

**The bundle scan was validated by planting a leak** — a component reading
`previewSecret` makes it fail, and reverting makes it pass. A guard test never
seen to fail is one nobody should trust.

## Trade-offs

**Four custom Drupal modules.** Every one exists because the contrib module that
would have done the job has no stable Drupal 11 release: `jsonapi_menu_items`,
`decoupled_router`, `webform`. If those stabilise, three of these modules should
be deleted — they are each under a hundred lines and losing them costs nothing.

**Two requests per article page.** The price of editor-controlled URLs. A single
request would mean the front end dictating the site's URL structure, which is
the opposite of running a CMS.

**Committed fixtures are a second thing to keep current.** A content-model change
that is not re-captured leaves them describing a Drupal that no longer exists —
and, worse, leaves the tests passing against it. Mitigated by making the capture
one command and committing the backend that produces it.

**The `app/` → `transport.ts` import ban is a convention**, not compiler-enforced.
If it slips, the indirection is being paid for without the benefit. A lint rule
on the import path would make it mechanical, and is worth adding the first time
it is violated.

**Rate limiting is per-instance.** Behind several instances the effective limit
multiplies by the instance count. It is a speed bump against scripted abuse, not
a control; Drupal's flood service is the one that actually holds.

## Future work

In the order it would be worth doing:

1. **i18n.** Language prefixes aligned with Drupal's languages. Deferred because
   it needs multilingual configuration in the reference backend, which is its
   own piece of work rather than a line in a pull request.
2. **A deployed demo.** The configuration is here; connecting an account is not
   something the repository can do for itself.
3. **Delete modules as contrib stabilises.** Worth re-checking every few months.
4. **`consumer_image_styles`** for responsive image derivatives. Stock Drupal
   emits no `image_style_uri`, which is why `styles` is usually an empty map.
5. **A lint rule** enforcing the `app/` → `transport.ts` import ban.
