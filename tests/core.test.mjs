import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const core = require("../src/core.cjs");

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
    assert.ok(source.includes("core.isFactionWarUrl(window.location.href)"));
  });
});

describe("War Companion route activation", () => {
  it("runs on Torn faction war routes", () => {
    assert.equal(core.isFactionWarUrl("https://www.torn.com/factions.php?step=your#/war/rank"), true);
    assert.equal(core.isFactionWarUrl("https://torn.com/factions.php?step=profile&ID=41309#/war"), true);
    assert.equal(core.isFactionWarUrl("https://www.torn.com/factions.php?step=your#/tab=war"), true);
  });

  it("stays inactive on Bazaar and unrelated Torn routes", () => {
    assert.equal(core.isFactionWarUrl("https://www.torn.com/bazaar.php"), false);
    assert.equal(core.isFactionWarUrl("https://www.torn.com/factions.php?step=your#/tab=crimes"), false);
    assert.equal(core.isFactionWarUrl("https://www.torn.com/factions.php#/%E0%A4%A"), false);
    assert.equal(core.isFactionWarUrl("https://example.com/factions.php#/war/rank"), false);
  });
});
