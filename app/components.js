/* Component markup.
 *
 * Every builder returns a string and carries `data-component="<slug>"`, which is
 * the instrumentation `verify:components` reads at runtime — an integrated
 * component that renders nowhere is not integrated.
 *
 * The components are class-only rebuilds on the shared tokens exactly as on the
 * Portal and the Module Picker: this site's `_headers` sends `style-src 'self'`,
 * so a library that writes a runtime <style> or style attribute (Radix
 * scroll-lock, sonner, vaul) would be refused by the browser. See
 * design-system/docs/STYLE_DECISIONS.md for the per-component record.
 *
 * Colour rule for this site: the accent is the neutral blue scale. Green, red
 * and amber appear on decision states and nowhere else — so every component
 * below is accent-neutral unless it is rendering an actual outcome.
 */
import { esc, fmtNum, fmtDate, fmtShort, fmtPct, decisionTone } from './core.js';

const icon = {
  search: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  sun: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  up: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6"/></svg>',
  info: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M12 11v5"/></svg>',
  dots: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5.2 5.2L20 6.6"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
  share: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="M8.4 10.8l7.2-4.4M8.4 13.2l7.2 4.4"/></svg>',
  pin: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11z"/><circle cx="12" cy="10" r="2.4"/></svg>',
};

/* --------------------------------------------------------------- navigation -- */

/** Gooey Nav — the tracker switcher. One indicator, driven by [aria-current]. */
export function gooeyNav(items, active) {
  return `<span class="gooey-indicator" aria-hidden="true"></span>${items
    .map(
      (item) => `<button type="button" class="gooey-item${item.id === active ? ' is-active' : ''}" data-component="gooey-nav"
        data-action="tracker" data-tracker="${item.id}" ${item.id === active ? 'aria-current="page"' : ''}>${item.label}</button>`
    )
    .join('')}`;
}

/** Switch Mode — light/dark, a real switch so its state is announced. */
export function switchMode(theme) {
  const dark = theme === 'dark';
  return `<button type="button" class="switch-mode touch-target" role="switch" aria-checked="${dark}" aria-label="Dark mode" data-component="switch-mode" data-action="theme">
    <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
    <span class="switch-icon" aria-hidden="true">${dark ? icon.moon : icon.sun}</span>
  </button>`;
}

/** Fluid Tabs — pill tablist. Its own group id keeps the indicator scoped. */
export function fluidTabs(groupId, tabs, active) {
  return `<div class="fluid-tabs" role="tablist" aria-label="Visa tracker views" data-component="fluid-tabs" data-layout-group="${groupId}">
    ${tabs
      .map(
        (tab) => `<button type="button" role="tab" id="tab-${groupId}-${tab.id}" aria-selected="${tab.id === active}" tabindex="${tab.id === active ? '0' : '-1'}"
          aria-controls="panel-${groupId}-${tab.id}" data-action="tab" data-tab="${tab.id}">${tab.label}</button>`
      )
      .join('')}
  </div>`;
}

/** Scroll Island — sticky section index with a scroll-progress ring. */
export function scrollIsland(id, items, label = 'On this page') {
  return `<nav class="scroll-island" aria-label="${esc(label)}" data-component="scroll-island" id="island-${id}">
    <span class="scroll-island-label">${esc(label)}</span>
    <svg class="island-ring" viewBox="0 0 32 32" aria-hidden="true"><circle class="ring-track" cx="16" cy="16" r="13"/><circle class="ring-fill" cx="16" cy="16" r="13" data-ring="${id}"/></svg>
    ${items.map((item) => `<a href="#${id}-${item.id}" data-island="${id}" data-target="${item.id}">${esc(item.label)}</a>`).join('')}
  </nav>`;
}

/* ------------------------------------------------------------- measurement -- */

/** Animated Counter — the DOM value is always the final one, and the value is
 *  the control: it opens the rows on this screen that the figure summarises. */
