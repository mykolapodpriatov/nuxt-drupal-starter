<script setup lang="ts">
import type { ArticleSummary, Paginated } from '../../../shared/domain';

/**
 * The full article listing, paginated.
 *
 * The cursor lives in the URL rather than in component state so a page of
 * results is linkable, shareable and survives a reload — and so the back button
 * does what the reader expects.
 */
const route = useRoute();
const router = useRouter();

const offset = computed(() => {
  const raw = Number(route.query.offset);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
});

const PAGE_SIZE = 10;

const { data, error } = await useFetch<Paginated<ArticleSummary>>('/api/articles', {
  // The offset is in the key, so navigating between pages refetches rather
  // than serving the first page from cache.
  key: () => `articles-${offset.value}`,
  query: computed(() => ({ limit: PAGE_SIZE, offset: offset.value })),
});

function goTo(next: number): void {
  void router.push({ query: next > 0 ? { offset: String(next) } : {} });
}

useHead({ title: 'Articles' });
</script>

<template>
  <div>
    <h1>Articles</h1>

    <p v-if="error" role="alert" class="error">The article list could not be loaded.</p>

    <p v-else-if="!data?.items.length" class="muted">No articles found.</p>

    <template v-else>
      <ArticleCard v-for="article in data.items" :key="article.id" :article="article" />

      <nav class="pager" aria-label="Pagination">
        <button
          type="button"
          :disabled="offset === 0"
          @click="goTo(Math.max(0, offset - PAGE_SIZE))"
        >
          ← Newer
        </button>
        <button
          type="button"
          :disabled="!data.nextCursor"
          @click="goTo(Number(data.nextCursor))"
        >
          Older →
        </button>
      </nav>
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

.pager {
  display: flex;
  gap: 0.75rem;
  margin-top: 2rem;
}

.pager button {
  padding: 0.5rem 1rem;
  font: inherit;
  color: var(--ink);
  background: transparent;
  border: 1px solid var(--rule);
  border-radius: 4px;
  cursor: pointer;
}

.pager button:hover:not(:disabled) {
  border-color: var(--accent);
}

/* Disabled rather than hidden: a control that disappears moves the one beside
   it under the reader's cursor. */
.pager button:disabled {
  color: var(--muted);
  cursor: not-allowed;
  opacity: 0.6;
}
</style>
