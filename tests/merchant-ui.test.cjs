// Optional browser regression: MERCHANT_UI_TEST=1, with Playwright on NODE_PATH.
// Uses a DOM fixture matching Item Piles 3.3.4; never connects to a live world.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('merchant settings survive tab changes, stay out of Main and fit the narrow sidebar', {
  skip: !process.env.MERCHANT_UI_TEST, timeout: 30000
}, async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ channel: process.env.MERCHANT_UI_CHANNEL || 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 720 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setContent('<style>body{font:14px sans-serif;background:#282828;color:#222;display:flex;gap:24px;padding:20px}.item-piles-app{background:#ece5d4;padding:16px;box-sizing:border-box}#config{width:430px}#shop{width:260px}.form-group{display:flex}nav{display:flex;gap:16px;margin-bottom:20px}h2{font-size:18px}select{font:inherit}</style><div id="config" class="item-piles-app"><h2>Merchant configuration</h2><nav><div data-tab="rest" class="active">Main Settings</div><div data-tab="rest">Other Settings</div></nav><form class="item-piles-config-container"><section class="tab-body"><div class="tab"><div class="form-group">Main setting</div></div></section></form></div><div id="shop" class="item-piles-app"><h2>Merchant sidebar</h2><nav>Description / Settings</nav><div class="merchant-description">Description</div></div>');
    if (process.env.ITEM_PILES_CSS) await page.addStyleTag({ content: fs.readFileSync(process.env.ITEM_PILES_CSS, 'utf8') });
    await page.addStyleTag({ content: fs.readFileSync(path.join(__dirname, '../styles/wfrp4-personnal-rules.css'), 'utf8') });
    await page.evaluate(translations => {
      const callbacks = new Map();
      window.Hooks = {
        once() {},
        on(name, cb) { const list = callbacks.get(name) || []; list.push(cb); callbacks.set(name, list); },
        emit(name, ...args) { for (const cb of callbacks.get(name) || []) cb(...args); }
      };
      window.game = {
        user: { isGM: true },
        i18n: { localize: key => translations[key] || ({
          'ITEM-PILES.Applications.ItemPileConfig.Merchant.MerchantImage': 'Merchant Image',
          'ITEM-PILES.Applications.ItemPileConfig.Other.Title': 'Other Settings'
        })[key] || key },
        settings: { get: () => 'MARKET.Town' }
      };
      window.foundry = { utils: { getProperty: (o, key) => key.split('.').reduce((v, p) => v?.[p], o) } };
      window.ui = { notifications: { error: error => { throw Error(error); } } };
      window.saved = [];
      window.shopActor = {
        uuid: 'Actor.shop', flags: {},
        getFlag(namespace, key) { return this.flags[namespace]?.[key]; },
        async setFlag(namespace, key, value) {
          (this.flags[namespace] ||= {})[key] = value;
          window.saved.push({ key, value });
          Hooks.emit('updateActor', this);
        }
      };
    }, JSON.parse(fs.readFileSync(path.join(__dirname, '../languages/en.json'), 'utf8')));
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../scripts/main.js'), 'utf8') });
    await page.evaluate(() => {
      registerMerchantConfigHooks();
      window.configApp = { id: 'item-pile-config-shop-random', options: { svelte: { props: { pileActor: shopActor } } } };
      window.shopApp = { id: 'item-pile-merchant-shop-random', merchant: shopActor };
      Hooks.emit('renderApplication', configApp, document.querySelector('#config'));
      Hooks.emit('renderApplication', shopApp, document.querySelector('#shop'));
    });
    assert.equal(await page.locator('.wfrp4pr-merchant-settings').count(), 0);
    await page.evaluate(() => {
      const tabs = document.querySelectorAll('#config [data-tab]');
      tabs[0].classList.remove('active'); tabs[1].classList.add('active');
      document.querySelector('#config .tab').innerHTML = '<div class="form-group"><label><span>Merchant Image</span></label><input></div>';
    });
    await page.locator('#config .wfrp4pr-merchant-settings').waitFor();
    assert.equal(await page.locator('#config .wfrp4pr-merchant-settings').count(), 1);
    await page.locator('#config .wfrp4pr-merchant-settings input').uncheck();
    assert.equal(await page.evaluate(() => saved[0].value), true);
    await page.evaluate(() => {
      document.querySelector('#shop .merchant-description').remove();
      document.querySelector('#shop').insertAdjacentHTML('beforeend', '<div class="tab merchant-settings"><div class="setting-container item-piles-config-container"><div class="form-group"><label>Purchase only</label><input type="checkbox"></div><div class="form-group"><label>Hide new items</label><input type="checkbox"></div><div>Buy price modifier</div><div>Sell price modifier</div></div><button class="update-button">Update</button></div>');
    });
    await page.locator('#shop .wfrp4pr-merchant-settings').waitFor();
    await page.locator('#shop select').selectOption('MARKET.City');
    assert.equal(await page.locator('#config select').inputValue(), 'MARKET.City');
    assert.equal(await page.locator('#shop .wfrp4pr-merchant-settings input').count(), 0);
    assert.equal(await page.evaluate(() => saved.filter(s => s.key === 'settlement').length), 1);
    const overflow = await page.locator('.wfrp4pr-merchant-settings').evaluateAll(blocks =>
      blocks.some(block => block.scrollWidth > block.clientWidth + 1 || [...block.querySelectorAll('select,input')].some(input =>
        input.getBoundingClientRect().right > block.getBoundingClientRect().right + 1)));
    assert.equal(overflow, false);
    if (process.env.MERCHANT_UI_SCREENSHOT) await page.screenshot({ path: process.env.MERCHANT_UI_SCREENSHOT });
    // Svelte reuses .tab: our fields must be removed when Other disappears.
    await page.evaluate(() => {
      const tabs = document.querySelectorAll('#config [data-tab]');
      tabs[1].classList.remove('active'); tabs[0].classList.add('active');
      document.querySelector('#config .form-group').remove();
    });
    await page.waitForFunction(() => !document.querySelector('#config .wfrp4pr-merchant-settings'));
    await page.evaluate(() => {
      const tabs = document.querySelectorAll('#config [data-tab]');
      tabs[0].classList.remove('active'); tabs[1].classList.add('active');
      document.querySelector('#config .tab').innerHTML = '<div class="form-group"><label><span>Merchant Image</span></label></div>';
    });
    await page.locator('#config .wfrp4pr-merchant-settings').waitFor();
    assert.equal(await page.locator('#config .wfrp4pr-merchant-settings').count(), 1);
    assert.equal(await page.locator('#config select').inputValue(), 'MARKET.City');
    assert.equal(await page.locator('#config input').isChecked(), false);
    await page.evaluate(() => { Hooks.emit('closeApplication', configApp); Hooks.emit('closeApplication', shopApp); });
    assert.equal(await page.evaluate(() => merchantConfigObservers.size), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
