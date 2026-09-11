const MODULE_ID = "wfrp4-personnal-rules";
const ITEM_PILES_ID = "item-piles";
const SOCKET_TRADE = "executeMerchantTrade";
const SOCKET_DOOR = "executeDoorAction";

const ITEM_PILE_DATA = `flags.${ITEM_PILES_ID}.data`;
const ITEM_PILE_ITEM = `flags.${ITEM_PILES_ID}.item`;
const MODULE_AVAILABILITY = `flags.${MODULE_ID}.availability`;
const MODULE_SETTLEMENT = `flags.${MODULE_ID}.settlement`;
const MODULE_NEGOTIATION_DISABLED = `flags.${MODULE_ID}.negotiationDisabled`;
const MODULE_DOOR = `flags.${MODULE_ID}.door`;

let socket = null;
let originalTradeItems = null;
const pendingAvailability = new Map();
const pendingDoorDialogs = new Set();
let gmTradeQueue = Promise.resolve();

Hooks.once("init", () => {
  registerSettings();
  applyTzeentchLorePatch();
});

Hooks.once("socketlib.ready", () => {
  registerSocket();
});

Hooks.once("ready", () => {
  registerSocket();
  patchItemPilesTrade();
  registerMerchantConfigHooks();
  registerAvailabilityHooks();
  registerDoorHooks();
  applyDifficultyPatch();
  applyTzeentchLorePatch();

  game.modules.get(MODULE_ID).api = {
    rollAvailability: (actor, options = {}) => rollAvailabilityForActor(resolveActor(actor), options),
    negotiateTrade: executeMerchantTradeAsGM,
    configureDoor: configureDoor
  };
});

function registerSettings() {
  game.settings.register(MODULE_ID, "enableNegotiation", {
    name: "WFRP4PR.Settings.EnableNegotiation.Name",
    hint: "WFRP4PR.Settings.EnableNegotiation.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "autoMerchantOpposedRoll", {
    name: "WFRP4PR.Settings.AutoMerchantOpposedRoll.Name",
    hint: "WFRP4PR.Settings.AutoMerchantOpposedRoll.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, "autoAvailability", {
    name: "WFRP4PR.Settings.AutoAvailability.Name",
    hint: "WFRP4PR.Settings.AutoAvailability.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "settlement", {
    name: "WFRP4PR.Settings.Settlement.Name",
    hint: "WFRP4PR.Settings.Settlement.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "MARKET.Town",
    choices: {
      "MARKET.Village": "WFRP4PR.Settlement.Village",
      "MARKET.Town": "WFRP4PR.Settlement.Town",
      "MARKET.City": "WFRP4PR.Settlement.City"
    }
  });

  game.settings.register(MODULE_ID, "availabilityModifier", {
    name: "WFRP4PR.Settings.AvailabilityModifier.Name",
    hint: "WFRP4PR.Settings.AvailabilityModifier.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 0
  });

  game.settings.register(MODULE_ID, "hideUnavailable", {
    name: "WFRP4PR.Settings.HideUnavailable.Name",
    hint: "WFRP4PR.Settings.HideUnavailable.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, "chatAvailability", {
    name: "WFRP4PR.Settings.ChatAvailability.Name",
    hint: "WFRP4PR.Settings.ChatAvailability.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "enableDoorActions", {
    name: "WFRP4PR.Settings.EnableDoorActions.Name",
    hint: "WFRP4PR.Settings.EnableDoorActions.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, "doorDefaultLockDifficulty", {
    name: "WFRP4PR.Settings.DoorDefaultLockDifficulty.Name",
    hint: "WFRP4PR.Settings.DoorDefaultLockDifficulty.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "average",
    choices: difficultyChoices()
  });

  game.settings.register(MODULE_ID, "doorDefaultLockSL", {
    name: "WFRP4PR.Settings.DoorDefaultLockSL.Name",
    hint: "WFRP4PR.Settings.DoorDefaultLockSL.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 0
  });

  game.settings.register(MODULE_ID, "doorDefaultTB", {
    name: "WFRP4PR.Settings.DoorDefaultTB.Name",
    hint: "WFRP4PR.Settings.DoorDefaultTB.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 4
  });

  game.settings.register(MODULE_ID, "doorDefaultWounds", {
    name: "WFRP4PR.Settings.DoorDefaultWounds.Name",
    hint: "WFRP4PR.Settings.DoorDefaultWounds.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 10
  });

  game.settings.register(MODULE_ID, "doorBashDifficulty", {
    name: "WFRP4PR.Settings.DoorBashDifficulty.Name",
    hint: "WFRP4PR.Settings.DoorBashDifficulty.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "challenging",
    choices: difficultyChoices()
  });

}

function applyDifficultyPatch() {
  if (!game.wfrp4e?.config) return;

  game.wfrp4e.config.difficultyModifiers = {
    veasy: 60,
    easy: 40,
    banal: 30,
    average: 20,
    medium: 10,
    challenging: 0,
    difficult: -10,
    hard: -20,
    vhard: -30,
    doom: -40,
    impossible: -50
  };

  game.wfrp4e.config.difficultyLabels = {
    veasy: "Tr\u00e8s Facile (+60)",
    easy: "Facile (+40)",
    banal: "Banal (+30)",
    average: "Accessible (+20)",
    medium: "Faisable (+10)",
    challenging: "Interm\u00e9diaire (+0)",
    difficult: "Complexe (-10)",
    hard: "Difficile (-20)",
    vhard: "Tr\u00e8s Difficile (-30)",
    doom: "Maudit (-40)",
    impossible: "Impossible (-50)"
  };

}

function applyTzeentchLorePatch() {
  const config = game.wfrp4e?.config;
  if (!config) return;

  config.loreEffects ||= {};
  const nameKey = "WFRP4PR.Lore.Tzeentch.Name";
  const localizedName = game.i18n.localize(nameKey);
  const effectName = localizedName === nameKey ? "Lore of Tzeentch" : localizedName;

  config.loreEffects.tzeentch = {
    name: effectName,
    img: "modules/wfrp4e-core/icons/spells/tzeentch.png",
    system: {
      transferData: { type: "target" },
      scriptData: [
        {
          trigger: "immediate",
          label: "@effect.name",
          script: tzeentchLoreScript(),
          options: { deleteEffect: true }
        }
      ]
    },
    flags: {
      wfrp4e: { lore: true },
      [MODULE_ID]: { injectedLoreEffect: "tzeentch" }
    }
  };
}

function tzeentchLoreScript() {
  return `
const actor = this.actor;
const actorName = foundry.utils.escapeHTML?.(actor.name) || actor.name;
const test = await actor.setupSkill(game.i18n.localize("NAME.Endurance"), {
  appendTitle: " - " + this.effect.name,
  skipTargets: true,
  fields: { difficulty: "challenging" },
  context: {
    success: game.i18n.localize("WFRP4PR.Lore.Tzeentch.TestSuccess"),
    failure: game.i18n.localize("WFRP4PR.Lore.Tzeentch.TestFailure")
  }
});
if (!test) return;
await test.roll();
if (!test.result) return;

if (test.failed) {
  const corruption = Number(actor.system.status.corruption?.value || 0);
  await actor.update({ "system.status.corruption.value": corruption + 1 });
  this.script.message(game.i18n.format("WFRP4PR.Lore.Tzeentch.CorruptionGained", { actor: actorName }));
}
else {
  const fortune = Number(actor.system.status.fortune?.value || 0);
  await actor.update({ "system.status.fortune.value": fortune + 1 });
  this.script.message(game.i18n.format("WFRP4PR.Lore.Tzeentch.FortuneGained", { actor: actorName }));
}
`;
}

function difficultyOptions() {
  return [
    ["veasy", "WFRP4PR.Difficulty.VEasy"],
    ["easy", "WFRP4PR.Difficulty.Easy"],
    ["banal", "WFRP4PR.Difficulty.Banal"],
    ["average", "WFRP4PR.Difficulty.Average"],
    ["medium", "WFRP4PR.Difficulty.Medium"],
    ["challenging", "WFRP4PR.Difficulty.Challenging"],
    ["difficult", "WFRP4PR.Difficulty.Difficult"],
    ["hard", "WFRP4PR.Difficulty.Hard"],
    ["vhard", "WFRP4PR.Difficulty.VHard"],
    ["doom", "WFRP4PR.Difficulty.Doom"],
    ["impossible", "WFRP4PR.Difficulty.Impossible"]
  ];
}

function difficultyChoices() {
  return Object.fromEntries(difficultyOptions());
}

function registerSocket() {
  if (socket || !globalThis.socketlib?.registerModule) return;
  socket = socketlib.registerModule(MODULE_ID);
  socket.register(SOCKET_TRADE, queueMerchantTradeAsGM);
  socket.register(SOCKET_DOOR, executeDoorActionAsGM);
}

function settlementOptions() {
  return [
    ["MARKET.Village", "WFRP4PR.Settlement.Village"],
    ["MARKET.Town", "WFRP4PR.Settlement.Town"],
    ["MARKET.City", "WFRP4PR.Settlement.City"]
  ];
}

function getMerchantSettlement(actor) {
  return actor?.getFlag?.(MODULE_ID, "settlement") || game.settings.get(MODULE_ID, "settlement");
}

function isActorNegotiationEnabled(actor) {
  return getProperty(actor, MODULE_NEGOTIATION_DISABLED, false) !== true;
}

