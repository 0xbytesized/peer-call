# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager: `pnpm` (production via Docker uses `pnpm`; `npm` also works locally per README).

- `pnpm dev` — start Vite dev server on http://localhost:5173
- `pnpm build` — type-check (`tsc`) then produce a static bundle in `dist/`
- `pnpm preview` — serve the built `dist/` locally
- `pnpm lint` / `pnpm lint:fix` — ESLint over `src/` (config: `eslint-config-mytools` base + typescript + prettier)
- `pnpm format` — Prettier over `src/**/*.{ts,css,html,json}`

No test suite exists. There is no single-test runner because there are no tests. When verifying changes, open the dev server in **two browsers** (or one browser + incognito) and exercise create-room / join-room, since this is the only way to see P2P behavior end-to-end.

## Architecture

PeerCall is a **zero-backend** WebRTC video-conferencing app. Everything runs in the browser; the only external service used is PeerJS's free signaling cloud. The production "server" is just nginx serving static assets (see `Dockerfile` + `nginx.conf`).

### Entry flow

1. `index.html` is a single-page app with three overlay views: `#lobby`, `#call`, `#connecting`. `src/main.ts` toggles them via `.hidden`.
2. On load, `main.ts` reads `window.location.hash` / `?room=` — if present, it jumps straight into `joinRoom(code)`; otherwise the lobby is shown.
3. After create/join, `requestMedia()` cascades through fallbacks: (audio+video) → (video-only) → (audio-only) → (no media placeholder). This is important for mobile browsers that reject combined permission requests.

### Peer mesh

`src/peer.ts` (`PeerCallManager`) is the P2P core. It's a **full-mesh** topology — every participant holds a data connection + media call to every other participant. This is why the app caps at ~6 participants.

- **Host** creates a Peer with ID `pcall-<roomCode>` (deterministic, so joiners know where to connect). Room codes are 9 chars from a restricted alphabet (see `generateCode`).
- **Joiners** connect to the host; the host then sends them a `peer-list` message containing everyone else, and they each dial those peers directly. Non-host peers also announce themselves via `join` messages so new arrivals get discovered after the initial handshake.
- Each peer relationship has **two channels**: a `DataConnection` (chat, control messages, rename, audio/video toggle broadcasts) and a `MediaConnection` (video+audio tracks). They are tracked together in the `RemotePeer` struct.
- Signaling over PeerJS cloud is only used to establish connections. After ICE negotiation, media and data flow directly peer-to-peer.

### ICE configuration

`CUSTOM_ICE_SERVERS` in `peer.ts` bundles Google STUN + Metered Open Relay TURN (UDP and TCP on ports 80/443). TURN is required for mobile/CGNAT/symmetric-NAT scenarios where direct P2P fails. If you swap in a different TURN provider, keep the TCP-on-443 entry — some ISPs block everything else.

### Track replacement pattern

Several features (device switching, screen share, noise suppression) swap out the local `MediaStreamTrack` without tearing down the PeerConnection. The pattern used throughout `main.ts`:

1. Get the new track.
2. Mutate `localStream` (remove old track, add new).
3. For each remote peer, `getPeerConnection(remotePeer).getSenders().find(s => s.track?.kind === 'audio' | 'video').replaceTrack(newTrack)`.

`getPeerConnection()` in `peer.ts` is a small helper that reaches into PeerJS's internal `MediaConnection.peerConnection` field — this isn't public API, so if the PeerJS version bumps, verify the cast still works.

### Noise suppression

`src/noise-suppression.ts` wraps `@shiguredo/rnnoise-wasm`. It builds an AudioContext graph (`MediaStreamSource → ScriptProcessor → MediaStreamDestination`), feeds 480-sample frames to RNNoise (in-place write), and exposes a cleaned MediaStream.

Non-obvious: the module keeps a **cloned copy of the original audio track** so disabling noise suppression can restore bitwise-identical audio (the raw track may get mutated by the caller during track replacement). `ScriptProcessorNode` is deprecated but still the simplest path; migrating to `AudioWorklet` would require moving RNNoise into a worklet context.

### UI conventions

- Icons are Lucide, rendered by hand (not the lucide runtime). `renderIcon(name)` in `main.ts` walks the `iconMap` entries (each is a `[tag, attrs]` tuple tree) and produces inline SVG strings. `replaceIcon(btn, name)` swaps an existing icon for toggles.
- Persisted client state (all in `localStorage`): display name at key `peercall-name`, and mic/speaker/camera selections at key `peercall-devices` (JSON `{ mic, speaker, camera }`).
- Feature detection: `setSinkId` (speaker selection) is gated behind `sinkSupported`; the speaker `<select>` is hidden entirely on iOS where the API doesn't exist.

### Deployment

`Dockerfile` is a two-stage build: node-alpine for `pnpm build`, then nginx-alpine serving `dist/`. `nginx.conf` rewrites everything to `/index.html` (SPA routing) and long-caches `/assets/`. Static deploy targets (Vercel, Netlify, etc.) work equally well — there's nothing server-side.
