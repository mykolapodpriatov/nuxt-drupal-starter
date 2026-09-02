# ADR-004: Resolve URL paths through Drupal's router, not a JSON:API filter

- **Status:** accepted
- **Date:** 2026-09-02

## Context

Drupal owns the site's URL structure. An editor sets an alias and an article
lives at `/blog/hello` — not at a path this front end invented. That is the
whole reason to run a CMS, so a decoupled front end cannot route by pattern; it
has to ask what is at a given path.

The obvious implementation is a JSON:API filter on the alias. It does not work,
and it does not work in two different ways depending on which spelling you try.
Both verified against a live Drupal 11 instance:

```
GET /jsonapi/node/article?filter[path.alias]=/blog/hello
→ 500  "'path' not found"

GET /jsonapi/node/article?filter[path][alias]=/blog/hello
→ 400  "You must provide a valid filter condition. Check that you have set the
        required keys for your filter."
```

The reason is that `path` is a **computed** field. It is not stored, so there
is nothing for the query builder to filter on — and the failure surfaces as a
500 rather than as a clear "this field is not filterable", which is why this is
the kind of thing found by running the request rather than by reading the
documentation.

Filtering on `status` works in both spellings, which makes the failure look
inconsistent until the computed-field distinction is understood:

```
filter[status]=1          → 200, 4 results
filter[status][value]=1   → 200, 4 results
filter[path.alias]=…      → 500
```

`drupal/decoupled_router` is the standard answer to this problem. Like
`drupal/jsonapi_menu_items` in ADR-003, it has **no stable Drupal 11 release**.

## Decision

A second small module, `drupal/modules/custom/nuxt_router`, exposes
`GET /api/resolve?path=…` and answers with an identity:

```jsonc
{
  "found": true,
  "entity": {
    "type": "node",
    "bundle": "article",
    "uuid": "59ec6373-…",
    "resourceType": "node--article",
    "langcode": "en"
  }
}
```

It resolves through Drupal's own `path_alias.manager` and `Url::fromUri()`,
rather than by pattern-matching `/node/12`. That matters because a site routes
more than nodes — taxonomy terms, users, media, custom entities — and each has
its own canonical route parameter. Using the router means aliases, language
prefixes and canonical paths behave exactly as they do for the site itself.

Two decisions inside that are worth stating:

**The response carries only an identity, never the content.** The front end
then fetches the entity over JSON:API as normal. That keeps exactly one code
path turning a Drupal resource into a domain model (ADR-001) and stops this
endpoint from becoming a second, divergent serialiser that has to be kept in
step with the first.

**Access is checked on the resolved entity**, not merely on the route. Without
it, an unpublished node's alias would answer `found: true` and so confirm that
the node exists. A small leak, but a real one — and the fix is three lines.

The cost is one extra round trip per page: resolve, then fetch. Worth it for
editor-controlled URLs, and the resolve response is cacheable by path.

## Alternatives considered

**Route by UUID: `/articles/{uuid}`.** Works with no backend module at all, and
throws away editor-controlled URLs — which is the point of the CMS. It also
produces URLs no human would share.

**`drupal/decoupled_router`.** The right answer once it has a stable Drupal 11
release, and this module is about fifty lines, so deleting it then costs
nothing.

**Mirror Drupal's alias pattern in the front end's router.** Requires the front
end to know the pathauto pattern, breaks the moment an editor sets a custom
alias, and silently serves the wrong article rather than a 404 when it is
wrong.

**Sync the alias table into the front end at build time.** Removes the round
trip and makes every new article require a deploy — which reintroduces exactly
the coupling that decoupling was meant to remove.

## Consequences

**Easier.** Any path Drupal serves resolves, including aliases set by hand,
without the front end knowing anything about the URL scheme. Extending the
starter to render taxonomy terms or basic pages is a branch on `resourceType`,
not new routing.

**Harder.** Two requests per article page instead of one, and a second custom
module the backend has to have installed. Both are stated in
`drupal/README.md`, and `setup.sh` enables it.

**Now has to be true.** The resolver's response shape and
`server/drupal/articles.ts` must agree. They are versioned together here; the
consumer is defensive — a response with no `entity`, or with a `resourceType`
this starter does not render, yields `null` rather than an error.

**A note on the fixture mode.** Path resolution is *derived* rather than
captured: the fixture transport computes the answer from the aliases already
present in the captured articles. One less fixture to keep current, and the two
cannot drift apart. Verified end to end in both modes — the same article renders
at the same alias from fixtures and from a live Drupal 11 instance.
