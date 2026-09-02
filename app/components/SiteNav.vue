<script setup lang="ts">
import type { MenuItem } from '../../shared/domain';

/**
 * The site's primary navigation, rendered from Drupal.
 *
 * Two accessibility details that are easy to leave out and expensive to add
 * back once the markup is everywhere:
 *
 * - The list is wrapped in a `<nav>` with an accessible name. A page with more
 *   than one navigation landmark — primary, breadcrumb, footer — is
 *   unnavigable by screen reader if they are all just "navigation".
 * - `aria-current="page"` marks the active item. Styling the current link
 *   without it conveys the state by colour alone, which is exactly the failure
 *   the accessibility baseline exists to prevent.
 */
defineProps<{
  items: MenuItem[];
  label?: string;
}>();

const route = useRoute();

/** `true` when this link is the page currently being viewed. */
function isCurrent(url: string): boolean {
  return route.path === url;
}
</script>

<template>
  <nav :aria-label="label ?? 'Primary'">
    <ul class="menu">
      <li v-for="item in items" :key="item.id">
        <NuxtLink
          :to="item.url"
          :aria-current="isCurrent(item.url) ? 'page' : undefined"
        >
          {{ item.title }}
        </NuxtLink>

        <!-- Nested lists rather than a flattened one: the hierarchy an editor
             built in Drupal is information, and screen readers announce list
             nesting depth. -->
        <ul v-if="item.children.length" class="menu menu--child">
          <li v-for="child in item.children" :key="child.id">
            <NuxtLink
              :to="child.url"
              :aria-current="isCurrent(child.url) ? 'page' : undefined"
            >
              {{ child.title }}
            </NuxtLink>
          </li>
        </ul>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.menu {
  display: flex;
  flex-wrap: wrap;
  gap: 0 1.25rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.menu--child {
  flex-basis: 100%;
  gap: 0 1rem;
  margin-top: 0.35rem;
  padding-left: 0.9rem;
  border-left: 2px solid var(--rule);
  font-size: 0.9rem;
}

.menu a {
  display: inline-block;
  padding: 0.35rem 0;
  color: var(--ink);
  text-decoration: none;
  border-bottom: 2px solid transparent;
}

.menu a:hover {
  border-bottom-color: var(--rule);
}

/* The current page is marked by the attribute, so the styling and the
   accessible state cannot drift apart. */
.menu a[aria-current='page'] {
  color: var(--accent);
  border-bottom-color: var(--accent);
}
</style>
