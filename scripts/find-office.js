/* Country/category office finder. Static page, public data, no application
   number and no server call beyond the two public JSON files. */
(function () {
  var COUNTRY_OFFICE = {
    india: 'new-delhi', bangladesh: 'new-delhi', nepal: 'new-delhi', 'sri-lanka': 'new-delhi',
    china: 'beijing', 'hong-kong': 'beijing', macau: 'beijing', mongolia: 'beijing',
    uae: 'abu-dhabi', qatar: 'abu-dhabi', bahrain: 'abu-dhabi', kuwait: 'abu-dhabi', oman: 'abu-dhabi',
    nigeria: 'abuja', ghana: 'abuja', 'cote-divoire': 'abuja', senegal: 'abuja',
    turkiye: 'ankara', azerbaijan: 'ankara', 'saudi-arabia': 'ankara',
    pakistan: 'dublin'
  };
  var OFFICE = {
    'new-delhi': { name: 'New Delhi', route: '/new-delhi-visa-decisions' },
    beijing: { name: 'Beijing', route: '/beijing-visa-decisions' },
    'abu-dhabi': { name: 'Abu Dhabi', route: '/abu-dhabi-visa-decisions' },
    abuja: { name: 'Abuja', route: '/abuja-visa-decisions' },
    ankara: { name: 'Ankara', route: '/ankara-visa-decisions' },
    dublin: { name: 'Dublin', route: '/dublin-visa-decisions' }
  };
  var CATEGORY = {
    study: 'Study (Stamp 2 / 2A)',
    work: 'Work (employment / critical skills)',
    family: 'Join family / dependant',
    visit: 'Short stay / visit',
    transit: 'Transit',
    other: 'Other or not sure'
  };
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }
  function longDate(value) {
    var match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
    if (!match) return '';
    var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
      'August', 'September', 'October', 'November', 'December'];
    return Number(match[3]) + ' ' + months[Number(match[2]) - 1] + ' ' + match[1];
  }
  function daysSince(value) {
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return null;
    var then = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    var now = new Date();
    var today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return Math.round((today - then) / 86400000);
  }
  function loadData() {
    return Promise.all([
      fetch('/data/data_manifest.json', { cache: 'no-store' }).then(function (response) {
        return response.ok ? response.json() : null;
      }).catch(function () { return null; }),
      fetch('/data/freshness.json', { cache: 'no-store' }).then(function (response) {
        return response.ok ? response.json() : null;
      }).catch(function () { return null; })
    ]);
  }
  function categoryNote(category) {
    if (category === 'study') return 'Study applications usually require an offer letter, fee evidence and funds. The visa is not a registration or a residence permission.';
    if (category === 'work') return 'Work applications usually depend on an employment permit and the employer’s documents. Check the permit type before relying on a visa timeline.';
    if (category === 'family') return 'Join-family and dependant applications can be transferred between offices; the receipt is the first place to check.';
    if (category === 'visit') return 'Short-stay applications are decided on the documents supplied and are not a route to residence or work.';
    if (category === 'transit') return 'Transit rules depend on the route, the airline and whether you pass through border control. Check the official transit guidance.';
    return 'The category on your receipt controls the documents and the office. If it is unclear, use the office on the receipt.';
  }
  function init() {
    var form = document.getElementById('office-finder');
    var out = document.getElementById('office-finder-result');
    if (!form || !out) return;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var country = form.elements.country.value;
      var category = form.elements.category.value;
      var applied = form.elements.applied.value;
      if (!country || !category) {
        out.textContent = 'Choose a country and a visa category first.';
        return;
      }
      var slug = COUNTRY_OFFICE[country] || '';
      out.textContent = 'Checking the public office metadata…';
      loadData().then(function (payloads) {
        var manifest = payloads[0] || {};
        var freshness = payloads[1] || {};
        var offices = {};
        ((manifest && manifest.offices) || []).forEach(function (office) {
          if (office && office.slug) offices[office.slug] = office;
        });
        var fresh = {};
        ((freshness && freshness.offices) || []).forEach(function (office) {
          if (office && office.slug) fresh[office.slug] = office;
        });
        var candidate = slug ? OFFICE[slug] : null;
        var meta = slug ? (offices[slug] || {}) : {};
        var state = slug ? (fresh[slug] || {}) : {};
        var reportDate = state.report_date || meta.report_date || '';
        var checked = state.last_success_label || state.last_success_at || '';
        var days = daysSince(applied);
        var html = '<div class="office-finder-card">' +
          '<h2>Likely office: <a href="' + esc(candidate ? candidate.route : '/irish-visa-decisions-today') + '">' +
          esc(candidate ? candidate.name : 'All six offices') + '</a></h2>' +
          '<p><strong>Country:</strong> ' + esc(form.elements.country.options[form.elements.country.selectedIndex].text) +
          ' &middot; <strong>Category:</strong> ' + esc(CATEGORY[category] || category) + '</p>' +
          '<p><strong>Latest published file:</strong> ' + (reportDate ? esc(longDate(reportDate)) : 'Not recorded') +
          (checked ? ' &middot; <strong>Last successful check:</strong> ' + esc(checked) : '') + '</p>' +
          (days != null ? '<p><strong>Days since the application date you entered:</strong> ' + days + '. This is arithmetic; the public file does not publish a decision window for an individual application.</p>' : '') +
          '<p>' + esc(categoryNote(category)) + '</p>';
        if (!slug) {
          html += '<p><strong>No single office is listed for that country.</strong> The application may be handled by the embassy or consulate nearest you. Check the receipt first, then <a href="/missing-decision">search all six offices</a>.</p>';
        } else if (country === 'saudi-arabia') {
          html += '<p class="small-note">Saudi Arabia is listed under Ankara for residents in the tracker’s coverage. The office on the receipt is the authority.</p>';
        }
        html += '<p class="small-note">This is a guide to the public coverage, not a prediction and not a status check. Do not use it to miss an appeal or document deadline.</p>' +
          '<p class="page-nav"><a href="' + esc(candidate ? candidate.route : '/irish-visa-decisions-today') + '">Open the office page</a>' +
          ' &middot; <a href="https://www.irishimmigration.ie/visa-offices/" rel="noopener">ISD visa offices</a>' +
          ' &middot; <a href="/visa-processing-times">Processing times</a></p></div>';
        out.innerHTML = html;
      }).catch(function () {
        out.textContent = 'The public office metadata could not be loaded. Open the office page or check Data status.';
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
