# Askelads Warbuddy

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
- Warbuddy connects only while the Torn tab is visible and focused.
- Its backend session can subscribe only to War Tracker settings, rosters, score, and retaliation for the verified faction.

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

### 0.1.2 - 20 August 2026

- Warbuddy now appears only on Torn faction war routes.
- Bazaar and other unrelated pages no longer keep the panel, ticker, or live WebSocket active.

### 0.1.1 - 20 August 2026

- Privacy now stays open while the live one-second countdown refreshes the panel.
- The panel keeps its scroll position across live updates.

### 0.1.0 - 20 August 2026

- Initial standalone release with the action queue and live retaliation opportunities.
