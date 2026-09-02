# ADR-003: Serve menus from a purpose-built module, not JSON:API

- **Status:** accepted
- **Date:** 2026-09-02

## Context

Every page of a decoupled site renders the navigation an editor built in
Drupal. The obvious source is JSON:API, which the rest of this starter already
uses, and which does expose `menu_link_content`.

It does not work, for two independent reasons. Both were found by running the
request rather than reading the documentation.

### Reading it requires `administer menu`

An anonymous consumer requesting `/jsonapi/menu_link_content/menu_link_content`
gets **HTTP 200**:

```jsonc
{
  "data": [],
  "meta": {
    "omitted": {
      "detail": "Some resources have been omitted because of insufficient authorization.",
      "links": {
        "item--k6hAYrc": {
          "meta": {
            "detail": "The current user is not allowed to GET the selected resource. The 'administer menu' permission is required."
          }
        }
      }
    }
  }
}
```

A success status, an empty collection, and the actual reason two levels deep in
metadata that nothing is obliged to read. The symptom is an empty navigation
with nothing in the status code, the payload shape or the logs to suggest a
permission problem. It is the quietest failure mode in the API.

Granting the front end `administer menu` would fix the read — and hand it
**write access to every menu on the site**. That is a very large trade for the
ability to render a list of links.

### Even with the permission, the result is wrong

JSON:API serves *entities*. Only some menu links are entities. Links defined in
code by a module — `standard.front_page`, the "Home" item on a stock Drupal —
are plugins, and they have no `menu_link_content` record at all.

So a consumer with full permissions still renders a navigation missing exactly
the items nobody thinks to check, because they were never created through the UI
and so never appear in a content editor's mental inventory of the menu.

### The usual community answer is unavailable

`drupal/jsonapi_menu_items` solves both problems and is what most projects
reach for. It has no stable Drupal 11 release. Putting an unstable contrib
dependency in a starter's critical path trades one problem for another.

## Decision

A small module, `drupal/modules/custom/nuxt_menu`, exposes `GET /api/menu/{menu}`
returning an access-checked, pre-nested, weight-ordered tree.

It reads through Drupal's own `menu.link_tree` service — the same service the
site's menu blocks use — with the two standard manipulators:

```php
$tree = $this->menuTree->transform($tree, [
  ['callable' => 'menu.default_tree_manipulators:checkAccess'],
  ['callable' => 'menu.default_tree_manipulators:generateIndexAndSort'],
]);
```

`checkAccess` is what makes the endpoint safe: it runs each link's own access
callback, so a link pointing at a node the current user cannot view is filtered
out. Reading `menu_link_content` entities directly does not do this — which is
part of why core demands such a broad permission for it.

Four properties follow:

- **Read-only.** `methods: [GET]`. There is no write path to secure.
- **Guarded by `access content`** — the permission a site already grants
  anonymous users to read published nodes. Reading navigation is the same class
  of operation, and it is several orders of magnitude narrower than
  `administer menu`.
- **Only what the site itself would render.** `onlyEnabledLinks()`, plus
  per-link access checks.
- **Cacheable.** The response carries `config:system.menu.<name>` as a cache
  tag and varies by `user.permissions`, so editing the menu invalidates it and
  two users with different access cannot be served each other's tree.

URLs are resolved server-side to something usable in an `href`. The front end
should not have to understand Drupal's `internal:` / `entity:` URI scheme, and
resolving a path alias is Drupal's job in any case.

Because the endpoint already nests and orders, `server/drupal/menu.ts` is a
shape translation rather than a tree build. The flat-list-to-tree mapper written
for the JSON:API approach (`toMenuTree`) was removed in the same change: it had
no caller left, and dead code in a starter is worse than a lower test count.

## Alternatives considered

**Grant the consumer `administer menu`.** One line of configuration, and it
gives an API consumer write access to every menu on the site. It also does not
solve the missing code-defined links.

**Use `drupal/jsonapi_menu_items`.** The right answer when it has a stable
Drupal 11 release. Worth revisiting then — this module is about sixty lines and
deleting it would be no loss.

**Hard-code the navigation in the front end.** Removes the dependency and
removes the point: the reason to run Drupal is that editors control the site
structure. A navigation only a developer can change is a navigation that stops
matching the content.

**Read `menu_link_content` with an authenticated service account.** Solves the
permission, not the missing plugin-defined links, and puts a credential with
menu-write scope in the front end's environment.

## Consequences

**Easier.** Navigation renders server-side on every page with no privileged
credential. The response is already ordered, nested and access-filtered, so the
front-end mapper is trivial and has nothing site-specific in it.

**Harder.** The backend is no longer stock Drupal — a module has to be enabled
for menus to work. That is stated in `drupal/README.md` and the setup script
enables it, but a team pointing this front end at an existing Drupal has to
install it there too.

**Now has to be true.** The endpoint's response shape and
`server/drupal/menu.ts` have to agree. They are versioned together in this
repository, but a site running an older copy of the module would serve a shape
the mapper does not expect. The mapper is defensive about it — an item with no
usable title or URL is dropped and its children promoted — so a mismatch
degrades the menu rather than breaking the page.

**A note on the fixture.** The captured `menu--main.json` contains
`standard.front_page`, which is the evidence for the second problem above: a
menu link with no `menu_link_content` entity behind it. A test asserts its
presence, so the fixture keeps proving the point rather than merely
illustrating it.
