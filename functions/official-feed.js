/**
 * Public feed of newly published official office files.
 *
 * The feed is deliberately narrower than the tracker: one item per office
 * report file, no applicant rows, no inferred counts. JSON Feed 1.1 is the
 * canonical representation; RSS 2.0 is generated from the same entries for
 * readers and feed-to-Telegram relays.
 */

const FEED_LIMIT = 80;
const CACHE_SECONDS = 300;

const OFFICE_PAGES = {
  'new-delhi': 'https://www.ireland.ie/en/india/newdelhi/services/visas/processing-times-and-decisions/',
  beijing: 'https://www.ireland.ie/en/china/beijing/services/visas/visa-decisions/',
  dublin: 'https://www.ireland.ie/en/ireland/services/visas/visa-decisions/',
  'abu-dhabi': 'https://www.ireland.ie/en/uae/abudhabi/services/visas/weekly-decision-reports/',
  abuja: 'https://www.ireland.ie/en/nigeria/abuja/services/visas/weekly-decision-reports/',
  ankara: 'https://www.ireland.ie/en/turkiye/ankara/services/visas/weekly-decision-report/'
};

const OFFICE_NAMES = {
  'new-delhi': 'New Delhi',
  beijing: 'Beijing',
  dublin: 'Dublin',
  'abu-dhabi': 'Abu Dhabi',
  abuja: 'Abuja',
  ankara: 'Ankara'
};

function isoDate(value) {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

function safeSource(value) {
  const raw = String(value || '').trim();
  return /^https?:\/\//i.test(raw) ? raw : '';
}

function xmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function dateISO(value, fallback) {
  const date = new Date(String(value || ''));
  if (!Number.isNaN(date.getTime())) return date.toISOString();
  return fallback ? `${fallback}T12:00:00Z` : new Date(0).toISOString();
}

function formatDateLabel(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-IE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

/**
 * Build the canonical entries from data/reports/index.json and the manifest.
 * Pure so the feed can be tested without a Worker or an asset bucket.
 */
export function buildOfficialFeed(reportsDoc, options = {}) {
  const manifest = options.manifest || {};
  const manifestNames = new Map(
    (Array.isArray(manifest.offices) ? manifest.offices : [])
      .map((office) => [String(office.slug || ''), office.name || ''])
  );
  const seen = new Map();
  const offices = reportsDoc && reportsDoc.offices && typeof reportsDoc.offices === 'object'
    ? reportsDoc.offices
    : {};

  for (const [slug, entries] of Object.entries(offices)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const reportDate = isoDate(entry && entry.report_date);
      if (!reportDate) continue;
      const sourceFile = safeSource(entry && entry.source_file);
      const sourcePage = OFFICE_PAGES[slug] || '';
      if (!sourceFile && !sourcePage) continue;
      const checksum = String((entry && entry.checksum) || '').trim();
      const id = [slug, reportDate, checksum || sourceFile || sourcePage].join(':');
      if (seen.has(id)) continue;
      const fetchedAt = dateISO(entry && entry.fetched_at, reportDate);
      const decisions = Math.max(0, Number(entry && entry.decisions) || 0);
      const approved = Math.max(0, Number(entry && entry.approved) || 0);
      const refused = Math.max(0, Number(entry && entry.refused) || 0);
      seen.set(id, {
        id,
        office: slug,
        office_name: manifestNames.get(slug) || OFFICE_NAMES[slug] || slug,
        report_date: reportDate,
        fetched_at: fetchedAt,
        decisions,
        approved,
        refused,
        source_file: sourceFile,
        source_page: sourcePage,
        checksum,
        added: Number(entry && entry.added) || 0,
        removed: Number(entry && entry.removed) || 0,
        corrections: Array.isArray(entry && entry.changed) ? entry.changed.length : 0
      });
    }
  }

  const entries = [...seen.values()]
    .sort((a, b) => {
      if (a.report_date !== b.report_date) return a.report_date < b.report_date ? 1 : -1;
      return a.fetched_at < b.fetched_at ? 1 : a.fetched_at > b.fetched_at ? -1 : 0;
    })
    .slice(0, FEED_LIMIT);

  return {
    entries,
    generated_at: options.generatedAt || new Date().toISOString(),
    base_url: String(options.baseUrl || 'https://irishvisaupdatetracker.pages.dev').replace(/\/+$/, ''),
    channel_url: safeSource(options.channelUrl)
  };
}

export function buildJsonFeed(feed) {
  const base = feed.base_url;
  return {
    version: 'https://jsonfeed.org/version/1.1',
    title: 'Irish visa official file feed',
    home_page_url: `${base}/status`,
    feed_url: `${base}/official-file-feed.json`,
    description: 'One item per newly published official Irish visa office decision file. No applicant rows.',
    language: 'en',
    ...(feed.channel_url ? { _telegram_channel_url: feed.channel_url } : {}),
    items: feed.entries.map((entry) => {
      const label = formatDateLabel(entry.report_date);
      const source = entry.source_file || entry.source_page;
      return {
        id: entry.id,
        url: source,
        title: `${entry.office_name}: ${entry.decisions.toLocaleString('en-IE')} decisions — ${label}`,
        content_text: [
          `Office: ${entry.office_name}`,
          `Report date: ${label}`,
          `Decisions: ${entry.decisions.toLocaleString('en-IE')}`,
          `Approved: ${entry.approved.toLocaleString('en-IE')}`,
          `Refused: ${entry.refused.toLocaleString('en-IE')}`,
          entry.added ? `Added since previous report: ${entry.added}` : '',
          entry.removed ? `Removed since previous report: ${entry.removed}` : '',
          entry.corrections ? `Corrected rows: ${entry.corrections}` : '',
          `Observed by tracker: ${entry.fetched_at}`,
          `Official file: ${source}`,
          `Tracker: ${base}/status#office-coverage`
        ].filter(Boolean).join('\n'),
        // Readers expect pubDate to be the report's publication date. The
        // tracker's observation time is exposed separately instead of making
        // a file published on the 16th look published on the 17th.
        date_published: `${entry.report_date}T00:00:00.000Z`,
        _observed_at: entry.fetched_at,
        tags: ['official-file', entry.office],
        _official_file: {
          office: entry.office,
          office_name: entry.office_name,
          report_date: entry.report_date,
          decisions: entry.decisions,
          approved: entry.approved,
          refused: entry.refused,
          source_file: entry.source_file || null,
          source_page: entry.source_page || null,
          checksum: entry.checksum || null,
          added: entry.added,
          removed: entry.removed,
          corrections: entry.corrections
        }
      };
    })
  };
}

export function buildRssFeed(feed) {
  const base = feed.base_url;
  const items = feed.entries.map((entry) => {
    const label = formatDateLabel(entry.report_date);
    const source = entry.source_file || entry.source_page;
    const description = [
      `Office: ${entry.office_name}`,
      `Report date: ${label}`,
      `Decisions: ${entry.decisions.toLocaleString('en-IE')}`,
      `Approved: ${entry.approved.toLocaleString('en-IE')}`,
      `Refused: ${entry.refused.toLocaleString('en-IE')}`,
      entry.added ? `Added since previous report: ${entry.added}` : '',
      entry.removed ? `Removed since previous report: ${entry.removed}` : '',
      entry.corrections ? `Corrected rows: ${entry.corrections}` : '',
      `Observed by tracker: ${entry.fetched_at}`,
      `Official file: ${source}`,
      `Tracker: ${base}/status#office-coverage`
    ].filter(Boolean).join('\n');
    return [
      '    <item>',
      `      <title>${xmlEscape(`${entry.office_name}: ${entry.decisions.toLocaleString('en-IE')} decisions — ${label}`)}</title>`,
      `      <link>${xmlEscape(source)}</link>`,
      `      <guid isPermaLink="false">${xmlEscape(entry.id)}</guid>`,
      `      <pubDate>${xmlEscape(new Date(`${entry.report_date}T00:00:00Z`).toUTCString())}</pubDate>`,
      `      <category>${xmlEscape(entry.office_name)}</category>`,
      `      <description>${xmlEscape(description)}</description>`,
      '    </item>'
    ].join('\n');
  }).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    '    <title>Irish visa official file feed</title>',
    `    <link>${xmlEscape(`${base}/status`)}</link>`,
    '    <description>One item per newly published official Irish visa office decision file. No applicant rows.</description>',
    '    <language>en</language>',
    `    <lastBuildDate>${xmlEscape(new Date(feed.generated_at).toUTCString())}</lastBuildDate>`,
    `    <atom:link href="${xmlEscape(`${base}/feed.xml`)}" rel="self" type="application/rss+xml"/>`,
    items,
    '  </channel>',
    '</rss>',
    ''
  ].join('\n');
}

