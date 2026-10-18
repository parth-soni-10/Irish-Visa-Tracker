/* Theme before first paint.
 *
 * External on purpose: the site sends `script-src 'self'` with no
 * 'unsafe-inline', so an inline one-liner in <head> would be dropped and every
 * visitor would see a light flash before the stored choice applied. Same key
 * the previous app used (`visa-theme`), so an existing visitor keeps their
 * theme.
 */
(function () {
  var stored = null;
  try { stored = localStorage.getItem('visa-theme'); } catch (e) { /* private mode */ }
  var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var theme = stored === 'dark' || stored === 'light' ? stored : prefersDark ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0e1014' : '#ffffff');
})();
