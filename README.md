# Askelads Warbuddy

## 0.1.14

- Supports Torn PDA's authenticated HTTP bridge when its native WebSocket is unavailable.
- Keeps the bearer token on PDA snapshot requests so the panel remains live through compatible polling.
- Starts the compatible feed immediately in Torn PDA instead of waiting for a WebSocket timeout.

Askelads Warbuddy is a read-only Torn userscript for the live war action queue and retaliation opportunities supplied by the Grusmedia backend.

## Install

1. Install Tampermonkey or another userscript manager.
2. Open [Install Askelads Warbuddy](https://raw.githubusercontent.com/Grussniffer/Askelads-Warbuddy/main/askelads-warbuddy.user.js).
3. Confirm the installation in your userscript manager.
4. Open Torn and enter a Torn API key when Warbuddy asks for one.

The install URL ends in `.user.js` and includes update metadata, so supported userscript managers can recognize it and receive later releases automatically.

## What It Shows

- Current chain-risk and hospital-exit opportunities from the faction War Tracker.
- Online enemy targets when they are relevant to the action queue.
- Active retaliation windows with explicit links to Torn.
- A stable empty state when there are no immediate actions.

Warbuddy displays information and links only. It does not attack, click, submit, claim, notify, or perform Torn actions for the player.

## Access And Privacy

- The Torn API key is stored locally by the userscript manager.
- The key is used to identify the player and faction, then exchanged for a six-hour, faction-scoped, read-only companion session.
- The key is not saved to the backend during that exchange.
- Warbuddy connects only while a Torn faction tab is visible and the device is online.
- Its backend session can read only War Tracker settings, rosters, score, and retaliation for the verified faction.
- WebSocket updates are preferred. If the browser rejects a third-party socket inside Torn, Warbuddy automatically uses a cached read-only snapshot without making extra Torn API calls.
- Torn PDA normally uses this compatible snapshot path and may therefore show **Live (compatible)** instead of **Live**.

If the earlier **Lads War Companion** script is installed, remove or disable it before installing Warbuddy so two copies do not run on the same Torn page.

## Development

```bash
npm test
npm run build
```

The build writes the installable `askelads-warbuddy.user.js` and update-only `askelads-warbuddy.meta.js` files to the repository root and `dist/`.

Source files:

- `src/core.cjs` contains the deterministic queue and live-state logic.
- `src/userscript.js` contains Torn UI, storage, authentication, and WebSocket integration.
- `userscript.header.txt` contains the userscript metadata.

Backend access is provided by `https://backend.grusmedia.no`; this repository contains no backend secrets.

## Releases

### 0.1.14 - 20 August 2026

- Torn PDA HTTP requests now retain their authorization headers.
- Warbuddy uses Torn PDA's HTTP bridge when its userscript transport is unavailable, while desktop userscript managers retain `GM_xmlhttpRequest`.
- Torn PDA skips the unsupported WebSocket attempt and begins compatible polling immediately.

### 0.1.13 - 20 August 2026

- Moves the live connection state beside the player name and version.
- Shows the named allied and enemy faction matchup in the compact header.
- Moves **Reconnect** and **Forget key** into Privacy so the normal panel stays focused on actions.

### 0.1.12 - 20 August 2026

- Stops the one-second live ticker until an API key has been submitted.
- Keeps an unsaved in-memory key draft intact if Torn remounts the panel while it is being entered.

### 0.1.11 - 20 August 2026

- A compatible HTTP snapshot now takes over automatically when Torn, Chrome, or a userscript environment rejects the native WebSocket.
- The fallback reads the same faction-scoped in-memory state as the socket and never sends the stored Torn key.
- Fallback requests pause with the tab, share a short gateway cache, and keep retrying the faster WebSocket in the background.

### 0.1.10 - 20 August 2026

- Warbuddy now requests Tampermonkey's isolated DOM sandbox instead of its default raw page context.
- The live WebSocket therefore bypasses Torn's page CSP and uses the gateway's restricted extension-origin path.

### 0.1.9 - 20 August 2026

- Tampermonkey extension-origin sockets now use the backend's restricted, signed Warbuddy session path.
- Rejected handshakes recover even when the browser reports `error` and `CLOSED` without a matching `close` event.
- The connection watchdog can no longer remain armed around an already-closed socket.

### 0.1.8 - 20 August 2026

- A 15-second watchdog replaces WebSockets that remain stuck in the browser's connecting state.
- Delayed close events from an older socket can no longer pause its replacement.
- Connection diagnostics now show whether the opening-handshake watchdog is active.

### 0.1.7 - 20 August 2026

- Drag the panel by its header; its position is saved locally and clamped to the current screen.
- A **Warbuddy: reset position** command restores the default lower-right placement.
- Visible tabs no longer tear down the live socket on brief browser-focus changes.
- Interrupted sockets reconnect automatically, while diagnostics now include connection state and close details.

### 0.1.6 - 20 August 2026

- The Torn API key entry no longer presents itself as a browser password field.
- Browser and password-manager autofill hints prevent Warbuddy from prompting for or inserting an email address elsewhere on Torn.
- The key remains visually masked while it is entered.

### 0.1.5 - 20 August 2026

- Warbuddy now uses the same body-mounted `div` and DOM-observer lifecycle pattern as the OC userscript.
- Torn faction styles can no longer hide the panel, and Torn DOM rebuilds restore it immediately.
- Tampermonkey now provides **Warbuddy: show panel** and **Warbuddy: diagnostics** menu commands for direct runtime checks.
- Script injection is limited to Torn faction URLs instead of every Torn page.

### 0.1.4 - 20 August 2026

- Warbuddy now remounts itself if Torn replaces the faction page shell or removes the panel.
- Browser back/forward cache restores restart route checks and the live connection cleanly.
- Faction path matching also supports extensionless Torn faction routes while Bazaar remains excluded.

### 0.1.3 - 20 August 2026

- Warbuddy is available throughout Torn's faction pages, including Torn's alternate and empty hash states.
- Bazaar and every other non-faction page still stop the panel, ticker, and live WebSocket.

### 0.1.2 - 20 August 2026

- Warbuddy now appears only on Torn faction war routes.
- Bazaar and other unrelated pages no longer keep the panel, ticker, or live WebSocket active.

### 0.1.1 - 20 August 2026

- Privacy now stays open while the live one-second countdown refreshes the panel.
- The panel keeps its scroll position across live updates.

### 0.1.0 - 20 August 2026

- Initial standalone release with the action queue and live retaliation opportunities.
