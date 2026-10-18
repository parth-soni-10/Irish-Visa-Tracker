/* Irish Visa Tracker — the app.
 *
 * Four screens: the landing overview, the embassy decisions tracker (Home /
 * Daily summary / Past results / Suggestions), Stamp 1G and employment permits.
 * The URL stays the contract the old app had: `?tracker=&tab=&q=&date=`, plus
 * `popstate` restoring it. Tab and tracker changes push a history entry;
 * search and date edits replace the current one.
 *
 * Everything renders through class-only components (see components.js) so the
 * strict `style-src 'self'` policy holds. The only colours that are not the
 * neutral blue accent are decision states.
 */
import * as C from './core.js';
import * as U from './components.js';

const view = document.getElementById('view');
const main = document.getElementById('main');
const live = document.getElementById('live');
const PAGE = 60;

const TRACKERS = [
  { id: 'home', label: 'Overview' },
  { id: 'visa', label: 'Visa decisions' },
  { id: '1g', label: 'Stamp 1G' },
  { id: 'permits', label: 'Permits' },
];
const TABS = [
  { id: 'home', label: 'Home' },
  { id: 'daily', label: 'Daily summary' },
  { id: 'past', label: 'Past results' },
  { id: 'suggest', label: 'Suggestions' },
];
const DECISIONS = [
  { value: 'all', label: 'All decisions' },
  { value: 'accepted', label: 'Granted' },
  { value: 'rejected', label: 'Refused' },
  { value: 'other', label: 'Other / pending' },
];

/* The Hairline figure's handle, so a re-render destroys the previous mount
 * instead of leaving a second frame loop registered. */
let runwayHandle = null;

const ui = {
  limit: PAGE,
  feedback: { state: 'idle', message: '' },
  rating: '',
  lastVisit: Number(localStorage.getItem('visa-last-visit') || '0') || 0,
  visited: false,
  undo: null,
  timeline: { outcome: 'granted', form: 'visa' },
  submitBusy: false,
  notices: new Set(),
};

/* -------------------------------------------------------------------- boot -- */

boot();

async function boot() {
  document.getElementById('theme-switch').innerHTML = U.switchMode(C.state.theme);
  wireGlobalEvents();
  await Promise.all([C.loadVisa(), C.loadMeta()]);
  C.loadTrackers().then(() => { if (['1g', 'permits'].includes(C.state.tracker) || C.state.tracker === 'home') render(); });
  await render();
  markVisited();
  loadAdmin();
  registerServiceWorker();
  setInterval(async () => {
    const before = C.data.rows.length;
    await C.loadVisa({ force: true });
    if (C.data.rows.length !== before) renderAll({ announce: 'Data refreshed.' });
  }, 5 * 60 * 1000);
}

/* ------------------------------------------------------------------ render -- */

function renderAll({ announce = '', focus = false } = {}) {
  document.getElementById('theme-switch').innerHTML = U.switchMode(C.state.theme);
  document.documentElement.setAttribute('data-theme', C.state.theme);
  paintNav();
  render();
  if (announce) live.textContent = announce;
  if (focus) {
    const heading = view.querySelector('h1');
    if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
  }
  paintIslands();
}

async function render() {
  paintNav();
  document.getElementById('admin-chip').hidden = !C.state.admin;
  const renderers = { home: renderLanding, visa: renderVisa, '1g': renderG1, permits: renderPermits };
  view.innerHTML = (renderers[C.state.tracker] || renderLanding)();
  afterRender();
}

function paintNav() {
  document.getElementById('tracker-nav').innerHTML = U.gooeyNav(TRACKERS, C.state.tracker);
}

function afterRender() {
  animateCounters();
  // The overview's empty state owns a Hairline figure: mount it after the
  // markup exists, and tear the last one down so its frame loop is gone.
  if (runwayHandle) { runwayHandle.destroy(); runwayHandle = null; }
  if (document.getElementById('visa-runway')) {
    runwayHandle = window.mountHairline('visa-runway', 0);
  }
  paintFundBars();
  const stamp = document.getElementById('footer-stamp');
  if (stamp && C.data.meta?.lastRunAt) stamp.textContent = `Last scrape ${C.data.meta.lastRunAt.replace('T', ' ')} IST · data published by the offices above`;
  if (C.data.staleAt) {
    const banner = document.getElementById('stale-slot');
    if (banner) banner.innerHTML = staleBanner();
  }
  wireInfiniteScroll();
  wireTimeline();
  paintDailyDetail();
  loadAdmin();
}

