const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Tests execute native ChannelTest and CastTest when a local WFRP4E bundle is supplied.
// The system's code is never bundled or redistributed with this module.
const systemPath = process.env.WFRP4E_SYSTEM_SOURCE;
const nativeSource = systemPath && fs.readFileSync(systemPath, 'utf8');
const moduleSource = fs.readFileSync(path.join(__dirname, '../scripts/channeling-pool.js'), 'utf8');
const moduleId = 'wfrp4-personnal-rules';

function harness(options = {}) {
  const settings = { homebrew: {}, useWoMChannelling: false, extendedTests: false, ...options };
  const hooks = new Map();
  const api = {};
  const errors = [];
  const warnings = [];
  const context = vm.createContext({
    console, Set, WeakMap, WeakSet, Promise,
    Hooks: { once: (key, fn) => hooks.set(key, fn), on: (key, fn) => hooks.set(key, fn), call() {} },
    game: {
      settings: { get: (scope, key) => settings[key] },
      modules: { get: () => ({ api }) },
      i18n: { localize: key => key },
      wfrp4e: { config: {
        magicLores: { fire: 'Fire', heavens: 'Heavens', shadow: 'Shadows', daemonology: 'Daemonology', necromancy: 'Necromancy' },
        magicWind: { fire: 'Aqshy', heavens: 'Azyr', shadow: 'Ulgu', daemonology: 'Dhar', necromancy: 'Dhar' }
      }, utility: { logHomebrew() {} } }
    },
    foundry: { utils: { duplicate: structuredClone } },
    ui: { notifications: { error: message => errors.push(message), warn: message => warnings.push(message) } },
    ChatMessage: { create() {} }
  });
  vm.runInContext(`
    class TestWFRP {
      get item() { return this.actor.items.get(this.preData.item); }
      get preData() { return this.data.preData; }
      get context() { return this.data.context; }
      get result() { return this.data.result; }
      get succeeded() { return this.result.outcome === 'success'; }
      get failed() { return !this.succeeded; }
      get hasIngredient() { return !!this.useIngredient; }
      async runPreEffects() {}
    async runPostEffects() {}
    computeTables() {}
      async computeResult() {}
      _handleMiscasts(count) { this.result.miscastCount = count; }
    }
    class SkillTest extends TestWFRP { async postTest() {} }
  `, context);
  if (nativeSource) {
    const extract = (start, end) => nativeSource.slice(nativeSource.indexOf(start), nativeSource.indexOf(end));
    vm.runInContext(extract('class ChannelTest extends', 'class ChannellingDialog extends'), context);
    // Exercise the real miscast severity handler as well as ChannelTest rules.
    vm.runInContext('class NativeMiscasts { ' + extract('  _handleMiscasts(miscastCounter) {', '  formatBreakdown()') + ' }; TestWFRP.prototype._handleMiscasts = NativeMiscasts.prototype._handleMiscasts;', context);
    vm.runInContext(extract('class CastTest extends', 'class WomCastTest extends'), context);
  } else {
    // Small contract doubles keep the ordinary suite runnable without an installed system.
    vm.runInContext(`
      class ChannelTest extends TestWFRP {
        get spell() { return this.item; }
        updateChannelledItems(delta) {
          this.item.system.cn.SL = Math.max(0, Math.min(this.item.cn.value, this.item.cn.SL + delta));
          return this.item.cn.SL;
        }
        async postTest() {
          let sl = Number(this.result.SL);
          if (!sl && game.settings.get('wfrp4e', 'extendedTests')) sl = this.succeeded ? 1 : -1;
          if (sl < 0 && game.settings.get('wfrp4e', 'homebrew').channelingNegativeSLTests) sl = 0;
          this.result.channelledSL = this.result.criticalchannell
            ? (game.settings.get('wfrp4e', 'useWoMChannelling') ? sl + this.actor.system.characteristics.wp.bonus : this.item.cn.value)
            : sl;
          const prior = this.context.previousResult || {};
          this.result.channelledDisplay = String(this.updateChannelledItems(this.result.channelledSL - (prior.channelledSL || 0) + (prior.pastSL || 0)));
        }
      }
      class CastTest extends TestWFRP {
        get spell() { return this.item; }
        async computeResult() {
          let cn = this.item.cn.value;
          const sl = this.preData.itemData.system.cn.SL;
          if (game.settings.get('wfrp4e', 'homebrew').partialChannelling || game.settings.get('wfrp4e', 'useWoMChannelling')) cn = Math.max(0, cn - sl);
          else if (sl >= cn) cn = 0;
          this.result.slOver = Number(this.result.SL) - cn;
          this.result.castOutcome = this.succeeded && this.result.slOver >= 0 ? 'success' : 'failure';
        }
        async postTest() {
          if (this.hasIngredient && !this.context.reroll && !this.context.edited) await this.item.ingredient.update({'system.quantity.value': this.item.ingredient.quantity.value - 1});
          if (this.item.cn.SL > 0) await this.item.update({'system.cn.SL': 0});
        }
      }
    `, context);
  }
  vm.runInContext('game.wfrp4e.rolls = { TestWFRP, ChannelTest, CastTest, SkillTest };', context);
  vm.runInContext(moduleSource, context);
  hooks.get('ready')();
  assert.deepEqual(errors, []);

  function actor() {
    const flags = new Map();
    const items = [];
    items.get = id => items.find(item => item.id === id);
    return {
      uuid: 'Actor.' + Math.random(), documentName: 'Actor', isOwner: true, items,
      system: { characteristics: { wp: { bonus: 4 } } },
      getFlag(scope, key) {
        if (flags.has(key)) return flags.get(key);
        if (key === 'channelPools') {
          return Object.fromEntries(Array.from(flags).filter(([flag]) => flag.startsWith('channelPools.')).map(([flag, value]) => [flag.slice(13), value]));
        }
      },
      async setFlag(scope, key, value) { flags.set(key, structuredClone(value)); },
      runScripts: () => [],
      async updateEmbeddedDocuments(type, updates) {
        for (const update of updates) {
          const item = items.get(update._id);
          item.system.cn.SL = update['system.cn.SL'];
          item._source.system.cn.SL = update['system.cn.SL'];
        }
      }
    };
  }
  function spell(owner, id, lore = 'fire', cn = 4, sl = 0, extra = {}) {
    const item = {
      id, uuid: owner.uuid + '.Item.' + id, type: 'spell', name: id, parent: owner, flags: {},
      system: { cn: { value: cn, SL: sl }, lore: { value: [lore] }, memorized: { value: true }, ritual: { value: false }, overcast: { enabled: false, usage: {} }, damage: { dice: '' }, ...extra },
      runScripts: () => [],
      toObject() { return { _id: id, type: 'spell', system: structuredClone(this.system) }; },
      async update(data) { if ('system.cn.SL' in data) this.system.cn.SL = data['system.cn.SL']; }
    };
    for (const key of ['cn', 'lore', 'overcast', 'damage']) Object.defineProperty(item, key, { get: () => item.system[key] });
    item._source = item.toObject();
    owner.items.push(item);
    return item;
  }
  function skill(owner, id, name) {
    const match = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(name);
    const item = { id, uuid: owner.uuid + '.Item.' + id, type: 'skill', name, runScripts: () => [], specifier: match?.[2] || '', parent: owner, toObject() { return { _id: id, type: 'skill', name, system: {} }; } };
    owner.items.push(item);
    return item;
  }
  function roll(kind, owner, item, sl = 2, success = true) {
    const result = { tables: {}, SL: String(sl), outcome: success ? 'success' : 'failure', roll: success ? 32 : 67, other: [], tooltips: {}, overcast: { enabled: false }, breakdown: { damage: { other: [] } } };
    const instance = Object.create(context.game.wfrp4e.rolls[kind].prototype);
    instance.actor = owner;
    instance.data = { preData: { item: item.id, itemData: item.toObject(), ingredientMode: 'none' }, context: {}, result };
    return instance;
  }
  return { actor, spell, skill, roll, api: api.channelPool, settings, context, hooks, warnings };
}

