<script setup lang="ts">
import type { ArticleSummary, Paginated } from '../../shared/domain';

/**
 * Home: the most recent published articles.
 *
 * `useFetch` rather than a client-side call so the list is rendered into the
 * HTML — a listing that only appears after hydration is invisible to a crawler
 * and shifts the layout on every visit.
 */
const { data, error } = await useFetch<Paginated<ArticleSummary>>('/api/articles', {
  key: 'home-articles',
  query: { limit: 5 },
});

const config = useRuntimeConfig();

useHead({
  title: 'nuxt-drupal-starter',
  meta: [
    {
      name: 'description',
      content:
        'Production-oriented Nuxt starter for decoupled Drupal: typed JSON:API, preview workflows and cache invalidation.',
    },
  ],
  link: [{ rel: 'canonical', href: config.public.siteUrl }],
});
</script>

<template>
  <div>
    <h1>Latest articles</h1>

    <!-- A failed listing is stated, not left as an empty page. `role="alert"`
         so a screen reader is told rather than left to discover it. -->
    <p v-if="error" role="alert" class="error">
      The article list could not be loaded.
    </p>

    <p v-else-if="!data?.items.length" class="muted">No articles published yet.</p>

    <template v-else>
      <ArticleCard v-for="article in data.items" :key="article.id" :article="article" />
      <p class="more">
        <NuxtLink to="/articles">All articles →</NuxtLink>
      </p>
    </template>
  </div>
</template>

<style scoped>
h1 {
  margin-top: 0;
}

.muted {
  color: var(--muted);
}

.error {
  padding: 0.75rem 1rem;
  border-left: 3px solid #c0392b;
  background: color-mix(in srgb, #c0392b 8%, transparent);
}

.more {
  margin-top: 1.5rem;
}
</style>