function patchItemPilesTrade() {
  const api = game.itempiles?.API;
  if (!api?.tradeItems || originalTradeItems) return;

  originalTradeItems = api.tradeItems.bind(api);
  api.tradeItems = async function wfrp4PersonnalRulesTradeItems(seller, buyer, items, options = {}) {
    if (!game.settings.get(MODULE_ID, "enableNegotiation")) {
      return originalTradeItems(seller, buyer, items, options);
    }

    const sellerActor = resolveActor(seller);
    const buyerActor = resolveActor(buyer);
    const sellerIsMerchant = isItemPilesMerchant(sellerActor);
    const buyerIsMerchant = isItemPilesMerchant(buyerActor);

    if (!sellerActor || !buyerActor || sellerIsMerchant === buyerIsMerchant) {
      return originalTradeItems(seller, buyer, items, options);
    }

    if (!isActorNegotiationEnabled(sellerActor) || !isActorNegotiationEnabled(buyerActor)) {
      return originalTradeItems(seller, buyer, items, options);
    }

    if (!socket && !game.user.isGM) {
      ui.notifications.error(game.i18n.localize("WFRP4PR.Error.NoSocket"));
      return false;
    }

    try {
      const normalizedItems = normalizeTradeItems(sellerActor, items);
      const results = [];
      const isPurchase = sellerIsMerchant;

      for (const itemData of normalizedItems) {
        const item = sellerActor.items.get(itemData.itemId);
        const playerActor = isPurchase ? buyerActor : sellerActor;
        const playerSkill = await promptNegotiationChoice({
          mode: isPurchase ? "buy" : "sell",
          actor: playerActor,
          item
        });

        if (!playerSkill) return false;
        if (playerSkill === "none") {
          return originalTradeItems(seller, buyer, items, options);
        }

        const playerTest = await rollSkillWithDialog(playerActor, playerSkill, {
          mode: isPurchase ? "buy" : "sell"
        });
        if (!playerTest) return false;

        const payload = {
          sellerUuid: sellerActor.uuid,
          buyerUuid: buyerActor.uuid,
          itemId: itemData.itemId,
          quantity: itemData.quantity,
          paymentIndex: itemData.paymentIndex,
          playerSkill,
          playerTest,
          interactionId: options.interactionId || false,
          userId: game.user.id
        };

        const result = game.user.isGM
          ? await executeMerchantTradeAsGM(payload)
          : await socket.executeAsGM(SOCKET_TRADE, payload);

        if (!result) return false;
        results.push(result);
      }

      return results.length === 1 ? results[0] : { results };
    } catch (error) {
      console.error(`${MODULE_ID} | Trade failed`, error);
      ui.notifications.error(error.message || String(error));
      return false;
    }
  };
}

function registerMerchantConfigHooks() {
  Hooks.on("renderItemPileConfig", injectMerchantSettlementConfig);

  const ItemPileConfig = game.itempiles?.apps?.ItemPileConfig;
  if (!ItemPileConfig || ItemPileConfig.prototype._wfrp4prSettlementPatch) return;

  const originalRender = ItemPileConfig.prototype.render;
  ItemPileConfig.prototype.render = function wfrp4prRenderItemPileConfig(...args) {
    const result = originalRender.apply(this, args);
    setTimeout(() => injectMerchantSettlementConfig(this, this.element || this._element), 25);
    return result;
  };
  ItemPileConfig.prototype._wfrp4prSettlementPatch = true;
}

function injectMerchantSettlementConfig(app, html) {
  setTimeout(() => {
    const actor = getItemPileConfigActor(app);
    if (!actor) return;

    const root = getHtmlElement(html) || app.element || app._element;
    if (!root || root.querySelector(".wfrp4pr-negotiation-config, .wfrp4pr-settlement-config")) return;

    const merchantSettings = Array.from(root.querySelectorAll(".form-group")).find(group => {
      return group.textContent?.includes(game.i18n.localize("ITEM-PILES.Applications.ItemPileConfig.Merchant.MerchantImage"));
    }) || root.querySelector("form.item-piles-config-container .form-group");

    if (!merchantSettings) return;

    const negotiationField = document.createElement("div");
    negotiationField.className = "form-group wfrp4pr-negotiation-config";
    negotiationField.innerHTML = `
      <label>
        <span>${game.i18n.localize("WFRP4PR.MerchantConfig.NegotiationEnabled")}</span>
        <p>${game.i18n.localize("WFRP4PR.MerchantConfig.NegotiationEnabledHint")}</p>
      </label>
      <input type="checkbox" style="flex:4;">
    `;

    const negotiationInput = negotiationField.querySelector("input");
    negotiationInput.checked = isActorNegotiationEnabled(actor);
    negotiationInput.addEventListener("change", async event => {
      await actor.setFlag(MODULE_ID, "negotiationDisabled", !event.currentTarget.checked);
      ui.notifications.info(game.i18n.localize("WFRP4PR.MerchantConfig.NegotiationSaved"));
    });

    const settlementField = document.createElement("div");
    settlementField.className = "form-group wfrp4pr-settlement-config";
    settlementField.innerHTML = `
      <label>
        <span>${game.i18n.localize("WFRP4PR.MerchantConfig.Settlement")}</span>
        <p>${game.i18n.localize("WFRP4PR.MerchantConfig.SettlementHint")}</p>
      </label>
      <select style="flex:4;">
        ${settlementOptions().map(([value, label]) => {
          return `<option value="${value}">${game.i18n.localize(label)}</option>`;
        }).join("")}
      </select>
    `;

    const select = settlementField.querySelector("select");
    select.value = getMerchantSettlement(actor);
    select.addEventListener("change", async event => {
      await actor.setFlag(MODULE_ID, "settlement", event.currentTarget.value);
      ui.notifications.info(game.i18n.localize("WFRP4PR.MerchantConfig.SettlementSaved"));
    });

    merchantSettings.after(negotiationField, settlementField);
  }, 0);
}

function getItemPileConfigActor(app) {
  return app?.options?.svelte?.props?.pileActor
    || app?.svelte?.props?.pileActor
    || game.actors.get(/^item-pile-config-([^-]+)/.exec(app?.id || "")?.[1]);
}

function getHtmlElement(html) {
  if (html instanceof DocumentFragment) return html;
  if (html instanceof HTMLElement) return html;
  if (Array.isArray(html)) return html[0];
  if (html?.jquery) return html[0];
  return html?.[0] || null;
}

function registerAvailabilityHooks() {
  Hooks.on("createActor", actor => {
    if (!game.user.isGM || !shouldAutoRollAvailability(actor)) return;
    scheduleAvailabilityRoll(actor, { force: true });
  });

  Hooks.on("updateActor", (actor, changes, options) => {
    if (!game.user.isGM || options?.[MODULE_ID]?.availability) return;
    if (!shouldAutoRollAvailability(actor)) return;
    if (foundry.utils.hasProperty(changes, MODULE_SETTLEMENT)) {
      scheduleAvailabilityRoll(actor, { force: true });
      return;
    }
    if (foundry.utils.getProperty(changes, `flags.${MODULE_ID}`)) return;

    const pileChange = foundry.utils.getProperty(changes, ITEM_PILE_DATA);
    const becameMerchant = pileChange?.enabled || pileChange?.type === "merchant";
    const needsInitialRoll = !actor.getFlag(MODULE_ID, "availabilityTested");
    if (becameMerchant || needsInitialRoll) {
      scheduleAvailabilityRoll(actor, { force: false });
    }
  });

  Hooks.on("createItem", item => {
    if (!game.user.isGM) return;
    const actor = item.parent;
    if (!shouldAutoRollAvailability(actor)) return;
    scheduleAvailabilityRoll(actor, { force: false });
  });
}

function shouldAutoRollAvailability(actor) {
  return game.settings.get(MODULE_ID, "autoAvailability")
    && actor?.documentName === "Actor"
    && actor.type === "npc"
    && isItemPilesMerchant(actor);
}

function scheduleAvailabilityRoll(actor, { force = false } = {}) {
  const key = actor.uuid || actor.id;
  if (!key) return;

  if (pendingAvailability.has(key)) {
    clearTimeout(pendingAvailability.get(key));
  }

  pendingAvailability.set(key, setTimeout(async () => {
    pendingAvailability.delete(key);
    try {
      await rollAvailabilityForActor(actor, { force });
    } catch (error) {
      console.error(`${MODULE_ID} | Availability failed`, error);
      ui.notifications.error(error.message || String(error));
    }
  }, 500));
}

function registerDoorHooks() {
  patchDoorControls();
  Hooks.on("canvasReady", () => {
    patchDoorControls();
    rebindDoorControls();
  });
}

function patchDoorControls() {
  const DoorControl = CONFIG.Canvas?.doorControlClass;
  if (!DoorControl?.prototype || DoorControl.prototype._wfrp4prDoorPatch) return;

  const originalMouseDown = DoorControl.prototype._onMouseDown;
  const originalRightDown = DoorControl.prototype._onRightDown;

  DoorControl.prototype._onMouseDown = function wfrp4prDoorMouseDown(event) {
    const states = CONST.WALL_DOOR_STATES;
    const wallDocument = this.wall?.document;
    const shouldHandleLockedDoor = event?.button === 0
      && wallDocument?.ds === states.LOCKED
      && !game.user.isGM
      && game.settings.get(MODULE_ID, "enableDoorActions");

    if (!shouldHandleLockedDoor) return originalMouseDown.call(this, event);

    event.stopPropagation();
    if (!game.user.can("WALL_DOORS")) return false;
    if (game.paused) {
      ui.notifications.warn("GAME.PausedWarning", { localize: true });
      return false;
    }

    this.wall?._playDoorSound?.("test");
    handleLockedDoorClick(this.wall).catch(error => {
      console.error(`${MODULE_ID} | Door action failed`, error);
      ui.notifications.error(error.message || String(error));
    });
    return false;
  };

  DoorControl.prototype._onRightDown = function wfrp4prDoorRightDown(event) {
    const shouldConfigure = game.user.isGM
      && game.settings.get(MODULE_ID, "enableDoorActions")
      && (event?.shiftKey || event?.nativeEvent?.shiftKey || game.keyboard?.isModifierActive?.("SHIFT"));

    if (!shouldConfigure) return originalRightDown.call(this, event);

    event.stopPropagation();
    configureDoor(this.wall).catch(error => {
      console.error(`${MODULE_ID} | Door configuration failed`, error);
      ui.notifications.error(error.message || String(error));
    });
    return false;
  };

  DoorControl.prototype._wfrp4prDoorPatch = true;
  rebindDoorControls();
}

