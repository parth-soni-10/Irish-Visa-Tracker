(function () {
  'use strict';

  var menus = Array.prototype.slice.call(document.querySelectorAll('details.sitebar-more'));
  if (!menus.length) return;

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
})();
