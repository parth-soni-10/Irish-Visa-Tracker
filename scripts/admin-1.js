(function () {
    var token = document.getElementById('admin-token');
    var status = document.getElementById('admin-status');
    var panels = {
      health: document.getElementById('admin-health'),
      quality: document.getElementById('admin-quality'),
      metrics: document.getElementById('admin-metrics'),
      errors: document.getElementById('admin-errors')
    };
    token.value = sessionStorage.getItem('admin-token') || '';

    function setStatus(text, kind) {
      status.textContent = text;
      status.className = 'admin-status' + (kind ? ' ' + kind : '');
    }

    function load() {
      var value = token.value.trim();
      if (!value) { setStatus('Enter an admin token first.', 'error'); return; }
      sessionStorage.setItem('admin-token', value);
      setStatus('Loading\u2026');
      var endpoints = ['health', 'quality', 'metrics', 'errors'];
      Promise.all(endpoints.map(function (name) {
        return fetch('/api/admin/' + name, { headers: { Authorization: 'Bearer ' + value } })
          .then(function (r) { return r.json().then(function (body) { return { name: name, ok: r.ok, body: body }; }); })
          .catch(function (e) { return { name: name, ok: false, body: { error: e.message } }; });
      })).then(function (results) {
        var failed = 0;
        results.forEach(function (result) {
          panels[result.name].textContent = JSON.stringify(result.body, null, 2);
          if (!result.ok) failed++;
        });
        setStatus(failed ? failed + ' endpoint(s) failed. Check the token and server logs.' : 'Dashboard loaded.', failed ? 'error' : 'ok');
      });
    }

    function api(path, options) {
      var opts = options || {};
      opts.headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + token.value.trim() });
      return fetch(path, opts);
    }

    document.getElementById('admin-trigger').addEventListener('click', function () {
      var action = document.getElementById('admin-action-status');
      var button = this;
      button.disabled = true;
      action.textContent = 'Dispatching workflow\u2026';
      action.className = 'admin-status';
      api('/api/admin/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embassy: document.getElementById('admin-embassy').value })
      }).then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
        .then(function (result) {
          action.textContent = result.ok ? (result.body.message || 'Dispatched.') : (result.body.error || 'Dispatch failed.');
          action.className = 'admin-status ' + (result.ok ? 'ok' : 'error');
        })
        .catch(function (error) { action.textContent = error.message; action.className = 'admin-status error'; })
        .finally(function () { button.disabled = false; });
    });

    document.getElementById('admin-token-form').addEventListener('submit', function (event) {
      event.preventDefault();
      var result = document.getElementById('admin-token-result');
      var name = document.getElementById('admin-token-name');
      if (!name.value.trim()) return;
      api('/api/admin/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.value.trim(), expiresDays: 90 })
      }).then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
        .then(function (response) {
          result.hidden = false;
          if (!response.ok) { result.textContent = response.body.error || 'Could not create token.'; return; }
          result.textContent = 'Copy this token now; it is shown once:\n\n' + response.body.token;
          name.value = '';
        })
        .catch(function (error) { result.hidden = false; result.textContent = error.message; });
    });

    document.getElementById('admin-refresh').addEventListener('click', load);
    document.getElementById('admin-clear').addEventListener('click', function () {
      sessionStorage.removeItem('admin-token');
      token.value = '';
      Object.keys(panels).forEach(function (key) { panels[key].textContent = 'Not loaded.'; });
      setStatus('Token cleared.');
    });
    if (token.value) load();
  })();
