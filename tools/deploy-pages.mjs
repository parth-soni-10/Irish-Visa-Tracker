/**
 * Deploy Pages Build Script
 * Builds the static assets and copies them to .pages-dist for Cloudflare Pages deployment
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
  'comparison.html',
  'contact.html',
  'daily-summaries.html',
  'employment-permit-processing-dates.html',
  'privacy.html',
  'terms.html',
  'refund.html',
  'admin.html',
  'monthly-report.html',
  'employer.html',
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
  'calendar-component.js',
  'dynamic-button.js',
  'filter-disclosure.js',
  'glide-select.js',
  'gooey-nav.js',
  'jelly-radio.js',
  'lucide.min.js',
  'rubber-segment.js',
  'scroll-island.js',
  'scroll-island-mount.js',
  'squish-switch.js',
  'stepper.js',
  'time-undo.js',
  'i18n.js',
  // CSS files
  'analytics-chart.css',
  'dynamic-button.css',
  'filter-disclosure.css',
  'glide-select.css',
  'gooey-nav.css',
  'jelly-radio.css',
  'rubber-segment.css',
  'scroll-island.css',
  'scroll-island-theme.css',
  'squish-switch.css',
  'stepper.css',
  'time-undo.css',
  'pages.css',
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
  
  console.log(`Build complete! Copied ${copied} files to ${outDir}`);
  console.log(`Output directory: ${distDir}`);
}

main().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});