(function() {
  var summary = document.getElementById('correction-summary');
  var list = document.getElementById('correction-list');
  if (!summary || !list) return;

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function number(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString('en-IE') : '0';
  }

  function safeUrl(value) {
    try {
      var url = new URL(String(value || ''));
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
    } catch (error) {
      return '';
    }
  }

  function dateLabel(value) {
    if (!value) return 'date not recorded';
    var date = new Date(String(value) + 'T00:00:00Z');
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleDateString('en-IE', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC'
    });
  }

  function fetchedLabel(value) {
    if (!value) return '';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('en-IE', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC'
    }) + ' UTC';
  }

  function sourceLink(entry) {
    var source = safeUrl(entry.source_url);
    if (!source) return '<span class="correction-no-source">Source link not recorded</span>';
    var label = entry.source_file ? 'Open official file' : 'Open office page';
    return '<a href="' + escapeHtml(source) + '" target="_blank" rel="noopener noreferrer">' +
      escapeHtml(label) + '</a>';
  }

  function changedTable(changes) {
    if (!changes || !changes.length) return '';
    return '<table class="correction-table">' +
      '<caption>Changed rows</caption>' +
      '<thead><tr><th scope="col">Application</th><th scope="col">Previous</th><th scope="col">Published</th></tr></thead>' +
      '<tbody>' + changes.map(function(change) {
        return '<tr><td class="mono">' + escapeHtml(change.number || '—') + '</td>' +
          '<td>' + escapeHtml(change.from || '—') + '</td>' +
          '<td>' + escapeHtml(change.to || '—') + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function renderEntry(entry) {
    var counts = [];
    if (Number(entry.added) > 0) counts.push('<li><strong>' + number(entry.added) + '</strong> added</li>');
    if (Number(entry.removed) > 0) counts.push('<li><strong>' + number(entry.removed) + '</strong> removed</li>');
    if (entry.changed && entry.changed.length) {
      counts.push('<li><strong>' + number(entry.changed.length) + '</strong> changed</li>');
    }
    var fetched = fetchedLabel(entry.fetched_at);
    return '<article class="correction-entry">' +
      '<div class="correction-head"><h3>' + escapeHtml(entry.office_name || entry.office) + '</h3>' +
      '<span class="correction-date">Report ' + escapeHtml(dateLabel(entry.report_date)) + '</span></div>' +
      '<p class="correction-meta">' +
        (fetched ? 'Fetched ' + escapeHtml(fetched) + ' · ' : '') +
        'Source: ' + sourceLink(entry) +
      '</p>' +
      (counts.length ? '<ul class="correction-counts">' + counts.join('') + '</ul>' : '') +
      changedTable(entry.changed) +
    '</article>';
  }

  function render(ledger) {
    var entries = ledger && Array.isArray(ledger.entries) ? ledger.entries : [];
    if (!entries.length) {
      summary.textContent = 'No differences have been recorded yet.';
      list.innerHTML = '<p class="callout">The official files currently match the previous reports. New differences appear after the next scrape.</p>';
      return;
    }

    var totals = ledger.totals || {};
    summary.innerHTML = '<strong>' + number(entries.length) + '</strong> report' +
      (entries.length === 1 ? '' : 's') + ' with recorded changes' +
      ' &middot; <strong>' + number(totals.changed) + '</strong> changed row' +
      (Number(totals.changed) === 1 ? '' : 's');
    list.innerHTML = entries.map(renderEntry).join('');
  }

  fetch('/api/reports/corrections', {
    headers: { 'Accept': 'application/json' }
  }).then(function(response) {
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  }).then(function(data) {
    render(data.ledger);
  }).catch(function() {
    summary.textContent = 'Could not load the correction ledger.';
    list.innerHTML = '<p class="callout">The data endpoint is temporarily unavailable. Try again later, or <a href="/contact#report-error">report an error</a>.</p>';
  });
})();
