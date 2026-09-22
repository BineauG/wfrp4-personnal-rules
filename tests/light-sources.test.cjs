const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ID = 'wfrp4-personnal-rules';
const code = fs.readFileSync(path.join(__dirname, '../scripts/light-sources.js'), 'utf8');

function harness() {
  const events = new Map(), errors = [], module = { api: {} };
  const actor = { uuid: 'Actor.hero', isOwner: true };
  const item = {
    id: 'torch', uuid: actor.uuid + '.Item.torch', actor, type: 'trapping', isOwner: true,
    system: { quantity: { value: 1 } },
    flags: { [ID]: { lightSource: { enabled: true, bright: 3, dim: 6 } } },
    getFlag(ns, key) { return this.flags[ns]?.[key]; },
    async setFlag(ns, key, value) { (this.flags[ns] ||= {})[key] = value; }
  };
  const makeToken = (id, owner = actor) => ({
    uuid: 'Scene.scene.Token.' + id, id, actor: owner, flags: {},
    light: { bright: 1, dim: 2, color: '#abcdef', animation: { type: 'torch' } },
    updates: [],
    getFlag(ns, key) { return this.flags[ns]?.[key]; },
    canUserModify() { return true; },
    async update(changes) {
      this.updates.push(changes);
      for (const [key, value] of Object.entries(changes)) {
        if (key === 'light.bright') this.light.bright = value;
        else if (key === 'light.dim') this.light.dim = value;
        else if (key.endsWith('.-=activeLight')) delete this.flags[ID]?.activeLight;
        else if (key.endsWith('.activeLight')) (this.flags[ID] ||= {}).activeLight = value;
        else throw Error('unexpected token field: ' + key);
      }
    }
  });
  const token = makeToken('one');
  const scene = { tokens: [token] };
  const env = vm.createContext({
    console,
    Hooks: {
      once(name, cb) { events.set(name, [cb]); },
      on(name, cb) { const list = events.get(name) || []; list.push(cb); events.set(name, list); }
    },
    game: {
      user: { id: 'owner', isGM: true },
      modules: { get: () => module }, scenes: [scene],
      i18n: { localize: key => key }
    },
    canvas: { scene, tokens: { controlled: [] } },
    ui: { notifications: { error: error => errors.push(error) } },
    foundry: { utils: {
      deepClone: structuredClone,
      hasProperty: (o, key) => key.split('.').reduce((v, p) => v?.[p], o) !== undefined
    } }
  });
  vm.runInContext(code, env);
  events.get('ready')[0]();
  const emit = async (name, ...args) => {
    for (const callback of events.get(name) || []) await callback(...args);
  };
  return { env, api: module.api.lightSources, actor, item, token, makeToken, scene, emit, errors };
}

test('lighting applies item radii; extinguishing restores original light without touching colour or animation', async () => {
  const { api, item, token } = harness();
  await api.toggle(item);
  assert.equal(token.light.bright, 3);
  assert.equal(token.light.dim, 6);
  assert.equal(token.getFlag(ID, 'activeLight').itemId, 'torch');
  await api.toggle(item);
  assert.equal(token.light.bright, 1);
  assert.equal(token.light.dim, 2);
  assert.equal(token.light.color, '#abcdef');
  assert.deepEqual(token.light.animation, { type: 'torch' });
  assert.equal(token.getFlag(ID, 'activeLight'), undefined);
});

test('switching sources keeps the initial baseline instead of leaving the previous torch lit', async () => {
  const { api, item, token } = harness();
  const lantern = { ...item, id: 'lantern', flags: { [ID]: { lightSource: { enabled: true, bright: 5, dim: 10 } } } };
  await api.toggle(item);
  await api.toggle(lantern);
  assert.equal(token.light.dim, 10);
  await api.toggle(lantern);
  assert.equal(token.light.dim, 2);
});

test('manual light changes made while lit survive extinguishing', async () => {
  const { api, item, token } = harness();
  await api.toggle(item);
  token.light.bright = 4;
  token.light.color = '#ffffff';
  await api.toggle(item);
  assert.equal(token.light.bright, 4);
  assert.equal(token.light.dim, 2);
  assert.equal(token.light.color, '#ffffff');
});

test('a selected matching token wins; other tokens and prototype stay untouched', async () => {
  const { api, item, token, makeToken, scene, env } = harness();
  const second = makeToken('two');
  scene.tokens.push(second);
  env.canvas.tokens.controlled = [{ document: second }];
  await api.toggle(item);
  assert.equal(second.light.dim, 6);
  assert.equal(token.updates.length, 0);
});

test('ambiguous tokens and absent tokens are rejected before any update', async () => {
  const { api, item, token, makeToken, scene, env } = harness();
  scene.tokens.push(makeToken('two'));
  await assert.rejects(api.toggle(item), /ChooseToken/);
  env.canvas.tokens.controlled = scene.tokens.map(document => ({ document }));
  await assert.rejects(api.toggle(item), /ChooseToken/);
  env.canvas.tokens.controlled = [];
  scene.tokens = [];
  await assert.rejects(api.toggle(item), /NoToken/);
  assert.equal(token.updates.length, 0);
});

