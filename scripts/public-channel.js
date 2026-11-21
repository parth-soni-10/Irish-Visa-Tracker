/*
 * Reveal the public Telegram channel only when the deployment has configured
 * one. The URL comes from /api/config, which validates it server-side; this
 * script never invents a channel and never sends application data.
 */
(function () {
  var links = document.querySelectorAll('[data-public-channel]');
  if (!links.length) return;

  fetch('/api/config', { headers: { Accept: 'application/json' } })
    .then(function (response) { return response.ok ? response.json() : null; })
    .then(function (config) {
      var url = config && typeof config.telegram_channel_url === 'string'
        ? config.telegram_channel_url
        : '';
      if (!/^https:\/\/t\.me\/[A-Za-z0-9_]{3,64}\/?$/.test(url)) return;
      links.forEach(function (link) {
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.hidden = false;
      });
    })
    .catch(function () {
      /* A missing config endpoint is not an error: keep the CTA hidden. */
    });
})();
