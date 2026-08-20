// ==UserScript==
// @name         Askelads Warbuddy
// @namespace    https://github.com/Grussniffer/Askelads-Warbuddy
// @version      0.1.6
// @description  Shows a read-only war action queue and live retaliation opportunities inside Torn.
// @author       Askelads
// @homepageURL  https://github.com/Grussniffer/Askelads-Warbuddy
// @supportURL   https://github.com/Grussniffer/Askelads-Warbuddy/issues
// @downloadURL  https://raw.githubusercontent.com/Grussniffer/Askelads-Warbuddy/main/askelads-warbuddy.user.js
// @updateURL    https://raw.githubusercontent.com/Grussniffer/Askelads-Warbuddy/main/askelads-warbuddy.meta.js
// @match        https://www.torn.com/factions.php*
// @match        https://torn.com/factions.php*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      backend.grusmedia.no
// @noframes
// ==/UserScript==

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

  const isFactionPageUrl = (value) => {
    let url;
    try {
      url = new URL(String(value || ""), "https://www.torn.com/");
    } catch {
      return false;
    }
    if (url.hostname.toLowerCase().replace(/^www\./, "") !== "torn.com") return false;
    return /^\/factions(?:\.php)?(?:\/|$)/i.test(url.pathname);
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
    isFactionPageUrl,
    scoreForFaction,
    toTimestampMs,
  };
});

