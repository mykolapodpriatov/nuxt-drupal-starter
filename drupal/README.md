# Reference Drupal backend

**You do not need this to run the front end.** With `NUXT_DRUPAL_BASE_URL`
unset, the Nuxt app serves the snapshot committed in `../fixtures/drupal`, so
`pnpm install && pnpm dev` renders real content on a machine with no PHP.

This directory exists so that snapshot is *reproducible*. It builds the Drupal
site the fixtures were captured from, so anyone can rebuild it, change the
content model and re-capture — rather than inheriting a JSON blob nobody can
regenerate.

Only configuration is committed: DDEV config, a Composer manifest and the setup
script. The Drupal install itself (`web/`, `vendor/`, `composer.lock`) is
gitignored.

## Build it

Requires [DDEV](https://ddev.com) and Docker.

```bash
./setup.sh
```

Then capture fixtures from it:

```bash
cd ..
NUXT_DRUPAL_BASE_URL="$(cd drupal && ddev describe -j \
  | jq -r '.raw.urls[] | select(startswith("http://127"))' | head -1)" \
  pnpm snapshot:content
```

Use the `127.0.0.1` URL rather than `*.ddev.site`: the latter is served over
HTTPS with a locally-trusted certificate that Node does not trust by default.

Or point the dev server straight at it:

```bash
NUXT_DRUPAL_BASE_URL=http://127.0.0.1:<port> pnpm dev
```

## What the setup script does, and why

**Applies core recipes for the content type.** Drupal 11's `standard` profile no
longer ships `article` and `page` — content types moved to recipes. `setup.sh`
applies `image_media_type` and `article_content_type`, which is why the article
bundle exists at all.

**Enables JSON:API in read-only mode** and grants anonymous `access content`.
Read-only is the right default for a consumer that only reads; leaving writes
enabled widens the attack surface for no benefit here.

**Creates sample content deliberately shaped for the fixtures.** Four published
articles (three with images, one without) and one unpublished draft. Each covers
a case the mappers must handle, and the "article with no image" is there because
an empty relationship is the single most common thing a Drupal mapper gets
wrong.

## Two findings worth knowing before you build on this

### `field_image` is a plain image field, not a media reference

Core's `article_content_type` recipe creates `field_image` as an **image field**,
so JSON:API points it straight at `file--file`:

```
field_image ──────────────────────────────────► file--file
```

A site using the media library instead produces:

```
field_image ──► media--image ──► field_media_image ──► file--file
```

Both are common. `server/drupal/normalize.ts` handles both, because handling
only one makes images silently vanish on half of all Drupal sites — and "no
image" is indistinguishable from an article that genuinely has none.

It also means the JSON:API `include` path differs. Requesting
`include=field_image.field_media_image` against a plain image field is an HTTP
400, which is why `scripts/snapshot-content.ts` probes include shapes
deepest-first rather than assuming one.

### Alt text lives on the relationship, not on the file

```jsonc
"relationships": {
  "field_image": {
    "data": {
      "type": "file--file",
      "id": "…",
      "meta": { "alt": "…", "title": "", "width": 1201, "height": 630 }
    }
  }
}
```

That is arguably correct — the same file reused on two nodes can carry different
alt text per usage — and it is also the detail every instinct gets wrong, because
alt text feels like a property of the image. A mapper reading the file's
attributes renders every image with empty alt and no intrinsic dimensions.

### Menus are not exposed here

Core JSON:API serves `menu_link_content`, but reading it requires the
`administer menu` permission. An anonymous consumer therefore gets **HTTP 200,
an empty `data` array, and the explanation buried in `meta.omitted`** — the
quietest failure in the API. The symptom is "the navigation is empty" with
nothing in the status code or the logs to suggest otherwise.

`server/drupal/validate.ts` detects that case (`describeOmitted`) and the client
reports it rather than rendering an empty menu, but detection is not a fix.
Granting an API consumer `administer menu` would hand it write access to every
menu on the site, and `drupal/jsonapi_menu_items` — the usual community answer —
has no stable Drupal 11 release. A small read-only, access-checked module lands
with the menu feature itself.

## Credentials

`admin` / `admin`. This is a local reference instance that is never deployed; if
you expose it anywhere, change them.
