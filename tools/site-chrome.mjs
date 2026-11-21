#!/usr/bin/env node
/**
 * Single source of truth for the shared site header and footer.
 *
 * Every page carries the same chrome. Keeping 17 hand-maintained copies in
 * sync produced two incidents: a header that only broke on some pages, and a
 * punctuation fix that re-encoded seven files. This module owns the markup;
 * `--write` splices it into the pages between marker comments, and `--check`
 * (run by `npm run build` and CI) fails when a page drifts.
 *
 * The only per-page inputs are the current nav item, the skip-link target and
 * whether the Corrections link is offered. Nothing page-specific belongs in
 * the markup itself.
 *
 *   node tools/site-chrome.mjs --write   # regenerate the pages
 *   node tools/site-chrome.mjs --check   # fail if a page is stale
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_LINKS = {
  tracker: { href: '#visa-dash', label: 'Skip to tracker' },
  content: { href: '#main-content', label: 'Skip to content' },
};

const PRIMARY_LINKS = [
  { href: '/', label: 'Tracker' },
  { href: '/daily-summaries', label: 'Daily summaries' },
  { href: '/visa-processing-times', label: 'Processing times' },
  { href: '/about', label: 'About' },
];

const MORE_LINKS = [
  { href: '/status', label: 'Data status' },
  { href: '/monthly-report', label: 'Monthly report' },
  { href: '/data-study', label: 'Data study' },
  { href: '/reports', label: 'Report archive' },
  { href: '/when-are-visa-decisions-published', label: 'Publication schedule' },
  { href: '/stamp-1g-processing-dates', label: 'Stamp 1G' },
  { href: '/employment-permit-processing-dates', label: 'Employment permits' },
  { href: '/help', label: 'Help' },
  { href: '/contact', label: 'Contact' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
];

// Pages that offer the corrections ledger in the More panel. The link is
// deliberately scoped: it belongs with the reporting surfaces, not every page.
const CORRECTIONS_LINK = { href: '/corrections', label: 'Correction ledger' };

export const PAGES = [
  { file: 'index.html', route: '/', current: '/', skip: 'tracker' },
  // Office pages are part of the tracker section, so the primary Tracker
  // link stays current when a reader lands on one from search.
  { file: 'new-delhi-visa-decisions.html', route: '/new-delhi-visa-decisions', current: '/', skip: 'content' },
  { file: 'beijing-visa-decisions.html', route: '/beijing-visa-decisions', current: '/', skip: 'content' },
  { file: 'abu-dhabi-visa-decisions.html', route: '/abu-dhabi-visa-decisions', current: '/', skip: 'content' },
  { file: 'abuja-visa-decisions.html', route: '/abuja-visa-decisions', current: '/', skip: 'content' },
  { file: 'ankara-visa-decisions.html', route: '/ankara-visa-decisions', current: '/', skip: 'content' },
  { file: 'dublin-visa-decisions.html', route: '/dublin-visa-decisions', current: '/', skip: 'content' },
  { file: 'about.html', route: '/about', current: '/about', skip: 'content' },
  { file: 'admin.html', route: '/admin', current: null, skip: 'content' },
  { file: 'community-timelines.html', route: '/community-timelines', current: null, skip: 'content' },
  { file: 'data.html', route: '/data', current: null, skip: 'content' },
  { file: 'data-study.html', route: '/data-study', current: '/data-study', skip: 'content' },
  { file: 'embed.html', route: '/embed', current: null, skip: 'content' },
  { file: 'press.html', route: '/press', current: null, skip: 'content' },
  { file: 'reports.html', route: '/reports', current: '/reports', skip: 'content' },
  { file: 'when-are-visa-decisions-published.html', route: '/when-are-visa-decisions-published', current: '/when-are-visa-decisions-published', skip: 'content' },
  { file: 'contact.html', route: '/contact', current: '/contact', skip: 'content', corrections: true },
  { file: 'corrections.html', route: '/corrections', current: '/corrections', skip: 'content', corrections: true },
  { file: 'daily-summaries.html', route: '/daily-summaries', current: '/daily-summaries', skip: 'content' },
  {
    file: 'employment-permit-processing-dates.html',
    route: '/employment-permit-processing-dates',
    current: '/employment-permit-processing-dates',
    skip: 'content',
  },
  { file: 'help.html', route: '/help', current: '/help', skip: 'content' },
  { file: 'monthly-report.html', route: '/monthly-report', current: '/monthly-report', skip: 'content', corrections: true },
  { file: 'privacy.html', route: '/privacy', current: '/privacy', skip: 'content' },
  {
    file: 'stamp-1g-processing-dates.html',
    route: '/stamp-1g-processing-dates',
    current: '/stamp-1g-processing-dates',
    skip: 'content',
  },
  { file: 'status.html', route: '/status', current: '/status', skip: 'content' },
  { file: 'terms.html', route: '/terms', current: '/terms', skip: 'content' },
  { file: 'visa-processing-times.html', route: '/visa-processing-times', current: '/visa-processing-times', skip: 'content' },
  // `wrangler pages dev` answers unknown paths with its own not-found page and
  // ignores the checked-in 404.html, so this page is covered by --check rather
  // than by the live layout/audit matrices.
  { file: '404.html', route: '/404.html', current: null, skip: 'content', layout: false },
];

const HEADER_START = '<!-- site-chrome:start -->';
const HEADER_END = '<!-- site-chrome:end -->';
const FOOTER_START = '<!-- site-footer:start -->';
const FOOTER_END = '<!-- site-footer:end -->';

function currentAttr(page, href) {
  return page.current === href ? ' aria-current="page"' : '';
}

function navLink(page, { href, label }, indent) {
  return `${indent}<a href="${href}"${currentAttr(page, href)}>${label}</a>`;
}

/**
 * The header body, unindented. `render()` applies the page's indentation so a
 * regenerated block keeps the surrounding document layout.
 */
