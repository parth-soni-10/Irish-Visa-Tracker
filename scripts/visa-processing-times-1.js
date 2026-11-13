/* One fetch per data file, then both the snapshot and the trend paragraphs are filled
     from the same responses. Static text in the HTML is the truth as of this page's build;
     this keeps it true afterwards. A failed fetch leaves the static text untouched. */
  (function () {
    var months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
    var DAY = 86400000;

    function longDate(iso) {
      var p = String(iso).slice(0, 10).split('-');
      if (p.length !== 3) return null;
      var m = months[Number(p[1]) - 1];
      if (!m) return null;
      return Number(p[2]) + ' ' + m + ' ' + p[0];
    }
    function isoMinusDays(iso, n) {
      var p = String(iso).slice(0, 10).split('-');
      var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
      return new Date(d.getTime() - n * DAY).toISOString().slice(0, 10);
    }
    function get(url) {
      return fetch(url, { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
        .catch(function () { return null; });
    }
    function series(rows, cat) {
      var out = [];
      (rows || []).forEach(function (r) {
        if (!r || String(r.category) !== cat) return;
        if (typeof r.lag_days !== 'number' || !r.run_date) return;
        out.push([r.run_date, r.lag_days]);
      });
      out.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
      return out;
    }
    function atOrBefore(pts, target) {
      var best = null;
      for (var i = 0; i < pts.length; i++) {
        if (pts[i][0] <= target) { if (!best || pts[i][0] > best[0]) best = pts[i]; }
      }
      return best;
    }
    function lastOf(pts) { return pts.length ? pts[pts.length - 1] : null; }
    function setText(id, text) {
      var el = document.getElementById(id);
      if (el && text) el.textContent = text;
    }

    Promise.all([
      get('/data/stamp_1g.json'),
      get('/data/work_permits.json'),
      get('/data/visa_decisions.json')
    ]).then(function (res) {
      var g1 = res[0], pm = res[1], dec = res[2];

      /* ---- snapshot ---- */
      if (Array.isArray(g1) && g1.length) {
        var latest = g1.reduce(function (a, r) { return r.run_date > a ? r.run_date : a; }, '');
        var same = g1.filter(function (r) { return r.run_date === latest; });
        var row = null;
        for (var i = 0; i < same.length; i++) {
          if (String(same[i].category).toLowerCase() === 'other') { row = same[i]; break; }
        }
        if (!row) row = same[same.length - 1];
        if (row) {
          var d = document.getElementById('t-g1-date');
          var l = document.getElementById('t-g1-lag');
          if (d && longDate(row.processing_date)) d.textContent = longDate(row.processing_date);
          if (l && typeof row.lag_days === 'number') l.textContent = row.lag_days + ' days';
        }
      }
      if (Array.isArray(pm) && pm.length) {
        var latestP = pm.reduce(function (a, r) { return r.run_date > a ? r.run_date : a; }, '');
        var lags = pm.filter(function (r) {
          return r.run_date === latestP && typeof r.lag_days === 'number';
        }).map(function (r) { return r.lag_days; });
        if (lags.length) {
          var mn = document.getElementById('t-perm-min');
          var mx = document.getElementById('t-perm-max');
          if (mn) mn.textContent = Math.min.apply(null, lags) + ' days';
          if (mx) mx.textContent = Math.max.apply(null, lags) + ' days';
        }
      }
      var published = [];
      if (Array.isArray(dec)) {
        var by = {}, approved = 0, refused = 0;
        for (var k = 0; k < dec.length; k++) {
          var dd = dec[k][0], vv = dec[k][2];
          if (vv === 'Approved') { approved++; by[dd] = (by[dd] || 0) + 1; }
          else if (vv === 'Refused') { refused++; by[dd] = (by[dd] || 0) + 1; }
        }
        published = Object.keys(by).sort().map(function (key) { return [key, by[key]]; });
        var total = approved + refused;
        var cEl = document.getElementById('t-decisions');
        var dEl = document.getElementById('t-days');
        var sEl = document.getElementById('t-approved-share');
        if (cEl) cEl.textContent = total.toLocaleString('en-IE');
        if (dEl) dEl.textContent = published.length;
        if (sEl && total > 0) sEl.textContent = (100 * approved / total).toFixed(1) + '%';
      }

      /* ---- trends: the same figures 30 days apart ---- */
      if (Array.isArray(g1) && g1.length) {
        var g1pts = series(g1, 'Other');
        var g1last = lastOf(g1pts);
        var g1then = g1last ? atOrBefore(g1pts, isoMinusDays(g1last[0], 30)) : null;
        if (g1last && g1then && g1then[0] !== g1last[0]) {
          var dg = g1last[1] - g1then[1];
          var g1Text = dg === 0
            ? 'The overall queue held at ' + g1last[1] + ' days behind between ' +
              longDate(g1then[0]) + ' and ' + longDate(g1last[0]) + '.'
            : 'The overall queue moved from ' + g1then[1] + ' days behind on ' + longDate(g1then[0]) +
              ' to ' + g1last[1] + ' days behind on ' + longDate(g1last[0]) + ' - it ' +
              (dg > 0 ? 'fell ' + dg + ' days further behind' : 'caught up by ' + (-dg) + ' days') +
              ' over that period.';
          setText('trend-g1', 'Stamp 1G. ' + g1Text);
        }
      }

      if (Array.isArray(pm) && pm.length) {
        var cats = {};
        pm.forEach(function (r) { if (r && r.category) cats[r.category] = true; });
        var changes = [];
        Object.keys(cats).forEach(function (cat) {
          var pts = series(pm, cat);
          var last = lastOf(pts);
          if (!last) return;
          var then = atOrBefore(pts, isoMinusDays(last[0], 30));
          if (!then || then[0] === last[0]) return;
          changes.push({ cat: cat, from: then[1], to: last[1], at: then[0], now: last[0], delta: last[1] - then[1] });
        });
        if (changes.length) {
          var worst = changes.slice().sort(function (a, b) { return b.delta - a.delta; })[0];
          var best = changes.slice().sort(function (a, b) { return a.delta - b.delta; })[0];
          var parts = [];
          if (worst && worst.delta > 0) {
            parts.push(worst.cat + ' moved from ' + worst.from + ' days behind on ' + longDate(worst.at) +
                       ' to ' + worst.to + ' days on ' + longDate(worst.now));
          }
          if (best && best.delta < 0 && best !== worst) {
            parts.push(best.cat + ' improved from ' + best.from + ' days behind to ' + best.to);
          }
          if (parts.length) {
            setText('trend-permits', 'Employment permits. ' + parts.join(', while ') + '.');
          }
        }
      }

      if (published.length >= 12) {
        var n = 6;
        var recent = published.slice(-n).reduce(function (a, p) { return a + p[1]; }, 0);
        var prior = published.slice(-2 * n, -n).reduce(function (a, p) { return a + p[1]; }, 0);
        var dir = recent === prior ? 'the same as'
                : recent > prior ? 'above' : 'below';
        var volText = 'Decision volume. The last ' + n + ' published days carried ' +
          recent.toLocaleString('en-IE') + ' decisions, ' + dir + ' the ' +
          prior.toLocaleString('en-IE') + ' across the ' + n + ' published days before them.';
        setText('trend-volume', volText);
      }
    });
  })();
