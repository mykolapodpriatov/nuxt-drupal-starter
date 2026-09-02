# ADR-001: Separate transport DTOs from domain models

- **Status:** accepted
- **Date:** 2026-09-02

## Context

Drupal's JSON:API returns a normalised graph, not a view model. An article
arrives as:

```jsonc
{
  "data": {
    "type": "node--article",
    "id": "…",
    "attributes": { "title": "…", "body": { "value": "…", "processed": "…" } },
    "relationships": { "field_image": { "data": { "type": "media--image", "id": "…" } } }
  },
  "included": [ /* the media entity, and the file it wraps, flat */ ]
}
```

Rendering the hero image means resolving a `{type, id}` pointer into `included`,
then resolving a second pointer from the media entity to its file. Two hops by
identity, through an array, before anything can be displayed.

Three properties of the source make the shape unstable in a way ordinary API
responses are not:

1. **The schema is edited through a web UI**, by site builders who are not
   reading this repository. `field_image` becomes `field_hero`; a single-value
   field becomes multi-value, flipping `data` from an object to an array.
2. **Absence is routine, not exceptional.** Articles without images, media
   entities whose file was deleted, empty body fields, image styles configured
   on staging but not production.
3. **Serialisation varies.** `image_style_uri` arrives as an object in some
   configurations and as an array wrapping that object in others — against the
   same codebase.

The question was whether components should consume these payloads directly
(with types applied to the fetch result), or whether an explicit mapping layer
should sit between.

## Decision

Two distinct type families, with one bridge between them.

- `server/drupal/transport.ts` — the shape Drupal sends. Faithful to JSON:API,
  warts included. Everything optional, because everything genuinely can be.
- `shared/domain.ts` — the shape the UI wants. Flat, non-optional wherever a
  template cannot cope with absence, free of Drupal vocabulary.
- `server/drupal/normalize.ts` — the only bridge.

The invariant that keeps it honest: **nothing under `app/` imports from
`transport.ts`.** A component that needs new data gets it by extending the
domain model and its mapper, never by learning about `included`.

Mappers degrade rather than throw. `validate.ts` has already rejected anything
structurally broken at the boundary; what reaches a mapper is the ordinary
messiness of a live content model, and none of it should blank a page. An
`Article` always has a `title` and a `bodyHtml`, even if both are `''`.

Two deliberate exceptions to "degrade quietly":

- **`published` defaults to `false`.** Defaulting an unknown status the other
  way leaks drafts the first time the field is renamed or omitted from a sparse
  fieldset. The safe default is the restrictive one.
- **`bodyHtml` never falls back to `body.value`.** `processed` is the output of
  Drupal's text-format filters; `value` is the editor's raw input. Falling back
  would let someone restricted to a basic format emit markup that format exists
  to strip.

## Alternatives considered

**Type the fetch result and render from it directly.** Least code today. It
makes every component a consumer of Drupal's storage model: renaming a field in
the CMS breaks every template that touched it, and each one needs its own
`?.` chain for the absence cases. The coupling is invisible until the first
content-model change, at which point it is everywhere.

**Generate types from Drupal's schema.** Attractive, and a common suggestion.
It solves the wrong half of the problem — it makes the *transport* types
accurate, but components still consume transport shapes, so the coupling
remains. It also makes the front end unbuildable without a reachable Drupal
instance, which conflicts with the backend-free mode in ADR-002. Worth
revisiting as a way to generate `transport.ts` specifically; not as a
replacement for the split.

**A generic JSON:API denormaliser** (`jsonapi-serializer` and similar). Removes
the pointer-walking, which is the easy part. Returns `Record<string, unknown>`
with relationships inlined, so the result is untyped and still shaped like
Drupal. The typed target is the value here, not the graph walk.

**One type, optional everywhere.** Collapses the two families by making the
domain model as optional as the transport. Pushes every absence case into every
template, forever. Optionality that survives to the UI is optionality the UI
has to handle.

## Consequences

**Easier.** A field rename in Drupal touches one mapper. Components are
testable against plain objects with no JSON:API fixtures. Swapping the backend
means writing another mapper to the same target type — which is exactly the
mechanism the fixture-backed mode uses.

**Harder.** Every new field needs adding in two places plus a mapper line. For
a project that only ever reads three fields, that is overhead; the split earns
its keep once the content model starts moving.

**Now has to be true.** The `app/` → `transport.ts` import ban is a convention,
not something the compiler enforces. If it slips, the indirection is being paid
for without the benefit. A lint rule restricting the import path would make it
mechanical, and is worth adding if it is ever violated.

**Testing shifts to the mapper.** 41 of this pull request's tests target
`normalize.ts`, covering the absence and inconsistency cases enumerated above —
dangling pointers, both `image_style_uri` shapes, a child menu link arriving
before its parent, an unknown `status`. That concentration is the point: those
cases exist in one file instead of being rediscovered in each component.