function staleBanner() {
  const when = new Date(C.data.staleAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return `<div class="stale-banner" role="status">Showing data from ${when}. Live refresh failed.
    ${U.dynamicButton({ id: 'stale-retry', label: 'Retry now', action: 'retry-live', variant: 'quiet', iconName: 'share' })}</div>`;
}

/* ---------------------------------------------------------------- landing -- */

function renderLanding() {
  const stats = C.visaStats(C.data.rows);
  const status = C.publishStatus(C.data.rows);
  const since = C.sinceLastVisit(C.data.rows, ui.lastVisit);
  const watchRows = C.realRows(C.data.rows).filter((row) => C.state.watchlist.some((term) => String(row.irl).includes(term))).slice(0, 5);
  const latest = C.realRows(C.data.rows).slice(0, 5);
  const meta = C.data.meta;
  const order = [C.state.primaryTracker, ...['visa', '1g', 'permits'].filter((id) => id !== C.state.primaryTracker)];
  const cards = order.map(trackerCard).join('');

  return `
  ${U.scrollIsland('home', [{ id: 'search', label: 'Search' }, { id: 'trackers', label: 'Trackers' }, { id: 'watch', label: 'Watchlist' }, { id: 'health', label: 'Health' }], 'Overview')}
  <section class="hero" id="home-search" aria-labelledby="home-title">
    <p class="eyebrow">Embassy of Ireland · New Delhi</p>
    <h1 id="home-title">Irish visa decisions, read from the source every day.</h1>
    <p class="lede">Every application number the embassy publishes, the daily volumes behind them, and the processing-date trend for Stamp 1G and employment permits. Unofficial, and checked against the published sheets — never a guess.</p>
    <div class="status-stack">
      ${U.statusLine(status.tone, status.text)}
      ${since ? U.statusLine('live', `Since you last checked (${since.when}): <strong>${since.newCount ?? since.count} new decision${since.count === 1 ? '' : 's'}</strong>${since.refused ? ` · ${since.refused} refused` : ''}.`) : ''}
    </div>
    <div id="stale-slot"></div>
    <form class="search-bar" id="home-search-form" role="search" data-action="search-form">
      ${U.skiper68({ id: 'home-q', label: 'Search by application number', value: C.state.q, placeholder: 'Enter your application number…', digits: 6, maxlength: 12 })}
      ${U.dynamicButton({ id: 'home-track', label: ui.trackBusy ? 'Tracking…' : 'Track', action: 'track', variant: 'primary', iconName: 'arrow' })}
    </form>
    <div class="recent-row" id="recent-row">${recentChips()}</div>
  </section>

  <section class="counters" aria-label="Headline numbers">
    ${U.animatedCounter({ id: 'c-record', value: meta?.sheetRows ?? stats.total, label: 'Decisions on record', hint: 'Every application number the embassy has published, since the tracker began. The sheet figure comes from the scraper’s own reconciliation, so it also counts rows older than this page keeps.' })}
    ${U.animatedCounter({ id: 'c-today', value: stats.latestCount, label: `Latest file (${stats.latestDate ? C.fmtShort(stats.latestDate) : 'awaiting data'})`, hint: 'The most recent day that actually contained decisions. A day whose file has not been uploaded renders as a notice, not a zero.' })}
    ${U.animatedCounter({ id: 'c-acc', value: stats.acceptanceRate * 100, label: 'Acceptance rate', hint: 'Granted ÷ every recorded decision, all-time. Placeholder notices are excluded — they are not applications.', suffix: '%' , format: (n) => n.toFixed(1) })}
    ${U.animatedCounter({ id: 'c-avg', value: stats.avgPerDay, label: 'Average per published day', hint: 'Mean decisions per day that published a file. Days with no upload are excluded so an embassy closure does not read as a slow day.', format: (n) => n.toFixed(1) })}
  </section>

  ${C.data.rows.length ? '' : `<section class="section" id="home-empty" aria-labelledby="empty-title">
    <div class="section-head"><div><p class="eyebrow">Before the first file</p><h2 id="empty-title">Awaiting data…</h2></div></div>
    <div class="card hairline-card">
      <div class="hairline-figure" id="visa-runway"></div>
      <p class="hairline-read" data-hairline-read aria-live="polite">rest</p>
      <p class="hint">The plane stands at the threshold until the first file lands. Each gate is one tracker: <strong>embassy decisions</strong>, then <strong>Stamp 1G</strong>, then <strong>employment permits</strong>. Point at a gate to see where the plane would stand; nothing here is a prediction.</p>
    </div>
  </section>`}

  <section class="section" id="home-trackers" aria-labelledby="trackers-title">
    <div class="section-head">
      <div><p class="eyebrow">Trackers</p><h2 id="trackers-title">What is moving</h2></div>
      ${U.jellyRadio('primary-tracker', 'Primary tracker', [
        { value: 'visa', label: 'Visa decisions' },
        { value: '1g', label: 'Stamp 1G' },
        { value: 'permits', label: 'Permits' },
      ], C.state.primaryTracker)}
    </div>
    ${U.fundWidget('tracker-fund', fundItems())}
    <div class="tracker-grid">${cards}</div>
  </section>

  <section class="section" id="home-watch" aria-labelledby="watch-title">
    <div class="section-head">
      <div><p class="eyebrow">Watchlist</p><h2 id="watch-title">Application numbers you follow</h2></div>
      ${U.timeUndoAction({ id: 'watchlist-clear', label: 'Clear watchlist', disabled: !C.state.watchlist.length })}
    </div>
    ${U.transactionList('watchlist', watchRows.map(watchRow), 'Nothing watched yet. Search an application number above to add it — up to ten.')}
    ${watchRows.length ? '<p class="hint">Swipe a row (or use its actions button) to remove it. Removal is immediate and undoable for a few seconds.</p>' : ''}
  </section>

  <section class="section" id="home-latest" aria-labelledby="latest-title">
    <div class="section-head"><div><p class="eyebrow">Newest first</p><h2 id="latest-title">Latest decisions</h2></div>
      ${U.dynamicButton({ id: 'latest-open', label: 'Open full history', action: 'go-past', variant: 'quiet' })}
    </div>
    ${U.transactionList('latest', latest.map(latestRow), 'Awaiting data…')}
  </section>

  <section class="section" id="home-health" aria-labelledby="health-title">
    <div class="section-head"><div><p class="eyebrow">Pipeline</p><h2 id="health-title">Scraper health</h2></div>
      ${U.warmTooltip('tip-health', 'The scraper records this object after every run. If it is missing the card stays hidden rather than showing a stale claim as live.')}
    </div>
    ${healthCard(meta)}
    ${rawDetails()}
  </section>

  ${communitySection()}
  ${C.state.admin ? adminSection() : ''}
  `;
}

function recentChips() {
  if (!C.state.recent.length) return '';
  return `<span class="recent-label">Recent:</span>${C.state.recent
    .map((term) => `<button type="button" class="chip" data-action="recent" data-value="${C.esc(term)}">${C.esc(term)}</button>`)
    .join('')}`;
}

function fundItems() {
  const stats = C.visaStats(C.data.rows);
  const g1 = C.data.g1[C.data.g1.length - 1];
  const permits = C.data.permits[C.data.permits.length - 1];
  const total = Math.max(stats.total, 1);
  return [
    { label: 'Visa decisions', value: C.fmtNum(stats.total), detail: `Granted ${C.fmtPct(stats.acceptanceRate)}`, change: stats.dayDiff === null ? '' : `${C.fmtSigned(stats.dayDiff)} vs prev day`, ratio: 1 },
    { label: 'Stamp 1G lag', value: g1 ? `${g1.lagDays} days` : 'Awaiting data…', detail: g1 ? `Processing ${C.fmtShort(g1.processingDate)}` : 'No observation yet', change: g1 ? `${(g1.lagDays / 7).toFixed(1)} weeks` : '', ratio: g1 ? Math.min(1, g1.lagDays / 120) : 0 },
    { label: 'Permit lag', value: permits ? `${permits.lagDays} days` : 'Awaiting data…', detail: permits ? `${permits.category} · ${C.fmtShort(permits.processingDate)}` : 'No observation yet', change: permits ? permits.category : '', ratio: permits ? Math.min(1, permits.lagDays / 120) : 0 },
    { label: 'Published days', value: C.fmtNum(stats.days), detail: `Since ${C.fmtShort(C.TRACKING_STARTED)}`, change: `${C.fmtNum(stats.avgPerDay.toFixed ? Number(stats.avgPerDay.toFixed(1)) : stats.avgPerDay)} per day`, ratio: stats.days / Math.max(stats.days, 120) },
  ].map((item) => ({ ...item, ratio: item.ratio }));
}

function trackerCard(id) {
  if (id === '1g') {
    const rows = C.data.g1;
    const latest = rows[rows.length - 1];
    return `<article class="tracker-card">
      <p class="eyebrow">Stamp 1G</p>
      <h3>Processing date</h3>
      <p class="tracker-figure">${latest ? C.fmtDate(latest.processingDate) : 'Awaiting data…'}</p>
      <p class="hint">${latest ? `${latest.lagDays}-day lag · observed ${C.fmtShort(latest.runDate)}` : 'The first observation appears after the next scheduled run.'}</p>
      ${U.dynamicButton({ id: 'open-1g', label: 'Open Stamp 1G', action: 'tracker', value: '1g', variant: 'quiet' })}
    </article>`;
  }
  if (id === 'permits') {
    const latest = C.data.permits[C.data.permits.length - 1];
    const count = C.categories(C.data.permits).length;
    return `<article class="tracker-card">
      <p class="eyebrow">Employment permits</p>
      <h3>${count ? `${count} categories tracked` : 'Categories'}</h3>
      <p class="tracker-figure">${latest ? `${latest.lagDays} days` : 'Awaiting data…'}</p>
      <p class="hint">${latest ? `${latest.category} · processing ${C.fmtShort(latest.processingDate)}` : 'Enterprise Ireland publishes these weekly; the first run fills the card.'}</p>
      ${U.dynamicButton({ id: 'open-permits', label: 'Open permits', action: 'tracker', value: 'permits', variant: 'quiet' })}
    </article>`;
  }
  const stats = C.visaStats(C.data.rows);
  return `<article class="tracker-card">
    <p class="eyebrow">Visa decisions</p>
    <h3>${stats.latestDate ? `Latest file ${C.fmtShort(stats.latestDate)}` : 'Awaiting data…'}</h3>
    <p class="tracker-figure">${C.fmtNum(stats.total)}</p>
    <p class="hint">${C.fmtPct(stats.acceptanceRate)} granted across ${C.fmtNum(stats.days)} published days.</p>
    ${U.dynamicButton({ id: 'open-visa', label: 'Open visa tracker', action: 'tracker', value: 'visa', variant: 'quiet' })}
  </article>`;
}

function watchRow(row) {
  const content = `<div class="row-line">
    <div class="txn">
      <span class="txn-id mono">${C.esc(row.irl)}</span>
      <span class="txn-date">${C.fmtShort(row.date)}</span>
      ${U.statBadge(row)}
    </div>
    ${U.inlineDisclosure(`watch-menu-${row.irl}`, [
      { action: 'copy', label: 'Copy number', value: row.irl },
      { action: 'share', label: 'Share', value: row.irl },
      { action: 'unwatch', label: 'Remove', value: row.irl },
    ])}
  </div>`;
  return U.swipeRow(`watch-${row.irl}`, content, [
    { action: 'copy', label: 'Copy number', value: row.irl },
    { action: 'share', label: 'Share', value: row.irl },
    { action: 'unwatch', label: 'Remove', value: row.irl },
  ]);
}

function latestRow(row) {
  return `<div class="txn"><span class="txn-id mono">${C.esc(row.irl)}</span><span class="txn-date">${C.fmtShort(row.date)}</span>${U.statBadge(row)}</div>`;
}

function healthCard(meta) {
  if (!meta) return '<p class="empty">Awaiting data… the health card appears once the scraper records a run.</p>';
  const today = C.istNow().toISOString().slice(0, 10);
  const isToday = String(meta.lastRunAt).slice(0, 10) === today;
  const tone = meta.ok === false ? 'bad' : isToday ? 'ok' : 'warn';
  const label = meta.ok === false ? 'Last scrape failed' : isToday ? 'Last scrape today' : 'Nothing recorded today yet';
  const rows = [
    `<div class="meta-line"><span class="dot dot-${tone}" aria-hidden="true"></span><strong>${label}</strong><span class="mono">${C.esc(String(meta.lastRunAt).replace('T', ' '))} IST</span></div>`,
    meta.fileRows && meta.sheetRows
      ? `<div class="meta-line">Recorded <strong>${C.fmtNum(meta.sheetRows)}</strong> of <strong>${C.fmtNum(meta.fileRows)}</strong> decisions in the latest file${meta.fileDate ? ` (dated ${C.esc(meta.fileDate)})` : ''}.${meta.sheetRows < meta.fileRows ? ` ${C.fmtNum(meta.fileRows - meta.sheetRows)} still missing.` : ' Fully synced.'}</div>`
      : '',
    `<div class="meta-line">Closure calendar: ${meta.closureDates && meta.closureDates.length ? meta.closureDates.map((d) => `<span class="closure-chip">${C.fmtShort(d)}</span>`).join('') : '<span class="hint">No closures listed by the office.</span>'}</div>`,
    `<div class="meta-line">New rows in the last run: <strong>${C.fmtNum(meta.newRows || 0)}</strong>.</div>`,
  ];
  return `<div class="meta-card">${rows.join('')}</div>`;
}

function rawDetails() {
  return `<details class="readme"><summary>How this tracker works</summary>
    <p>Every day an automated job checks the Irish embassy's New Delhi visa decisions page for the latest published spreadsheet and records any application numbers that have not appeared before. Stamp 1G and employment-permit observations are read from the official processing-date pages.</p>
    <ul>
      <li><strong>Home</strong> — today's snapshot, headline numbers and the latest decisions.</li>
      <li><strong>Daily summary</strong> — one row per published day: volume, day-on-day change, acceptance and rejection rates.</li>
      <li><strong>Past results</strong> — the full history, searchable by application number.</li>
      <li><strong>Suggestions</strong> — leave feedback; I read all of it.</li>
    </ul>
    <p>After approval, most visas are dispatched through BlueDart and follow standard courier timelines from Delhi.</p>
  </details>`;
}

function communitySection() {
  const community = C.data.community || [];
  const stats = C.communityStats(community, C.state.tracker === '1g' ? '1g' : 'visa');
  return `<section class="section" id="home-community" aria-labelledby="community-title">
    <div class="section-head"><div><p class="eyebrow">Community</p><h2 id="community-title">Reported timelines</h2></div>
      ${U.warmTooltip('tip-community', 'Submitted through the site’s own form, stored in D1, and merged into the data file by a nightly sync. Nothing here is inferred.')}
    </div>
    ${stats ? `<p class="hint">${stats.n} reported timeline${stats.n === 1 ? '' : 's'}; median wait <strong>${stats.median} days</strong>.</p>` : '<p class="empty">Awaiting data… reported timelines appear after the nightly sync.</p>'}
    <div class="profile-row">
      ${community.slice(-3).reverse().map((entry, i) => U.profileCardTrigger(`community-${i}`, `${entry.tracker === '1g' ? 'Stamp 1G' : 'Visa'} · ${C.fmtShort(entry.applied)} → ${C.fmtShort(entry.decided)}`, i)).join('')}
      ${/* The empty state is a real, usable card rather than nothing: a visitor
           arriving before the first sync still gets the explanation of what a
           reported timeline contains and where it is sent. */''}
      ${U.profileCardTrigger('community-empty', 'How a reported timeline is shown', -1)}
    </div>
    ${U.profileCardDialog()}
  </section>`;
}

function adminSection() {
  return `<section class="section" id="home-admin" aria-labelledby="admin-title">
    <div class="section-head"><div><p class="eyebrow">Sanctioned local surface</p><h2 id="admin-title">Pending submissions</h2></div><span class="state-chip state-chip-soft">Read-only preview</span></div>
    <p class="hint">Visible only with <code>?admin=1</code>. Reads <code>/api/community-submissions</code>; nothing is written from here.</p>
    <div id="admin-table">${U.inlineTableControl('admin-table-control', [])}</div>
  </section>`;
}

/* ------------------------------------------------------------- visa screens -- */

function renderVisa() {
  const stats = C.visaStats(C.data.rows);
  const status = C.publishStatus(C.data.rows);
  const tabs = U.fluidTabs('visa', TABS, C.state.tab);
  const panels = {
    home: visaHomeTab(stats, status),
    daily: visaDailyTab(stats),
    past: visaPastTab(stats),
    suggest: visaSuggestTab(),
  };
  return `${tabs}
    <section class="panel" role="tabpanel" id="panel-visa-${C.state.tab}" aria-labelledby="tab-visa-${C.state.tab}" tabindex="-1">
      ${panels[C.state.tab] || panels.home}
    </section>`;
}

function visaHomeTab(stats, status) {
  const rows = filteredRows().slice(0, ui.limit);
  return `<div class="tracker-head">
    <div><p class="eyebrow">Visa decisions</p><h1>New Delhi decision files</h1></div>
    <div class="head-actions">
      ${U.dynamicButton({ id: 'visa-export', label: 'Export CSV', action: 'export-visa', variant: 'quiet', iconName: 'down' })}
      ${U.dynamicButton({ id: 'visa-share', label: 'Share view', action: 'share-view', variant: 'quiet', iconName: 'share' })}
    </div>
  </div>
  ${U.statusLine(status.tone, status.text)}
  <div class="counters counters-4">
    ${U.animatedCounter({ id: 'v-today', value: stats.latestCount, label: 'Latest file', hint: 'Decisions in the newest published file, not counting notice rows.' })}
    ${U.animatedCounter({ id: 'v-diff', value: stats.dayDiff ?? 0, label: 'Day on day', format: (n) => `${n > 0 ? '+' : ''}${C.fmtNum(n)}`, hint: 'Difference against the previous day that published decisions. A skipped day is not a drop to zero.' })}
    ${U.animatedCounter({ id: 'v-acc', value: stats.acceptanceRate * 100, label: 'Acceptance rate', suffix: '%', format: (n) => n.toFixed(1), hint: 'Granted ÷ all real decisions.' })}
    ${U.animatedCounter({ id: 'v-avg', value: stats.avgPerDay, label: 'Avg / published day', format: (n) => n.toFixed(1), hint: 'Days with no upload are excluded.' })}
  </div>
  ${U.filterDisclosure('decision', decisionFilterItems(stats), C.state.decisionFilter)}
  <div class="search-row">
    ${U.skiper68({ id: 'visa-q', label: 'Search by application number', value: C.state.q, placeholder: 'Search application numbers…', digits: 4 })}
    ${U.dynamicButton({ id: 'visa-track', label: 'Track', action: 'track', variant: 'secondary' })}
  </div>
  <div class="recent-row">${recentChips()}</div>
  ${decisionsTable(rows, stats)}
  ${ui.limit < filteredRows().length ? '<div class="load-more" data-sentinel="visa">Loading more…</div>' : ''}
  `;
}

function visaDailyTab(stats) {
  const series = C.dailySeries(C.data.rows, { groupWeek: C.state.groupWeek, hideWeekends: C.state.hideWeekends });
  const grid = C.heatmap(C.data.rows);
  const byDate = stats.byDate;
  const dailyRows = byDate.slice(0, ui.limit);
  return `<div class="tracker-head"><div><p class="eyebrow">Daily summary</p><h1>One row per published day</h1></div>
    <div class="head-actions">${U.dynamicButton({ id: 'daily-export', label: 'Export CSV', action: 'export-daily', variant: 'quiet', iconName: 'down' })}</div></div>
  <div class="counters counters-4">
    ${U.animatedCounter({ id: 'd-days', value: stats.days, label: 'Published days' })}
    ${U.animatedCounter({ id: 'd-busy', value: stats.busiestCount, label: `Busiest day (${stats.busiestDate ? C.fmtShort(stats.busiestDate) : '—'})` })}
    ${U.animatedCounter({ id: 'd-acc', value: stats.acceptanceRate * 100, label: 'Acceptance rate', suffix: '%', format: (n) => n.toFixed(1) })}
    ${U.animatedCounter({ id: 'd-rej', value: stats.rejectionRate * 100, label: 'Refusal rate', suffix: '%', format: (n) => n.toFixed(1) })}
  </div>
  <div class="control-row">
    ${U.squishSwitch('sw-group', 'Group by week', C.state.groupWeek)}
    ${U.squishSwitch('sw-weekend', 'Hide weekends', C.state.hideWeekends)}
    ${U.squishSwitch('sw-alert', `Alert me if a gap exceeds ${C.state.alertGap} days`, C.state.alertGap > 0)}
    ${U.stepper('alert-gap', 'Gap', C.state.alertGap, { min: 0, max: 60, suffix: 'days' })}
  </div>
  <div class="insight-grid">
    <section class="card" aria-labelledby="heat-title"><h2 id="heat-title">Decisions per day</h2>${U.githubActivity('heat', grid)}</section>
    <section class="card" aria-labelledby="trend-title"><h2 id="trend-title">Volume trend</h2>${U.analyticsChart('daily-chart', series, { label: C.state.groupWeek ? 'Decisions per week' : 'Decisions per day', valueLabel: 'decisions', caption: `${C.state.hideWeekends ? 'Weekdays only. ' : ''}Every point is a published day.${C.state.groupWeek ? ' Grouped into weeks starting Monday.' : ''}` })}</section>
  </div>
  <div id="day-detail" class="day-detail" hidden></div>
  <h2 class="subhead">Day by day</h2>
  ${dailyTable(dailyRows)}
  ${ui.limit < byDate.length ? '<div class="load-more" data-sentinel="visa">Loading more…</div>' : ''}
  `;
}

function visaPastTab(stats) {
  const rows = filteredRows();
  const shown = rows.slice(0, ui.limit);
  const subTabs = `<div class="fluid-tabs fluid-tabs-sub" role="tablist" aria-label="Past results detail" data-component="fluid-tabs" data-layout-group="visa-past">
    ${[['overview', 'Overview'], ['timeline', 'Timeline'], ['raw', 'Raw']].map(([id, label]) => `<button type="button" role="tab" aria-selected="${C.state.pastSub === id}" tabindex="${C.state.pastSub === id ? '0' : '-1'}" data-action="past-sub" data-value="${id}">${label}</button>`).join('')}
  </div>`;
  const body = C.state.pastSub === 'timeline' ? timelineRows(shown) : C.state.pastSub === 'raw' ? rawTable(shown) : decisionsTable(shown, stats);
  return `<div class="tracker-head"><div><p class="eyebrow">Past results</p><h1>Search the full history</h1></div>
    <div class="head-actions">${U.dynamicButton({ id: 'past-export', label: 'Export CSV', action: 'export-past', variant: 'quiet', iconName: 'down' })}</div></div>
  <div class="search-row">
    ${U.skiper68({ id: 'past-q', label: 'Application number', value: C.state.q, placeholder: 'Exact application number…', digits: 6, maxlength: 12 })}
    <label class="field"><span class="field-label">Date</span><input class="input" type="date" id="past-date" data-action="date" value="${C.esc(C.state.date)}"/></label>
    ${U.dynamicButton({ id: 'past-track', label: 'Track', action: 'track', variant: 'secondary' })}
    ${C.state.q || C.state.date ? U.dynamicButton({ id: 'past-clear', label: 'Clear filters', action: 'clear-filters', variant: 'quiet' }) : ''}
  </div>
  ${U.filterDisclosure('decision-past', decisionFilterItems(stats), C.state.decisionFilter)}
  ${subTabs}
  <p class="hint">${C.fmtNum(rows.length)} row${rows.length === 1 ? '' : 's'}${C.state.q ? ` matching “${C.esc(C.state.q)}”` : ''}${C.state.date ? ` on ${C.fmtDate(C.state.date)}` : ''}.</p>
  ${body}
  ${ui.limit < rows.length ? '<div class="load-more" data-sentinel="visa">Loading more…</div>' : ''}`;
}

function visaSuggestTab() {
  return `<div class="tracker-head"><div><p class="eyebrow">Suggestions</p><h1>Tell me what to fix</h1></div></div>
  <p class="lede">Corrections, a feature you want, or a number that looks wrong — tell me and I will look. Submissions go to this site's own form endpoint (stored in D1) and the honeypot is still there.</p>
  ${U.feedbackForm(ui.feedback)}
  <form class="card" id="time-form" name="timelines-visa" aria-labelledby="timeline-form-title" novalidate>
    <h2 id="timeline-form-title">Share your timeline</h2>
    <p class="hint">Dates only; no name, email or application number is collected for timelines.</p>
    <div class="control-row">${U.rubberSegment('timeline-outcome', 'Outcome', [{ value: 'granted', label: 'Granted' }, { value: 'refused', label: 'Refused' }], ui.timeline.outcome)}</div>
    <div class="field-row">
      <label class="field"><span class="field-label">Applied on</span><input class="input" type="date" id="time-applied" name="applied" max="${C.todayISO()}"/></label>
      <label class="field"><span class="field-label">Decided on</span><input class="input" type="date" id="time-decided" name="decided" max="${C.todayISO()}"/></label>
    </div>
    <p class="hp" aria-hidden="true"><label>Leave this field empty<input type="text" name="bot-field" id="time-bot" tabindex="-1" autocomplete="off"/></label></p>
    <div class="form-actions">
      ${U.dynamicButton({ id: 'timeline-submit', label: 'Send timeline', action: 'submit-timeline', value: 'visa' })}
      <p class="form-status" id="time-status" role="status"></p>
    </div>
  </form>`;
}

/* ------------------------------------------------------------------- stamp 1G -- */

function renderG1() {
  const rows = C.data.g1.filter((r) => r.category === C.state.g1Category || C.state.g1Category === 'all');
  const all = C.data.g1;
  const projections = C.projections(rows);
  const latest = rows[rows.length - 1];
  const categories = C.categories(all);
  const estimate = C.estimate(rows, C.state.estimatorDate, C.state.estimatorMode);
  const milestones = projections.ok
    ? [
        { date: C.todayISO(), label: 'Today', value: latest ? C.fmtShort(latest.processingDate) : '—' },
        ...projections.ahead.map((p) => ({ date: C.shiftISO(C.todayISO(), p.days), label: `In ${p.days} days`, value: C.fmtShort(p.date) })),
        ...(projections.etaDate ? [{ date: projections.etaDate, label: 'Your date reached (ETA)', value: C.fmtDate(projections.etaDate) }] : []),
      ].sort((a, b) => a.date.localeCompare(b.date))
    : [];

  return `${U.scrollIsland('g1', [{ id: 'overview', label: 'Overview' }, { id: 'estimator', label: 'Estimator' }, { id: 'trend', label: 'Trend' }, { id: 'history', label: 'History' }], 'Stamp 1G')}
  <div class="tracker-head"><div><p class="eyebrow">Stamp 1G</p><h1>Processing date, observed daily</h1></div>
    <div class="head-actions">${U.dynamicButton({ id: 'g1-export', label: 'Export CSV', action: 'export-g1', variant: 'quiet', iconName: 'down' })}</div></div>
  ${categories.length > 1 ? `<div class="control-row">${U.glideSelect('g1-category', 'Category', [{ value: 'all', label: 'All categories' }, ...categories.map((c) => ({ value: c, label: c }))], C.state.g1Category)}</div>` : ''}
  <section id="g1-overview" class="section-block">
    <div class="counters counters-4">
      ${U.animatedCounter({ id: 'g1-latest', value: latest ? C.dayNumber(latest.processingDate) : 0, label: 'Processing date', format: () => (latest ? C.fmtDate(latest.processingDate) : 'Awaiting data…'), hint: 'The date ISD says it is currently processing for this category.' })}
      ${U.animatedCounter({ id: 'g1-lag', value: latest?.lagDays ?? 0, label: 'Current lag', format: (n) => `${n} days`, hint: 'Observation date minus the processing date — how far behind the queue is today.' })}
      ${U.animatedCounter({ id: 'g1-rate', value: projections.ok ? projections.recentWeek : 0, label: 'Advancing / week', format: (n) => `${n.toFixed(1)} days`, hint: 'Recent slope of the processing date against the calendar: the last ten observations, not the all-time fit.' })}
      ${U.animatedCounter({ id: 'g1-eta', value: projections.etaDays ?? 0, label: 'ETA to today', format: (n) => (projections.etaDays === null ? 'stalled' : `${n} days`), hint: 'At the recent pace, how long until the processing date reaches today. A stalled queue has no finite ETA.' })}
    </div>
    ${rows.length ? `<div class="note-strip">${U.warmTooltip('tip-g1-note', 'Lag is the gap between when ISD recorded the page and the date it was processing. It moves in steps because the office updates in batches.')} <span>Observed ${C.fmtDate(latest.runDate)} · processing <strong>${C.fmtDate(latest.processingDate)}</strong> · lag <strong>${latest.lagDays} days</strong> (${(latest.lagDays / 7).toFixed(1)} weeks).</span></div>` : '<p class="empty">Awaiting data… the first scheduled run fills this screen.</p>'}
  </section>

  <section id="g1-estimator" class="section-card" aria-labelledby="estimator-title">
    <div class="section-head"><div><p class="eyebrow">Estimator</p><h2 id="estimator-title">Your application</h2></div>
      ${U.rubberSegment('estimator-mode', 'I have…', [{ value: 'applied', label: 'Already applied' }, { value: 'plan', label: 'Plan to apply' }], C.state.estimatorMode)}
    </div>
    <div class="control-row">
      <label class="field"><span class="field-label">${C.state.estimatorMode === 'plan' ? 'I plan to apply on' : 'I applied on'}</span>
        <input class="input" type="date" id="g1-date" data-action="estimator-date" value="${C.esc(C.state.estimatorDate)}" min="${C.state.estimatorMode === 'plan' ? C.shiftISO(C.todayISO(), 1) : '2020-01-01'}" max="${C.state.estimatorMode === 'plan' ? '' : C.todayISO()}"/></label>
      ${U.stepper('applied-days', 'Or days ago', g1DaysAgo(), { min: 0, max: 400, suffix: 'days' })}
    </div>
    <div class="estimate" id="g1-estimate">${estimateMarkup(estimate)}</div>
    <div class="control-row">
      <label class="field"><span class="field-label">IRP expiry (optional)</span><input class="input" type="date" id="g1-expiry" data-action="expiry" value="${C.esc(C.state.expiry)}"/></label>
      <p class="hint" id="g1-expiry-note">${C.state.expiry ? C.irpWindow(C.state.expiry) : 'Add your IRP expiry for a renewal-window countdown. The window opens 12 weeks before expiry.'}</p>
    </div>
    <div id="g1-timeline">${U.skiper74('g1-timeline-cal', milestones)}</div>
  </section>

  <section id="g1-trend" class="section-card" aria-labelledby="g1-trend-title">
    <div class="section-head"><div><p class="eyebrow">Trend</p><h2 id="g1-trend-title">Lag over time</h2></div>
      ${U.warmTooltip('tip-g1-trend', 'Weekly means. Daily observations saw-tooth as the office stalls then jumps; a week is the smallest honest unit for a direction.')}
    </div>
    ${U.analyticsChart('g1-chart', C.lagByWeek(rows), { label: 'Mean lag per week', valueLabel: 'days of lag', format: (n) => `${Math.round(n)}d`, caption: 'Gap between the observation date and the processing date, averaged per week.' })}
  </section>

  <section id="g1-history" class="section-card" aria-labelledby="g1-history-title">
    <div class="section-head"><div><p class="eyebrow">History</p><h2 id="g1-history-title">Every observation</h2></div></div>
    <div id="g1-table">${g1Table(rows.slice(-ui.limit).reverse())}</div>
  </section>

  <section class="section-card" aria-labelledby="g1-community-title">
    <div class="section-head"><div><p class="eyebrow">Community</p><h2 id="g1-community-title">Reported 1G timelines</h2></div></div>
    ${C.communityStats(C.data.community, '1g') ? `<p class="hint">${C.communityStats(C.data.community, '1g').n} reported · median ${C.communityStats(C.data.community, '1g').median} days.</p>` : '<p class="empty">Awaiting data… community timelines land after the nightly sync.</p>'}
    ${g1TimelineForm()}
  </section>
  `;
}

function g1DaysAgo() {
  if (!C.state.estimatorDate) return 0;
  return Math.max(0, Math.round(C.dayNumber(C.todayISO()) - C.dayNumber(C.state.estimatorDate)));
}

function estimateMarkup(estimate) {
  if (estimate.state === 'no-data') return '<p class="empty">Estimates appear once the tracker records its first observation.</p>';
  if (estimate.state === 'empty') return '<p class="hint">Enter your date above — the estimate recalculates from the newest observation on every load.</p>';
  const when = estimate.mode === 'plan' ? `Apply on ${C.fmtDate(C.state.estimatorDate)}` : `Applied ${C.fmtDate(C.state.estimatorDate)}`;
  if (estimate.state === 'past') {
    return `<p>${when} — ISD is already processing <strong>${C.fmtDate(estimate.latest.processingDate)}</strong>, past your date. Your outcome may already be decided.</p>`;
  }
  return `<p>${when} → tentative outcome around <strong>${C.fmtDate(estimate.tentative)}</strong> (in ~${estimate.inDays} days).</p>
    <p class="hint">Your date plus the current ${estimate.latest.lagDays}-day lag, recalculated automatically when new observations arrive.</p>`;
}

function g1TimelineForm() {
  return `<form class="card timeline-form" id="time-form-1g" name="timelines-1g" novalidate>
    <div class="control-row">${U.rubberSegment('timeline-outcome-1g', 'Outcome', [{ value: 'granted', label: 'Granted' }, { value: 'refused', label: 'Refused' }], ui.timeline.outcome)}</div>
    <div class="field-row">
      <label class="field"><span class="field-label">Applied on</span><input class="input" type="date" id="time-applied-1g" name="applied" max="${C.todayISO()}"/></label>
      <label class="field"><span class="field-label">Decided on</span><input class="input" type="date" id="time-decided-1g" name="decided" max="${C.todayISO()}"/></label>
    </div>
    <p class="hp" aria-hidden="true"><label>Leave this field empty<input type="text" name="bot-field" id="time-bot-1g" tabindex="-1" autocomplete="off"/></label></p>
    <div class="form-actions">
      ${U.dynamicButton({ id: 'timeline-submit-1g', label: 'Share timeline', action: 'submit-timeline', value: '1g' })}
      <p class="form-status" id="time-status-1g" role="status"></p>
    </div>
  </form>`;
}

function g1Table(rows) {
  if (!rows.length) return '<p class="empty">Awaiting data…</p>';
  return `<table class="data-table"><caption class="sr-only">Stamp 1G observations, newest first</caption>
    <thead><tr><th scope="col">Observed</th><th scope="col">Processing date</th><th scope="col">Lag</th><th scope="col">Change</th></tr></thead>
    <tbody>${rows
      .map((row, i) => {
        const prev = rows[i + 1];
        const delta = prev ? row.lagDays - prev.lagDays : 0;
        return `<tr><td class="mono">${C.fmtShort(row.runDate)}</td><td>${C.fmtDate(row.processingDate)}</td><td class="mono">${row.lagDays}d</td><td class="mono">${delta > 0 ? `+${delta}` : delta < 0 ? String(delta) : '—'}</td></tr>`;
      })
      .join('')}</tbody></table>`;
}

/* ------------------------------------------------------------------ permits -- */

function renderPermits() {
  const all = C.data.permits;
  const categories = C.categories(all);
  const category = C.state.permitsCategory || categories[0] || '';
  const rows = all.filter((r) => r.category === category);
  const latest = rows[rows.length - 1];
  const previous = rows[rows.length - 2];
  const projections = C.projections(rows.length >= 2 ? rows : all);
  const series = C.lagByWeek(rows.length >= 2 ? rows : all);

  return `<div class="tracker-head"><div><p class="eyebrow">Employment permits</p><h1>Processing dates by category</h1></div>
    <div class="head-actions">${U.dynamicButton({ id: 'permits-export', label: 'Export CSV', action: 'export-permits', variant: 'quiet', iconName: 'down' })}</div></div>
  ${categories.length ? `<div class="control-row">${U.glideSelect('permits-category', 'Category', categories.map((c) => ({ value: c, label: c })), category)}</div>` : '<p class="empty">Awaiting data… permit observations appear after the weekly run.</p>'}
  <div class="counters counters-4">
    ${U.animatedCounter({ id: 'p-latest', value: latest ? C.dayNumber(latest.processingDate) : 0, label: 'Processing date', format: () => (latest ? C.fmtDate(latest.processingDate) : 'Awaiting data…') })}
    ${U.animatedCounter({ id: 'p-lag', value: latest?.lagDays ?? 0, label: 'Current lag', format: (n) => `${n} days` })}
    ${U.animatedCounter({ id: 'p-week', value: projections.ok ? projections.recentWeek : 0, label: 'Advancing / week', format: (n) => `${n.toFixed(1)} days` })}
    ${U.animatedCounter({ id: 'p-change', value: latest && previous ? latest.lagDays - previous.lagDays : 0, label: 'Lag vs previous run', format: (n) => `${n > 0 ? '+' : ''}${n} days` })}
  </div>
  <div class="insight-grid">
    <section class="card" aria-labelledby="permits-trend"><h2 id="permits-trend">Lag trend</h2>${U.analyticsChart('permits-chart', series, { label: `${category || 'Permits'} lag`, valueLabel: 'days of lag', format: (n) => `${Math.round(n)}d`, caption: 'Weekly mean lag for the selected category.' })}</section>
    <section class="card" aria-labelledby="permits-eta"><h2 id="permits-eta">Projection</h2>
      <div class="projection">
        ${projections.ok ? `<p>At the recent pace of <strong>${projections.recentWeek.toFixed(1)} days per week</strong>, the processing date reaches today in <strong>${projections.etaDays === null ? 'no finite time — the queue has stalled' : `${projections.etaDays} days`}</strong>.</p>
        <ul class="ahead-list">${projections.ahead.map((p) => `<li><span class="mono">+${p.days}d</span><span>${C.fmtDate(p.date)}</span></li>`).join('')}</ul>` : '<p class="empty">Awaiting at least two observations to project.</p>'}
        <p class="hint">A straight-line fit of the published processing date. It is a description of the trend, not a promise.</p>
      </div>
    </section>
  </div>
  ${rows.length ? `<table class="data-table"><caption class="sr-only">Permit observations for ${C.esc(category)}</caption>
    <thead><tr><th scope="col">Observed</th><th scope="col">Category</th><th scope="col">Processing date</th><th scope="col">Lag</th></tr></thead>
    <tbody>${rows.slice(-ui.limit).reverse().map((row) => `<tr><td class="mono">${C.fmtShort(row.runDate)}</td><td>${C.esc(row.category)}</td><td>${C.fmtDate(row.processingDate)}</td><td class="mono">${row.lagDays}d</td></tr>`).join('')}</tbody></table>` : ''}
  `;
}

/* -------------------------------------------------------------------- tables -- */

function filteredRows() {
  const rows = C.realRows(C.data.rows).filter((row) => {
    if (C.state.q && !String(row.irl).includes(C.state.q.replace(/\s+/g, ''))) return false;
    if (C.state.date && row.date !== C.state.date) return false;
    if (C.state.decisionFilter !== 'all' && row.status !== C.state.decisionFilter) return false;
    return true;
  });
  return rows;
}

function decisionFilterItems(stats) {
  return DECISIONS.map((item) => ({
    ...item,
    count: item.value === 'all' ? stats.total : item.value === 'accepted' ? stats.accepted : item.value === 'rejected' ? stats.rejected : stats.total - stats.accepted - stats.rejected,
  }));
}

function decisionsTable(rows, stats) {
  if (!rows.length) return '<p class="empty">No decisions match this filter. Clear the search or date to see the full history.</p>';
  return `<table class="data-table"><caption class="sr-only">Visa decisions, newest first</caption>
    <thead><tr><th scope="col">Date</th><th scope="col">Application</th><th scope="col">Decision</th></tr></thead>
    <tbody>${rows
      .map((row) => `<tr><td class="mono">${C.fmtShort(row.date)}</td><td class="mono">${C.esc(row.irl)}</td><td>${U.statBadge(row)}</td></tr>`)
      .join('')}</tbody></table>`;
}

function rawTable(rows) {
  if (!rows.length) return '<p class="empty">No rows match.</p>';
  return `<table class="data-table data-table-raw"><caption class="sr-only">Raw rows as published</caption>
    <thead><tr><th scope="col">date</th><th scope="col">application</th><th scope="col">decision</th></tr></thead>
    <tbody>${rows.map((row) => `<tr><td class="mono">${row.date}</td><td class="mono">${C.esc(row.irl)}</td><td>${C.esc(row.decision)}</td></tr>`).join('')}</tbody></table>`;
}

function timelineRows(rows) {
  if (!rows.length) return '<p class="empty">No rows match.</p>';
  return `<ol class="timeline-list timeline-list-flat">${rows
    .map((row) => `<li><span class="timeline-date">${C.fmtShort(row.date)}</span><span class="timeline-label mono">${C.esc(row.irl)}</span>${U.statBadge(row)}</li>`)
    .join('')}</ol>`;
}

function dailyTable(byDate) {
  if (!byDate.length) return '<p class="empty">Awaiting data…</p>';
  return `<table class="data-table"><caption class="sr-only">Daily summary, newest first</caption>
    <thead><tr><th scope="col">Date</th><th scope="col">Decisions</th><th scope="col">Change</th><th scope="col">Granted</th><th scope="col">Refused</th><th scope="col"><span class="sr-only">Detail</span></th></tr></thead>
    <tbody>${byDate
      .map((entry, i) => {
        const list = C.realRows(entry[1]);
        const prev = byDate[i + 1];
        const prevCount = prev ? C.realRows(prev[1]).length : null;
        const delta = prevCount === null ? null : list.length - prevCount;
        const accepted = list.filter((r) => r.status === 'accepted').length;
        const rejected = list.filter((r) => r.status === 'rejected').length;
        return `<tr><td class="mono">${C.fmtShort(entry[0])} <span class="hint">${C.weekdayShort(entry[0])}</span></td><td class="mono">${C.fmtNum(list.length)}</td><td class="mono">${delta === null ? '—' : delta > 0 ? `+${delta}` : delta < 0 ? String(delta) : '0'}</td><td class="mono">${accepted}</td><td class="mono">${rejected}</td><td><button type="button" class="btn btn-quiet touch-target" data-action="day" data-date="${entry[0]}">Open</button></td></tr>`;
      })
      .join('')}</tbody></table>`;
}

/* ------------------------------------------------------------------- events -- */

function wireGlobalEvents() {
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('popstate', () => {
    const params = new URLSearchParams(location.search);
    C.state.tracker = ['home', 'visa', '1g', 'permits'].includes(params.get('tracker')) ? params.get('tracker') : C.KNOWN_TABS.includes(params.get('tab')) ? 'visa' : 'home';
    C.state.tab = C.KNOWN_TABS.includes(params.get('tab')) ? params.get('tab') : 'home';
    C.state.q = (params.get('q') || '').slice(0, 200);
    C.state.date = (params.get('date') || '').slice(0, 10);
    ui.limit = PAGE;
    renderAll({ focus: true });
  });
  window.addEventListener('scroll', paintIslands, { passive: true });
  document.getElementById('sw-update-reload').addEventListener('click', reloadForUpdate);
}

const markVisited = () => {
  if (ui.visited || !C.data.rows.length) return;
  ui.visited = true;
  ui.lastVisit = Date.now();
  try { localStorage.setItem('visa-last-visit', String(ui.lastVisit)); } catch (e) { /* private mode */ }
};

function onClick(event) {
  const target = event.target.closest('[data-action]');
  const themeButton = event.target.closest('[data-action="theme"]');
  if (themeButton) {
    C.state.theme = C.state.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('visa-theme', C.state.theme); } catch (e) { /* private mode */ }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', C.state.theme === 'dark' ? '#0e1014' : '#ffffff');
    renderAll({ announce: `Theme: ${C.state.theme}` });
    return;
  }
  if (!target) {
    // Clicking away closes any open warm tooltip.
    closeTips();
    return;
  }
  const action = target.dataset.action;
  const value = target.dataset.value || '';

  switch (action) {
    case 'landing':
      event.preventDefault();
      setTracker('home', { push: true });
      return;
    case 'tracker':
      setTracker(target.dataset.tracker || value, { push: true });
      return;
    case 'tab': {
      const tabId = target.dataset.tab || value;
      if (C.state.tab === tabId) return;
      C.state.tab = tabId;
      ui.limit = PAGE;
      C.syncUrl('push');
      // Selection follows focus in a tablist, so focus stays on the tab that is
      // now selected rather than being thrown to the panel heading. The render
      // replaces the buttons, so the focus has to be re-applied afterwards.
      renderAll({ announce: `${tabId} tab` });
      document.getElementById(`tab-visa-${tabId}`)?.focus({ preventScroll: true });
      return;
    }
    case 'past-sub':
      C.state.pastSub = value;
      renderAll({ focus: false });
      return;
    case 'search-form':
      event.preventDefault();
      runSearch();
      return;
    case 'track':
      event.preventDefault();
      runSearch();
      return;
    case 'recent':
      C.state.q = value;
      C.syncUrl();
      renderAll({ announce: `Searching ${value}` });
      return;
    case 'filter': {
      const group = target.dataset.group;
      if (group === 'decision' || group === 'decision-past') {
        C.state.decisionFilter = value;
        if (group === 'decision-past') C.state.tab = 'past';
        C.syncUrl();
        renderAll({ announce: `Filter: ${value}` });
      }
      return;
    }
    case 'date':
      return;
    case 'clear-filters':
      C.state.q = '';
      C.state.date = '';
      C.state.decisionFilter = 'all';
      C.syncUrl();
      renderAll({ announce: 'Filters cleared' });
      return;
    case 'day':
      openDay(target.dataset.date);
      return;
    case 'point': {
      const figure = target.closest('.chart');
      const readout = figure?.querySelector('[data-chart-readout]');
      if (readout) readout.innerHTML = `${C.esc(target.dataset.date)}: <strong>${C.esc(target.dataset.value)}</strong>`;
      return;
    }
    case 'tip':
      toggleTip(target);
      return;
    case 'switch': {
      const key = target.dataset.key;
      if (key === 'sw-group') C.state.groupWeek = target.checked;
      if (key === 'sw-weekend') C.state.hideWeekends = target.checked;
      if (key === 'sw-alert') C.state.alertGap = target.checked ? 14 : 0;
      renderAll({ announce: 'View updated' });
      return;
    }
    case 'step': {
      const input = document.getElementById(target.dataset.target);
      if (!input) return;
      const step = Number(input.step) || 1;
      const dir = Number(target.dataset.dir);
      const next = Math.min(Number(input.max), Math.max(Number(input.min), Number(input.value || 0) + dir * step));
      input.value = String(next);
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    case 'step-value':
      return;
    case 'jelly': {
      const checked = event.target;
      if (!checked.checked) return;
      C.savePrimary(checked.value);
      renderAll({ announce: `Primary tracker: ${checked.value}` });
      return;
    }
    case 'segment': {
      const group = target.dataset.group;
      if (group === 'estimator-mode') {
        C.state.estimatorMode = value === 'plan' ? 'plan' : 'applied';
        C.storeValue('stamp1g-apply-mode', C.state.estimatorMode);
      } else {
        ui.timeline.outcome = value;
      }
      renderAll({ announce: `Selected ${value}` });
      return;
    }
    case 'estimator-date':
      return;
    case 'expiry':
      return;
    case 'digits':
      return;
    case 'rate': {
      ui.rating = ui.rating === value ? '' : value;
      document.querySelectorAll('.rating').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.rate === ui.rating)));
      document.getElementById('sugg-text')?.focus();
      return;
    }
    case 'submit-suggestion':
      submitSuggestion();
      return;
    case 'submit-timeline':
      submitTimeline(value === '1g');
      return;
    case 'swipe-toggle': {
      const row = document.querySelector(`[data-swipe="${CSS.escape(value)}"]`);
      const actions = row?.querySelector('.swipe-actions');
      if (!actions) return;
      const open = actions.hidden;
      actions.hidden = !open;
      target.setAttribute('aria-expanded', String(open));
      return;
    }
    case 'unwatch':
      C.saveWatchlist(C.state.watchlist.filter((term) => term !== value));
      renderAll({ announce: `Removed ${value} from the watchlist` });
      return;
    case 'copy':
      navigator.clipboard?.writeText(value).then(() => live.textContent = `Copied ${value}`).catch(() => live.textContent = 'Copy failed');
      return;
    case 'share':
      shareText(value);
      return;
    case 'undo-start':
      startUndo(value);
      return;
    case 'undo-cancel':
      cancelUndo();
      return;
    case 'go-past':
      C.state.tracker = 'visa';
      C.state.tab = 'past';
      C.syncUrl('push');
      renderAll({ focus: true });
      return;
    case 'open-profile':
      openProfile(Number(value));
      return;
    case 'close-profile':
      document.getElementById('profile-dialog')?.close();
      return;
    case 'share-view':
      shareView();
      return;
    case 'export-visa':
      exportCsv('visa-decisions', filteredRows(), [{ label: 'date', value: (r) => r.date }, { label: 'application', value: (r) => r.irl }, { label: 'decision', value: (r) => r.decision }]);
      return;
    case 'export-daily':
      exportDaily();
      return;
    case 'export-past':
      exportCsv('visa-history', filteredRows(), [{ label: 'date', value: (r) => r.date }, { label: 'application', value: (r) => r.irl }, { label: 'decision', value: (r) => r.decision }]);
      return;
    case 'export-g1':
      exportCsv('stamp-1g', C.data.g1, [{ label: 'observed', value: (r) => r.runDate }, { label: 'processing_date', value: (r) => r.processingDate }, { label: 'lag_days', value: (r) => r.lagDays }, { label: 'category', value: (r) => r.category }]);
      return;
    case 'export-permits':
      exportCsv('work-permits', C.data.permits, [{ label: 'observed', value: (r) => r.runDate }, { label: 'category', value: (r) => r.category }, { label: 'processing_date', value: (r) => r.processingDate }, { label: 'lag_days', value: (r) => r.lagDays }]);
      return;
    case 'retry-live':
      retryLive();
      return;
    case 'reload-admin':
      loadAdmin();
      return;
    case 'fund-step':
      stepFund(Number(value || target.dataset.dir));
      return;
    default:
      return;
  }
}

