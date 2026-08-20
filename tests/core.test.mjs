import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

const require = createRequire(import.meta.url);
const core = require("../src/core.cjs");

const bootUserscript = async (href, { withBody = true } = {}) => {
  const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");
  const elements = new Map();
  const documentListeners = new Map();
  const menuCommands = new Map();
  let observerCallback = null;
  const mount = {
    appendChild(element) {
      element.parentNode = this;
      elements.set(element.id, element);
    },
  };
  const document = {
    body: withBody ? mount : null,
    documentElement: mount,
    head: mount,
    readyState: withBody ? "complete" : "loading",
    visibilityState: "hidden",
    hasFocus: () => false,
    addEventListener(name, callback) { documentListeners.set(name, callback); },
    querySelector: () => null,
    getElementById: (id) => elements.get(id) || null,
    createElement(tagName) {
      return {
        id: "",
        tagName: String(tagName || "").toUpperCase(),
        parentNode: null,
        classList: { toggle() {} },
        addEventListener() {},
        querySelector: () => null,
        querySelectorAll: () => [],
        remove() { elements.delete(this.id); },
      };
    },
  };
  let routeCheck = null;
  const context = {
    AskeladdsWarCompanionCore: core,
    URL,
    console,
    document,
    location: { href },
    GM_addStyle() {},
    GM_getValue: (_key, fallback) => fallback,
    GM_setValue() {},
    GM_deleteValue() {},
    GM_registerMenuCommand(name, callback) { menuCommands.set(name, callback); },
    MutationObserver: class {
      constructor(callback) { observerCallback = callback; }
      observe() {}
      disconnect() {}
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    alert() {},
    requestAnimationFrame: (callback) => callback(),
    setInterval(callback) { routeCheck = callback; return 1; },
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    addEventListener() {},
  };
  context.window = context;
  runInNewContext(source, context);
  return {
    elements,
    menuCommands,
    routeCheck: () => routeCheck?.(),
    notifyMutation: () => observerCallback?.([]),
    activateBody() {
      document.body = mount;
      document.readyState = "complete";
      documentListeners.get("DOMContentLoaded")?.();
    },
  };
};

describe("War Companion action queue", () => {
  it("prioritizes urgent chain and hospital actions before online targets", () => {
    const nowMs = 2_000_000_000_000;
    const items = core.buildActionQueue({
      nowMs,
      ownBsp: 1_000_000_000,
      alliedScore: {
        chain: 27,
        chain_timer: new Date(nowMs + 90_000).toISOString(),
      },
      enemies: [
        {
          member_id: 101,
          member_name: "Returning",
          bsp: 800_000_000,
          activity: "Offline",
          status: { userStatus: "Hospital", untill: nowMs + 120_000 },
          location: { current: "Torn" },
        },
        {
          member_id: 102,
          member_name: "Online",
          bsp: 700_000_000,
          activity: "Online",
          status: { userStatus: "Okay" },
          location: { current: "Torn" },
        },
        {
          member_id: 103,
          member_name: "Too strong",
          bsp: 2_000_000_000,
          activity: "Online",
          status: { userStatus: "Okay" },
          location: { current: "Torn" },
        },
      ],
    });

    assert.deepEqual(items.map((item) => item.key), ["chain-risk", "hospital-101", "online-102"]);
    assert.equal(items[0].severity, "urgent");
    assert.equal(items[1].severity, "urgent");
  });

  it("keeps the queue empty when no action is useful", () => {
    assert.deepEqual(core.buildActionQueue({ enemies: [], alliedScore: { chain: 2 } }), []);
  });
});

describe("War Companion live state", () => {
  it("applies full snapshots and ordered deltas", () => {
    const full = core.applyRosterUpdate(undefined, {
      version: 4,
      members: [{ member_id: 1, member_name: "One" }, { member_id: 2, member_name: "Two" }],
    });
    const delta = core.applyRosterUpdate(full, {
      baseVersion: 4,
      version: 5,
      changedMembers: [{ member_id: 2, member_name: "Two updated" }],
      removedMemberIds: [1],
    });
    assert.equal(delta.needsSnapshot, false);
    assert.deepEqual(delta.members, [{ member_id: 2, member_name: "Two updated" }]);
    assert.equal(delta.version, 5);
  });

  it("requests a new snapshot when a delta base is missing", () => {
    const result = core.applyRosterUpdate({ version: 4, members: [] }, {
      baseVersion: 3,
      version: 5,
      changedMembers: [{ member_id: 2 }],
    });
    assert.equal(result.needsSnapshot, true);
    assert.equal(result.version, 4);
  });

  it("prefers the score's explicit opponent over extra tracked rosters", () => {
    const scores = new Map([
      ["41309", { factionId: "41309", opponentFactionId: "49352" }],
    ]);
    const rosters = new Map([["41309", {}], ["41067", {}], ["49352", {}]]);
    assert.equal(core.inferEnemyFactionId("41309", scores, rosters), "49352");
  });

  it("drops expired retaliation opportunities", () => {
    assert.deepEqual(
      core.activeRetaliations({ attacks: [
        { attackerId: 1, expiresAt: 99 },
        { attackerId: 2, expiresAt: 101 },
      ] }, 100).map((attack) => attack.attackerId),
      [2]
    );
  });
});

describe("War Companion panel state", () => {
  it("preserves the Privacy disclosure and panel scroll position across live renders", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    assert.ok(source.includes("privacyOpen: false"));
    assert.ok(source.includes('if (privacyDisclosure) state.privacyOpen = privacyDisclosure.open'));
    assert.ok(source.includes('data-section="privacy"${state.privacyOpen ? " open" : ""}'));
    assert.ok(source.includes("if (nextBody) nextBody.scrollTop = bodyScrollTop"));
    assert.ok(source.includes("state.privacyOpen = event.currentTarget.open"));
    assert.ok(source.includes("core.isFactionPageUrl(window.location.href)"));
  });

  it("keeps the API key field out of browser login autofill", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    assert.ok(source.includes('class="wc-input wc-secret-input"'));
    assert.ok(source.includes('const SCRIPT_VERSION = "0.1.11"'));
    assert.ok(source.includes('type="text"'));
    assert.ok(source.includes('autocomplete="one-time-code"'));
    assert.ok(source.includes('data-1p-ignore'));
    assert.ok(source.includes('data-lpignore="true"'));
    assert.ok(source.includes('data-bwignore="true"'));
    assert.doesNotMatch(source, /data-field="api-key" type="password"/);
  });

  it("persists a draggable panel position", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    assert.ok(source.includes('const POSITION_STORAGE = "lads_war_companion_position"'));
    assert.ok(source.includes('header.addEventListener("pointerdown"'));
    assert.ok(source.includes('header.addEventListener("pointermove"'));
    assert.ok(source.includes("setPanelPosition(panel, { left: rect.left, top: rect.top }, true)"));
    assert.ok(source.includes('registerMenuCommand("Warbuddy: reset position"'));
  });

  it("keeps the socket alive while a visible page briefly loses focus", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    assert.doesNotMatch(source, /const isForeground = \(\) =>[^;]*document\.hasFocus/s);
    assert.doesNotMatch(source, /addEventListener\("blur", syncForegroundState\)/);
    assert.ok(source.includes('window.addEventListener("online", syncForegroundState)'));
    assert.ok(source.includes('window.addEventListener("offline", syncForegroundState)'));
    assert.doesNotMatch(source, /state\.error = "Live connection failed"/);
  });

  it("recovers a socket that never completes its opening handshake", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    assert.ok(source.includes("const SOCKET_CONNECT_TIMEOUT_MS = 15_000"));
    assert.ok(source.includes("socketConnectTimer: 0"));
    assert.ok(source.includes('"Live connection timed out. Retrying automatically."'));
    assert.ok(source.includes('"Handshake timed out"'));
    assert.ok(source.includes("state.socketConnectTimer = 0"));
    assert.doesNotMatch(source, /socket\.readyState !== WebSocket\.CONNECTING\) return/);
    assert.ok(source.includes('"Live connection was rejected. Retrying automatically."'));
    assert.ok(source.includes("recoverFailedSocket("));
    assert.ok(source.includes("scheduleReconnect();"));
  });

  it("falls back to a scoped HTTP snapshot when native WebSockets are rejected", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    assert.ok(source.includes("const FALLBACK_POLL_MS = 10_000"));
    assert.ok(source.includes("const FALLBACK_SOCKET_RETRY_MS = 60_000"));
    assert.ok(source.includes("/war-companion/snapshot?timestamp="));
    assert.ok(source.includes("headers: { Authorization: `Bearer ${state.token}` }"));
    assert.ok(source.includes("startFallbackPolling();"));
    assert.ok(source.includes('if (state.phase === "fallback") return { label: "Live (compatible)", tone: "live" };'));
    assert.doesNotMatch(source, /war-companion\/snapshot[^\n]*tornApiKey/);
  });

  it("ignores delayed close events from sockets that were already replaced", async () => {
    const source = await readFile(new URL("../src/userscript.js", import.meta.url), "utf8");

    assert.ok(source.includes('socket.addEventListener("close", (event) => {\n        if (socket !== state.socket) return;'));
    assert.doesNotMatch(source, /socketClosing/);
  });
});

