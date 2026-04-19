import Peer, { DataConnection, MediaConnection, PeerOptions } from 'peerjs';

// ─── ICE Servers ───
// STUN discovers public IPs; TURN relays traffic when P2P fails (CGNAT, symmetric NAT).
// PeerJS includes its own STUN+TURN by default, but we add Metered Open Relay
// for better NAT traversal behind Movistar/ISP routers.

const CUSTOM_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

// ─── Types ───

export interface PeerMessage {
  type: 'join' | 'peer-list' | 'chat' | 'screen-start' | 'screen-stop' | 'rename' | 'audio-toggle' | 'video-toggle';
  payload: unknown;
}

export interface RemotePeer {
  id: string;
  name: string;
  conn: DataConnection;
  call?: MediaConnection;
  stream?: MediaStream;
  audioEnabled: boolean;
  videoEnabled: boolean;
}

type EventHandler =
  | { type: 'peer-joined'; peer: RemotePeer }
  | { type: 'peer-left'; peerId: string }
  | { type: 'stream'; peerId: string; stream: MediaStream }
  | { type: 'stream-removed'; peerId: string }
  | { type: 'chat'; peerId: string; text: string }
  | { type: 'screen'; peerId: string; stream: MediaStream }
  | { type: 'screen-stop'; peerId: string }
  | { type: 'audio-toggle'; peerId: string; enabled: boolean }
  | { type: 'video-toggle'; peerId: string; enabled: boolean }
  | { type: 'error'; message: string };

const TIMEOUT_MS = 20000;

function buildPeerOptions(id?: string): PeerOptions {
  return {
    debug: 2, // Errors + Warnings — helps debug in browser console
    config: {
      iceServers: CUSTOM_ICE_SERVERS,
      sdpSemantics: 'unified-plan',
    },
  };
}

// ─── Peer Manager ───

export class PeerCallManager {
  private peer: Peer | null = null;
  private peers: Map<string, RemotePeer> = new Map();
  private localStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private isHost = false;
  private roomId = '';
  private userName = '';

  private listeners: ((event: EventHandler) => void)[] = [];

  constructor() {
    this.userName = this.generateName();
  }

  on(handler: (event: EventHandler) => void) {
    this.listeners.push(handler);
  }

  private emit(event: EventHandler) {
    for (const h of this.listeners) h(event);
  }

  get myName() { return this.userName; }
  get myId() { return this.peer?.id ?? ''; }
  get peerList() { return [...this.peers.values()]; }
  get roomCode() { return this.roomId; }
  get isHosting() { return this.isHost; }

  // ─── Create / Join ───

  async createRoom(): Promise<string> {
    this.roomId = this.generateCode();
    const peerId = `pcall-${this.roomId}`;
    this.isHost = true;

    console.log(`[PeerCall] createRoom: peerId=${peerId}`);

    return new Promise((resolve, reject) => {
      const opts = buildPeerOptions();
      console.log('[PeerCall] Creating Peer with options:', JSON.stringify(opts));
      this.peer = new Peer(peerId, opts);

      const timeout = setTimeout(() => {
        console.error('[PeerCall] createRoom timeout after', TIMEOUT_MS, 'ms');
        this.peer?.destroy();
        this.peer = null;
        reject(new Error('Timed out creating room. Check your connection.'));
      }, TIMEOUT_MS);

      this.peer.on('open', (id) => {
        clearTimeout(timeout);
        console.log('[PeerCall] createRoom open, id=', id);
        resolve(this.roomId);
      });

      this.peer.on('connection', (conn) => this.handleIncomingConnection(conn));
      this.peer.on('call', (call) => this.handleIncomingCall(call));

      this.peer.on('error', (err) => {
        clearTimeout(timeout);
        console.error('[PeerCall] createRoom error:', err.type, err.message);
        this.emit({ type: 'error', message: err.message });
        reject(new Error(err.message));
      });

      this.peer.on('disconnected', () => {
        console.warn('[PeerCall] createRoom: disconnected from signaling server');
      });
    });
  }