export function animatedCounter({ id, value, label, hint, format = fmtNum, tone = '', suffix = '' }) {
  const shown = `${esc(format(value))}${esc(suffix)}`;
  return `<div class="counter${tone ? ` is-${tone}` : ''}" data-component="animated-counter">
    <button type="button" class="counter-value counter-figure tabular" id="${id}" data-counter="${value}" data-target="${value}" data-action="counter-drill" data-counter-id="${id}" aria-label="${shown} — open the rows behind this figure">${shown}</button>
    <span class="counter-label">${esc(label)}${hint ? warmTooltip(`tip-${id}`, hint) : ''}</span>
  </div>`;
}

/** Warm Tooltip — a "warm" window means one open tooltip closes the others. */
export function warmTooltip(id, text) {
  return `<span class="tip-wrap"><button type="button" class="tip-trigger" aria-describedby="${id}" aria-expanded="false" data-component="warm-tooltip" data-action="tip" data-tip="${id}">${icon.info}<span class="sr-only">What this means</span></button><span class="warm-tooltip" role="tooltip" id="${id}" hidden>${esc(text)}</span></span>`;
}

/** GitHub Activity — any dated metric as a heatmap. Cells are real buttons. */
export function githubActivity(id, grid) {
  return `<div class="activity" data-component="github-activity" id="${id}">
    <div class="activity-grid" role="group" aria-label="Applications per day, last ${grid.weeks} weeks">
      ${grid.cells
        .map(
          (cell) => `<button type="button" class="activity-cell level-${cell.level}" data-action="day" data-date="${cell.date}"
            aria-label="${fmtDate(cell.date)}: ${cell.count} application${cell.count === 1 ? '' : 's'}"><span class="sr-only">${cell.count}</span></button>`
        )
        .join('')}
    </div>
    <div class="activity-legend"><span>${fmtShort(grid.start)}</span><span class="legend-scale" aria-hidden="true">${[0, 1, 2, 3, 4].map((level) => `<i class="activity-cell level-${level}"></i>`).join('')}</span><span>${fmtShort(grid.end)}</span></div>
    <p class="hint">Each cell is one published day; the darker it is, the more decisions landed. Busiest day: <strong>${fmtNum(grid.max)}</strong>.</p>
  </div>`;
}

/**
 * Analytics Chart — single-series SVG line with focusable dots.
 * `format` labels the value; `caption` explains the series in words, because a
 * chart without a sentence is decoration.
 */