function onInput(event) {
  const target = event.target;
  if (target.dataset?.action === 'digits') {
    const digitsOnly = target.value.replace(/[^\d]/g, '').slice(0, Number(target.dataset.digits || 12) * 2);
    if (digitsOnly !== target.value) target.value = digitsOnly;
  }
}

function onChange(event) {
  const target = event.target;
  const action = target.dataset?.action;
  if (action === 'select') {
    if (target.dataset.key === 'permits-category') {
      C.state.permitsCategory = target.value;
      renderAll({ announce: `Category: ${target.value}` });
    } else if (target.dataset.key === 'g1-category') {
      C.state.g1Category = target.value;
      renderAll({ announce: `Category: ${target.value}` });
    }
    return;
  }
  if (action === 'date') {
    C.state.date = target.value;
    C.syncUrl();
    renderAll({ announce: 'Date filter applied' });
    return;
  }
  if (action === 'estimator-date') {
    C.storeValue('stamp1g-apply-date', target.value);
    const note = document.getElementById('g1-estimate');
    if (note) note.innerHTML = estimateMarkup(C.estimate(C.data.g1, target.value, C.state.estimatorMode));
    return;
  }
  if (action === 'step-value') {
    if (target.dataset.target === 'applied-days') {
      const days = Number(target.value || 0);
      const date = C.shiftISO(C.todayISO(), -days);
      C.storeValue('stamp1g-apply-date', days ? date : '');
      const dateInput = document.getElementById('g1-date');
      if (dateInput) dateInput.value = days ? date : '';
      const note = document.getElementById('g1-estimate');
      if (note) note.innerHTML = estimateMarkup(C.estimate(C.data.g1, days ? date : '', C.state.estimatorMode));
    }
    return;
  }
  if (action === 'expiry') {
    C.storeValue('stamp1g-expiry', target.value);
    const note = document.getElementById('g1-expiry-note');
    if (note) note.textContent = target.value ? C.irpWindow(target.value) : 'Add your IRP expiry for a renewal-window countdown. The window opens 12 weeks before expiry.';
    return;
  }
  if (action === 'digits') {
    target.value = target.value.replace(/[^\d]/g, '');
  }
  if (target.id === 'sugg-bot' || target.name === 'bot-field') return;
}

