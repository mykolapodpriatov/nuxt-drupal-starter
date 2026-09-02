# Deployment

The application is server-rendered, so it needs a Node runtime. Nuxt builds a
platform-agnostic `.output` directory; every option below is a matter of where
that runs.

## Vercel — the full demo

Nuxt detects Vercel and emits the right output with no configuration. The
`vercel.json` here only pins the package manager and the region.

```bash
vercel link
vercel --prod
```

Set these in the project's environment. **All of them are server-only** — none
appears under `runtimeConfig.public`, and a test asserts that:

| Variable | Required | Purpose |
|---|---|---|
| `NUXT_DRUPAL_BASE_URL` | for live content | Drupal origin. **Unset, the app serves the committed fixtures** — which is a legitimate demo mode, not a broken one |
| `NUXT_DRUPAL_TOKEN` | for preview | Bearer token that may read unpublished nodes |
| `NUXT_DRUPAL_PREVIEW_SECRET` | for preview | Must match `$settings['nuxt_preview_secret']` in Drupal |
| `NUXT_DRUPAL_REVALIDATE_SECRET` | for webhooks | Must match `$settings['nuxt_revalidate_secret']` |
| `NUXT_PUBLIC_SITE_URL` | yes | Canonical origin, used for canonical tags and the sitemap |

Then, in Drupal's `settings.php`:

```php
$settings['nuxt_frontend_url'] = 'https://your-deployment.vercel.app';
$settings['nuxt_preview_secret'] = '…';      // same value as above
$settings['nuxt_revalidate_secret'] = '…';   // same value as above
```

A mismatched secret presents as *"preview links stopped working"* with a
`bad-signature` line in the front end's log and nothing on the Drupal side. That
is why the rejection reason is logged rather than swallowed.

## Anywhere with Node

```bash
pnpm build
node .output/server/index.mjs
```

Reads `PORT` and `HOST`. No platform-specific code is involved.

## Docker

```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml package.json ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/.output ./.output
ENV PORT=3000 HOST=0.0.0.0
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
```

## Static export — and what it costs

```bash
pnpm generate
```

Produces a fully static site that any host will serve, including GitHub Pages.
Worth being explicit that this discards most of what this starter demonstrates:

- **No preview.** Rendering unpublished content requires a server to verify the
  signature.
- **No cache invalidation.** There is no cache to invalidate; content changes
  need a rebuild.
- **No contact form.** The submission endpoint is a server route.
- **No per-request security headers.** A static host sets its own, and the CSP
  nonce — which has to differ per request — cannot exist.

That last point is not hypothetical. Prerendering was removed from this project
for exactly this reason: a prerendered route is served by the static handler, so
Nitro's render hooks never run and the security headers were silently absent on
the most public page in the app.

Static export is a reasonable way to publish a *screenshot* of the site. It is
not a way to demonstrate a decoupled architecture.

## Before going live

- Rotate the development secrets. `drupal/setup.sh` writes
  `test-preview-secret` and `test-revalidate-secret` into `settings.php`; they
  are development values and the bundle scan will catch them if they ever reach
  the client, but they should not survive to production.
- Change the reference Drupal's `admin`/`admin` credentials, or do not expose
  that instance at all.
- Confirm `NUXT_PUBLIC_SITE_URL` matches the real origin. It is what canonical
  tags and the sitemap are built from, and a wrong value is an SEO problem that
  takes weeks to surface.
- Check the response headers once, in a browser. Two of this project's real
  bugs — a plugin that never registered, and a CSP that blocked hydration —
  were invisible in the code and obvious in the response.
