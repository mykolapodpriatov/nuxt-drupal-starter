#!/usr/bin/env bash
#
# Build the reference Drupal backend the committed fixtures were captured from.
#
# The front end does not need this: with NUXT_DRUPAL_BASE_URL unset it serves
# the snapshot in ../fixtures/drupal. This exists so that snapshot is
# reproducible rather than archaeological — anyone can rebuild the site it came
# from and re-capture.
#
# Requires DDEV and Docker.
set -euo pipefail

cd "$(dirname "$0")"

echo "==> Starting DDEV"
ddev start -y

echo "==> Installing Drupal 11"
ddev composer install --no-interaction

echo "==> Installing the site"
ddev drush site:install standard \
  --account-name=admin --account-pass=admin \
  --site-name="Nuxt Drupal Starter" -y

# Drupal 11's `standard` profile no longer ships content types — they moved to
# recipes. `article_content_type` gives the article bundle with title, body,
# path and field_image; `image_media_type` is applied first because the article
# recipe expects the image handling to exist.
echo "==> Applying core recipes"
ddev drush recipe ../web/core/recipes/image_media_type
ddev drush recipe ../web/core/recipes/article_content_type

# The menu module lives in drupal/modules/custom (committed); Drupal looks in
# web/modules/custom (gitignored, part of the generated install).
echo "==> Installing the custom modules"
mkdir -p web/modules/custom
cp -R modules/custom/nuxt_menu web/modules/custom/
cp -R modules/custom/nuxt_router web/modules/custom/
cp -R modules/custom/nuxt_preview web/modules/custom/
cp -R modules/custom/nuxt_contact web/modules/custom/

echo "==> Enabling JSON:API (read-only)"
ddev drush en jsonapi -y
ddev drush config:set jsonapi.settings read_only true -y
ddev drush role:perm:add anonymous 'access content' -y

echo "==> Enabling the menu and path-resolution endpoints"
# Core JSON:API cannot expose menus to an unprivileged consumer (ADR-003), and
# cannot filter on `path` at all because it is a computed field (ADR-004).
ddev drush en contact nuxt_menu nuxt_router nuxt_preview nuxt_contact -y

# The contact form messages are filed against. Core's standard profile no
# longer creates one.
ddev drush php:eval '
$s = \Drupal::entityTypeManager()->getStorage("contact_form");
if (!$s->load("feedback")) {
  $s->create(["id" => "feedback", "label" => "Website feedback", "recipients" => ["admin@example.test"], "reply" => "", "weight" => 0, "message" => "Your message has been sent."])->save();
}
\Drupal::configFactory()->getEditable("contact.settings")->set("default_form", "feedback")->save();
'

# Reading navigation and submitting the contact form are both things an
# anonymous visitor does on an ordinary Drupal site.
ddev drush role:perm:add anonymous 'access site-wide contact form' -y

# Preview links and cache invalidation need three settings, and they live in
# settings.php rather than configuration: config is exported to config/sync and
# committed, and a secret in git is not a secret.
if ! grep -q "nuxt_frontend_url" web/sites/default/settings.php; then
  cat >> web/sites/default/settings.php <<'PHPEOF'

/**
 * Decoupled front end (nuxt_preview).
 *
 * Replace these development values before exposing this instance anywhere.
 * `host.docker.internal` is how the container reaches a dev server running on
 * the host; a deployed front end gets its real origin here.
 */
$settings['nuxt_frontend_url'] = 'http://host.docker.internal:3000';
$settings['nuxt_preview_secret'] = 'test-preview-secret';
$settings['nuxt_revalidate_secret'] = 'test-revalidate-secret';
PHPEOF
fi

echo "==> Creating sample content"
ddev drush php:script scripts/create-articles.php
ddev drush php:script scripts/create-menu-links.php

ddev drush cr

echo
echo "Done. Capture fixtures with:"
echo
echo "  cd .. && NUXT_DRUPAL_BASE_URL=\"\$(cd drupal && ddev describe -j | jq -r '.raw.urls[] | select(startswith(\"http://127\"))' | head -1)\" pnpm snapshot:content"
echo
ddev describe
