/**
 * Deploy Pages Build Script
 * Builds the static assets and copies them to .pages-dist for Cloudflare Pages deployment
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { buildSearchFallback } from './build-search-fallback.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parse command line arguments
const args = process.argv.slice(2);
let assetsDir = '.';
let outDir = '.pages-dist';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--assets' && i + 1 < args.length) {
    assetsDir = args[i + 1];
    i++;
  } else if (args[i] === '--out' && i + 1 < args.length) {
    outDir = args[i + 1];
    i++;
  }
}

const rootDir = path.resolve(__dirname, '..');
const assetsRootDir = path.resolve(rootDir, assetsDir);
const distDir = path.resolve(rootDir, outDir);

// Files and directories to copy to .pages-dist
// Only includes files that actually exist
const assetsToCopy = [
  'index.html',
  '404.html',
  'about.html',
  'help.html',
  'comparison.html',
  'status.html',
  'contact.html',
  'daily-summaries.html',
  'employment-permit-processing-dates.html',
  'privacy.html',
  'terms.html',
  'admin.html',
  'monthly-report.html',

  'stamp-1g-processing-dates.html',
  'vac-transit.html',
  'visa-processing-times.html',
  '_headers',
  'manifest.json',
  'sw.js',
  'icon-72.png',
  'icon-96.png',
  'icon-128.png',
  'icon-144.png',
  'icon-152.png',
  'icon-192.png',
  'icon-384.png',
  'icon-512.png',
  'icon.svg',
  'apple-touch-icon.png',
  'og-image.png',
  'robots.txt',
  'sitemap.xml',
  'llms.txt',
  // JS modules
  'analytics-chart.js',
  'lucide.min.js',
  'site-chrome.js',
  // CSS files
  'analytics-chart.css',
  'pages.css',
  'site-chrome.css',
  // Data files
  'data/embassy-abu-dhabi.json',
  'data/embassy-abuja.json',
  'data/embassy-ankara.json',
  'data/embassy-beijing.json',
  'data/embassy-dublin.json',
  'data/embassy-new-delhi.json',
  'data/visa_meta.json',
  'data/visa_decisions.json',
  'data/stamp_1g.json',
  'data/work_permits.json',
  'data/community_timelines.json',
  'data/training_data.json',
];

// Directories to copy recursively
const dirsToCopy = [
  'data',
  'fonts',
  'scripts',
  'styles',
];

async function copyFile(src, dest) {
  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Copied: ${path.relative(rootDir, src)} -> ${path.relative(rootDir, dest)}`);
    return true;
  } else {
    console.warn(`Warning: File not found: ${path.relative(rootDir, src)}`);
    return false;
  }
}

async function copyDir(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, destPath);
        console.log(`Copied: ${path.relative(rootDir, srcPath)} -> ${path.relative(rootDir, destPath)}`);
      } else {
        console.warn(`Warning: File not found: ${path.relative(rootDir, srcPath)}`);
      }
    }
  }
}

function buildCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync('git rev-parse HEAD', { cwd: rootDir, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

// Keep the checked-in page modular for local development, but serve a single
// stylesheet and script in production. This removes 35 render/fetch requests
// from the tracker's first load without adding a framework or bundler.
function bundleIndexAssets() {
  const indexPath = path.resolve(distDir, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  const cssFiles = [];
  let cssInserted = false;
  html = html.replace(/<link\b[^>]*\brel="stylesheet"[^>]*>/gi, (tag) => {
    const match = tag.match(/\bhref="([^"]+)"/i);
    const file = localDistPath(match && match[1]);
    if (!file || !fs.existsSync(file)) return tag;
    cssFiles.push(file);
    if (cssInserted) return '';
    cssInserted = true;
    return '<link rel="stylesheet" href="/styles/index-bundle.css">';
  });
  if (cssFiles.length) {
    fs.writeFileSync(
      path.resolve(distDir, 'styles', 'index-bundle.css'),
      cssFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n')
    );
  }

  const scriptFiles = [];
  let scriptInserted = false;
  html = html.replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>/gi, (tag, href) => {
    const file = localDistPath(href);
    if (!file || !fs.existsSync(file)) return tag;
    scriptFiles.push(file);
    if (scriptInserted) return '';
    scriptInserted = true;
    return '<script src="/scripts/index-bundle.js" defer></script>';
  });
  if (scriptFiles.length) {
    fs.writeFileSync(
      path.resolve(distDir, 'scripts', 'index-bundle.js'),
      scriptFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n;\n')
    );
  }
  fs.writeFileSync(indexPath, html);
  console.log(`Bundled ${cssFiles.length} stylesheets and ${scriptFiles.length} scripts for index.html`);
}

function localDistPath(href) {
  if (!href || /^(?:[a-z]+:)?\/\//i.test(href) || href.startsWith('data:')) return null;
  const pathname = decodeURIComponent(href.split(/[?#]/)[0]).replace(/^\/+/, '');
  return path.resolve(distDir, pathname);
}

async function main() {
  console.log('Building for Cloudflare Pages...');
  
  // Clean and create .pages-dist directory
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
  fs.mkdirSync(distDir, { recursive: true });
  
  // Copy individual files
  let copied = 0;
  for (const file of assetsToCopy) {
    const src = path.resolve(assetsRootDir, file);
    const dest = path.resolve(distDir, file);
    if (fs.existsSync(src)) {
      await copyFile(src, dest);
      copied++;
    } else {
      console.warn(`Warning: File not found: ${file}`);
    }
  }
  
  // Record exactly which commit this tree represents. The post-deploy
  // verifier waits for this marker before comparing the live assets.
  fs.writeFileSync(
    path.resolve(distDir, 'build-info.json'),
    JSON.stringify({ commit: buildCommit(), built_at: new Date().toISOString() }, null, 2) + '\n'
  );

  // Cloudflare reserves /404.html and redirects it to /404. Keep that file
  // for Pages' own fallback, and publish an internal copy the Worker can
  // fetch without triggering the reserved-path redirect.
  if (await copyFile(path.resolve(assetsRootDir, '404.html'), path.resolve(distDir, '404-internal.html'))) {
    copied++;
  }

  // Copy directories
  for (const dir of dirsToCopy) {
    const src = path.resolve(assetsRootDir, dir);
    const dest = path.resolve(distDir, dir);
    if (fs.existsSync(src)) {
      await copyDir(src, dest);
    } else {
      console.warn(`Warning: Directory not found: ${dir}`);
    }
  }

  bundleIndexAssets();
  
  const fallback = buildSearchFallback({
    dataDir: path.resolve(assetsRootDir, 'data'),
    manifestPath: path.resolve(assetsRootDir, 'data', 'data_manifest.json'),
    outFile: path.resolve(distDir, 'data', 'search_fallback.json')
  });
  console.log(`Search fallback: ${fallback.rows} rows (${(fallback.bytes / 1024 / 1024).toFixed(2)} MiB)`);

  console.log(`Build complete! Copied ${copied} files to ${outDir}`);
  console.log(`Output directory: ${distDir}`);
}

main().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});