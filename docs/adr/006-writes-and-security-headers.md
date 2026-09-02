# ADR-006: Keep JSON:API read-only; write through narrow endpoints

- **Status:** accepted
- **Date:** 2026-09-02

## Context

The contact form is the first thing in this starter that writes to Drupal, and
it forces a decision that has been deferred since ADR-002: how does a public
front end put data into the CMS?

JSON:API can do it. Drupal exposes `POST /jsonapi/contact_message/feedback`, and
enabling it is one configuration change:

```
jsonapi.settings: read_only: false
```

That flag is **global**. It does not enable writing to contact messages; it
enables writing to every entity type the requester's permissions allow. The
front end is a public origin, so "the requester" is whoever finds the endpoint —
and they reach Drupal directly, bypassing the validation, honeypot and rate
limiting that live in the Nuxt route.

Restricting the damage means restricting the *permissions* of whoever POSTs,
which for an anonymous submission means restricting anonymous users. That works,
until the next module adds a permission that anonymous users happen to hold.

There is also a contrib option, and it is the fourth in this repository to fail
the same way: `drupal/webform` — the standard answer for forms in Drupal — has
**no stable Drupal 11 release**, alongside `jsonapi_menu_items` (ADR-003) and
`decoupled_router` (ADR-004).

## Decision

**JSON:API stays read-only.** Writes go through purpose-built endpoints, one per
operation, each creating exactly one entity type and generalising to nothing.

For the contact form that is `drupal/modules/custom/nuxt_contact`, guarded by
`access site-wide contact form` — Drupal's own permission for the operation it
performs. Its whole write surface is one `contact_message`.

Defence is split across the two sides on purpose, according to what each can
actually enforce:

| | Nuxt route | Drupal endpoint |
|---|---|---|
| Shape and length validation | zod, shared with the client | entity API constraints |
| Honeypot | yes | — |
| Rate limiting | in-memory, per instance | Drupal's flood service |
| Email validation | zod | `email.validator`, re-checked |
| Delivery | — | `contact.mail_handler` |

The Drupal side re-validates rather than trusting the front end, because the
endpoint is reachable independently of it. The email address in particular is
used as a Reply-To, and an unvalidated one is a header-injection surface.

Rate limiting exists on both sides for different reasons: the Nuxt limiter is
in-memory and per-instance, so behind several instances the effective limit
multiplies — a speed bump, not a control. Drupal's flood service is shared and
persistent, and applies however the message arrived.

`contact.mail_handler` does the delivery so the contact form's configured
recipients and templates apply. Reimplementing that would drift from the CMS's
configuration the first time an editor changed it.

### Security headers

Set in a Nitro plugin rather than route rules, because they have to apply to
everything — pages, API routes, the sitemap, error responses — and a header
missing from exactly one route is a header that does not exist.

The CSP allows no inline or eval-ed script. Nuxt's hydration payload is a JSON
script tag rather than executable code, so it needs neither. Inline *styles* are
allowed, deliberately: Vue's scoped styles and Nuxt's SSR `<style>` blocks both
require it, and removing it means giving up scoped styles or hashing every
generated block on every render — a poor trade for a directive that cannot
execute anything.

`connect-src 'self'` is the one that encodes the architecture: the browser talks
to this app's server routes and never to Drupal, which is what keeps the
credentials server-side.

`referrer-policy: strict-origin-when-cross-origin` matters more here than on a
typical site: a preview URL carries a signed token in its query string, and the
default policy would hand that token to every third-party asset the page loads.

### The bundle scan

`test/build-output.scan.ts` reads the built client chunks and fails on any
server-only config key, secret environment variable name, `Bearer` header
construction or `/jsonapi/` path.

`test/runtime-config.spec.ts` already asserts the *intent* — no Drupal setting
under `runtimeConfig.public`. This asserts the *outcome*, against the bytes
actually shipped, because the two diverge in ways nothing else catches: a
component reading `useRuntimeConfig().drupal` gets the value inlined at build
time; a `server/` module imported from `app/` drags its constants into a client
chunk. Neither produces a type error, a lint warning or a failed build.

It runs from its own config in the `build` CI job, after there is something to
inspect, and fails outright if there is not — in the main suite it would find no
files and pass vacuously, which reads on a green CI as coverage that does not
exist.

It was validated by planting a leak: a component reading `previewSecret` makes
the scan fail, and reverting makes it pass. A guard test that has never been
seen to fail is a guard test nobody should trust.

## Alternatives considered

**Turn `read_only` off and rely on permissions.** One line, and it opens
Drupal's write surface to the public internet, bypassing every check in the Nuxt
route. Tightening permissions contains the damage only until a module adds one
anonymous users happen to hold.

**`drupal/webform`.** The standard answer, with no stable Drupal 11 release.
Worth revisiting; this module is small enough to delete without regret.

**Post the form directly from the browser to Drupal.** Removes a hop and every
defence with it: no honeypot, no rate limiting, and Drupal's write endpoint
exposed to the open internet.

**A CAPTCHA instead of a honeypot.** More effective against determined abuse,
and a real accessibility and privacy cost for every legitimate visitor. A
honeypot plus flood control stops the automated majority; if a determined
attacker turns up, that is the moment to reconsider — not before.

**A nonce-based CSP for scripts.** Stricter, and unnecessary: there is no inline
script to permit. It would be required if a third-party analytics snippet were
added, which is the trigger to revisit.

## Consequences

**Easier.** Drupal's write surface stays closed. Every write is a named
endpoint with its own permission, so "what can this front end change?" has a
short, readable answer.

**Harder.** A fourth custom module, and a new form means new code on both sides
rather than a configuration change. That is the cost of not opening the API, and
it is proportionate for a site with two or three forms — not for one with fifty,
where Webform reaching a stable Drupal 11 release changes the calculation.

**Now has to be true.** The zod schema and the PHP validation have to stay
compatible. They are not shared, and cannot be. A field the front end allows and
Drupal rejects surfaces as a 502 with a clear log line rather than silently, so
the divergence is visible — but it is a divergence.

**Worth stating plainly.** Four of this repository's Drupal modules exist
because a contrib module that would have done the job has no stable Drupal 11
release: `jsonapi_menu_items`, `decoupled_router`, `webform`, and the
`consumer_image_styles` gap noted in ADR-001. That is the current state of the
decoupled Drupal 11 ecosystem, and the reason this starter is worth having.
