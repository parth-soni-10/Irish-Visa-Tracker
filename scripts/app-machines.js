/* Explicit state for the visa tracker's own flows.
 *
 *   tab        search | history | alerts | saved | tools   switchTab()
 *   alerts     unsupported | default | granted | denied    Notification.permission
 *   freshness  unknown | current | stale | error           the landing freshness line
 *
 * The tracker already keeps all three: the active navpill's class, the browser's
 * permission, and the sentence paintHomeFreshness() writes. This file names
 * them so the UI, the tests and an agent read the same states.
 */
(function () {
  'use strict';

  var SM = window.StateMachine;
  if (!SM) return;

  var TABS = ['search', 'history', 'alerts', 'saved', 'tools'];
  var dash = document.getElementById('visa-dash') || document.body;

  function activeTab() {
    var pill = document.querySelector('#visa-dash .navpill.active');
    var name = pill && pill.getAttribute('data-tab');
    return TABS.indexOf(name) === -1 ? 'search' : name;
  }

  /* 1. One tab at a time. switchTab() toggles the class and aria-current. */
  var tabStates = {};
  TABS.forEach(function (name) {
    tabStates[name] = { on: { NAVIGATE: '*' } };
  });

  SM.mirror('tab', {
    initial: activeTab(),
    states: tabStates,
    read: activeTab,
    listen: function (sync) {
      new MutationObserver(sync).observe(dash, {
        attributes: true,
        attributeFilter: ['class'],
        subtree: true
      });
    }
  }, dash);

  /* 2. The alert channel is a permission machine, not a boolean: the browser
        answers 'default' until asked, and never lets the page re-ask after a
        denial. */
  function permission() {
    if (typeof Notification === 'undefined') return 'unsupported';
    var value = Notification.permission;
    return value === 'granted' || value === 'denied' ? value : 'default';
  }

  SM.mirror('alerts', {
    initial: permission(),
    states: {
      unsupported: { on: { ENABLE: 'default' } },
      default: { on: { GRANT: 'granted', DENY: 'denied', BLOCK: 'unsupported' } },
      granted: { on: { REVOKE: 'denied' } },
      denied: { on: { RESET: 'default' } }
    },
    read: permission
  }, dash);

  /* 3. The landing page's freshness line is the page's own summary of the
        stored reports; 'stale' and 'error' are the two states it names. */
  var freshnessEl = document.getElementById('landing-freshness');

  function freshness() {
    if (!freshnessEl) return 'unknown';
    var text = freshnessEl.textContent.trim();
    if (!text) return 'unknown';
    if (/unavailable|failed|could not/i.test(text)) return 'error';
    if (/stale|overdue|behind|out of date/i.test(text)) return 'stale';
    return 'current';
  }

  SM.mirror('freshness', {
    initial: 'unknown',
    states: {
      unknown: { on: { LOAD: 'current', FAIL: 'error' } },
      current: { on: { AGE: 'stale', FAIL: 'error', RESET: 'unknown' } },
      stale: { on: { REFRESH: 'current', FAIL: 'error' } },
      error: { on: { RETRY: 'current', RESET: 'unknown' } }
    },
    read: freshness,
    watch: freshnessEl
      ? { el: freshnessEl, options: { childList: true, characterData: true, subtree: true } }
      : null
  }, freshnessEl || dash);
})();
