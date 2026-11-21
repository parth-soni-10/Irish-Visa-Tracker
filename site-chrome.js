(function () {
  'use strict';

  var THEME_KEY = 'visa-theme';
  var menus = Array.prototype.slice.call(
    document.querySelectorAll('details.sitebar-more, details.sitebar-prefs, details.sitebar-mobile')
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
    // One theme choice for the whole site. The dashboard applies its own
    // scoped theme from this same preference; every other page uses the
    // shared dark palette in pages.css / monthly-report.css.
    applyTheme(readTheme(), false);
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function () {
        var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(THEME_KEY, next); } catch (error) { /* private mode */ }
        applyTheme(next, true);
      });
    }
  }

  initTheme();
})();
