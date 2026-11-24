/* Browser-only bulk check for agents and advisers.
   The full fallback index is fetched only when the visitor presses Check. */
(function () {
  var INDEX_URL = '/data/search_fallback.json';
  var MAX = 100;
  var OFFICE_NAMES = {
    'new-delhi': 'New Delhi', beijing: 'Beijing', 'abu-dhabi': 'Abu Dhabi',
    abuja: 'Abuja', ankara: 'Ankara', dublin: 'Dublin'
  };
  var index = null;
  var indexPromise = null;
  var rows = [];

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }
  function digits(value) {
    return String(value == null ? '' : value).replace(/\D/g, '').replace(/^0+/, '');
  }
  function longDate(value) {
    var match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
    if (!match) return '';
    var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
      'August', 'September', 'October', 'November', 'December'];
    return Number(match[3]) + ' ' + months[Number(match[2]) - 1] + ' ' + match[1];
  }
  function loadIndex() {
    if (index) return Promise.resolve(index);
    if (indexPromise) return indexPromise;
    indexPromise = fetch(INDEX_URL, { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    }).then(function (payload) {
      if (!payload || !Array.isArray(payload.rows) || !payload.offices) throw new Error('Invalid index');
      index = payload;
      return payload;
    }).finally(function () { indexPromise = null; });
    return indexPromise;
  }
  function parseInput(text) {
    var seen = {};
    var list = [];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var parts = line.split(/[,\t;]+/).map(function (part) { return part.trim(); }).filter(Boolean);
      if (!parts.length) return;
      var number = digits(parts[0]);
      if (number.length < 6) return;
      var office = (parts[1] || '').toLowerCase();
      if (office && !OFFICE_NAMES[office]) office = '';
      var key = number + '|' + office;
      if (seen[key]) return;
      seen[key] = 1;
      list.push({ number: number, office: office });
    });
    return list.slice(0, MAX);
  }
  function rowFor(requested, match, payload) {
    var office = match ? match[0] : (requested.office || '');
    var meta = office ? (payload.offices[office] || {}) : {};
    return {
      number: requested.number,
      office: office,
      officeName: office ? (OFFICE_NAMES[office] || office) : 'All offices',
      decision: match ? match[3] : '',
      date: match ? match[2] : '',
      reportDate: meta.report_date || '',
      checked: meta.last_success_label || meta.last_success_at || '',
      source: office ? '/reports/' + encodeURIComponent(office) : '/reports'
    };
  }
  function findMatches(requested, payload) {
    var matches = [];
    (payload.rows || []).forEach(function (row) {
      if (!Array.isArray(row) || row.length < 4) return;
      if (row[1] !== requested.number) return;
      if (requested.office && row[0] !== requested.office) return;
      matches.push(row);
    });
    matches.sort(function (a, b) { return String(b[2]).localeCompare(String(a[2])); });
    if (!matches.length) return [rowFor(requested, null, payload)];
    return matches.map(function (match) { return rowFor(requested, match, payload); });
  }
  function filtered() {
    var office = document.getElementById('bulk-filter-office');
    var decision = document.getElementById('bulk-filter-decision');
    var from = document.getElementById('bulk-filter-from');
    var to = document.getElementById('bulk-filter-to');
    return rows.filter(function (row) {
      if (office && office.value !== 'all' && row.office !== office.value) return false;
      if (decision && decision.value !== 'all') {
        if (decision.value === 'missing' && row.decision) return false;
        if (decision.value !== 'missing' && row.decision !== decision.value) return false;
      }
      if (from && from.value && row.date && row.date < from.value) return false;
      if (to && to.value && row.date && row.date > to.value) return false;
      return true;
    });
  }
  function render() {
    var section = document.getElementById('bulk-results-section');
    var body = document.querySelector('#bulk-results-table tbody');
    var summary = document.getElementById('bulk-summary');
    if (!section || !body) return;
    var visible = filtered();
    section.hidden = false;
    body.innerHTML = visible.map(function (row) {
      var outcome = row.decision
        ? '<span class="pill ' + (row.decision === 'Approved' ? 'green' : 'red') + '">' + esc(row.decision) + '</span>'
        : '<span class="note2">Not found</span>';
      return '<tr data-office="' + esc(row.office) + '">' +
        '<td class="mono" data-label="Application">' + esc('IRL' + row.number) + '</td>' +
        '<td data-label="Office">' + esc(row.officeName) + '</td>' +
        '<td data-label="Outcome">' + outcome + '</td>' +
        '<td data-label="Decision date">' + (row.date ? '<time datetime="' + esc(row.date) + '">' + esc(longDate(row.date)) + '</time>' : '—') + '</td>' +
        '<td data-label="Report date">' + (row.reportDate ? '<time datetime="' + esc(row.reportDate) + '">' + esc(longDate(row.reportDate)) + '</time>' : '—') + '</td>' +
        '<td data-label="Source"><a href="' + esc(row.source) + '">Report</a></td>' +
        '<td data-label="Last checked">' + esc(row.checked || 'Not recorded') + '</td>' +
        '</tr>';
    }).join('');
    if (summary) {
      var missing = visible.filter(function (row) { return !row.decision; }).length;
      summary.textContent = visible.length + ' row' + (visible.length === 1 ? '' : 's') +
        ' shown · ' + missing + ' not found. “Not found” is not a refusal.';
    }
  }
  function csvCell(value) {
    var raw = String(value == null ? '' : value);
    return /[",\n]/.test(raw) ? '"' + raw.replace(/"/g, '""') + '"' : raw;
  }
  function exportCsv() {
    var visible = filtered();
    var header = ['application_number', 'office', 'outcome', 'decision_date', 'report_date', 'source', 'last_checked'];
    var lines = [header.join(',')].concat(visible.map(function (row) {
      return [row.number, row.office, row.decision, row.date, row.reportDate, row.source, row.checked]
        .map(csvCell).join(',');
    }));
    var blob = new Blob(['\uFEFF' + lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'irish-visa-bulk-check-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }
  function trackBulkCheck() {
    try {
      fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'bulk_check', source: 'bulk_tools' }),
        keepalive: true
      }).catch(function () {});
    } catch { /* analytics must never block the tool */ }
  }
  function init() {
    var form = document.getElementById('bulk-form');
    if (!form) return;
    var status = document.getElementById('bulk-status');
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var requested = parseInput(form.elements.numbers.value);
      if (!requested.length) {
        status.textContent = 'Paste at least one application number with 6 or more digits.';
        return;
      }
      status.textContent = 'Loading the local fallback index (about 3.2 MB)…';
      loadIndex().then(function (payload) {
        rows = [];
        requested.forEach(function (item) {
          rows = rows.concat(findMatches(item, payload));
        });
        render();
        trackBulkCheck();
        status.textContent = 'Checked ' + requested.length + ' number' + (requested.length === 1 ? '' : 's') + ' against the published index.';
      }).catch(function () {
        status.textContent = 'The local index could not be loaded. Try the main tracker or the report archive.';
      });
    });
    var clear = document.getElementById('bulk-clear');
    if (clear) clear.addEventListener('click', function () {
      form.reset();
      rows = [];
      document.getElementById('bulk-results-section').hidden = true;
      status.textContent = 'Nothing checked yet.';
    });
    ['bulk-filter-office', 'bulk-filter-decision', 'bulk-filter-from', 'bulk-filter-to'].forEach(function (id) {
      var element = document.getElementById(id);
      if (element) element.addEventListener('change', render);
    });
    var exportButton = document.getElementById('bulk-export');
    if (exportButton) exportButton.addEventListener('click', exportCsv);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