function onKeydown(event) {
  const target = event.target;
  // Roving focus inside tablists and segmented controls.
  if (target.getAttribute('role') === 'tab' && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
    const tabs = [...target.closest('[role="tablist"]').querySelectorAll('[role="tab"]')];
    const index = tabs.indexOf(target);
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    event.preventDefault();
    next.focus();
    next.click();
    return;
  }
  if (target.getAttribute('role') === 'radio' && ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    const group = target.closest('[role="radiogroup"]');
    const radios = [...group.querySelectorAll('[role="radio"]')];
    const index = radios.indexOf(target);
    const dir = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    const next = radios[(index + dir + radios.length) % radios.length];
    event.preventDefault();
    next.focus();
    next.click();
    // The selection re-renders the control, so focus is re-applied to the same
    // choice afterwards — otherwise the arrow key moves the value but drops the
    // visitor back to the top of the page.
    const groupId = group.dataset.segmentGroup;
    const value = next.dataset.value;
    requestAnimationFrame(() => {
      document.querySelector(`[data-segment-group="${groupId}"] [data-value="${value}"]`)?.focus({ preventScroll: true });
    });
    return;
  }
  if ((event.key === 'Enter' || event.key === ' ') && target.dataset?.action === 'digits') {
    return;
  }
  if (event.key === 'Enter' && target.dataset?.action === 'track') {
    event.preventDefault();
    runSearch();
    return;
  }
  if (event.key === 'Escape') {
    const tip = document.querySelector('.warm-tooltip:not([hidden])');
    if (tip) {
      event.preventDefault();
      const trigger = document.querySelector(`[data-tip="${tip.id}"]`);
      closeTips();
      trigger?.focus();
      return;
    }
    const dialog = document.getElementById('profile-dialog');
    if (dialog?.open) { dialog.close(); return; }
    const row = document.querySelector('.swipe-actions:not([hidden])');
    if (row) { row.hidden = true; row.closest('[data-swipe]')?.querySelector('.swipe-toggle')?.focus(); }
  }
}

