if ('serviceWorker' in navigator) {
  var refreshing = false;
  var hadController = Boolean(navigator.serviceWorker.controller);

  // A new worker takes control immediately. Reload once so an already-open
  // page does not keep running the old deployment's scripts.
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (!hadController || refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
      .then(function (registration) { return registration.update(); })
      .catch(function () {});
  });
}
