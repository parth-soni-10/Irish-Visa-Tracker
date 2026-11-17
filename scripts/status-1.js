(function () {
      'use strict';

      function esc(value) {
        return String(value == null ? '' : value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function fmtDate(value) {
        if (!value) return 'Not recorded';
        var date = new Date(String(value).slice(0, 10) + 'T00:00:00Z');
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
      }

      function fmtStamp(value) {
        if (!value) return 'Not recorded';
        if (window.IVTimeMode) return window.IVTimeMode.node(value, 'full');
        var date = new Date(value);
        if (Number.isNaN(date.getTime())) return esc(String(value));
        return esc(date.toLocaleString('en-IE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hourCycle: 'h23' }) + ' UTC');
      }

      function isThin(office) {
        return Number(office.decisions) < 500;
      }

      fetch('/data/data_manifest.json', { cache: 'no-store' })
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json();
        })
        .then(function (manifest) {
          var offices = Array.isArray(manifest.offices) ? manifest.offices : [];
          if (!offices.length) throw new Error('No offices in manifest');

          var latestReport = offices.reduce(function (latest, office) {
            return office.report_date && (!latest || office.report_date > latest) ? office.report_date : latest;
          }, null);
          var latestFetch = offices.reduce(function (latest, office) {
            return office.fetched_at && (!latest || office.fetched_at > latest) ? office.fetched_at : latest;
          }, null);
          document.getElementById('status-summary').innerHTML =
            '<div class="status-metric"><span class="status-metric-label">Offices covered</span><strong>' + offices.length + '</strong><span>Named official sources</span></div>' +
            '<div class="status-metric"><span class="status-metric-label">Latest report</span><strong>' + esc(fmtDate(latestReport)) + '</strong><span>Most recent office report</span></div>' +
            '<div class="status-metric"><span class="status-metric-label">Last ingest</span><strong>' + fmtStamp(latestFetch) + '</strong><span>When the data was fetched</span></div>';

          function officeSource(office) {
            var links = [];
            if (office.source_url) links.push('<a href="' + esc(office.source_url) + '" target="_blank" rel="noopener noreferrer">Office page</a>');
            if (office.source_file) links.push('<a href="' + esc(office.source_file) + '" target="_blank" rel="noopener noreferrer">Published file</a>');
            return links.length ? links.join(' &middot; ') : 'Not recorded';
          }

          document.getElementById('status-rows').innerHTML = offices.map(function (office) {
            var label = office.status === 'official' ? 'Official' : esc(office.status || 'Published');
            var thin = isThin(office);
            var datedHistory = { 'new-delhi': true, 'abu-dhabi': true, abuja: true, ankara: true };
            var history = datedHistory[office.slug] ? 'Dated history' : 'Latest report only';
            return '<tr>' +
              '<th scope="row">' + esc(office.name || office.slug) + '</th>' +
              '<td data-label="Status"><span class="status-pill' + (thin ? ' is-thin' : '') + '">' + label + (thin ? ' &middot; small office' : '') + '</span></td>' +
              '<td data-label="Latest report">' + esc(fmtDate(office.report_date)) + '</td>' +
              '<td data-label="Latest report rows">' + (Number(office.decisions) || 0).toLocaleString('en-IE') + '</td>' +
              '<td data-label="Archive rows">' + (Number(office.archive_decisions) || Number(office.decisions) || 0).toLocaleString('en-IE') + '</td>' +
              '<td data-label="History">' + history + '</td>' +
              '<td data-label="Source">' + officeSource(office) + '</td>' +
              '<td data-label="Fetched">' + (office.fetched_at ? fmtStamp(office.fetched_at) : 'Not recorded') + '</td>' +
            '</tr>';
          }).join('');

          var periodicOffices = { 'abu-dhabi': true, abuja: true, ankara: true };
          var historyRows = [];
          offices.forEach(function (office) {
            var reports = Array.isArray(office.archive_reports) ? office.archive_reports.slice() : [];
            if (!reports.length && office.report_date) {
              reports.push({
                report_date: office.report_date,
                decisions: Number(office.archive_decisions) || Number(office.decisions) || 0
              });
            }
            reports.sort(function (a, b) {
              return String(b.report_date || '').localeCompare(String(a.report_date || ''));
            });
            reports.forEach(function (report) {
              historyRows.push({ office: office, report: report });
            });
          });
          document.getElementById('archive-history-rows').innerHTML = historyRows.length
            ? historyRows.map(function (entry) {
                var office = entry.office;
                var report = entry.report;
                var basis = periodicOffices[office.slug] ? 'Period end' : 'Latest snapshot';
                return '<tr>' +
                  '<th scope="row">' + esc(office.name || office.slug) + '</th>' +
                  '<td data-label="Archived report date"><time datetime="' + esc(String(report.report_date || '').slice(0, 10)) + '">' + esc(fmtDate(report.report_date)) + '</time></td>' +
                  '<td data-label="Archived rows">' + (Number(report.decisions) || 0).toLocaleString('en-IE') + '</td>' +
                  '<td data-label="Basis">' + basis + '</td>' +
                '</tr>';
              }).join('')
            : '<tr><td colspan="4" class="note2">No archived report dates are recorded in the manifest.</td></tr>';
        })
        .catch(function (error) {
          document.getElementById('status-summary').innerHTML = '<p class="note2">The data manifest could not be loaded: ' + esc(error.message) + '. <a href="/data/data_manifest.json">Open the manifest directly</a>.</p>';
          document.getElementById('status-rows').innerHTML = '<tr><td colspan="8" class="note2">Office coverage is unavailable right now. The manifest link above remains authoritative.</td></tr>';
          document.getElementById('archive-history-rows').innerHTML = '<tr><td colspan="4" class="note2">Archived report dates are unavailable right now.</td></tr>';
        });

      // Public channel link is optional; only show it when the deployment has
      // a valid TELEGRAM_CHANNEL_URL configured.
      fetch('/api/config', { headers: { Accept: 'application/json' } })
        .then(function (response) { return response.ok ? response.json() : null; })
        .then(function (config) {
          var link = document.getElementById('telegram-channel-link');
          if (!link || !config || !config.telegram_channel_url) return;
          link.href = config.telegram_channel_url;
          link.hidden = false;
        })
        .catch(function () { /* feed links remain available */ });

      function initModelCard() {
        var box = document.getElementById('model-card-summary');
        if (!box) return;
        Promise.all([
          fetch('/api/predict', { headers: { Accept: 'application/json' } })
            .then(function (response) { return response.ok ? response.json() : null; }),
          fetch('/api/predict/feedback', { headers: { Accept: 'application/json' } })
            .then(function (response) { return response.ok ? response.json() : null; })
            .catch(function () { return null; })
        ]).then(function (results) {
          var data = results[0];
          var feedback = results[1];
          if (!data || !data.model) throw new Error('Model card unavailable');
          var model = data.model;
          var validation = model.validation || {};
          var calibration = feedback && feedback.calibration ? feedback.calibration : {};
          var samples = Number(calibration.samples) || 0;
          var gateText = samples >= Number(calibration.minimum_samples || 200)
            ? 'Calibration sample gate met'
            : 'Calibration gate not met (' + samples + '/' + (calibration.minimum_samples || 200) + ')';
          var calibrationText = calibration.meets_minimum_samples
            ? 'Baseline MAE ' + calibration.baseline_mae + ' days; ' + calibration.within_14_day_share + '% within 14 days.'
            : (calibration.note || 'No real-outcome calibration is published yet.');
          box.innerHTML =
            '<h3>Transparent baseline is live; the synthetic ML model is paused.</h3>' +
            '<p><span class="model-gate">' + esc(gateText) + '</span></p>' +
            '<p>' + esc(validation.backtesting || 'No real-outcome backtest is available.') + '</p>' +
            '<p>' + esc(calibrationText) + '</p>' +
            '<dl>' +
              '<div><dt>Published estimate</dt><dd>' + esc(model.baseline && model.baseline.name || 'Office wait + seasonal baseline') + '</dd></div>' +
              '<div><dt>Model version</dt><dd>' + esc(model.version || 'Not recorded') + '</dd></div>' +
              '<div><dt>Synthetic prototype data</dt><dd>' + esc(model.training_data || 'Not recorded') + '</dd></div>' +
              '<div><dt>Synthetic holdout MAE</dt><dd>' + esc(model.training_metrics && model.training_metrics.mae != null ? model.training_metrics.mae + ' days (not validation)' : 'Not published') + '</dd></div>' +
              '<div><dt>Real-outcome samples</dt><dd>' + samples + ' / ' + (calibration.minimum_samples || 200) + '</dd></div>' +
              '<div><dt>Uncertainty</dt><dd>No calibrated interval is shown.</dd></div>' +
            '</dl>';
        }).catch(function () {
          box.innerHTML = '<p>Model card data is unavailable right now. The endpoint remains <a href="/api/predict">/api/predict</a>.</p>';
        });

        var form = document.getElementById('model-feedback-form');
        if (!form) return;
        var today = new Date().toISOString().slice(0, 10);
        var applied = document.getElementById('model-feedback-applied');
        var decided = document.getElementById('model-feedback-decided');
        if (applied) applied.max = today;
        if (decided) decided.max = today;
        form.addEventListener('submit', function (event) {
          event.preventDefault();
          var status = document.getElementById('model-feedback-status');
          var submit = document.getElementById('model-feedback-submit');
          var office = document.getElementById('model-feedback-office');
          var visa = document.getElementById('model-feedback-visa');
          if (!office || !visa || !applied || !decided || !status || !submit) return;
          if (!applied.value || !decided.value) {
            status.textContent = 'Enter both dates.';
            status.className = 'contact-form-status is-error';
            return;
          }
          submit.disabled = true;
          status.textContent = 'Sharing anonymous dates\u2026';
          status.className = 'contact-form-status';
          fetch('/api/predict/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              embassy: office.value,
              visa_type: visa.value,
              application_date: applied.value,
              decision_date: decided.value
            })
          }).then(function (response) {
            return response.json().catch(function () { return {}; }).then(function (body) {
              if (!response.ok) throw new Error(body.error || 'Could not share dates');
              return body;
            });
          }).then(function (body) {
            status.textContent = 'Thanks. The baseline error for this timeline was ' +
              body.baseline_error_days + ' days' + (body.within_14_days ? ' (within 14 days).' : '.') +
              ' It is stored anonymously.';
            status.className = 'contact-form-status is-success';
            form.reset();
          }).catch(function (error) {
            status.textContent = error.message || 'Could not share dates.';
            status.className = 'contact-form-status is-error';
          }).finally(function () {
            submit.disabled = false;
          });
        });
      }
      initModelCard();
    })();