function rebindDoorControls() {
  for (const door of Array.from(canvas.controls?.doors?.children || [])) {
    if (!door?.removeAllListeners || !door._onMouseDown || !door._onRightDown) continue;
    door.removeAllListeners();
    door.on("pointerover", door._onMouseOver).on("pointerout", door._onMouseOut)
      .on("pointerdown", door._onMouseDown).on("rightdown", door._onRightDown);
  }
}

async function handleLockedDoorClick(wall) {
  const wallDocument = wall?.document || wall;
  if (!wallDocument || wallDocument.ds !== CONST.WALL_DOOR_STATES.LOCKED) return false;

  const key = wallDocument.uuid || `${wallDocument.parent?.id || canvas.scene?.id}.${wallDocument.id}`;
  if (pendingDoorDialogs.has(key)) return false;
  pendingDoorDialogs.add(key);

  try {
    const actor = getDoorInteractionActor();
    if (!actor) {
      ui.notifications.error(game.i18n.localize("WFRP4PR.Error.NoDoorActor"));
      return false;
    }

    const stats = getDoorStats(wallDocument);
    const choice = await promptDoorAction(actor, stats);
    if (!choice) return false;

    const action = typeof choice === "string" ? choice : choice.action;
    if (action === "pick") return resolveDoorPick(actor, wallDocument, stats);
    if (action === "bash") return resolveDoorBash(actor, wallDocument, stats, choice);
    return false;
  } finally {
    pendingDoorDialogs.delete(key);
  }
}

function getDoorInteractionActor() {
  const controlled = Array.from(canvas.tokens?.controlled || []);
  const tokenActor = controlled.find(token => token.actor?.isOwner)?.actor;
  if (tokenActor) return tokenActor;

  return game.user.character?.isOwner ? game.user.character : null;
}

async function promptDoorAction(actor, stats) {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  const canPick = !!findSkill(actor, "pickLock");
  const weapons = getDoorBashWeapons(actor);
  const content = renderDoorDialogContent(actor, stats, canPick, weapons);
  const buttons = [];

  if (canPick) {
    buttons.push({
      action: "pick",
      label: game.i18n.localize("WFRP4PR.Door.Pick"),
      icon: "fa-solid fa-key",
      callback: () => ({ action: "pick" })
    });
  }

  buttons.push({
    action: "bash",
    label: game.i18n.localize("WFRP4PR.Door.Bash"),
    icon: "fa-solid fa-hand-fist",
    callback: (event, button) => readDoorActionChoice("bash", button.form)
  });

  buttons.push({
    action: "cancel",
    label: game.i18n.localize("Cancel"),
    icon: "fa-solid fa-ban",
    callback: () => null
  });

  if (DialogV2?.wait) {
    return DialogV2.wait({
      window: { title: game.i18n.localize("WFRP4PR.Door.DialogTitle") },
      content,
      buttons,
      close: () => null
    });
  }

  return new Promise(resolve => {
    const legacyButtons = {};
    if (canPick) {
      legacyButtons.pick = {
        label: game.i18n.localize("WFRP4PR.Door.Pick"),
        icon: '<i class="fas fa-key"></i>',
        callback: () => resolve({ action: "pick" })
      };
    }
    legacyButtons.bash = {
      label: game.i18n.localize("WFRP4PR.Door.Bash"),
      icon: '<i class="fas fa-hand-fist"></i>',
      callback: html => resolve(readDoorActionChoice("bash", getHtmlElement(html)?.querySelector("form")))
    };
    legacyButtons.cancel = {
      label: game.i18n.localize("Cancel"),
      icon: '<i class="fas fa-ban"></i>',
      callback: () => resolve(null)
    };

    new Dialog({
      title: game.i18n.localize("WFRP4PR.Door.DialogTitle"),
      content,
      buttons: legacyButtons,
      close: () => resolve(null),
      default: canPick ? "pick" : "bash"
    }).render(true);
  });
}

function readDoorActionChoice(action, form) {
  return {
    action,
    weaponId: form?.elements?.weaponId?.value || ""
  };
}

function renderDoorDialogContent(actor, stats, canPick, weapons = []) {
  const pickLine = canPick
    ? game.i18n.format("WFRP4PR.Door.PickLine", {
      difficulty: difficultyLabel(stats.lockDifficulty),
      sl: stats.lockSL
    })
    : game.i18n.localize("WFRP4PR.Door.NoPickLock");

  return `
    <form class="wfrp4pr-card wfrp4pr-door-action">
      <p>${game.i18n.format("WFRP4PR.Door.DialogContent", { actor: actor.name })}</p>
      <table>
        <tr>
          <th>${game.i18n.localize("WFRP4PR.Door.Lock")}</th>
          <td>${pickLine}</td>
        </tr>
        <tr>
          <th>${game.i18n.localize("WFRP4PR.Door.Door")}</th>
          <td>${game.i18n.format("WFRP4PR.Door.BashLine", {
            toughnessBonus: stats.toughnessBonus,
            wounds: stats.remaining,
            maxWounds: stats.wounds
          })}</td>
        </tr>
      </table>
      <div class="form-group">
        <label>${game.i18n.localize("WFRP4PR.Door.BashMethod")}</label>
        <select name="weaponId">
          <option value="">${game.i18n.localize("WFRP4PR.Door.Body")}</option>
          ${weapons.map(weapon => {
            return `<option value="${weapon.id}">${weapon.name} (+${getDoorWeaponBonus(weapon)})</option>`;
          }).join("")}
        </select>
      </div>
    </form>
  `;
}

async function resolveDoorPick(actor, wallDocument, stats) {
  if (!findSkill(actor, "pickLock")) {
    ui.notifications.warn(game.i18n.localize("WFRP4PR.Error.NoPickLock"));
    return false;
  }

  const test = await rollSkillWithDialog(actor, "pickLock", {
    appendTitle: ` - ${game.i18n.localize("WFRP4PR.Door.PickTitle")}`,
    difficulty: stats.lockDifficulty
  });
  if (!test) return false;

  const success = test.success && test.sl >= stats.lockSL;
  const result = success ? await requestDoorAction({
    ...doorPayload(wallDocument),
    action: "unlock"
  }) : null;

  await postDoorActionChat({
    action: "pick",
    actor,
    test,
    stats,
    success: !!result?.ok
  });

  return result;
}

async function resolveDoorBash(actor, wallDocument, stats, choice = {}) {
  const weapon = choice?.weaponId ? actor.items.get(choice.weaponId) : null;
  const test = weapon
    ? await rollWeaponWithDialog(actor, weapon, {
      appendTitle: ` - ${game.i18n.localize("WFRP4PR.Door.BashTitle")}`,
      difficulty: stats.bashDifficulty
    })
    : await rollSkillWithDialog(actor, "meleeBrawling", {
      appendTitle: ` - ${game.i18n.localize("WFRP4PR.Door.BashTitle")}`,
      difficulty: stats.bashDifficulty
    });
  if (!test) return false;

  const strengthBonus = getStrengthBonus(actor);
  const weaponBonus = weapon ? getDoorWeaponBonus(weapon) : 0;
  const impact = Math.max(0, strengthBonus + test.sl + weaponBonus);
  const damage = Math.max(0, impact - stats.toughnessBonus);
  const result = damage > 0 ? await requestDoorAction({
    ...doorPayload(wallDocument),
    action: "damage",
    damage
  }) : {
    ok: true,
    damage: 0,
    totalDamage: stats.damage,
    remaining: stats.remaining,
    broken: false
  };

  await postDoorActionChat({
    action: "bash",
    actor,
    test,
    stats,
    strengthBonus,
    weaponName: weapon?.name || "",
    weaponBonus,
    impact,
    damage,
    remaining: result?.remaining ?? stats.remaining,
    broken: !!result?.broken,
    success: damage > 0
  });

  return result;
}

function doorPayload(wallDocument) {
  return {
    sceneId: wallDocument.parent?.id || canvas.scene?.id,
    wallId: wallDocument.id,
    userId: game.user.id
  };
}

async function requestDoorAction(payload) {
  if (game.user.isGM) return executeDoorActionAsGM(payload);
  if (!socket) {
    ui.notifications.error(game.i18n.localize("WFRP4PR.Error.NoSocket"));
    return null;
  }
  return socket.executeAsGM(SOCKET_DOOR, payload);
}

async function executeDoorActionAsGM(payload) {
  if (!game.user.isGM) return false;

  const scene = game.scenes.get(payload.sceneId) || canvas.scene;
  const wall = scene?.walls?.get(payload.wallId);
  if (!wall) throw new Error(game.i18n.localize("WFRP4PR.Error.NoWall"));

  if (payload.action === "unlock") {
    if (wall.ds === CONST.WALL_DOOR_STATES.LOCKED) {
      await wall.update({ ds: CONST.WALL_DOOR_STATES.CLOSED }, { sound: true });
    }
    return { ok: true, unlocked: true };
  }

  if (payload.action === "damage") {
    const stats = getDoorStats(wall);
    const damage = Math.max(0, Number(payload.damage) || 0);
    const totalDamage = clampNumber(stats.damage + damage, 0, stats.wounds);
    const remaining = Math.max(0, stats.wounds - totalDamage);
    const broken = remaining <= 0;
    const update = {};

    setProperty(update, `${MODULE_DOOR}.damage`, totalDamage);
    setProperty(update, `${MODULE_DOOR}.lastDamage`, damage);
    setProperty(update, `${MODULE_DOOR}.lastActor`, game.users.get(payload.userId)?.name || "");
    setProperty(update, `${MODULE_DOOR}.broken`, broken);
    if (broken) update.ds = CONST.WALL_DOOR_STATES.OPEN;

    await wall.update(update, { sound: broken });
    return { ok: true, damage, totalDamage, remaining, broken };
  }

  return false;
}

