/* Fill the observation from the Stamp 1G file. The static text above is the truth as of
     this page's last build; this keeps it true after the next pipeline run. A failed fetch
     leaves the static values in place rather than blanking the page. */
  (function () {
    var asOf = document.getElementById('g1-as-of');
    var run = document.getElementById('g1-run');
    var processing = document.getElementById('g1-processing');
    var lag = document.getElementById('g1-lag');
    var status = document.getElementById('g1-status');
    var months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
    function longDate(iso) {
      var p = String(iso).slice(0, 10).split('-');
      if (p.length !== 3) return null;
      var m = months[Number(p[1]) - 1];
      if (!m) return null;
      return Number(p[2]) + ' ' + m + ' ' + p[0];
    }
    function setDate(el, iso) {
      var shown = longDate(iso);
      if (el && shown) {
        el.textContent = shown;
        el.setAttribute('datetime', String(iso).slice(0, 10));
      }
    }
    Promise.all([
      fetch('/data/stamp_1g.json', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); }),
      fetch('/data/visa_meta.json', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
    ]).then(function (out) {
      var rows = out[0];
      var meta = out[1];
      if (meta && status) status.textContent = meta.ok ? 'OK' : 'Degraded';
      if (!Array.isArray(rows) || !rows.length) return;
      var latest = rows.reduce(function (a, r) {
        return r && r.run_date && r.run_date > a ? r.run_date : a;
      }, '');
      var sameDay = rows.filter(function (r) { return r && r.run_date === latest; });
      var row = null;
      for (var i = 0; i < sameDay.length; i++) {
        if (String(sameDay[i].category).toLowerCase() === 'other') { row = sameDay[i]; break; }
      }
      if (!row) row = sameDay[sameDay.length - 1];
      if (!row) return;
      setDate(asOf, latest);
      setDate(run, latest);
      setDate(processing, row.processing_date);
      if (lag && typeof row.lag_days === 'number') {
        lag.textContent = row.lag_days + ' days';
        if (typeof row.lag_weeks === 'number') {
          lag.textContent += ' (about ' + row.lag_weeks.toFixed(1) + ' weeks)';
        }
      }
    }).catch(function () { /* static figures remain */ });
  })();
