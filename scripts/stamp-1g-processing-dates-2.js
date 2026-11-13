(function () {
  var form = document.getElementById('renewal-planner-form');
  var select = document.getElementById('planner-stamp');
  var expiry = document.getElementById('planner-expiry');
  var out = document.getElementById('renewal-planner-result');
  if (!form || !select || !out) return;
  var queue = null;
  var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  function fmt(iso) {
    var p = String(iso).slice(0, 10).split('-');
    if (p.length !== 3 || !months[Number(p[1]) - 1]) return iso;
    return Number(p[2]) + ' ' + months[Number(p[1]) - 1] + ' ' + p[0];
  }
  function addDays(iso, n) {
    var d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function daysBetween(a, b) {
    return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
  }
  fetch('/data/irp_queues.json', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      queue = data;
      if (!data || !data.categories || !data.categories.length) {
        select.innerHTML = '<option value="">Queue data unavailable</option>';
        return;
      }
      select.innerHTML = data.categories.map(function (c) {
        return '<option value="' + c.stamp + '">' + c.stamp + '</option>';
      }).join('');
    })
    .catch(function () { select.innerHTML = '<option value="">Queue data unavailable</option>'; });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!queue || !queue.categories || !queue.categories.length) {
      out.textContent = 'The current IRP queue could not be loaded. Check the official ISD page.';
      return;
    }
    if (!expiry.value) {
      out.textContent = 'Enter your current IRP expiry date first.';
      return;
    }
    var category = queue.categories.find(function (c) { return c.stamp === select.value; });
    if (!category) return;
    var asOf = queue.as_of || new Date().toISOString().slice(0, 10);
    var lag = Math.max(0, daysBetween(category.received_date, asOf));
    var graceEnds = addDays(expiry.value, 84);
    var projected = addDays(asOf, lag);
    var today = new Date().toISOString().slice(0, 10);
    var html = '<strong>' + category.stamp + '</strong> is currently processing applications received on ' +
      fmt(category.received_date) + ' (a queue lag of about ' + lag + ' days, or ' + (lag / 7).toFixed(1) + ' weeks).<br>' +
      'Submit before <strong>' + fmt(expiry.value) + '</strong> to keep the renewal on time.<br>' +
      'If you apply before it expires, your existing permission can continue for up to 12 weeks after expiry; that grace period ends on <strong>' + fmt(graceEnds) + '</strong>.<br>' +
      'If you submitted today, the published queue points to a decision around <strong>' + fmt(projected) + '</strong>.';
    if (expiry.value < today) {
      html += '<br><strong>This expiry date has already passed.</strong> Check the official ISD guidance for your situation.';
    } else if (projected > expiry.value) {
      html += '<br><strong>Submit as soon as possible:</strong> the current queue is longer than the time left before expiry.';
    }
    out.innerHTML = html;
  });
})();
