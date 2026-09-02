import { listArticles } from '../drupal/articles';
import { useDrupal } from '../utils/drupal';

/**
 * A sitemap built from Drupal's published content.
 *
 * Generated rather than hand-maintained, because the whole point of the CMS is
 * that a URL can appear without a deploy. A static sitemap in a decoupled setup
 * is stale the first time an editor publishes.
 *
 * Uses each article's Drupal alias, so the URLs here match the ones the site
 * actually serves — a sitemap listing paths that redirect is worse than none.
 */
export default defineEventHandler(async (event) => {
  const { client, siteUrl } = useDrupal(event);
  const { public: publicConfig } = useRuntimeConfig(event);
  const origin = publicConfig.siteUrl.replace(/\/+$/, '');

  // Cap rather than paginate: a sitemap index is the correct answer beyond a
  // few thousand URLs, and pretending otherwise would produce one enormous
  // document that search engines reject.
  const { items } = await listArticles(client, siteUrl, { limit: 50 });

  const urls = [
    { loc: `${origin}/`, lastmod: null },
    { loc: `${origin}/articles`, lastmod: null },
    ...items.map((article) => ({
      loc: `${origin}${article.path}`,
      lastmod: article.createdAt,
    })),
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    ({ loc, lastmod }) =>
      `  <url>\n    <loc>${escapeXml(loc)}</loc>${
        lastmod ? `\n    <lastmod>${escapeXml(lastmod)}</lastmod>` : ''
      }\n  </url>`,
  )
  .join('\n')}
</urlset>
`;

  setHeader(event, 'content-type', 'application/xml; charset=utf-8');
  setHeader(event, 'cache-control', 'public, max-age=3600');
  return body;
});

/**
 * Escape the five characters XML cannot carry raw.
 *
 * Titles and aliases come from editors, and an ampersand in a URL is enough to
 * make the whole document unparseable — at which point a search engine drops
 * every URL in it, not just the offending one.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
