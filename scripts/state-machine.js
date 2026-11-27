/* state-machine.js - explicit states for UI that already had them.
 *
 * Every interactive surface here already moves through a handful of states:
 * the loader overlay is up or down, the status pill is idle, fetching, ready or
 * failed, a switch is on or off, a select menu is open or closed, a destructive
 * button is idle, working, or counting down its undo window. Those states were
 * implicit - spread across class names, booleans, `disabled` and text - so CSS,
 * the page code and a reader each had to re-derive them, and none of them
 * agreed on the names. That is the bug this file removes.
 *
 * The page stays authoritative. Nothing here decides what the app does; it
 * names what the app is doing, in one vocabulary, and projects that onto the
 * DOM so every reader sees the same thing.
 *
 * Two kinds of machine
 *   create()  an explicit machine the app drives with send(event).
 *   mirror()  an observed machine that reads an existing source of truth (a
 *             class, an attribute, a disabled button) and keeps the model in
 *             step with it. send() is refused: the DOM is the truth.
 *
 *   StateMachine.create('upload', {
 *     initial: 'idle',
 *     states: {
 *       idle:    { on: { START: 'sending' } },
 *       sending: { on: { OK: 'done', FAIL: 'error' } },
 *       done:    { on: { RESET: 'idle' } },
 *       error:   { on: { RETRY: 'sending', RESET: 'idle' } }
 *     }
 *   }, host).send('START');
 *
 *   StateMachine.mirror('theme', {
 *     initial: 'light',
 *     states: { light: { on: { TOGGLE: 'dark' } }, dark: { on: { TOGGLE: 'light' } } },
 *     read: function () { return document.documentElement.dataset.theme || 'light'; },
 *     watch: { el: document.documentElement, options: { attributes: true } }
 *   }, host);
 *
 * A transition may also be an object: { target: 'state', guard: fn, action: fn }
 * and a target may be '*' to take the state named by the event detail
 * ({ to: 'data' }), which is how a page/tab machine stays a closed set of
 * states without a transition line per pair.
 *
 * DOM contract (one vocabulary for CSS, tests and agents)
 *   <host data-machine="app theme" data-app-state="ready" data-theme-state="dark">
 *   `data-<key>-state` always exists for the machine's own key; a host carrying
 *   a single machine also gets the generic `data-machine-state`.
 *
 * Events
 *   Every change dispatches a bubbling `machine:change` CustomEvent whose
 *   detail is { name, from, to, event, source, detail, at }.
 *
 * Agent contract
 *   window.StateMachine.snapshot()  -> every machine, its state and its events
 *   window.StateMachine.get(name)   -> one machine
 *   window.StateMachine.from(el)    -> the machine bound to an element
 *
 * The kit's own widgets are adopted automatically (scan/adopt below) so a
 * switch, a select menu and an undo button report their state without the
 * widget having to know this file exists.
 */
