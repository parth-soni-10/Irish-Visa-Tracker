/* Scroll Island — the index of the tracker that is open.
 *
 * Two layouts, one index. The Embassy tracker paints each tab into #tab-body,
 * and the Stamp 1G and Permits trackers paint their panels as .g1-chart and
 * .readme blocks, so the selector names all three. The page replaces whole
 * subtrees on every tab and tracker switch — including #visa-dash's contents —
 * so the island mounts on <body>, where a repaint cannot delete it, and the
 * kit re-reads the selector when the headings it holds detach.
 *
 * The theme lives on #visa-dash, so it is mirrored onto <body> here; that is
 * the attribute scroll-island-theme.css keys its dark block on.
 */
(function () {
  'use strict';
  if (!window.ScrollIsland) return;

  var dash = document.getElementById('visa-dash');
  function syncTheme() {
    var theme = dash && dash.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    document.body.setAttribute('data-si-theme', theme);
  }
  syncTheme();
  if (dash && window.MutationObserver) {
    new MutationObserver(syncTheme).observe(dash, { attributes: true, attributeFilter: ['data-theme'] });
  }

  ScrollIsland.mount(document.body, {
    label: 'Tracker sections',
    head: 'On this page',
    sections: '#tab-body h3, .g1-chart h3, .readme-title',
    offset: 20
  });
})();