async function loadJson(env, request, path) {
  const url = new URL(path, request.url);
  try {
    if (env && env.ASSETS) {
      const response = await env.ASSETS.fetch(new Request(url, { headers: { Accept: 'application/json' } }));
      if (response.ok) return await response.json();
    }
  } catch (error) {
    console.warn(`Official feed asset read failed for ${path}:`, error.message);
  }
  try {
    const response = await fetch(url);
    if (response.ok) return await response.json();
  } catch (error) {
    console.warn(`Official feed fetch failed for ${path}:`, error.message);
  }
  return null;
}

export async function officialFeedResponse(env, request) {
  const pathname = new URL(request.url).pathname;
  const [reports, manifest] = await Promise.all([
    loadJson(env, request, '/data/reports/index.json'),
    loadJson(env, request, '/data/data_manifest.json')
  ]);
  const feed = buildOfficialFeed(reports, {
    manifest,
    baseUrl: env.APP_BASE_URL || new URL(request.url).origin,
    channelUrl: env.TELEGRAM_CHANNEL_URL
  });
  const isRss = pathname.endsWith('.xml');
  const body = isRss ? buildRssFeed(feed) : JSON.stringify(buildJsonFeed(feed), null, 2) + '\n';
  return new Response(request.method === 'HEAD' ? null : body, {
    status: 200,
    headers: {
      'Content-Type': isRss ? 'application/rss+xml; charset=utf-8' : 'application/feed+json; charset=utf-8',
      'Cache-Control': `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`,
      'X-Content-Type-Options': 'nosniff'
    }
  });
}
