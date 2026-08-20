(function runWarCompanion() {
  "use strict";

  const core = globalThis.AskeladdsWarCompanionCore;
  if (!core) return;

  const BACKEND_BASE_URL = "https://backend.grusmedia.no";
  const SCRIPT_VERSION = "0.1.14";
  const PANEL_ID = "lads-war-companion";
  const KEY_STORAGE = "lads_war_companion_api_key";
  const COLLAPSED_STORAGE = "lads_war_companion_collapsed";
  const POSITION_STORAGE = "lads_war_companion_position";
  const REQUEST_TIMEOUT_MS = 30_000;
  const SOCKET_CONNECT_TIMEOUT_MS = 15_000;
  const FALLBACK_POLL_MS = 10_000;
  const FALLBACK_SOCKET_RETRY_MS = 60_000;
  const isTornPda = typeof window.PDA_httpGet === "function" || typeof window.PDA_httpPost === "function";
  const PANEL_EDGE_GAP = 8;
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
    socketConnectTimer: 0,
    reconnectTimer: 0,
    reconnectAttempt: 0,
    fallbackTimer: 0,
    fallbackInFlight: false,
    fallbackActive: false,
    fallbackGeneration: 0,
    lastFallbackAt: "",
    lastFallbackError: "",
    keyDraft: "",
    ticker: 0,
    routeTimer: 0,
    pageObserver: null,
    observedBody: null,
    authPromise: null,
    rosters: new Map(),
    factionNames: new Map(),
    scores: new Map(),
    settings: null,
    retaliation: { attacks: [] },
    nowMs: Date.now(),
    collapsed: String(storage.get(COLLAPSED_STORAGE, "")) === "1",
    privacyOpen: false,
    active: false,
    renderQueued: false,
    dragging: false,
    lastSocketErrorAt: "",
    lastSocketClose: null,
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
    #${PANEL_ID} { display:block !important; visibility:visible !important; opacity:1 !important; position:fixed !important; right:10px; bottom:10px; z-index:2147483647 !important; width:min(320px,calc(100vw - 20px)); max-height:min(70vh,620px); overflow:hidden; border:1px solid #3f3f46; border-radius:7px; background:#111113; color:#f4f4f5; box-shadow:0 12px 32px rgba(0,0,0,.55); font:12px/1.35 Arial,Helvetica,sans-serif; }
    #${PANEL_ID} * { box-sizing:border-box; letter-spacing:0; }
    #${PANEL_ID}.wc-collapsed .wc-body { display:none; }
    #${PANEL_ID} .wc-header { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; min-height:42px; padding:5px 7px; border-bottom:1px solid #27272a; background:#18181b; cursor:move; touch-action:none; user-select:none; }
    #${PANEL_ID}.wc-dragging .wc-header { cursor:grabbing; }
    #${PANEL_ID} .wc-heading { min-width:0; flex:1; }
    #${PANEL_ID} .wc-title-row { display:flex; min-width:0; align-items:center; gap:4px; }
    #${PANEL_ID} .wc-player { min-width:0; flex:0 1 auto; overflow:hidden; font-weight:700; text-overflow:ellipsis; white-space:nowrap; }
    #${PANEL_ID} .wc-version { flex:0 0 auto; color:#71717a; font-size:10px; font-weight:400; }
    #${PANEL_ID} .wc-header-status { display:inline-flex; flex:0 0 auto; align-items:center; gap:3px; margin-left:auto; color:#d4d4d8; font-size:10px; font-weight:600; }
    #${PANEL_ID} .wc-matchup { margin-top:1px; overflow:hidden; color:#a1a1aa; font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
    #${PANEL_ID} .wc-body { max-height:calc(min(70vh,620px) - 42px); overflow:auto; padding:7px; }
    #${PANEL_ID} .wc-dot { width:7px; height:7px; flex:0 0 auto; border-radius:50%; background:#71717a; }
    #${PANEL_ID} .wc-dot.live { background:#10b981; }
    #${PANEL_ID} .wc-dot.wait { background:#f59e0b; }
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
    #${PANEL_ID} .wc-private-actions { display:flex; gap:5px; padding:0 6px 6px; }
    @media (max-width:520px) { #${PANEL_ID} { right:6px; bottom:6px; width:calc(100vw - 12px); max-height:58vh; } #${PANEL_ID} .wc-body { max-height:calc(58vh - 42px); } }
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
      window.PDA_httpGet(options.url, options.headers || {})
        .then((value) => options.onload?.(normalizeResponse(value))).catch(options.onerror);
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
  const isForeground = () => state.active
    && document.visibilityState !== "hidden"
    && (typeof navigator === "undefined" || navigator.onLine !== false);
  const backendUrl = (path) => `${BACKEND_BASE_URL.replace(/\/$/, "")}${path}`;
  const socketUrl = () => `${BACKEND_BASE_URL.replace(/^http/i, "ws").replace(/\/$/, "")}/ws`;
  const fallbackIsFresh = () => state.fallbackActive
    && Number.isFinite(Date.parse(state.lastFallbackAt))
    && Date.parse(state.lastFallbackAt) > Date.now() - (FALLBACK_POLL_MS * 3);

  function getStoredPanelPosition() {
    const raw = storage.get(POSITION_STORAGE, "");
    if (!raw) return null;
    try {
      const position = JSON.parse(String(raw));
      const left = Number(position?.left);
      const top = Number(position?.top);
      if (Number.isFinite(left) && Number.isFinite(top)) return { left, top };
    } catch {
      // Ignore invalid coordinates left by an older browser session.
    }
    storage.remove(POSITION_STORAGE);
    return null;
  }

  function clampPanelPosition(panel, left, top) {
    const width = panel.offsetWidth || panel.getBoundingClientRect().width || 320;
    const height = panel.offsetHeight || panel.getBoundingClientRect().height || 80;
    return {
      left: Math.min(Math.max(PANEL_EDGE_GAP, left), Math.max(PANEL_EDGE_GAP, window.innerWidth - width - PANEL_EDGE_GAP)),
      top: Math.min(Math.max(PANEL_EDGE_GAP, top), Math.max(PANEL_EDGE_GAP, window.innerHeight - height - PANEL_EDGE_GAP)),
    };
  }

  function setPanelPosition(panel, position, persist = false) {
    if (!panel || !position) return;
    const next = clampPanelPosition(panel, position.left, position.top);
    panel.style.left = `${next.left}px`;
    panel.style.top = `${next.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    if (persist) storage.set(POSITION_STORAGE, JSON.stringify(next));
  }

  function applyStoredPanelPosition() {
    const panel = document.getElementById(PANEL_ID);
    const position = getStoredPanelPosition();
    if (panel && position) setPanelPosition(panel, position);
  }

  function resetPanelPosition() {
    storage.remove(POSITION_STORAGE);
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    for (const property of ["left", "top", "right", "bottom"]) panel.style.removeProperty(property);
  }

  function attachPanelDragHandler(panel) {
    const header = panel?.querySelector(".wc-header");
    if (!header) return;
    let drag = null;

    const stopDrag = (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      header.releasePointerCapture?.(event.pointerId);
      panel.classList.remove("wc-dragging");
      state.dragging = false;
      if (drag.moved) {
        const rect = panel.getBoundingClientRect();
        setPanelPosition(panel, { left: rect.left, top: rect.top }, true);
      }
      drag = null;
      scheduleRender();
    };

    header.addEventListener("pointerdown", (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      if (event.target?.closest?.("button, a, input, summary, details")) return;
      const rect = panel.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left,
        top: rect.top,
        moved: false,
      };
      state.dragging = true;
      header.setPointerCapture?.(event.pointerId);
    });

    header.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      panel.classList.add("wc-dragging");
      event.preventDefault();
      setPanelPosition(panel, { left: drag.left + dx, top: drag.top + dy });
    });

    header.addEventListener("pointerup", stopDrag);
    header.addEventListener("pointercancel", stopDrag);
  }

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
        label: "War Companion login",
      });
      if (!response?.session?.wsSessionToken) throw new Error("Backend did not return a companion session");
      state.session = response.session;
      if (response.session.factionId && response.session.factionName) {
        state.factionNames.set(String(response.session.factionId), String(response.session.factionName));
      }
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

  function clearSocketConnectTimer() {
    if (state.socketConnectTimer) clearTimeout(state.socketConnectTimer);
    state.socketConnectTimer = 0;
  }

  function closeSocket() {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = 0;
    stopFallbackPolling();
    clearSocketConnectTimer();
    const socket = state.socket;
    state.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "Paused");
    }
  }

  function recoverFailedSocket(socket, message, reason = "Connection failed") {
    if (socket !== state.socket) return;
    clearSocketConnectTimer();
    state.socket = null;
    state.lastSocketClose = {
      code: 1006,
      reason,
      at: new Date().toISOString(),
    };
    if (fallbackIsFresh()) {
      state.error = "";
      state.phase = "fallback";
    } else {
      state.error = message;
      state.phase = isForeground() ? "connecting" : "paused";
    }
    try {
      if (socket.readyState < WebSocket.CLOSING) socket.close(4000, reason);
    } catch {
      // A rejected browser handshake may discard the socket before close() runs.
    }
    scheduleRender();
    if (isForeground()) {
      startFallbackPolling();
      scheduleReconnect();
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
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      if (state.fallbackActive) pollFallbackSnapshot();
      return;
    }
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
        const factionName = String(payload?.factionName || payload?.faction_name || "").trim();
        if (factionName) state.factionNames.set(factionId, factionName);
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

  function applyFallbackSnapshot(snapshot) {
    state.settings = snapshot?.settings || null;
    const factionNames = new Map();
    const ownFactionId = String(state.session?.factionId || "");
    const ownFactionName = String(state.session?.factionName || "").trim();
    if (ownFactionId && ownFactionName) factionNames.set(ownFactionId, ownFactionName);
    for (const [factionId, factionName] of Object.entries(snapshot?.factionNames || {})) {
      const normalizedName = String(factionName || "").trim();
      if (factionId && normalizedName) factionNames.set(String(factionId), normalizedName);
    }
    const rosters = new Map();
    for (const payload of Array.isArray(snapshot?.rosters) ? snapshot.rosters : []) {
      const factionId = String(payload?.factionId || payload?.faction_id || "");
      if (!factionId) continue;
      const factionName = String(payload?.factionName || payload?.faction_name || "").trim();
      if (factionName) factionNames.set(factionId, factionName);
      rosters.set(factionId, core.applyRosterUpdate(undefined, payload));
    }
    const scores = new Map();
    for (const score of Array.isArray(snapshot?.scores) ? snapshot.scores : []) {
      const factionId = String(score?.factionId || score?.faction_id || "");
      if (factionId) scores.set(factionId, score);
    }
    state.rosters = rosters;
    state.factionNames = factionNames;
    state.scores = scores;
    state.retaliation = snapshot?.retaliation || { attacks: [] };
    scheduleRender();
  }

  function clearFallbackTimer() {
    if (state.fallbackTimer) clearTimeout(state.fallbackTimer);
    state.fallbackTimer = 0;
  }

  function stopFallbackPolling() {
    clearFallbackTimer();
    state.fallbackGeneration += 1;
    state.fallbackActive = false;
    state.fallbackInFlight = false;
  }

  function scheduleFallbackPoll() {
    clearFallbackTimer();
    if (!state.fallbackActive || !isForeground()) return;
    state.fallbackTimer = setTimeout(() => {
      state.fallbackTimer = 0;
      pollFallbackSnapshot();
    }, FALLBACK_POLL_MS);
  }

  function startFallbackPolling() {
    if (!state.session || !state.token || !isForeground()) return;
    state.fallbackActive = true;
    pollFallbackSnapshot();
  }

  async function pollFallbackSnapshot() {
    if (!state.fallbackActive || state.fallbackInFlight || !isForeground()) return;
    const generation = state.fallbackGeneration;
    state.fallbackInFlight = true;
    clearFallbackTimer();
    try {
      const expiresAt = Date.parse(String(state.session?.wsSessionTokenExpiresAt || state.session?.expiresAt || ""));
      if (!state.token || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 30_000) {
        await authenticate();
      }
      const factionId = String(state.session?.factionId || "");
      if (!factionId || !state.token) throw new Error("Companion session is unavailable");
      const snapshot = await requestJson({
        method: "GET",
        url: backendUrl(`/api/v1/factions/${encodeURIComponent(factionId)}/war-companion/snapshot?timestamp=${Date.now()}`),
        headers: { Authorization: `Bearer ${state.token}` },
        label: "War Companion snapshot",
      });
      if (generation !== state.fallbackGeneration || !state.fallbackActive || !isForeground()) return;
      applyFallbackSnapshot(snapshot);
      state.phase = "fallback";
      state.error = "";
      state.lastFallbackAt = new Date().toISOString();
      state.lastFallbackError = "";
    } catch (error) {
      if (generation !== state.fallbackGeneration || !state.fallbackActive) return;
      state.lastFallbackError = String(error?.message || "Fallback update failed");
      if (fallbackIsFresh()) {
        state.phase = "fallback";
        state.error = "";
      } else if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
        state.phase = "connecting";
        state.error = `Live connection and compatible fallback failed: ${state.lastFallbackError}`;
      }
      scheduleRender();
    } finally {
      if (generation !== state.fallbackGeneration) return;
      state.fallbackInFlight = false;
      scheduleFallbackPoll();
    }
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
    const delay = state.fallbackActive
      ? FALLBACK_SOCKET_RETRY_MS
      : Math.min(20_000, 1_000 * 2 ** Math.min(state.reconnectAttempt, 4));
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
      if (isTornPda) {
        if (!fallbackIsFresh()) state.phase = "connecting";
        startFallbackPolling();
        scheduleRender();
        return;
      }
      if (!fallbackIsFresh()) {
        state.phase = "connecting";
        scheduleRender();
      }
      const socket = new window.WebSocket(socketUrl());
      state.socket = socket;
      clearSocketConnectTimer();
      state.socketConnectTimer = setTimeout(() => {
        if (socket !== state.socket) return;
        state.socketConnectTimer = 0;
        if (socket.readyState === WebSocket.OPEN) return;
        recoverFailedSocket(
          socket,
          "Live connection timed out. Retrying automatically.",
          "Handshake timed out"
        );
      }, SOCKET_CONNECT_TIMEOUT_MS);
      socket.addEventListener("open", () => {
        if (socket !== state.socket) return;
        clearSocketConnectTimer();
        stopFallbackPolling();
        state.phase = "connected";
        state.reconnectAttempt = 0;
        state.error = "";
        state.lastSocketClose = null;
        subscribeTopics(socket);
        scheduleRender();
      });
      socket.addEventListener("message", handleSocketMessage);
      socket.addEventListener("error", () => {
        if (socket !== state.socket) return;
        state.lastSocketErrorAt = new Date().toISOString();
        setTimeout(() => {
          if (socket !== state.socket || socket.readyState < WebSocket.CLOSING) return;
          recoverFailedSocket(
            socket,
            "Live connection was rejected. Retrying automatically.",
            "Handshake rejected"
          );
        }, 0);
      });
      socket.addEventListener("close", (event) => {
        if (socket !== state.socket) return;
        clearSocketConnectTimer();
        state.socket = null;
        state.lastSocketClose = {
          code: Number(event.code || 1006),
          reason: String(event.reason || ""),
          at: new Date().toISOString(),
        };
        if (!isForeground()) {
          state.phase = "paused";
          scheduleRender();
          return;
        }
        if (event.code === 1008) {
          state.token = "";
          state.session = null;
          state.error = "Live authorization expired. Reconnecting.";
        } else if (typeof navigator !== "undefined" && navigator.onLine === false) {
          state.error = "Device is offline. Live updates will resume automatically.";
        } else if (state.reconnectAttempt >= 2) {
          state.error = `Live connection interrupted (code ${event.code || 1006}). Retrying automatically.`;
        }
        state.phase = fallbackIsFresh() ? "fallback" : "connecting";
        if (state.token && state.session) startFallbackPolling();
        scheduleRender();
        scheduleReconnect();
      });
    } catch (error) {
      if (fallbackIsFresh()) {
        state.phase = "fallback";
        state.error = "";
      } else if (!state.error) {
        state.error = String(error?.message || "Could not start the live connection");
      }
      scheduleRender();
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
      if (getStoredKey()) startTicker();
      else stopTicker();
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
    const ownFactionName = String(state.session?.factionName || state.factionNames.get(ownFactionId) || "").trim();
    const enemyFactionName = String(state.factionNames.get(enemyFactionId) || "").trim();
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
    return { ownFactionId, ownFactionName, enemyFactionId, enemyFactionName, actions, retaliation };
  }

  const statusView = () => {
    if (!getStoredKey()) return { label: "API key needed", tone: "" };
    if (state.phase === "connected") return { label: "Live", tone: "live" };
    if (state.phase === "fallback") return { label: "Live (compatible)", tone: "live" };
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
    if (state.dragging) return;
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
    const noWar = (state.phase === "connected" || state.phase === "fallback")
      && !trackerDisabled
      && !view.enemyFactionId;
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
    const ownFactionLabel = view.ownFactionName || (view.ownFactionId ? `Faction ${view.ownFactionId}` : "");
    const enemyFactionLabel = view.enemyFactionName || (view.enemyFactionId ? `Faction ${view.enemyFactionId}` : "");
    const matchupLabel = enemyFactionLabel ? `${ownFactionLabel} vs ${enemyFactionLabel}` : ownFactionLabel;
    const matchupTitle = view.enemyFactionId
      ? `${ownFactionLabel} (${view.ownFactionId}) vs ${enemyFactionLabel} (${view.enemyFactionId})`
      : ownFactionLabel;

    panel.innerHTML = `<div class="wc-header">
      <div class="wc-heading"><div class="wc-title-row"><span class="wc-player">${escapeHtml(state.session?.playerName || "War Companion")}</span><span class="wc-version">v${SCRIPT_VERSION}</span><span class="wc-header-status"><span class="wc-dot ${status.tone}"></span>${escapeHtml(status.label)}</span></div>${matchupLabel ? `<div class="wc-matchup" title="${escapeHtml(matchupTitle)}">${escapeHtml(matchupLabel)}</div>` : ""}</div>
      <button class="wc-button wc-icon" data-action="collapse" title="${state.collapsed ? "Expand" : "Collapse"}">${state.collapsed ? "+" : "-"}</button>
    </div>
    <div class="wc-body">
      ${state.error ? `<div class="wc-error">${escapeHtml(state.error)}</div>` : ""}
      ${savedKey ? "" : `<div class="wc-row"><input class="wc-input wc-secret-input" data-field="api-key" type="text" inputmode="text" autocomplete="one-time-code" autocapitalize="none" autocorrect="off" spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore="true" data-protonpass-ignore="true" data-form-type="other" aria-label="Torn API key" placeholder="Torn API key" value="${escapeHtml(state.keyDraft)}"><button class="wc-button primary" data-action="connect">Connect</button></div>`}
      ${savedKey ? `<div class="wc-section"><div class="wc-section-title"><span>Action queue</span><span class="wc-count">${view.actions.length}</span></div>${queueMarkup}</div>${retaliationSection}` : ""}
      <details data-section="privacy"${state.privacyOpen ? " open" : ""}><summary>Privacy</summary><div class="wc-privacy">The key stays in your userscript storage. Torn and the backend use it only to verify your profile and faction; the companion session is read-only.</div>${savedKey ? `<div class="wc-private-actions"><button class="wc-button" data-action="refresh">Reconnect</button><button class="wc-button" data-action="forget">Forget key</button></div>` : ""}</details>
    </div>`;

    const nextBody = panel.querySelector(".wc-body");
    if (nextBody) nextBody.scrollTop = bodyScrollTop;
    panel.querySelector('[data-section="privacy"]')?.addEventListener("toggle", (event) => {
      state.privacyOpen = event.currentTarget.open;
    });
    applyStoredPanelPosition();
    attachPanelDragHandler(panel);

    panel.querySelector('[data-action="collapse"]')?.addEventListener("click", () => {
      state.collapsed = !state.collapsed;
      storage.set(COLLAPSED_STORAGE, state.collapsed ? "1" : "0");
      scheduleRender();
    });
    panel.querySelector('[data-action="connect"]')?.addEventListener("click", connectFromInput);
    const keyInput = panel.querySelector('[data-field="api-key"]');
    keyInput?.addEventListener("input", (event) => {
      state.keyDraft = String(event.currentTarget?.value || "");
    });
    keyInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") connectFromInput();
    });
    panel.querySelector('[data-action="refresh"]')?.addEventListener("click", () => {
      const resumeFallback = state.fallbackActive;
      state.rosters.clear();
      state.scores.clear();
      state.retaliation = { attacks: [] };
      closeSocket();
      state.phase = "connecting";
      if (resumeFallback) startFallbackPolling();
      setTimeout(ensureConnected, 50);
      scheduleRender();
    });
    panel.querySelector('[data-action="forget"]')?.addEventListener("click", () => {
      storage.remove(KEY_STORAGE);
      state.keyDraft = "";
      stopTicker();
      closeSocket();
      state.session = null;
      state.token = "";
      state.error = "";
      state.phase = "idle";
      state.rosters.clear();
      state.factionNames.clear();
      state.scores.clear();
      state.settings = null;
      state.retaliation = { attacks: [] };
      scheduleRender();
    });
  }

  function connectFromInput() {
    const input = document.querySelector(`#${PANEL_ID} [data-field="api-key"]`);
    const key = String(input?.value || state.keyDraft || "").trim();
    if (!key) return;
    storage.set(KEY_STORAGE, key);
    state.keyDraft = "";
    state.token = "";
    state.session = null;
    startTicker();
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
      `Phase: ${state.phase}`,
      `Page visibility: ${document.visibilityState}`,
      `Browser online: ${typeof navigator === "undefined" || navigator.onLine !== false ? "yes" : "no"}`,
      `WebSocket state: ${state.socket?.readyState ?? "none"}`,
      `Transport: ${state.phase === "fallback" ? "compatible HTTP fallback" : "WebSocket"}`,
      `Connect watchdog: ${state.socketConnectTimer ? "armed" : "idle"}`,
      `Last socket error: ${state.lastSocketErrorAt || "none"}`,
      `Last close: ${state.lastSocketClose ? `${state.lastSocketClose.code}${state.lastSocketClose.reason ? ` (${state.lastSocketClose.reason})` : ""} at ${state.lastSocketClose.at}` : "none"}`,
      `Last fallback update: ${state.lastFallbackAt || "none"}`,
      `Last fallback error: ${state.lastFallbackError || "none"}`,
      `Endpoint: ${socketUrl()}`,
      window.location.href,
    ].join("\n"));
  });

  registerMenuCommand("Warbuddy: reset position", () => {
    resetPanelPosition();
    applyStoredPanelPosition();
  });

  document.addEventListener("visibilitychange", syncForegroundState);
  window.addEventListener("focus", syncForegroundState);
  window.addEventListener("online", syncForegroundState);
  window.addEventListener("offline", syncForegroundState);
  window.addEventListener("resize", applyStoredPanelPosition);
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