function headerLines(page) {
  // Keep the ledger with the other reporting links, before Contact.
  const moreLinks = page.corrections
    ? MORE_LINKS.flatMap((link) => (link.href === '/contact' ? [CORRECTIONS_LINK, link] : [link]))
    : MORE_LINKS;
  const moreCurrent = moreLinks.some((link) => link.href === page.current);
  const skip = SKIP_LINKS[page.skip];

  const lines = [
    HEADER_START,
    `<a class="skip-link" href="${skip.href}">${skip.label}</a>`,
    '<header class="sitebar">',
    '  <div class="sitebar-inner">',
    '    <a class="brand" href="/" aria-label="Irish Visa Decision Tracker home">',
    '      <img src="/icon.svg" alt="" width="24" height="24">',
    '      <span>Irish Visa Decision Tracker</span>',
    '    </a>',
    '    <nav class="sitebar-nav" aria-label="Site">',
    ...PRIMARY_LINKS.map((link) => navLink(page, link, '      ')),
    `      <details class="sitebar-more${moreCurrent ? ' is-current' : ''}">`,
    // The summary is a disclosure control, not the current page. Marking it
    // aria-current made screen readers announce two current pages in one nav.
    '        <summary>More</summary>',
    '        <div class="sitebar-more-panel">',
    ...moreLinks.map((link) => navLink(page, link, '          ')),
    '        </div>',
    '      </details>',
    '      <details class="sitebar-prefs">',
    '        <summary>Preferences</summary>',
    '        <div class="sitebar-more-panel sitebar-prefs-panel">',
    '          <div class="sitebar-pref-row">',
    '            <span class="sitebar-pref-label">Time zone</span>',
    '            <button class="sitebar-pref-button" type="button" data-time-mode-toggle data-mode="utc" aria-pressed="false">',
    '              <span data-time-mode-label>UTC</span>',
    '            </button>',
    '          </div>',
    '          <div class="sitebar-pref-row">',
    '            <span class="sitebar-pref-label">Theme</span>',
    '            <button class="sitebar-pref-button" type="button" data-theme-toggle aria-pressed="false">',
    '              <span data-theme-label>Light</span>',
    '            </button>',
    '          </div>',
    '          <label class="sitebar-pref-row" data-language-row hidden>',
    '            <span class="sitebar-pref-label">Language</span>',
    '            <select class="sitebar-pref-select" data-language-select aria-label="Language"></select>',
    '          </label>',
    '        </div>',
    '      </details>',
    '    </nav>',
    // A real mobile menu. The old header was a nowrap flex row, so at 390px
    // About, More and Preferences were clipped off-screen with no affordance.
    // This mirrors the same links (and the two preferences) in a scrollable
    // sheet, and the desktop nav is hidden below 980px.
    '    <details class="sitebar-mobile">',
    '      <summary><span class="sitebar-mobile-bars" aria-hidden="true"></span>Menu</summary>',
    '      <div class="sitebar-more-panel sitebar-mobile-panel">',
    '        <p class="sitebar-mobile-title">Tracker</p>',
    ...PRIMARY_LINKS.map((link) => navLink(page, link, '        ')),
    '        <p class="sitebar-mobile-title">More</p>',
    ...moreLinks.map((link) => navLink(page, link, '        ')),
    '        <p class="sitebar-mobile-title">Preferences</p>',
    '        <div class="sitebar-pref-row">',
    '          <span class="sitebar-pref-label">Time zone</span>',
    '          <button class="sitebar-pref-button" type="button" data-time-mode-toggle data-mode="utc" aria-pressed="false">',
    '            <span data-time-mode-label>UTC</span>',
    '          </button>',
    '        </div>',
    '        <div class="sitebar-pref-row">',
    '          <span class="sitebar-pref-label">Theme</span>',
    '          <button class="sitebar-pref-button" type="button" data-theme-toggle aria-pressed="false">',
    '            <span data-theme-label>Light</span>',
    '          </button>',
    '        </div>',
    '      </div>',
    '    </details>',
    '  </div>',
    '</header>',
    HEADER_END,
  ];
  return lines;
}