(function (global) {
  'use strict';

  if (global.StateMachine && global.StateMachine.version) return;

  var VERSION = '1.0.0';
  var doc = global.document || null;
  var registry = Object.create(null);
  var byHost = typeof WeakMap === 'function' ? new WeakMap() : null;
  var autoCount = 0;
  var AUTO_LIMIT = 200;
  var HISTORY = 12;

  function owns(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function isFn(value) {
    return typeof value === 'function';
  }

  function now() {
    return Date.now ? Date.now() : 0;
  }

  function slug(value) {
    var text = String(value == null ? '' : value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    return text || 'machine';
  }

  function warn(message) {
    if (global.console && global.console.warn) global.console.warn('[state-machine] ' + message);
  }

  function Machine(name, spec, host, observed) {
    this.name = String(name);
    this.spec = spec || {};
    this.key = slug(this.spec.key || this.name);
    this.host = host || null;
    this.observed = !!observed;
    this.states = this.spec.states || {};
    var initial = owns(this.states, this.spec.initial) ? this.spec.initial : Object.keys(this.states)[0];
    this.state = initial || 'unknown';
    this.previous = null;
    this.since = now();
    this.seq = 0;
    this.source = 'init';
    this.trail = [];
    this.observer = null;
    this.ownsBusy = false;

    registry[this.name] = this;
    if (this.host && byHost) byHost.set(this.host, this);
    this.project();
    publish();
  }

  Machine.prototype.definition = function () {
    return this.states[this.state] || {};
  };

  Machine.prototype.busy = function () {
    if (this.definition().busy) return true;
    var declared = this.spec.busy;
    return Array.isArray(declared) && declared.indexOf(this.state) !== -1;
  };

  Machine.prototype.project = function () {
    var host = this.host;
    if (!host || !host.setAttribute) return;

    var names = String(host.getAttribute('data-machine') || '').split(/\s+/).filter(Boolean);
    if (names.indexOf(this.name) === -1) names.push(this.name);
    host.setAttribute('data-machine', names.join(' '));
    host.setAttribute('data-' + this.key + '-state', this.state);
    if (names.length === 1) host.setAttribute('data-machine-state', this.state);
    else host.removeAttribute('data-machine-state');

    if (this.spec.busy !== undefined || this.definition().busy !== undefined) {
      if (this.busy()) {
        host.setAttribute('aria-busy', 'true');
        this.ownsBusy = true;
      } else if (this.ownsBusy) {
        host.removeAttribute('aria-busy');
        this.ownsBusy = false;
      }
    }
  };

  Machine.prototype.enter = function (to, event, detail, source) {
    if (!owns(this.states, to) || to === this.state) return false;

    var from = this.state;
    this.previous = from;
    this.state = to;
    this.since = now();
    this.seq += 1;
    this.source = source;
    this.trail.push({ from: from, to: to, event: event || null, source: source, at: this.since });
    if (this.trail.length > HISTORY) this.trail.shift();

    this.project();

    var definition = this.definition();
    if (isFn(definition.enter)) {
      try {
        definition.enter(detail, this, from);
      } catch (error) {
        if (global.console) global.console.error('[state-machine] ' + this.name + ' enter hook failed', error);
      }
    }
    this.announce(from, event, detail, source);
    return true;
  };

  Machine.prototype.announce = function (from, event, detail, source) {
    if (!this.host || !isFn(global.CustomEvent)) return;
    this.host.dispatchEvent(new global.CustomEvent('machine:change', {
      bubbles: true,
      detail: {
        name: this.name,
        from: from,
        to: this.state,
        event: event || null,
        source: source,
        detail: detail === undefined ? null : detail,
        at: this.since
      }
    }));
  };

  Machine.prototype.send = function (event, detail) {
    if (this.observed) {
      warn('"' + this.name + '" is observed from the DOM; send() is refused');
      return false;
    }

    var rule = (this.definition().on || {})[event];
    if (rule === undefined) {
      if (this.spec.verbose !== false) warn('"' + this.name + '" has no "' + event + '" from "' + this.state + '"');
      return false;
    }

    var target = rule;
    var guard = null;
    var action = null;
    if (rule && typeof rule === 'object') {
      target = rule.target;
      guard = rule.guard;
      action = rule.action;
    }
    if (target === '*') target = detail && (detail.to || detail.state);
    if (isFn(guard) && !guard(detail, this)) return false;
    if (!owns(this.states, target)) {
      warn('"' + this.name + '" has no state "' + target + '"');
      return false;
    }

    var changed = this.enter(target, event, detail, 'send');
    if (changed && isFn(action)) {
      try {
        action(detail, this);
      } catch (error) {
        if (global.console) global.console.error('[state-machine] ' + this.name + ' action failed', error);
      }
    }
    return changed;
  };

  Machine.prototype.can = function (event) {
    return !this.observed && (this.definition().on || {})[event] !== undefined;
  };

  Machine.prototype.is = function (state) {
    return this.state === state;
  };

  Machine.prototype.sync = function (state, detail) {
    if (!this.observed) return false;
    return this.enter(state, null, detail, 'observe');
  };

  Machine.prototype.describe = function () {
    var on = this.definition().on || {};
    return {
      mode: this.observed ? 'observed' : 'explicit',
      state: this.state,
      previous: this.previous,
      attr: 'data-' + this.key + '-state',
      events: Object.keys(on),
      since: this.since,
      seq: this.seq,
      busy: this.busy()
    };
  };

  Machine.prototype.destroy = function () {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    var host = this.host;
    var name = this.name;
    if (host && host.removeAttribute) {
      host.removeAttribute('data-' + this.key + '-state');
      var names = String(host.getAttribute('data-machine') || '')
        .split(/\s+/)
        .filter(function (entry) { return Boolean(entry) && entry !== name; });
      if (names.length) host.setAttribute('data-machine', names.join(' '));
      else {
        host.removeAttribute('data-machine');
        host.removeAttribute('data-machine-state');
      }
      if (this.ownsBusy) host.removeAttribute('aria-busy');
    }
    delete registry[this.name];
    if (byHost && host) byHost.delete(host);
    publish();
  };

  function create(name, spec, host) {
    return new Machine(name, spec, host, false);
  }

  function mirror(name, spec, host) {
    var machine = new Machine(name, spec, host, true);

    function sync() {
      if (!isFn(spec.read)) return;
      var next;
      try {
        next = spec.read(machine);
      } catch (error) {
        if (spec.verbose) warn(name + ' read failed: ' + error.message);
        return;
      }
      if (typeof next === 'string') machine.sync(next, 'dom');
    }

    machine.refresh = sync;

    if (doc && isFn(global.MutationObserver) && spec.watch) {
      var entries = Array.isArray(spec.watch) ? spec.watch : [spec.watch];
      var observer = new global.MutationObserver(sync);
      entries.forEach(function (entry) {
        var el = typeof entry === 'string' ? doc.querySelector(entry) : entry && entry.el;
        if (!el) return;
        var options = (entry && entry.options) || { attributes: true, childList: true, subtree: true, characterData: true };
        observer.observe(el, options);
      });
      machine.observer = observer;
    }

    if (isFn(spec.listen)) {
      try {
        spec.listen(sync, machine);
      } catch (error) {
        warn(name + ' listen failed: ' + error.message);
      }
    }

    sync();
    return machine;
  }

  /* ---- adoption of the shared kit ---------------------------------------- */

  function readToggle(el) {
    var input = el.tagName === 'INPUT'
      ? el
      : (el.querySelector ? el.querySelector('input.squish-switch__input, input[type="checkbox"]') : null);
    if (input) return input.checked ? 'on' : 'off';
    if (el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true') return 'on';
    if (el.getAttribute('data-on') === 'true') return 'on';
    if (el.classList && (el.classList.contains('on') || el.classList.contains('active'))) return 'on';
    return 'off';
  }

  function readMode() {
    var root = doc && doc.documentElement;
    return root && root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function readDisclosure(el) {
    var trigger = (el.querySelector && el.querySelector('[aria-expanded]')) || el;
    return trigger.getAttribute('aria-expanded') === 'true' ? 'open' : 'closed';
  }

  function readUndo(el) {
    var state = el.getAttribute('data-tu-state');
    return state === 'starting' || state === 'counting' ? state : 'idle';
  }

  var TOGGLE = {
    initial: 'off',
    states: {
      off: { on: { TOGGLE: 'on', ON: 'on' } },
      on: { on: { TOGGLE: 'off', OFF: 'off' } }
    },
    read: readToggle
  };

  var MODE = {
    initial: 'light',
    states: {
      light: { on: { TOGGLE: 'dark', DARK: 'dark' } },
      dark: { on: { TOGGLE: 'light', LIGHT: 'light' } }
    },
    read: readMode,
    watch: { el: doc && doc.documentElement, options: { attributes: true, attributeFilter: ['data-theme', 'class'] } }
  };

  var DISCLOSURE = {
    initial: 'closed',
    states: {
      closed: { on: { OPEN: 'open' } },
      open: { on: { CLOSE: 'closed' } }
    },
    read: readDisclosure
  };

  var UNDO = {
    initial: 'idle',
    states: {
      idle: { on: { START: 'starting', ARM: 'counting' } },
      starting: { on: { READY: 'counting', CANCEL: 'idle' } },
      counting: { on: { CANCEL: 'idle', COMMIT: 'idle' } }
    },
    read: readUndo
  };

  var ADAPTERS = [
    { selector: '.squish-switch', base: 'switch', spec: TOGGLE },
    { selector: '.switch-mode', base: 'theme', spec: MODE },
    { selector: '.glide-select', base: 'menu', spec: DISCLOSURE },
    { selector: '.tu-btn', base: 'undo', spec: UNDO }
  ];

  function labelOf(el) {
    return el.getAttribute('data-ss-label')
      || el.getAttribute('aria-label')
      || el.getAttribute('data-tu-label')
      || (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 48);
  }

  function uniqueName(base, el) {
    var name = base;
    var label = labelOf(el);
    if (label) name += ':' + slug(label).slice(0, 32);
    if (!registry[name]) return name;
    var index = 2;
    while (registry[name + '#' + index]) index += 1;
    return name + '#' + index;
  }

  function adopt(root) {
    if (!root || !root.querySelectorAll || autoCount >= AUTO_LIMIT) return 0;
    var adopted = 0;

    ADAPTERS.forEach(function (adapter) {
      var candidates = [];
      if (root.matches && root.matches(adapter.selector)) candidates.push(root);
      var inside = root.querySelectorAll(adapter.selector);
      for (var i = 0; i < inside.length; i++) candidates.push(inside[i]);

      for (var j = 0; j < candidates.length; j++) {
        var el = candidates[j];
        if (autoCount >= AUTO_LIMIT) break;
        if (byHost && byHost.has(el)) continue;
        var machine = mirror(uniqueName(adapter.base, el), adapter.spec, el);
        machine.auto = true;
        autoCount += 1;
        adopted += 1;
      }
    });

    return adopted;
  }

  function prune() {
    Object.keys(registry).forEach(function (name) {
      var machine = registry[name];
      if (machine.auto && machine.host && machine.host.isConnected === false) machine.destroy();
    });
  }

  function publish() {
    if (!doc || !doc.documentElement) return;
    doc.documentElement.setAttribute('data-machines', String(Object.keys(registry).length));
  }

  function watchDom() {
    if (!doc || !isFn(global.MutationObserver)) return;
    var scheduled = false;
    var observer = new global.MutationObserver(function (records) {
      if (scheduled) return;
      scheduled = true;
      var run = function () {
        scheduled = false;
        var added = 0;
        records.forEach(function (record) {
          var nodes = record.addedNodes;
          for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            if (node.nodeType !== 1 || node.childElementCount > 250) continue;
            added += adopt(node);
          }
        });
        if (added) publish();
        prune();
      };
      if (isFn(global.requestAnimationFrame)) global.requestAnimationFrame(run);
      else global.setTimeout(run, 16);
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true });
  }

  function boot() {
    if (!doc) return;
    adopt(doc.documentElement);
    publish();
  }

  global.StateMachine = {
    version: VERSION,
    create: create,
    mirror: mirror,
    adopt: adopt,
    scan: function () {
      var count = adopt(doc && doc.documentElement);
      publish();
      return count;
    },
    get: function (name) {
      return registry[name] || null;
    },
    from: function (el) {
      return el && byHost ? byHost.get(el) || null : null;
    },
    all: function () {
      return Object.keys(registry).map(function (name) { return registry[name]; });
    },
    snapshot: function () {
      var machines = {};
      Object.keys(registry).forEach(function (name) {
        var machine = registry[name];
        if (machine.host && machine.host.isConnected === false) return;
        machines[name] = machine.describe();
      });
      return { version: VERSION, count: Object.keys(machines).length, machines: machines };
    }
  };

  if (doc) {
    if (doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', function () {
        boot();
        watchDom();
      });
    } else {
      boot();
      watchDom();
    }
  }
})(window);
