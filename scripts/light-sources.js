(() => {
  const ID = "wfrp4-personnal-rules";
  const CONFIG_KEY = "lightSource";
  const STATE_KEY = "activeLight";
  const TYPES = new Set(["trapping", "weapon", "armour", "ammunition", "container"]);
  const queues = new Map();
  const sheets = new Map();
  const t = key => game.i18n.localize("WFRP4PR.Light." + key);
  const fail = key => { throw new Error(t(key)); };
  const clone = value => foundry.utils.deepClone(value);

  function getConfig(item) {
    const data = item?.getFlag(ID, CONFIG_KEY) || {};
    return { enabled: data.enabled === true, bright: Number(data.bright ?? 0), dim: Number(data.dim ?? 0) };
  }

  function validateConfig(data) {
    const config = { enabled: data.enabled === true, bright: Number(data.bright), dim: Number(data.dim) };
    if (![config.bright, config.dim].every(value => Number.isFinite(value) && value >= 0)
      || config.bright > config.dim || (config.enabled && config.dim <= 0)) fail("InvalidRange");
    return config;
  }

  async function configure(item, data) {
    if (!game.user.isGM || !item?.isOwner || !TYPES.has(item.type)) fail("NoPermission");
    const config = validateConfig(data);
    await item.setFlag(ID, CONFIG_KEY, config);
    return config;
  }

  function belongsTo(token, actor) {
    return !!token?.actor && token.actor.uuid === actor?.uuid;
  }

  function resolveToken(actor) {
    if (!actor) fail("NoActor");
    const controlled = Array.from(canvas.tokens?.controlled || [])
      .map(token => token.document).filter(token => belongsTo(token, actor));
    if (controlled.length === 1) return controlled[0];
    if (controlled.length > 1) fail("ChooseToken");
    const tokens = Array.from(canvas.scene?.tokens || []).filter(token => belongsTo(token, actor));
    if (tokens.length === 1) return tokens[0];
    fail(tokens.length ? "ChooseToken" : "NoToken");
  }

  function stateOf(token) {
    return token.getFlag(ID, STATE_KEY);
  }

  function isActive(token, item) {
    const state = token && stateOf(token);
    return state?.itemId === item.id && state.actorUuid === item.actor?.uuid;
  }

  function enqueue(token, task) {
    const key = token.uuid;
    const operation = (queues.get(key) || Promise.resolve()).catch(() => {}).then(task);
    queues.set(key, operation);
    operation.finally(() => {
      if (queues.get(key) === operation) queues.delete(key);
    }).catch(() => {});
    return operation;
  }

  // Restore only radii we still control. Preserve manual changes, colour,
  // animation, vision and every other token setting.
  function originalRadii(token) {
    const state = stateOf(token);
    return Object.fromEntries(["bright", "dim"].map(key => {
      const current = Number(token.light?.[key] || 0);
      return [key, state && current === state.applied[key] ? state.base[key] : current];
    }));
  }

  async function extinguish(token) {
    if (!stateOf(token)) return;
    const base = originalRadii(token);
    await token.update({
      "light.bright": base.bright, "light.dim": base.dim,
      ["flags." + ID + ".-=" + STATE_KEY]: null
    });
  }

  async function illuminate(token, item) {
    const config = validateConfig(getConfig(item));
    if (!config.enabled) fail("NotSource");
    const quantity = Number(item.system?.quantity?.value ?? 1);
    if (!Number.isFinite(quantity) || quantity <= 0) fail("Empty");
    const applied = { bright: config.bright, dim: config.dim };
    await token.update({
      "light.bright": applied.bright, "light.dim": applied.dim,
      ["flags." + ID + "." + STATE_KEY]: {
        itemId: item.id, actorUuid: item.actor.uuid,
        base: originalRadii(token), applied: clone(applied)
      }
    });
  }

  async function toggle(item) {
    const actor = item?.actor;
    if (!actor?.isOwner || !item?.isOwner) fail("NoPermission");
    const token = resolveToken(actor);
    if (!token.canUserModify(game.user, "update")) fail("NoPermission");
    return enqueue(token, async () => {
      if (isActive(token, item)) await extinguish(token);
      else await illuminate(token, item);
      refreshButtons();
    });
  }

  async function syncItem(item, deleted = false) {
    if (!item.actor) return;
    // Only runs on relevant item changes, not on every frame or token movement.
    const tokens = Array.from(game.scenes || []).flatMap(scene => Array.from(scene.tokens || []))
      .filter(token => belongsTo(token, item.actor) && isActive(token, item));
    await Promise.all(tokens.map(token => enqueue(token, async () => {
      if (!isActive(token, item) || !token.canUserModify(game.user, "update")) return;
      if (deleted || !getConfig(item).enabled || Number(item.system?.quantity?.value ?? 1) <= 0) {
        await extinguish(token);
      } else {
        await illuminate(token, item);
      }
    })));
    refreshButtons();
  }

  function rootOf(app, html) {
    return [app.element, html].map(node => node?.querySelectorAll ? node : node?.[0])
      .find(node => node?.nodeType === 1 && node.isConnected);
  }

  function makeButton(item, compact = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wfrp4pr-light-toggle" + (compact ? " wfrp4pr-light-compact" : "");
    button.dataset.lightItem = item.id;
    button.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      button.disabled = true;
      try { await toggle(item); }
      catch (error) { ui.notifications.warn(error.message); }
      finally { button.disabled = false; refreshButtons(); }
    });
    return button;
  }

  function refreshButtons() {
    for (const [app, entry] of sheets) {
      if (!entry.root.isConnected) { sheets.delete(app); continue; }
      for (const button of entry.root.querySelectorAll(".wfrp4pr-light-toggle")) {
        const item = entry.item || entry.actor?.items.get(button.dataset.lightItem);
        if (!item) continue;
        let token;
        try { token = resolveToken(item.actor); } catch { /* No token yet, explain on click. */ }
        const active = isActive(token, item);
        if (button.classList.contains("wfrp4pr-light-compact")) {
          const icon = document.createElement("i");
          icon.className = active ? "fa-solid fa-lightbulb" : "fa-regular fa-lightbulb";
          button.replaceChildren(icon);
        } else button.textContent = t(active ? "Off" : "On");
        button.title = item.name + " — " + t(active ? "Off" : "On");
        button.setAttribute("aria-label", button.title);
        button.setAttribute("aria-pressed", String(active));
      }
    }
  }

  function renderSheet(app, html) {
    const root = rootOf(app, html);
    if (!root) return;
    const item = app.item || (app.document?.documentName === "Item" ? app.document : null);
    if (item && TYPES.has(item.type)) {
      const target = root.querySelector('section[data-tab="details"]');
      if (!target) return;
      root.querySelector(".wfrp4pr-light-config")?.remove();
      const config = getConfig(item);
      if (!game.user.isGM && !config.enabled) return;
      const section = document.createElement("fieldset");
      section.className = "wfrp4pr-light-config";
      // Item sheets auto-submit native fields on change. Keep our draft local
      // until Save, otherwise that re-render would discard unsaved radii.
      section.addEventListener("change", event => event.stopPropagation());
      const legend = document.createElement("legend");
      legend.textContent = t("Title");
      section.append(legend);
      if (game.user.isGM && item.isOwner) {
        for (const [key, label] of [["enabled", "Enabled"], ["bright", "Bright"], ["dim", "Dim"]]) {
          const row = document.createElement("label");
          const title = document.createElement("span");
          title.textContent = t(label);
          const input = document.createElement("input");
          input.dataset.lightField = key; // No name: do not join native sheet auto-submit.
          input.type = key === "enabled" ? "checkbox" : "number";
          if (key === "enabled") input.checked = config.enabled;
          else { input.min = "0"; input.step = "any"; input.value = String(config[key]); }
          row.append(title, input);
          section.append(row);
        }
        const save = document.createElement("button");
        save.type = "button";
        save.textContent = t("Save");
        save.addEventListener("click", async event => {
          event.preventDefault(); event.stopPropagation();
          save.disabled = true;
          try {
            const value = key => section.querySelector('[data-light-field="' + key + '"]');
            await configure(item, { enabled: value("enabled").checked, bright: value("bright").value, dim: value("dim").value });
            app.render(false);
          } catch (error) { ui.notifications.warn(error.message); }
          finally { save.disabled = false; }
        });
        section.append(save);
      } else {
        const ranges = document.createElement("p");
        ranges.textContent = t("Bright") + ": " + config.bright + " / " + t("Dim") + ": " + config.dim;
        section.append(ranges);
      }
      const hint = document.createElement("p");
      hint.className = "notes";
      hint.textContent = t("Hint");
      section.append(hint);
      if (config.enabled && item.actor?.isOwner && item.isOwner) section.append(makeButton(item));
      target.append(section);
      sheets.set(app, { root, item });
    } else {
      const actor = app.actor || (app.document?.documentName === "Actor" ? app.document : null);
      if (!actor?.isOwner) return;
      for (const button of root.querySelectorAll(".wfrp4pr-light-toggle")) button.remove();
      for (const row of root.querySelectorAll(".sheet-list.inventory .list-row[data-uuid]")) {
        const entry = Array.from(actor.items).find(item => item.uuid === row.dataset.uuid);
        if (!entry || !getConfig(entry).enabled) continue;
        const controls = row.querySelector(".row-content .list-controls");
        controls?.prepend(makeButton(entry, true));
      }
      sheets.set(app, { root, actor });
    }
    refreshButtons();
  }

  Hooks.once("ready", () => {
    (game.modules.get(ID).api ||= {}).lightSources = { configure, toggle, getConfig };
    Hooks.on("renderApplicationV2", renderSheet);
    Hooks.on("renderItemSheet", renderSheet);
    Hooks.on("renderActorSheet", renderSheet);
    for (const hook of ["closeApplication", "closeApplicationV2"]) Hooks.on(hook, app => sheets.delete(app));
    for (const hook of ["updateToken", "controlToken", "canvasReady"]) Hooks.on(hook, refreshButtons);
    Hooks.on("updateItem", (item, changes, options, userId) => {
      if (userId !== game.user.id) return;
      if (!foundry.utils.hasProperty(changes, "flags." + ID + "." + CONFIG_KEY)
        && !foundry.utils.hasProperty(changes, "system.quantity.value")) return;
      return syncItem(item).catch(error => ui.notifications.error(error.message));
    });
    Hooks.on("deleteItem", (item, options, userId) => {
      if (userId === game.user.id) return syncItem(item, true).catch(error => ui.notifications.error(error.message));
    });
  });
})();
