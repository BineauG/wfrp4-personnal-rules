// Keep native WFRP4E tests and rules; replace only their channelled-SL storage.
(() => {
  const MODULE_ID = "wfrp4-personnal-rules";
  const CONTEXT_KEY = "wfrp4prChannelPool";
  const SKILL_CONTEXT_KEY = "wfrp4prChannelSkill";
  const queues = new WeakMap();
  const pendingChannel = new WeakMap();
  const suppressNativeClear = new WeakSet();
  const criticalChannels = new WeakSet();
  const poolMenuRoots = new WeakMap();

  const setting = key => game.settings.get("wfrp4e", key);
  const localize = key => game.i18n.localize(`WFRP4PR.ChannelPool.${key}`);
  const flagKey = lore => `channelPools.lore-${lore}`;
  const hiddenFlagKey = lore => `hiddenChannelPools.lore-${lore}`;
  const loreLabel = lore => game.i18n.localize(game.wfrp4e.config.magicLores[lore] || lore);

  function getLore(item) {
    if (item?.type !== "spell" || item.system.ritual?.value) return null;
    const value = item.system.lore?.value;
    const lores = Array.isArray(value) ? value : [value];
    const lore = lores.includes(item.system.lore?.chosen) ? item.system.lore.chosen : lores[0];
    return typeof lore === "string" && lore !== "petty" && /^[a-z][a-z0-9_-]*$/.test(lore) ? lore : null;
  }

  const normalize = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();

  function channelSkillWind(skill) {
    if (skill?.type !== "skill") return null;
    const match = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(skill.name || "");
    const base = normalize(match ? match[1] : skill.name);
    const names = ["channelling", "channeling", normalize(game.i18n.localize("NAME.Channelling"))];
    if (!names.includes(base)) return null;
    return normalize(skill.specifier || match?.[2]);
  }

  function storedLores(actor) {
    return Object.keys(actor.getFlag(MODULE_ID, "channelPools") || {}).filter(key => /^lore-[a-z][a-z0-9_-]*$/.test(key)).map(key => key.slice(5));
  }

  function getSkillLore(actor, skill) {
    const wind = channelSkillWind(skill);
    if (!wind || wind === "none") return null;
    const matches = Object.entries(game.wfrp4e.config.magicWind || {}).filter(([lore, name]) => lore !== "petty" && /^[a-z][a-z0-9_-]*$/.test(lore) && [name, game.i18n.localize(name), lore, loreLabel(lore)].some(value => normalize(value) === wind)).map(([lore]) => lore);
    if (matches.length === 1) return matches[0];
    const known = new Set([...storedLores(actor), ...Array.from(actor.items || []).map(getLore).filter(Boolean)]);
    const owned = matches.filter(lore => known.has(lore));
    return owned.length === 1 ? owned[0] : null;
  }

  function getChannelSkill(actor, lore) {
    return Array.from(actor.items || []).find(item => getSkillLore(actor, item) === lore) || null;
  }

  function actorLores(actor) {
    const lores = [...storedLores(actor), ...Array.from(actor.items || []).flatMap(item => [getLore(item), getSkillLore(actor, item)].filter(Boolean))];
    return new Set(lores.filter(lore => !actor.getFlag(MODULE_ID, hiddenFlagKey(lore))));
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
    if (pool.sl > 0 && actor.getFlag(MODULE_ID, hiddenFlagKey(lore))) {
      await actor.setFlag(MODULE_ID, hiddenFlagKey(lore), false);
    }
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
    if (!actorLores(actor).has(lore)) throw new Error(localize("NoLore"));
    return queue(actor, () => {
      const current = getPool(actor, lore);
      return savePool(actor, lore, { sl, epoch: current.epoch + 1, revision: current.revision + 1, critical: false });
    });
  }

  function stepPool(actor, lore, delta) {
    if (!actor.isOwner) return Promise.reject(new Error(localize("NoPermission")));
    return queue(actor, () => {
      const current = getPool(actor, lore);
      return savePool(actor, lore, { ...current, sl: Math.max(0, current.sl + delta), epoch: current.epoch + 1, revision: current.revision + 1, critical: false });
    });
  }

  function removePool(actor, lore) {
    if (!actor.isOwner) return Promise.reject(new Error(localize("NoPermission")));
    return queue(actor, async () => {
      const current = getPool(actor, lore);
      await savePool(actor, lore, { sl: 0, epoch: current.epoch + 1, revision: current.revision + 1, critical: false });
      await actor.setFlag(MODULE_ID, hiddenFlagKey(lore), true);
    });
  }

  async function rollPool(actor, lore) {
    if (!actor.isOwner) throw new Error(localize("NoPermission"));
    const skill = getChannelSkill(actor, lore);
    if (!skill) throw new Error(localize("NoSkill"));
    const test = await actor.setupSkill(skill, {
      skipTargets: true,
      title: game.i18n.localize("ChannellingTest") + " - " + lore.charAt(0).toUpperCase() + lore.slice(1)
    });
    return test?.roll();
  }

  function patchSkillTests(SkillTest) {
    const nativePost = SkillTest.prototype.postTest;
    SkillTest.prototype.postTest = async function(...args) {
      const result = await nativePost.apply(this, args);
      const skill = this.item;
      if (!this.actor?.isOwner || channelSkillWind(skill) === null || this.context.unopposed) return result;
      const previous = this.context[SKILL_CONTEXT_KEY];
      const lore = previous?.lore || getSkillLore(this.actor, skill);
      if (!lore) { if (this.succeeded) ui.notifications.warn(localize("UnknownWind")); return result; }
      if (!previous && (this.context.reroll || this.context.edited)) return result;
      return queue(this.actor, async () => {
        const pool = getPool(this.actor, lore);
        if (previous && previous.epoch !== pool.epoch) return result;
        const contribution = this.succeeded ? Math.max(0, Number(this.result.SL)) : 0;
        if (!Number.isSafeInteger(contribution)) throw new Error(localize("InvalidSL"));
        const delta = contribution - (previous?.contribution || 0);
        if (delta !== 0) await savePool(this.actor, lore, { ...pool, sl: Math.max(0, pool.sl + delta), revision: pool.revision + 1 });
        this.context[SKILL_CONTEXT_KEY] = { lore, epoch: pool.epoch, contribution };
        return result;
      });
    };
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
    const { TestWFRP, ChannelTest, CastTest, SkillTest } = game.wfrp4e.rolls;
    const nativeItem = Object.getOwnPropertyDescriptor(TestWFRP.prototype, "item")?.get;
    if (!nativeItem || !ChannelTest.prototype.updateChannelledItems || !CastTest.prototype.postTest || !SkillTest?.prototype.postTest) {
      throw new Error(localize("UnsupportedVersion"));
    }
    patchSkillTests(SkillTest);
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

  function registerPoolContextMenu(app) {
    if (poolMenuRoots.get(app) === app.element) return;
    if (typeof app._createContextMenu !== "function") throw new Error(localize("UnsupportedVersion"));
    app._createContextMenu(() => [{
      name: localize("Remove"),
      icon: '<i class="fas fa-times"></i>',
      condition: target => {
        const actor = app.actor || (app.document?.documentName === "Actor" ? app.document : null);
        return !!actor?.isOwner && !!target.closest(".wfrp4pr-channelling .list-row[data-lore]");
      },
      callback: async target => {
        const actor = app.actor || (app.document?.documentName === "Actor" ? app.document : null);
        const row = target.closest(".wfrp4pr-channelling .list-row[data-lore]");
        if (!actor || !row) return;
        try {
          await removePool(actor, row.dataset.lore);
          const content = row.parentElement;
          row.remove();
          if (!content?.querySelector(":scope > .list-row")) content?.closest(".wfrp4pr-channelling")?.remove();
        } catch (error) {
          ui.notifications.error(error.message);
        }
      }
    }], ".wfrp4pr-pool-menu-trigger", { eventName: "click", jQuery: false, fixed: true });
    poolMenuRoots.set(app, app.element);
  }

  function renderPool(app, html) {
    const actor = app.actor || (app.document?.documentName === "Actor" ? app.document : null);
    const root = html?.querySelectorAll ? html : html?.[0];
    const list = root?.querySelector(".sheet-list.spells");
    if (!actor || !list) return;
    const header = list.querySelector(":scope > .list-header");
    if (!header) return;

    root.querySelector(".wfrp4pr-channelling")?.remove();
    const rows = Array.from(list.querySelectorAll(":scope > .list-content > .list-row"));
    const lores = actorLores(actor);
    let allPooled = rows.length > 0;
    for (const row of rows) {
      const item = Array.from(actor.items).find(item => item.uuid === row.dataset.uuid);
      const lore = getLore(item);
      if (!lore) {
        allPooled = false;
        continue;
      }
      row.querySelector(":scope > .progress-bar")?.remove();
      const counter = row.querySelector('[data-path="system.cn.SL"]');
      if (counter) {
        const placeholder = document.createElement("span");
        placeholder.className = "tiny wfrp4pr-pooled-sl";
        counter.replaceWith(placeholder);
      }
    }
    const slHeader = Array.from(header.children).filter(node => node.classList.contains("tiny"))[1];
    if (slHeader) slHeader.classList.toggle("wfrp4pr-pool-hidden", allPooled);
    for (const cell of list.querySelectorAll(".wfrp4pr-pooled-sl")) {
      cell.classList.toggle("wfrp4pr-pool-hidden", allPooled);
    }
    if (!lores.size) return;

    const section = document.createElement("div");
    section.className = "sheet-list wfrp4pr-channelling";
    const sectionHeader = document.createElement("div");
    sectionHeader.className = "list-header row-content";
    const title = document.createElement("div");
    title.className = "list-name";
    title.textContent = localize("Heading");
    const ingredientSpacer = document.createElement("div");
    ingredientSpacer.className = "flex";
    const cnSpacer = document.createElement("div");
    cnSpacer.className = "tiny";
    const slTitle = document.createElement("div");
    slTitle.className = "tiny";
    slTitle.textContent = "SL";
    const controlsSpacer = document.createElement("div");
    controlsSpacer.className = "list-controls";
    sectionHeader.append(title, ingredientSpacer, cnSpacer, slTitle, controlsSpacer);

    if (actor.isOwner) registerPoolContextMenu(app);

    const content = document.createElement("div");
    content.className = "list-content";
    for (const lore of lores) {
      const row = document.createElement("div");
      row.className = "list-row nocontext";
      row.dataset.lore = lore;
      const line = document.createElement("div");
      line.className = "row-content";

      const name = document.createElement("div");
      name.className = "list-name wfrp4pr-lore-name";
      const displayName = lore.charAt(0).toUpperCase() + lore.slice(1);
      const image = document.createElement("img");
      image.className = "wfrp4pr-lore-image";
      image.src = "modules/wfrp4e-core/icons/spells/" + lore + ".png";
      image.alt = "";
      const skill = getChannelSkill(actor, lore);
      const label = document.createElement(actor.isOwner && skill ? "a" : "span");
      label.className = "label" + (actor.isOwner && skill ? " wfrp4pr-lore-test" : "");
      label.textContent = displayName;
      if (actor.isOwner && skill) {
        label.setAttribute("role", "button");
        label.tabIndex = 0;
        label.setAttribute("aria-label", localize("Roll") + " " + displayName);
        const roll = async event => {
          if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          if (label.dataset.rolling) return;
          label.dataset.rolling = "true";
          try {
            await rollPool(actor, lore);
          } catch (error) {
            ui.notifications.error(error.message);
          } finally {
            delete label.dataset.rolling;
          }
        };
        label.addEventListener("click", roll);
        label.addEventListener("keydown", roll);
      }
      name.append(image, label);

      const ingredient = document.createElement("div");
      ingredient.className = "flex";
      const cn = document.createElement("div");
      cn.className = "tiny";
      const counter = document.createElement(actor.isOwner ? "a" : "span");
      counter.className = "tiny prevent-context wfrp4pr-pool-counter";
      counter.textContent = String(getPool(actor, lore).sl);
      counter.setAttribute("aria-label", displayName + " — SL");
      if (actor.isOwner) {
        counter.setAttribute("role", "button");
        counter.tabIndex = 0;
        const step = async event => {
          if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          const delta = (event.type === "contextmenu" ? -1 : 1) * (event.ctrlKey ? 10 : 1);
          try {
            await stepPool(actor, lore, delta);
            counter.textContent = String(getPool(actor, lore).sl);
          } catch (error) {
            ui.notifications.error(error.message);
          }
        };
        counter.addEventListener("click", step);
        counter.addEventListener("contextmenu", step);
        counter.addEventListener("keydown", step);
      }

      const controls = document.createElement("div");
      controls.className = "list-controls";
      if (actor.isOwner) {
        const trigger = document.createElement("a");
        trigger.className = "list-control wfrp4pr-pool-menu-trigger";
        trigger.setAttribute("aria-label", localize("Menu"));
        trigger.innerHTML = '<i class="fa-regular fa-ellipsis-vertical"></i>';
        controls.append(trigger);
      }

      line.append(name, ingredient, cn, counter, controls);
      row.append(line);
      content.append(row);
    }
    section.append(sectionHeader, content);
    list.before(section);
  }

  Hooks.once('ready', () => {
    try {
      patchTests();
      (game.modules.get(MODULE_ID).api ||= {}).channelPool = { get: getPool, set: setPool, step: stepPool, remove: removePool, roll: rollPool, getLore };
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
