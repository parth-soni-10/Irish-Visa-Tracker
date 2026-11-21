/* Fill the freshness line from the canonical freshness file. The static text
   above is the truth as of this page's last build; this keeps it true after the
   next pipeline run. If the fetch fails, the static values stay - they are
   never replaced by blanks or by an attempt date that was not a success. */
(function () {
  var asOf = document.getElementById('visa-as-of');
  var observed = document.getElementById('visa-observed');
  var checked = document.getElementById('visa-checked');
  var status = document.getElementById('visa-status');
  if (!asOf && !observed && !checked && !status) return;
  var months = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];
  function longDate(iso) {
    var p = String(iso).slice(0, 10).split('-');
    if (p.length !== 3) return null;
    var m = months[Number(p[1]) - 1];
    if (!m) return null;
    return Number(p[2]) + ' ' + m + ' ' + p[0];
  }
  function checkedNode(iso) {
    if (window.IVTimeMode && window.IVTimeMode.newDelhiNode) {
      return window.IVTimeMode.newDelhiNode(iso, 'full');
    }
    var shown = longDate(iso);
    return shown ? shown : '';
  }
  fetch('/data/freshness.json', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
    .then(function (payload) {
      var office = (payload.offices || []).filter(function (item) {
        return item.slug === 'new-delhi';
      })[0];
      if (!office) return;
      var official = longDate(office.report_date);
      if (asOf && official) {
        asOf.textContent = official;
        asOf.setAttribute('datetime', String(office.report_date).slice(0, 10));
      }
      var latest = String(office.latest_decision_date || '').slice(0, 10);
      if (observed && latest) {
        var partial = latest > String(office.report_date || '').slice(0, 10);
        observed.textContent = longDate(latest) +
          (partial ? ' (partial observation; not in the official file)' : '');
      }
      if (checked && office.last_success_at) {
        checked.innerHTML = checkedNode(office.last_success_at);
        checked.setAttribute('datetime', String(office.last_success_at));
      }
      if (status) status.textContent = office.status_label || 'OK';
    })
    .catch(function () { /* static figures remain */ });
})();