function setTracker(id, { push = false } = {}) {
  C.state.tracker = id;
  if (id !== 'visa') C.state.tab = 'home';
  ui.limit = PAGE;
  C.syncUrl(push ? 'push' : 'replace');
  renderAll({ focus: true, announce: `${id} view` });
}

function runSearch() {
  const input = document.getElementById('home-q') || document.getElementById('visa-q') || document.getElementById('past-q');
  const term = (input?.value || C.state.q || '').replace(/\s+/g, '');
  C.state.q = term;
  if (term) C.saveRecentSearch(term);
  if (term && C.state.tracker === 'home') {
    C.state.tracker = 'visa';
    C.state.tab = 'past';
  }
  ui.limit = PAGE;
  C.syncUrl('push');
  if (term && C.state.watchlist.includes(term) === false) {
    const hit = C.data.rows.some((row) => String(row.irl).includes(term));
    if (hit) C.saveWatchlist([term, ...C.state.watchlist].slice(0, 10));
  }
  markVisited();
  renderAll({ focus: true, announce: term ? `Showing results for ${term}` : 'Showing the full history' });
}

function openDay(date) {
  C.state.date = date;
  C.state.tracker = 'visa';
  C.state.tab = 'daily';
  C.syncUrl('push');
  renderAll({ focus: true });
  paintDailyDetail(date);
}