test('same lore shares SL, exceeds spell CN, and is cleared by a different spell', async () => {
  const h = harness(); const a = h.actor();
  const one = h.spell(a, 'one', 'fire', 2); const two = h.spell(a, 'two', 'fire', 6);
  h.spell(a, 'blue', 'heavens', 4, 3);
  await h.roll('ChannelTest', a, one, 8).postTest();
  assert.equal(h.api.get(a, 'fire').sl, 8);
  assert.equal(one.system.cn.SL, 0);
  const cast = h.roll('CastTest', a, two, 1);
  await cast.runPreEffects(); await cast.computeResult(); await cast.postTest();
  assert.equal(cast.result.castOutcome, 'success');
  assert.equal(cast.preData.itemData.system.cn.SL, 8);
  assert.equal(h.api.get(a, 'fire').sl, 0);
  assert.equal(h.api.get(a, 'heavens').sl, 3);
});

test('normal and partial channelling keep native casting thresholds', async () => {
  for (const partialChannelling of [false, true]) {
    const h = harness({ homebrew: { partialChannelling } }); const a = h.actor();
    const item = h.spell(a, 'spell', 'fire', 6);
    await h.roll('ChannelTest', a, item, 4).postTest();
    const cast = h.roll('CastTest', a, item, 2);
    await cast.runPreEffects(); await cast.computeResult();
    assert.equal(cast.result.castOutcome, partialChannelling ? 'success' : 'failure');
  }
});

