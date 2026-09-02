# ADR-002: Ship a captured fixture snapshot, not a required backend

- **Status:** accepted
- **Date:** 2026-09-02

## Context

A decoupled starter has an evaluation problem its monolithic equivalent does
not. `pnpm install && pnpm dev` on a Nuxt + Drupal repository renders nothing
useful, because the content lives in a CMS that is not in the repository.
Getting to a first rendered page means installing PHP, Composer, a database and
a content model.

That cost falls on three audiences, and each of them mostly declines to pay it:

- **A reviewer** — the person this repository exists to persuade — has a few
  minutes. If the home page does not render, the code is judged on its README.
- **CI** would have to provision a Drupal instance on every run. That turns a
  90-second pipeline into a multi-minute one and makes the front-end tests fail
  for backend reasons.
- **A developer working on the front end** loses the ability to work offline, or
  while the shared Drupal is mid-migration.

The obvious fix is to mock the network layer in tests. That solves CI and
nothing else: `pnpm dev` still renders an empty site, and the mocks live in the
test directory where the running application cannot reach them.

## Decision

The transport is swappable, and the choice is made in exactly one place.

`server/drupal/index.ts` inspects `NUXT_DRUPAL_BASE_URL`. Unset, it builds the
client over `createFixtureFetch`, which answers from JSON committed under
`fixtures/drupal/`. Set, it builds the client over the network. No route,
composable or component branches on the mode.

Two properties matter more than the mechanism:

**Everything above the socket is identical.** The fixture transport implements
`fetch`'s signature, so the client, the response validators and the normalizers
run unchanged. URL construction is exercised — the fixture transport parses
`filter[status][value]`, `sort` and `page[limit]` out of the query string the
client built. A double injected higher up, at the client or the mapper, would
skip the code most likely to be wrong.

**The fixtures are captured, not written.** `scripts/snapshot-content.ts` pulls
from a live instance and writes the result verbatim, minus sanitisation.

Hand-written fixtures are the failure mode this avoids. They drift towards what
the code expects rather than what Drupal emits, so they agree with every bug the
code already has. The inconsistencies worth defending against are exactly the
ones nobody invents from memory: `image_style_uri` serialised as an object in
one configuration and an array-wrapped object in another; a single-value field
becoming multi-value and flipping `data` from an object to an array; a
relationship pointing at an entity that was deleted.

A reference backend is committed as configuration only — `drupal/` holds a DDEV
config, a Composer manifest and a setup script, not a Drupal install. One
command builds the site the snapshot was taken from, so the fixtures are
reproducible rather than archaeological.

The capture is sanitised on two axes:

- **Secrets and hostnames.** The capturing site's origin is replaced with
  `https://cms.example.test`, so fixtures neither leak an internal hostname nor
  change when captured from a different environment.
- **Churn.** `links`, per-request `meta` and `resourceVersion` are dropped.
  They change on every save, and left in, a re-capture produces a diff that is
  entirely link noise with the real content change buried inside it.

## Alternatives considered

**Require a running Drupal.** Honest, and what a production project does. For a
repository whose purpose is to be read, it means most readers never see it run.

**Mock at the test layer only** (MSW, `vi.mock`). Solves CI, leaves `pnpm dev`
rendering an empty site, and puts the sample content somewhere the application
cannot use it. Also tests a different code path than production, since the mock
usually intercepts above the client.

**Check in a Drupal database dump.** Reproduces the backend exactly. Costs tens
of megabytes in git, needs a database to read, and still requires PHP — so it
solves the fidelity problem while leaving the cost problem untouched.

**Point the demo at a public Drupal instance.** Zero setup for the reader, until
the instance is down, rate-limited, spammed or discontinued — at which point the
repository looks broken through no fault of its code. It also cannot run in CI
without a network dependency.

**Generate fixtures from the TypeScript types.** Guarantees the fixtures satisfy
the types, which is precisely the property that makes them worthless: they can
only ever contain what the code already anticipates.

## Consequences

**Easier.** `pnpm install && pnpm dev` renders content on any machine. CI needs
no CMS. The static showcase build has real data to prerender. Front-end work
continues while the shared Drupal is unavailable.

**Harder.** The fixtures are a second thing to keep current. A content model
change that is not re-captured leaves them describing a Drupal that no longer
exists — and, worse, leaves the tests passing against it. Mitigation: the
capture is one command, and the reference backend that produces it is committed
alongside.

**Now has to be true.** The fixture transport must keep implementing enough
JSON:API query semantics to be representative. It currently handles the status
filter, sort and pagination — the operations the app issues. A new query
capability used in production but unimplemented here would pass in fixture mode
and fail live, which is the one way this design can hurt. Any new query feature
belongs in `applyQuery` in the same change.

**Explicitly not a goal.** The fixture transport is not a Drupal emulator. It
answers the requests this application makes, and returns a JSON:API 404 for
anything else rather than approximating.
