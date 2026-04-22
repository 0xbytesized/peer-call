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

1. `index.html` is a single-page app with four overlay views: `#lobby`, `#setup`, `#call`, `#connecting`. `src/main.ts` toggles them via `.hidden`.
2. On load, `main.ts` reads `window.location.hash` / `?room=` — if present, it jumps into `joinRoom(code)`; otherwise the lobby is shown.
3. `createRoom` / `joinRoom` **do not create the PeerJS peer yet** — they set `pendingSetup = { mode, roomCode? }`, construct a `PeerCallManager`, and call `startSetup()` which enters the **green-room view**: media is acquired via `manager.startMedia()`, camera pipeline is wired up, mic-level meter is attached, and the user can adjust name/camera/mic/speaker/noise suppression/filters against a live preview. Nothing leaves the browser at this point.
4. When the user clicks "Unirse", `confirmSetup()` runs `manager.createRoom()` or `manager.joinRoom(code)` (the actual signaling), and `showCallView()` promotes the already-configured `localStream` into the call grid via `addLocalVideo()`.
5. `acquireMediaForSetup()` cascades through fallbacks: (audio+video) → (audio-only) → (no media placeholder). Joining with no media is allowed; the user can enable camera/mic later from the call-view controls.

### Shared device actions

`switchMic`, `switchCamera`, `switchSpeaker`, `setNoiseSuppressionEnabled` live at module top in `main.ts` and are used by both the setup view and the call-view panels (camera popover, settings panel). They own the full track-swap: acquire new device, rebuild the noise-suppression / camera pipelines as needed, swap into `localStream`, and `replaceTrack` on every outgoing RTP sender. The setup-view handlers and call-view handlers both delegate to these; UI-sync helpers like `updateNoiseSuppressionUI()` update both sets of controls.

### Peer disconnection handling

Cleanup has two complementary paths:

1. **Our side** — `window` listens for both `pagehide` and `beforeunload` and calls `manager.leave()`, which closes every DataConnection + MediaConnection and destroys the Peer. This gives remotes a clean close signal on normal tab close / navigation so their DataConnection `close` event fires immediately (instead of waiting on ICE timeout). `leave()` is idempotent via `hasLeft`.

2. **Remote side** — `watchConnection()` in `peer.ts` attaches `iceconnectionstatechange` to each MediaConnection's underlying `RTCPeerConnection`. `failed`/`closed` trigger immediate `removePeer`. `disconnected` starts a 3-second timer (cleared on recovery to `connected`/`completed`) — this catches the force-kill case where the peer's browser crashes without sending a proper close. Without this, remotes would stare at a frozen frame for ~15s until the default ICE timeout.

### Peer mesh

`src/peer.ts` (`PeerCallManager`) is the P2P core. It's a **full-mesh** topology — every participant holds a data connection + media call to every other participant. This is why the app caps at ~6 participants.

- **Host** creates a Peer with ID `pcall-<roomCode>` (deterministic, so joiners know where to connect). Room codes are 9 chars from a restricted alphabet (see `generateCode`).
- **Joiners** connect to the host; the host then sends them a `peer-list` message containing everyone else, and they each dial those peers directly. Non-host peers also announce themselves via `join` messages so new arrivals get discovered after the initial handshake.
- Each peer relationship has **two channels**: a `DataConnection` (chat, control messages, rename, audio/video toggle broadcasts) and a `MediaConnection` (video+audio tracks). They are tracked together in the `RemotePeer` struct.
- Signaling over PeerJS cloud is only used to establish connections. After ICE negotiation, media and data flow directly peer-to-peer.

### ICE configuration

`CUSTOM_ICE_SERVERS` in `peer.ts` bundles Google STUN + Metered Open Relay TURN (UDP and TCP on ports 80/443). TURN is required for mobile/CGNAT/symmetric-NAT scenarios where direct P2P fails. If you swap in a different TURN provider, keep the TCP-on-443 entry — some ISPs block everything else.

### Camera filter pipeline

`src/camera-filters.ts` runs a **WebGL** pipeline on the raw camera track: video → texture upload → horizontal gaussian blur (9-tap, FBO) → vertical gaussian blur + brightness/contrast/saturation (composite to canvas) → `canvas.captureStream()`. The captured track is what sits in `localStream` and the WebRTC senders, so **remote peers see the filtered image on every browser** (including iPad Safari, which silently ignores `ctx.filter`). Filters persist in `localStorage` under `peercall-filters`.

When the user changes camera device or starts the call, `applyCameraPipeline()` in `main.ts` tears down the old pipeline (which owns and stops the raw camera) and swaps the new canvas track into `localStream` and senders via `replaceTrack`. If WebGL context creation fails (extremely rare), `detectPipelineSupport()` returns false and filters degrade to `style.filter` on the local `<video>` (local-only, not retransmitted); every filter-update site branches on whether `cameraPipeline` is non-null.

### Track replacement pattern

Several features (device switching, screen share, noise suppression) swap out the local `MediaStreamTrack` without tearing down the PeerConnection. The pattern used throughout `main.ts`:

1. Get the new track.
2. Mutate `localStream` (remove old track, add new).
3. For each remote peer, `getPeerConnection(remotePeer).getSenders().find(s => s.track?.kind === 'audio' | 'video').replaceTrack(newTrack)`.

`getPeerConnection()` in `peer.ts` is a small helper that reaches into PeerJS's internal `MediaConnection.peerConnection` field — this isn't public API, so if the PeerJS version bumps, verify the cast still works.

### Noise suppression

`src/noise-suppression.ts` wraps `@sapphi-red/web-noise-suppressor`, which ships an AudioWorkletProcessor with RNNoise bundled as WASM. The graph is `MediaStreamSource → RnnoiseWorkletNode → MediaStreamDestination`. All denoising runs on the audio render thread — no main-thread audio glitches and no `ScriptProcessorNode` deprecation warnings.

The `.wasm` and worklet `.js` are imported with Vite's `?url` suffix (see `src/vite-env.d.ts` for the `vite/client` types) and shipped as separate assets; `loadRnnoise` fetches them lazily on first enable. `audioContext.audioWorklet.addModule(workletUrl)` is called per-context inside `buildGraph`, so the graph can be torn down and rebuilt cheaply when the user switches mic.

Non-obvious: the module keeps a **cloned copy of the original audio track** so disabling noise suppression can restore bitwise-identical audio (the raw track may get mutated by the caller during track replacement). If the user switches mic while NS is active, call `updateNoiseSuppressionSource(newStream)` rather than toggling off/on — it stops the stale clone, rebuilds the graph against the new mic, and returns a fresh processed stream to swap into `localStream` and remote senders.

### UI conventions

- Icons are Lucide, rendered by hand (not the lucide runtime). `renderIcon(name)` in `main.ts` walks the `iconMap` entries (each is a `[tag, attrs]` tuple tree) and produces inline SVG strings. `replaceIcon(btn, name)` swaps an existing icon for toggles.
- Persisted client state (all in `localStorage`): display name at key `peercall-name`, and mic/speaker/camera selections at key `peercall-devices` (JSON `{ mic, speaker, camera }`).
- Feature detection: `setSinkId` (speaker selection) is gated behind `sinkSupported`; the speaker `<select>` is hidden entirely on iOS where the API doesn't exist.

### Deployment

`Dockerfile` is a two-stage build: node-alpine for `pnpm build`, then nginx-alpine serving `dist/`. `nginx.conf` rewrites everything to `/index.html` (SPA routing) and long-caches `/assets/`. Static deploy targets (Vercel, Netlify, etc.) work equally well — there's nothing server-side.
