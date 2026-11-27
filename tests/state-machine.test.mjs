/* The state kernel is the contract CSS, tests and agents read. These pin the
 * parts every site depends on: a transition is atomic and announced, an
 * unknown event changes nothing, a guard can refuse, an observed machine
 * cannot be sent events, and every machine projects onto its host.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../scripts/state-machine.js', import.meta.url), 'utf8');

function host(name) {
  return {
    tagName: 'DIV',
    isConnected: true,
    attrs: Object.create(null),
    events: [],
    setAttribute(key, value) { this.attrs[key] = String(value); },
    getAttribute(key) { return key in this.attrs ? this.attrs[key] : null; },
    removeAttribute(key) { delete this.attrs[key]; },
    dispatchEvent(event) { this.events.push(event); }
  };
}

function boot() {
  const root = host('HTML');
  const document = {
    readyState: 'complete',
    documentElement: root,
    querySelector() { return null; },
    addEventListener() {}
  };
  root.querySelectorAll = () => [];
  root.matches = () => false;

  class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init && init.detail;
    }
  }

  const sandbox = {
    console: { warn() {}, error() {} },
    CustomEvent,
    document,
    Date,
    Object,
    Array,
    String,
    WeakMap,
    setTimeout,
    clearTimeout
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'state-machine.js' });
  return { SM: sandbox.StateMachine, root, CustomEvent };
}

function counter(SM, el) {
  return SM.create('counter', {
    initial: 'zero',
    states: {
      zero: { on: { INC: 'one' } },
      one: { on: { INC: 'many', DEC: 'zero' } },
      many: { on: { RESET: 'zero' } }
    }
  }, el);
}

test('create projects the initial state onto the host', () => {
  const { SM } = boot();
  const el = host();
  const machine = counter(SM, el);

  assert.equal(machine.state, 'zero');
  assert.equal(el.attrs['data-machine'], 'counter');
  assert.equal(el.attrs['data-machine-state'], 'zero');
  assert.equal(el.attrs['data-counter-state'], 'zero');
});

test('send follows the declared transition and announces it', () => {
  const { SM } = boot();
  const el = host();
  const machine = counter(SM, el);

  assert.equal(machine.send('INC'), true);
  assert.equal(machine.state, 'one');
  assert.equal(machine.previous, 'zero');
  assert.equal(el.attrs['data-counter-state'], 'one');

  const change = el.events.at(-1);
  assert.equal(change.type, 'machine:change');
  assert.equal(change.detail.from, 'zero');
  assert.equal(change.detail.to, 'one');
  assert.equal(change.detail.event, 'INC');
  assert.equal(change.detail.source, 'send');
  assert.equal(machine.trail.length, 1);
});

test('an event with no transition changes nothing and returns false', () => {
  const { SM } = boot();
  const el = host();
  const machine = counter(SM, el);

  assert.equal(machine.send('RESET'), false);
  assert.equal(machine.state, 'zero');
  assert.equal(machine.seq, 0);
  assert.equal(el.events.length, 0);
});

test('a guard can refuse a transition', () => {
  const { SM } = boot();
  const el = host();
  let allowed = false;
  const machine = SM.create('guarded', {
    initial: 'closed',
    states: {
      closed: { on: { OPEN: { target: 'open', guard: () => allowed } } },
      open: { on: { CLOSE: 'closed' } }
    }
  }, el);

  assert.equal(machine.send('OPEN'), false);
  assert.equal(machine.state, 'closed');

  allowed = true;
  assert.equal(machine.send('OPEN'), true);
  assert.equal(machine.state, 'open');
});

test('a "*" target takes the state named by the event detail', () => {
  const { SM } = boot();
  const el = host();
  const machine = SM.create('tabs', {
    initial: 'a',
    states: {
      a: { on: { GO: '*' } },
      b: { on: { GO: '*' } },
      c: { on: { GO: '*' } }
    }
  }, el);

  assert.equal(machine.send('GO', { to: 'c' }), true);
  assert.equal(machine.state, 'c');
  assert.equal(machine.send('GO', { to: 'nope' }), false);
  assert.equal(machine.state, 'c');
});

test('a mirrored machine reads its source and refuses send()', () => {
  const { SM } = boot();
  const el = host();
  let lit = false;
  const machine = SM.mirror('lamp', {
    initial: 'off',
    states: {
      off: { on: { ON: 'on' } },
      on: { on: { OFF: 'off' } }
    },
    read: () => (lit ? 'on' : 'off')
  }, el);

  assert.equal(machine.state, 'off');
  lit = true;
  machine.refresh();
  assert.equal(machine.state, 'on');
  assert.equal(machine.observed, true);
  assert.equal(machine.send('OFF'), false);
  assert.equal(machine.state, 'on');
});

test('snapshot reports every machine with its state and events', () => {
  const { SM, root } = boot();
  counter(SM, host());

  const snapshot = SM.snapshot();
  assert.equal(snapshot.version, '1.0.0');
  assert.equal(snapshot.machines.counter.state, 'zero');
  assert.deepEqual(snapshot.machines.counter.events, ['INC']);
  assert.equal(root.attrs['data-machines'], '1');
});

test('destroy removes the machine and its attributes', () => {
  const { SM } = boot();
  const el = host();
  const machine = counter(SM, el);

  machine.destroy();

  assert.equal(SM.get('counter'), null);
  assert.equal(el.attrs['data-machine'], undefined);
  assert.equal(el.attrs['data-counter-state'], undefined);
  assert.equal(el.attrs['data-machine-state'], undefined);
});
