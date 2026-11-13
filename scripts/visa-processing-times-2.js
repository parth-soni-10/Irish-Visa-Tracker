(function () {
  var box = document.getElementById('dublin-queue-table');
  if (!box) return;
  var plannerForm = document.getElementById('dublin-planner-form');
  var plannerSelect = document.getElementById('dublin-planner-category');
  var plannerTarget = document.getElementById('dublin-planner-target');
  var plannerResult = document.getElementById('dublin-planner-result');
  var queueData = null;
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
  function esc(value) {
    return String(value).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  fetch('/data/dublin_queues.json', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data || !data.categories || !data.categories.length) {
        box.innerHTML = '<p class="small-note">Queue data is not available right now.</p>';
        return;
      }
      var asOf = data.as_of || '';
      var asOfEl = document.getElementById('dublin-queue-as-of');
      if (asOfEl) asOfEl.textContent = fmt(asOf);
      var html = '<table style="width:100%;border-collapse:collapse">' +
        '<thead><tr>' +
        '<th style="text-align:left;padding:8px;border-bottom:1px solid #e5e7eb">Category</th>' +
        '<th style="text-align:left;padding:8px;border-bottom:1px solid #e5e7eb">Applications received</th>' +
        '<th style="text-align:left;padding:8px;border-bottom:1px solid #e5e7eb">Queue lag</th>' +
        '</tr></thead><tbody>';
      data.categories.forEach(function (c) {
        var lag = Math.max(0, Math.round((new Date(asOf) - new Date(c.applications_received)) / 86400000));
        html += '<tr>' +
          '<td style="padding:8px;border-bottom:1px solid #f1f5f9">' + esc(c.category) + '</td>' +
          '<td style="padding:8px;border-bottom:1px solid #f1f5f9">' + fmt(c.applications_received) + '</td>' +
          '<td style="padding:8px;border-bottom:1px solid #f1f5f9">' + lag + ' days (~' + (lag / 7).toFixed(1) + ' weeks)</td>' +
          '</tr>';
      });
      box.innerHTML = html + '</tbody></table>';
      queueData = data;
      if (plannerSelect) {
        plannerSelect.innerHTML = '<option value="">Select a category…</option>' +
          data.categories.map(function (c) {
            return '<option value="' + esc(c.category) + '">' + esc(c.category) + '</option>';
          }).join('');
      }
    })
    .catch(function () { box.innerHTML = '<p class="small-note">Queue data could not be loaded.</p>'; });

  if (plannerForm) {
    plannerForm.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!queueData || !queueData.categories || !queueData.categories.length) {
        plannerResult.textContent = 'The current Dublin queue could not be loaded. Check the official ISD page.';
        return;
      }
      var category = queueData.categories.find(function (c) { return c.category === plannerSelect.value; });
      if (!category) {
        plannerResult.textContent = 'Choose a visa category first.';
        return;
      }
      if (!plannerTarget.value) {
        plannerResult.textContent = 'Choose the date you need a decision by.';
        return;
      }
      var asOf = queueData.as_of || new Date().toISOString().slice(0, 10);
      var lag = Math.max(0, daysBetween(category.applications_received, asOf));
      var submitBy = addDays(plannerTarget.value, -lag);
      var today = new Date().toISOString().slice(0, 10);
      var daysFromToday = daysBetween(today, submitBy);
      var html = '<strong>' + esc(category.category) + '</strong> is currently deciding applications received on ' +
        fmt(category.applications_received) + ' — a queue lag of <strong>' + lag + ' days</strong> (about ' +
        (lag / 7).toFixed(1) + ' weeks).<br>To have a decision by <strong>' + fmt(plannerTarget.value) +
        '</strong>, apply by <strong>' + fmt(submitBy) + '</strong>.';
      if (daysFromToday < 0) {
        html += '<br><strong>That date has passed.</strong> Apply as soon as possible and check the official ISD queue.';
      } else {
        html += '<br>That is ' + daysFromToday + ' days from today.';
      }
      plannerResult.innerHTML = html;
    });
  }
})();