function footerLines() {
  return [
    FOOTER_START,
    '<footer class="sitebar-footer">',
    '  <div class="sitebar-footer-inner">',
    '    <div class="sitebar-footer-brand">',
    '      <a class="brand" href="/" aria-label="Irish Visa Decision Tracker home">',
    '        <img src="/icon.svg" alt="" width="24" height="24">',
    '        <span>Irish Visa Decision Tracker</span>',
    '      </a>',
    '      <p>Independent and unofficial. Not immigration advice.</p>',
    '    </div>',
    '    <div class="sitebar-footer-col">',
    '      <p class="sitebar-footer-title">Data</p>',
    '      <ul>',
    '        <li><a href="/status">Data status</a></li>',
    '        <li><a href="/data">Open data</a></li>',
    '        <li><a href="/about#method">Method &amp; sources</a></li>',
    '        <li><a href="/monthly-report">Monthly report</a></li>',
    '        <li><a href="/data-study">Data study</a></li>',
    '        <li><a href="/reports">Report archive</a></li>',
    '        <li><a href="/when-are-visa-decisions-published">Publication schedule</a></li>',
    '        <li><a href="/press">Press &amp; citation</a></li>',
    '        <li><a href="/embed">Embed badge</a></li>',
    '      </ul>',
    '    </div>',
    '    <div class="sitebar-footer-col">',
    '      <p class="sitebar-footer-title">Trackers</p>',
    '      <ul>',
    '        <li><a href="/stamp-1g-processing-dates">Stamp 1G</a></li>',
    '        <li><a href="/employment-permit-processing-dates">Employment permits</a></li>',
    '        <li><a href="/new-delhi-visa-decisions">New Delhi decisions</a></li>',
    '        <li><a href="/beijing-visa-decisions">Beijing decisions</a></li>',
    '        <li><a href="/abu-dhabi-visa-decisions">Abu Dhabi decisions</a></li>',
    '        <li><a href="/abuja-visa-decisions">Abuja decisions</a></li>',
    '        <li><a href="/ankara-visa-decisions">Ankara decisions</a></li>',
    '        <li><a href="/dublin-visa-decisions">Dublin decisions</a></li>',
    '      </ul>',
    '    </div>',
    '    <div class="sitebar-footer-col">',
    '      <p class="sitebar-footer-title">Legal</p>',
    '      <ul>',
    '        <li><a href="/help">Help</a></li>',
    '        <li><a href="/contact">Contact</a></li>',
    '        <li><a href="/privacy">Privacy</a></li>',
    '        <li><a href="/terms">Terms</a></li>',
    '        <li><a href="https://github.com/parth-soni-10/Irish-Visa-Tracker" rel="noopener">GitHub</a></li>',
    '      </ul>',
    '    </div>',
    '  </div>',
    '  <div class="sitebar-footer-bottom">',
    '    <p>&copy; 2026 Parth Soni &middot; Dublin, Ireland</p>',
    '  </div>',
    '</footer>',
    FOOTER_END,
  ];
}

