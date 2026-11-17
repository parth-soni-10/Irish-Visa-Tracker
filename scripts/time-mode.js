/*
 * One time-zone choice for every clock KPI on the site.
 *
 * UTC is the default and the storage-independent fallback. Times are rendered
 * as <time data-iv-time="ISO" data-iv-time-format="preset"> so toggling updates
 * existing nodes in place instead of re-rendering a tab (and losing a search).
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'visa-time-mode';
  var NEW_DELHI_TIME_ZONE = 'Asia/Kolkata';
  var PRESETS = {
    full: { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' },
    short: { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' },
    weekday: { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' },
    time: { hour: '2-digit', minute: '2-digit' }
  };
  var WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  var mode = readMode();
  var zoneFormatter = null;
  var zoneFormatters = {};

  function readMode() {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'local' ? 'local' : 'utc';
    } catch (error) {
      return 'utc';
    }
  }

  function storeMode(next) {
    try { localStorage.setItem(STORAGE_KEY, next); } catch (error) { /* private mode */ }
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character];
    });
  }

  function toDate(value) {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    var date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  // Read a timestamp's wall-clock fields in a named IANA zone. This keeps
  // conversions correct across offset changes instead of baking in an offset.
  function partsInZone(date, timeZone) {
    try {
      var formatter = zoneFormatters[timeZone];
      if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-GB', {
          timeZone: timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          weekday: 'short',
          hourCycle: 'h23'
        });
        zoneFormatters[timeZone] = formatter;
      }
      var parts = formatter.formatToParts(date);
      var fields = {};
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type !== 'literal') fields[parts[i].type] = parts[i].value;
      }
      var weekday = fields.weekday || '';
      return {
        year: Number(fields.year),
        month: Number(fields.month),
        day: Number(fields.day),
        hour: Number(fields.hour),
        minute: Number(fields.minute),
        second: Number(fields.second),
        weekday: weekday,
        weekdayIndex: WEEKDAYS[weekday]
      };
    } catch (error) {
      return null;
    }
  }

  function wallClockToDate(year, month, day, hour, minute, second, timeZone) {
    var wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second || 0);
    var offset = 0;
    // Resolve the wall clock through the zone's current rules. Re-evaluate the
    // offset at the candidate instant so a daylight-saving change is applied.
    for (var i = 0; i < 3; i++) {
      var observed = partsInZone(new Date(wallAsUtc - offset), timeZone);
      if (!observed) return null;
      var observedWall = Date.UTC(observed.year, observed.month - 1, observed.day,
        observed.hour, observed.minute, observed.second);
      var nextOffset = observedWall - (wallAsUtc - offset);
      if (nextOffset === offset) break;
      offset = nextOffset;
    }
    var result = new Date(wallAsUtc - offset);
    return Number.isNaN(result.getTime()) ? null : result;
  }

  function newDelhiToDate(value) {
    var source = String(value || '').trim();
    // lastRunAt is usually an unzoned New Delhi wall clock, but an explicit
    // Z/offset is already an instant and must not be shifted a second time.
    if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(source)) return toDate(source);
    var match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(source);
    if (!match) return toDate(source);
    return wallClockToDate(+match[1], +match[2], +match[3],
      +match[4], +match[5], +(match[6] || 0), NEW_DELHI_TIME_ZONE);
  }

  function newDelhiParts(date) {
    var parts = partsInZone(date instanceof Date ? date : new Date(), NEW_DELHI_TIME_ZONE);
    if (!parts) return null;
    parts.date = parts.year + '-' + pad(parts.month) + '-' + pad(parts.day);
    return parts;
  }

  function localZoneLabel(date) {
    if (mode === 'utc') return 'UTC';
    try {
      if (!zoneFormatter) {
        zoneFormatter = new Intl.DateTimeFormat('en-GB', {
          timeZoneName: 'short',
          hour: '2-digit',
          minute: '2-digit'
        });
      }
      var parts = zoneFormatter.formatToParts(date);
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'timeZoneName' && parts[i].value) return parts[i].value;
      }
    } catch (error) { /* Intl can be unavailable in a stripped runtime */ }
    return 'Local';
  }

  function formatDate(date, preset) {
    var options = PRESETS[preset] || PRESETS.short;
    var format = {};
    Object.keys(options).forEach(function (key) { format[key] = options[key]; });
    format.hourCycle = 'h23';
    if (mode === 'utc') format.timeZone = 'UTC';
    return date.toLocaleString('en-GB', format) + ' ' + localZoneLabel(date);
  }

  function node(value, preset) {
    var date = toDate(value);
    if (!date) return escapeHtml('Not recorded');
    var key = PRESETS[preset] ? preset : 'short';
    var iso = date.toISOString();
    return '<time datetime="' + iso + '" data-iv-time="' + iso +
      '" data-iv-time-format="' + key + '">' + escapeHtml(formatDate(date, key)) + '</time>';
  }

  function newDelhiNode(value, preset) {
    var date = newDelhiToDate(value);
    return date ? node(date, preset) : escapeHtml('Not recorded');
  }

  function scheduleDate(hour, minute) {
    var today = newDelhiParts(new Date());
    if (!today) return null;
    // Callers pass New Delhi wall-clock hours (11:00 for the normal weekly
    // report). Convert through the zone rather than assuming a fixed UTC time.
    return wallClockToDate(today.year, today.month, today.day, hour, minute, 0, NEW_DELHI_TIME_ZONE);
  }

  function scheduleNode(hour, minute, preset) {
    var date = scheduleDate(hour, minute);
    return date ? node(date, preset || 'time') : escapeHtml('Not recorded');
  }

  function refreshTimes() {
    var nodes = document.querySelectorAll('time[data-iv-time]');
    for (var i = 0; i < nodes.length; i++) {
      var date = toDate(nodes[i].getAttribute('data-iv-time'));
      if (!date) continue;
      var preset = nodes[i].getAttribute('data-iv-time-format') || 'short';
      nodes[i].textContent = formatDate(date, PRESETS[preset] ? preset : 'short');
    }
  }

  function updateButtons() {
    var buttons = document.querySelectorAll('[data-time-mode-toggle]');
    for (var i = 0; i < buttons.length; i++) {
      var button = buttons[i];
      button.setAttribute('data-mode', mode);
      button.setAttribute('aria-pressed', mode === 'local' ? 'true' : 'false');
      button.setAttribute('aria-label', mode === 'utc'
        ? 'Time UTC. Switch all clock times to local time.'
        : 'Time Local. Switch all clock times to UTC.');
      button.setAttribute('title', mode === 'utc'
        ? 'Switch all clock times to local time'
        : 'Switch all clock times to UTC');
      var label = button.querySelector('[data-time-mode-label]');
      if (label) label.textContent = mode === 'utc' ? 'UTC' : 'Local';
    }
  }

  function applyMode() {
    document.documentElement.setAttribute('data-time-mode', mode);
    refreshTimes();
    updateButtons();
  }

  function setMode(next, persist) {
    var resolved = next === 'local' ? 'local' : 'utc';
    if (resolved === mode) return;
    mode = resolved;
    if (persist) storeMode(mode);
    applyMode();
  }

  function toggleMode() {
    setMode(mode === 'utc' ? 'local' : 'utc', true);
  }

  function createButton() {
    var nav = document.querySelector('.sitebar-nav');
    if (!nav || nav.querySelector('[data-time-mode-toggle]')) return;
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'time-mode-toggle';
    button.setAttribute('data-time-mode-toggle', '');
    button.innerHTML = '<span class="time-mode-toggle-kicker">Time</span> ' +
      '<span data-time-mode-label>UTC</span>';
    button.addEventListener('click', toggleMode);
    nav.appendChild(button);
  }

  window.IVTimeMode = {
    node: node,
    newDelhiNode: newDelhiNode,
    newDelhiParts: newDelhiParts,
    scheduleNode: scheduleNode
  };

  window.addEventListener('storage', function (event) {
    if (event.key !== STORAGE_KEY) return;
    var next = readMode();
    if (next === mode) return;
    mode = next;
    applyMode();
  });

  createButton();
  applyMode();
})();
