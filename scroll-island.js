/* Scroll Island — the page's index, floating over the page.
 *
 *   ScrollIsland.mount(host, {
 *     label: 'Report sections',            // the pill's accessible name
 *     sections: '#results h2',             // a selector, or [{ el, label }, ...]
 *     scroll: window,                      // or an element that scrolls
 *     offset: 24,                          // px above a heading that counts as "here"
 *     onChange: function (id, section) { ... }
 *   });
 *
 * The pill carries a ring that fills as the page is read and a small index
 * glyph. Pressing it lists the sections the page already has; the row you are
 * in is marked, and choosing another one scrolls to it. The list is built from
 * the document, not from a second copy of the page's own contents: pass a
 * selector and the kit reads the headings, their text and their positions.
 *
 * Nothing is added to the page's history or URL. A floating index is a way
 * around one document, and a host whose hash already means a route (cents.) or
 * a tab (the picker) does not need a second meaning for it.
 *
 * A page that does not scroll does not get a pill: the island marks itself
 * `data-si-idle` and the stylesheet keeps it out of sight, because an index of
 * six sections the reader can already see is furniture.
 *
 * The headings may arrive after the mount (a report that is fetched, a tab that
 * is opened). `refresh()` re-reads the selector, and so does a ResizeObserver
 * on the scroll container — the island is not a snapshot of the first paint.
 *
 * CSP-safe: classes, attributes and CSS custom properties only, written through
 * the CSSOM. No style element, no inline handler, no network.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var NS = 'http://www.w3.org/2000/svg';
  var seq = 0;
  var STATE = '__siState';
  var openState = null; // one panel at a time, page-wide

  var ICON = {
    index: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3.5 6h.01', 'M3.5 12h.01', 'M3.5 18h.01'],
    close: ['M18 6 6 18', 'M6 6l12 12']
  };

  function svg(name, cls) {
    var node = doc.createElementNS(NS, 'svg');
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', 'currentColor');
    node.setAttribute('stroke-width', '1.9');
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
    node.setAttribute('aria-hidden', 'true');
    node.setAttribute('focusable', 'false');
    if (cls) node.setAttribute('class', cls);
    (ICON[name] || ICON.index).forEach(function (d) {
      var path = doc.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      node.appendChild(path);
    });
    return node;
  }

  function el(tag, cls, text) {
    var node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function reduced() {
    return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // A heading in a numbered report reads "04 Turn-by-turn analysis". The number
  // is the page's own business and is already implied by the list's order, so a
  // leading 1–2 digits and their punctuation come off the label.
  function clean(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\d{1,2}\s*[).:\u00b7\-–—]?\s*/, '')
      .trim();
  }

  function labelFor(node) {
    var explicit = node.getAttribute('data-si-label');
    if (explicit) return clean(explicit);
    var heading = node.querySelector ? node.querySelector('h1, h2, h3, [data-si-title]') : null;
    return clean(explicit || (heading || node).textContent);
  }

  // A heading in a panel that is not on screen is not a place the reader can
  // go, so the index leaves it out. That is what keeps a tabbed report's list
  // to the tab that is open.
  function visible(node) {
    return node.getClientRects().length > 0;
  }

  function resolve(container, sections) {
    if (!sections) return [];
    if (typeof sections === 'string') {
      return Array.prototype.map.call(container.querySelectorAll(sections), function (node) {
        return { el: node, label: labelFor(node) };
      }).filter(function (s) { return s.label && visible(s.el); });
    }
    return Array.prototype.map.call(sections, function (item) {
      if (!item) return null;
      // A section may arrive as the element itself (hosts that already hold the
      // nodes, like cents.' own screen renderer) or as { el, label }.
      var node = item.nodeType === 1 ? item : item.el;
      if (!node && typeof item === 'string') node = container.querySelector(item);
      if (!node) return null;
      return { el: node, label: item.label ? clean(item.label) : labelFor(node) };
    }).filter(Boolean);
  }

  function sameList(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i].el !== b[i].el) return false;
    return true;
  }

  function hiddenSection(list) {
    return list.some(function (s) { return !visible(s.el); });
  }

  function scrollRoot(cfg) {
    var node = cfg.scroll;
    if (!node || node === global || node === doc || node === doc.documentElement || node === doc.body) {
      return { el: doc.scrollingElement || doc.documentElement, win: true };
    }
    return { el: node, win: false };
  }

  function metrics(scroller) {
    var node = scroller.el;
    var height = scroller.win ? (global.innerHeight || doc.documentElement.clientHeight) : node.clientHeight;
    var total = node.scrollHeight;
    var top = node.scrollTop || (scroller.win ? (global.pageYOffset || 0) : 0);
    return {
      height: height,
      total: total,
      top: top,
      room: Math.max(0, total - height),
      progress: total > height ? Math.min(1, Math.max(0, top / (total - height))) : 0
    };
  }

  function topOf(node, scroller) {
    if (!scroller.win) {
      var box = node.getBoundingClientRect();
      var frame = scroller.el.getBoundingClientRect();
      return box.top - frame.top + (scroller.el.scrollTop || 0);
    }
    var rect = node.getBoundingClientRect();
    return rect.top + (global.pageYOffset || 0);
  }

  function mount(host, options) {
    if (!host) throw new Error('ScrollIsland.mount needs a host element');
    if (host[STATE]) host[STATE].destroy();
    var cfg = Object.assign({
      label: 'Page sections',
      sections: null,
      container: doc.body,
      scroll: global,
      offset: 28,
      head: 'On this page',
      onChange: null
    }, options || {});
    var scroller = scrollRoot(cfg);
    var uid = 'si' + (++seq);

    var root = el('div', 'si');
    root.setAttribute('data-si-idle', 'true');

    var trigger = el('button', 'si-trigger');
    trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', cfg.label);
    trigger.setAttribute('title', cfg.label);

    var ring = doc.createElementNS(NS, 'svg');
    ring.setAttribute('class', 'si-ring');
    ring.setAttribute('viewBox', '0 0 36 36');
    ring.setAttribute('aria-hidden', 'true');
    ring.setAttribute('focusable', 'false');
    // r = 15.6 gives a circumference of 98.02; the stylesheet reads it as 98 so
    // the dash maths stays legible in one place (--si-ring-length).
    [['si-track', 0], ['si-bar', 1]].forEach(function (pair) {
      var circle = doc.createElementNS(NS, 'circle');
      circle.setAttribute('class', pair[0]);
      circle.setAttribute('cx', '18');
      circle.setAttribute('cy', '18');
      circle.setAttribute('r', '15.6');
      if (pair[1]) circle.setAttribute('transform', 'rotate(-90 18 18)');
      ring.appendChild(circle);
    });
    trigger.appendChild(ring);
    trigger.appendChild(svg('index', 'si-glyph'));

    var panel = el('div', 'si-panel');
    panel.id = uid + '-panel';
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', cfg.label);
    panel.hidden = true;

    var state = {
      host: host,
      cfg: cfg,
      root: root,
      trigger: trigger,
      panel: panel,
      scroller: scroller,
      sections: [],
      items: [],
      current: -1,
      isOpen: false,
      frame: null,
      observer: null
    };

    // ---- reading the page -------------------------------------------------

    function paintProgress() {
      var m = metrics(scroller);
      root.style.setProperty('--si-progress', String(Math.round(m.progress * 1000) / 1000));
      // A page with nothing to scroll has no index to offer. The class is on the
      // root so a host can style the absence (or ignore it) without guessing.
      var idle = m.room < 96 || state.sections.length < 2;
      root.setAttribute('data-si-idle', idle ? 'true' : 'false');
      if (idle && state.isOpen) close(false);
    }

    function currentIndex() {
      var m = metrics(scroller);
      if (m.room - m.top < 4) return state.sections.length - 1; // the end is the last section
      // Two pixels of slack: a chosen section lands at exactly `offset` below
      // the top, and sub-pixel scroll positions make that landing a fraction
      // short — without the slack the row the reader just picked reads as the
      // one above it.
      var line = m.top + cfg.offset + 2;
      var found = 0;
      for (var i = 0; i < state.sections.length; i++) {
        if (topOf(state.sections[i].el, scroller) <= line) found = i;
        else break;
      }
      return found;
    }

    function paintCurrent() {
      if (!state.sections.length) return;
      var next = currentIndex();
      if (next === state.current) return;
      state.current = next;
      state.items.forEach(function (item, i) {
        var on = i === next;
        item.setAttribute('aria-checked', on ? 'true' : 'false');
        item.setAttribute('tabindex', on ? '0' : '-1');
      });
      var section = state.sections[next];
      if (section && typeof cfg.onChange === 'function') cfg.onChange(next, section);
    }

    function measure() {
      state.frame = null;
      // A host that re-renders its page (a fetched report, a filter that swaps
      // the list) replaces the heading nodes the island is holding. The
      // selector is the durable description of the index, so when the nodes it
      // gave us are gone, ask it again — a floating index that points at
      // detached elements is worse than no index.
      if (typeof cfg.sections === 'string' && (state.sections.length === 0
        || state.sections.some(function (s) { return !s.el.isConnected; })
        || hiddenSection(state.sections))) {
        var next = resolve(cfg.container || doc.body, cfg.sections);
        if (!sameList(next, state.sections)) {
          state.sections = next;
          if (state.isOpen) rebuild();
        }
      }
      paintProgress();
      paintCurrent();
    }

    function onScroll() {
      if (state.frame) return;
      state.frame = global.requestAnimationFrame(measure);
    }

    // ---- the list ---------------------------------------------------------

    function buildList() {
      var list = el('ol', 'si-list');
      state.items = [];
      state.sections.forEach(function (section, i) {
        var item = el('button', 'si-item');
        item.type = 'button';
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-checked', 'false');
        item.setAttribute('tabindex', '-1');
        item.setAttribute('data-si-index', String(i));
        item.appendChild(el('span', 'si-dot'));
        item.appendChild(el('span', 'si-label', section.label));
        var mark = el('span', 'si-mark');
        mark.appendChild(svg('index'));
        item.appendChild(mark);
        item.addEventListener('click', function () { go(i); });
        item.addEventListener('keydown', onItemKey);
        list.appendChild(item);
        state.items.push(item);
      });
      return list;
    }

    function head() {
      var bar = el('div', 'si-head');
      bar.appendChild(el('span', 'si-head-label', cfg.head));
      var count = el('span', 'si-count', String(state.sections.length));
      count.setAttribute('aria-hidden', 'true');
      bar.appendChild(count);
      return bar;
    }

    function rebuild() {
      panel.textContent = '';
      state.current = -1;
      if (!state.sections.length) {
        panel.appendChild(el('p', 'si-empty', 'This page has no sections to index yet.'));
        return;
      }
      panel.appendChild(head());
      panel.appendChild(buildList());
      paintCurrent();
    }

    // ---- opening and moving ----------------------------------------------

    // A long page can grow while the smooth scroll is running: Portfolio's
    // live dashboard paints its charts under the fold and pushes every
    // heading below it down 118px. The scroll then stops where the heading
    // used to be, and the reader who picked Credentials is left on Skills —
    // the one miss a floating index cannot afford. So when the scroll comes
    // to rest, if the chosen heading is no longer under `offset`, one silent
    // correction puts it there. Any wheel, touch or key from the reader — or
    // a second pick — cancels it, because by then moving is their call.
    var goTicket = 0;

    function cancelSettle() {
      goTicket++;
      if (state.settleFrame) {
        global.cancelAnimationFrame(state.settleFrame);
        state.settleFrame = null;
      }
      global.removeEventListener('wheel', cancelSettle, true);
      global.removeEventListener('touchstart', cancelSettle, true);
      global.removeEventListener('keydown', cancelSettle, true);
    }

    function settle(el0) {
      cancelSettle();
      var ticket = goTicket;
      var last = metrics(scroller).top;
      var still = 0;
      var until = Date.now() + 1600;

      function finish() {
        if (ticket !== goTicket) return;
        cancelSettle();
        if (!el0.isConnected) return;
        var now = metrics(scroller);
        var want = Math.max(0, Math.min(now.room, topOf(el0, scroller) - cfg.offset));
        if (Math.abs(want - now.top) < 16) return;
        if (scroller.win) global.scrollTo({ top: want, behavior: 'instant' });
        else scroller.el.scrollTo({ top: want, behavior: 'instant' });
        onScroll();
      }

      function tick() {
        if (ticket !== goTicket) return;
        var top = metrics(scroller).top;
        still = Math.abs(top - last) < 1 ? still + 1 : 0;
        last = top;
        if (still >= 3 || Date.now() > until) {
          state.settleFrame = null;
          finish();
          return;
        }
        state.settleFrame = global.requestAnimationFrame(tick);
      }

      state.settleFrame = global.requestAnimationFrame(tick);
      global.addEventListener('wheel', cancelSettle, true);
      global.addEventListener('touchstart', cancelSettle, true);
      global.addEventListener('keydown', cancelSettle, true);
    }

    function go(index) {
      var section = state.sections[index];
      if (!section) return;
      var el0 = section.el;
      var target = Math.max(0, topOf(el0, scroller) - cfg.offset);
      // `auto` is not "no animation": it follows the page's own scroll-behavior,
      // which is `smooth` on several hosts — so a reader who asked for reduced
      // motion would still get the glide. `instant` is the value that says so,
      // and where an engine does not know it, writing scrollTop is instant.
      var behavior = reduced() ? 'instant' : 'smooth';
      try {
        if (scroller.win) global.scrollTo({ top: target, behavior: behavior });
        else scroller.el.scrollTo({ top: target, behavior: behavior });
      } catch (err) {
        if (scroller.win) {
          (doc.scrollingElement || doc.documentElement).scrollTop = target;
        } else {
          scroller.el.scrollTop = target;
        }
      }
      state.current = index;
      state.items.forEach(function (item, i) {
        var on = i === index;
        item.setAttribute('aria-checked', on ? 'true' : 'false');
        item.setAttribute('tabindex', on ? '0' : '-1');
      });
      if (typeof cfg.onChange === 'function') cfg.onChange(index, section);
      // Shut first, then hand focus to the heading. Returning focus to the pill
      // would undo the move the reader just asked for — they chose a place in
      // the page, and Tab should continue from there, not from the corner.
      close(false);
      if (!el0.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(el0.tagName)) {
        el0.setAttribute('tabindex', '-1');
      }
      el0.focus({ preventScroll: true });
      if (behavior === 'smooth') settle(el0);
    }

    function onItemKey(ev) {
      var list = state.items;
      var i = Number(ev.currentTarget.getAttribute('data-si-index'));
      var k = ev.key;
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        ev.preventDefault();
        var next = (i + (k === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
        list[next].focus();
      } else if (k === 'Home' || k === 'End') {
        ev.preventDefault();
        list[k === 'Home' ? 0 : list.length - 1].focus();
      } else if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
        ev.preventDefault();
        go(i);
      } else if (k === 'Escape') {
        ev.preventDefault();
        close(true);
      } else if (k === 'Tab') {
        close(false);
      } else if (k && k.length === 1 && /\S/.test(k)) {
        var start = i + 1;
        for (var n = 0; n < list.length; n++) {
          var cand = list[(start + n) % list.length];
          var label = cand.querySelector('.si-label');
          if ((label ? label.textContent : cand.textContent).trim().toLowerCase().indexOf(k.toLowerCase()) === 0) {
            cand.focus();
            break;
          }
        }
      }
    }

    function onDocDown(ev) {
      if (!state.isOpen) return;
      if (panel.contains(ev.target) || trigger.contains(ev.target)) return;
      close(false);
    }

    function onDocKey(ev) {
      if (ev.key === 'Escape' && state.isOpen) {
        ev.preventDefault();
        close(true);
      }
    }

    function open() {
      if (state.isOpen) return;
      if (openState && openState !== state) openState.close(false);
      rebuild();
      panel.hidden = false;
      state.isOpen = true;
      openState = state;
      root.setAttribute('data-si-open', 'true');
      trigger.setAttribute('aria-expanded', 'true');
      trigger.setAttribute('aria-controls', panel.id);
      doc.addEventListener('pointerdown', onDocDown, true);
      doc.addEventListener('keydown', onDocKey, true);
      var on = panel.querySelector('.si-item[aria-checked="true"]') || panel.querySelector('.si-item');
      if (on) on.focus();
    }

    function close(returnFocus) {
      if (!state.isOpen) return;
      doc.removeEventListener('pointerdown', onDocDown, true);
      doc.removeEventListener('keydown', onDocKey, true);
      panel.hidden = true;
      state.isOpen = false;
      if (openState === state) openState = null;
      root.setAttribute('data-si-open', 'false');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-controls');
      if (returnFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
    }

    function apply(list) {
      state.sections = resolve(cfg.container || doc.body, list === undefined ? cfg.sections : list);
      if (state.isOpen) rebuild();
      measure();
    }

    trigger.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (state.isOpen) close(true);
      else open();
    });

    // The panel is the first child so it opens *above* the pill, which is
    // where a control anchored to the bottom of the viewport has room.
    root.appendChild(panel);
    root.appendChild(trigger);
    host.appendChild(root);

    // ---- lifecycle --------------------------------------------------------

    var scrollTarget = scroller.win ? global : scroller.el;
    scrollTarget.addEventListener('scroll', onScroll, { passive: true });
    global.addEventListener('resize', onScroll, { passive: true });

    // Headings that arrive later (a fetched report, an opened tab) and any
    // reflow that moves them are picked up without the host telling us twice.
    if (global.ResizeObserver) {
      state.observer = new global.ResizeObserver(function () { onScroll(); });
      state.observer.observe(scroller.win ? doc.documentElement : scroller.el);
    }

    // Content that is painted after the mount is the normal case for a report
    // that is fetched or a tab that is opened, so the island watches for the
    // headings to arrive rather than making every host remember to call
    // refresh(). Only the selector form can be re-read: nodes handed in by a
    // host are that host's to replace.
    if (global.MutationObserver && typeof cfg.sections === 'string') {
      state.mutations = new global.MutationObserver(function () { onScroll(); });
      state.mutations.observe(cfg.container || doc.body, { childList: true, subtree: true });
    }

    state.refresh = function (list) { apply(list); };
    state.setSections = function (list) { apply(list); };
    state.open = open;
    state.close = function () { close(true); };
    state.goto = go;
    state.destroy = function () {
      cancelSettle();
      close(false);
      scrollTarget.removeEventListener('scroll', onScroll);
      global.removeEventListener('resize', onScroll);
      if (state.observer) state.observer.disconnect();
      if (state.mutations) state.mutations.disconnect();
      if (state.frame) global.cancelAnimationFrame(state.frame);
      if (root.parentNode) root.remove();
      delete host[STATE];
    };

    host[STATE] = state;
    apply();
    return state;
  }

  function closeOpen() {
    if (openState) openState.close(false);
  }

  global.ScrollIsland = { mount: mount, close: closeOpen };
  doc.addEventListener('visibilitychange', function () {
    if (doc.hidden) closeOpen();
  });
})(typeof window !== 'undefined' ? window : this);
