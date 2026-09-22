const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('light fields autosave and players use a native-style inventory effect button only', {
  skip: !process.env.LIGHT_UI_TEST, timeout: 30000
}, async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1050, height: 700 } });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setContent('<style>body{font:15px sans-serif;background:#282828;display:flex;gap:24px;padding:24px}.sheet{background:#eee6d5;padding:20px;width:430px;box-sizing:border-box}label{margin:4px 0}input,button{font:inherit}button{cursor:pointer}.row-content,.list-controls{display:flex;align-items:center;gap:8px}.list-name{flex:1}.notes{color:#555}</style><div class="sheet" id="item"><h2>Torche</h2><nav>Description / Détails / Effets</nav><section data-tab="details"><p>Équipement</p></section></div><div class="sheet" id="actor"><h2>Inventaire du personnage</h2><div class="sheet-list inventory"><div class="list-row" data-uuid="Actor.hero.Item.torch"><div class="row-content"><div class="list-name">Torche</div><div class="list-controls"></div></div></div></div></div>');
    await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, '../styles/wfrp4-personnal-rules.css'), 'utf8') });
    await page.evaluate(translations => {
      const callbacks = new Map();
      window.Hooks = {
        once(name, cb) { callbacks.set(name, [cb]); },
        on(name, cb) { const list = callbacks.get(name) || []; list.push(cb); callbacks.set(name, list); },
        async emit(name, ...args) { for (const cb of callbacks.get(name) || []) await cb(...args); }
      };
      window.hero = { uuid: 'Actor.hero', isOwner: true };
      window.torch = {
        actor: hero, id: 'torch', uuid: 'Actor.hero.Item.torch', name: 'Torche',
        documentName: 'Item', type: 'trapping', isOwner: true, flags: {},
        system: { quantity: { value: 1 } },
        getFlag(ns, key) { return this.flags[ns]?.[key]; },
        async setFlag(ns, key, value) {
          (this.flags[ns] ||= {})[key] = value;
          await Hooks.emit('updateItem', this, { flags: { [ns]: { [key]: value } } }, {}, 'owner');
          await itemApp.render();
          await Hooks.emit('renderApplicationV2', actorApp, document.createDocumentFragment());
        }
      };
      hero.items = [torch];
      hero.items.get = id => hero.items.find(i => i.id === id);
      window.token = {
        uuid: 'Scene.scene.Token.token', actor: hero, light: { bright: 0, dim: 0 }, flags: {},
        getFlag(ns, key) { return this.flags[ns]?.[key]; },
        canUserModify() { return true; },
        async update(changes) {
          for (const [key, value] of Object.entries(changes)) {
            if (key.startsWith('light.')) this.light[key.slice(6)] = value;
            else if (key.includes('.-=')) delete this.flags['wfrp4-personnal-rules']?.activeLight;
            else (this.flags['wfrp4-personnal-rules'] ||= {}).activeLight = value;
          }
          await Hooks.emit('updateToken', this);
        }
      };
      window.canvas = { scene: { tokens: [token] }, tokens: { controlled: [] } };
      const module = { api: {} };
      window.game = { user: { id: 'owner', isGM: true }, modules: { get: () => module }, scenes: [canvas.scene], i18n: { localize: key => translations[key] || key } };
      window.ui = { notifications: { warn: message => { throw Error(message); }, error: message => { throw Error(message); } } };
      window.foundry = { utils: { deepClone: value => structuredClone(value), hasProperty: (o, k) => k.split('.').reduce((v, p) => v?.[p], o) !== undefined } };
      window.itemApp = { item: torch, element: document.querySelector('#item'), render() { Hooks.emit('renderApplicationV2', this, document.createDocumentFragment()); } };
      window.actorApp = { actor: hero, element: document.querySelector('#actor') };
      window.nativeChanges = 0;
      itemApp.element.addEventListener('change', () => nativeChanges++);
    }, JSON.parse(fs.readFileSync(path.join(__dirname, '../languages/fr.json'), 'utf8')));
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../scripts/light-sources.js'), 'utf8') });
    await page.evaluate(async () => { await Hooks.emit('ready'); await itemApp.render(); });
    await page.locator('[data-light-field="enabled"]').check();
    await page.waitForFunction(() => torch.getFlag('wfrp4-personnal-rules', 'lightSource')?.enabled);
    await page.locator('[data-light-field="bright"]').fill('3');
    await page.locator('[data-light-field="bright"]').blur();
    await page.waitForFunction(() => torch.getFlag('wfrp4-personnal-rules', 'lightSource')?.bright === 3);
    await page.locator('[data-light-field="dim"]').fill('6');
    await page.locator('[data-light-field="dim"]').blur();
    await page.waitForFunction(() => torch.getFlag('wfrp4-personnal-rules', 'lightSource')?.dim === 6);
    assert.equal(await page.evaluate(() => torch.getFlag('wfrp4-personnal-rules', 'lightSource').dim), 6);
    assert.equal(await page.evaluate(() => nativeChanges), 0);
    await page.evaluate(() => Hooks.emit('renderApplicationV2', actorApp, document.createDocumentFragment()));
    assert.equal(await page.locator('#actor .wfrp4pr-light-toggle').count(), 1);
    assert.equal(await page.locator('#item button').count(), 0);
    assert.equal(await page.locator('#item fieldset.wfrp4pr-light-config > legend').innerText(), 'Source de lumière');
    assert.equal(await page.locator('#item .wfrp4pr-light-config').evaluate(element => getComputedStyle(element).rowGap), '8px');
    assert.equal(await page.locator('.form-group .form-fields [data-light-field]').count(), 3);
    assert.equal(await page.locator('#actor .list-controls button').count(), 0);
    assert.equal(await page.locator('#actor .sheet-effect-buttons .wfrp4pr-light-toggle').innerText(), 'Light');
    assert.equal(await page.locator('#actor .wfrp4pr-light-toggle i').count(), 0);
    // Existing manual effects must survive reinjection.
    await page.evaluate(() => {
      const effect = document.createElement('button');
      effect.className = 'native-effect';
      effect.textContent = 'Manual effect';
      document.querySelector('#actor .sheet-effect-buttons').prepend(effect);
    });
    if (process.env.LIGHT_UI_SCREENSHOT) await page.screenshot({ path: process.env.LIGHT_UI_SCREENSHOT });
    await page.evaluate(async () => { game.user.isGM = false; await itemApp.render(); });
    assert.equal(await page.locator('[data-light-field]').count(), 0);
    await page.locator('#actor .wfrp4pr-light-toggle').click();
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => token.light.dim), 6);
    assert.equal(await page.locator('#actor .wfrp4pr-light-toggle').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#item .wfrp4pr-light-toggle').count(), 0);
    await page.locator('#actor .wfrp4pr-light-toggle').click();
    assert.equal(await page.evaluate(() => token.light.dim), 0);
    assert.equal(await page.locator('#actor .wfrp4pr-light-toggle').getAttribute('aria-pressed'), 'false');
    await page.evaluate(() => Hooks.emit('renderApplicationV2', actorApp, actorApp.element));
    assert.equal(await page.locator('#actor .wfrp4pr-light-toggle').count(), 1);
    assert.equal(await page.locator('#actor .native-effect').count(), 1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