async function configureDoor(wall) {
  if (!game.user.isGM) return false;

  const wallDocument = wall?.document || wall;
  if (!wallDocument) {
    ui.notifications.error(game.i18n.localize("WFRP4PR.Error.NoWall"));
    return false;
  }

  const stats = getDoorStats(wallDocument);
  const result = await promptDoorConfiguration(stats);
  if (!result) return false;

  result.damage = clampNumber(result.damage, 0, result.wounds);
  const update = {};
  setProperty(update, MODULE_DOOR, result);
  await wallDocument.update(update);
  ui.notifications.info(game.i18n.localize("WFRP4PR.Door.ConfigSaved"));
  return true;
}

async function promptDoorConfiguration(stats) {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  const content = renderDoorConfigurationForm(stats);

  if (DialogV2?.prompt) {
    return DialogV2.prompt({
      window: { title: game.i18n.localize("WFRP4PR.Door.ConfigTitle") },
      content,
      ok: {
        label: game.i18n.localize("Save"),
        callback: (event, button) => readDoorConfigurationForm(button.form)
      }
    });
  }

  return new Promise(resolve => {
    new Dialog({
      title: game.i18n.localize("WFRP4PR.Door.ConfigTitle"),
      content,
      buttons: {
        save: {
          label: game.i18n.localize("Save"),
          icon: '<i class="fas fa-save"></i>',
          callback: html => resolve(readDoorConfigurationForm(getHtmlElement(html)?.querySelector("form")))
        },
        cancel: {
          label: game.i18n.localize("Cancel"),
          icon: '<i class="fas fa-ban"></i>',
          callback: () => resolve(null)
        }
      },
      close: () => resolve(null),
      default: "save"
    }).render(true);
  });
}

function renderDoorConfigurationForm(stats) {
  return `
    <form class="wfrp4pr-door-config">
      <p>${game.i18n.localize("WFRP4PR.Door.ConfigHint")}</p>
      <div class="form-group">
        <label>${game.i18n.localize("WFRP4PR.Door.LockDifficulty")}</label>
        <select name="lockDifficulty">${difficultyOptionsHtml(stats.lockDifficulty)}</select>
      </div>
      <div class="form-group">
        <label>${game.i18n.localize("WFRP4PR.Door.LockSL")}</label>
        <input type="number" name="lockSL" value="${stats.lockSL}" step="1">
      </div>
      <div class="form-group">
        <label>${game.i18n.localize("WFRP4PR.Door.BashDifficulty")}</label>
        <select name="bashDifficulty">${difficultyOptionsHtml(stats.bashDifficulty)}</select>
      </div>
      <div class="form-group">
        <label>${game.i18n.localize("WFRP4PR.Door.ToughnessBonus")}</label>
        <input type="number" name="toughnessBonus" value="${stats.toughnessBonus}" min="0" step="1">
      </div>
      <div class="form-group">
        <label>${game.i18n.localize("WFRP4PR.Door.Wounds")}</label>
        <input type="number" name="wounds" value="${stats.wounds}" min="1" step="1">
      </div>
      <div class="form-group">
        <label>${game.i18n.localize("WFRP4PR.Door.Damage")}</label>
        <input type="number" name="damage" value="${stats.damage}" min="0" step="1">
      </div>
    </form>
  `;
}

function readDoorConfigurationForm(form) {
  if (!form) return null;
  const data = Object.fromEntries(new FormData(form).entries());
  return {
    lockDifficulty: data.lockDifficulty || "average",
    lockSL: numberOrDefault(data.lockSL, 0),
    bashDifficulty: data.bashDifficulty || "challenging",
    toughnessBonus: Math.max(0, numberOrDefault(data.toughnessBonus, 4)),
    wounds: Math.max(1, numberOrDefault(data.wounds, 10)),
    damage: Math.max(0, numberOrDefault(data.damage, 0)),
    at: Date.now()
  };
}

function getDoorStats(wallDocument) {
  const flags = getProperty(wallDocument, MODULE_DOOR, {});
  const wounds = Math.max(1, numberOrDefault(flags.wounds, getSettingSafe(MODULE_ID, "doorDefaultWounds", 10)));
  const damage = clampNumber(numberOrDefault(flags.damage, 0), 0, wounds);

  return {
    lockDifficulty: flags.lockDifficulty || getSettingSafe(MODULE_ID, "doorDefaultLockDifficulty", "average"),
    lockSL: numberOrDefault(flags.lockSL, getSettingSafe(MODULE_ID, "doorDefaultLockSL", 0)),
    bashDifficulty: flags.bashDifficulty || getSettingSafe(MODULE_ID, "doorBashDifficulty", "challenging"),
    toughnessBonus: Math.max(0, numberOrDefault(flags.toughnessBonus, getSettingSafe(MODULE_ID, "doorDefaultTB", 4))),
    wounds,
    damage,
    remaining: Math.max(0, wounds - damage),
    broken: flags.broken === true
  };
}

function getStrengthBonus(actor) {
  const bonus = Number(getProperty(actor, "system.characteristics.s.bonus", NaN));
  if (Number.isFinite(bonus)) return bonus;

  const value = Number(getProperty(actor, "system.characteristics.s.value", 0));
  return Math.floor(value / 10);
}

function getDoorBashWeapons(actor) {
  return Array.from(actor?.items || [])
    .filter(item => item.type === "weapon" && isEquippedItem(item) && isMeleeWeapon(item) && getDoorWeaponBonus(item) > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function isEquippedItem(item) {
  const equipped = getProperty(item, "system.equipped.value", getProperty(item, "system.equipped", false));
  return equipped === true || equipped === "true" || equipped === 1 || equipped === "1";
}

function isMeleeWeapon(item) {
  if (typeof item.system?.isMelee === "boolean") return item.system.isMelee;

  const group = getProperty(item, "system.weaponGroup.value", "");
  const groupType = game.wfrp4e?.config?.groupToType?.[group];
  if (groupType) return groupType === "melee";

  return !["blackpowder", "bow", "crossbow", "engineering", "explosives", "sling", "throwing"].includes(group);
}

function getDoorWeaponBonus(weapon) {
  const rawDamage = String(getProperty(weapon, "system.damage.value", "") || "");
  const withoutStrength = rawDamage.replace(/SB/gi, "");
  const parts = withoutStrength.match(/[+-]?\d+/g)?.map(Number) || [];
  const weaponOnlyDamage = parts.reduce((total, value) => total + value, 0);

  if (weaponOnlyDamage > 0) return Math.floor(weaponOnlyDamage / 2);

  const totalDamage = Number(getProperty(weapon, "system.Damage", weapon.system?.Damage));
  return Number.isFinite(totalDamage) ? Math.floor(Math.max(0, totalDamage) / 2) : 0;
}

function difficultyOptionsHtml(selected) {
  return difficultyOptions().map(([value, label]) => {
    return `<option value="${value}" ${value === selected ? "selected" : ""}>${game.i18n.localize(label)}</option>`;
  }).join("");
}

function difficultyLabel(difficulty) {
  return game.wfrp4e?.config?.difficultyLabels?.[difficulty]
    || game.i18n.localize(difficultyChoices()[difficulty] || difficulty);
}

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function postDoorActionChat({
  action,
  actor,
  test,
  stats,
  success,
  strengthBonus = null,
  weaponName = "",
  weaponBonus = 0,
  impact = null,
  damage = null,
  remaining = null,
  broken = false
}) {
  const title = action === "pick" ? "WFRP4PR.Door.ChatPick" : "WFRP4PR.Door.ChatBash";
  let resultText = "";

  if (action === "pick") {
    resultText = success
      ? game.i18n.localize("WFRP4PR.Door.SuccessUnlocked")
      : game.i18n.localize("WFRP4PR.Door.FailedLocked");
  } else if (broken) {
    resultText = game.i18n.localize("WFRP4PR.Door.BrokenOpen");
  } else if (damage > 0) {
    resultText = game.i18n.format("WFRP4PR.Door.Damaged", { damage, remaining });
  } else {
    resultText = game.i18n.localize("WFRP4PR.Door.NoDamage");
  }

  const bashRows = action === "bash" ? `
    <tr>
      <th>${game.i18n.localize("WFRP4PR.Door.StrengthBonus")}</th>
      <td>${strengthBonus}</td>
    </tr>
    ${weaponName ? `
      <tr>
        <th>${game.i18n.localize("WFRP4PR.Door.Weapon")}</th>
        <td>${weaponName} (+${weaponBonus})</td>
      </tr>
    ` : ""}
    <tr>
      <th>${game.i18n.localize("WFRP4PR.Door.Impact")}</th>
      <td>${impact}</td>
    </tr>
    <tr>
      <th>${game.i18n.localize("WFRP4PR.Door.Damage")}</th>
      <td>${damage}</td>
    </tr>
  ` : "";

  const content = `
    <div class="wfrp4pr-card">
      <h3>${game.i18n.localize("WFRP4PR.Door.ChatTitle")} - ${game.i18n.localize(title)}</h3>
      <table>
        <tr>
          <th>${game.i18n.localize("WFRP4PR.Chat.PlayerTest")}</th>
          <td>${actor.name} (${test.skill})</td>
          <td>${test.roll}/${test.target}</td>
          <td>${formatSignedSL(test.sl)} SL</td>
        </tr>
        <tr>
          <th>${game.i18n.localize("Difficulty")}</th>
          <td colspan="3">${difficultyLabel(action === "pick" ? stats.lockDifficulty : stats.bashDifficulty)}</td>
        </tr>
        ${action === "pick" ? `
          <tr>
            <th>${game.i18n.localize("WFRP4PR.Door.LockSL")}</th>
            <td colspan="3">${stats.lockSL}</td>
          </tr>
        ` : `
          <tr>
            <th>${game.i18n.localize("WFRP4PR.Door.ToughnessBonus")}</th>
            <td colspan="3">${stats.toughnessBonus}</td>
          </tr>
          ${bashRows}
        `}
      </table>
      <p><strong>${resultText}</strong></p>
    </div>
  `;

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content
  });
}

