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
        return date.toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
      }

      function stampText(value) {
        if (!value) return 'Not recorded';
        var date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString('en-IE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hourCycle: 'h23' }) + ' UTC';
      }

      function fmtStamp(value) {
        if (!value) return 'Not recorded';
        if (window.IVTimeMode) return window.IVTimeMode.node(value, 'full');
        return esc(stampText(value));
      }

      function fetchJson(url) {
        return fetch(url, { cache: 'no-store' }).then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json();
        });
      }

      Promise.all([
        fetchJson('/data/data_manifest.json'),
        fetchJson('/data/freshness.json').catch(function () { return null; })
      ])
        .then(function (results) {
          var manifest = results[0];
          var freshness = results[1];
          var offices = Array.isArray(manifest.offices) ? manifest.offices : [];
          if (!offices.length) throw new Error('No offices in manifest');
          var freshBySlug = {};
          if (freshness && Array.isArray(freshness.offices)) {
            freshness.offices.forEach(function (office) {
              if (office && office.slug) freshBySlug[office.slug] = office;
            });
          }

          var withDates = offices.filter(function (office) { return office.report_date; });
          var newest = withDates.slice().sort(function (a, b) {
            return String(b.report_date).localeCompare(String(a.report_date));
          })[0] || null;
          var newestDated = withDates.filter(function (office) {
            return office.slug !== 'beijing' && office.slug !== 'dublin';
          }).sort(function (a, b) {
            return String(b.report_date).localeCompare(String(a.report_date));
          })[0] || null;
          var latestFetch = offices.reduce(function (latest, office) {
            return office.fetched_at && (!latest || office.fetched_at > latest) ? office.fetched_at : latest;
          }, null);
          document.getElementById('status-summary').innerHTML =
            '<div class="status-metric"><span class="status-metric-label">Offices covered</span><strong>' + offices.length + '</strong><span>Named official sources</span></div>' +
            '<div class="status-metric"><span class="status-metric-label">Newest office update</span><strong>' + esc(newest ? fmtDate(newest.report_date) : 'Not recorded') + '</strong><span>' + esc(newest ? (newest.slug === 'dublin' || newest.slug === 'beijing' ? newest.name + ' snapshot' : newest.name + ' report') : 'No office dates') + '</span></div>' +
            '<div class="status-metric"><span class="status-metric-label">Newest dated report</span><strong>' + esc(newestDated ? fmtDate(newestDated.report_date) : 'Not recorded') + '</strong><span>' + esc(newestDated ? newestDated.name + ' report' : 'No dated reports') + '</span></div>' +
            '<div class="status-metric"><span class="status-metric-label">Last ingest</span><strong>' + fmtStamp(latestFetch) + '</strong><span>When the data was fetched</span></div>';

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

          var historyEl = document.querySelector
            ? document.querySelector('[data-freshness-history]')
            : null;
          if (historyEl) {
            var lagRows = offices.filter(function (office) {
              return freshBySlug[office.slug] && freshBySlug[office.slug].observation_lag;
            });
            historyEl.innerHTML = lagRows.length
              ? '<p class="small-note"><strong>How quickly does the tracker see a file?</strong> Lag is the time between a report date and the tracker\'s first archived observation of it. Backfilled history is excluded from the median.</p>' +
                '<div class="table-wrap" role="region" aria-label="Observation lag by office" tabindex="0"><table class="office-table stack-table"><caption>Report date to first tracker observation</caption><thead><tr><th scope="col">Office</th><th scope="col">Observation lag</th><th scope="col">Recent report → first observation</th></tr></thead><tbody>' +
                lagRows.map(function (office) {
                  var lag = freshBySlug[office.slug].observation_lag || {};
                  var sample = lag.sample_size
                    ? 'Median ' + lag.median_days + ' day' + (lag.median_days === 1 ? '' : 's') +
                      ' (range ' + lag.min_days + '–' + lag.max_days + '; ' + lag.sample_size + ' report' + (lag.sample_size === 1 ? '' : 's') + ')'
                    : 'Not enough observations yet';
                  var recent = (lag.history || []).slice(0, 3).map(function (entry) {
                    return fmtDate(entry.report_date) + ' → ' + fmtStamp(entry.observed_at) +
                      (entry.lag_days == null ? '' : ' (' + entry.lag_days + ' day' + (entry.lag_days === 1 ? '' : 's') + ')') +
                      (entry.backfilled ? ' <span class="small-note">backfilled</span>' : '');
                  }).join('<br>');
                  return '<tr><th scope="row"><a href="/' + esc(office.slug) + '-visa-decisions">' + esc(office.name || office.slug) + '</a></th>' +
                    '<td data-label="Observation lag">' + esc(sample) + '</td>' +
                    '<td data-label="Recent report → first observation">' + (recent || '—') + '</td></tr>';
                }).join('') + '</tbody></table></div>'
              : '<p class="small-note">No observation history is available yet.</p>';
          }
        })
        .catch(function (error) {
          document.getElementById('status-summary').innerHTML = '<p class="note2">The data manifest could not be loaded: ' + esc(error.message) + '. <a href="/data/data_manifest.json">Open the manifest directly</a>.</p>';
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

      function calibrationDate(value) {
        if (!value) return 'No verified samples yet';
        var raw = String(value);
        var parsed = new Date(raw.indexOf('T') >= 0 ? raw : raw.replace(' ', 'T') + 'Z');
        if (isNaN(parsed.getTime())) return raw;
        return parsed.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' });
      }

      function initModelCard() {
        var box = document.getElementById('model-card-summary');
        if (!box) return;
        fetch('/api/predict', { headers: { Accept: 'application/json' } })
          .then(function (response) { return response.ok ? response.json() : null; })
          .then(function (data) {
            if (!data || !data.model) throw new Error('Model card unavailable');
            var model = data.model;
            var validation = model.validation || {};
            var calibration = model.calibration || data.calibration || {};
            var available = calibration.available !== false;
            var samples = Number(calibration.samples) || 0;
            var minimum = Number(calibration.minimum_samples) || 200;
            var gateMet = available && calibration.meets_minimum_samples === true;
            var gateText = !available
              ? 'Calibration data unavailable'
              : gateMet
                ? 'Calibration sample gate met'
                : 'Calibration gate not met (' + samples + '/' + minimum + ')';
            var calibrationText = !available
              ? (calibration.note || 'The verified sample count could not be loaded.')
              : gateMet
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
                '<div><dt>Real-outcome samples</dt><dd>' + (available ? samples + ' / ' + minimum : 'Unavailable') + '</dd></div>' +
                '<div><dt>Last calibrated</dt><dd>' + (available ? esc(calibrationDate(calibration.last_calibrated_at)) : 'Unavailable') + '</dd></div>' +
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
          status.textContent = 'Checking the community timeline\u2026';
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
            status.textContent = 'Thanks. The dates matched a community timeline. The baseline error for it was ' +
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
