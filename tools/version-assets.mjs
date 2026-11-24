#!/usr/bin/env node
/**
 * Version local static assets after the Pages build.
 *
 * Every CSS/JS/font/image URL gets one build-level `?v=<content hash>` value.
 * When any static asset changes, the hash changes and browsers fetch the new
 * URL; unchanged assets can then be served with an immutable cache policy.
 *
 * HTML and data files are deliberately excluded: HTML revalidates, and data
 * keeps its no-store policy so a deploy is visible on the next request.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSET_DIRS = ['styles', 'scripts', 'fonts', 'assets'];
const ROOT_ASSETS = new Set([
  '/analytics-chart.css',
  '/analytics-chart.js',
  '/pages.css',
  '/site-chrome.css',
  '/site-chrome.js',
  '/icon.svg',
  '/apple-touch-icon.png',
]);
const NON_VERSIONED = new Set([
  '/sw.js',
  '/manifest.json',
  '/sitemap.xml',
  '/robots.txt',
  '/llms.txt',
]);

function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(file, out);
    else out.push(file);
  }
  return out;
}

function hashableBuffer(file) {
  const buffer = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  if (ext !== '.css' && ext !== '.js') return buffer;
  // Make repeated runs idempotent: an existing ?v= is build metadata, not
  // source content.
  return buffer.toString('utf8').replace(/\?v=[a-f0-9]{6,}/g, '');
}

export function contentVersion(distDir) {
  const hash = crypto.createHash('sha256');
  const files = [];
  for (const dir of ASSET_DIRS) files.push(...walkFiles(path.join(distDir, dir)));
  for (const asset of ROOT_ASSETS) {
    const file = path.join(distDir, asset.replace(/^\//, ''));
    if (fs.existsSync(file)) files.push(file);
  }
  files.sort();
  for (const file of files) {
    hash.update(path.relative(distDir, file).split(path.sep).join('/'));
    hash.update('\0');
    hash.update(hashableBuffer(file));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 10);
}

export function shouldVersion(url) {
  if (!url || !url.startsWith('/') || url.startsWith('//')) return false;
  const clean = url.split(/[?#]/, 1)[0];
  if (!clean || clean.endsWith('.html') || clean.endsWith('.md')) return false;
  if (clean.startsWith('/data/') || NON_VERSIONED.has(clean)) return false;
  return clean.startsWith('/styles/')
    || clean.startsWith('/scripts/')
    || clean.startsWith('/fonts/')
    || clean.startsWith('/assets/')
    || ROOT_ASSETS.has(clean);
}

export function addVersion(url, version) {
  if (!shouldVersion(url)) return url;
  const hashIndex = url.indexOf('#');
  const fragment = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const withoutFragment = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const [base, query = ''] = withoutFragment.split('?');
  const params = new URLSearchParams(query);
  params.set('v', version);
  return `${base}?${params.toString()}${fragment}`;
}

function versionHtml(html, version) {
  return html.replace(
    /(\b(?:href|src)=")([^"]+)(")/gi,
    (match, before, url, after) => before + addVersion(url, version) + after,
  );
}

function versionCss(css, version) {
  return css.replace(
    /(url\(\s*['"]?)(\/[^'")]+)(['"]?\s*\))/gi,
    (match, before, url, after) => before + addVersion(url, version) + after,
  );
}

export function versionAssets(distDir = path.join(ROOT, '.pages-dist')) {
  const version = contentVersion(distDir);
  let htmlFiles = 0;
  let cssFiles = 0;

  const files = walkFiles(distDir);
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (ext !== '.html' && ext !== '.css') continue;
    const before = fs.readFileSync(file, 'utf8');
    const after = ext === '.html'
      ? versionHtml(before, version)
      : versionCss(before, version);
    if (after !== before) {
      fs.writeFileSync(file, after);
      if (ext === '.html') htmlFiles += 1;
      else cssFiles += 1;
    }
  }

  return { version, htmlFiles, cssFiles };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = versionAssets(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  console.log(`Asset version: ${result.version} (${result.htmlFiles} HTML, ${result.cssFiles} CSS files).`);
}