  async joinRoom(code: string): Promise<void> {
    this.roomId = code.trim().toLowerCase();
    this.isHost = false;
    const hostId = `pcall-${this.roomId}`;

    console.log(`[PeerCall] joinRoom: hostId=${hostId}`);

    return new Promise((resolve, reject) => {
      const opts = buildPeerOptions();
      // No ID provided = PeerJS generates one
      this.peer = new Peer(opts);

      const timeout = setTimeout(() => {
        console.error('[PeerCall] joinRoom timeout after', TIMEOUT_MS, 'ms');
        this.peer?.destroy();
        this.peer = null;
        reject(new Error('Timed out joining room. The room may not exist.'));
      }, TIMEOUT_MS);

      this.peer.on('open', (myId) => {
        clearTimeout(timeout);
        console.log(`[PeerCall] joinRoom open, myId=${myId}, connecting to host=${hostId}`);

        const conn = this.peer!.connect(hostId, { reliable: true });

        const connTimeout = setTimeout(() => {
          console.error('[PeerCall] joinRoom: data connection to host timed out');
          conn.close();
          reject(new Error('Could not connect to room. The room may not exist.'));
        }, TIMEOUT_MS);

        conn.on('open', () => {
          clearTimeout(connTimeout);
          console.log('[PeerCall] joinRoom: data connection open to host');
          this.setupDataConnection(conn, hostId);
          conn.send({ type: 'join', payload: { name: this.userName, id: myId } } satisfies PeerMessage);
          resolve();
        });

        conn.on('error', (err) => {
          clearTimeout(connTimeout);
          console.error('[PeerCall] joinRoom: data connection error:', err.message);
          this.emit({ type: 'error', message: `Connection error: ${err.message}` });
          reject(new Error(err.message));
        });

        conn.on('close', () => {
          clearTimeout(connTimeout);
        });
      });

      this.peer.on('call', (call) => this.handleIncomingCall(call));

      this.peer.on('error', (err) => {
        clearTimeout(timeout);
        console.error('[PeerCall] joinRoom error:', err.type, err.message);
        this.emit({ type: 'error', message: err.message });
        reject(new Error(err.message));
      });

      this.peer.on('disconnected', () => {
        console.warn('[PeerCall] joinRoom: disconnected from signaling server');
      });
    });
  }

  // ─── Media ───

  async startMedia(video = true, audio = true): Promise<MediaStream> {
    this.localStream = await navigator.mediaDevices.getUserMedia({
      video: video ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      audio: audio ? { echoCancellation: true, noiseSuppression: true } : false,
    });

    for (const [peerId, remotePeer] of this.peers) {
      this.callPeer(peerId, remotePeer.conn);
    }

    return this.localStream;
  }