function paintDailyDetail(date = C.state.date) {
  const slot = document.getElementById('day-detail');
  if (!slot) return;
  if (!date) { slot.hidden = true; return; }
  const rows = C.data.rows.filter((row) => row.date === date);
  const real = C.realRows(rows);
  slot.hidden = false;
  slot.innerHTML = `<div class="day-detail-head"><h2>${C.fmtLong(date)}</h2><button type="button" class="btn btn-quiet" data-action="clear-filters">Close</button></div>
    <p class="hint">${real.length} decision${real.length === 1 ? '' : 's'}${rows.length !== real.length ? ' · the office published a notice for this date' : ''}.</p>
    ${real.length ? `<div class="txn-grid">${real.map(latestRow).join('')}</div>` : '<p class="empty">No decisions in this date’s file.</p>'}`;
}

function toggleTip(trigger) {
  const id = trigger.dataset.tip;
  const tip = document.getElementById(id);
  if (!tip) return;
  const wasOpen = !tip.hidden;
  closeTips();
  if (!wasOpen) {
    tip.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
  }
}

function closeTips() {
  document.querySelectorAll('.warm-tooltip').forEach((tip) => { tip.hidden = true; });
  document.querySelectorAll('[data-tip]').forEach((trigger) => trigger.setAttribute('aria-expanded', 'false'));
}