function queueMerchantTradeAsGM(payload) {
  if (!game.user.isGM) return false;

  gmTradeQueue = gmTradeQueue
    .catch(error => console.error(`${MODULE_ID} | Previous queued trade failed`, error))
    .then(async () => {
      try {
        return await executeMerchantTradeAsGM(payload);
      } catch (error) {
        console.error(`${MODULE_ID} | Queued trade failed`, error);
        ui.notifications.error(error.message || String(error));
        await whisperTradeError(payload, error);
        return false;
      }
    });

  return { ok: true, pending: true };
}

async function whisperTradeError(payload, error) {
  const user = game.users.get(payload?.userId);
  if (!user) return;

  await ChatMessage.create({
    speaker: { alias: game.i18n.localize("WFRP4PR.Chat.NegotiationTitle") },
    content: `<p>${game.i18n.format("WFRP4PR.Error.TradeFailed", {
      error: error.message || String(error)
    })}</p>`,
    whisper: [user.id]
  });
}

async function executeMerchantTradeAsGM(payload) {
  const seller = resolveActor(await fromUuid(payload.sellerUuid));
  const buyer = resolveActor(await fromUuid(payload.buyerUuid));
  const sellerIsMerchant = isItemPilesMerchant(seller);
  const buyerIsMerchant = isItemPilesMerchant(buyer);

  if (!seller || !buyer || sellerIsMerchant === buyerIsMerchant) {
    throw new Error(game.i18n.localize("WFRP4PR.Error.NoMerchant"));
  }

  const item = seller.items.get(payload.itemId);
  if (!item) throw new Error(game.i18n.localize("WFRP4PR.Error.NoItem"));

  const mode = sellerIsMerchant ? "buy" : "sell";
  const merchant = sellerIsMerchant ? seller : buyer;
  const player = sellerIsMerchant ? buyer : seller;
  const merchantPileData = getPileData(merchant);
  const itemFlagData = getItemPileData(item);
  const quantity = Math.max(1, Number(payload.quantity) || 1);
  const quantityForPrice = Math.max(1, Number(getProperty(item, itemQuantityForPricePath(), 1)) || 1);
  const itemQuantity = Math.max(1, Math.floor(quantity * quantityForPrice));

  validateTradeAllowed({ mode, merchant, merchantPileData, itemFlagData, item });

  const baseItemBP = getDisplayedTradePriceBP({
    item,
    merchant,
    actor: player,
    mode,
    quantity
  });
  const merchantHadAvailableItem = mode === "sell" && merchantHasAvailableItem(merchant, item);
  const baseBP = Math.round(baseItemBP * (merchantHadAvailableItem ? 0.5 : 1));

  const playerSkill = mode === "buy" && payload.playerSkill === "evaluate" ? "evaluate" : "haggle";
  const merchantSkill = mode === "buy" ? "haggle" : bestSkillKey(merchant, ["haggle", "evaluate"]);
  const playerTest = payload.playerTest || await rollSkillWithDialog(player, playerSkill, { mode });
  if (!playerTest) return false;
  const merchantTest = await rollMerchantSkill(merchant, merchantSkill, { mode });
  if (!merchantTest) return false;
  const opposedSL = playerTest.sl - merchantTest.sl;
  const finalBP = computeNegotiatedPrice(baseBP, opposedSL, mode);

  const moneyTransfers = await validateTradeResources({
    seller,
    buyer,
    merchant,
    mode,
    item,
    itemQuantity,
    finalBP,
    sellerIsMerchant,
    itemFlagData,
    merchantPileData
  });

  await transferTradedItem({
    seller,
    buyer,
    merchant,
    mode,
    item,
    itemQuantity,
    sellerIsMerchant,
    itemFlagData,
    merchantPileData
  });

  await transferMoneyForTrade(moneyTransfers);

  await postNegotiationChat({
    mode,
    item,
    quantity: itemQuantity,
    player,
    merchant,
    playerTest,
    merchantTest,
    opposedSL,
    baseBP,
    finalBP,
    merchantHadAvailableItem
  });

  return {
    ok: true,
    itemName: item.name,
    quantity: itemQuantity,
    baseBP,
    finalBP,
    opposedSL
  };
}

function validateTradeAllowed({ mode, merchant, merchantPileData, itemFlagData, item }) {
  if (mode === "buy" && itemFlagData.notForSale) {
    throw new Error(game.i18n.format("WFRP4PR.Error.NotForSale", { item: item.name }));
  }

  if (mode === "sell") {
    if (merchantPileData.purchaseOnly) {
      throw new Error(game.i18n.format("WFRP4PR.Error.PurchaseOnly", { merchant: merchant.name }));
    }
    if (itemFlagData.cantBeSoldToMerchants) {
      throw new Error(game.i18n.format("WFRP4PR.Error.CantSellItem", {
        merchant: merchant.name,
        item: item.name
      }));
    }
  }
}

async function validateTradeResources({
  seller,
  buyer,
  merchant,
  mode,
  item,
  itemQuantity,
  finalBP,
  sellerIsMerchant,
  itemFlagData,
  merchantPileData
}) {
  const sellerInfinite = sellerIsMerchant && isInfiniteQuantity(merchantPileData, itemFlagData);
  const sellerQuantity = getItemQuantity(item);
  if (!sellerInfinite && sellerQuantity < itemQuantity) {
    throw new Error(game.i18n.format("WFRP4PR.Error.NotEnoughItems", {
      actor: seller.name,
      item: item.name
    }));
  }

  // Prepare both balances before moving any items or money.
  return prepareMoneyTransfers({
    payer: mode === "buy" ? buyer : merchant,
    payee: mode === "buy" ? merchant : seller,
    merchantPileData,
    mode,
    amountBP: finalBP
  });
}

async function transferTradedItem({
  seller,
  buyer,
  merchant,
  mode,
  item,
  itemQuantity,
  sellerIsMerchant,
  itemFlagData,
  merchantPileData
}) {
  const sellerInfinite = sellerIsMerchant && isInfiniteQuantity(merchantPileData, itemFlagData);
  const buyerPileData = getPileData(buyer);
  const buyerIsMerchant = isItemPilesMerchant(buyer);

  if (!itemFlagData.isService) {
    await addItemQuantity(buyer, item, itemQuantity, {
      hide: buyerIsMerchant && buyerPileData.hideNewItems
    });
  }

  if (!sellerInfinite) {
    await removeItemQuantity(seller, item, itemQuantity, {
      keepZero: itemFlagData.isService || itemFlagData.keepZeroQuantity || getPileData(seller).keepZeroQuantity
    });
  }

  if (mode === "sell" && isItemPilesMerchant(merchant)) {
    await markMerchantItemAvailable(merchant, item);
  }
}

function prepareMoneyTransfers({ payer, payee, merchantPileData, mode, amountBP }) {
  if (!Number.isSafeInteger(amountBP) || amountBP < 0) {
    throw new Error(game.i18n.localize("WFRP4PR.Error.InvalidMoney"));
  }
  if (amountBP === 0) return [];

  const payerInfinite = mode === "sell" && merchantPileData.infiniteCurrencies;
  const payeeInfinite = mode === "buy" && merchantPileData.infiniteCurrencies;
  const transfers = [];

  if (!payerInfinite) {
    const total = getMoneyTotalBP(payer);
    if (total < amountBP) {
      throw new Error(game.i18n.format("WFRP4PR.Error.NotEnoughMoney", {
        actor: payer.name,
        price: formatMoney(amountBP)
      }));
    }
    transfers.push({ actor: payer, updates: buildMoneyUpdates(payer, total - amountBP) });
  }
  if (!payeeInfinite) {
    transfers.push({ actor: payee, updates: buildMoneyUpdates(payee, getMoneyTotalBP(payee) + amountBP) });
  }
  return transfers;
}

async function transferMoneyForTrade(transfers) {
  for (const { actor, updates } of transfers) {
    await actor.updateEmbeddedDocuments("Item", updates);
  }
}

function computeNegotiatedPrice(baseBP, opposedSL, mode) {
  if (baseBP <= 0 || opposedSL <= 0) return Math.max(0, Math.round(baseBP));

  const modifier = mode === "sell"
    ? 1 + (opposedSL * 0.10)
    : Math.max(0, 1 - (opposedSL * 0.05));

  return Math.max(1, Math.round(baseBP * modifier));
}

