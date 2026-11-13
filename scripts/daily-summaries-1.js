/* Fill the freshness line from the scraper health file. The static text above is the
     truth as of this page's last build; this keeps it true after the next pipeline run.
     If the fetch fails, the static values stay - they are never replaced by blanks. */
  (function () {
    var asOf = document.getElementById('visa-as-of');
    var rows = document.getElementById('visa-rows');
    var status = document.getElementById('visa-status');
    if (!asOf && !rows && !status) return;
    var months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
    function longDate(iso) {
      var p = String(iso).slice(0, 10).split('-');
      if (p.length !== 3) return null;
      var m = months[Number(p[1]) - 1];
      if (!m) return null;
      return Number(p[2]) + ' ' + m + ' ' + p[0];
    }
    fetch('/data/visa_meta.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
      .then(function (meta) {
        var shown = longDate(meta.lastRunAt);
        if (asOf && shown) {
          asOf.textContent = shown;
          asOf.setAttribute('datetime', String(meta.lastRunAt).slice(0, 10));
        }
        if (rows && typeof meta.sheetRows === 'number') {
          rows.textContent = meta.sheetRows.toLocaleString('en-IE');
        }
        if (status) status.textContent = meta.ok ? 'OK' : 'Degraded';
      })
      .catch(function () { /* static figures remain */ });
  })();
