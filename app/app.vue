<script setup lang="ts">
/**
 * Root shell: skip link, Drupal-driven navigation, page outlet.
 *
 * The navigation is fetched here rather than per page so it is requested once
 * per navigation, during SSR, and every route inherits it without repeating
 * the call.
 */
const { data: menu } = await useMenu('main');
</script>

<template>
  <div class="app">
    <NuxtRouteAnnouncer />

    <!-- First focusable element on the page. Without it, a keyboard user
         tabs through the whole navigation on every single page before
         reaching the content. -->
    <a class="skip-link" href="#main">Skip to content</a>

    <header class="masthead">
      <NuxtLink to="/" class="brand">nuxt-drupal-starter</NuxtLink>
      <SiteNav :items="menu?.items ?? []" />
    </header>

    <main id="main" tabindex="-1">
      <NuxtPage />
    </main>
  </div>
</template>

<style>
:root {
  --ink: #16181d;
  --paper: #fff;
  --muted: #5b6472;
  --rule: #e3e6ea;
  --accent: #0b5fff;
}

@media (prefers-color-scheme: dark) {
  :root {
    --ink: #e8eaee;
    --paper: #101216;
    --muted: #98a1b0;
    --rule: #262a31;
    --accent: #6f9bff;
  }
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font: 16px/1.6 system-ui, -apple-system, 'Segoe UI', sans-serif;
}

.app {
  max-width: 46rem;
  margin: 0 auto;
  padding: 2rem 1.25rem 4rem;
}

a {
  color: var(--accent);
}

/* A visible focus ring is part of the accessibility baseline, not a detail to
   add later — removing the default outline without a replacement is the most
   common way an app becomes unusable by keyboard. */
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* Off-screen until focused, rather than `display: none`, which would remove it
   from the tab order entirely and defeat the purpose. */
.skip-link {
  position: absolute;
  left: -9999px;
  padding: 0.5rem 0.9rem;
  background: var(--accent);
  color: #fff;
  border-radius: 0 0 4px 0;
}

.skip-link:focus {
  left: 0;
  top: 0;
  z-index: 10;
}

.masthead {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.75rem 2rem;
  padding-bottom: 1rem;
  margin-bottom: 2.5rem;
  border-bottom: 1px solid var(--rule);
}

.brand {
  font-weight: 600;
  color: var(--ink);
  text-decoration: none;
}

/* `main` carries tabindex="-1" so the skip link can move focus to it; that
   would otherwise draw a focus ring around the entire page. */
main:focus {
  outline: none;
}
</style>
