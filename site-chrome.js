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
      // Keep the current visible label (Light/Dark) in the accessible name so
      // voice-control users can refer to the button by what they see.
      buttons[i].setAttribute('aria-label', dark
        ? 'Dark theme. Switch to light theme.'
        : 'Light theme. Switch to dark theme.');
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

  // Give the content pages the same cover language as the tracker without
  // asking 38 hand-maintained documents to repeat the wrapper. The cover is
  // an enhancement: the heading and lede remain the same elements, in the same
  // reading order, and the page is fully readable if this script never runs.
  function wrapPageCover() {
    if (document.querySelector('.bp-page-cover')) return;
    var main = document.querySelector('main.page');
    var monthly = false;
    if (!main) {
      main = document.querySelector('main.wrap');
      monthly = !!main;
    }
    if (!main) return;

    var children = Array.prototype.slice.call(main.children);
    var head = children.filter(function (node) { return node.tagName === 'H1'; })[0];
    if (!head) return;

    var endClass = monthly ? 'note' : 'page-lede';
    var end = null;
    for (var i = children.indexOf(head); i < children.length; i++) {
      if (children[i].classList && children[i].classList.contains(endClass)) {
        end = children[i];
        break;
      }
    }
    if (!end) end = head;
    var last = children.indexOf(end);
    if (last < 0) return;

    var cover = document.createElement('div');
    cover.className = 'bp-page-cover';
    cover.setAttribute('data-bp-cover', '');
    main.insertBefore(cover, children[0]);
    for (var j = 0; j <= last; j++) cover.appendChild(children[j]);

    var line = document.createElement('div');
    line.className = 'bp-cover-topline';
    line.innerHTML = '<span>Irish Visa Decision Tracker</span><span>Public record</span><span>Independent and unofficial</span>';
    cover.insertBefore(line, cover.firstChild);
  }

  wrapPageCover();
})();