test('failed casting clears normally, but retains SL with mooCastAfterChannelling', async () => {
  for (const keep of [false, true]) {
    const h = harness({ homebrew: { mooCastAfterChannelling: keep } }); const a = h.actor();
    const item = h.spell(a, 'spell');
    await h.roll('ChannelTest', a, item, 6).postTest();
    const cast = h.roll('CastTest', a, item, -2, false);
    await cast.runPreEffects(); await cast.computeResult(); await cast.postTest();
    assert.equal(h.api.get(a, 'fire').sl, keep ? 6 : 0);
    if (keep) {
      cast.context.reroll = true;
      cast.result.outcome = 'success'; cast.result.SL = '2'; cast.result.roll = 32;
      await cast.runPreEffects(); await cast.computeResult(); await cast.postTest();
      assert.equal(h.api.get(a, 'fire').sl, 0);
    }
  }
});

test('a cast reroll keeps its snapshot without draining newly channelled SL', async () => {
  const h = harness(); const a = h.actor(); const item = h.spell(a, 'spell');
  await h.roll('ChannelTest', a, item, 6).postTest();
  const cast = h.roll('CastTest', a, item);
  await cast.runPreEffects(); await cast.computeResult(); await cast.postTest();
  await h.roll('ChannelTest', a, item, 3).postTest();
  cast.context.reroll = true;
  await cast.runPreEffects(); await cast.computeResult(); await cast.postTest();
  assert.equal(cast.preData.itemData.system.cn.SL, 6);
  assert.equal(h.api.get(a, 'fire').sl, 3);
});

test('channel corrections apply deltas and cannot resurrect a spent pool', async () => {
  const h = harness(); const a = h.actor(); const item = h.spell(a, 'spell');
  const channel = h.roll('ChannelTest', a, item, 4);
  await channel.postTest();
  channel.context.previousResult = structuredClone(channel.result); channel.result.SL = '6';
  await channel.postTest();
  assert.equal(h.api.get(a, 'fire').sl, 6);
  const cast = h.roll('CastTest', a, item);
  await cast.runPreEffects(); await cast.computeResult(); await cast.postTest();
  channel.context.previousResult = structuredClone(channel.result); channel.result.SL = '8';
  await channel.postTest();
  assert.equal(h.api.get(a, 'fire').sl, 0);
});

test('negative SL, zero SL and critical channel rules remain native', async () => {
  for (const wom of [false, true]) {
    const h = harness({ useWoMChannelling: wom, extendedTests: true }); const a = h.actor(); const item = h.spell(a, 'spell', 'fire', 6);
    const critical = h.roll('ChannelTest', a, item, 2); critical.result.criticalchannell = 'Critical';
    await critical.postTest();
    assert.equal(h.api.get(a, 'fire').sl, 6);
    assert.equal(h.api.get(a, 'fire').critical, true);
    await h.roll('ChannelTest', a, item, -10, false).postTest();
    assert.equal(h.api.get(a, 'fire').sl, 0);
    await h.roll('ChannelTest', a, item, 0).postTest();
    assert.equal(h.api.get(a, 'fire').sl, 1);
  }
});