describe("War Companion route activation", () => {
  it("runs throughout Torn faction pages", () => {
    assert.equal(core.isFactionPageUrl("https://www.torn.com/factions.php?step=your#/war/rank"), true);
    assert.equal(core.isFactionPageUrl("https://torn.com/factions.php?step=profile&ID=41309"), true);
    assert.equal(core.isFactionPageUrl("https://www.torn.com/factions.php?step=your#/tab=crimes"), true);
  });

  it("stays inactive on Bazaar and non-faction pages", () => {
    assert.equal(core.isFactionPageUrl("https://www.torn.com/bazaar.php"), false);
    assert.equal(core.isFactionPageUrl("https://www.torn.com/page.php?sid=attack"), false);
    assert.equal(core.isFactionPageUrl("https://example.com/factions.php#/war/rank"), false);
  });

  it("mounts and restores the panel on faction pages without mounting on Bazaar", async () => {
    const faction = await bootUserscript("https://www.torn.com/factions.php?step=your&type=1", { withBody: false });
    assert.equal(faction.elements.has("lads-war-companion"), false);

    faction.activateBody();
    assert.equal(faction.elements.has("lads-war-companion"), true);
    assert.equal(faction.elements.get("lads-war-companion").tagName, "DIV");
    assert.equal(faction.menuCommands.has("Warbuddy: diagnostics"), true);

    faction.elements.get("lads-war-companion").remove();
    faction.notifyMutation();
    assert.equal(faction.elements.has("lads-war-companion"), true);

    const bazaar = await bootUserscript("https://www.torn.com/bazaar.php");
    assert.equal(bazaar.elements.has("lads-war-companion"), false);
  });

  it("injects only on Torn faction URLs", async () => {
    const header = await readFile(new URL("../userscript.header.txt", import.meta.url), "utf8");
    assert.match(header, /@sandbox\s+DOM/);
    assert.match(header, /@match\s+https:\/\/www\.torn\.com\/factions\.php\*/);
    assert.doesNotMatch(header, /@match\s+https:\/\/www\.torn\.com\/\*/);
  });
});