test('another actors selected token is never modified; synthetic actor tokens work', async () => {
  const { api, item, actor, token, makeToken, env } = harness();
  const foreign = makeToken('foreign', { uuid: 'Actor.other', isOwner: true });
  env.canvas.tokens.controlled = [{ document: foreign }];
  actor.uuid = 'Scene.scene.Token.one.Actor.hero';
  await api.toggle(item);
  assert.equal(token.light.dim, 6);
  assert.equal(foreign.updates.length, 0);
});

test('players can toggle owned light but cannot configure radii', async () => {
  const { api, item, token, env } = harness();
  env.game.user.isGM = false;
  await api.toggle(item);
  assert.equal(token.light.dim, 6);
  await assert.rejects(api.configure(item, { enabled: true, bright: 100, dim: 100 }), /NoPermission/);
});

test('object and token permissions are checked before lighting', async () => {
  for (const permission of ['item', 'actor', 'token']) {
    const { api, item, actor, token } = harness();
    if (permission === 'item') item.isOwner = false;
    if (permission === 'actor') actor.isOwner = false;
    if (permission === 'token') token.canUserModify = () => false;
    await assert.rejects(api.toggle(item), /NoPermission/);
    assert.equal(token.updates.length, 0);
  }
});

test('configuration validates radii and is stored on the item', async () => {
  const { api, item } = harness();
  for (const [bright, dim] of [[-1, 6], [7, 6], [0, 0], [NaN, 6], [0, Infinity]]) {
    await assert.rejects(api.configure(item, { enabled: true, bright, dim }), /InvalidRange/);
  }
  await api.configure(item, { enabled: true, bright: '2.5', dim: '7.5' });
  assert.equal(api.getConfig(item).bright, 2.5);
  assert.equal(api.getConfig(item).dim, 7.5);
});

test('zero quantity and disabled source cannot be lit', async () => {
  const { api, item, token } = harness();
  item.system.quantity.value = 0;
  await assert.rejects(api.toggle(item), /Empty/);
  item.system.quantity.value = 1;
  item.flags[ID].lightSource.enabled = false;
  await assert.rejects(api.toggle(item), /NotSource/);
  assert.equal(token.updates.length, 0);
});

test('changing an active item radius updates tokens and keeps the original baseline', async () => {
  const { api, item, token, emit } = harness();
  await api.toggle(item);
  await api.configure(item, { enabled: true, bright: 4, dim: 8 });
  await emit('updateItem', item, { flags: { [ID]: { lightSource: {} } } }, {}, 'owner');
  assert.equal(token.light.dim, 8);
  await api.toggle(item);
  assert.equal(token.light.dim, 2);
});

test('intermediate blur-saved ranges preserve active lighting until both radii are usable', async () => {
  const { api, item, token, emit, errors } = harness();
  await api.toggle(item);
  item.flags[ID].lightSource.bright = 9;
  const changes = { flags: { [ID]: { lightSource: {} } } };
  await emit('updateItem', item, changes, {}, 'owner');
  assert.equal(token.light.bright, 3);
  assert.equal(token.light.dim, 6);
  item.flags[ID].lightSource.dim = 12;
  await emit('updateItem', item, changes, {}, 'owner');
  assert.equal(token.light.bright, 9);
  assert.equal(token.light.dim, 12);
  assert.deepEqual(errors, []);
  await api.toggle(item);
  assert.equal(token.light.dim, 2);
});

test('deletion, transfer to zero and disabling restore active light on all matching scenes', async () => {
  for (const action of ['delete', 'empty', 'disable']) {
    const { api, item, actor, token, makeToken, emit, env } = harness();
    await api.toggle(item);
    const other = makeToken('elsewhere', actor);
    other.flags = structuredClone(token.flags);
    other.light.bright = 3; other.light.dim = 6;
    env.game.scenes.push({ tokens: [other] });
    if (action === 'delete') await emit('deleteItem', item, {}, 'owner');
    if (action === 'empty') {
      item.system.quantity.value = 0;
      await emit('updateItem', item, { system: { quantity: { value: 0 } } }, {}, 'owner');
    }
    if (action === 'disable') {
      item.flags[ID].lightSource.enabled = false;
      await emit('updateItem', item, { flags: { [ID]: { lightSource: {} } } }, {}, 'owner');
    }
    assert.equal(token.light.dim, 2, action);
    assert.equal(other.light.dim, 2, action);
  }
});

test('remote and unrelated item updates do not duplicate writes', async () => {
  const { api, item, token, emit } = harness();
  await api.toggle(item);
  await emit('updateItem', item, { name: 'Torch' }, {}, 'owner');
  await emit('updateItem', item, { system: { quantity: { value: 0 } } }, {}, 'other-user');
  assert.equal(token.updates.length, 1);
});

test('rapid toggles are serialized and failed writes leave no stale lighting state', async () => {
  const { api, item, token } = harness();
  await Promise.all([api.toggle(item), api.toggle(item)]);
  assert.equal(token.light.dim, 2);
  const update = token.update;
  token.update = async () => { throw Error('denied'); };
  await assert.rejects(api.toggle(item), /denied/);
  assert.equal(token.getFlag(ID, 'activeLight'), undefined);
  token.update = update;
  await api.toggle(item);
  assert.equal(token.light.dim, 6);
});
