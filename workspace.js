(function () {
  'use strict';

  var OFFICES = [
    ['all', 'All offices'],
    ['new-delhi', 'New Delhi'],
    ['beijing', 'Beijing'],
    ['dublin', 'Dublin'],
    ['abu-dhabi', 'Abu Dhabi'],
    ['abuja', 'Abuja'],
    ['ankara', 'Ankara']
  ];
  var VIEW_TITLES = {
    overview: 'Overview',
    profile: 'Profile',
    notifications: 'Notifications',
    analytics: 'Analytics depth',
    exports: 'Exports',
    assistant: 'Application assistant',
    community: 'Community',
    organization: 'Organization'
  };
  var state = {
    view: 'overview',
    overview: null,
    analytics: null,
    analyticsFilter: { office: 'all', from: '', to: '', date: '' },
    community: null,
    communityFilter: { kind: '', office: '' },
    communityPost: null,
    referral: null,
    schedules: null,
    tokens: null,
    orgDetail: null,
    tokenResult: null,
    fees: null,
    scan: null,
    ref: ''
  };

  function el(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }
  function count(value) { return Number(value || 0).toLocaleString(); }
  function money(value) {
    return '€' + Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function date(value) { return String(value || '').slice(0, 10); }
  function safeColor(value) {
    return /^#[0-9a-f]{3,8}$/i.test(String(value || '')) ? String(value) : '#047857';
  }
  function pill(text, kind) { return '<span class="workspace-pill ' + (kind || '') + '">' + esc(text) + '</span>'; }
  function empty(text) { return '<p class="workspace-empty">' + esc(text) + '</p>'; }
  function options(list, selected) {
    return list.map(function (item) {
      var value = Array.isArray(item) ? item[0] : item;
      var label = Array.isArray(item) ? item[1] : item;
      return '<option value="' + esc(value) + '"' + (String(value) === String(selected) ? ' selected' : '') + '>' + esc(label) + '</option>';
    }).join('');
  }

  async function api(path, options) {
    var opts = Object.assign({ credentials: 'include', headers: {} }, options || {});
    if (opts.body && !(opts.body instanceof FormData) && typeof opts.body !== 'string') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    var response = await fetch(path, opts);
    var data = null;
    try { data = await response.json(); } catch (error) { data = null; }
    if (!response.ok) {
      var failure = new Error(data && data.error ? data.error : 'Request failed (' + response.status + ')');
      failure.status = response.status;
      failure.data = data;
      throw failure;
    }
    return data || {};
  }

  function flash(message, kind) {
    var status = el('workspace-status');
    if (!status) return;
    status.hidden = !message;
    status.textContent = message || '';
    status.className = 'workspace-status' + (kind ? ' ' + kind : '');
  }
  function formStatus(form, message, kind) {
    if (!form) return;
    var status = form.querySelector('[data-form-status]');
    if (!status) return;
    status.textContent = message || '';
    status.className = 'form-status' + (kind ? ' ' + kind : '');
  }
  function readForm(form) {
    var output = {};
    Array.prototype.forEach.call(form.elements, function (field) {
      if (!field.name) return;
      if (field.type === 'checkbox') output[field.name] = field.checked;
      else if (field.type === 'radio') { if (field.checked) output[field.name] = field.value; }
      else if (field.type === 'file') output[field.name] = field.files && field.files[0] ? field.files[0] : null;
      else output[field.name] = field.value;
    });
    return output;
  }
  function markBusy(button, busy) {
    if (!button) return;
    button.disabled = Boolean(busy);
    if (busy) {
      button.dataset.originalText = button.textContent;
      button.textContent = 'Working…';
    } else if (button.dataset.originalText) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
    }
  }

  function showAuth(message) {
    el('workspace-loading').hidden = true;
    el('workspace-app').hidden = true;
    el('workspace-auth').hidden = false;
    if (message) el('auth-signin-status').textContent = message;
    var first = document.querySelector('#workspace-auth input');
    if (first) first.focus();
  }
  function showApp() {
    el('workspace-loading').hidden = true;
    el('workspace-auth').hidden = true;
    el('workspace-app').hidden = false;
  }
  function setAuthTab(tab) {
    var signin = tab !== 'register';
    el('auth-tab-signin').setAttribute('aria-selected', String(signin));
    el('auth-tab-register').setAttribute('aria-selected', String(!signin));
    el('auth-signin').hidden = !signin;
    el('auth-register').hidden = signin;
    var form = signin ? el('auth-signin') : el('auth-register');
    var first = form.querySelector('input');
    if (first) first.focus();
  }
  function renderPerson() {
    var data = state.overview;
    if (!data || !data.user) return;
    el('workspace-user-name').textContent = data.user.name || 'Applicant';
    el('workspace-user-email').textContent = data.user.email || '';
    var badge = el('workspace-org-badge');
    badge.hidden = !data.org;
    badge.textContent = data.org ? data.org.brand_name || data.org.name : '';
    applyBrand(data.org);
  }
  function applyBrand(org) {
    var color = safeColor(org && org.brand_color);
    document.documentElement.style.setProperty('--workspace-brand', color);
    document.documentElement.style.setProperty('--workspace-brand-soft', '#dcfce7');
  }

  function renderOverview() {
    var data = state.overview;
    var user = data.user || {};
    var capabilities = data.capabilities || {};
    var notifications = data.notifications || [];
    var values = [
      ['Watchlist', data.watchlists ? data.watchlists.length : 0],
      ['Unread alerts', data.unread_notifications || 0],
      ['Private exports', (data.jobs || []).length]
    ];
    return '<div class="workspace-heading"><h2>Welcome back, ' + esc((user.name || 'Applicant').split(/\s+/)[0]) + '</h2><p>Your private workspace for applications, alerts and research.</p></div>' +
      '<div class="workspace-stat-grid">' + values.map(function (item) {
        return '<div class="workspace-stat"><span>' + esc(item[0]) + '</span><strong>' + count(item[1]) + '</strong></div>';
      }).join('') + '</div>' +
      '<section class="workspace-card"><h3>Account</h3>' +
        '<div class="workspace-row"><div><strong>' + esc(user.email || '') + '</strong><p class="workspace-muted">Account email</p></div></div>' +
        '<div class="workspace-actions" style="margin-top:10px;"><button class="btn" type="button" data-action="go" data-view="profile">Edit profile</button><a class="btn" href="/">Open tracker</a></div>' +
      '</section>' +
      '<section class="workspace-card"><h3>Alerts and delivery</h3><div class="workspace-inline">' +
        [['Email', capabilities.email], ['Push', capabilities.push]].map(function (item) {
          return pill(item[0] + ': ' + (item[1] ? 'ready' : 'not configured'), item[1] ? 'ok' : 'off');
        }).join('') +
      '</div><p class="workspace-muted" style="margin-top:10px;">Email and push are configured by the deployment. Enable them per watched application.</p>' +
      '<button class="btn" type="button" data-action="go" data-view="notifications">Manage notifications</button></section>' +
      '<section class="workspace-card"><h3>Recent notifications</h3>' +
        (notifications.length ? '<ul class="workspace-list">' + notifications.map(function (item) {
          return '<li><div class="workspace-row"><div><strong>' + esc(item.title) + '</strong><p class="workspace-muted">' + esc(item.body) + '</p></div><span class="workspace-meta">' + esc(date(item.created_at)) + '</span></div></li>';
        }).join('') + '</ul>' : empty('No notifications yet. Add a watchlist on the tracker to start receiving decision alerts.')) +
      '</section>' +
      '<section class="workspace-card"><h3>Your watchlist</h3>' +
        ((data.watchlists || []).length ? '<ul class="workspace-list">' + data.watchlists.map(function (row) {
          return '<li><div class="workspace-row"><div><strong>' + esc(row.nickname || row.application_number) + '</strong><p class="workspace-muted">' + esc(row.application_number) + ' · ' + esc(row.embassy_slug) + '</p></div><span class="workspace-meta">' + esc(date(row.created_at)) + '</span></div></li>';
        }).join('') + '</ul>' : empty('No watchlist entries. Add one from the public tracker.')) +
      '</section>' +
      (data.org ? '<section class="workspace-card"><h3>' + esc(data.org.brand_name || data.org.name) + '</h3><p class="workspace-muted">Organization workspace · ' + esc(data.org.plan || 'team') + '</p><button class="btn" type="button" data-action="go" data-view="organization">Open organization</button></section>' : '');
  }

  function renderProfile() {
    var user = (state.overview && state.overview.user) || {};
    var prefs = user.preferences || {};
    var notify = prefs.notifications || {};
    return '<div class="workspace-heading"><h2>Profile and preferences</h2><p>Control your display name, locale, digest and the channels the tracker may use.</p></div>' +
      '<section class="workspace-card"><form class="workspace-form" data-action="save-profile">' +
        '<div class="workspace-form-grid"><label>Name<input name="name" maxlength="120" value="' + esc(user.name || '') + '"></label>' +
        '<label>Email<input value="' + esc(user.email || '') + '" disabled></label>' +
        '<label>Theme<select name="theme">' + options([['light', 'Light'], ['dark', 'Dark'], ['system', 'System']], prefs.theme) + '</select></label>' +
        '<label>Language<select name="language">' + options([['en', 'English'], ['fr', 'Français'], ['es', 'Español'], ['hi', 'हिन्दी']], prefs.language || 'en') + '</select></label>' +
        '<label>Timezone<input name="timezone" maxlength="80" placeholder="Europe/Dublin" value="' + esc(prefs.timezone || 'UTC') + '"></label></div>' +
        '<fieldset style="border:0;padding:0;margin:0"><legend class="workspace-field">Message preferences</legend>' +
          '<label class="workspace-check"><input type="checkbox" name="notify_email"' + (notify.email ? ' checked' : '') + '> Email decisions and digest</label>' +
          '<label class="workspace-check"><input type="checkbox" name="notify_push"' + (notify.push ? ' checked' : '') + '> Browser push decisions</label>' +
          '<label class="workspace-check"><input type="checkbox" name="notify_digest"' + (notify.digest ? ' checked' : '') + '> Include a periodic digest when available</label>' +
        '</fieldset>' +
        '<div class="workspace-actions"><button class="btn primary" type="submit">Save profile</button></div>' +
        '<p class="form-status" data-form-status aria-live="polite"></p></form></section>' +
      '<section class="workspace-card"><h3>Account security</h3><p class="workspace-muted">Sessions expire after 30 days. Password changes require your current password.</p><div class="workspace-actions"><button class="btn secondary" type="button" id="profile-signout">Sign out</button></div></section>';
  }

  function renderNotifications() {
    var data = state.overview || {};
    var capabilities = data.capabilities || {};
    return '<div class="workspace-heading"><h2>Notifications</h2><p>Email and browser push are optional and can be switched per watched application.</p></div>' +
      '<section class="workspace-card"><h3>Delivery availability</h3><div class="workspace-inline">' +
        [['Email', capabilities.email], ['Push', capabilities.push]].map(function (item) {
          return pill(item[0] + ': ' + (item[1] ? 'ready' : 'not configured'), item[1] ? 'ok' : 'off');
        }).join('') + '</div>' +
      '</section>' +
      '<section class="workspace-card"><h3>Notification preferences</h3><p class="workspace-muted">Edit email, push and digest preferences in your profile.</p><button class="btn" type="button" data-action="go" data-view="profile">Edit preferences</button></section>';
  }

  function renderAnalytics() {
    var data = state.analytics;
    var filter = state.analyticsFilter;
    var filterForm = '<form class="workspace-form" data-action="analytics-filter"><div class="workspace-form-grid">' +
      '<label>Office<select name="office">' + options(OFFICES, filter.office) + '</select></label>' +
      '<label>From<input type="date" name="from" value="' + esc(filter.from) + '"></label>' +
      '<label>To<input type="date" name="to" value="' + esc(filter.to) + '"></label>' +
      '<label>Drill-down date<input type="date" name="date" value="' + esc(filter.date) + '"></label></div>' +
      '<button class="btn primary" type="submit">Apply filters</button></form>';
    if (!data) {
      return '<div class="workspace-heading"><h2>Analytics depth</h2><p>Forecasts, anomalies, heatmaps, cohorts and a dated drill-down over published decisions.</p></div><section class="workspace-card">' + filterForm + '</section>' + empty('Loading analytics…');
    }
    var summary = data.summary || {};
    var forecast = data.forecast || {};
    var anomalies = data.anomalies || [];
    var heatmap = data.heatmap || { offices: [], weekdays: [], max: 0 };
    var cohorts = data.cohorts || [];
    var drilldown = data.drilldown || [];
    var points = forecast.points || [];
    return '<div class="workspace-heading"><h2>Analytics depth</h2><p>Filtered to ' + esc(data.filters && data.filters.office || 'all offices') + ' · ' + count(summary.total) + ' published decisions.</p></div>' +
      '<section class="workspace-card">' + filterForm + '</section>' +
      '<div class="workspace-stat-grid"><div class="workspace-stat"><span>Decisions</span><strong>' + count(summary.total) + '</strong></div><div class="workspace-stat"><span>Approved</span><strong>' + count(summary.approved) + '</strong></div><div class="workspace-stat"><span>Refused</span><strong>' + count(summary.refused) + '</strong></div><div class="workspace-stat"><span>Approval rate</span><strong>' + Number(summary.approval_rate || 0) + '%</strong></div></div>' +
      '<section class="workspace-card"><h3>Next 14 days — projection</h3><div class="workspace-notice warn">Projection only. This is a statistical estimate from published daily counts, not an official processing promise. ' + esc(forecast.method || '') + '</div>' +
        (forecast.available === false ? empty(forecast.method || 'Not enough dated history for a forecast.') : '<div class="workspace-table-wrap"><table class="workspace-table"><thead><tr><th>Date</th><th>Projected</th><th>Lower</th><th>Upper</th></tr></thead><tbody>' + points.map(function (point) {
          return '<tr><td>' + esc(point.date) + '</td><td>' + count(point.total) + '</td><td>' + count(point.lower) + '</td><td>' + count(point.upper) + '</td></tr>';
        }).join('') + '</tbody></table></div>') + '</section>' +
      '<section class="workspace-card"><h3>Anomalies</h3>' + (anomalies.length ? '<div class="workspace-table-wrap"><table class="workspace-table"><thead><tr><th>Date</th><th>Direction</th><th>Total</th><th>Expected</th><th>Z-score</th><th>Severity</th></tr></thead><tbody>' + anomalies.map(function (row) {
        return '<tr><td>' + esc(row.date) + '</td><td>' + esc(row.direction) + '</td><td>' + count(row.total) + '</td><td>' + count(row.expected) + '</td><td>' + esc(row.z_score) + '</td><td>' + esc(row.severity) + '</td></tr>';
      }).join('') + '</tbody></table></div>' : empty('No decision-count anomalies crossed the two-standard-deviation threshold.')) + '</section>' +
      '<section class="workspace-card"><h3>Weekday heatmap</h3>' + (heatmap.offices.length ? '<div class="workspace-table-wrap"><table class="workspace-heat"><thead><tr><th>Office</th>' + heatmap.weekdays.map(function (day) { return '<th>' + esc(day.slice(0, 3)) + '</th>'; }).join('') + '</tr></thead><tbody>' + heatmap.offices.map(function (row) {
        return '<tr><th>' + esc(row.office) + '</th>' + row.cells.map(function (cell) {
          var tint = row.total ? Math.round((cell.total / Math.max(1, row.total)) * 40) / 100 : 0;
          return '<td style="background:rgba(4,120,87,' + tint + ')" title="' + esc(cell.total + ' decisions, ' + cell.approval_rate + '% approved') + '">' + count(cell.total) + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table></div>' : empty('No dated rows available for a heatmap.')) + '</section>' +
      '<section class="workspace-card"><h3>Cohorts by decision month</h3>' + (cohorts.length ? '<div class="workspace-table-wrap"><table class="workspace-table"><thead><tr><th>Month</th><th>Decisions</th><th>Approved</th><th>Refused</th><th>Approval rate</th></tr></thead><tbody>' + cohorts.map(function (row) {
        return '<tr><td>' + esc(row.cohort) + '</td><td>' + count(row.total) + '</td><td>' + count(row.approved) + '</td><td>' + count(row.refused) + '</td><td>' + esc(row.approval_rate) + '%</td></tr>';
      }).join('') + '</tbody></table></div>' : empty('No cohort rows available.')) + '</section>' +
      '<section class="workspace-card"><h3>Drill-down</h3>' + (drilldown.length ? '<div class="workspace-table-wrap"><table class="workspace-table"><thead><tr><th>Date</th><th>Application</th><th>Decision</th><th>Office</th><th>Source</th></tr></thead><tbody>' + drilldown.slice(0, 120).map(function (row) {
        return '<tr><td>' + esc(row.date) + '</td><td>' + esc(row.number) + '</td><td>' + esc(row.decision) + '</td><td>' + esc(row.office) + '</td><td>' + esc(row.source || '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' : empty('No rows match the selected date.')) + '</section>';
  }

  function renderExports() {
    var data = state.overview || {};
    var schedules = state.schedules || [];
    var tokens = state.tokens || [];
    var jobs = data.jobs || [];
    var tokenResult = state.tokenResult;
    return '<div class="workspace-heading"><h2>Private exports</h2><p>Download a filtered CSV or JSON, schedule a recurring export, or create a private link. There is no public developer API.</p></div>' +
      '<section class="workspace-card"><h3>Download now</h3><form class="workspace-form" data-action="download-export"><div class="workspace-form-grid">' +
        '<label>Format<select name="format">' + options([['csv', 'CSV'], ['json', 'JSON']], 'csv') + '</select></label>' +
        '<label>Office<select name="office">' + options(OFFICES, 'all') + '</select></label>' +
        '<label>From<input type="date" name="from"></label><label>To<input type="date" name="to"></label></div>' +
        '<button class="btn primary" type="submit">Download export</button></form></section>' +
      '<section class="workspace-card"><h3>Scheduled exports</h3><form class="workspace-form" data-action="add-schedule"><div class="workspace-form-grid">' +
        '<label>Format<select name="format">' + options([['csv', 'CSV'], ['json', 'JSON']], 'csv') + '</select></label>' +
        '<label>Frequency<select name="frequency">' + options([['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly']], 'weekly') + '</select></label>' +
        '<label>Office<select name="office">' + options(OFFICES, 'all') + '</select></label></div>' +
        '<button class="btn" type="submit">Create schedule</button><p class="form-status" data-form-status aria-live="polite"></p></form>' +
        (schedules.length ? '<ul class="workspace-list" style="margin-top:12px;">' + schedules.map(function (row) {
          return '<li><div class="workspace-row"><div><strong>' + esc(String(row.format || 'csv').toUpperCase()) + ' · ' + esc(row.frequency) + '</strong><p class="workspace-muted">Next run ' + esc(date(row.next_run_at)) + '</p></div><button class="btn secondary workspace-danger" type="button" data-action="delete-schedule" data-id="' + esc(row.id) + '">Delete</button></div></li>';
        }).join('') + '</ul>' : '<p class="workspace-muted" style="margin-top:12px;">No scheduled exports.</p>') + '</section>' +
      '<section class="workspace-card"><h3>Private export tokens</h3><p class="workspace-muted">A token can only download your own filtered export. It is not a general-purpose API key. It is shown once.</p>' +
        (tokenResult ? '<div class="workspace-notice"><strong>Copy this token now:</strong><code class="workspace-code">' + esc(tokenResult) + '</code><div class="workspace-actions" style="margin-top:8px;"><button class="btn" type="button" data-action="copy-token">Copy token</button></div></div>' : '') +
        '<form class="workspace-form" data-action="create-token"><div class="workspace-form-grid"><label>Token name<input name="name" maxlength="80" placeholder="Accountant export" required></label><label>Expires in days<input name="expires_days" type="number" min="1" max="3650" value="365"></label></div><button class="btn" type="submit">Create private token</button><p class="form-status" data-form-status aria-live="polite"></p></form>' +
        (tokens.length ? '<ul class="workspace-list">' + tokens.map(function (row) {
          return '<li><div class="workspace-row"><div><strong>' + esc(row.name) + '</strong><p class="workspace-muted">Created ' + esc(date(row.created_at)) + ' · expires ' + esc(date(row.expires_at)) + '</p></div><button class="btn secondary workspace-danger" type="button" data-action="revoke-token" data-id="' + esc(row.id) + '">Revoke</button></div></li>';
        }).join('') + '</ul>' : '<p class="workspace-muted">No private export tokens.</p>') + '</section>' +
      '<section class="workspace-card"><h3>Recent export jobs</h3>' + (jobs.length ? '<div class="workspace-table-wrap"><table class="workspace-table"><thead><tr><th>Created</th><th>Format</th><th>Status</th><th>Rows</th></tr></thead><tbody>' + jobs.map(function (row) {
        return '<tr><td>' + esc(date(row.created_at)) + '</td><td>' + esc(row.format) + '</td><td>' + esc(row.status) + '</td><td>' + count(row.row_count) + '</td></tr>';
      }).join('') + '</tbody></table></div>' : empty('No scheduled export jobs have run yet.')) + '</section>';
  }

  function renderAssistant() {
    var fees = state.fees;
    var scan = state.scan;
    return '<div class="workspace-heading"><h2>Application assistant</h2><p>Estimate fees, extract fields from a decision or application document, and jump to the tracker tools.</p></div>' +
      '<section class="workspace-card"><h3>Indicative fee estimate</h3><form class="workspace-form" data-action="fees"><div class="workspace-form-grid">' +
        '<label>Office<select name="office">' + options(OFFICES.slice(1), 'new-delhi') + '</select></label>' +
        '<label>Entry type<select name="entry_type">' + options([['single', 'Single entry'], ['multi', 'Multiple entry'], ['transit', 'Transit']], 'single') + '</select></label>' +
        '<label>Applicants<input type="number" name="entries" min="1" max="20" value="1"></label></div>' +
        '<div class="workspace-inline"><label class="workspace-check"><input type="checkbox" name="vfs" checked> Include VFS service fee</label><label class="workspace-check"><input type="checkbox" name="postal"> Include return courier</label></div>' +
        '<button class="btn primary" type="submit">Calculate estimate</button></form>' +
        (fees ? '<div class="workspace-table-wrap" style="margin-top:14px;"><table class="workspace-table"><tbody>' + fees.line_items.map(function (item) { return '<tr><td>' + esc(item.label) + '</td><td>' + money(item.amount) + '</td></tr>'; }).join('') + '<tr><th>Total (EUR)</th><th>' + money(fees.total) + '</th></tr></tbody></table></div><p class="workspace-muted">' + esc(fees.disclaimer) + '</p>' : '') + '</section>' +
      '<section class="workspace-card"><h3>Read a document</h3><p class="workspace-muted">Paste text or upload a .txt/.csv file, then extract the application fields.</p><form class="workspace-form" data-action="scan">' +
        '<label>Document text<textarea name="text" rows="6" placeholder="Paste the decision email or application page here…"></textarea></label>' +
        '<label>Or upload a file<input type="file" name="file" accept=".txt,.csv"></label>' +
        '<button class="btn primary" type="submit">Extract fields</button><p class="form-status" data-form-status aria-live="polite"></p></form>' +
        (scan ? '<div class="workspace-notice">Confidence ' + esc(scan.confidence) + '% · ' + count(scan.text_length) + ' characters read</div><div class="workspace-table-wrap"><table class="workspace-table"><tbody>' + Object.keys(scan.fields || {}).map(function (key) { return '<tr><th>' + esc(key.replace(/_/g, ' ')) + '</th><td>' + (scan.fields[key] ? esc(scan.fields[key]) : '<span class="workspace-muted">not found</span>') + '</td></tr>'; }).join('') + '</tbody></table></div>' + (scan.warnings && scan.warnings.length ? '<div class="workspace-notice warn">' + scan.warnings.map(esc).join('<br>') + '</div>' : '') : '') + '</section>' +
      '<section class="workspace-card"><h3>Tracker tools</h3><div class="workspace-actions"><a class="btn" href="/?tracker=visa&tab=search">Decision search</a><a class="btn" href="/?tracker=visa&tab=watchlist">Watchlist and alerts</a><a class="btn" href="/?tracker=visa&tab=search#vfs-check-btn">VFS appointment check</a><a class="btn" href="/visa-processing-times">Processing times</a></div><p class="workspace-muted" style="margin-top:10px;">The fee estimate is indicative only. Confirm current fees and requirements with the official embassy or VFS page before paying.</p></section>';
  }

  function renderCommunity() {
    var data = state.community;
    var filter = state.communityFilter;
    var post = state.communityPost;
    if (post && post.post) {
      var item = post.post;
      return '<div class="workspace-heading"><h2>' + esc(item.title) + '</h2><p>' + esc(item.kind) + ' · by ' + esc(item.author) + ' · ' + esc(date(item.created_at)) + '</p></div>' +
        '<section class="workspace-card"><p>' + esc(item.body).replace(/\n/g, '<br>') + '</p>' +
          (item.rating ? '<p class="workspace-meta">Rating ' + esc(item.rating) + '/5</p>' : '') +
          (item.outcome ? '<p class="workspace-meta">Outcome: ' + esc(item.outcome) + '</p>' : '') +
          '<div class="workspace-actions"><button class="btn" type="button" data-action="back-community">Back to community</button></div>' +
          '<div class="workspace-thread"><h3>Answers</h3>' +
            ((post.answers || []).length ? post.answers.map(function (answer) {
              return '<article class="workspace-answer ' + (answer.accepted ? 'accepted' : '') + '"><p>' + esc(answer.body).replace(/\n/g, '<br>') + '</p><p class="workspace-meta">' + esc(answer.author) + ' · ' + esc(date(answer.created_at)) + (answer.accepted ? ' · accepted' : '') + '</p>' +
                (item.is_owner && !answer.accepted ? '<button class="workspace-link-button" type="button" data-action="accept-answer" data-post="' + esc(item.id) + '" data-answer="' + esc(answer.id) + '">Accept this answer</button>' : '') + '</article>';
            }).join('') : empty('No answers yet.')) +
            '<form class="workspace-form" data-action="answer" data-post="' + esc(item.id) + '"><label>Your answer<textarea name="body" rows="4" maxlength="4000" required placeholder="Share what you know, without personal or immigration advice."></textarea></label><button class="btn primary" type="submit">Post answer</button><p class="form-status" data-form-status aria-live="polite"></p></form>' +
          '</div></section>';
    }
    return '<div class="workspace-heading"><h2>Community</h2><p>Questions, reviews and success stories from applicants. Be respectful and never post application numbers, passport data or other personal information.</p></div>' +
      '<section class="workspace-card"><form class="workspace-form" data-action="community-filter"><div class="workspace-form-grid">' +
        '<label>Kind<select name="kind">' + options([['', 'All kinds'], ['question', 'Questions'], ['review', 'Reviews'], ['success', 'Success stories']], filter.kind) + '</select></label>' +
        '<label>Office<select name="office">' + options(OFFICES, filter.office) + '</select></label></div><button class="btn" type="submit">Filter</button></form></section>' +
      (data && data.can_post ? '<section class="workspace-card"><h3>Share an update</h3><form class="workspace-form" data-action="create-post"><div class="workspace-form-grid"><label>Kind<select name="kind">' + options([['question', 'Question'], ['review', 'Review'], ['success', 'Success story']], 'question') + '</select></label><label>Office<select name="office">' + options(OFFICES, 'all') + '</select></label><label>Visa type<input name="visa_type" maxlength="40" placeholder="Study, work, visit…"></label><label>Rating (reviews)<select name="rating">' + options(['5', '4', '3', '2', '1'], '5') + '</select></label><label>Outcome (success)<select name="outcome">' + options([['', 'Not specified'], ['Approved', 'Approved'], ['Refused', 'Refused']], '') + '</select></label></div>' +
        '<label>Title<input name="title" maxlength="140" required placeholder="What is your update about?"></label><label>Details<textarea name="body" maxlength="6000" required placeholder="Share timelines, documents or a question. Do not include personal identifiers."></textarea></label><button class="btn primary" type="submit">Publish</button><p class="form-status" data-form-status aria-live="polite"></p></form></section>' : '') +
      '<section class="workspace-card"><h3>Recent community posts</h3>' +
        (data && data.posts && data.posts.length ? data.posts.map(function (row) {
          return '<article class="workspace-post"><h4>' + esc(row.title) + '</h4><p>' + esc(row.body).slice(0, 220) + (row.body && row.body.length > 220 ? '…' : '') + '</p><div class="workspace-row"><span class="workspace-meta">' + esc(row.kind) + ' · ' + esc(row.author) + ' · ' + count(row.answer_count) + ' answer(s)</span><button class="workspace-link-button" type="button" data-action="open-post" data-id="' + esc(row.id) + '">Open discussion</button></div></article>';
        }).join('') : empty('No posts yet.')) + '</section>' +
      '<section class="workspace-card"><h3>Referrals</h3>' + (state.referral ? '<p class="workspace-muted">Invite another applicant. You have <strong>' + count(state.referral.accepted) + '</strong> accepted referral(s) and <strong>' + count(state.referral.credits || 0) + '</strong> referral credit(s).</p><code class="workspace-code">' + esc(state.referral.link) + '</code><div class="workspace-actions" style="margin-top:8px;"><button class="btn" type="button" data-action="copy-referral">Copy invite link</button></div><form class="workspace-form" data-action="referral-invite" style="margin-top:12px;"><div class="workspace-form-grid"><label>Invite email<input type="email" name="email" required placeholder="colleague@example.com"></label></div><button class="btn secondary" type="submit">Create email invite</button><p class="form-status" data-form-status aria-live="polite"></p></form>' : '<p class="workspace-muted">Sign in to get your referral link.</p>') + '</section>';
  }

  function renderOrganization() {
    var detail = state.orgDetail;
    var org = detail && detail.org;
    if (!org) {
      return '<div class="workspace-heading"><h2>Organization</h2><p>Create a small team workspace with branding and shared support context.</p></div>' +
        '<section class="workspace-card"><h3>Create an organization</h3><form class="workspace-form" data-action="create-org"><label>Organization name<input name="name" maxlength="120" required placeholder="Your team or agency"></label><button class="btn primary" type="submit">Create organization</button><p class="form-status" data-form-status aria-live="polite"></p></form></section>' +
        '<section class="workspace-card"><h3>Join with an invite</h3><form class="workspace-form" data-action="join-org"><label>Invite token<input name="token" required></label><button class="btn" type="submit">Join organization</button><p class="form-status" data-form-status aria-live="polite"></p></form></section>';
    }
    var members = detail.members || [];
    var canEdit = org.role === 'owner' || org.role === 'admin' || detail.role === 'owner' || detail.role === 'admin';
    return '<div class="workspace-heading"><h2>Organization</h2><p>' + esc(org.name) + ' · ' + esc(org.plan || 'team') + ' · your role: ' + esc(detail.role || org.role || 'member') + '</p></div>' +
      '<section class="workspace-card"><div class="workspace-brand-preview" style="background:' + safeColor(org.brand_color) + '"><strong>' + esc(org.brand_name || org.name) + '</strong><span>Brand preview · ' + esc(org.slug) + '</span></div></section>' +
      (canEdit ? '<section class="workspace-card"><h3>Branding</h3><form class="workspace-form" data-action="save-org"><div class="workspace-form-grid"><label>Legal name<input name="name" maxlength="120" value="' + esc(org.name) + '"></label><label>Brand name<input name="brand_name" maxlength="120" value="' + esc(org.brand_name || org.name) + '"></label><label>Brand color<input name="brand_color" maxlength="20" value="' + esc(org.brand_color || '#047857') + '"></label><label>Logo URL<input name="logo_url" maxlength="500" value="' + esc(org.logo_url || '') + '"></label></div>' +
        '<button class="btn primary" type="submit">Save organization</button><p class="form-status" data-form-status aria-live="polite"></p></form></section>' : '') +
      '<section class="workspace-card"><h3>Members</h3>' + (members.length ? '<div class="workspace-table-wrap"><table class="workspace-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead><tbody>' + members.map(function (member) {
        return '<tr><td>' + esc(member.name || '') + '</td><td>' + esc(member.email || '') + '</td><td>' + esc(member.role) + '</td></tr>';
      }).join('') + '</tbody></table></div>' : empty('No members found.')) + '</section>' +
      (canEdit ? '<section class="workspace-card"><h3>Invite a member</h3><form class="workspace-form" data-action="invite-org"><label>Email<input type="email" name="email" required></label><button class="btn" type="submit">Create invite</button><p class="form-status" data-form-status aria-live="polite"></p></form><p class="workspace-muted">Invites expire after seven days. Email delivery is attempted only when the deployment has an email webhook configured.</p></section>' : '') +
      '';
  }

  function renderView(view) {
    if (view === 'profile') return renderProfile();
    if (view === 'notifications') return renderNotifications();
    if (view === 'analytics') return renderAnalytics();
    if (view === 'exports') return renderExports();
    if (view === 'assistant') return renderAssistant();
    if (view === 'community') return renderCommunity();
    if (view === 'organization') return renderOrganization();
    return renderOverview();
  }
  function renderPanel() {
    el('workspace-panel').innerHTML = renderView(state.view);
    if (state.view === 'profile') {
      var signout = el('profile-signout');
      if (signout) signout.addEventListener('click', signOut);
    }
  }

  async function loadAnalytics(force) {
    if (state.analytics && !force) return;
    var filter = state.analyticsFilter;
    var query = new URLSearchParams();
    query.set('office', filter.office || 'all');
    if (filter.from) query.set('from', filter.from);
    if (filter.to) query.set('to', filter.to);
    if (filter.date) query.set('date', filter.date);
    query.set('horizon', '14');
    state.analytics = await api('/api/portal/analytics?' + query.toString());
  }
  async function loadCommunity(force) {
    if (state.community && !force) return;
    var query = new URLSearchParams();
    if (state.communityFilter.kind) query.set('kind', state.communityFilter.kind);
    if (state.communityFilter.office) query.set('office', state.communityFilter.office);
    var results = await Promise.all([
      api('/api/portal/community' + (query.toString() ? '?' + query.toString() : '')),
      api('/api/portal/referrals').catch(function () { return null; })
    ]);
    state.community = results[0];
    state.referral = results[1];
  }
  async function loadExports(force) {
    if (state.schedules && state.tokens && !force) return;
    var results = await Promise.all([
      api('/api/portal/exports/schedules'),
      api('/api/portal/export-tokens')
    ]);
    state.schedules = results[0].schedules || [];
    state.tokens = results[1].tokens || [];
  }
  async function loadOrg(force) {
    if (state.orgDetail && !force) return;
    var detail = await api('/api/portal/org');
    state.orgDetail = detail;
    if (detail.org) {
      detail.org.role = detail.org.role || detail.role;
      applyBrand(detail.org);
    }
  }
  async function refreshOverview() {
    state.overview = await api('/api/portal/overview');
    renderPerson();
    return state.overview;
  }

  async function setView(view, initial) {
    if (!VIEW_TITLES[view]) view = 'overview';
    state.view = view;
    Array.prototype.forEach.call(document.querySelectorAll('#workspace-nav [data-view]'), function (button) {
      if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    if (!initial) {
      try { history.replaceState(null, '', '#' + view); } catch (error) {}
    }
    var panel = el('workspace-panel');
    panel.innerHTML = '<p class="workspace-loading">Loading ' + esc(VIEW_TITLES[view].toLowerCase()) + '…</p>';
    try {
      if (view === 'analytics') await loadAnalytics();
      if (view === 'community') await loadCommunity();
      if (view === 'exports') await loadExports();
      if (view === 'organization') await loadOrg();
      panel.innerHTML = renderView(view);
      if (view === 'profile') {
        var signout = el('profile-signout');
        if (signout) signout.addEventListener('click', signOut);
      }
      if (!initial) panel.focus({ preventScroll: true });
    } catch (error) {
      panel.innerHTML = '<div class="workspace-card"><h3>Could not load this section</h3><p class="workspace-notice error">' + esc(error.message) + '</p><button class="btn" type="button" data-action="retry">Retry</button></div>';
    }
  }

  async function handleInvite() {
    var params = new URLSearchParams(location.search);
    var token = params.get('org_invite');
    if (!token) return;
    try {
      await api('/api/portal/org/join', { method: 'POST', body: { token: token } });
      flash('Organization invitation accepted.');
      await refreshOverview();
    } catch (error) {
      flash('Could not join organization: ' + error.message, 'warning');
    }
    var url = new URL(location.href);
    url.searchParams.delete('org_invite');
    try { history.replaceState(null, '', url.pathname + url.search + url.hash); } catch (error) {}
  }

  async function bootstrap() {
    try {
      var data = await api('/api/portal/overview');
      state.overview = data;
      renderPerson();
      showApp();
      await handleInvite();
      var requested = (location.hash || '').replace('#', '');
      await setView(VIEW_TITLES[requested] ? requested : 'overview', true);
    } catch (error) {
      if (error.status === 401) showAuth();
      else {
        el('workspace-loading').hidden = true;
        el('workspace-auth').hidden = false;
        el('auth-signin-status').textContent = error.message;
      }
    }
  }

  async function signOut() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (error) {}
    location.href = '/workspace';
  }

  async function submitAuth(form, kind) {
    var status = kind === 'register' ? el('auth-register-status') : el('auth-signin-status');
    var button = form.querySelector('button[type="submit"]');
    markBusy(button, true);
    status.textContent = kind === 'register' ? 'Creating account…' : 'Signing in…';
    status.className = 'form-status';
    try {
      var input = readForm(form);
      if (kind === 'register') {
        var storedRef = '';
        try { storedRef = localStorage.getItem('ivt_referral') || ''; } catch (error) {}
        input.referral_code = storedRef;
      }
      await api(kind === 'register' ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: input });
      await bootstrap();
    } catch (error) {
      status.textContent = error.message;
      status.className = 'form-status error';
    } finally {
      markBusy(button, false);
    }
  }

  async function handlePanelClick(event) {
    var target = event.target.closest('[data-action]');
    if (!target) return;
    var action = target.dataset.action;
    if (action === 'go') {
      await setView(target.dataset.view || 'overview');
      return;
    }
    if (action === 'retry') {
      await setView(state.view);
      return;
    }
    if (action === 'delete-schedule') {
      if (!window.confirm('Delete this scheduled export?')) return;
      try {
        await api('/api/portal/exports/schedules?id=' + encodeURIComponent(target.dataset.id), { method: 'DELETE' });
        state.schedules = null;
        await loadExports(true);
        renderPanel();
        flash('Schedule deleted.');
      } catch (error) { flash(error.message, 'error'); }
      return;
    }
    if (action === 'revoke-token') {
      if (!window.confirm('Revoke this private export token?')) return;
      try {
        await api('/api/portal/export-tokens?id=' + encodeURIComponent(target.dataset.id), { method: 'DELETE' });
        state.tokens = null;
        await loadExports(true);
        renderPanel();
        flash('Token revoked.');
      } catch (error) { flash(error.message, 'error'); }
      return;
    }
    if (action === 'copy-token') {
      try {
        await navigator.clipboard.writeText(state.tokenResult || '');
        flash('Token copied.');
      } catch (error) { flash('Copy failed. Select the token text and copy it manually.', 'warning'); }
      return;
    }
    if (action === 'copy-referral') {
      try {
        await navigator.clipboard.writeText(state.referral && state.referral.link || '');
        flash('Referral link copied.');
      } catch (error) { flash('Copy failed. Select the link and copy it manually.', 'warning'); }
      return;
    }
    if (action === 'open-post') {
      try {
        state.communityPost = await api('/api/portal/community/' + encodeURIComponent(target.dataset.id));
        renderPanel();
      } catch (error) { flash(error.message, 'error'); }
      return;
    }
    if (action === 'back-community') {
      state.communityPost = null;
      renderPanel();
      return;
    }
    if (action === 'accept-answer') {
      try {
        await api('/api/portal/community/' + encodeURIComponent(target.dataset.post) + '/answers/' + encodeURIComponent(target.dataset.answer) + '/accept', { method: 'POST' });
        state.communityPost = await api('/api/portal/community/' + encodeURIComponent(target.dataset.post));
        renderPanel();
        flash('Answer accepted.');
      } catch (error) { flash(error.message, 'error'); }
    }
  }

  async function handlePanelSubmit(event) {
    var form = event.target.closest('form[data-action]');
    if (!form) return;
    event.preventDefault();
    var action = form.dataset.action;
    var values = readForm(form);
    var button = form.querySelector('button[type="submit"]');
    markBusy(button, true);
    formStatus(form, 'Working…');
    try {
      if (action === 'save-profile') {
        await api('/api/portal/profile', {
          method: 'PATCH',
          body: {
            name: values.name,
            preferences: {
              theme: values.theme,
              language: values.language,
              timezone: values.timezone,
              notifications: {
                email: Boolean(values.notify_email),
                push: Boolean(values.notify_push),
                digest: Boolean(values.notify_digest)
              }
            }
          }
        });
        await refreshOverview();
        formStatus(form, 'Profile saved.', 'ok');
        flash('Profile saved.');
      } else if (action === 'analytics-filter') {
        state.analyticsFilter = { office: values.office, from: values.from, to: values.to, date: values.date };
        state.analytics = null;
        await loadAnalytics(true);
        renderPanel();
      } else if (action === 'download-export') {
        var query = new URLSearchParams({ format: values.format || 'csv', office: values.office || 'all' });
        if (values.from) query.set('from', values.from);
        if (values.to) query.set('to', values.to);
        window.location.href = '/api/portal/exports?' + query.toString();
        formStatus(form, 'Download started.', 'ok');
      } else if (action === 'add-schedule') {
        await api('/api/portal/exports/schedules', {
          method: 'POST',
          body: { format: values.format, frequency: values.frequency, filters: { office: values.office } }
        });
        state.schedules = null;
        await loadExports(true);
        renderPanel();
        flash('Scheduled export created.');
      } else if (action === 'create-token') {
        var created = await api('/api/portal/export-tokens', {
          method: 'POST',
          body: { name: values.name, expires_days: Number(values.expires_days) || 365 }
        });
        state.tokenResult = created.token;
        state.tokens = null;
        await loadExports(true);
        renderPanel();
        flash('Private token created. Copy it now; it will not be shown again.');
      } else if (action === 'fees') {
        var feeQuery = new URLSearchParams({
          office: values.office || 'new-delhi',
          entry_type: values.entry_type || 'single',
          entries: values.entries || '1',
          vfs: values.vfs ? '1' : '0',
          biometrics: '1',
          postal: values.postal ? '1' : '0'
        });
        state.fees = await api('/api/portal/assistant/fees?' + feeQuery.toString());
        renderPanel();
      } else if (action === 'scan') {
        var formData = new FormData(form);
        state.scan = await api('/api/portal/assistant/scan', { method: 'POST', body: formData });
        renderPanel();
        flash('Document fields extracted.');
      } else if (action === 'community-filter') {
        state.communityFilter = { kind: values.kind, office: values.office };
        state.community = null;
        state.communityPost = null;
        await loadCommunity(true);
        renderPanel();
      } else if (action === 'create-post') {
        await api('/api/portal/community', {
          method: 'POST',
          body: {
            kind: values.kind,
            title: values.title,
            body: values.body,
            office: values.office === 'all' ? '' : values.office,
            visa_type: values.visa_type,
            rating: values.rating,
            outcome: values.outcome
          }
        });
        state.community = null;
        state.communityPost = null;
        await loadCommunity(true);
        renderPanel();
        flash('Post published.');
      } else if (action === 'answer') {
        await api('/api/portal/community/' + encodeURIComponent(form.dataset.post) + '/answers', {
          method: 'POST',
          body: { body: values.body }
        });
        state.communityPost = await api('/api/portal/community/' + encodeURIComponent(form.dataset.post));
        renderPanel();
        flash('Answer posted.');
      } else if (action === 'referral-invite') {
        var invitation = await api('/api/portal/referrals', { method: 'POST', body: { email: values.email } });
        state.referral = await api('/api/portal/referrals');
        renderPanel();
        flash(invitation.sent ? 'Referral invite sent.' : 'Referral created; email delivery is not configured.');
      } else if (action === 'create-org') {
        await api('/api/portal/org', { method: 'POST', body: { name: values.name } });
        state.orgDetail = null;
        await refreshOverview();
        await loadOrg(true);
        renderPanel();
        flash('Organization created.');
      } else if (action === 'save-org') {
        await api('/api/portal/org', {
          method: 'PATCH',
          body: {
            name: values.name,
            brand_name: values.brand_name,
            brand_color: values.brand_color,
            logo_url: values.logo_url
          }
        });
        state.orgDetail = null;
        await refreshOverview();
        await loadOrg(true);
        renderPanel();
        flash('Organization updated.');
      } else if (action === 'invite-org') {
        var invite = await api('/api/portal/org/invite', { method: 'POST', body: { email: values.email } });
        formStatus(form, invite.sent ? 'Invite sent.' : 'Invite created. Email is not configured; copy the invite link.', invite.sent ? 'ok' : '');
        if (invite.invite_url) {
          var copy = document.createElement('code');
          copy.className = 'workspace-code';
          copy.textContent = invite.invite_url;
          form.appendChild(copy);
        }
        flash(invite.sent ? 'Invite sent.' : 'Invite created; email delivery is not configured.');
      } else if (action === 'join-org') {
        await api('/api/portal/org/join', { method: 'POST', body: { token: values.token } });
        state.orgDetail = null;
        await refreshOverview();
        await loadOrg(true);
        renderPanel();
        flash('Joined organization.');
      }
    } catch (error) {
      formStatus(form, error.message, 'error');
      flash(error.message, 'error');
    } finally {
      markBusy(button, false);
    }
  }

  function init() {
    try {
      var queryRef = new URLSearchParams(location.search).get('ref');
      if (queryRef) {
        state.ref = queryRef;
        try { localStorage.setItem('ivt_referral', queryRef); } catch (error) {}
      } else {
        try { state.ref = localStorage.getItem('ivt_referral') || ''; } catch (error) {}
      }
    } catch (error) {}

    Array.prototype.forEach.call(document.querySelectorAll('[data-auth-tab]'), function (button) {
      button.addEventListener('click', function () { setAuthTab(button.dataset.authTab); });
    });
    el('auth-signin').addEventListener('submit', function (event) {
      event.preventDefault();
      submitAuth(event.target, 'signin');
    });
    el('auth-register').addEventListener('submit', function (event) {
      event.preventDefault();
      submitAuth(event.target, 'register');
    });
    Array.prototype.forEach.call(document.querySelectorAll('#workspace-nav [data-view]'), function (button) {
      button.addEventListener('click', function () { setView(button.dataset.view); });
    });
    el('workspace-signout').addEventListener('click', signOut);
    el('workspace-panel').addEventListener('click', function (event) { handlePanelClick(event); });
    el('workspace-panel').addEventListener('submit', function (event) { handlePanelSubmit(event); });
    window.addEventListener('hashchange', function () {
      if (!state.overview) return;
      var view = location.hash.replace('#', '');
      if (VIEW_TITLES[view] && view !== state.view) setView(view, true);
    });
    bootstrap();
  }

  init();
})();