function openProfile(index) {
  const dialog = document.getElementById('profile-dialog');
  if (!dialog) return;
  if (index < 0) {
    document.getElementById('profile-title').textContent = 'How a reported timeline is shown';
    document.getElementById('profile-body').innerHTML = `<p>When a timeline has been reported, this card opens with four facts: the month applied, the month decided, the wait in days, and the reported outcome.</p>
      <p class="hint">Nothing else is stored: no name, no email, no application number. Submissions go through this site's own form endpoint into D1, and a nightly sync merges them into the published file — which is why a new one appears a day later, not immediately.</p>
      <p class="hint">${(C.data.community || []).length ? `${(C.data.community || []).length} reported so far.` : 'None reported yet.'}</p>`;
    dialog.showModal();
    return;
  }
  const entry = (C.data.community || []).slice(-3).reverse()[index];
  if (!entry) return;
  const wait = Math.max(0, Math.round((Date.parse(entry.decided) - Date.parse(entry.applied)) / 86400000));
  document.getElementById('profile-title').textContent = `${entry.tracker === '1g' ? 'Stamp 1G' : 'Visa'} timeline`;
  document.getElementById('profile-body').innerHTML = `<dl class="profile-facts">
      <div><dt>Applied</dt><dd>${C.fmtDate(entry.applied)}</dd></div>
      <div><dt>Decided</dt><dd>${C.fmtDate(entry.decided)}</dd></div>
      <div><dt>Wait</dt><dd>${wait} days</dd></div>
      <div><dt>Outcome</dt><dd><span class="badge badge-${entry.outcome === 'refused' ? 'bad' : 'ok'}">${C.esc(entry.outcome || 'reported')}</span></dd></div>
    </dl>
    <p class="hint">Reported through this site and merged by the nightly sync. No name, email or application number is stored with it.</p>`;
  dialog.showModal();
}

function startUndo(id) {
  if (id !== 'watchlist-clear') return;
  const previous = [...C.state.watchlist];
  C.saveWatchlist([]);
  renderAll({ announce: 'Watchlist cleared — undo available' });
  const wrap = document.querySelector('[data-undo="watchlist-clear"]');
  const count = wrap?.querySelector('[data-undo-count]');
  const cancel = wrap?.querySelector('[data-action="undo-cancel"]');
  let left = Number(wrap?.dataset.countdown || 6);
  if (count) { count.hidden = false; cancel.hidden = false; count.textContent = `Undo (${left})`; }
  clearInterval(ui.undo?.timer);
  ui.undo = {
    previous,
    timer: setInterval(() => {
      left -= 1;
      if (count) count.textContent = `Undo (${left})`;
      if (left <= 0) cancelUndo(true);
    }, 1000),
  };
}

function cancelUndo(expired = false) {
  clearInterval(ui.undo?.timer);
  const previous = ui.undo?.previous;
  ui.undo = null;
  if (expired) {
    renderAll();
    live.textContent = 'Watchlist cleared.';
    return;
  }
  if (previous) C.saveWatchlist(previous);
  renderAll({ announce: 'Watchlist restored' });
}

