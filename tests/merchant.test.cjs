const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/main.js'), 'utf8');
const ID = 'wfrp4-personnal-rules';
const getProperty = (o, key) => key.split('.').reduce((v, p) => v?.[p], o);

function environment({ gm = true, automatic = true } = {}) {
  const hooks = new Map(), settings = new Map(), notifications = [], timers = new Map();
  let timerId = 0;
  const user = { id: gm ? 'gm' : 'player', isGM: gm, active: true };
  const users = new Map([['gm', { id: 'gm', isGM: true, active: true }], ['player', { id: 'player', isGM: false, active: true }]]);
  users.activeGM = users.get('gm');
  const env = vm.createContext({
    console,
    Hooks: { once() {}, on(key, cb) { const list = hooks.get(key) || []; list.push(cb); hooks.set(key, list); } },
    game: {
      user, users,
      settings: {
        register(namespace, key, data) { settings.set(key, data); },
        get(namespace, key) { return key === 'autoAvailability' ? automatic : key === 'settlement' ? 'MARKET.Town' : true; }
      },
      i18n: { localize: key => key, format: key => key },
      itempiles: { API: {} }
    },
    ui: { notifications: { error: v => notifications.push(v), info: v => notifications.push(v) } },
    foundry: { utils: { getProperty, hasProperty: (o, k) => getProperty(o, k) !== undefined, deepClone: structuredClone, mergeObject: Object.assign } },
    setTimeout(cb) { timers.set(++timerId, cb); return timerId; },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(source, env);
  return { env, hooks, settings, notifications, timers };
}

function actor(name, merchant = false, entries = []) {
  entries.get = id => entries.find(item => item.id === id);
  return {
    id: name, uuid: 'Actor.' + name, name, documentName: 'Actor', type: 'npc', items: entries,
    flags: { 'item-piles': { data: { enabled: merchant, type: merchant ? 'merchant' : 'pile' } } },
    getFlag(namespace, key) { return this.flags[namespace]?.[key]; },
    async setFlag(namespace, key, value) { (this.flags[namespace] ||= {})[key] = value; }
  };
}

function goods(id, flags = {}) {
  return { id, name: id, type: 'trapping', system: { quantity: { value: 1 } }, flags: { 'item-piles': { item: flags } } };
}

test('global defaults stay hidden and availability chat is not registered', () => {
  const { env, settings } = environment();
  env.registerSettings();
  assert.equal(settings.get('settlement').config, false);
  assert.equal(settings.get('settlement').default, 'MARKET.Town');
  assert.equal(settings.get('availabilityModifier').config, false);
  assert.equal(settings.get('availabilityModifier').default, 0);
  assert.equal(settings.has('chatAvailability'), false);
});

test('mixed basket: no-negotiation trades only that line, once', async () => {
  const { env } = environment();
  const seller = actor('shop', true, [goods('a'), goods('b'), goods('c')]);
  const buyer = actor('buyer');
  const calls = [];
  env.game.itempiles.API.tradeItems = async (s, b, items) => { calls.push(['native', items.map(i => i.item)]); return { ok: true }; };
  env.normalizeTradeItems = (a, items) => items;
  const choices = ['haggle', 'none', 'evaluate'];
  env.promptNegotiationChoice = async () => choices.shift();
  env.rollSkillWithDialog = async () => ({ sl: 1 });
  env.queueMerchantTradeAsGM = async payload => { calls.push(['haggle', [payload.itemId]]); return { ok: true }; };
  env.patchItemPilesTrade();
  const result = await env.game.itempiles.API.tradeItems(seller, buyer, ['a', 'b', 'c'].map(itemId => ({ itemId, quantity: 1, paymentIndex: 0 })));
  assert.equal(result.results.length, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['haggle', ['a']], ['native', ['b']], ['haggle', ['c']]]);
});

test('cancelled line stops the basket without replaying completed lines', async () => {
  const { env } = environment();
  const seller = actor('shop', true, [goods('a'), goods('b')]);
  env.game.itempiles.API.tradeItems = async () => { throw Error('unexpected native trade'); };
  env.normalizeTradeItems = (a, items) => items;
  const choices = ['haggle', null];
  env.promptNegotiationChoice = async () => choices.shift();
  env.rollSkillWithDialog = async () => ({ sl: 1 });
  let count = 0;
  env.queueMerchantTradeAsGM = async () => { count++; return { ok: true }; };
  env.patchItemPilesTrade();
  assert.equal(await env.game.itempiles.API.tradeItems(seller, actor('buyer'), ['a', 'b'].map(itemId => ({ itemId, paymentIndex: 0 }))), false);
  assert.equal(count, 1);
});

test('services, alternative prices, macros and logs stay native; basic goods still haggle', async () => {
  const { env } = environment();
  for (const flags of [{ isService: true }, { macro: 'Macro.x' }, { prices: [[{ cost: 2 }]] }, { sellPrices: [[{ cost: 2 }]] }, { overheadCost: [{}] }]) {
    const seller = actor('shop', true, [goods('a', flags)]);
    assert.equal(env.requiresNativeTrade(seller, actor('buyer'), [{ itemId: 'a', paymentIndex: 0 }]), true);
  }
  const seller = actor('shop', true, [goods('a')]), buyer = actor('buyer');
  assert.equal(env.requiresNativeTrade(seller, buyer, [{ itemId: 'a', paymentIndex: 0 }]), false);
  assert.equal(env.requiresNativeTrade(seller, buyer, [{ itemId: 'a', paymentIndex: 1 }]), true);
  seller.flags['item-piles'].data.logMerchantActivity = true;
  assert.equal(env.requiresNativeTrade(seller, buyer, [{ itemId: 'a', paymentIndex: 0 }]), true);
  let nativeCalls = 0;
  const basket = [{ itemId: 'a', paymentIndex: 0 }];
  env.game.itempiles.API.tradeItems = async (s, b, entries) => { assert.equal(entries, basket); nativeCalls++; return { ok: true }; };
  env.normalizeTradeItems = (a, items) => items;
  env.promptNegotiationChoice = async () => { throw Error('should not haggle'); };
  env.patchItemPilesTrade();
  await env.game.itempiles.API.tradeItems(seller, buyer, basket);
  assert.equal(nativeCalls, 1);
});

test('GM queue awaits real completion and serializes requests', async () => {
  const { env } = environment();
  const events = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  env.executeMerchantTradeAsGM = async p => { events.push('start' + p.id); if (p.id === 1) await gate; events.push('end' + p.id); return { ok: true, id: p.id }; };
  const first = env.queueMerchantTradeAsGM({ id: 1 });
  const second = env.queueMerchantTradeAsGM({ id: 2 });
  let completed = false;
  first.then(() => { completed = true; });
  await new Promise(setImmediate);
  assert.equal(completed, false);
  assert.deepEqual(events, ['start1']);
  release();
  assert.equal((await first).id, 1);
  assert.equal((await second).id, 2);
  assert.deepEqual(events, ['start1', 'end1', 'start2', 'end2']);
});

test('cancel and failure notify requester and do not poison the queue', async () => {
  const { env } = environment();
  const errors = [];
  env.whisperTradeError = async (p, error) => errors.push(error.message);
  env.executeMerchantTradeAsGM = async p => { if (p.id === 1) return false; if (p.id === 2) throw Error('write failed'); return { ok: true }; };
  assert.equal(await env.queueMerchantTradeAsGM({ id: 1 }), false);
  assert.equal(await env.queueMerchantTradeAsGM({ id: 2 }), false);
  assert.equal((await env.queueMerchantTradeAsGM({ id: 3 })).ok, true);
  assert.equal(errors.length, 2);
});

test('price comes from native Item Piles including its matching merchant item modifiers', () => {
  const { env } = environment();
  const merchant = actor('shop', true), player = actor('player'), item = goods('a');
  env.game.itempiles.API.getPricesForItem = (i, options) => {
    assert.equal(i, item); assert.equal(options.seller, player); assert.equal(options.buyer, merchant);
    assert.equal(options.quantity, 3);
    return [{ totalCost: 123 }];
  };
  assert.equal(env.getDisplayedTradePriceBP({ item, merchant, actor: player, mode: 'sell', quantity: 3 }), 123);
});

test('settlement change rerolls all stock even with auto availability disabled', async () => {
  const { env, hooks, timers } = environment({ automatic: false });
  const shop = actor('shop', true);
  let force;
  env.rollAvailabilityForActor = async (a, options) => { assert.equal(a, shop); force = options.force; };
  env.registerAvailabilityHooks();
  hooks.get('updateActor')[0](shop, { flags: { [ID]: { settlement: 'MARKET.City' } } }, {}, 'gm');
  assert.equal(timers.size, 1);
  await [...timers.values()][0]();
  assert.equal(force, true);
});

test('debounce preserves a forced reroll when a new item event follows', async () => {
  const { env, timers } = environment();
  const shop = actor('shop', true);
  let force;
  env.rollAvailabilityForActor = async (a, options) => { force = options.force; };
  env.scheduleAvailabilityRoll(shop, { force: true });
  env.scheduleAvailabilityRoll(shop, { force: false });
  assert.equal(timers.size, 1);
  await [...timers.values()][0]();
  assert.equal(force, true);
});

test('only the initiating GM, or active GM for a player action, rolls availability', () => {
  const { env } = environment();
  env.game.users.set('gm2', { id: 'gm2', active: true, isGM: true });
  assert.equal(env.isAvailabilityAuthority('gm'), true);
  assert.equal(env.isAvailabilityAuthority('gm2'), false);
  assert.equal(env.isAvailabilityAuthority('player'), true);
  env.game.user = env.game.users.get('gm2');
  assert.equal(env.isAvailabilityAuthority('player'), false);
  assert.equal(env.isAvailabilityAuthority('gm2'), true);
});

test('availability updates inventory without creating a chat message', async () => {
  const { env } = environment();
  const shop = actor('shop', true, [goods('a'), goods('b')]);
  env.isAvailabilityItem = () => true;
  env.rollAvailabilityForItem = async item => ({ item: item.name, available: true });
  env.ChatMessage = { create() { throw Error('unexpected chat'); } };
  assert.equal((await env.rollAvailabilityForActor(shop, { force: true })).length, 2);
  assert.ok(shop.getFlag(ID, 'availabilityTested'));
});

test('empty stock does not halve resale price despite old positive availability', () => {
  const { env } = environment();
  const existing = goods('a');
  existing.id = 'stock-a';
  existing.system.quantity.value = 0;
  existing.flags[ID] = { availability: { available: true } };
  const shop = actor('shop', true, [existing]);
  assert.equal(env.merchantHasAvailableItem(shop, goods('a')), false);
  existing.system.quantity.value = 1;
  assert.equal(env.merchantHasAvailableItem(shop, goods('a')), true);
});