test('existing SL are summed for core rules and counted once for WoM', async () => {
  for (const wom of [false, true]) {
    const h = harness({ useWoMChannelling: wom }); const a = h.actor();
    const one = h.spell(a, 'one', 'fire', 4, 3); h.spell(a, 'two', 'fire', 4, 3);
    assert.equal(h.api.get(a, 'fire').sl, wom ? 3 : 6);
    await h.roll('ChannelTest', a, one, 1).postTest();
    assert.equal(h.api.get(a, 'fire').sl, wom ? 4 : 7);
    assert.ok(a.items.every(item => item.system.cn.SL === 0));
  }
});

test('petty magic and rituals use their original counters; chosen lore selects the pool', async () => {
  const h = harness(); const a = h.actor();
  const petty = h.spell(a, 'petty', 'petty');
  const ritual = h.spell(a, 'ritual', 'fire', 4, 0, { ritual: { value: true } });
  assert.equal(h.api.getLore(petty), null); assert.equal(h.api.getLore(ritual), null);
  for (const item of [petty, ritual]) {
    const test = h.roll('ChannelTest', a, item, 2);
    assert.equal(test.item, item);
  }
  const multi = h.spell(a, 'multi', 'fire', 4, 0, { lore: { value: ['fire', 'heavens'], chosen: 'heavens' } });
  await h.roll('ChannelTest', a, multi, 3).postTest();
  assert.equal(h.api.get(a, 'heavens').sl, 3); assert.equal(h.api.get(a, 'fire').sl, 0);
});

test('simultaneous local channel updates are serialized, and persisted data reloads', async () => {
  const h = harness(); const a = h.actor(); const one = h.spell(a, 'one'); const two = h.spell(a, 'two');
  await Promise.all([h.roll('ChannelTest', a, one, 3).postTest(), h.roll('ChannelTest', a, two, 4).postTest()]);
  assert.equal(h.api.get(a, 'fire').sl, 7);
  const reloaded = harness();
  assert.equal(reloaded.api.get(a, 'fire').sl, 7);
});

test('manual pool edits validate values and permissions', async () => {
  const h = harness(); const a = h.actor(); h.spell(a, 'spell');
  await h.api.set(a, 'fire', 12);
  for (const sl of [-1, 0.5, NaN, Infinity]) await assert.rejects(h.api.set(a, 'fire', sl), /InvalidSL/);
  assert.equal(h.api.get(a, 'fire').sl, 12);
  a.isOwner = false;
  await assert.rejects(h.api.set(a, 'fire', 0), /NoPermission/);
});

test('native ingredients are consumed only once across a cast reroll', async () => {
  const h = harness(); const a = h.actor(); const item = h.spell(a, 'spell');
  item.ingredient = { quantity: { value: 2 }, async update(data) { this.quantity.value = data['system.quantity.value']; } };
  await h.roll('ChannelTest', a, item, 6).postTest();
  const cast = h.roll('CastTest', a, item); cast.useIngredient = true;
  await cast.runPreEffects(); await cast.computeResult(); await cast.postTest();
  cast.context.reroll = true;
  await cast.runPreEffects(); await cast.computeResult(); await cast.postTest();
  assert.equal(item.ingredient.quantity.value, 1);
});

test('old channel cards do not modify a new pool, and actor pools stay independent', async () => {
  const h = harness(); const a = h.actor(); const b = h.actor();
  const one = h.spell(a, 'one'); h.spell(b, 'two');
  await h.api.set(a, 'fire', 5);
  const old = h.roll('ChannelTest', a, one, 8);
  old.context.reroll = true;
  old.context.previousResult = { channelledSL: 2 };
  await old.postTest();
  assert.equal(h.api.get(a, 'fire').sl, 5);
  assert.equal(h.api.get(b, 'fire').sl, 0);
});


