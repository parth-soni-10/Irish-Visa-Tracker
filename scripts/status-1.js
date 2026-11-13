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
        var date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString('en-IE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
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
          var total = offices.reduce(function (sum, office) { return sum + (Number(office.decisions) || 0); }, 0);
          var archiveTotal = offices.reduce(function (sum, office) { return sum + (Number(office.archive_decisions) || Number(office.decisions) || 0); }, 0);

          document.getElementById('status-summary').innerHTML =
            '<div class="status-card"><span class="status-kicker">Offices covered</span><strong>' + offices.length + '</strong><span>Named official sources</span></div>' +
            '<div class="status-card"><span class="status-kicker">Latest report</span><strong>' + esc(fmtDate(latestReport)) + '</strong><span>Most recent office report</span></div>' +
            '<div class="status-card"><span class="status-kicker">Last ingest</span><strong>' + esc(fmtStamp(latestFetch)) + '</strong><span>When the data was fetched</span></div>' +
            '<div class="status-card"><span class="status-kicker">Latest report rows</span><strong>' + total.toLocaleString('en-IE') + '</strong><span>Across all offices</span></div>' +
            '<div class="status-card"><span class="status-kicker">Archive rows</span><strong>' + archiveTotal.toLocaleString('en-IE') + '</strong><span>All dated official history</span></div>';

          document.getElementById('status-rows').innerHTML = offices.map(function (office) {
            var label = office.status === 'official' ? 'Official' : esc(office.status || 'Published');
            var thin = isThin(office);
            var datedHistory = { 'new-delhi': true, 'abu-dhabi': true, abuja: true, ankara: true };
            var history = datedHistory[office.slug] ? 'Dated history' : 'Latest report only';
            return '<tr>' +
              '<th scope="row">' + esc(office.name || office.slug) + '</th>' +
              '<td><span class="status-pill' + (thin ? ' is-thin' : '') + '">' + label + (thin ? ' &middot; small office' : '') + '</span></td>' +
              '<td>' + esc(fmtDate(office.report_date)) + '</td>' +
              '<td>' + (Number(office.decisions) || 0).toLocaleString('en-IE') + '</td>' +
              '<td>' + (Number(office.archive_decisions) || Number(office.decisions) || 0).toLocaleString('en-IE') + '</td>' +
              '<td>' + history + '</td>' +
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
                  '<td><time datetime="' + esc(String(report.report_date || '').slice(0, 10)) + '">' + esc(fmtDate(report.report_date)) + '</time></td>' +
                  '<td>' + (Number(report.decisions) || 0).toLocaleString('en-IE') + '</td>' +
                  '<td>' + basis + '</td>' +
                '</tr>';
              }).join('')
            : '<tr><td colspan="4" class="note2">No archived report dates are recorded in the manifest.</td></tr>';
        })
        .catch(function (error) {
          document.getElementById('status-summary').innerHTML = '<p class="note2">The data manifest could not be loaded: ' + esc(error.message) + '. <a href="/data/data_manifest.json">Open the manifest directly</a>.</p>';
          document.getElementById('status-rows').innerHTML = '<tr><td colspan="6" class="note2">Office coverage is unavailable right now. The manifest link above remains authoritative.</td></tr>';
          document.getElementById('archive-history-rows').innerHTML = '<tr><td colspan="4" class="note2">Archived report dates are unavailable right now.</td></tr>';
        });
    })();
