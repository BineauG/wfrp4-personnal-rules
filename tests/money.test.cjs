const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../scripts/main.js'), 'utf8');
const getProperty = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);
function setProperty(object, key, value) {
  const parts = key.split('.');
  const leaf = parts.pop();
  for (const part of parts) object = object[part] ||= {};
  object[leaf] = value;
}

function environment() {
  const context = vm.createContext({
    Hooks: { once() {} },
    game: {
      i18n: { localize: key => key, format: (key, values) => `${key}: ${JSON.stringify(values)}` },
      itempiles: { API: {} }
    },
    foundry: { utils: { getProperty, setProperty, deepClone: structuredClone, mergeObject: Object.assign } }
  });
  vm.runInContext(source, context);
  return context;
}

function actor(name, coins) {
  const items = coins.map(([value, quantity], index) => ({
    id: `${name}-${index}`, type: 'money', system: { coinValue: { value }, quantity: { value: quantity } }
  }));
  return {
    name, items, writes: 0,
    async updateEmbeddedDocuments(type, updates) {
      assert.equal(type, 'Item');
      this.writes++;
      for (const update of updates) {
        const item = this.items.find(item => item.id === update._id);
        item.system.quantity.value = update.system.quantity.value;
      }
    }
  };
}

test('achats et ventes conservent exactement la monnaie avec les denominations WFRP4E', async () => {
  const env = environment();
  for (const mode of ['buy', 'sell']) {
    for (const amountBP of [1, 11, 12, 13, 239, 240, 241, 480]) {
      const payer = actor('payer', [[240, 2], [12, 0], [1, 0]]);
      const payee = actor('payee', [[240, 0], [12, 2], [1, 3]]);
      const transfers = env.prepareMoneyTransfers({ payer, payee, mode, amountBP, merchantPileData: {} });
      assert.equal(payer.writes + payee.writes, 0);
      await env.transferMoneyForTrade(transfers);
      assert.equal(env.getMoneyTotalBP(payer), 480 - amountBP);
      assert.equal(env.getMoneyTotalBP(payee), 27 + amountBP);
    }
  }
});

test('les pieces dupliquees et les stocks de pennies nuls sont geres', async () => {
  const env = environment();
  const payer = actor('payer', [[12, 2], [12, 1], [1, 0], [1, 0]]);
  const payee = actor('payee', [[1, 0]]);
  await env.transferMoneyForTrade(env.prepareMoneyTransfers({ payer, payee, mode: 'buy', amountBP: 1, merchantPileData: {} }));
  assert.equal(env.getMoneyTotalBP(payer), 35);
  assert.equal(env.getMoneyTotalBP(payee), 1);
});

test('une piece manquante chez le payeur ou le beneficiaire bloque avant tout transfert', async () => {
  for (const mode of ['buy', 'sell']) {
    for (const missing of ['payer', 'payee']) {
      const env = environment();
      const payer = actor('payer', missing === 'payer' ? [[12, 1]] : [[1, 12]]);
      const payee = actor('payee', missing === 'payee' ? [[12, 0]] : [[1, 0]]);
      const merchant = mode === 'buy' ? payee : payer;
      const seller = mode === 'buy' ? merchant : payee;
      const buyer = mode === 'buy' ? payer : merchant;
      const item = { id: 'goods', name: 'goods', type: 'trapping', system: { quantity: { value: 1 }, price: { bp: 1 } } };
      seller.items.push(item);
      seller.items.get = id => seller.items.find(item => item.id === id);
      env.fromUuid = async id => id === 'seller' ? seller : buyer;
      env.resolveActor = value => value;
      env.isItemPilesMerchant = value => value === merchant;
      env.bestSkillKey = () => 'haggle';
      env.rollMerchantSkill = async () => ({ sl: 0 });
      let itemTransfers = 0;
      env.transferTradedItem = async () => { itemTransfers++; };
      const before = JSON.stringify([payer.items, payee.items]);
      await assert.rejects(env.executeMerchantTradeAsGM({ sellerUuid: 'seller', buyerUuid: 'buyer', itemId: 'goods', quantity: 1, playerTest: { sl: 0 } }), /MissingDenomination/);
      assert.equal(itemTransfers, 0);
      assert.equal(payer.writes + payee.writes, 0);
      assert.equal(JSON.stringify([payer.items, payee.items]), before);
    }
  }
});

test('un solde exact reste autorise sans pennies', async () => {
  const env = environment();
  const payer = actor('payer', [[12, 2]]);
  const payee = actor('payee', [[12, 0]]);
  await env.transferMoneyForTrade(env.prepareMoneyTransfers({ payer, payee, mode: 'buy', amountBP: 12, merchantPileData: {} }));
  assert.equal(env.getMoneyTotalBP(payer), 12);
  assert.equal(env.getMoneyTotalBP(payee), 12);
});

test('les marchands a monnaie infinie ne necessitent aucun objet de monnaie', async () => {
  const env = environment();
  for (const mode of ['buy', 'sell']) {
    const merchant = actor('merchant', []);
    const player = actor('player', [[1, 12]]);
    const payer = mode === 'buy' ? player : merchant;
    const payee = mode === 'buy' ? merchant : player;
    await env.transferMoneyForTrade(env.prepareMoneyTransfers({ payer, payee, mode, amountBP: 1, merchantPileData: { infiniteCurrencies: true } }));
    assert.equal(merchant.writes, 0);
    assert.equal(env.getMoneyTotalBP(player), mode === 'buy' ? 11 : 13);
  }
});

test('un echange gratuit ne necessite pas de monnaie', () => {
  const env = environment();
  assert.equal(env.prepareMoneyTransfers({ payer: actor('payer', []), payee: actor('payee', []), mode: 'buy', amountBP: 0, merchantPileData: {} }).length, 0);
});

test('les fonds insuffisants, monnaies absentes et montants invalides sont refuses sans ecriture', () => {
  const env = environment();
  const payer = actor('payer', [[1, 12]]);
  const payee = actor('payee', [[1, 0]]);
  const options = { payer, payee, mode: 'buy', merchantPileData: {} };
  assert.throws(() => env.prepareMoneyTransfers({ ...options, amountBP: 13 }), /NotEnoughMoney/);
  assert.throws(() => env.prepareMoneyTransfers({ ...options, payee: actor('empty', []), amountBP: 1 }), /NoMoneyItems/);
  for (const amountBP of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => env.prepareMoneyTransfers({ ...options, amountBP }), /InvalidMoney/);
  }
  assert.equal(payer.writes + payee.writes, 0);
});
