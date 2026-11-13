/* Fill each category from the permit file. Static text above is the truth as of this
     page's build; this keeps it true after the next pipeline run. A failed fetch leaves the
     static values in place rather than blanking the list. */
  (function () {
    var asOf = document.getElementById('perm-as-of');
    var status = document.getElementById('perm-status');
    var months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
    function longDate(iso) {
      var p = String(iso).slice(0, 10).split('-');
      if (p.length !== 3) return null;
      var m = months[Number(p[1]) - 1];
      if (!m) return null;
      return Number(p[2]) + ' ' + m + ' ' + p[0];
    }
    Promise.all([
      fetch('/data/work_permits.json', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); }),
      fetch('/data/visa_meta.json', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
    ]).then(function (out) {
      var rows = out[0], meta = out[1];
      if (meta && status) status.textContent = meta.ok ? 'OK' : 'Degraded';
      if (!Array.isArray(rows) || !rows.length) return;
      var latest = rows.reduce(function (a, r) {
        return r && r.run_date && r.run_date > a ? r.run_date : a;
      }, '');
      if (asOf && longDate(latest)) {
        asOf.textContent = longDate(latest);
        asOf.setAttribute('datetime', latest);
      }
      rows.forEach(function (r) {
        if (!r || r.run_date !== latest) return;
        var cat = r.category;
        var d = document.querySelector('[data-perm-date="' + cat + '"]');
        var l = document.querySelector('[data-perm-lag="' + cat + '"]');
        if (d && longDate(r.processing_date)) d.textContent = longDate(r.processing_date);
        if (l && typeof r.lag_days === 'number') {
          var txt = r.lag_days + ' days';
          if (typeof r.lag_weeks === 'number') {
            txt += ' (about ' + r.lag_weeks.toFixed(1) + ' weeks)';
          }
          l.textContent = txt;
        }
      });
    }).catch(function () { /* static figures remain */ });
  })();
