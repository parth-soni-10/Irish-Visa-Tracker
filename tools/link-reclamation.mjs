#!/usr/bin/env node
/**
 * Link reclamation check.
 *
 * The cheapest link a site can earn is one the writer already intended to
 * give: a page names "Irish Visa Decision Tracker" or quotes a figure from the
 * data study but never links back. This tool takes a list of candidate URLs,
 * fetches each one and reports whether it links to the site, merely mentions
 * it, does not mention it, or could not be read. It changes nothing and sends
 * nothing; the fix is a short, specific email to the page's author.
 *
 *   node tools/link-reclamation.mjs                 # check data/link-reclamation.json
 *   node tools/link-reclamation.mjs --out=report.json
 *
 * Candidates are added by hand from a search for the project name, the study
 * title, or the site host. The file starts empty because inventing mentions
 * would make the report worthless.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SITE_ORIGIN } from './site-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FILE = path.join(ROOT, 'data', 'link-reclamation.json');

export const MENTION_PATTERNS = [
  'Irish Visa Decision Tracker',
  'Irish Visa Update Tracker',
  'Irish visa decision tracker',
  'irishvisaupdatetracker',
];

function hostVariants(origin) {
  const url = new URL(origin);
  const bare = url.host.replace(/^www\./, '');
  return [bare, `www.${bare}`, url.hostname];
}

/**
 * Classify one page.
 *   linked   - an anchor points at the site
 *   unlinked - the page names the project or quotes the host without a link
 *   none     - neither
 */
export function classifyMention(html, origin = SITE_ORIGIN) {
  const source = String(html || '');
  const hosts = hostVariants(origin);
  const anchorPattern = new RegExp(`<a\\b[^>]*href=["']([^"']+)["']`, 'gi');
  for (const match of source.matchAll(anchorPattern)) {
    const href = match[1];
    if (!/^https?:\/\//i.test(href)) continue;
    try {
      const target = new URL(href);
      if (hosts.includes(target.hostname.replace(/^www\./, '')) || hosts.includes(target.hostname)) {
        return { status: 'linked', detail: href };
      }
    } catch { /* an unparsable href is not a link to this site */ }
  }
  const text = source.replace(/<[^>]+>/g, ' ');
  const named = MENTION_PATTERNS.find((pattern) => text.toLowerCase().includes(pattern.toLowerCase()));
  const hostMention = hosts.find((host) => text.toLowerCase().includes(host.toLowerCase()));
  if (named || hostMention) {
    return { status: 'unlinked', detail: named || hostMention };
  }
  return { status: 'none', detail: '' };
}

async function fetchPage(url, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'IrishVisaDecisionTracker link-reclamation check (+https://irishvisaupdatetracker.pages.dev/about)' },
    });
    const type = response.headers.get('content-type') || '';
    if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}` };
    if (!/text\/html|application\/xhtml/i.test(type)) return { ok: false, status: response.status, error: `not HTML (${type || 'unknown type'})` };
    return { ok: true, status: response.status, html: await response.text() };
  } catch (error) {
    return { ok: false, status: 0, error: error && error.name === 'AbortError' ? 'timed out' : String(error && error.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Check every candidate. An unreachable page is reported as such, never
 *  counted as a missing link. */
export async function auditMentions(candidates, { origin = SITE_ORIGIN, fetchImpl, timeoutMs } = {}) {
  const rows = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const url = typeof candidate === 'string' ? candidate : candidate && candidate.url;
    if (!/^https?:\/\//i.test(String(url || ''))) {
      rows.push({ url: String(url || ''), status: 'invalid', detail: 'not an http(s) URL' });
      continue;
    }
    const page = await fetchPage(url, { fetchImpl, timeoutMs });
    if (!page.ok) {
      rows.push({ url, status: 'unreachable', detail: page.error || `HTTP ${page.status}` });
      continue;
    }
    const result = classifyMention(page.html, origin);
    rows.push({ url, status: result.status, detail: result.detail, note: typeof candidate === 'object' && candidate ? candidate.note || '' : '' });
  }
  return {
    origin,
    checked: rows.length,
    linked: rows.filter((row) => row.status === 'linked').length,
    unlinked: rows.filter((row) => row.status === 'unlinked').length,
    unreachable: rows.filter((row) => row.status === 'unreachable').length,
    rows,
  };
}

export function loadCandidates(file = DEFAULT_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed.candidates) ? parsed.candidates : [];
  } catch {
    return [];
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const fileArg = process.argv.find((arg) => arg.startsWith('--file='));
  const outArg = process.argv.find((arg) => arg.startsWith('--out='));
  const candidates = loadCandidates(fileArg ? path.resolve(fileArg.slice('--file='.length)) : DEFAULT_FILE);
  if (!candidates.length) {
    console.log('Link reclamation: no candidate URLs recorded in data/link-reclamation.json.');
    console.log('Add pages that mention the project without linking, then rerun. See docs/link-building.md.');
  } else {
    const result = await auditMentions(candidates);
    for (const row of result.rows) {
      console.log(`${row.status.padEnd(12)} ${row.url}${row.detail ? ` — ${row.detail}` : ''}`);
    }
    console.log(`Link reclamation: ${result.checked} checked, ${result.linked} linked, ${result.unlinked} unlinked mention(s), ${result.unreachable} unreachable.`);
    if (outArg) {
      fs.writeFileSync(path.resolve(outArg.slice('--out='.length)), `${JSON.stringify(result, null, 2)}\n`);
    }
  }
}