test('pool steps match the sheet controls and never go below zero', async () => {
  const h = harness(); const a = h.actor(); h.spell(a, 'spell');
  assert.equal((await h.api.step(a, 'fire', -1)).sl, 0);
  assert.equal(h.api.get(a, 'fire').sl, 0);
  assert.equal((await h.api.step(a, 'fire', 1)).sl, 1);
  assert.equal(h.api.get(a, 'fire').sl, 1);
  assert.equal((await h.api.step(a, 'fire', -10)).sl, 0);
  assert.equal(h.api.get(a, 'fire').sl, 0);
});
test('the lore name rolls the matching owned Channelling skill', async () => {
  const h = harness(); const a = h.actor();
  const skill = h.skill(a, 'channel-ulgu', 'Channelling (Ulgu)');
  let setup;
  let rolls = 0;
  a.setupSkill = async (selected, options) => {
    setup = { selected, options };
    return { async roll() { rolls += 1; return 'rolled'; } };
  };

  assert.equal(await h.api.roll(a, 'shadow'), 'rolled');
  assert.equal(setup.selected, skill);
  assert.equal(setup.options.skipTargets, true);
  assert.match(setup.options.title, /Shadow$/);
  assert.equal(rolls, 1);

  const withoutSkill = h.actor();
  h.spell(withoutSkill, 'shadow-spell', 'shadow');
  await assert.rejects(h.api.roll(withoutSkill, 'shadow'), /NoSkill/);
});

test('removing a Channelling row clears and hides it until a new successful test', async () => {
  const h = harness(); const a = h.actor();
  const skill = h.skill(a, 'channel-aqshy', 'Channelling (Aqshy)');
  h.spell(a, 'fire-spell', 'fire');
  await h.api.set(a, 'fire', 4);
  await h.api.remove(a, 'fire');

  assert.equal(h.api.get(a, 'fire').sl, 0);
  assert.equal(a.getFlag(moduleId, 'hiddenChannelPools.lore-fire'), true);

  await h.roll('SkillTest', a, skill, 3, true).postTest();
  assert.equal(h.api.get(a, 'fire').sl, 3);
  assert.equal(a.getFlag(moduleId, 'hiddenChannelPools.lore-fire'), false);
});
test('Channelling (Ulgu) skill successes add SL to the Shadows pool and rerolls correct the contribution', async () => {
  const h = harness(); const a = h.actor(); const skill = h.skill(a, 'channel-ulgu', 'Channelling (Ulgu)');
  const roll = h.roll('SkillTest', a, skill, 3, true);
  await roll.postTest();
  assert.equal(h.api.get(a, 'shadow').sl, 3);
  assert.deepEqual(h.warnings, []);
  roll.context.reroll = true; roll.result.SL = '5'; roll.result.outcome = 'success';
  await roll.postTest();
  assert.equal(h.api.get(a, 'shadow').sl, 5);
});

test('failed Channelling skill rolls do not add SL and old rolls cannot recreate a spent pool', async () => {
  const h = harness(); const a = h.actor(); const skill = h.skill(a, 'channel-ulgu', 'Channelling (Ulgu)');
  const roll = h.roll('SkillTest', a, skill, -2, false);
  await roll.postTest();
  assert.equal(h.api.get(a, 'shadow').sl, 0);
  roll.context.reroll = true; roll.result.SL = '4'; roll.result.outcome = 'success';
  await roll.postTest();
  assert.equal(h.api.get(a, 'shadow').sl, 4);
  await h.api.set(a, 'shadow', 0);
  roll.result.SL = '6';
  await roll.postTest();
  assert.equal(h.api.get(a, 'shadow').sl, 0);
});

test('a Channelling skill creates a visible pool without a spell and ambiguous Dhar warns', async () => {
  const h = harness(); const a = h.actor(); const ulgu = h.skill(a, 'channel-ulgu', 'Channelling (Ulgu)');
  await h.roll('SkillTest', a, ulgu, 2, true).postTest();
  assert.equal(h.api.get(a, 'shadow').sl, 2);
  const dhar = h.skill(a, 'channel-dhar', 'Channelling (Dhar)');
  h.spell(a, 'daemon', 'daemonology'); h.spell(a, 'necro', 'necromancy');
  await h.roll('SkillTest', a, dhar, 3, true).postTest();
  assert.equal(h.warnings.length, 1);
  assert.equal(h.api.get(a, 'daemonology').sl, 0);
  assert.equal(h.api.get(a, 'necromancy').sl, 0);
});


