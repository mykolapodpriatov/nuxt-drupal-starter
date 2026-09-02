<script setup lang="ts">
import type { Article } from '../../shared/domain';

/**
 * Any path Drupal owns.
 *
 * Editors set URL aliases, so an article lives at `/blog/hello` rather than at
 * a path this front end chose. Routing by pattern would mean the front end
 * dictating the site's URL structure, which is the opposite of what running a
 * CMS is for — so the page asks the backend what is at this path instead.
 */
const route = useRoute();
const config = useRuntimeConfig();

const { data, error } = await useFetch<{ type: 'article'; article: Article }>(
  '/api/resolve',
  {
    key: () => `resolve-${route.path}`,
    query: computed(() => ({ path: route.path })),
  },
);

// A path with nothing behind it must produce a real 404: the right status code
// for a crawler, and Nuxt's error page for the reader. Rendering an empty
// article body with a 200 is how dead URLs stay indexed.
if (error.value || !data.value) {
  throw createError({
    statusCode: 404,
    statusMessage: 'Page not found',
    fatal: true,
  });
}

const article = computed(() => data.value!.article);

const canonical = computed(() => `${config.public.siteUrl}${article.value.path}`);

useHead(() => ({
  title: article.value.title,
  meta: [
    { name: 'description', content: article.value.summary },
    { property: 'og:title', content: article.value.title },
    { property: 'og:description', content: article.value.summary },
    { property: 'og:type', content: 'article' },
    { property: 'og:url', content: canonical.value },
    ...(article.value.image ? [{ property: 'og:image', content: article.value.image.url }] : []),
  ],
  link: [{ rel: 'canonical', href: canonical.value }],
}));

// Structured data, so the article is eligible for a rich result rather than
// leaving a search engine to infer the headline and date from the markup.
useSeoMeta({});
useHead(() => ({
  script: [
    {
      type: 'application/ld+json',
      innerHTML: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: article.value.title,
        description: article.value.summary,
        ...(article.value.createdAt ? { datePublished: article.value.createdAt } : {}),
        ...(article.value.updatedAt ? { dateModified: article.value.updatedAt } : {}),
        ...(article.value.image ? { image: [article.value.image.url] } : {}),
        mainEntityOfPage: canonical.value,
      }),
    },
  ],
}));

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat('en', { dateStyle: 'long' }).format(date);
}
</script>

<template>
  <article v-if="article">
    <h1>{{ article.title }}</h1>

    <p v-if="article.createdAt" class="meta">
      <time :datetime="article.createdAt">{{ formatDate(article.createdAt) }}</time>
    </p>

    <!-- Standing alone, the image carries meaning, so Drupal's alt text is
         used rather than the empty alt the listing card uses. -->
    <img
      v-if="article.image"
      class="hero"
      :src="article.image.url"
      :alt="article.image.alt"
      :width="article.image.width"
      :height="article.image.height"
      decoding="async"
    >

    <!--
      `bodyHtml` is Drupal's `processed` output: the editor's input after the
      text format's filters have run. That is the same markup Drupal itself
      would render, and re-sanitising it here would strip legitimate embeds
      while adding no protection Drupal has not already applied.

      What makes this safe is upstream, in the mapper: `bodyHtml` never falls
      back to the raw `body.value`. See server/drupal/normalize.ts.
    -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div class="body" v-html="article.bodyHtml" />
  </article>
</template>

<style scoped>
h1 {
  margin-top: 0;
  line-height: 1.2;
}

.meta {
  margin-top: -0.5rem;
  color: var(--muted);
  font-size: 0.9rem;
}

.hero {
  display: block;
  width: 100%;
  height: auto;
  margin: 1.5rem 0;
  border-radius: 8px;
}

.body :deep(p) {
  margin: 1em 0;
}

.body :deep(code) {
  padding: 0.1em 0.35em;
  background: var(--rule);
  border-radius: 3px;
  font-size: 0.9em;
}

.body :deep(img) {
  max-width: 100%;
  height: auto;
}
</style>
