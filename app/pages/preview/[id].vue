<script setup lang="ts">
import type { Article } from '../../../shared/domain';

/**
 * Preview of unpublished content.
 *
 * Deliberately looks different from the published article page. An editor
 * reviewing a draft should never be in doubt about which they are looking at —
 * a preview that renders identically to production is how "I thought it was
 * live" happens.
 */
const route = useRoute();

const { data: article, error } = await useFetch<Article>(
  () => `/api/preview/${route.params.id as string}`,
  {
    key: () => `preview-${String(route.params.id)}-${String(route.query.token ?? '')}`,
    query: computed(() => ({ token: route.query.token })),
  },
);

if (error.value || !article.value) {
  throw createError({
    statusCode: 404,
    statusMessage: 'This preview link is not valid, or has expired.',
    fatal: true,
  });
}

useHead(() => ({
  title: `Preview — ${article.value?.title ?? ''}`,
  meta: [
    // Belt and braces alongside the X-Robots-Tag header and robots.txt: three
    // independent mechanisms, because indexing a draft is not reversible on the
    // timescale anyone cares about.
    { name: 'robots', content: 'noindex, nofollow, noarchive' },
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
    <!-- `role="status"` rather than a plain div: a screen reader user needs to
         be told this is a draft, not left to infer it from a colour. -->
    <p class="banner" role="status">
      <strong>Preview</strong> — this is
      {{ article.published ? 'published content' : 'an unpublished draft' }}. It is not
      cached and not indexed.
    </p>

    <h1>{{ article.title }}</h1>

    <p v-if="article.createdAt" class="meta">
      <time :datetime="article.createdAt">{{ formatDate(article.createdAt) }}</time>
    </p>

    <img
      v-if="article.image"
      class="hero"
      :src="article.image.url"
      :alt="article.image.alt"
      :width="article.image.width"
      :height="article.image.height"
      decoding="async"
    >

    <!-- eslint-disable-next-line vue/no-v-html -->
    <div class="body" v-html="article.bodyHtml" />
  </article>
</template>

<style scoped>
.banner {
  margin: 0 0 2rem;
  padding: 0.75rem 1rem;
  border-left: 4px solid #b8860b;
  background: color-mix(in srgb, #b8860b 12%, transparent);
  font-size: 0.95rem;
}

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

.body :deep(img) {
  max-width: 100%;
  height: auto;
}
</style>