async function promptNegotiationChoice({ mode, actor, item }) {
  const DialogV2 = foundry.applications?.api?.DialogV2;
  const content = `<p>${game.i18n.format(mode === "buy" ? "WFRP4PR.Dialog.BuySkill.Content" : "WFRP4PR.Dialog.SellSkill.Content", {
    actor: actor.name,
    item: item.name
  })}</p>`;
  const buttons = [
    {
      action: "haggle",
      label: game.i18n.localize("WFRP4PR.Skill.Haggle"),
      icon: "fa-solid fa-comments-dollar",
      callback: () => "haggle"
    }
  ];

  if (mode === "buy") {
    buttons.push({
      action: "evaluate",
      label: game.i18n.localize("WFRP4PR.Skill.Evaluate"),
      icon: "fa-solid fa-magnifying-glass-chart",
      callback: () => "evaluate"
    });
  }

  buttons.push({
    action: "none",
    label: game.i18n.localize("WFRP4PR.Skill.NoNegotiation"),
    icon: "fa-solid fa-handshake-simple",
    callback: () => "none"
  });

  if (DialogV2?.wait) {
    return DialogV2.wait({
      window: { title: game.i18n.localize(mode === "buy" ? "WFRP4PR.Dialog.BuySkill.Title" : "WFRP4PR.Dialog.SellSkill.Title") },
      content,
      buttons,
      close: () => null
    });
  }

  return new Promise(resolve => {
    const legacyButtons = {
      haggle: {
        label: game.i18n.localize("WFRP4PR.Skill.Haggle"),
        icon: '<i class="fas fa-comments-dollar"></i>',
        callback: () => resolve("haggle")
      },
      none: {
        label: game.i18n.localize("WFRP4PR.Skill.NoNegotiation"),
        icon: '<i class="fas fa-handshake"></i>',
        callback: () => resolve("none")
      }
    };

    if (mode === "buy") {
      legacyButtons.evaluate = {
        label: game.i18n.localize("WFRP4PR.Skill.Evaluate"),
        icon: '<i class="fas fa-search-dollar"></i>',
        callback: () => resolve("evaluate")
      };
    }

    new Dialog({
      title: game.i18n.localize(mode === "buy" ? "WFRP4PR.Dialog.BuySkill.Title" : "WFRP4PR.Dialog.SellSkill.Title"),
      content,
      buttons: legacyButtons,
      close: () => resolve(null),
      default: "haggle"
    }).render(true);
  });
}

function normalizeTradeItems(sellerActor, items) {
  return items.map(data => {
    const item = resolveItemOnActor(sellerActor, data.item);
    if (!item) throw new Error(game.i18n.localize("WFRP4PR.Error.NoItem"));
    return {
      itemId: item.id,
      quantity: Math.max(1, Number(data.quantity) || 1),
      paymentIndex: Math.max(0, Number(data.paymentIndex) || 0)
    };
  });
}

function resolveItemOnActor(actor, itemData) {
  if (!actor) return null;
  if (itemData instanceof Item) return actor.items.get(itemData.id) || itemData;
  if (typeof itemData === "string") return actor.items.get(itemData) || actor.items.getName(itemData);
  if (itemData?._id) return actor.items.get(itemData._id) || actor.items.getName(itemData.name);
  if (itemData?.id) return actor.items.get(itemData.id) || actor.items.getName(itemData.name);
  return null;
}

async function rollMerchantSkill(actor, skillKey, { mode } = {}) {
  const automatic = game.settings.get(MODULE_ID, "autoMerchantOpposedRoll");
  return rollSkillWithDialog(actor, skillKey, { mode, merchant: true, skipDialog: automatic });
}

async function rollSkillWithDialog(actor, skillKey, {
  merchant = false,
  skipDialog = false,
  appendTitle = null,
  difficulty = null
} = {}) {
  const skill = findSkill(actor, skillKey);
  const skillName = skill?.name || skillLabel(skillKey);
  const startedAt = Date.now();
  const context = {
    appendTitle: appendTitle ?? ` - ${game.i18n.localize(merchant ? "WFRP4PR.Chat.MerchantTest" : "WFRP4PR.Chat.PlayerTest")}`,
    skipDialog,
    skipTargets: true
  };

  if (difficulty) context.fields = { difficulty };

  const test = await actor.setupSkill(skill || skillName, context);

  if (!test) return null;
  const rolledTest = await test.roll();
  const normalized = await waitForSkillTestResult(rolledTest || test, actor, skillKey, startedAt);
  if (normalized) return normalized;

  ui.notifications.error(game.i18n.localize("WFRP4PR.Error.RollResultMissing"));
  console.warn(`${MODULE_ID} | Could not read WFRP4E skill test result`, { actor, skillKey, test });
  return null;
}

async function rollWeaponWithDialog(actor, weapon, { appendTitle = null, difficulty = null } = {}) {
  const startedAt = Date.now();
  const context = {
    appendTitle: appendTitle ?? ` - ${game.i18n.localize("WFRP4PR.Door.BashTitle")}`,
    skipTargets: true
  };

  if (difficulty) context.fields = { difficulty };

  const test = await actor.setupWeapon(weapon, context);
  if (!test) return null;

  const rolledTest = await test.roll();
  const normalized = await waitForSkillTestResult(rolledTest || test, actor, "weapon", startedAt, { matchSkill: false });
  if (normalized) {
    normalized.skill = weapon.name;
    normalized.skillKey = "weapon";
    return normalized;
  }

  ui.notifications.error(game.i18n.localize("WFRP4PR.Error.RollResultMissing"));
  console.warn(`${MODULE_ID} | Could not read WFRP4E weapon test result`, { actor, weapon, test });
  return null;
}

function normalizeSkillTest(test, actor, skillKey) {
  const source = getSkillTestSource(test);
  const data = source?.data || source;
  const result = source?.result || data?.result || {};
  const preData = source?.preData || data?.preData || {};
  const roll = Number(result.roll ?? preData.roll);
  const target = Number(result.target ?? preData.target);
  const sl = parseSL(result.SL ?? preData.SL);

  if (Number.isFinite(roll) && Number.isFinite(target) && Number.isFinite(sl)) {
    return {
      actor: actor.name,
      skill: getSkillTestName(source, preData, skillKey),
      skillKey,
      target,
      roll,
      sl,
      success: getSkillTestSuccess(source, result, roll, target)
    };
  }

  return null;
}

async function waitForSkillTestResult(test, actor, skillKey, startedAt, { matchSkill = true } = {}) {
  const direct = normalizeSkillTest(test, actor, skillKey);
  if (direct) return direct;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const message = getSkillTestMessage(test);
    const fromMessage = normalizeSkillTest(message, actor, skillKey);
    if (fromMessage) return fromMessage;

    const recent = findRecentSkillTestMessage(actor, skillKey, startedAt, { matchSkill });
    if (recent) return recent;

    await sleep(125);
  }

  return null;
}

function getSkillTestSource(source) {
  if (!source) return null;

  try {
    if (source.system?.test) return source.system.test;
  } catch (error) {
    console.debug(`${MODULE_ID} | Could not read message system test`, error);
  }

  const object = source?.toObject ? source.toObject() : source;
  const testData = source.system?.testData
    || foundry.utils.getProperty(object, "system.testData")
    || source.testData
    || object?.testData;

  if (testData) {
    try {
      return game.wfrp4e?.rolls?.TestWFRP?.recreate?.(testData) || { data: testData };
    } catch (error) {
      console.debug(`${MODULE_ID} | Could not recreate WFRP4E test`, error);
      return { data: testData };
    }
  }

  return source;
}

function getSkillTestMessage(test) {
  try {
    if (test?.message) return test.message;
  } catch (error) {
    console.debug(`${MODULE_ID} | Could not read test message`, error);
  }

  const messageId = test?.context?.messageId || test?.data?.context?.messageId;
  return messageId ? game.messages.get(messageId) : null;
}

function findRecentSkillTestMessage(actor, skillKey, startedAt, { matchSkill = true } = {}) {
  const messages = Array.from(game.messages?.contents || game.messages || []).reverse();

  for (const message of messages) {
    if (message.timestamp && message.timestamp < startedAt - 2000) break;
    if (message.speaker?.actor && message.speaker.actor !== actor.id) continue;

    const result = normalizeSkillTest(message, actor, skillKey);
    if (result && (!matchSkill || skillNameMatches(result.skill, skillKey))) return result;
  }

  return null;
}

function getSkillTestName(source, preData, skillKey) {
  try {
    return source?.item?.name || source?.skill?.name || preData.skillName || skillLabel(skillKey);
  } catch (error) {
    console.debug(`${MODULE_ID} | Could not read skill test name`, error);
    return preData.skillName || skillLabel(skillKey);
  }
}

function getSkillTestSuccess(source, result, roll, target) {
  try {
    if (typeof source?.succeeded === "boolean") return source.succeeded;
  } catch (error) {
    console.debug(`${MODULE_ID} | Could not read skill test success`, error);
  }

  if (result.outcome) return result.outcome === "success";
  return isSuccessfulRoll(roll, target);
}

function skillNameMatches(name, skillKey) {
  const normalizedName = normalizeText(name);
  return skillNames(skillKey).some(skillName => normalizedName.includes(normalizeText(skillName)));
}

