// Keep native WFRP4E tests and rules; replace only their channelled-SL storage.
(() => {
  const MODULE_ID = "wfrp4-personnal-rules";
  const CONTEXT_KEY = "wfrp4prChannelPool";
  const queues = new WeakMap();
  const pendingChannel = new WeakMap();
  const suppressNativeClear = new WeakSet();
  const criticalChannels = new WeakSet();

  const setting = key => game.settings.get("wfrp4e", key);
  const localize = key => game.i18n.localize(`WFRP4PR.ChannelPool.${key}`);
  const flagKey = lore => `channelPools.lore-${lore}`;
  const loreLabel = lore => game.i18n.localize(game.wfrp4e.config.magicLores[lore] || lore);

  function getLore(item) {
    if (item?.type !== "spell" || item.system.ritual?.value) return null;
    const value = item.system.lore?.value;
    const lores = Array.isArray(value) ? value : [value];
    const lore = lores.includes(item.system.lore?.chosen) ? item.system.lore.chosen : lores[0];
    return typeof lore === "string" && lore !== "petty" && /^[a-z][a-z0-9_-]*$/.test(lore) ? lore : null;
  }

  function isOwnedSpell(item, actor) {
    return !!actor?.items?.get(item?.id) && item.parent?.uuid === actor.uuid && !!getLore(item);
  }

  function getPool(actor, lore) {
    const saved = actor.getFlag(MODULE_ID, flagKey(lore));
    if (saved) return { ...saved };

    // Existing core SL were independent; WoM SL were already mirrored between spells.
    const amounts = Array.from(actor.items || [])
      .filter(item => getLore(item) === lore)
      .map(item => Math.max(0, Number(item._source?.system?.cn?.SL ?? item.system.cn.SL) || 0));
    const sl = setting("useWoMChannelling")
      ? Math.max(0, ...amounts)
      : amounts.reduce((sum, value) => sum + value, 0);
    return { sl, epoch: 0, revision: 0, critical: false };
  }

  function queue(actor, task) {
    const previous = queues.get(actor) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    queues.set(actor, next);
    // Observe errors without hiding them from the caller or leaving a rejected finally promise.
    next.then(() => { if (queues.get(actor) === next) queues.delete(actor); },
      () => { if (queues.get(actor) === next) queues.delete(actor); });
    return next;
  }

  async function savePool(actor, lore, pool) {
    if (!Number.isSafeInteger(pool.sl) || pool.sl < 0) throw new Error(localize("InvalidSL"));
    const firstWrite = !actor.getFlag(MODULE_ID, flagKey(lore));
    await actor.setFlag(MODULE_ID, flagKey(lore), pool);
    if (firstWrite) {
      // Save the shared balance first, then retire legacy per-spell counters.
      const updates = Array.from(actor.items).filter(item => getLore(item) === lore && item.system.cn.SL)
        .map(item => ({ _id: item.id, "system.cn.SL": 0 }));
      if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, { updateWoM: true });
    }
    return pool;
  }

  async function setPool(actor, lore, sl) {
    if (!actor.isOwner) throw new Error(localize("NoPermission"));
    if (!Array.from(actor.items).some(item => getLore(item) === lore)) throw new Error(localize("NoLore"));
    return queue(actor, () => {
      const current = getPool(actor, lore);
      return savePool(actor, lore, { sl, epoch: current.epoch + 1, revision: current.revision + 1, critical: false });
    });
  }

  // The view is local to a Test. It never changes the spell document or global settings.
  function spellView(test, item) {
    if (!isOwnedSpell(item, test.actor)) return item;
    const lore = test.context?.[CONTEXT_KEY]?.lore || getLore(item);
    const pool = getPool(test.actor, lore);
    const snapshot = test.context?.[CONTEXT_KEY];
    const critical = snapshot?.critical ?? pool.critical;
    const cn = { ...item.cn, SL: suppressNativeClear.has(test) ? 0 : pool.sl };
    const flags = new Proxy(item.flags, {
      get(target, key) {
        return key === "criticalchannell" ? criticalChannels.has(test) || critical : target[key];
      },
      set(target, key, value) {
        if (key === "criticalchannell") {
          if (value) criticalChannels.add(test); else criticalChannels.delete(test);
          return true;
        }
        return Reflect.set(target, key, value);
      }
    });
    const system = new Proxy(item.system, {
      get(target, key) {
        if (key === "cn") return cn;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    return new Proxy(item, {
      get(target, key) {
        if (key === "cn") return cn;
        if (key === "system") return system;
        if (key === "flags") return flags;
        if (key === "toObject") return (...args) => {
          const data = target.toObject(...args);
          data.system.cn.SL = cn.SL;
          return data;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
  }

  function patchTests() {
    const { TestWFRP, ChannelTest, CastTest } = game.wfrp4e.rolls;
    const nativeItem = Object.getOwnPropertyDescriptor(TestWFRP.prototype, "item")?.get;
    if (!nativeItem || !ChannelTest.prototype.updateChannelledItems || !CastTest.prototype.postTest) {
      throw new Error(localize("UnsupportedVersion"));
    }
    for (const TestClass of [ChannelTest, CastTest]) {
      Object.defineProperty(TestClass.prototype, "item", {
        configurable: true,
        get() { return spellView(this, nativeItem.call(this)); }
      });
    }

    const nativeChannelUpdate = ChannelTest.prototype.updateChannelledItems;
    ChannelTest.prototype.updateChannelledItems = function(slDelta) {
      const pending = pendingChannel.get(this);
      if (!pending) return nativeChannelUpdate.call(this, slDelta);
      const previous = this.context[CONTEXT_KEY];
      if ((previous && previous.epoch !== pending.pool.epoch) || (!previous && (this.context.reroll || this.context.edited))) {
        pending.stale = true;
        return pending.pool.sl; // Editing a spent roll must not recreate spent SL.
      }
      const raw = pending.pool.sl + Number(slDelta);
      this.result.pastSL = Math.min(0, raw); // Native negative-SL correction, without a spell CN cap.
      pending.pool = {
        ...pending.pool,
        sl: Math.max(0, raw),
        revision: pending.pool.revision + 1,
        critical: raw > 0 && (pending.pool.critical || !!this.result.criticalchannell)
      };
      return pending.pool.sl;
    };

    const nativeChannelPost = ChannelTest.prototype.postTest;
    ChannelTest.prototype.postTest = async function(...args) {
      const item = nativeItem.call(this);
      if (!isOwnedSpell(item, this.actor)) return nativeChannelPost.apply(this, args);
      return queue(this.actor, async () => {
        const lore = this.context[CONTEXT_KEY]?.lore || getLore(item);
        const pending = { lore, pool: getPool(this.actor, lore) };
        pendingChannel.set(this, pending);
        try {
          const result = await nativeChannelPost.apply(this, args);
          if (!pending.stale) {
            await savePool(this.actor, lore, pending.pool);
            this.context[CONTEXT_KEY] = { lore, epoch: pending.pool.epoch };
          }
          this.result.channelledDisplay = `${pending.pool.sl} ${game.i18n.localize("SL")} — ${loreLabel(lore)}`;
          return result;
        } finally {
          pendingChannel.delete(this);
          criticalChannels.delete(this);
        }
      });
    };

    const nativeCastPre = CastTest.prototype.runPreEffects;
    CastTest.prototype.runPreEffects = async function(...args) {
      const item = nativeItem.call(this);
      if (isOwnedSpell(item, this.actor) && !this.context[CONTEXT_KEY]) {
        const lore = getLore(item);
        const pool = getPool(this.actor, lore);
        const historic = !!(this.context.reroll || this.context.edited);
        // Snapshot at roll time, not when a dialog was opened. Re-rolls keep that snapshot.
        if (!historic) {
          this.preData.itemData ||= item.toObject();
          this.preData.itemData.system.cn.SL = pool.sl;
        }
        this.context[CONTEXT_KEY] = { lore, epoch: pool.epoch, revision: pool.revision, critical: pool.critical, consumed: historic };
      }
      return nativeCastPre.apply(this, args);
    };

    const nativeCastPost = CastTest.prototype.postTest;
    CastTest.prototype.postTest = async function(...args) {
      const item = nativeItem.call(this);
      if (!isOwnedSpell(item, this.actor)) return nativeCastPost.apply(this, args);
      return queue(this.actor, async () => {
        // Native postTest still consumes ingredients and applies its other post-roll rules.
        // Its per-item clear is replaced below, including when WoM is enabled.
        suppressNativeClear.add(this);
        let result;
        try { result = await nativeCastPost.apply(this, args); }
        finally { suppressNativeClear.delete(this); }

        const snapshot = this.context[CONTEXT_KEY];
        if (!snapshot || snapshot.consumed) return result;
        const keepOnFailure = setting("homebrew").mooCastAfterChannelling && this.result.castOutcome !== "success";
        if (keepOnFailure) {
          if (this.preData.itemData?.system.cn.SL > 0 && this.result.castOutcome === "failure") {
            this.result.other.push(game.i18n.localize("MOO.FailedCast"));
          }
          return result;
        }
        const pool = getPool(this.actor, snapshot.lore);
        if (pool.epoch === snapshot.epoch && pool.revision === snapshot.revision) {
          await savePool(this.actor, snapshot.lore, { sl: 0, epoch: pool.epoch + 1, revision: pool.revision + 1, critical: false });
        }
        snapshot.consumed = true;
        return result;
      });
    };
  }

  function renderPool(app, html) {
    const actor = app.actor || (app.document?.documentName === "Actor" ? app.document : null);
    const root = html?.querySelectorAll ? html : html?.[0];
    const list = root?.querySelector('.sheet-list.spells');
    if (!actor || !list) return;
    const header = list.querySelector(':scope > .list-header');
    if (!header) return;
    list.querySelector(':scope > .wfrp4pr-channel-pools')?.remove();
    const rows = Array.from(list.querySelectorAll(':scope > .list-content > .list-row'));
    const lores = new Set();
    let allPooled = rows.length > 0;
    for (const row of rows) {
      const item = Array.from(actor.items).find(item => item.uuid === row.dataset.uuid);
      const lore = getLore(item);
      if (!lore) { allPooled = false; continue; }
      lores.add(lore);
      row.querySelector(':scope > .progress-bar')?.remove();
      const counter = row.querySelector('[data-path="system.cn.SL"]');
      if (counter) {
        const placeholder = document.createElement('span');
        placeholder.className = 'tiny wfrp4pr-pooled-sl';
        counter.replaceWith(placeholder);
      }
    }
    if (!lores.size) return;
    const slHeader = Array.from(header.children).filter(node => node.classList.contains('tiny'))[1];
    if (slHeader) slHeader.classList.toggle('wfrp4pr-pool-hidden', allPooled);
    for (const cell of list.querySelectorAll('.wfrp4pr-pooled-sl')) cell.classList.toggle('wfrp4pr-pool-hidden', allPooled);

    const pools = document.createElement('div');
    pools.className = 'wfrp4pr-channel-pools';
    for (const lore of lores) {
      const pool = getPool(actor, lore);
      const bar = document.createElement('div');
      bar.className = 'wfrp4pr-channel-pool';
      bar.dataset.lore = lore;
      const label = document.createElement('label');
      label.textContent = `${loreLabel(lore)} — ${localize('Label')}`;
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.step = '1';
      input.value = String(pool.sl);
      input.disabled = !actor.isOwner;
      input.setAttribute('aria-label', `${loreLabel(lore)} — ${localize('Label')}`);
      label.append(input, document.createTextNode(game.i18n.localize('SL')));
      input.addEventListener('change', async event => {
        event.stopPropagation();
        if (input.disabled) return;
        const sl = input.value === '' ? NaN : Number(input.value);
        input.disabled = true;
        try { await setPool(actor, lore, sl); }
        catch (error) { input.value = String(getPool(actor, lore).sl); ui.notifications.error(error.message); }
        finally { input.disabled = !actor.isOwner; }
      });
      const track = document.createElement('div');
      track.className = 'progress-bar wfrp4pr-pool-track';
      track.setAttribute('aria-hidden', 'true');
      const fill = document.createElement('div');
      fill.className = `fill ${lore}`;
      // A segment is one SL; the numeric total stays exact even beyond the visible track.
      fill.style.width = `min(100%, ${pool.sl * 12}px)`;
      track.append(fill);
      bar.append(label, track);
      pools.append(bar);
    }
    header.after(pools);
  }

  Hooks.once('ready', () => {
    try {
      patchTests();
      (game.modules.get(MODULE_ID).api ||= {}).channelPool = { get: getPool, set: setPool, getLore };
      Hooks.on('renderApplicationV2', renderPool);
      Hooks.on('renderActorSheet', renderPool);
      Hooks.on('renderChatMessageHTML', (message, html) => {
        const test = message.system?.test;
        if (!test?.context?.[CONTEXT_KEY] || test.preData?.rollClass !== 'ChannelTest') return;
        const row = html.querySelector?.('.hide-spellcn');
        const label = Array.from(row?.childNodes || []).find(node => node.nodeType === 3 && node.textContent.trim());
        if (label) label.textContent = localize('Label') + ': ';
      });
    } catch (error) {
      console.error(`${MODULE_ID} | Channel pool initialization failed`, error);
      ui.notifications.error(localize('UnsupportedVersion'));
    }
  });
})();