async function submitSuggestion() {
  if (ui.submitBusy) return;
  const name = document.getElementById('sugg-name');
  const text = document.getElementById('sugg-text');
  const status = document.getElementById('sugg-status');
  const nameValue = name?.value.trim() || '';
  const textValue = text?.value.trim() || '';
  if (!nameValue || !textValue) {
    if (status) status.textContent = 'Please fill in both fields.';
    (nameValue ? text : name)?.focus();
    return;
  }
  ui.submitBusy = true;
  if (status) status.textContent = 'Sending…';
  try {
    const body = new URLSearchParams({ 'form-name': 'suggestions', 'bot-field': '', name: nameValue, suggestion: textValue });
    const res = await fetch(location.pathname, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ui.feedback = { state: 'sent', message: `Thanks, ${nameValue} — your suggestion is in.` };
    renderAll({ announce: 'Suggestion sent' });
    document.getElementById('sugg-status')?.focus?.();
  } catch (error) {
    if (status) status.textContent = 'Could not submit. Try again.';
  } finally {
    ui.submitBusy = false;
  }
}

async function submitTimeline(is1G) {
  if (ui.submitBusy) return;
  const suffix = is1G ? '-1g' : '';
  const applied = document.getElementById(`time-applied${suffix}`)?.value;
  const decided = document.getElementById(`time-decided${suffix}`)?.value;
  const status = document.getElementById(`time-status${suffix}`);
  if (!applied || !decided) {
    if (status) status.textContent = 'Please fill in both dates.';
    return;
  }
  if (applied > decided || decided > C.todayISO() || applied < '2020-01-01') {
    if (status) status.textContent = 'Those dates don’t look right — applied must come first and decided can’t be in the future.';
    return;
  }
  ui.submitBusy = true;
  if (status) status.textContent = 'Submitting…';
  try {
    const body = new URLSearchParams({
      'form-name': is1G ? 'timelines-1g' : 'timelines-visa',
      'bot-field': '',
      tracker: is1G ? '1g' : 'visa',
      applied,
      decided,
      outcome: ui.timeline.outcome,
    });
    const res = await fetch(location.pathname, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (status) status.innerHTML = '<strong>Thanks — timeline shared.</strong> It appears in the community stats after the nightly sync.';
  } catch (error) {
    if (status) status.textContent = 'Could not submit. Try again.';
  } finally {
    ui.submitBusy = false;
  }
}

function exportCsv(name, rows, columns) {
  if (!rows.length) { live.textContent = 'Nothing to export yet.'; return; }
  C.download(`${name}-${C.todayISO()}.csv`, C.toCsv(rows, columns));
  live.textContent = `Exported ${rows.length} rows.`;
}

function exportDaily() {
  const byDate = C.visaStats(C.data.rows).byDate;
  const rows = byDate.map(([date, list]) => {
    const real = C.realRows(list);
    return { date, count: real.length, accepted: real.filter((r) => r.status === 'accepted').length, refused: real.filter((r) => r.status === 'rejected').length };
  });
  exportCsv('visa-daily', rows, [
    { label: 'date', value: (r) => r.date },
    { label: 'decisions', value: (r) => r.count },
    { label: 'granted', value: (r) => r.accepted },
    { label: 'refused', value: (r) => r.refused },
  ]);
}

async function shareView() {
  const url = location.href;
  const title = 'Irish visa decisions — New Delhi';
  if (navigator.share) {
    try { await navigator.share({ title, url }); return; } catch (e) { /* dismissed */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    live.textContent = 'Link copied.';
  } catch (e) {
    live.textContent = url;
  }
}

async function shareText(text) {
  if (navigator.share) {
    try { await navigator.share({ title: `Visa application ${text}`, text }); return; } catch (e) { /* dismissed */ }
  }
  try { await navigator.clipboard.writeText(text); live.textContent = `Copied ${text}`; } catch (e) { live.textContent = text; }
}

async function retryLive() {
  await C.loadVisa({ force: true });
  await C.loadMeta();
  renderAll({ announce: C.data.staleAt ? 'Still unreachable — showing the last good copy.' : 'Live data restored.' });
}

function stepFund(dir) {
  const fund = document.querySelector('[data-component="fund-widget"]');
  if (!fund) return;
  const cards = [...fund.querySelectorAll('[data-fund-item]')];
  const current = Number(fund.dataset.index || 0);
  const next = (current + dir + cards.length) % cards.length;
  fund.dataset.index = String(next);
  cards.forEach((card, i) => { card.hidden = i !== next; card.classList.toggle('is-current', i === next); });
  const count = fund.querySelector('[data-fund-count]');
  if (count) count.textContent = `${next + 1} / ${cards.length}`;
}

/* -------------------------------------------------------------- animations -- */

function animateCounters() {
  document.querySelectorAll('[data-counter]').forEach((node) => {
    // First paint shows the exact value: a counter that starts at zero and rolls
    // up is a lie about a figure for as long as it takes to arrive.
    const target = node.getAttribute('data-target');
    if (node.dataset.shown === target) return;
    node.dataset.shown = target;
    node.classList.remove('is-ticking');
    void node.offsetWidth;
    node.classList.add('is-ticking');
  });
}

function paintFundBars() {
  // The share is a <progress> value, so no width is ever written as a style.
  document.querySelectorAll('.fund-track').forEach((bar) => {
    if (bar.tagName === 'PROGRESS') bar.toggleAttribute('data-loaded', true);
  });
}

/* --------------------------------------------------------------- containers -- */

function paintIslands() {
  document.querySelectorAll('.scroll-island').forEach((island) => {
    const id = island.id.replace('island-', '');
    const links = [...island.querySelectorAll('a[data-target]')];
    if (!links.length) return;
    const sections = links.map((link) => document.getElementById(`${id}-${link.dataset.target}`)).filter(Boolean);
    const scrolled = window.scrollY + 140;
    let active = sections[0];
    for (const section of sections) if (section.offsetTop <= scrolled) active = section;
    links.forEach((link) => {
      const on = active && link.dataset.target === active.id.replace(`${id}-`, '');
      link.classList.toggle('is-active', Boolean(on));
      if (on) link.setAttribute('aria-current', 'true'); else link.removeAttribute('aria-current');
    });
    const ring = document.querySelector(`[data-ring="${id}"]`);
    if (ring) {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const ratio = max > 0 ? Math.min(1, window.scrollY / max) : 0;
      const circumference = 2 * Math.PI * 13;
      ring.setAttribute('stroke-dasharray', circumference.toFixed(1));
      ring.setAttribute('stroke-dashoffset', (circumference * (1 - ratio)).toFixed(1));
    }
  });
}

function wireInfiniteScroll() {
  const sentinel = document.querySelector('[data-sentinel]');
  if (!sentinel || !('IntersectionObserver' in window)) return;
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    ui.limit += PAGE;
    renderAll();
  }, { rootMargin: '600px' });
  observer.observe(sentinel);
}

function wireTimeline() {
  const timeline = document.getElementById('g1-timeline-cal');
  if (!timeline) return;
  const header = timeline.querySelector('[data-timeline-month]');
  const items = [...timeline.querySelectorAll('.timeline-list li')];
  const paint = () => {
    if (!items.length || !header) return;
    const at = window.scrollY + window.innerHeight * 0.35;
    let current = items[0];
    for (const item of items) if (item.offsetTop <= at) current = item;
    header.textContent = current.dataset.month || header.textContent;
    items.forEach((item) => item.classList.toggle('is-past', item === current));
  };
  window.addEventListener('scroll', paint, { passive: true });
  paint();
}

/* ------------------------------------------------------------------ admin -- */

async function loadAdmin() {
  if (!C.state.admin) return;
  try {
    const res = await fetch('/api/community-submissions', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    const slot = document.getElementById('admin-table');
    if (slot) slot.innerHTML = U.inlineTableControl('admin-table-control', (Array.isArray(rows) ? rows : []).slice(0, 12).map((row, i) => ({
      id: String(row.id ?? i + 1).slice(0, 12),
      tracker: String(row.tracker ?? 'visa'),
      applied: String(row.applied ?? '').slice(0, 10),
      decided: String(row.decided ?? '').slice(0, 10),
      outcome: String(row.outcome ?? 'pending'),
    })));
  } catch (error) {
    // Keep the control itself mounted: an endpoint that is unreachable in a
    // preview is a data condition, not a reason for the console to disappear.
    const slot = document.getElementById('admin-table');
    if (slot) slot.innerHTML = `${U.inlineTableControl('admin-table-control', [])}<p class="hint">The submissions endpoint is not reachable in this preview.</p>`;
  }
}

/* -------------------------------------------------- service worker + update -- */

let updateRegistration = null;

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('sw.js');
    updateRegistration = registration;
    const banner = document.getElementById('sw-update-banner');
    const show = () => {
      if (!banner) return;
      if (registration.waiting && navigator.serviceWorker.controller) banner.hidden = false;
    };
    show();
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (installing.state === 'installed') show();
      });
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (banner) banner.hidden = true;
    });
  } catch (error) {
    console.warn('service worker not registered:', error);
  }
}

function reloadForUpdate() {
  updateRegistration?.waiting?.postMessage('SKIP_WAITING');
  const banner = document.getElementById('sw-update-banner');
  if (banner) banner.hidden = true;
  setTimeout(() => location.reload(), 120);
}
