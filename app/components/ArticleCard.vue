<script setup lang="ts">
import type { ArticleSummary } from '../../shared/domain';

defineProps<{ article: ArticleSummary }>();

/**
 * Format a Drupal timestamp for display.
 *
 * `Intl` rather than a date library: this is the whole requirement, and a
 * dependency for it would be 20 kB to save four lines.
 */
function formatDate(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat('en', { dateStyle: 'long' }).format(date);
}
</script>

<template>
  <article class="card">
    <!-- The image is decorative here: the heading beside it already carries
         the article's meaning, so repeating the alt text makes a screen reader
         announce the same thing twice. Drupal's alt is still used when the
         image stands alone, on the article page. -->
    <NuxtLink
v-if="article.image" :to="article.path" class="card__media" tabindex="-1"
              aria-hidden="true">
      <img
        :src="article.image.url"
        :width="article.image.width"
        :height="article.image.height"
        alt=""
        loading="lazy"
        decoding="async"
      >
    </NuxtLink>

    <div class="card__body">
      <h3 class="card__title">
        <NuxtLink :to="article.path">{{ article.title }}</NuxtLink>
      </h3>
      <p v-if="article.summary" class="card__summary">{{ article.summary }}</p>
      <!-- `datetime` carries the machine-readable value; the text is the human
           one. Without it the date is only parseable by guessing the locale. -->
      <time v-if="article.createdAt" :datetime="article.createdAt" class="card__date">
        {{ formatDate(article.createdAt) }}
      </time>
    </div>
  </article>
</template>

<style scoped>
.card {
  display: grid;
  grid-template-columns: minmax(0, 10rem) minmax(0, 1fr);
  gap: 1.25rem;
  padding: 1.25rem 0;
  border-bottom: 1px solid var(--rule);
}

@media (width < 34rem) {
  .card {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* The media column collapses when there is no image rather than leaving a gap,
   so a mixed listing does not look broken. */
.card:not(:has(.card__media)) {
  grid-template-columns: minmax(0, 1fr);
}

.card__media img {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 6px;
  /* Reserving the box from the intrinsic size keeps the list from jumping as
     lazy images arrive. */
  aspect-ratio: 16 / 9;
  object-fit: cover;
  background: var(--rule);
}

.card__title {
  margin: 0 0 0.4rem;
  font-size: 1.1rem;
  line-height: 1.35;
}

.card__title a {
  color: var(--ink);
  text-decoration: none;
}

.card__title a:hover {
  text-decoration: underline;
}

.card__summary {
  margin: 0 0 0.5rem;
  color: var(--muted);
}

.card__date {
  font-size: 0.85rem;
  color: var(--muted);
}
</style>
