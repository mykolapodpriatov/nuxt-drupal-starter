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
echo "==> Installing the nuxt_menu module"
mkdir -p web/modules/custom
cp -R modules/custom/nuxt_menu web/modules/custom/

echo "==> Enabling JSON:API (read-only)"
ddev drush en jsonapi -y
ddev drush config:set jsonapi.settings read_only true -y
ddev drush role:perm:add anonymous 'access content' -y

echo "==> Enabling the menu endpoint"
# Core JSON:API cannot expose menus to an unprivileged consumer — see
# docs/adr/003-menu-endpoint.md.
ddev drush en nuxt_menu -y

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