function parseSL(value) {
  if (typeof value === "number") return value;
  const match = String(value ?? "").match(/[+-]?\d+/);
  return match ? Number(match[0]) : NaN;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isSuccessfulRoll(roll, target) {
  return roll <= Number(getSettingSafe("wfrp4e", "automaticSuccess", 5)) || roll <= target;
}

function bestSkillKey(actor, skillKeys) {
  return skillKeys
    .map(key => ({ key, target: getSkillTarget(actor, findSkill(actor, key), key) }))
    .sort((a, b) => b.target - a.target)[0]?.key || skillKeys[0];
}

function findSkill(actor, skillKey) {
  const names = skillNames(skillKey).map(normalizeText);
  const skills = Array.from(actor?.itemTypes?.skill || actor?.itemTags?.skill || [])
    .concat(Array.from(actor?.items || []).filter(item => item.type === "skill"));

  return skills.find(skill => names.includes(normalizeText(skill.name)))
    || skills.find(skill => names.some(name => normalizeText(skill.name).includes(name)));
}

function getSkillTarget(actor, skill, skillKey) {
  const total = Number(getProperty(skill, "system.total.value", getProperty(skill, "total.value", NaN)));
  if (Number.isFinite(total)) return total;

  const characteristic = getProperty(skill, "system.characteristic.value", fallbackCharacteristic(skillKey));
  return Number(getProperty(actor, `system.characteristics.${characteristic}.value`, actor?.characteristics?.[characteristic]?.value || 0)) || 0;
}

function skillNames(skillKey) {
  if (skillKey === "evaluate") {
    return [
      "Evaluate",
      game.i18n.localize("NAME.Evaluate"),
      "Evaluation",
      "Estimation"
    ];
  }

  if (skillKey === "pickLock") {
    return [
      "Pick Lock",
      game.i18n.localize("NAME.PickLock"),
      "Crochetage",
      "Serrurerie"
    ];
  }

  if (skillKey === "meleeBrawling") {
    return [
      "Melee (Brawling)",
      game.i18n.localize("NAME.MeleeBrawling"),
      "Melee (Bagarre)",
      "Melee (Brawl)",
      "Corps a corps (Bagarre)",
      "Corps \u00e0 corps (Bagarre)",
      "Bagarre"
    ];
  }

  return [
    "Haggle",
    game.i18n.localize("NAME.Haggle"),
    "Marchandage"
  ];
}

function skillLabel(skillKey) {
  if (skillKey === "evaluate") return game.i18n.localize("NAME.Evaluate");
  if (skillKey === "pickLock") return game.i18n.localize("NAME.PickLock");
  if (skillKey === "meleeBrawling") return game.i18n.localize("NAME.MeleeBrawling");
  return game.i18n.localize("NAME.Haggle");
}

function fallbackCharacteristic(skillKey) {
  if (skillKey === "evaluate") return "int";
  if (skillKey === "pickLock") return "dex";
  if (skillKey === "meleeBrawling") return "ws";
  return "fel";
}

async function rollAvailabilityForActor(actor, { force = false } = {}) {
  if (!actor || !game.user.isGM || !isItemPilesMerchant(actor)) return [];

  const settlement = getMerchantSettlement(actor);
  const results = [];
  for (const item of actor.items) {
    if (!isAvailabilityItem(item)) continue;
    if (!force && getProperty(item, MODULE_AVAILABILITY, null)) continue;

    const result = await rollAvailabilityForItem(item, settlement);
    if (result) results.push(result);
  }

  if (results.length) {
    await actor.setFlag(MODULE_ID, "availabilityTested", {
      settlement,
      at: Date.now()
    });

    if (game.settings.get(MODULE_ID, "chatAvailability")) {
      await postAvailabilityChat(actor, results);
    }
  }

  return results;
}

async function rollAvailabilityForItem(item, settlement) {
  const rarityValue = getProperty(item, "system.availability.value", "");
  const entry = getAvailabilityEntry(rarityValue, settlement);
  if (!entry) return null;

  const modifier = Number(game.settings.get(MODULE_ID, "availabilityModifier")) || 0;
  const roll = await new Roll("1d100 - @modifier", { modifier }).roll({ allowInteractive: false });
  const available = Number(entry.test) > 0 && roll.total <= Number(entry.test);
  const stock = available ? await rollStock(entry.stock) : 0;
  const infinite = stock === Infinity;
  const itemUpdate = {};
  const finalQuantity = infinite ? Math.max(1, getItemQuantity(item)) : stock;

  setProperty(itemUpdate, itemQuantityPath(), finalQuantity);
  setProperty(itemUpdate, `${ITEM_PILE_ITEM}.notForSale`, !available);
  setProperty(itemUpdate, `${ITEM_PILE_ITEM}.hidden`, !available && game.settings.get(MODULE_ID, "hideUnavailable"));
  setProperty(itemUpdate, `${ITEM_PILE_ITEM}.infiniteQuantity`, infinite ? "yes" : "no");
  setProperty(itemUpdate, MODULE_AVAILABILITY, {
    available,
    roll: roll.total,
    test: Number(entry.test),
    stock: infinite ? "infinite" : stock,
    rarity: rarityValue,
    settlement,
    at: Date.now()
  });

  await item.update(itemUpdate, { [MODULE_ID]: { availability: true } });

  return {
    item: item.name,
    available,
    roll: roll.total,
    test: Number(entry.test),
    stock: infinite ? "infinite" : stock,
    rarity: rarityValue
  };
}

function getAvailabilityEntry(rarityValue, settlement) {
  const table = game.wfrp4e?.config?.availabilityTable;
  if (!table) return null;

  const settlementTable = table[settlement] || table["MARKET.Town"] || Object.values(table)[0];
  if (!settlementTable) return null;

  const availabilityConfig = game.wfrp4e?.config?.availability || {};
  const directKey = availabilityConfig[rarityValue] || rarityValue;
  if (settlementTable[directKey]) return settlementTable[directKey];

  const normalizedRarity = normalizeText(rarityValue);
  const foundKey = Object.keys(settlementTable).find(key => {
    return normalizeText(key) === normalizedRarity
      || normalizeText(game.i18n.localize(key)) === normalizedRarity
      || normalizeText(key).endsWith(`.${normalizedRarity}`);
  });

  return foundKey ? settlementTable[foundKey] : null;
}

async function rollStock(stockFormula) {
  const stock = String(stockFormula ?? "0");
  if (stock.includes("\u221e") || stock.toLowerCase().includes("inf")) return Infinity;
  if (/d/i.test(stock)) {
    const roll = await new Roll(stock).roll({ allowInteractive: false });
    return Math.max(0, Number(roll.total) || 0);
  }
  const numericStock = Number(stock);
  if (!Number.isFinite(numericStock)) return Infinity;
  return Math.max(0, numericStock || 0);
}

function isAvailabilityItem(item) {
  if (!item || item.type === "money") return false;
  const rarity = getProperty(item, "system.availability.value", "");
  return !!rarity && !["-", "none", "None", "special"].includes(rarity);
}

function merchantHasAvailableItem(merchant, item) {
  return Array.from(merchant.items).some(merchantItem => {
    if (merchantItem.id === item.id) return false;
    if (merchantItem.type !== item.type || normalizeText(merchantItem.name) !== normalizeText(item.name)) return false;

    const flags = getItemPileData(merchantItem);
    if (flags.hidden || flags.notForSale) return false;

    const availability = getProperty(merchantItem, MODULE_AVAILABILITY, null);
    return availability?.available || isInfiniteQuantity(getPileData(merchant), flags) || getItemQuantity(merchantItem) > 0;
  });
}

async function markMerchantItemAvailable(merchant, sourceItem) {
  const matchingItem = Array.from(merchant.items).find(item => {
    return item.type === sourceItem.type && normalizeText(item.name) === normalizeText(sourceItem.name);
  });

  if (!matchingItem) return;

  await matchingItem.update({
    [`${ITEM_PILE_ITEM}.notForSale`]: false,
    [MODULE_AVAILABILITY]: {
      available: true,
      stock: getItemQuantity(matchingItem),
      soldToMerchant: true,
      at: Date.now()
    }
  }, { [MODULE_ID]: { availability: true } });
}

async function addItemQuantity(actor, sourceItem, quantity, { hide = false } = {}) {
  const existing = findSimilarActorItem(actor, sourceItem);
  if (existing) {
    const update = { _id: existing.id };
    setProperty(update, itemQuantityPath(), getItemQuantity(existing) + quantity);
    if (hide) setProperty(update, `${ITEM_PILE_ITEM}.hidden`, true);
    await actor.updateEmbeddedDocuments("Item", [update]);
    return existing;
  }

  const itemData = sourceItem.toObject();
  delete itemData._id;
  setProperty(itemData, itemQuantityPath(), quantity);
  if (hide) setProperty(itemData, `${ITEM_PILE_ITEM}.hidden`, true);
  const created = await actor.createEmbeddedDocuments("Item", [itemData]);
  return created[0];
}

async function removeItemQuantity(actor, item, quantity, { keepZero = false } = {}) {
  const remaining = getItemQuantity(item) - quantity;
  if (remaining > 0 || keepZero) {
    const update = { _id: item.id };
    setProperty(update, itemQuantityPath(), Math.max(0, remaining));
    if (remaining <= 0) setProperty(update, `${ITEM_PILE_ITEM}.notForSale`, true);
    await actor.updateEmbeddedDocuments("Item", [update]);
  } else {
    await actor.deleteEmbeddedDocuments("Item", [item.id]);
  }
}

function findSimilarActorItem(actor, sourceItem) {
  try {
    const found = game.itempiles?.API?.findSimilarItem?.(Array.from(actor.items), sourceItem);
    if (found) return found;
  } catch (error) {
    console.debug(`${MODULE_ID} | Item Piles similarity lookup failed`, error);
  }

  return Array.from(actor.items).find(item => {
    return item.type === sourceItem.type && normalizeText(item.name) === normalizeText(sourceItem.name);
  });
}

function getMoneyItems(actor) {
  return Array.from(actor?.items || [])
    .filter(item => item.type === "money" && Number(getProperty(item, "system.coinValue.value", 0)) > 0)
    .sort((a, b) => Number(getProperty(b, "system.coinValue.value", 0)) - Number(getProperty(a, "system.coinValue.value", 0)));
}

function getMoneyTotalBP(actor) {
  return getMoneyItems(actor).reduce((total, item) => {
    return total + (getItemQuantity(item) * Number(getProperty(item, "system.coinValue.value", 0)));
  }, 0);
}

function buildMoneyUpdates(actor, totalBP) {
  if (!Number.isSafeInteger(totalBP) || totalBP < 0) {
    throw new Error(game.i18n.localize("WFRP4PR.Error.InvalidMoney"));
  }
  const moneyItems = getMoneyItems(actor);
  if (!moneyItems.length) {
    throw new Error(game.i18n.format("WFRP4PR.Error.NoMoneyItems", { actor: actor.name }));
  }
  const updates = [];
  let remaining = totalBP;

  for (const item of moneyItems) {
    const coinValue = Number(getProperty(item, "system.coinValue.value", 0));
    if (!Number.isSafeInteger(coinValue)) {
      throw new Error(game.i18n.localize("WFRP4PR.Error.InvalidMoney"));
    }
    const quantity = Math.floor(remaining / coinValue);
    remaining %= coinValue;
    const update = { _id: item.id };
    setProperty(update, itemQuantityPath(), quantity);
    updates.push(update);
  }

  if (remaining !== 0) {
    throw new Error(game.i18n.format("WFRP4PR.Error.MissingDenomination", {
      actor: actor.name,
      remainder: remaining
    }));
  }
  return updates;
}

async function postNegotiationChat({
  mode,
  item,
  quantity,
  player,
  merchant,
  playerTest,
  merchantTest,
  opposedSL,
  baseBP,
  finalBP,
  merchantHadAvailableItem
}) {
  const modeLabel = game.i18n.localize(mode === "buy" ? "WFRP4PR.Chat.Buy" : "WFRP4PR.Chat.Sell");
  const adjustment = opposedSL > 0
    ? `${formatSignedSL(opposedSL)} SL`
    : game.i18n.localize("WFRP4PR.Chat.NoDiscount");

  const content = `
    <div class="wfrp4pr-card">
      <h3>${game.i18n.localize("WFRP4PR.Chat.NegotiationTitle")} - ${modeLabel}</h3>
      <p><strong>${quantity} x ${item.name}</strong></p>
      <table>
        <tr>
          <th>${game.i18n.localize("WFRP4PR.Chat.PlayerTest")}</th>
          <td>${player.name} (${playerTest.skill})</td>
          <td>${playerTest.roll}/${playerTest.target}</td>
          <td>${formatSignedSL(playerTest.sl)} SL</td>
        </tr>
        <tr>
          <th>${game.i18n.localize("WFRP4PR.Chat.MerchantTest")}</th>
          <td>${merchant.name} (${merchantTest.skill})</td>
          <td>${merchantTest.roll}/${merchantTest.target}</td>
          <td>${formatSignedSL(merchantTest.sl)} SL</td>
        </tr>
      </table>
      <div class="wfrp4pr-price">
        <strong>${game.i18n.localize("WFRP4PR.Chat.OpposedSL")}</strong><span>${adjustment}</span>
        <strong>${game.i18n.localize("WFRP4PR.Chat.BasePrice")}</strong><span>${formatMoney(baseBP)}</span>
        <strong>${game.i18n.localize("WFRP4PR.Chat.FinalPrice")}</strong><span>${formatMoney(finalBP)}</span>
      </div>
      ${merchantHadAvailableItem ? `<p class="wfrp4pr-note">${game.i18n.localize("WFRP4PR.Chat.ExistingStockHalved")}</p>` : ""}
    </div>
  `;

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: player }),
    content
  });
}

