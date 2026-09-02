<script setup lang="ts">
/**
 * Root shell. Deliberately thin: layout, navigation and page chrome arrive in
 * PR 4 together with the Drupal-driven menu, so nothing here has to be
 * unpicked once real content exists.
 */
</script>

<template>
  <div class="app">
    <NuxtRouteAnnouncer />
    <NuxtPage />
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
  padding: 3rem 1.25rem;
}

a {
  color: var(--accent);
}

/* A visible focus ring is part of the accessibility baseline, not a detail to
   add later — removing the default outline without a replacement is the most
   common way a Vue app becomes unusable by keyboard. */
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
