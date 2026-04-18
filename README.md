# PeerCall

> Video calls without a backend. No signup, no server, no tracking. Just a link.

PeerCall is a free, open-source video call app powered by WebRTC. It works peer-to-peer — your video, audio, and chat data never pass through a central server. Share a link, and call.

## How it works

```
You open the page → Create a room → Share the link
Your friend opens the link → PeerJS connects you both
Video/audio flows directly between your browsers
No server ever sees your data
```

**Signaling** uses PeerJS's free cloud service (just to establish the connection, then it's P2P).
**Media** flows directly between browsers via WebRTC.
**Chat** uses WebRTC DataChannels.

## Features

- 🎥 Video and audio calls (1-6 participants, mesh P2P)
- 🖥️ Screen sharing
- 💬 In-call chat (DataChannel)
- 🔇 Mute/camera toggle with indicators
- 🔗 Share a link — no signup needed
- 🔒 No backend, no tracking, no data stored
- 📱 Responsive — works on mobile

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173 in two browsers (or share the link with a friend).

## Architecture

```
┌─────────────┐          PeerJS signaling          ┌─────────────┐
│   Browser A │ ◄─────────────────────────────────► │   Browser B │
│             │                                     │             │
│  ┌────────┐ │          WebRTC P2P                │ ┌────────┐  │
│  │ Camera │ ├────────────────────────────────────►│ │ Camera │  │
│  │  Mic   │ │  (video, audio, chat data)         │ │  Mic   │  │
│  └────────┘ │                                     │ └────────┘  │
└─────────────┘                                     └─────────────┘
```

- **PeerJS** handles signaling (finding peers, exchanging connection info)
- **WebRTC** handles media and data channels (direct P2P)
- **No server** processes, stores, or relays your calls

## Limitations

- **Max ~6 participants**: Mesh P2P doesn't scale beyond small groups. For larger calls, you'd need an SFU (MediaSoup, Janus, etc.)
- **NAT traversal**: Most connections work via STUN/TURN. PeerJS uses free STUN servers; for restrictive NATs, you'd want a TURN relay
- **Room persistence**: When the host leaves, the room ends. This is by design — calls are ephemeral

## Tech stack

- **WebRTC** — P2P video/audio/data
- **PeerJS** — WebRTC signaling
- **TypeScript** — type safety
- **Vite** — fast dev server and bundler
- **Vanilla CSS** — no framework overhead

## Running in production

```bash
npm run build
```

Deploy the `dist/` folder to any static host (Vercel, Netlify, Cloudflare Pages, GitHub Pages).

For TURN support in restrictive networks, configure a TURN server in `peer.ts`.

## Self-hosting

If you don't want to depend on PeerJS's cloud signaling, you can run your own:

```bash
npx peerjs --port 9000 --path /myapp
```

Then configure the Peer constructor:

```typescript
const peer = new Peer(peerId, {
  host: 'your-server.com',
  port: 9000,
  path: '/myapp',
});
```

## License

MIT