async function postAvailabilityChat(actor, results) {
  const rows = results.map(result => `
    <tr>
      <td>${result.item}</td>
      <td>${result.available ? game.i18n.localize("WFRP4PR.Chat.Available") : game.i18n.localize("WFRP4PR.Chat.Unavailable")}</td>
      <td>${result.roll}/${result.test}</td>
      <td>${result.stock === "infinite" ? "\u221e" : result.stock}</td>
    </tr>
  `).join("");

  const content = `
    <div class="wfrp4pr-card">
      <h3>${game.i18n.localize("WFRP4PR.Chat.AvailabilityTitle")}: ${actor.name}</h3>
      <table>
        <tr>
          <th>${game.i18n.localize("Item")}</th>
          <th>${game.i18n.localize("Status")}</th>
          <th>${game.i18n.localize("WFRP4PR.Chat.Roll")}</th>
          <th>${game.i18n.localize("WFRP4PR.Chat.Stock")}</th>
        </tr>
        ${rows}
      </table>
    </div>
  `;

  await ChatMessage.create({
    speaker: { alias: actor.name },
    content,
    whisper: ChatMessage.getWhisperRecipients("GM").map(user => user.id)
  });
}

function isItemPilesMerchant(actor) {
  if (!actor) return false;

  try {
    if (game.itempiles?.API?.isItemPileMerchant?.(actor)) return true;
  } catch (error) {
    console.debug(`${MODULE_ID} | Item Piles merchant check failed`, error);
  }

  const pileData = getPileData(actor);
  return !!pileData.enabled && pileData.type === "merchant";
}

function isInfiniteQuantity(pileData, itemFlagData) {
  if (itemFlagData.infiniteQuantity === "yes") return true;
  if (itemFlagData.infiniteQuantity === "no") return false;
  return !!pileData.infiniteQuantity;
}

function getPileData(actor) {
  const defaults = game.itempiles?.pile_flag_defaults || {};
  const data = getProperty(actor, ITEM_PILE_DATA, {});
  return foundry.utils.mergeObject(foundry.utils.deepClone(defaults), foundry.utils.deepClone(data || {}));
}

function getItemPileData(item) {
  const defaults = game.itempiles?.item_flag_defaults || {};
  const data = getProperty(item, ITEM_PILE_ITEM, {});
  return foundry.utils.mergeObject(foundry.utils.deepClone(defaults), foundry.utils.deepClone(data || {}));
}

function getItemPriceBP(item) {
  const price = getProperty(item, "system.price", {});
  return Math.max(0,
    (Number(price.gc) || 0) * 240
    + (Number(price.ss) || 0) * 12
    + (Number(price.bp) || 0)
  );
}

function getDisplayedTradePriceBP({ item, merchant, actor, mode, quantity }) {
  const itemFlagData = getItemPileData(item);
  if (itemFlagData.free) return 0;

  const base = getItemPriceBP(item);
  const modifier = getMerchantTradeModifier({ merchant, actor, item, mode, itemFlagData });
  return Math.max(0, Math.round(base * modifier * quantity));
}

function getMerchantTradeModifier({ merchant, actor, item, mode, itemFlagData }) {
  const pileData = getPileData(merchant);
  let buyPriceModifier = Number(pileData.buyPriceModifier ?? 1) || 0;
  let sellPriceModifier = Number(pileData.sellPriceModifier ?? 0.5) || 0;

  buyPriceModifier *= Number(itemFlagData.buyPriceModifier ?? 1) || 0;
  sellPriceModifier *= Number(itemFlagData.sellPriceModifier ?? 1) || 0;

  const itemTypePriceModifier = [...(pileData.itemTypePriceModifiers || [])]
    .sort((a, b) => a.type === "custom" && b.type !== "custom" ? -1 : 0)
    .find(priceData => {
      return priceData.type === "custom"
        ? normalizeText(priceData.category) === normalizeText(itemFlagData.customCategory)
        : priceData.type === item.type;
    });

  if (itemTypePriceModifier) {
    buyPriceModifier = itemTypePriceModifier.override
      ? Number(itemTypePriceModifier.buyPriceModifier ?? buyPriceModifier)
      : buyPriceModifier * Number(itemTypePriceModifier.buyPriceModifier ?? 1);
    sellPriceModifier = itemTypePriceModifier.override
      ? Number(itemTypePriceModifier.sellPriceModifier ?? sellPriceModifier)
      : sellPriceModifier * Number(itemTypePriceModifier.sellPriceModifier ?? 1);
  }

  const actorPriceModifier = (pileData.actorPriceModifiers || []).find(data => {
    return data.actorUuid === actor?.uuid || data.actor === actor?.id;
  });

  if (actorPriceModifier) {
    buyPriceModifier = actorPriceModifier.override
      ? Number(actorPriceModifier.buyPriceModifier ?? buyPriceModifier)
      : buyPriceModifier * Number(actorPriceModifier.buyPriceModifier ?? 1);
    sellPriceModifier = actorPriceModifier.override
      ? Number(actorPriceModifier.sellPriceModifier ?? sellPriceModifier)
      : sellPriceModifier * Number(actorPriceModifier.sellPriceModifier ?? 1);
  }

  return Math.max(0, mode === "buy" ? buyPriceModifier : sellPriceModifier);
}

function getItemQuantity(item) {
  return Number(getProperty(item, itemQuantityPath(), 1)) || 0;
}

function itemQuantityPath() {
  return game.itempiles?.API?.ITEM_QUANTITY_ATTRIBUTE || "system.quantity.value";
}

function itemQuantityForPricePath() {
  return game.itempiles?.API?.QUANTITY_FOR_PRICE_ATTRIBUTE || "flags.item-piles.system.quantityForPrice";
}

function formatMoney(bpValue) {
  const amount = game.wfrp4e?.market?.makeSomeChange
    ? game.wfrp4e.market.makeSomeChange(Math.max(0, Math.round(bpValue)), 0)
    : {
      gc: Math.floor(bpValue / 240),
      ss: Math.floor((bpValue % 240) / 12),
      bp: bpValue % 12
    };

  if (game.wfrp4e?.market?.amountToString) return game.wfrp4e.market.amountToString(amount);
  return `${amount.gc || 0}gc ${amount.ss || 0}ss ${amount.bp || 0}bp`;
}

function formatSignedSL(value) {
  return value >= 0 ? `+${value}` : String(value);
}

function resolveActor(target) {
  if (!target) return null;
  if (target.documentName === "Actor") return target;
  if (target.actor) return target.actor;
  if (typeof target === "string") {
    const document = fromUuidSync(target) || game.actors.get(target) || game.actors.getName(target);
    return resolveActor(document);
  }
  return null;
}

function getProperty(source, path, fallback = undefined) {
  if (!source || !path) return fallback;
  const object = source?.toObject ? source.toObject() : source;
  const value = foundry.utils.getProperty(source, path);
  return value ?? foundry.utils.getProperty(object, path) ?? fallback;
}

function setProperty(target, path, value) {
  foundry.utils.setProperty(target, path, value);
}

function getSettingSafe(namespace, key, fallback) {
  try {
    return game.settings.get(namespace, key);
  } catch {
    return fallback;
  }
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}
