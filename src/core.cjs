(function attachWarCompanionCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.AskeladdsWarCompanionCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createWarCompanionCore() {
  "use strict";

  const HOSPITAL_WINDOW_MS = 15 * 60 * 1000;
  const URGENT_HOSPITAL_MS = 3 * 60 * 1000;
  const CHAIN_WINDOW_MS = 5 * 60 * 1000;
  const URGENT_CHAIN_MS = 2 * 60 * 1000;

  const toTimestampMs = (value) => {
    const numeric = Number(value || 0);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const duration = (milliseconds) => {
    const seconds = Math.max(0, Math.ceil(Number(milliseconds || 0) / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  };

  const formatBsp = (value) => {
    const numeric = Number(value || 0);
    if (numeric >= 1e12) return `${(numeric / 1e12).toFixed(1)}t`;
    if (numeric >= 1e9) return `${(numeric / 1e9).toFixed(1)}b`;
    if (numeric >= 1e6) return `${(numeric / 1e6).toFixed(1)}m`;
    return Math.round(numeric).toLocaleString("en-US");
  };

  const attackUrl = (memberId) =>
    `https://www.torn.com/page.php?sid=attack&user2ID=${encodeURIComponent(String(memberId || ""))}`;

  const isFactionWarUrl = (value) => {
    let url;
    try {
      url = new URL(String(value || ""), "https://www.torn.com/");
    } catch {
      return false;
    }
    if (url.hostname.toLowerCase().replace(/^www\./, "") !== "torn.com") return false;
    if (url.pathname.toLowerCase() !== "/factions.php") return false;
    let route = String(url.hash || "");
    try { route = decodeURIComponent(route); } catch {}
    route = route.toLowerCase().replace(/^#\/?/, "");
    return /^war(?:[/?]|$)/.test(route)
      || /(?:^|[/?&])tab=war(?:[/?&#]|$)/.test(route)
      || /^ranked-?war(?:[/?]|$)/.test(route);
  };

  const memberStatus = (member) =>
    String(member?.status?.userStatus || member?.status?.state || member?.status?.status || "").toLowerCase();

  const memberLocation = (member) =>
    String(member?.location?.current || member?.location?.name || member?.location || "").toLowerCase();

  const memberActivity = (member) => String(member?.activity || "").toLowerCase();

  const scoreForFaction = (scores, factionId) => {
    if (scores instanceof Map) return scores.get(String(factionId));
    return Object.values(scores || {}).find((score) => String(score?.factionId || score?.faction_id || "") === String(factionId));
  };

  const inferEnemyFactionId = (ownFactionId, scores, rosters) => {
    const ownScore = scoreForFaction(scores, ownFactionId);
    const explicitOpponent = String(ownScore?.opponentFactionId || ownScore?.opponent_faction_id || "").trim();
    if (explicitOpponent && explicitOpponent !== String(ownFactionId)) return explicitOpponent;

    const scoreValues = scores instanceof Map ? Array.from(scores.values()) : Object.values(scores || {});
    const opposingScore = scoreValues.find((score) => {
      const factionId = String(score?.factionId || score?.faction_id || "");
      return factionId && factionId !== String(ownFactionId)
        && String(score?.opponentFactionId || score?.opponent_faction_id || "") === String(ownFactionId);
    });
    if (opposingScore) return String(opposingScore.factionId || opposingScore.faction_id);

    const rosterIds = (rosters instanceof Map ? Array.from(rosters.keys()) : Object.keys(rosters || {}))
      .map(String)
      .filter((factionId) => factionId !== String(ownFactionId));
    return rosterIds.length === 1 ? rosterIds[0] : "";
  };

  const applyRosterUpdate = (current, payload) => {
    const existing = current || { version: 0, members: [] };
    const version = Number(payload?.version || 0);
    if (Array.isArray(payload?.members)) {
      return { version, members: payload.members.slice(), needsSnapshot: false };
    }

    const changed = Array.isArray(payload?.changedMembers) ? payload.changedMembers : [];
    const removed = new Set((payload?.removedMemberIds || []).map((id) => Number(id)));
    if (!changed.length && !removed.size) return { ...existing, needsSnapshot: false };
    const baseVersion = Number(payload?.baseVersion || 0);
    if (existing.version && baseVersion && existing.version !== baseVersion) {
      return { ...existing, needsSnapshot: true };
    }

    const byId = new Map(existing.members.map((member) => [Number(member?.member_id || 0), member]));
    for (const memberId of removed) byId.delete(memberId);
    for (const member of changed) byId.set(Number(member?.member_id || 0), member);
    return {
      version: version || existing.version,
      members: Array.from(byId.values()),
      needsSnapshot: false,
    };
  };

  const buildActionQueue = ({ enemies = [], alliedScore, ownBsp = 0, nowMs = Date.now() }) => {
    const result = [];
    const chainEndsAt = toTimestampMs(alliedScore?.chain_timer);
    const chainRemaining = chainEndsAt - nowMs;
    if (Number(alliedScore?.chain || 0) >= 10 && chainRemaining > 0 && chainRemaining <= CHAIN_WINDOW_MS) {
      result.push({
        key: "chain-risk",
        severity: chainRemaining <= URGENT_CHAIN_MS ? "urgent" : "watch",
        title: `Chain ${alliedScore.chain} needs a hit`,
        detail: `${duration(chainRemaining)} remaining`,
        order: chainEndsAt,
      });
    }

    for (const member of enemies) {
      if (memberStatus(member) !== "hospital") continue;
      const until = toTimestampMs(member?.status?.untill || member?.status?.until);
      const remaining = until - nowMs;
      if (remaining <= 0 || remaining > HOSPITAL_WINDOW_MS) continue;
      result.push({
        key: `hospital-${member.member_id}`,
        severity: remaining <= URGENT_HOSPITAL_MS ? "urgent" : "watch",
        title: `${member.member_name} leaves hospital`,
        detail: `${duration(remaining)} - ${member.bsp ? `${formatBsp(member.bsp)} BSP` : "BSP unknown"}`,
        actionLabel: "Open",
        url: attackUrl(member.member_id),
        order: until,
      });
    }

    const numericOwnBsp = Number(ownBsp || 0);
    const onlineTargets = enemies
      .filter((member) => memberActivity(member) === "online" && memberStatus(member) === "okay")
      .filter((member) => memberLocation(member) === "torn")
      .filter((member) => !numericOwnBsp || !member.bsp || Number(member.bsp) <= numericOwnBsp * 1.25)
      .sort((a, b) => Number(b.bsp || 0) - Number(a.bsp || 0))
      .slice(0, 3);
    for (const member of onlineTargets) {
      result.push({
        key: `online-${member.member_id}`,
        severity: "info",
        title: `${member.member_name} is online in Torn`,
        detail: member.bsp ? `${formatBsp(member.bsp)} BSP` : `Level ${member.level || "?"} - BSP unknown`,
        actionLabel: "Attack",
        url: attackUrl(member.member_id),
        order: Number.MAX_SAFE_INTEGER - Number(member.bsp || 0),
      });
    }

    const severityRank = { urgent: 0, watch: 1, info: 2 };
    return result
      .sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || a.order - b.order)
      .slice(0, 9);
  };

  const activeRetaliations = (payload, nowSeconds = Math.floor(Date.now() / 1000)) =>
    (Array.isArray(payload?.attacks) ? payload.attacks : [])
      .filter((attack) => Number(attack?.expiresAt || 0) > nowSeconds && Number(attack?.attackerId || 0) > 0)
      .sort((a, b) => Number(a.expiresAt || 0) - Number(b.expiresAt || 0));

  return {
    activeRetaliations,
    applyRosterUpdate,
    attackUrl,
    buildActionQueue,
    duration,
    formatBsp,
    inferEnemyFactionId,
    isFactionWarUrl,
    scoreForFaction,
    toTimestampMs,
  };
});