// These cases use installed WFRP4E methods; no copies of system rules ship here.
test('skill channelling uses native miscast severity and chat tables', { skip: !nativeSource }, async () => {
  for (const [dice, success, expected] of [
    [77, false, 'majormis'], [80, false, 'majormis'], [100, false, 'majormis'],
    [22, true, 'minormis'], [78, false, undefined], [20, true, undefined]
  ]) {
    const h = harness(); const a = h.actor();
    const skill = h.skill(a, 'ulgu', 'Channelling (Ulgu)');
    const spell = h.spell(a, 'shadow', 'shadow');
    const viaSkill = h.roll('SkillTest', a, skill, success ? 3 : -3, success);
    const viaSpell = h.roll('ChannelTest', a, spell, success ? 3 : -3, success);
    for (const roll of [viaSkill, viaSpell]) {
      roll.result.roll = dice;
      await roll.computeResult();
      roll.computeTables();
      assert.equal(roll.result.tables.miscast?.key, expected, 'roll ' + dice);
    }
    assert.deepEqual(JSON.parse(JSON.stringify(viaSkill.result.tables)), JSON.parse(JSON.stringify(viaSpell.result.tables)));
    await viaSkill.postTest();
    assert.equal(h.api.get(a, 'shadow').sl, success ? 3 : 0);
    assert.equal(skill.flags, undefined, 'critical flags never mutate the skill document');
  }
});

test('native Aethyric Attunement effect applies to skill and pool lore rolls', { skip: !nativeSource }, async () => {
  const line = nativeSource.split('\n').find(line => line.includes('mergeObject(game.wfrp4e.config.effectScripts'));
  const scripts = JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1));
  const talentScript = scripts.vzMxIDjRlQSxXtCW;
  assert.ok(talentScript, 'installed Aethyric Attunement script is available');
  for (const [dice, success, expected] of [[22, true, undefined], [77, false, 'majormis']]) {
    const h = harness(); const a = h.actor();
    const skill = h.skill(a, 'ulgu', 'Channelling (Ulgu)');
    const calls = [];
    const talent = vm.runInContext('(args) => { ' + talentScript + ' }', h.context);
    a.runScripts = (trigger, args) => { calls.push(trigger); return trigger === 'rollChannellingTest' ? [talent(args)] : []; };
    a.setupSkill = async selected => {
      const roll = h.roll('SkillTest', a, selected, 3, success);
      roll.result.roll = dice;
      roll.roll = async () => {
        await roll.runPreEffects();
        await roll.computeResult();
        roll.computeTables();
        await roll.runPostEffects();
        await roll.postTest();
        return roll;
      };
      return roll;
    };
    const result = await h.api.roll(a, 'shadow');
    assert.equal(result.result.tables.miscast?.key, expected);
    assert.deepEqual(calls, ['preChannellingTest', 'rollChannellingTest']);
  }
});

test('native Winds of Magic miscasts and reroll recalculation work for skills', { skip: !nativeSource }, async () => {
  const h = harness({ useWoMChannelling: true }); const a = h.actor();
  const skill = h.skill(a, 'ulgu', 'Channelling (Ulgu)');
  const roll = h.roll('SkillTest', a, skill, -3, false);
  roll.result.roll = 77;
  await roll.computeResult(); roll.computeTables();
  assert.equal(roll.result.tables.miscast.key, 'minormis');
  // Foundry resets result data before recomputing an edited/rerolled test.
  roll.context.reroll = true;
  roll.data.result = { ...h.roll('SkillTest', a, skill, -3, false).result, roll: 80 };
  await roll.computeResult(); roll.computeTables();
  assert.equal(roll.result.tables.miscast, undefined);
});

test('other skills and dispel tests retain their normal computation and effects', { skip: !nativeSource }, async () => {
  const h = harness(); const a = h.actor();
  const calls = [];
  a.runScripts = (trigger) => { calls.push(trigger); return []; };
  const ordinary = h.roll('SkillTest', a, h.skill(a, 'cool', 'Cool'), -3, false);
  const dispel = h.roll('SkillTest', a, h.skill(a, 'ulgu', 'Channelling (Ulgu)'), -3, false);
  dispel.context.dispel = 'message-id';
  for (const roll of [ordinary, dispel]) {
    roll.result.roll = 77;
    await roll.runPreEffects(); await roll.computeResult(); roll.computeTables();
    await roll.runPostEffects(); await roll.postTest();
    assert.equal(roll.result.tables.miscast, undefined);
  }
  assert.deepEqual(calls, []);
  assert.equal(h.api.get(a, 'shadow').sl, 0);
});
