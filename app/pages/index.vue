<script setup lang="ts">
/**
 * Placeholder home page. PR 4 replaces it with the Drupal-driven article
 * listing; it exists now so the scaffold has something to build, prerender and
 * smoke-test end to end.
 */
useHead({ title: 'nuxt-drupal-starter' });
</script>

<template>
  <main>
    <h1>nuxt-drupal-starter</h1>
    <p>
      Production-oriented Nuxt starter for decoupled Drupal: typed JSON:API,
      preview workflows, cache invalidation, Webform and media handling.
    </p>
    <p class="muted">Scaffold only — content layer lands in the next pull request.</p>
  </main>
</template>

<style scoped>
.muted {
  color: var(--muted);
}
</style>