export function analyticsChart(id, series, { label, valueLabel = 'value', format = fmtNum, caption = '' }) {
  const points = series.slice(-60);
  if (!points.length) return `<figure class="chart" data-component="analytics-chart"><figcaption>${esc(label)}</figcaption><p class="empty">Awaiting data…</p></figure>`;
  const width = 640;
  const height = 190;
  const pad = { top: 16, right: 14, bottom: 26, left: 34 };
  const values = points.map((p) => p.value);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const x = (i) => pad.left + (points.length === 1 ? (width - pad.left - pad.right) / 2 : (i * (width - pad.left - pad.right)) / (points.length - 1));
  const y = (v) => pad.top + (1 - (v - min) / span) * (height - pad.top - pad.bottom);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const first = points[0];
  const last = points[points.length - 1];
  return `<figure class="chart" data-component="analytics-chart" id="${id}">
    <figcaption><span>${esc(label)}</span><span class="chart-range">${fmtShort(first.date)} – ${fmtShort(last.date)}</span></figcaption>
    <svg viewBox="0 0 ${width} ${height}" role="group" aria-label="${esc(label)}: ${esc(caption)}">
      <line class="chart-grid" x1="${pad.left}" x2="${width - pad.right}" y1="${height - pad.bottom}" y2="${height - pad.bottom}"/>
      <line class="chart-grid" x1="${pad.left}" x2="${width - pad.right}" y1="${pad.top}" y2="${pad.top}"/>
      <text x="${pad.left - 6}" y="${pad.top + 4}" text-anchor="end">${esc(format(max))}</text>
      <text x="${pad.left - 6}" y="${height - pad.bottom + 4}" text-anchor="end">${esc(format(min))}</text>
      <path class="chart-line" d="${path}"/>
      ${points
        .map(
          (p, i) => `<g class="chart-dot" tabindex="0" role="button" aria-label="${fmtDate(p.date)}: ${esc(format(p.value))} ${esc(valueLabel)}" data-action="point" data-date="${p.date}" data-value="${p.value}">
            <circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="9" class="dot-hit"/><circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3.2"/></g>`
        )
        .join('')}
    </svg>
    <div class="chart-foot"><span>${esc(caption)}</span><span class="chart-readout" data-chart-readout="${id}">Latest: <strong>${esc(format(last.value))}</strong></span></div>
  </figure>`;
}

/** Fund Widget — vertical carousel with arrow buttons so it is not drag-only. */
export function fundWidget(id, items) {
  return `<div class="fund" data-component="fund-widget" id="${id}" data-index="0">
    <div class="fund-viewport">
      ${items
        .map(
          (item, i) => `<article class="fund-card${i === 0 ? ' is-current' : ''}" data-fund-item="${i}"${i === 0 ? '' : ' hidden'}>
        <div class="fund-top"><span>${esc(item.label)}</span><strong>${esc(item.value)}</strong></div>
        <progress class="fund-track" max="100" value="${Math.round((item.ratio || 0) * 100)}" aria-label="${esc(item.label)} share of its scale">${Math.round((item.ratio || 0) * 100)}%</progress>
        <div class="fund-foot"><span>${esc(item.detail)}</span><span class="mono">${esc(item.change || '')}</span></div>
      </article>`
        )
        .join('')}
    </div>
    <div class="fund-controls">
      <button type="button" class="btn btn-quiet touch-target" data-component="fund-widget" data-action="fund-step" data-dir="-1" aria-label="Previous tracker">${icon.up}</button>
      <span class="fund-count mono" data-fund-count>1 / ${items.length}</span>
      <button type="button" class="btn btn-quiet touch-target" data-component="fund-widget" data-action="fund-step" data-dir="1" aria-label="Next tracker">${icon.down}</button>
    </div>
  </div>`;
}

/* ---------------------------------------------------------------- controls -- */

/** Jelly Radio — a single choice whose chip pushes its neighbours. */
export function jellyRadio(name, legend, items, value) {
  return `<fieldset class="jelly-radio" data-component="jelly-radio">
    <legend>${esc(legend)}</legend>
    ${items
      .map(
        (item) => `<label><input type="radio" name="${esc(name)}" value="${esc(item.value)}" data-action="jelly" data-group="${esc(name)}"${item.value === value ? ' checked' : ''}/><span>${esc(item.label)}</span></label>`
      )
      .join('')}
  </fieldset>`;
}

/** Rubber Segment — mode switch, ≤4 short labels, sliding indicator. */
export function rubberSegment(name, legend, items, value) {
  const index = Math.max(0, items.findIndex((item) => item.value === value));
  return `<div class="rubber-segment" role="radiogroup" aria-label="${esc(legend)}" data-component="rubber-segment" data-segment-group="${esc(name)}" data-index="${index}">
    <span class="rubber-indicator" aria-hidden="true" data-segment-indicator></span>
    ${items
      .map(
        (item, i) => `<button type="button" role="radio" class="sem-chip${item.value === value ? ' active' : ''}" aria-checked="${item.value === value}" tabindex="${item.value === value ? '0' : '-1'}"
          data-action="segment" data-group="${esc(name)}" data-value="${esc(item.value)}">${esc(item.label)}</button>`
      )
      .join('')}
  </div>`;
}

/** Squish Switch — a labelled native checkbox styled as a switch. */
export function squishSwitch(id, label, checked, hint = '') {
  return `<label class="squish-switch" data-component="squish-switch">
    <input type="checkbox" id="${id}" data-action="switch" data-key="${id}"${checked ? ' checked' : ''}/>
    <span>${esc(label)}${hint ? `<span class="switch-hint">${esc(hint)}</span>` : ''}</span>
  </label>`;
}

/** Stepper — numeric input with ± buttons and rolling digits. */
export function stepper(id, label, value, { min = 0, max = 120, suffix = 'days' } = {}) {
  return `<div class="stepper-control" data-component="stepper" data-stepper="${id}">
    <label for="${id}">${esc(label)}</label>
    <button type="button" class="stepper-button touch-target" data-action="step" data-dir="-1" data-target="${id}" aria-label="Decrease ${esc(label)}">−</button>
    <input type="number" id="${id}" name="${id}" value="${value}" min="${min}" max="${max}" step="1" inputmode="numeric" data-action="step-value" data-target="${id}"/>
    <button type="button" class="stepper-button touch-target" data-action="step" data-dir="1" data-target="${id}" aria-label="Increase ${esc(label)}">+</button>
    <span class="stepper-suffix">${esc(suffix)}</span>
  </div>`;
}

/** Glide Select — the CSP-safe select base: native, labelled, token-styled. */
export function glideSelect(id, label, options, value) {
  return `<label class="field" for="${id}"><span class="field-label">${esc(label)}</span>
    <select class="glide-select" id="${id}" data-component="glide-select" data-action="select" data-key="${esc(id)}">
      ${options.map((o) => `<option value="${esc(o.value)}"${o.value === value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
    </select>
  </label>`;
}

/** Skiper68 — exact numeric entry (application numbers are digits only). */
export function skiper68({ id, label, value = '', placeholder = '', digits = 6, maxlength = 12 }) {
  return `<div class="number-field" data-component="skiper68">
    <label class="sr-only" for="${id}">${esc(label)}</label>
    <input class="input tabular" id="${id}" name="${id}" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off"
      maxlength="${maxlength}" placeholder="${esc(placeholder)}" value="${esc(value)}" data-digits="${digits}" data-action="digits"/>
  </div>`;
}

/** Skiper74 — sticky-month timeline: the month updates while you scroll. */
export function skiper74(id, items) {
  return `<div class="timeline" data-component="skiper74" id="${id}">
    <div class="timeline-sticky"><span data-timeline-month>${items.length ? fmtDate(items[0].date, { month: 'long', year: 'numeric' }) : 'Awaiting data…'}</span><span class="mono" data-timeline-count>${items.length} milestones</span></div>
    <button type="button" class="timeline-open" data-action="history-drill" aria-label="Open every observation behind this timeline">Open every observation ↓</button>
    <ol class="timeline-list">
      ${items
        .map(
          (item) => `<li data-month="${fmtDate(item.date, { month: 'long', year: 'numeric' })}"><span class="timeline-date">${fmtShort(item.date)}</span><span class="timeline-label">${esc(item.label)}</span><span class="timeline-value mono">${esc(item.value)}</span></li>`
        )
        .join('')}
    </ol>
  </div>`;
}

/** Filter Disclosure — single-choice icon filter, collapses when you pick one. */
export function filterDisclosure(id, items, active) {
  return `<details class="filter-disclosure" data-component="filter-disclosure" data-filter-group="${esc(id)}" open>
    <summary>Filter<span class="filter-hint">${esc((items.find((i) => i.value === active) || items[0]).label)}</span></summary>
    <div class="filter-items">
      ${items
        .map(
          (item) => `<button type="button" class="filter-item${item.value === active ? ' is-active' : ''}" aria-pressed="${item.value === active}" data-action="filter" data-group="${esc(id)}" data-value="${esc(item.value)}">
          <span class="filter-dot" aria-hidden="true"></span>${esc(item.label)}<span class="filter-count mono">${item.count ?? ''}</span></button>`
        )
        .join('')}
    </div>
  </details>`;
}

/** Inline Disclosure Menu — per-row actions behind a disclosure, with confirm. */
export function inlineDisclosure(id, items) {
  return `<details class="inline-disclosure" data-component="inline-disclosure-menu" data-menu="${esc(id)}">
    <summary aria-haspopup="true">${icon.dots}<span>Actions</span></summary>
    <div class="inline-menu-items">
      ${items
        .map(
          (item) => `<button type="button" class="menu-item" data-action="${item.action}" data-value="${esc(item.value ?? '')}">${item.icon || ''}<span>${esc(item.label)}</span></button>`
        )
        .join('')}
    </div>
  </details>`;
}

/** Time Undo Action — destructive action applied now, undo window afterwards. */
export function timeUndoAction({ id, label, countdown = 6, disabled = false }) {
  return `<div class="undo-action" data-component="time-undo-action" data-undo="${id}" data-countdown="${countdown}">
    <button type="button" class="btn btn-danger touch-target" data-action="undo-start" data-value="${esc(id)}"${disabled ? ' disabled' : ''}>${esc(label)}</button>
    <span class="undo-count" data-undo-count hidden role="status"></span>
    <button type="button" class="btn btn-quiet touch-target" data-action="undo-cancel" data-value="${esc(id)}" hidden>Cancel</button>
  </div>`;
}

/** Dynamic Button — the label is a string that crossfades on state change. */
export function dynamicButton({ id, label, action, value = '', variant = 'primary', iconName = '', attrs = '' }) {
  return `<button type="button" class="btn btn-${variant} dynamic-button touch-target" id="${id}" data-component="dynamic-button" data-action="${action}" data-value="${esc(value)}" data-label="${esc(label)}" ${attrs}>
    <span class="dynamic-label">${esc(label)}</span>${iconName ? `<span class="btn-icon" aria-hidden="true">${icon[iconName] || ''}</span>` : ''}
  </button>`;
}

/** Swipe Row — swipe (or the actions key) reveals fixed-height row actions. */
export function swipeRow(id, content, actions) {
  return `<div class="swipe-row" data-component="swipe-row" data-swipe="${esc(id)}">
    <div class="swipe-surface">${content}</div>
    <div class="swipe-actions" id="swipe-${esc(id)}" hidden>
      ${actions.map((a) => `<button type="button" class="btn btn-quiet touch-target" data-action="${a.action}" data-value="${esc(a.value)}">${a.label}</button>`).join('')}
    </div>
      <button type="button" class="swipe-toggle" aria-expanded="false" aria-controls="swipe-${esc(id)}" data-action="swipe-toggle" data-value="${esc(id)}" aria-label="Row actions for ${esc(id)}">${icon.dots}</button>
  </div>`;
}

/** Transaction List — compact rows: a label, a detail and a state badge. */
export function transactionList(id, rows, emptyLabel) {
  return `<div class="transactions" data-component="transaction-list" id="${id}">
    ${rows.length ? rows.join('') : `<p class="empty">${esc(emptyLabel)}</p><button type="button" class="txn-open" data-action="focus-search" aria-label="Search an application by application number">Search an application →</button>`}
  </div>`;
}

/** Inline Table Control — inline edit of a row, labelled read-only here. */
export function inlineTableControl(id, rows) {
  return `<div class="inline-table" data-component="inline-table-control" id="${id}">
    <p class="hint">Preview only: submissions are read from <code>/api/community-submissions</code> and this console never writes. Edits are discarded.</p>
    <ul class="inline-table-rows">
      ${rows
        .map(
          (row, i) => `<li><span class="mono">${esc(row.id)}</span>
            <label><span class="sr-only">Tracker</span><input class="input" value="${esc(row.tracker)}" readonly /></label>
            <label><span class="sr-only">Applied</span><input class="input" value="${esc(row.applied)}" readonly /></label>
            <label><span class="sr-only">Decided</span><input class="input" value="${esc(row.decided)}" readonly /></label>
            <span class="state-chip state-chip-soft">${esc(row.outcome)}</span></li>`
        )
        .join('') || `<li class="empty">No pending submissions in the preview. <button type="button" class="btn btn-quiet touch-target" data-action="reload-admin">Reload submissions</button></li>`}
    </ul>
  </div>`;
}

/** Feedback — the existing fields and honeypot, with a rating in front. */
export function feedbackForm({ state: status = 'idle', message = '' } = {}) {
  const disabled = status === 'sending';
  if (status === 'sent') {
    return `<div class="feedback card feedback-sent" id="suggest-form-sent" data-component="feedback" role="status">
      <div class="success-mark" aria-hidden="true">${icon.check}</div>
      <h3>${esc(message || 'Suggestion sent.')}</h3>
      <p class="hint">It is stored through this site's own form endpoint. I read every one.</p>
    </div>`;
  }
  return `<form class="feedback card" id="suggest-form" name="suggestions" novalidate data-component="feedback">
    <div class="feedback-head">
      <div><h3>Suggestions</h3><p class="hint">I read every one and reply as soon as I can.</p></div>
      <div class="feedback-rating" role="group" aria-label="Was this useful?">
        <button type="button" class="rating touch-target" data-action="rate" data-rate="up" aria-pressed="false" aria-label="This was useful">👍</button>
        <button type="button" class="rating touch-target" data-action="rate" data-rate="down" aria-pressed="false" aria-label="This was not useful">👎</button>
      </div>
    </div>
    <label class="field"><span class="field-label">Name</span><input class="input" id="sugg-name" name="name" type="text" autocomplete="name" maxlength="120" placeholder="Your name…" ${disabled ? 'disabled' : ''}/></label>
    <label class="field"><span class="field-label">Suggestion</span><textarea class="input" id="sugg-text" name="suggestion" rows="4" maxlength="2000" placeholder="What should change?" ${disabled ? 'disabled' : ''}></textarea></label>
    <p class="hp" aria-hidden="true"><label>Leave this field empty<input type="text" name="bot-field" id="sugg-bot" tabindex="-1" autocomplete="off"/></label></p>
    <div class="form-actions">
      ${dynamicButton({ id: 'sugg-submit', label: status === 'sending' ? 'Sending…' : 'Send suggestion', action: 'submit-suggestion', attrs: disabled ? 'disabled' : '' })}
      <p class="form-status" id="sugg-status" role="status">${esc(message)}</p>
    </div>
  </form>`;
}

/** Expandable Profile Card — trigger + the dialog it expands into. */
export function profileCardTrigger(id, label, index) {
  return `<button type="button" class="profile-trigger touch-target" data-component="expandable-profile-card" data-action="open-profile" data-value="${index}" aria-haspopup="dialog">${esc(label)}</button>`;
}

export function profileCardDialog() {
  return `<dialog class="profile-dialog" id="profile-dialog" aria-labelledby="profile-title">
    <div class="profile-dialog-head"><div><p class="eyebrow">Community timeline</p><h2 id="profile-title">Awaiting data…</h2></div><button type="button" class="btn btn-quiet touch-target" data-action="close-profile">Close</button></div>
    <div class="profile-dialog-body" id="profile-body"></div>
  </dialog>`;
}

/* ------------------------------------------------------------------- pieces -- */

export function statBadge(row) {
  if (row.placeholder) return '<span class="badge badge-notice">Notice</span>';
  return `<span class="badge badge-${decisionTone(row)}">${esc(row.decision || '—')}</span>`;
}

export function statusLine(tone, text) {
  return `<p class="status-line status-${esc(tone)}">${text}</p>`;
}

export function publishChip(tone, text) {
  return `<span class="state-chip state-chip-${tone === 'live' ? 'live' : tone === 'late' ? 'late' : 'soft'}">${esc(text)}</span>`;
}

export function progressRing(value, max, label) {
  const pct = max > 0 ? Math.min(1, value / max) : 0;
  const circumference = 2 * Math.PI * 26;
  return `<div class="ring-figure" role="img" aria-label="${esc(label)}: ${fmtPct(pct)}"><svg viewBox="0 0 64 64" aria-hidden="true">
    <circle class="ring-track" cx="32" cy="32" r="26"/><circle class="ring-fill" cx="32" cy="32" r="26" stroke-dasharray="${circumference.toFixed(1)}" stroke-dashoffset="${(circumference * (1 - pct)).toFixed(1)}"/>
  </svg><span class="ring-value tabular">${fmtPct(pct)}</span></div>`;
}
