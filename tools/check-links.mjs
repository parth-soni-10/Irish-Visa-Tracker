#!/usr/bin/env node
/**
 * Internal link integrity check.
 *
 * Header and footer links are literal strings; a renamed route or a typo
 * currently ships silently. Crawl every page, collect internal hrefs, and
 * request each unique path from a local server (redirects followed).
 *
 *   node tools/check-links.mjs --base http://127.0.0.1:8788
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { PAGES } from './site-chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const BASE = argValue('--base', process.env.LINKS_BASE_URL || 'http://127.0.0.1:8788').replace(/\/+$/, '');

function internalTarget(href) {
  if (!href || !href.startsWith('/') || href.startsWith('//')) return null;
  const withoutHash = href.split('#')[0].split('?')[0];
  if (!withoutHash) return null;
  return withoutHash;
}

async function main() {
  const pages = PAGES.filter((page) => fs.existsSync(path.join(ROOT, page.file)));
  const links = new Map();

  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, page.file), 'utf8');
    const $ = cheerio.load(html);
    $('a[href]').each((_, element) => {
      const target = internalTarget($(element).attr('href'));
      if (!target) return;
      if (!links.has(target)) links.set(target, new Set());
      links.get(target).add(page.file);
    });
  }

  const failures = [];
  const targets = [...links.keys()].sort();

  for (const target of targets) {
    let response;
    try {
      response = await fetch(BASE + target, { redirect: 'follow' });
    } catch (error) {
      failures.push(`${target}: request failed (${error.message})`);
      continue;
    }
    if (response.status >= 400) {
      failures.push(`${target}: HTTP ${response.status} (linked from ${[...links.get(target)].join(', ')})`);
    }
  }

  // A skip link that points at a missing id is just as broken as a missing page.
  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, page.file), 'utf8');
    const $ = cheerio.load(html);
    $('a.skip-link').each((_, element) => {
      const href = $(element).attr('href') || '';
      if (!href.startsWith('#')) return;
      const id = href.slice(1);
      if (!$(`[id="${id}"]`).length) failures.push(`${page.file}: skip link targets #${id}, which does not exist`);
    });
  }

  if (failures.length) {
    console.error(failures.join('\n'));
    console.error(`${failures.length} internal link problem(s) found.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Internal links OK: ${targets.length} unique target(s) across ${pages.length} page(s).`);
}

main().catch((error) => {
  console.error('Link check failed: ' + error.message);
  process.exitCode = 1;
});