(function runWarCompanion() {
  "use strict";

  const core = globalThis.AskeladdsWarCompanionCore;
  if (!core) return;

  const BACKEND_BASE_URL = "https://backend.grusmedia.no";
  const SCRIPT_VERSION = "0.1.6";
  const PANEL_ID = "lads-war-companion";
  const KEY_STORAGE = "lads_war_companion_api_key";
  const COLLAPSED_STORAGE = "lads_war_companion_collapsed";
  const REQUEST_TIMEOUT_MS = 30_000;
  const TOPICS = ["war_tracker_settings", "war_tracker", "score", "retaliation"];

  const storage = {
    get(key, fallback = "") {
      if (typeof GM_getValue === "function") return GM_getValue(key, fallback);
      return window.localStorage?.getItem(key) ?? fallback;
    },
    set(key, value) {
      if (typeof GM_setValue === "function") GM_setValue(key, value);
      else window.localStorage?.setItem(key, String(value));
    },
    remove(key) {
      if (typeof GM_deleteValue === "function") GM_deleteValue(key);
      else window.localStorage?.removeItem(key);
    },
  };

  const state = {
    phase: "idle",
    error: "",
    session: null,
    token: "",
    socket: null,
    socketClosing: false,
    reconnectTimer: 0,
    reconnectAttempt: 0,
    ticker: 0,
    routeTimer: 0,
    pageObserver: null,
    observedBody: null,
    authPromise: null,
    rosters: new Map(),
    scores: new Map(),
    settings: null,
    retaliation: { attacks: [] },
    nowMs: Date.now(),
    collapsed: String(storage.get(COLLAPSED_STORAGE, "")) === "1",
    privacyOpen: false,
    active: false,
    renderQueued: false,
  };

  const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

  const addStyle = (css) => {
    if (typeof GM_addStyle === "function") GM_addStyle(css);
    else {
      const style = document.createElement("style");
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
    }
  };

  const registerMenuCommand = (name, callback) => {
    if (typeof GM_registerMenuCommand === "function") GM_registerMenuCommand(name, callback);
  };

  addStyle(`
    #${PANEL_ID} { display:block !important; visibility:visible !important; opacity:1 !important; position:fixed !important; right:10px !important; bottom:10px !important; z-index:2147483647 !important; width:min(320px,calc(100vw - 20px)); max-height:min(70vh,620px); overflow:hidden; border:1px solid #3f3f46; border-radius:7px; background:#111113; color:#f4f4f5; box-shadow:0 12px 32px rgba(0,0,0,.55); font:12px/1.35 Arial,Helvetica,sans-serif; }
    #${PANEL_ID} * { box-sizing:border-box; letter-spacing:0; }
    #${PANEL_ID}.wc-collapsed .wc-body { display:none; }
    #${PANEL_ID} .wc-header { display:flex; align-items:center; justify-content:space-between; gap:8px; min-height:34px; padding:6px 8px; border-bottom:1px solid #27272a; background:#18181b; }
    #${PANEL_ID} .wc-title { min-width:0; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    #${PANEL_ID} .wc-version { color:#71717a; font-size:10px; font-weight:400; }
    #${PANEL_ID} .wc-body { max-height:calc(min(70vh,620px) - 34px); overflow:auto; padding:7px; }
    #${PANEL_ID} .wc-status { display:flex; align-items:center; justify-content:space-between; gap:6px; margin-bottom:6px; padding:5px 6px; border:1px solid #27272a; border-radius:5px; background:#09090b; }
    #${PANEL_ID} .wc-dot { width:7px; height:7px; flex:0 0 auto; border-radius:50%; background:#71717a; }
    #${PANEL_ID} .wc-dot.live { background:#10b981; }
    #${PANEL_ID} .wc-dot.wait { background:#f59e0b; }
    #${PANEL_ID} .wc-status-main { display:flex; min-width:0; align-items:center; gap:6px; }
    #${PANEL_ID} .wc-muted { color:#a1a1aa; }
    #${PANEL_ID} .wc-error { margin-bottom:6px; padding:6px; border:1px solid #7f1d1d; border-radius:5px; background:#2a1114; color:#fecaca; }
    #${PANEL_ID} .wc-section { margin-top:6px; border:1px solid #27272a; border-radius:5px; overflow:hidden; }
    #${PANEL_ID} .wc-section-title { display:flex; align-items:center; justify-content:space-between; gap:6px; padding:5px 6px; background:#18181b; font-weight:700; }
    #${PANEL_ID} .wc-count { color:#a1a1aa; font-size:10px; font-weight:400; }
    #${PANEL_ID} .wc-empty { padding:7px; color:#a1a1aa; }
    #${PANEL_ID} .wc-item { display:flex; align-items:center; justify-content:space-between; gap:7px; min-height:38px; padding:5px 6px; border-top:1px solid #27272a; }
    #${PANEL_ID} .wc-item:first-child { border-top:0; }
    #${PANEL_ID} .wc-item-text { min-width:0; }
    #${PANEL_ID} .wc-item-title { overflow:hidden; color:#e4e4e7; font-weight:700; text-overflow:ellipsis; white-space:nowrap; }
    #${PANEL_ID} .wc-item-detail { overflow:hidden; color:#a1a1aa; font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
    #${PANEL_ID} .wc-item.urgent { box-shadow:inset 3px 0 #ef4444; }
    #${PANEL_ID} .wc-item.watch { box-shadow:inset 3px 0 #f59e0b; }
    #${PANEL_ID} .wc-item.retal { box-shadow:inset 3px 0 #38bdf8; }
    #${PANEL_ID} .wc-row { display:flex; gap:5px; margin-top:6px; }
    #${PANEL_ID} .wc-input { min-width:0; flex:1; border:1px solid #3f3f46; border-radius:5px; background:#09090b; color:#f4f4f5; padding:6px; }
    #${PANEL_ID} .wc-secret-input { -webkit-text-security:disc; }
    #${PANEL_ID} .wc-button, #${PANEL_ID} .wc-link { display:inline-flex; flex:0 0 auto; align-items:center; justify-content:center; border:1px solid #3f3f46; border-radius:5px; background:#27272a; color:#f4f4f5; padding:5px 7px; text-decoration:none; font:inherit; font-weight:700; cursor:pointer; }
    #${PANEL_ID} .wc-button:hover, #${PANEL_ID} .wc-link:hover { background:#3f3f46; }
    #${PANEL_ID} .wc-button.primary, #${PANEL_ID} .wc-link.primary { border-color:#065f46; background:#064e3b; color:#d1fae5; }
    #${PANEL_ID} .wc-icon { width:22px; height:22px; padding:0; }
    #${PANEL_ID} details { margin-top:6px; border:1px solid #27272a; border-radius:5px; color:#a1a1aa; }
    #${PANEL_ID} summary { cursor:pointer; padding:5px 6px; color:#d4d4d8; font-weight:700; }
    #${PANEL_ID} .wc-privacy { padding:0 6px 6px; }
    @media (max-width:520px) { #${PANEL_ID} { right:6px; bottom:6px; width:calc(100vw - 12px); max-height:58vh; } #${PANEL_ID} .wc-body { max-height:calc(58vh - 34px); } }
  `);

  const normalizeResponse = (response) => {
    if (typeof response === "string") return { status: 200, responseText: response };
    if (response && typeof response === "object" && !("responseText" in response) && !("status" in response)) {
      return { status: 200, responseText: JSON.stringify(response) };
    }
    return response || {};
  };

  const sendRequest = (options) => {
    if (typeof GM_xmlhttpRequest === "function") return GM_xmlhttpRequest({ ...options, anonymous: true });
    const method = String(options.method || "GET").toUpperCase();
    if (method === "GET" && typeof window.PDA_httpGet === "function") {
      window.PDA_httpGet(options.url).then((value) => options.onload?.(normalizeResponse(value))).catch(options.onerror);
      return;
    }
    if (method === "POST" && typeof window.PDA_httpPost === "function") {
      window.PDA_httpPost(options.url, options.headers || {}, options.data || "")
        .then((value) => options.onload?.(normalizeResponse(value))).catch(options.onerror);
      return;
    }
    fetch(options.url, {
      method,
      headers: options.headers || {},
      body: options.data,
      credentials: "omit",
    }).then(async (response) => options.onload?.({
      status: response.status,
      responseText: await response.text(),
    })).catch(options.onerror);
  };

  const requestJson = (options) => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => finish(reject, new Error(`${options.label || "Request"} timed out`)), REQUEST_TIMEOUT_MS);
    sendRequest({
      ...options,
      timeout: REQUEST_TIMEOUT_MS,
      onload(rawResponse) {
        const response = normalizeResponse(rawResponse);
        let body;
        try { body = JSON.parse(response.responseText || "null"); }
        catch { finish(reject, new Error(`${options.label || "Request"} returned invalid JSON`)); return; }
        const status = Number(response.status || 200);
        if (status < 200 || status >= 300) {
          const message = body?.error?.error || body?.error?.message || body?.message || `HTTP ${status}`;
          finish(reject, new Error(message));
          return;
        }
        finish(resolve, body);
      },
      onerror() { finish(reject, new Error(`${options.label || "Request"} failed`)); },
      ontimeout() { finish(reject, new Error(`${options.label || "Request"} timed out`)); },
    });
  });

  const getStoredKey = () => String(storage.get(KEY_STORAGE, "") || "").trim();
  const isForeground = () => state.active && document.visibilityState === "visible" && document.hasFocus();
  const backendUrl = (path) => `${BACKEND_BASE_URL.replace(/\/$/, "")}${path}`;
  const socketUrl = () => `${BACKEND_BASE_URL.replace(/^http/i, "ws").replace(/\/$/, "")}/ws`;

  async function getProfileWithKey(key) {
    const query = `key=${encodeURIComponent(key)}&timestamp=${Date.now()}`;
    let profile = await requestJson({
      method: "GET",
      url: `https://api.torn.com/user/?selections=profile&${query}`,
      label: "Torn profile",
    });
    if (profile?.error?.code === 16) {
      profile = await requestJson({
        method: "GET",
        url: `https://api.torn.com/user/?selections=&${query}`,
        label: "Torn profile",
      });
    }
    if (profile?.error) throw new Error(profile.error.error || "Torn rejected this key");
    if (!profile?.player_id) throw new Error("Torn did not return your profile");
    return profile;
  }

  const profileFactionId = (profile) => String(
    profile?.faction?.faction_id || profile?.faction?.id || profile?.faction_id || ""
  ).trim();

  async function authenticate() {
    if (state.authPromise) return state.authPromise;
    const key = getStoredKey();
    if (!key) return;
    state.phase = "authenticating";
    state.error = "";
    scheduleRender();
    state.authPromise = (async () => {
      const profile = await getProfileWithKey(key);
      const factionId = profileFactionId(profile);
      if (!factionId) throw new Error("Your Torn profile is not in a faction");
      const response = await requestJson({
        method: "POST",
        url: backendUrl(`/api/v1/factions/${encodeURIComponent(factionId)}/war-companion/session`),
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify({ tornApiKey: key }),
        label: "Warbuddy login",
      });
      if (!response?.session?.wsSessionToken) throw new Error("Backend did not return a companion session");
      state.session = response.session;
      state.token = response.session.wsSessionToken;
      state.reconnectAttempt = 0;
      state.error = "";
      return response.session;
    })().catch((error) => {
      state.phase = "error";
      state.error = String(error?.message || "Could not connect");
      throw error;
    }).finally(() => {
      state.authPromise = null;
      scheduleRender();
    });
    return state.authPromise;
  }

  function closeSocket() {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = 0;
    const socket = state.socket;
    state.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      state.socketClosing = true;
      socket.close(1000, "Paused");
    }
  }

  function subscribeTopics(socket) {
    for (const topic of TOPICS) {
      socket.send(JSON.stringify({
        type: "subscribe",
        id: `wc-${topic}-${Date.now()}`,
        topic,
        payload: { wsSessionToken: state.token },
      }));
    }
  }

  function requestRosterSnapshot() {
    const socket = state.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "unsubscribe", id: `wc-reset-${Date.now()}`, topic: "war_tracker", payload: { wsSessionToken: state.token } }));
    setTimeout(() => {
      if (socket !== state.socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: "subscribe", id: `wc-resub-${Date.now()}`, topic: "war_tracker", payload: { wsSessionToken: state.token } }));
    }, 100);
  }

  function applyEvent(topic, payload) {
    if (topic === "war_tracker_settings") state.settings = payload || null;
    if (topic === "war_tracker") {
      const factionId = String(payload?.factionId || payload?.faction_id || "");
      if (factionId) {
        const next = core.applyRosterUpdate(state.rosters.get(factionId), payload);
        state.rosters.set(factionId, next);
        if (next.needsSnapshot) requestRosterSnapshot();
      }
    }
    if (topic === "score") {
      const values = Array.isArray(payload) ? payload : Array.isArray(payload?.scores) ? payload.scores : [payload];
      for (const score of values) {
        const factionId = String(score?.factionId || score?.faction_id || "");
        if (factionId) state.scores.set(factionId, score);
      }
    }
    if (topic === "retaliation") state.retaliation = payload || { attacks: [] };
    scheduleRender();
  }

  function handleSocketMessage(event) {
    let message;
    try { message = JSON.parse(String(event.data || "")); }
    catch { return; }
    if (message?.type === "event" && TOPICS.includes(String(message.topic || ""))) {
      applyEvent(String(message.topic), message.payload);
    }
    if (message?.type === "error") {
      state.error = message?.error?.error || message?.error?.message || "Live update failed";
      scheduleRender();
    }
  }

  function scheduleReconnect() {
    if (!isForeground() || state.reconnectTimer) return;
    const delay = Math.min(20_000, 1_000 * 2 ** Math.min(state.reconnectAttempt, 4));
    state.reconnectAttempt += 1;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = 0;
      ensureConnected();
    }, delay);
  }

  async function ensureConnected() {
    if (!isForeground() || !getStoredKey()) return;
    if (state.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.socket.readyState)) return;
    try {
      const expiresAt = Date.parse(String(state.session?.wsSessionTokenExpiresAt || state.session?.expiresAt || ""));
      if (!state.token || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 30_000) await authenticate();
      if (!isForeground()) return;
      state.phase = "connecting";
      state.socketClosing = false;
      scheduleRender();
      const socket = new WebSocket(socketUrl());
      state.socket = socket;
      socket.addEventListener("open", () => {
        if (socket !== state.socket) return;
        state.phase = "connected";
        state.reconnectAttempt = 0;
        state.error = "";
        subscribeTopics(socket);
        scheduleRender();
      });
      socket.addEventListener("message", handleSocketMessage);
      socket.addEventListener("error", () => {
        if (socket !== state.socket) return;
        state.error = "Live connection failed";
        scheduleRender();
      });
      socket.addEventListener("close", (event) => {
        if (socket === state.socket) state.socket = null;
        if (state.socketClosing || !isForeground()) {
          state.socketClosing = false;
          state.phase = "paused";
          scheduleRender();
          return;
        }
        if (event.code === 1008) {
          state.token = "";
          state.session = null;
        }
        state.phase = "connecting";
        scheduleRender();
        scheduleReconnect();
      });
    } catch {
      scheduleReconnect();
    }
  }

  function startTicker() {
    if (state.ticker) return;
    state.ticker = setInterval(() => {
      state.nowMs = Date.now();
      scheduleRender();
    }, 1_000);
  }

  function stopTicker() {
    if (state.ticker) clearInterval(state.ticker);
    state.ticker = 0;
  }

  function syncForegroundState() {
    if (!state.active) {
      stopTicker();
      closeSocket();
      return;
    }
    if (isForeground()) {
      startTicker();
      ensureConnected();
      return;
    }
    stopTicker();
    closeSocket();
    state.phase = getStoredKey() ? "paused" : "idle";
    scheduleRender();
  }

  function sessionView() {
    const ownFactionId = String(state.session?.factionId || "");
    const enemyFactionId = core.inferEnemyFactionId(ownFactionId, state.scores, state.rosters);
    const ownRoster = state.rosters.get(ownFactionId)?.members || [];
    const enemyRoster = state.rosters.get(enemyFactionId)?.members || [];
    const ownMember = ownRoster.find((member) => Number(member?.member_id || 0) === Number(state.session?.playerId || 0));
    const alliedScore = core.scoreForFaction(state.scores, ownFactionId);
    const actions = state.settings?.enabled === false ? [] : core.buildActionQueue({
      enemies: enemyRoster,
      alliedScore,
      ownBsp: ownMember?.bsp || 0,
      nowMs: state.nowMs,
    });
    const retaliation = core.activeRetaliations(state.retaliation, Math.floor(state.nowMs / 1000));
    return { ownFactionId, enemyFactionId, actions, retaliation };
  }

  const statusView = () => {
    if (!getStoredKey()) return { label: "API key needed", tone: "" };
    if (state.phase === "connected") return { label: "Live", tone: "live" };
    if (state.phase === "paused") return { label: "Paused while hidden", tone: "" };
    if (state.phase === "error") return { label: "Connection error", tone: "wait" };
    if (state.phase === "authenticating") return { label: "Checking key", tone: "wait" };
    return { label: "Connecting", tone: "wait" };
  };

  function actionMarkup(item) {
    return `<div class="wc-item ${escapeHtml(item.severity)}">
      <div class="wc-item-text"><div class="wc-item-title">${escapeHtml(item.title)}</div><div class="wc-item-detail" title="${escapeHtml(item.detail)}">${escapeHtml(item.detail)}</div></div>
      ${item.url ? `<a class="wc-link ${item.severity === "urgent" ? "primary" : ""}" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.actionLabel || "Open")}</a>` : ""}
    </div>`;
  }

  function retaliationMarkup(attack) {
    const remaining = core.duration((Number(attack.expiresAt || 0) * 1000) - state.nowMs);
    const target = attack.defenderName ? `Hit ${attack.defenderName}` : "Faction hit";
    return `<div class="wc-item retal">
      <div class="wc-item-text"><div class="wc-item-title">${escapeHtml(attack.attackerName || `Player ${attack.attackerId}`)}</div><div class="wc-item-detail">${escapeHtml(`${target} - ${remaining} left`)}</div></div>
      <a class="wc-link primary" href="${escapeHtml(attack.attackUrl || core.attackUrl(attack.attackerId))}" target="_blank" rel="noopener noreferrer">Attack</a>
    </div>`;
  }

  function render() {
    state.renderQueued = false;
    const mount = document.body;
    if (!mount) return;
    if (!state.active) {
      document.getElementById(PANEL_ID)?.remove();
      return;
    }
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = PANEL_ID;
      mount.appendChild(panel);
    }
    const currentBody = panel.querySelector(".wc-body");
    const bodyScrollTop = Number(currentBody?.scrollTop || 0);
    const privacyDisclosure = panel.querySelector('[data-section="privacy"]');
    if (privacyDisclosure) state.privacyOpen = privacyDisclosure.open;
    panel.classList.toggle("wc-collapsed", state.collapsed);
    const status = statusView();
    const view = sessionView();
    const savedKey = getStoredKey();
    const trackerDisabled = state.settings?.enabled === false;
    const noWar = state.phase === "connected" && !trackerDisabled && !view.enemyFactionId;
    const queueMarkup = trackerDisabled
      ? `<div class="wc-empty">War tracker is disabled.</div>`
      : noWar
        ? `<div class="wc-empty">No active war.</div>`
        : view.actions.length
          ? view.actions.map(actionMarkup).join("")
          : `<div class="wc-empty">No immediate actions.</div>`;
    const retaliationSection = view.retaliation.length
      ? `<div class="wc-section"><div class="wc-section-title"><span>Retaliations</span><span class="wc-count">${view.retaliation.length}</span></div>${view.retaliation.map(retaliationMarkup).join("")}</div>`
      : "";

    panel.innerHTML = `<div class="wc-header">
      <div class="wc-title">${escapeHtml(state.session?.playerName || "Warbuddy")} <span class="wc-version">v${SCRIPT_VERSION}</span></div>
      <button class="wc-button wc-icon" data-action="collapse" title="${state.collapsed ? "Expand" : "Collapse"}">${state.collapsed ? "+" : "-"}</button>
    </div>
    <div class="wc-body">
      <div class="wc-status"><div class="wc-status-main"><span class="wc-dot ${status.tone}"></span><span>${escapeHtml(status.label)}</span></div><span class="wc-muted">${escapeHtml(view.enemyFactionId ? `vs ${view.enemyFactionId}` : "")}</span></div>
      ${state.error ? `<div class="wc-error">${escapeHtml(state.error)}</div>` : ""}
      ${savedKey ? "" : `<div class="wc-row"><input class="wc-input wc-secret-input" data-field="api-key" type="text" inputmode="text" autocomplete="one-time-code" autocapitalize="none" autocorrect="off" spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore="true" data-protonpass-ignore="true" data-form-type="other" aria-label="Torn API key" placeholder="Torn API key"><button class="wc-button primary" data-action="connect">Connect</button></div>`}
      ${savedKey ? `<div class="wc-section"><div class="wc-section-title"><span>Action queue</span><span class="wc-count">${view.actions.length}</span></div>${queueMarkup}</div>${retaliationSection}<div class="wc-row"><button class="wc-button primary" data-action="refresh">Refresh</button><button class="wc-button" data-action="forget">Forget key</button></div>` : ""}
      <details data-section="privacy"${state.privacyOpen ? " open" : ""}><summary>Privacy</summary><div class="wc-privacy">The key stays in your userscript storage. Torn and the backend use it only to verify your profile and faction; the companion session is read-only.</div></details>
    </div>`;

    const nextBody = panel.querySelector(".wc-body");
    if (nextBody) nextBody.scrollTop = bodyScrollTop;
    panel.querySelector('[data-section="privacy"]')?.addEventListener("toggle", (event) => {
      state.privacyOpen = event.currentTarget.open;
    });

    panel.querySelector('[data-action="collapse"]')?.addEventListener("click", () => {
      state.collapsed = !state.collapsed;
      storage.set(COLLAPSED_STORAGE, state.collapsed ? "1" : "0");
      scheduleRender();
    });
    panel.querySelector('[data-action="connect"]')?.addEventListener("click", connectFromInput);
    panel.querySelector('[data-field="api-key"]')?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") connectFromInput();
    });
    panel.querySelector('[data-action="refresh"]')?.addEventListener("click", () => {
      state.rosters.clear();
      state.scores.clear();
      state.retaliation = { attacks: [] };
      closeSocket();
      state.phase = "connecting";
      setTimeout(ensureConnected, 50);
      scheduleRender();
    });
    panel.querySelector('[data-action="forget"]')?.addEventListener("click", () => {
      storage.remove(KEY_STORAGE);
      closeSocket();
      state.session = null;
      state.token = "";
      state.error = "";
      state.phase = "idle";
      state.rosters.clear();
      state.scores.clear();
      state.settings = null;
      state.retaliation = { attacks: [] };
      scheduleRender();
    });
  }

  function connectFromInput() {
    const input = document.querySelector(`#${PANEL_ID} [data-field="api-key"]`);
    const key = String(input?.value || "").trim();
    if (!key) return;
    storage.set(KEY_STORAGE, key);
    state.token = "";
    state.session = null;
    ensureConnected();
    scheduleRender();
  }

  function scheduleRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(render);
  }

  function start() {
    startPageObserver();
    syncPageActivation();
    syncForegroundState();
    if (!state.routeTimer) state.routeTimer = setInterval(syncPageActivation, 1_000);
  }

  function startPageObserver() {
    if (typeof MutationObserver !== "function" || !document.body) return;
    if (state.pageObserver && state.observedBody === document.body) return;
    state.pageObserver?.disconnect();
    state.observedBody = document.body;
    state.pageObserver = new MutationObserver(() => {
      if (state.active && !document.getElementById(PANEL_ID)) render();
    });
    state.pageObserver.observe(document.body, { childList: true, subtree: true });
  }

  function syncPageActivation() {
    startPageObserver();
    const active = core.isFactionPageUrl(window.location.href);
    if (!active) {
      if (state.active || document.getElementById(PANEL_ID)) {
        stopTicker();
        closeSocket();
        state.phase = getStoredKey() ? "paused" : "idle";
        document.getElementById(PANEL_ID)?.remove();
      }
      state.active = false;
      return;
    }
    const becameActive = !state.active;
    state.active = true;
    if (becameActive || !document.getElementById(PANEL_ID)) render();
    if (becameActive) syncForegroundState();
  }

  registerMenuCommand("Warbuddy: show panel", () => {
    state.active = core.isFactionPageUrl(window.location.href);
    if (!state.active) {
      window.alert(`Warbuddy v${SCRIPT_VERSION} is installed, but this is not recognized as a Torn faction page.\n\n${window.location.href}`);
      return;
    }
    render();
    syncForegroundState();
  });

  registerMenuCommand("Warbuddy: diagnostics", () => {
    const routeMatches = core.isFactionPageUrl(window.location.href);
    const panel = document.getElementById(PANEL_ID);
    window.alert([
      `Warbuddy v${SCRIPT_VERSION}`,
      `Route matched: ${routeMatches ? "yes" : "no"}`,
      `Document body: ${document.body ? "ready" : "missing"}`,
      `Panel mounted: ${panel ? "yes" : "no"}`,
      `Panel visible: ${panel ? getComputedStyle(panel).display !== "none" && getComputedStyle(panel).visibility !== "hidden" : "n/a"}`,
      window.location.href,
    ].join("\n"));
  });

  document.addEventListener("visibilitychange", syncForegroundState);
  window.addEventListener("focus", syncForegroundState);
  window.addEventListener("blur", syncForegroundState);
  window.addEventListener("hashchange", syncPageActivation);
  window.addEventListener("popstate", syncPageActivation);
  window.addEventListener("pageshow", start);
  window.addEventListener("pagehide", () => {
    if (state.routeTimer) clearInterval(state.routeTimer);
    state.routeTimer = 0;
    stopTicker();
    closeSocket();
    state.active = false;
    state.pageObserver?.disconnect();
    state.pageObserver = null;
    state.observedBody = null;
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