function render(lines, indent, eol) {
  return lines
    .map((line) => (line ? indent + line : ''))
    .join(eol);
}

function eolFor(content) {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function detectIndent(content) {
  const match = content.match(/(?:^|\n)([ \t]*)<a class="skip-link"/);
  return match ? match[1] : '  ';
}

function splice(content, page) {
  const eol = eolFor(content);
  const indent = detectIndent(content);
  const header = render(headerLines(page), indent, eol);
  const footer = render(footerLines(), indent, eol);

  let next = content;
  if (next.includes(HEADER_START)) {
    next = next.replace(/[ \t]*<!-- site-chrome:start -->[\s\S]*?<!-- site-chrome:end -->/, header);
  } else {
    const existing = /[ \t]*<a class="skip-link"[\s\S]*?<\/header>/;
    if (!existing.test(next)) throw new Error('no skip link and header found to replace');
    next = next.replace(existing, header);
  }

  if (next.includes(FOOTER_START)) {
    next = next.replace(/[ \t]*<!-- site-footer:start -->[\s\S]*?<!-- site-footer:end -->/, footer);
  } else {
    const existing = /[ \t]*<footer class="sitebar-footer">[\s\S]*?<\/footer>/;
    if (!existing.test(next)) throw new Error('no footer found to replace');
    next = next.replace(existing, footer);
  }
  return next;
}

/**
 * Structural checks that the generated output must satisfy. These are cheap
 * invariants, not a second copy of the tests: exactly one current page inside
 * the Site nav, and a skip-link target that actually exists on the page.
 */
function validate(content, page) {
  const problems = [];
  const nav = content.match(/<nav class="sitebar-nav"[\s\S]*?<\/nav>/);
  if (!nav) {
    problems.push('no Site nav');
  } else {
    const marked = [...nav[0].matchAll(/aria-current="page"/g)].length;
    const expected = page.current ? 1 : 0;
    if (marked !== expected) {
      problems.push(`expected ${expected} aria-current="page" in nav, found ${marked}`);
    }
  }
  const target = SKIP_LINKS[page.skip].href.slice(1);
  if (!content.includes(`id="${target}"`)) {
    problems.push(`skip link targets #${target}, which is missing from the page`);
  }
  return problems;
}

/** Splice the canonical header and footer into a page (used by build-time generators). */
export function spliceChrome(content, page) {
  return splice(content, page);
}

function main() {
  const mode = process.argv.includes('--write') ? 'write' : 'check';
  const failures = [];
  let changed = 0;

  for (const page of PAGES) {
    const file = path.join(ROOT, page.file);
    if (!fs.existsSync(file)) {
      failures.push(`${page.file}: listed page does not exist`);
      continue;
    }
    const before = fs.readFileSync(file, 'utf8');
    let after;
    try {
      after = splice(before, page);
    } catch (error) {
      failures.push(`${page.file}: ${error.message}`);
      continue;
    }

    for (const problem of validate(after, page)) failures.push(`${page.file}: ${problem}`);

    if (after !== before) {
      changed += 1;
      if (mode === 'write') fs.writeFileSync(file, after);
      else failures.push(`${page.file}: shared header/footer is stale (run npm run chrome:sync)`);
    }
  }

  const pagesOnDisk = fs
    .readdirSync(ROOT)
    .filter((name) => name.endsWith('.html'))
    .sort();
  for (const name of pagesOnDisk) {
    if (!PAGES.some((page) => page.file === name)) failures.push(`${name}: not registered in tools/site-chrome.mjs`);
  }

  if (mode === 'write') {
    console.log(`Shared chrome written to ${changed} of ${PAGES.length} page(s).`);
  } else if (!failures.length) {
    console.log(`Shared chrome is in sync across ${PAGES.length} pages.`);
  }

  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
