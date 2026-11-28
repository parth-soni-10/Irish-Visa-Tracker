/*
 * Reveal the public Telegram links only when the deployment has configured
 * them. URLs come from /api/config, which validates them server-side; this
 * script never invents a bot or channel and never sends application data.
 *
 * Two kinds of link:
 *   [data-public-channel]      the public channel
 *   [data-office-alerts]       t.me/<bot>?start=office_<slug>, one message when
 *                              that office publishes a new decisions file
 */
(function () {
  var channelLinks = document.querySelectorAll('[data-public-channel]');
  var officeLinks = document.querySelectorAll('[data-office-alerts]');

  // status-1.js wants the same config for the channel link. Share one request
  // instead of fetching the same JSON twice on a page that has both scripts.
  window.VisaConfig = window.VisaConfig || {
    load: function () {
      if (!window.__visaConfigPromise) {
        window.__visaConfigPromise = fetch('/api/config', { headers: { Accept: 'application/json' } })
          .then(function (response) { return response.ok ? response.json() : null; })
          .catch(function () { return null; });
      }
      return window.__visaConfigPromise;
    }
  };

  if (!channelLinks.length && !officeLinks.length) return;

  window.VisaConfig.load()
    .then(function (config) {
      var channel = config && typeof config.telegram_channel_url === 'string'
        ? config.telegram_channel_url
        : '';
      if (/^https:\/\/t\.me\/[A-Za-z0-9_]{3,64}\/?$/.test(channel)) {
        channelLinks.forEach(function (link) {
          link.href = channel;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.hidden = false;
        });
      }

      var bot = config && typeof config.telegram_bot_username === 'string'
        ? config.telegram_bot_username
        : '';
      if (!/^[A-Za-z0-9_]{3,64}$/.test(bot)) return;
      officeLinks.forEach(function (link) {
        var office = link.getAttribute('data-office-alerts');
        if (!/^[a-z0-9-]{3,32}$/.test(office)) return;
        link.href = 'https://t.me/' + bot + '?start=office_' + office;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.hidden = false;
      });
    })
    .catch(function () {
      /* A missing config endpoint is not an error: keep the CTAs hidden. */
    });
})();