  async startScreenShare(): Promise<MediaStream | null> {
    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      this.broadcastData({ type: 'screen-start', payload: { id: this.myId } });

      for (const remotePeer of this.peers.values()) {
        if (remotePeer.call) {
          const screenTrack = this.screenStream.getVideoTracks()[0];
          if (screenTrack) {
            const sender = remotePeer.call.peerConnection.getSenders().find(s => s.track?.kind === 'video');
            if (sender) sender.replaceTrack(screenTrack);
          }
        }
      }

      this.screenStream.getVideoTracks()[0].onended = () => {
        this.stopScreenShare();
      };

      return this.screenStream;
    } catch {
      return null;
    }
  }

  stopScreenShare() {
    if (!this.screenStream) return;

    this.broadcastData({ type: 'screen-stop', payload: { id: this.myId } });

    const cameraTrack = this.localStream?.getVideoTracks()[0];
    for (const remotePeer of this.peers.values()) {
      if (remotePeer.call && cameraTrack) {
        const sender = remotePeer.call.peerConnection.getSenders().find(s => s.track?.kind === 'video');
        if (sender) sender.replaceTrack(cameraTrack);
      }
    }

    this.screenStream.getTracks().forEach(t => t.stop());
    this.screenStream = null;
  }

  toggleAudio(enabled: boolean) {
    if (!this.localStream) return;
    this.localStream.getAudioTracks().forEach(t => { t.enabled = enabled; });
    this.broadcastData({ type: 'audio-toggle', payload: { id: this.myId, enabled } });
  }

  toggleVideo(enabled: boolean) {
    if (!this.localStream) return;
    this.localStream.getVideoTracks().forEach(t => { t.enabled = enabled; });
    this.broadcastData({ type: 'video-toggle', payload: { id: this.myId, enabled } });
  }

  // ─── Chat ───

  sendChat(text: string) {
    this.broadcastData({ type: 'chat', payload: { name: this.userName, text } });
  }

  // ─── Disconnect ───

  leave() {
    for (const remotePeer of this.peers.values()) {
      remotePeer.conn.close();
      remotePeer.call?.close();
    }
    this.localStream?.getTracks().forEach(t => t.stop());
    this.screenStream?.getTracks().forEach(t => t.stop());
    this.peer?.destroy();
    this.peers.clear();
  }

  // ─── Internal ───

  private handleIncomingConnection(conn: DataConnection) {
    const peerId = conn.peer;
    console.log('[PeerCall] Incoming connection from:', peerId);

    conn.on('open', () => {
      console.log('[PeerCall] Incoming data connection open from:', peerId);
      this.setupDataConnection(conn, peerId);

      if (this.isHost) {
        const existingPeers = [...this.peers.values()]
          .filter(p => p.id !== peerId) // Don't include the newcomer in their own list
          .map(p => ({ id: p.id, name: p.name }));
        conn.send({ type: 'peer-list', payload: existingPeers } satisfies PeerMessage);
        this.broadcastData({ type: 'join', payload: { id: peerId, name: '...' } });
      }

      if (this.localStream) {
        this.callPeer(peerId, conn);
      }
    });
  }

  private setupDataConnection(conn: DataConnection, peerId: string) {
    // Don't overwrite existing connection unless this is a new one
    const existing = this.peers.get(peerId);
    if (existing && existing.conn === conn) return;

    const remotePeer: RemotePeer = {
      id: peerId,
      name: existing?.name ?? '...',
      conn,
      audioEnabled: true,
      videoEnabled: true,
    };
    this.peers.set(peerId, remotePeer);

    conn.on('data', (raw) => {
      const msg = raw as PeerMessage;
      this.handleMessage(peerId, msg);
    });

    conn.on('close', () => {
      this.peers.delete(peerId);
      this.emit({ type: 'peer-left', peerId });
    });

    conn.on('error', () => {
      this.peers.delete(peerId);
      this.emit({ type: 'peer-left', peerId });
    });
  }

  private handleMessage(fromId: string, msg: PeerMessage) {
    switch (msg.type) {
      case 'join': {
        const { name, id } = msg.payload as { name: string; id: string };
        const peer = this.peers.get(fromId);
        if (peer) peer.name = name;
        this.emit({ type: 'peer-joined', peer: peer ?? { id: fromId, name: name, conn: this.peers.get(fromId)?.conn!, audioEnabled: true, videoEnabled: true } });

        // Non-host peers connect to each other directly
        if (!this.isHost && id && id !== this.myId && !this.peers.has(id)) {
          this.connectToPeer(id);
        }
        break;
      }

      case 'peer-list': {
        const peers = msg.payload as { id: string; name: string }[];
        for (const p of peers) {
          if (p.id !== this.myId) {
            this.connectToPeer(p.id);
          }
        }
        break;
      }

      case 'chat': {
        const { name, text } = msg.payload as { name: string; text: string };
        const peer = this.peers.get(fromId);
        if (peer) peer.name = name;
        this.emit({ type: 'chat', peerId: fromId, text });
        break;
      }

      case 'audio-toggle': {
        const { enabled } = msg.payload as { enabled: boolean };
        const peer = this.peers.get(fromId);
        if (peer) peer.audioEnabled = enabled;
        this.emit({ type: 'audio-toggle', peerId: fromId, enabled });
        break;
      }

      case 'video-toggle': {
        const { enabled } = msg.payload as { enabled: boolean };
        const peer = this.peers.get(fromId);
        if (peer) peer.videoEnabled = enabled;
        this.emit({ type: 'video-toggle', peerId: fromId, enabled });
        break;
      }

      case 'screen-start':
        break;

      case 'screen-stop':
        this.emit({ type: 'screen-stop', peerId: fromId });
        break;

      case 'rename': {
        const { name } = msg.payload as { name: string };
        const peer = this.peers.get(fromId);
        if (peer) peer.name = name;
        break;
      }
    }
  }

  private connectToPeer(peerId: string) {
    if (!this.peer || peerId === this.myId) return;
    if (this.peers.has(peerId)) return;

    console.log('[PeerCall] Connecting to peer:', peerId);
    const conn = this.peer.connect(peerId, { reliable: true });
    conn.on('open', () => {
      conn.send({ type: 'join', payload: { name: this.userName, id: this.myId } } satisfies PeerMessage);
      this.setupDataConnection(conn, peerId);
      if (this.localStream) {
        this.callPeer(peerId, conn);
      }
    });
  }

  private callPeer(peerId: string, _conn: DataConnection) {
    if (!this.localStream || !this.peer) return;

    const call = this.peer.call(peerId, this.localStream);
    if (!call) return;

    const remotePeer = this.peers.get(peerId);
    if (remotePeer) remotePeer.call = call;

    call.on('stream', (stream) => {
      this.emit({ type: 'stream', peerId, stream });
    });

    call.on('close', () => {
      this.emit({ type: 'stream-removed', peerId });
    });
  }

  private handleIncomingCall(call: MediaConnection) {
    console.log('[PeerCall] Incoming call from:', call.peer);

    if (this.localStream) {
      call.answer(this.localStream);
    } else {
      call.answer();
    }

    const remotePeer = this.peers.get(call.peer);
    if (remotePeer) remotePeer.call = call;

    call.on('stream', (stream) => {
      this.emit({ type: 'stream', peerId: call.peer, stream });
    });

    call.on('close', () => {
      this.emit({ type: 'stream-removed', peerId: call.peer });
    });
  }

  private broadcastData(msg: PeerMessage) {
    for (const remotePeer of this.peers.values()) {
      if (remotePeer.conn.open) {
        remotePeer.conn.send(msg);
      }
    }
  }

  private generateCode(): string {
    const chars = 'abcdefghijkmnpqrstuvwxyz2345679';
    let code = '';
    for (let i = 0; i < 9; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  private generateName(): string {
    const adjectives = ['quick', 'brave', 'calm', 'keen', 'warm', 'bold', 'cool', 'fast', 'kind', 'wise'];
    const animals = ['fox', 'owl', 'cat', 'dog', 'bee', 'elk', 'ram', 'fin', 'jay', 'yak'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const animal = animals[Math.floor(Math.random() * animals.length)];
    return `${adj}-${animal}`;
  }
}