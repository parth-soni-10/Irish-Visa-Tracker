/* Filter Disclosure — one funnel button, one single-select choice panel.
 *
 *   FilterDisclosure.mount(host, {
 *     label: 'Filter by status',
 *     value: 'all',
 *     defaultId: 'all',
 *     size: 'sm',                       // sm | md | lg
 *     head: 'Show',                     // optional panel heading
 *     choices: [
 *       { id: 'all',    label: 'All modules', icon: 'grid',  hint: 42 },
 *       { id: 'failed', label: 'Failed',      glyph: 'alert', hint: 3 }
 *     ],
 *     showValue: true,                  // optional: name the active choice beside it
 *     onChange: function (id, choice) { ... }
 *   });
 *
 * The trigger is a round funnel. Once the choice is not the default, a badge
 * in its corner shows the active choice's icon, so the control says both "this
 * filters" and "to what" without a label eating the toolbar. Pressing it opens
 * a panel of choices: icon, label, an optional count, and a check circle on the
 * right that only the active row fills. Choosing one closes the panel, puts
 * focus back on the trigger and calls onChange once.
 *
 * Keyboard: the trigger opens on Enter/Space/ArrowDown/ArrowUp; arrows walk
 * the choices, Home/End jump, a letter jumps to the next choice starting with
 * it, Enter/Space choose, Escape closes and returns focus, Tab closes and lets
 * the page continue.
 *
 * `mount()` is idempotent per host: mounting again replaces the previous
 * instance, which is what a host that rebuilds its toolbar can rely on.
 * `setChoices()` keeps the current value when it still exists, so a host can
 * refresh counts without losing the reader's filter.
 *
 * CSP-safe: no injected stylesheet, no network, no event-handler attributes.
 * It only writes classes, attributes and CSS custom properties.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var NS = 'http://www.w3.org/2000/svg';
  var seq = 0;
  var openState = null; // one panel at a time, page-wide
  var STATE = '__fdState';

  /* A small drawn set, in the Feather/Lucide idiom (24x24, stroked). Hosts can
     also pass `icon` as an SVG path string, or a function returning an <svg>. */
  var ICONS = {
    funnel: ['M3 5h18l-7.2 8.2V19l-3.6 2v-7.8z'],
    grid: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z'],
    list: ['M9 6h12', 'M9 12h12', 'M9 18h12', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
    check: ['M20 6L9 17l-5-5'],
    x: ['M18 6L6 18', 'M6 6l12 12'],
    clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5.2l3.2 1.9'],
    calendar: ['M5 5h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M4 10h16', 'M8 3v4', 'M16 3v4'],
    alert: ['M12 3.2 21 19H3z', 'M12 9.4v4.4', 'M12 17h.01'],
    film: ['M3 5h18v14H3z', 'M7 5v14', 'M17 5v14', 'M3 9h4', 'M17 9h4', 'M3 15h4', 'M17 15h4'],
    tv: ['M3 7h18v11H3z', 'M8 21h8', 'M12 18v3'],
    star: ['M12 3.5l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17.5l-5.4 2.9 1-6.1L3.2 10l6.1-.9z'],
    chart: ['M3 17l6-6 4 4 8-8', 'M15 7h6v6'],
    tag: ['M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0l-7-7A2 2 0 0 1 3 12.2V5a2 2 0 0 1 2-2h7.2a2 2 0 0 1 1.4.6l7 7a2 2 0 0 1 0 2.8z', 'M7.5 7.5h.01'],
    flag: ['M5 21V4h8l1 2h6v9h-7l-1-2H5'],
    person: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
    pin: ['M12 21.5s7-6.4 7-11.3A7 7 0 1 0 5 10.2c0 4.9 7 11.3 7 11.3z', 'M12 12.3a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'],
    card: ['M3 6h18v12H3z', 'M3 10h18', 'M7 15h4'],
    book: ['M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z', 'M20 18H6.5'],
    globe: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M3.6 9h16.8', 'M3.6 15h16.8', 'M12 3c2.5 2.4 3.8 5.4 3.8 9S14.5 18.6 12 21c-2.5-2.4-3.8-5.4-3.8-9S9.5 5.4 12 3z']
  };

  function svgIcon(name, cls) {
    var svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (cls) svg.setAttribute('class', cls);
    var paths = ICONS[name] || ICONS.grid;
    paths.forEach(function (d) {
      var p = doc.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    return svg;
  }

  // `glyph` is the name in this kit's own set (grid, list, alert, …); `icon` is
  // accepted as the same thing for symmetry with the other kits. Hosts that keep
  // an icon map of their own should use `glyph`, so a tool that checks their map
  // does not mistake a kit name for one of theirs.
  function iconNode(choice, cls) {
    var spec = choice ? (choice.glyph !== undefined ? choice.glyph : choice.icon) : null;
    if (typeof spec === 'function') {
      var made = spec();
      if (made) {
        if (!made.getAttribute('aria-hidden')) made.setAttribute('aria-hidden', 'true');
        if (cls && !made.getAttribute('class')) made.setAttribute('class', cls);
        return made;
      }
    }
    if (typeof spec === 'string' && spec.length > 2 && spec.indexOf('M') === 0) {
      var svg = svgIcon('grid', cls);
      svg.textContent = '';
      var p = doc.createElementNS(NS, 'path');
      p.setAttribute('d', spec);
      svg.appendChild(p);
      return svg;
    }
    return svgIcon((typeof spec === 'string' && spec) || 'grid', cls);
  }

  function makeEl(tag, cls, text) {
    var el = doc.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  // The panel lives on <body>, so it cannot inherit the trigger's tokens by
  // cascade. These are copied off the trigger when it opens; the base names are
  // the second fallback each hook reads, so they travel too and a dark card's
  // remap reaches the panel, not just the button.
  var TOKENS = [
    '--fd-card', '--fd-ink', '--fd-muted', '--fd-line', '--fd-hover', '--fd-bg',
    '--fd-accent', '--fd-accent-soft', '--fd-ring',
    '--card', '--ink', '--muted', '--line', '--bg-deep', '--accent', '--accent-soft'
  ];

  function inheritTokens(panel, trigger) {
    var cs = global.getComputedStyle(trigger);
    TOKENS.forEach(function (name) {
      var value = cs.getPropertyValue(name);
      if (value && value.trim()) panel.style.setProperty(name, value.trim());
    });
  }

  function reduced() {
    return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function indexOfId(choices, id) {
    for (var i = 0; i < choices.length; i++) if (choices[i].id === id) return i;
    return -1;
  }

  function position(state) {
    var panel = state.panel;
    var trigger = state.trigger;
    if (!panel || !trigger) return;
    var r = trigger.getBoundingClientRect();
    var w = panel.offsetWidth;
    var h = panel.offsetHeight;
    var pad = 8;
    var gap = 8;
    var vh = global.innerHeight || doc.documentElement.clientHeight;
    var vw = global.innerWidth || doc.documentElement.clientWidth;
    var below = r.bottom + gap;
    var above = r.top - gap - h;
    var top;
    var side;
    if (below + h <= vh - pad || above < pad) {
      top = Math.min(below, Math.max(pad, vh - pad - h));
      side = 'bottom';
    } else {
      top = Math.max(pad, above);
      side = 'top';
    }
    // The trigger is round, so its left edge is the honest anchor; a panel that
    // would hang off the right of the viewport slides back until it fits.
    var left = r.left;
    left = Math.min(Math.max(pad, left), Math.max(pad, vw - pad - w));
    panel.style.setProperty('--fd-x', Math.round(left) + 'px');
    panel.style.setProperty('--fd-y', Math.round(top) + 'px');
    panel.setAttribute('data-fd-side', side);
  }

  function nameFor(state) {
    var choice = state.choices[indexOfId(state.choices, state.value)];
    return choice ? state.cfg.label + ', currently ' + choice.label : state.cfg.label;
  }

  function paint(state) {
    var choice = state.choices[indexOfId(state.choices, state.value)];
    state.trigger.setAttribute('aria-label', nameFor(state));
    state.trigger.setAttribute('title', nameFor(state));
    if (state.badge) {
      state.badge.remove();
      state.badge = null;
    }
    var isDefault = state.value === state.defaultId;
    // The badge and the value text say the same thing; when the host asked for
    // the words, the icon would be a second, smaller answer to the same question.
    if (state.cfg.showValue) {
      if (!state.valueEl) {
        state.valueEl = makeEl('span', 'fd-value');
        state.valueEl.setAttribute('aria-hidden', 'true');
        state.root.appendChild(state.valueEl);
      }
      state.valueEl.textContent = isDefault || !choice ? '' : choice.label;
      state.valueEl.hidden = isDefault || !choice;
    }
    if (state.cfg.showBadge !== false && !state.cfg.showValue && choice && !isDefault) {
      var badge = makeEl('span', 'fd-badge');
      badge.setAttribute('aria-hidden', 'true');
      badge.appendChild(iconNode(choice));
      state.root.appendChild(badge);
      state.badge = badge;
    }
    if (state.panel) {
      var items = Array.prototype.slice.call(state.panel.querySelectorAll('.fd-item'));
      var hasChecked = false;
      items.forEach(function (btn) {
        var on = btn.getAttribute('data-fd-id') === state.value;
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
        if (on) hasChecked = true;
      });
      // A roving tab stop: the checked row keeps Tab in the group, and when the
      // value matches nothing (a host refreshed its choices) the first row does.
      items.forEach(function (btn, i) {
        var on = btn.getAttribute('aria-checked') === 'true';
        btn.setAttribute('tabindex', on || (!hasChecked && i === 0) ? '0' : '-1');
      });
    }
  }

  function focusables(panel) {
    return Array.prototype.filter.call(panel.querySelectorAll('.fd-item'), function (el) {
      return !el.disabled;
    });
  }

  function activate(state, btn) {
    var id = btn.getAttribute('data-fd-id');
    var choice = state.choices[indexOfId(state.choices, id)];
    if (!choice) return;
    state.setValue(id);
    if (typeof state.cfg.onChange === 'function') state.cfg.onChange(id, choice);
    // Long enough for the check to land and the badge to swap, short enough
    // that the press still feels like one gesture.
    state.pending = global.setTimeout(function () {
      state.pending = null;
      state.close(true);
    }, reduced() ? 40 : 170);
  }

  function build(state) {
    var panel = makeEl('div', 'fd-panel');
    panel.id = 'fd-panel-' + (++seq);
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', state.cfg.label);
    panel.setAttribute('data-fd-side', 'bottom');

    if (state.cfg.head) {
      var head = makeEl('div', 'fd-head', state.cfg.head);
      head.setAttribute('aria-hidden', 'true');
      panel.appendChild(head);
    }

    state.choices.forEach(function (choice, i) {
      var btn = makeEl('button', 'fd-item');
      btn.type = 'button';
      btn.setAttribute('role', 'menuitemradio');
      btn.setAttribute('aria-checked', choice.id === state.value ? 'true' : 'false');
      btn.setAttribute('data-fd-id', choice.id);
      btn.setAttribute('tabindex', '-1');
      btn.style.setProperty('--fd-i', String(i));
      btn.appendChild(iconNode(choice, 'fd-ico'));
      btn.appendChild(makeEl('span', 'fd-label', choice.label));
      if (choice.hint !== undefined && choice.hint !== null && choice.hint !== '') {
        btn.appendChild(makeEl('span', 'fd-hint', String(choice.hint)));
      }
      var check = makeEl('span', 'fd-check');
      check.setAttribute('aria-hidden', 'true');
      var tick = svgIcon('check');
      check.appendChild(tick);
      btn.appendChild(check);
      btn.addEventListener('click', function () { activate(state, btn); });
      btn.addEventListener('keydown', function (ev) { onItemKey(ev, state, btn); });
      panel.appendChild(btn);
    });
    return panel;
  }

  function onItemKey(ev, state, btn) {
    var k = ev.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      ev.preventDefault();
      var list = focusables(state.panel);
      var i = list.indexOf(btn);
      list[(i + (k === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus();
    } else if (k === 'Home' || k === 'End') {
      ev.preventDefault();
      var all = focusables(state.panel);
      if (all.length) all[k === 'Home' ? 0 : all.length - 1].focus();
    } else if (k === 'Escape') {
      ev.preventDefault();
      state.close(true);
    } else if (k === 'Tab') {
      state.close(false);
    } else if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
      ev.preventDefault();
      activate(state, btn);
    } else if (k && k.length === 1 && /\S/.test(k)) {
      var items = focusables(state.panel);
      var start = items.indexOf(btn) + 1;
      for (var n = 0; n < items.length; n++) {
        var cand = items[(start + n) % items.length];
        var label = cand.querySelector('.fd-label');
        if ((label ? label.textContent : cand.textContent).trim().toLowerCase().indexOf(k.toLowerCase()) === 0) {
          cand.focus();
          break;
        }
      }
    }
  }

  function mount(host, options) {
    if (!host) throw new Error('FilterDisclosure.mount needs a host element');
    if (host[STATE]) host[STATE].destroy();
    var cfg = Object.assign({
      label: 'Filter',
      value: null,
      defaultId: null,
      size: 'md',
      head: '',
      showBadge: true,
      onChange: null
    }, options || {});
    var choices = (cfg.choices || []).slice();
    if (!choices.length) throw new Error('FilterDisclosure.mount needs at least one choice');
    var defaultId = cfg.defaultId === null ? choices[0].id : cfg.defaultId;
    var value = cfg.value === null || indexOfId(choices, cfg.value) < 0 ? defaultId : cfg.value;

    var state = {
      host: host,
      cfg: cfg,
      choices: choices,
      defaultId: defaultId,
      value: value,
      panel: null,
      badge: null,
      open: false,
      pending: null
    };

    var root = makeEl('span', 'fd' + (cfg.size === 'sm' ? ' fd--sm' : cfg.size === 'lg' ? ' fd--lg' : ''));
    var trigger = makeEl('button', 'fd-trigger');
    trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.appendChild(svgIcon('funnel', 'fd-funnel'));
    root.appendChild(trigger);
    host.appendChild(root);

    state.root = root;
    state.trigger = trigger;

    function onTriggerKey(ev) {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (!state.open) state.openPanel(true);
      }
    }
    function onDocDown(ev) {
      if (!state.open) return;
      if (state.panel && (state.panel.contains(ev.target) || trigger.contains(ev.target))) return;
      state.close(false);
    }
    function onDocKey(ev) {
      if (ev.key === 'Escape' && state.open) {
        ev.preventDefault();
        state.close(true);
      }
    }
    function onReflow() {
      if (state.open) position(state);
    }

    state.openPanel = function (focusChecked) {
      if (state.open) return;
      if (openState && openState !== state) openState.close(false);
      var panel = build(state);
      inheritTokens(panel, trigger);
      doc.body.appendChild(panel);
      state.panel = panel;
      state.open = true;
      openState = state;
      trigger.setAttribute('aria-controls', panel.id);
      trigger.setAttribute('aria-expanded', 'true');
      paint(state);
      position(state);
      doc.addEventListener('pointerdown', onDocDown, true);
      doc.addEventListener('keydown', onDocKey, true);
      global.addEventListener('resize', onReflow);
      global.addEventListener('scroll', onReflow, true);
      if (focusChecked) {
        var on = panel.querySelector('.fd-item[aria-checked="true"]') || panel.querySelector('.fd-item');
        if (on) on.focus();
      }
    };

    state.close = function (returnFocus) {
      if (!state.open) return;
      if (state.pending) {
        global.clearTimeout(state.pending);
        state.pending = null;
      }
      doc.removeEventListener('pointerdown', onDocDown, true);
      doc.removeEventListener('keydown', onDocKey, true);
      global.removeEventListener('resize', onReflow);
      global.removeEventListener('scroll', onReflow, true);
      if (state.panel) state.panel.remove();
      state.panel = null;
      state.open = false;
      if (openState === state) openState = null;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-controls');
      if (returnFocus && trigger.isConnected) trigger.focus();
    };

    state.setValue = function (id, opts) {
      if (indexOfId(state.choices, id) < 0) return;
      state.value = id;
      paint(state);
      if (opts && opts.silent) return;
    };

    state.setChoices = function (list, opts) {
      state.choices = (list || []).slice();
      if (indexOfId(state.choices, state.value) < 0) state.value = state.defaultId;
      if (state.open) {
        state.close(false);
        state.openPanel(true);
      } else {
        paint(state);
      }
      if (opts && opts.onChange && indexOfId(state.choices, state.value) >= 0) {
        opts.onChange(state.value);
      }
    };

    state.destroy = function () {
      state.close(false);
      trigger.removeEventListener('click', onClick);
      trigger.removeEventListener('keydown', onTriggerKey);
      if (root.parentNode) root.remove();
      delete host[STATE];
    };

    function onClick(ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (state.open) state.close(true);
      else state.openPanel(true);
    }

    trigger.addEventListener('click', onClick);
    trigger.addEventListener('keydown', onTriggerKey);
    host[STATE] = state;
    paint(state);
    return state;
  }

  function closeOpen() {
    if (openState) openState.close(false);
  }

  global.FilterDisclosure = {
    mount: mount,
    close: closeOpen,
    icons: ICONS,
    get current() { return openState; }
  };

  doc.addEventListener('visibilitychange', function () {
    if (doc.hidden) closeOpen();
  });
})(typeof window !== 'undefined' ? window : this);
