/*
 * Keep relative freshness labels honest after the build.
 *
 * The static HTML is rendered at build time and therefore says "2 days old at
 * last build". This script reads the absolute report/due dates from
 * /data/freshness.json, recomputes the age and publication state against the
 * visitor's current UTC date, and updates tagged elements. Dates are evaluated
 * in UTC so a page crossing midnight does not briefly disagree with the
 * canonical report dates used by the build.
 */
(function (root) {
  'use strict';

  var DAY_MS = 24 * 60 * 60 * 1000;
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var CADENCE_DAYS = {
    'new-delhi': 3,
    beijing: 35,
    dublin: 7,
    'abu-dhabi': 14,
    abuja: 14,
    ankara: 14
  };
  var EXPECTED_INTERVAL_DAYS = {
    'new-delhi': 1,
    beijing: null,
    dublin: 7,
    'abu-dhabi': 7,
    abuja: 7,
    ankara: 7
  };

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function dateKey(value) {
    // Dates can cross a vm/iframe realm boundary in tests and embeds, so use
    // the date protocol instead of an instanceof check.
    if (value && typeof value.toISOString === 'function') {
      var time = Number(value.getTime());
      return Number.isFinite(time) ? value.toISOString().slice(0, 10) : '';
    }
    var match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ''));
    return match ? match[1] : '';
  }

  function parseDay(value) {
    var key = dateKey(value);
    if (!key) return null;
    var parts = key.split('-');
    var time = Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return Number.isFinite(time) ? time : null;
  }

  function todayKey(now) {
    return dateKey(now || new Date());
  }

  function daysBetween(from, to) {
    var start = parseDay(from);
    var end = parseDay(to);
    if (start == null || end == null) return null;
    return Math.max(0, Math.round((end - start) / DAY_MS));
  }

  function addDays(value, days) {
    var base = parseDay(value);
    if (base == null) return '';
    return new Date(base + days * DAY_MS).toISOString().slice(0, 10);
  }

  function weekday(value) {
    var base = parseDay(value);
    return base == null ? -1 : new Date(base).getUTCDay();
  }

  function isWeekend(value) {
    var day = weekday(value);
    return day === 0 || day === 6;
  }

  function longDate(value) {
    var key = dateKey(value);
    var parts = key.split('-');
    var month = MONTHS[Number(parts[1]) - 1];
    return month ? Number(parts[2]) + ' ' + month + ' ' + parts[0] : '';
  }

  function shortDate(value) {
    var key = dateKey(value);
    var parts = key.split('-');
    var month = MONTHS[Number(parts[1]) - 1];
    return month ? Number(parts[2]) + ' ' + month.slice(0, 3) + ' ' + parts[0] : '';
  }

  function weekdayDate(value) {
    var key = dateKey(value);
    if (!key) return '';
    return WEEKDAYS[weekday(key)] + ' ' + longDate(key);
  }

  function nextWeekday(value) {
    var date = addDays(value, 1);
    for (var i = 0; date && i < 8; i += 1) {
      var day = weekday(date);
      if (day !== 0 && day !== 6) return date;
      date = addDays(date, 1);
    }
    return date;
  }

  function nextTuesday(value) {
    var date = addDays(value, 1);
    for (var i = 0; date && i < 8; i += 1) {
      if (weekday(date) === 2) return date;
      date = addDays(date, 1);
    }
    return date;
  }

  function nextWeekdayNumber(value, target) {
    var date = addDays(value, 1);
    for (var i = 0; date && i < 8; i += 1) {
      if (weekday(date) === target) return date;
      date = addDays(date, 1);
    }
    return date;
  }

  function ruleFor(office) {
    return office && office.expected_rule && typeof office.expected_rule === 'object'
      ? office.expected_rule
      : null;
  }

  function expectedDate(reportDate, slug, rule) {
    if (rule) {
      if (rule.kind === 'irregular') return '';
      if (rule.kind === 'weekday') {
        return rule.weekday == null ? nextWeekday(reportDate) : nextWeekdayNumber(reportDate, rule.weekday);
      }
      if (rule.interval) return addDays(reportDate, rule.interval);
    }
    var interval = EXPECTED_INTERVAL_DAYS[slug];
    if (!reportDate || interval == null) return '';
    return slug === 'new-delhi' ? nextWeekday(reportDate) : addDays(reportDate, interval);
  }

  function expectedAfter(reportDate, slug, asOf, rule) {
    var date = expectedDate(reportDate, slug, rule);
    for (var i = 0; date && asOf && date <= asOf && i < 60; i += 1) {
      date = rule
        ? expectedDate(date, slug, rule)
        : slug === 'new-delhi'
          ? nextWeekday(date)
          : addDays(date, EXPECTED_INTERVAL_DAYS[slug]);
    }
    return date;
  }

  // The publication-schedule page has its own cadence modes: Dublin is every
  // Tuesday, while the freshness model uses a seven-day interval from its
  // report date. Keep that distinction here so a dynamic update cannot silently
  // change the page's stated schedule.
  function scheduleDate(reportDate, slug, rule) {
    if (rule) return expectedDate(reportDate, slug, rule);
    if (!reportDate || slug === 'beijing') return '';
    if (slug === 'new-delhi') return nextWeekday(reportDate);
    if (slug === 'dublin') return nextTuesday(reportDate);
    return addDays(reportDate, 7);
  }

  function scheduleAfter(reportDate, slug, asOf, rule) {
    var date = scheduleDate(reportDate, slug, rule);
    for (var i = 0; date && asOf && date <= asOf && i < 60; i += 1) {
      date = rule
        ? expectedDate(date, slug, rule)
        : slug === 'new-delhi'
          ? nextWeekday(date)
          : slug === 'dublin' ? nextTuesday(date) : addDays(date, 7);
    }
    return date;
  }

  function ageLabel(days, atBuild) {
    if (!Number.isFinite(days)) return '';
    return days + ' day' + (days === 1 ? '' : 's') + ' old' + (atBuild ? ' at last build' : '');
  }

  function checkedStamp(value) {
    if (!value) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return shortDate(value);
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
      hourCycle: 'h23'
    }) + ' UTC';
  }

  function observationNote(office) {
    var observed = dateKey(office.observed_data_through);
    var official = dateKey(office.official_data_through || office.report_date);
    if (!observed || !official || observed <= official) return '';
    return 'Tracker observed decisions dated through ' + longDate(observed) +
      '; these are not in the ' + longDate(official) + ' official file.';
  }

  function summary(office, view) {
    var kind = office.snapshot ? 'snapshot' : 'report';
    var decisions = Number(office.decisions) || 0;
    var parts = [
      (office.name || office.slug) + ' — ' + kind + ' ' + longDate(office.report_date),
      decisions.toLocaleString('en-IE') + ' decisions'
    ];
    var through = longDate(office.official_data_through);
    if (through && dateKey(office.official_data_through) !== dateKey(office.report_date)) {
      parts.push('official decisions dated through ' + through);
    }
    if (view.age_label) parts.push(view.age_label);
    var checked = office.checked_label || office.last_success_label ||
      checkedStamp(office.checked_at || office.last_success_at);
    if (checked) parts.push('checked ' + checked);
    return parts.join(' · ');
  }

  function warning(office, view) {
    if (office.status === 'error') {
      return office.note || 'The tracker could not read a newer official file for this office.';
    }
    if (view.overdue) {
      return 'This office report is overdue: expected since ' + longDate(view.due_at) + '.' +
        (view.next_due_label ? ' ' + view.next_due_label + '.' : '');
    }
    if (view.stale) {
      return 'This office report is ' + view.age_label + '; a newer decision may not appear here yet.';
    }
    return '';
  }

  function searchImpact(office, view) {
    var name = office.name || office.slug || 'This office';
    var report = longDate(view.report_date);
    var missing = ' A decision published after that may not appear in a search yet.';
    if (view.status === 'error') {
      return 'We couldn\'t refresh ' + name + ' this time.' +
        (report ? ' The latest official report is ' + report + '.' : '') + missing;
    }
    if (view.overdue) {
      return 'The ' + name + ' report is overdue' +
        (view.due_at ? ' (expected since ' + longDate(view.due_at) + ')' : '') + '.' +
        (report ? ' The latest official report is ' + report + '.' : '') + missing;
    }
    if (view.stale) {
      return 'The latest ' + name + ' report is ' + (view.age_label || 'older than expected') + '.' +
        (report ? ' It is dated ' + report + '.' : '') + missing;
    }
    if (office.snapshot) return 'Live snapshot. A search covers the latest published list.';
    return 'Current. A search covers the latest official report.';
  }

  function compute(office, now) {
    office = office || {};
    var slug = office.slug || '';
    var today = todayKey(now);
    var reportDate = dateKey(office.report_date);
    var age = daysBetween(reportDate, today);
    var rule = ruleFor(office);
    var dueAt = expectedDate(reportDate, slug, rule);
    var nextDueAt = expectedAfter(reportDate, slug, today, rule);
    var overdue = Boolean(dueAt && today && dueAt < today &&
      !(slug === 'new-delhi' && isWeekend(today)));
    var cadence = Number(office.cadence_days) || CADENCE_DAYS[slug] || 14;
    var stale = age != null && age > cadence;
    var status = String(office.status || 'official');
    var statusTone = status === 'error' ? 'error' : status !== 'official' || stale || overdue ? 'warn' : '';
    var dueLabel = dueAt
      ? overdue
        ? 'Due since ' + longDate(dueAt) + ' — not yet published'
        : 'Expected ' + longDate(dueAt >= today ? dueAt : nextDueAt)
      : '';
    var nextDueLabel = overdue && nextDueAt ? 'Next expected ' + longDate(nextDueAt) : '';
    var view = {
      status: status,
      report_date: reportDate,
      age_days: age,
      age_label: ageLabel(age),
      stale: stale,
      due_at: dueAt,
      next_due_at: nextDueAt,
      overdue: overdue,
      overdue_days: overdue ? daysBetween(dueAt, today) : 0,
      due_label: dueLabel,
      due_short_label: overdue ? 'Due since ' + shortDate(dueAt) : '',
      next_due_label: nextDueLabel,
      status_tone: statusTone,
      attention: Boolean(statusTone)
    };
    view.status_label = status === 'error' ? 'Couldn\'t refresh' : overdue ? 'Report overdue' :
      (office.status_label || (office.snapshot ? 'Snapshot' : status.charAt(0).toUpperCase() + status.slice(1)));
    view.observation_note = observationNote(office);
    view.summary = summary(office, view);
    view.warning = warning(office, view);
    view.search_impact = searchImpact(office, view);
    return Object.assign({}, office, view);
  }

  function schedule(office, now) {
    office = office || {};
    var slug = office.slug || '';
    var today = todayKey(now);
    var reportDate = dateKey(office.report_date);
    var age = daysBetween(reportDate, today);
    var rule = ruleFor(office);
    var dueAt = scheduleDate(reportDate, slug, rule);
    var nextDueAt = scheduleAfter(reportDate, slug, today, rule);
    var overdue = Boolean(dueAt && today && dueAt < today &&
      !(slug === 'new-delhi' && isWeekend(today)));
    return {
      age_days: age,
      age_label: ageLabel(age),
      due_at: dueAt,
      next_due_at: nextDueAt,
      overdue: overdue,
      expected_at: dueAt >= today ? dueAt : nextDueAt
    };
  }

  function scheduleHTML(office, now) {
    var view = schedule(office, now);
    if (!view.due_at) return 'No fixed date';
    if (view.overdue) {
      return '<strong>Due since ' + escapeHtml(weekdayDate(view.due_at)) + ' — not yet published</strong>' +
        '<br><span class="small-note">Next expected ' + escapeHtml(weekdayDate(view.next_due_at)) + '</span>';
    }
    return '<strong>' + escapeHtml(weekdayDate(view.expected_at)) + '</strong>' +
      '<br><span class="small-note">Expected, not guaranteed</span>';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character];
    });
  }

  function bySlug(payload) {
    var map = Object.create(null);
    ((payload && payload.offices) || []).forEach(function (office) {
      if (office && office.slug) map[office.slug] = office;
    });
    return map;
  }

  function updateOfficeBlocks(map, now) {
    var blocks = document.querySelectorAll('[data-freshness]');
    for (var i = 0; i < blocks.length; i += 1) {
      var block = blocks[i];
      var office = map[block.getAttribute('data-freshness')];
      if (!office) continue;
      var view = compute(office, now);
      var tone = view.status_tone ? ' is-' + view.status_tone : '';
      block.innerHTML = '<span class="freshness-chip' + tone + '">' + escapeHtml(view.status_label) + '</span> ' +
        escapeHtml(view.summary) +
        (view.observation_note ? ' <span class="office-freshness-observation">' + escapeHtml(view.observation_note) + '</span>' : '') +
        (view.warning ? ' <span class="office-freshness-warning">' + escapeHtml(view.warning) + '</span>' : '');
    }
  }

  function updateStatusRows(map, now) {
    var rows = document.querySelectorAll('[data-freshness-slug][data-freshness-view="status"]');
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      var office = map[row.getAttribute('data-freshness-slug')];
      if (!office) continue;
      var view = compute(office, now);
      var age = row.querySelector('[data-freshness-age]');
      if (age) age.textContent = [view.age_label, view.due_short_label].filter(Boolean).join(' · ');
      var impact = row.querySelector('[data-freshness-impact]');
      if (impact) impact.textContent = view.search_impact;
      var pill = row.querySelector('[data-freshness-status]');
      if (pill) {
        pill.className = 'status-pill' + (view.status_tone ? ' is-' + view.status_tone : '');
        pill.textContent = view.status_label;
        if (view.warning) pill.setAttribute('title', view.warning);
        else pill.removeAttribute('title');
      }
    }
  }

  function updateScheduleRows(map, now) {
    var rows = document.querySelectorAll('[data-freshness-slug][data-freshness-view="schedule"]');
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      var office = map[row.getAttribute('data-freshness-slug')];
      if (!office) continue;
      var view = schedule(office, now);
      var age = row.querySelector('[data-freshness-age]');
      if (age) age.textContent = view.age_label;
      var expected = row.querySelector('[data-freshness-expected]');
      if (expected) expected.innerHTML = scheduleHTML(office, now);
    }
  }

  function paint(payload, now) {
    var map = bySlug(payload);
    updateOfficeBlocks(map, now || new Date());
    updateStatusRows(map, now || new Date());
    updateScheduleRows(map, now || new Date());
    return map;
  }

  // A page generated for "today" is only today on the day it was built. The
  // daily pages are rebuilt when the data changes, not on a clock, so say
  // plainly when the reader is looking at an older snapshot.
  function dublinToday() {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(new Date());
    } catch (error) {
      return todayKey(new Date());
    }
  }

  function initSnapshotNote() {
    var el = document.querySelector('[data-snapshot-day]');
    if (!el) return;
    var built = String(el.getAttribute('data-snapshot-day') || '').slice(0, 10);
    var today = dublinToday();
    if (!built || !today || built === today) return;
    el.innerHTML = 'This page is a snapshot for ' + escapeHtml(longDate(built)) +
      '. Today is ' + escapeHtml(longDate(today)) +
      ' — open <a href="/status">Data status</a> for the newest checks.';
    el.hidden = false;
  }

  function init() {
    if (typeof document === 'undefined') return;
    initSnapshotNote();
    if (typeof fetch !== 'function') return;
    if (!document.querySelector('[data-freshness], [data-freshness-slug]')) return;
    fetch('/data/freshness.json', { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (payload) {
        var cached = payload;
        paint(cached, new Date());
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden) paint(cached, new Date());
        });
      })
      .catch(function () { /* the honest at-last-build labels remain */ });
  }

  root.IVFreshness = {
    ageDays: daysBetween,
    ageLabel: ageLabel,
    longDate: longDate,
    shortDate: shortDate,
    weekdayDate: weekdayDate,
    compute: compute,
    schedule: schedule,
    scheduleHTML: scheduleHTML,
    paint: paint
  };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof window !== 'undefined' ? window : globalThis);
