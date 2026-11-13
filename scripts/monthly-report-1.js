(function () {
  var monthInput = document.getElementById('report-month');
  var statusEl = document.getElementById('report-status');
  var cardsEl = document.getElementById('summary-cards');
  var officeRows = document.getElementById('office-rows');
  var officeNote = document.getElementById('office-note');
  var dailyRows = document.getElementById('daily-rows');
  var barsEl = document.getElementById('bars');
  var changesBody = document.getElementById('changes-body');
  var downloadJson = document.getElementById('download-json');
  var currentMonth = '';

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }
  function num(value) { return Number(value || 0).toLocaleString('en-IE'); }
  function pct(value) { return Number(value || 0).toFixed(1) + '%'; }
  function statusClass(key) { return ['expired', 'critical', 'warning', 'notice', 'ok', 'missing'].indexOf(key) >= 0 ? key : 'missing'; }

  function showStatus(message, error) {
    statusEl.textContent = message || '';
    statusEl.style.color = error ? 'var(--red)' : 'var(--muted)';
  }

  function renderSummary(report) {
    var c = report.change;
    var sign = c.total > 0 ? '+' : '';
    cardsEl.innerHTML =
      '<div class="card"><div class="label">Dated decisions</div><div class="value">' + num(report.totals.total) + '</div><div class="hint">' + sign + num(c.total) + ' vs ' + esc(report.previous_month) + '</div></div>' +
      '<div class="card"><div class="label">Approved</div><div class="value">' + num(report.totals.approved) + '</div><div class="hint">' + pct(report.totals.approval_rate) + ' approval rate</div></div>' +
      '<div class="card"><div class="label">Refused</div><div class="value">' + num(report.totals.refused) + '</div><div class="hint">' + sign + num(c.refused) + ' vs previous month</div></div>' +
      '<div class="card"><div class="label">Busiest day</div><div class="value" style="font-size:19px">' + (report.busiest_day ? esc(report.busiest_day.date) : 'No data') + '</div><div class="hint">' + (report.busiest_day ? num(report.busiest_day.total) + ' decisions' : '') + '</div></div>';
  }

  function renderOffices(report) {
    if (!report.offices.length) {
      officeRows.innerHTML = '<tr><td colspan="5" class="empty">No office data for this month.</td></tr>';
      return;
    }
    officeRows.innerHTML = report.offices.map(function (office) {
      var status = office.status === 'ocr_required' ? ' <span class="pill missing">OCR required</span>' : '';
      return '<tr><td><strong>' + esc(office.name) + '</strong>' + status + '</td>' +
        '<td class="num">' + num(office.total) + '</td><td class="num">' + pct(office.approval_rate) + '</td>' +
        '<td class="num">' + num(office.reported_total) + '</td><td class="num">' + esc(office.report_date || '—') + '</td></tr>';
    }).join('');
    var asOf = report.offices.filter(function (o) { return o.report_date; }).map(function (o) { return o.name + ' ' + o.report_date; }).join('; ');
    officeNote.textContent = 'Dated counts use official report-period dates for Abu Dhabi, Abuja and Ankara. New Delhi tracker additions are observation-dated and excluded from dated monthly totals. New Delhi, Beijing and Dublin are shown under "Latest report" only; that column is the size of each file, not a month count.' + (asOf ? ' Latest reports: ' + asOf + '.' : '');
  }

  function renderDaily(report) {
    var daily = report.daily || [];
    dailyRows.innerHTML = daily.length ? daily.slice().reverse().map(function (day) {
      return '<tr><td>' + esc(day.date) + '</td><td class="num">' + num(day.total) + '</td><td class="num">' + num(day.approved) + '</td><td class="num">' + num(day.refused) + '</td></tr>';
    }).join('') : '<tr><td colspan="4" class="empty">No decisions in this month.</td></tr>';
    var max = daily.reduce(function (m, day) { return Math.max(m, day.total); }, 0) || 1;
    barsEl.innerHTML = daily.slice(-31).map(function (day) {
      var height = Math.max(4, Math.round((day.total / max) * 92));
      return '<div class="bar" style="height:' + height + 'px" title="' + esc(day.date) + ': ' + day.total + '"><span>' + esc(day.date.slice(8)) + '</span></div>';
    }).join('');
  }

  function renderReport(report) {
    currentMonth = report.month;
    monthInput.value = report.month;
    document.getElementById('download-json').href = '/api/reports/monthly?month=' + encodeURIComponent(report.month);
    renderSummary(report);
    renderOffices(report);
    renderDaily(report);
    showStatus('Showing ' + report.label + '.');
  }

  async function loadReport(month) {
    showStatus('Loading the official files…');
    try {
      var url = '/api/reports/monthly' + (month ? '?month=' + encodeURIComponent(month) : '');
      var response = await fetch(url);
      var data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load the report');
      renderReport(data.report);
    } catch (error) {
      showStatus(error.message, true);
    }
  }

  function renderChanges(changes) {
    var updates = (changes.office_updates || []).filter(function (o) { return o.report_date; });
    var recent = (changes.recent || []).slice(0, 8);
    changesBody.innerHTML =
      '<p><strong>' + esc(changes.headline) + '</strong></p>' +
      '<p class="note">Window: ' + esc(changes.window.start) + ' to ' + esc(changes.window.end) + '. Previous: ' + esc(changes.previous_window.start) + ' to ' + esc(changes.previous_window.end) + '.</p>' +
      '<p class="note">Headline counts cover dated decisions; office totals are cumulative.</p>' +
      (updates.length ? '<h3>Office reports</h3><ul class="feed">' + updates.map(function (o) {
        return '<li><strong>' + esc(o.name) + '</strong> ' + (o.is_this_week ? '<span class="pill ok">updated this week</span>' : '<span class="pill notice">latest</span>') +
          '<div class="meta">Report date ' + esc(o.report_date) + (o.added != null ? ' · ' + num(o.added) + ' rows added' : '') + (o.corrections ? ' · ' + num(o.corrections) + ' corrections' : '') + '</div></li>';
      }).join('') + '</ul>' : '') +
      (recent.length ? '<h3>Latest decisions</h3><ul class="feed">' + recent.map(function (d) {
        return '<li><strong>' + esc(d.number) + '</strong> <span class="pill ' + (d.decision === 'Approved' ? 'ok' : 'critical') + '">' + esc(d.decision) + '</span><div class="meta">' + esc(d.office) + ' · ' + esc(d.date) + '</div></li>';
      }).join('') + '</ul>' : '<p class="empty">No decisions were recorded in this window.</p>') +
      (changes.corrections && changes.corrections.length ? '<h3>Corrections</h3><ul class="feed">' + changes.corrections.map(function (c) {
        return '<li>' + esc(c.application_number || c.number || 'Corrected row') + '<div class="meta">' + esc(c.office) + ' · report ' + esc(c.report_date) + '</div></li>';
      }).join('') + '</ul>' : '');
  }

  async function loadChanges() {
    try {
      var response = await fetch('/api/reports/changes?days=7');
      var data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load changes');
      renderChanges(data.changes);
    } catch (error) {
      changesBody.innerHTML = '<p class="status" style="color:var(--red)">' + esc(error.message) + '</p>';
    }
  }

  document.getElementById('load-month').addEventListener('click', function () {
    if (monthInput.value) loadReport(monthInput.value);
  });
  monthInput.addEventListener('change', function () {
    if (monthInput.value) loadReport(monthInput.value);
  });
  document.getElementById('digest-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    var button = document.getElementById('digest-button');
    var status = document.getElementById('digest-status');
    var email = document.getElementById('digest-email').value.trim();
    if (!email) return;
    button.disabled = true;
    status.textContent = 'Requesting confirmation…';
    status.style.color = 'var(--muted)';
    try {
      var response = await fetch('/api/digest/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email })
      });
      var data = await response.json().catch(function () { return {}; });
      if (response.ok) {
        status.textContent = data.message || 'Check your inbox to confirm the subscription.';
        status.style.color = 'var(--green)';
        document.getElementById('digest-email').value = '';
      } else {
        status.textContent = data.error || 'Could not subscribe.';
        status.style.color = 'var(--red)';
      }
    } catch (error) {
      status.textContent = 'Could not subscribe.';
      status.style.color = 'var(--red)';
    } finally { button.disabled = false; }
  });

  var params = new URLSearchParams(location.search);
  var requested = params.get('month') || '';
  loadReport(requested);
  loadChanges();
})();
