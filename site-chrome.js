(function () {
  'use strict';

  var THEME_KEY = 'visa-theme';
  var menus = Array.prototype.slice.call(
    document.querySelectorAll('details.sitebar-more, details.sitebar-prefs')
  );

  function close(menu, restoreFocus) {
    if (!menu.open) return;
    menu.open = false;
    if (restoreFocus) {
      var summary = menu.querySelector('summary');
      if (summary) summary.focus();
    }
  }

  document.addEventListener('click', function (event) {
    menus.forEach(function (menu) {
      if (menu.open && !menu.contains(event.target)) close(menu, false);
    });
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    menus.forEach(function (menu) {
      if (!menu.open) return;
      event.preventDefault();
      close(menu, true);
    });
  });

  menus.forEach(function (menu) {
    menu.addEventListener('toggle', function () {
      if (!menu.open) return;
      menus.forEach(function (other) {
        if (other !== menu) close(other, false);
      });
    });
  });

  function readTheme() {
    try {
      return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
    } catch (error) {
      return 'light';
    }
  }

  function applyTheme(theme, notify) {
    var dark = theme === 'dark';
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0b1220' : '#ffffff');
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-pressed', dark ? 'true' : 'false');
      buttons[i].setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
      var label = buttons[i].querySelector('[data-theme-label]');
      if (label) label.textContent = dark ? 'Dark' : 'Light';
    }
    if (notify) {
      document.dispatchEvent(new CustomEvent('visa:themechange', { detail: { theme: dark ? 'dark' : 'light' } }));
    }
  }

  function initTheme() {
    // The theme is a dashboard preference. Static trust pages stay in their
    // reading theme so a dark dashboard choice cannot leave half a page dark.
    var canTheme = Boolean(document.getElementById('visa-dash'));
    applyTheme(canTheme ? readTheme() : 'light', false);
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < buttons.length; i++) {
      var row = buttons[i].closest('.sitebar-pref-row');
      if (!canTheme) {
        if (row) row.hidden = true;
        continue;
      }
      buttons[i].addEventListener('click', function () {
        var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(THEME_KEY, next); } catch (error) { /* private mode */ }
        applyTheme(next, true);
      });
    }
  }

  function initLanguage() {
    var select = document.querySelector('[data-language-select]');
    if (!select) return;
    var row = select.closest('[data-language-row]');
    if (typeof window.getAvailableLanguages !== 'function' ||
        typeof window.setLanguage !== 'function') {
      if (row) row.hidden = true;
      return;
    }
    var languages = window.getAvailableLanguages();
    if (!languages.length) {
      if (row) row.hidden = true;
      return;
    }
    select.innerHTML = languages.map(function (language) {
      return '<option value="' + language.code + '">' + language.nativeName + '</option>';
    }).join('');
    if (typeof window.getLanguage === 'function') select.value = window.getLanguage();
    if (row) row.hidden = false;
    select.addEventListener('change', function () {
      if (!window.setLanguage(select.value)) return;
      if (typeof window.translatePage === 'function') window.translatePage();
      select.value = typeof window.getLanguage === 'function' ? window.getLanguage() : select.value;
    });
  }

  initTheme();
  initLanguage();
})();
