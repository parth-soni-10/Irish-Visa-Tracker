/* Start the search bundle after the page has painted once.
 *
 * The bundle builds the decision index on the main thread. Running it before
 * the first painted frame pushed the largest heading (the LCP element) from
 * about 2.1 s to 2.8 s on a throttled mobile profile, even though the heading
 * itself needs no JavaScript. Two frames of requestAnimationFrame guarantee a
 * paint has happened; the bundle then loads with the same ?v= query as this
 * loader so it is cached exactly like the rest of the build.
 */
(function () {
  var loader = document.currentScript;
  var query = loader && loader.src.indexOf('?') > -1 ? '?' + loader.src.split('?')[1] : '';

  function load() {
    var script = document.createElement('script');
    script.src = '/scripts/app-bundle.js' + query;
    script.defer = true;
    document.body.appendChild(script);
  }

  function afterPaint() {
    requestAnimationFrame(function () {
      requestAnimationFrame(load);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', afterPaint, { once: true });
  } else {
    afterPaint();
  }
})();
