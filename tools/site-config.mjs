/**
 * The site's canonical origin.
 *
 * Every generated canonical, Open Graph URL, JSON-LD @id and sitemap entry
 * should come from here. The default is the current pages.dev deployment;
 * setting `SITE_ORIGIN` during a build moves all generated output to a custom
 * domain without a second code change.
 *
 *   SITE_ORIGIN=https://example.ie npm run build
 */

export const DEFAULT_SITE_ORIGIN = 'https://irishvisaupdatetracker.pages.dev';

export function siteOrigin(env = process.env) {
  const raw = String(env.SITE_ORIGIN || env.SITE_URL || '').trim();
  if (!raw) return DEFAULT_SITE_ORIGIN;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return DEFAULT_SITE_ORIGIN;
    if (url.pathname !== '/' || url.search || url.hash) return DEFAULT_SITE_ORIGIN;
    return url.origin;
  } catch {
    return DEFAULT_SITE_ORIGIN;
  }
}

export const SITE_ORIGIN = siteOrigin();
