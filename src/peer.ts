import Peer, { DataConnection, MediaConnection, PeerOptions } from 'peerjs';

// ─── ICE Servers (STUN + TURN) ───
// STUN discovers public IPs; TURN relays traffic when P2P fails (CGNAT, symmetric NAT).
// Free TURN from Metered (https://www.metered.ca/tools/openrelay/) ensures calls work
// behind Movistar/CGNAT routers. Without TURN, ~30% of connections fail silently.

const ICE_SERVERS: RTCConfiguration['iceServers'] = [
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

    return new Promise((resolve, reject) => {
      this.peer = new Peer(peerId, this.getPeerConfig());

      this.peer.on('open', () => {
        resolve(this.roomId);
      });

      this.peer.on('connection', (conn) => this.handleIncomingConnection(conn));
      this.peer.on('call', (call) => this.handleIncomingCall(call));
      this.peer.on('error', (err) => {
        this.emit({ type: 'error', message: err.message });
        reject(err);
      });
    });
  }

  async joinRoom(code: string): Promise<void> {
    this.roomId = code;
    this.isHost = false;
    const hostId = `pcall-${code}`;

    return new Promise((resolve, reject) => {
      this.peer = new Peer('', this.getPeerConfig());

      this.peer.on('open', () => {
        const conn = this.peer!.connect(hostId, { reliable: true });

        conn.on('open', () => {
          conn.send({ type: 'join', payload: { name: this.userName, id: this.peer!.id } } satisfies PeerMessage);
          this.setupDataConnection(conn, this.peer!.id);
          resolve();
        });

        conn.on('error', (err) => {
          this.emit({ type: 'error', message: `Connection error: ${err.message}` });
          reject(err);
        });
      });

      this.peer.on('call', (call) => this.handleIncomingCall(call));
      this.peer.on('error', (err) => {
        this.emit({ type: 'error', message: err.message });
        reject(err);
      });
    });
  }

  // ─── Media ───

  async startMedia(video = true, audio = true): Promise<MediaStream> {
    this.localStream = await navigator.mediaDevices.getUserMedia({
      video: video ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      audio: audio ? { echoCancellation: true, noiseSuppression: true } : false,
    });

    // Call all existing peers with our stream
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

      // Notify peers we're sharing screen
      this.broadcastData({ type: 'screen-start', payload: { id: this.myId } });

      // Add screen track to existing calls
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

    // Replace with camera track
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

    conn.on('open', () => {
      this.setupDataConnection(conn, peerId);

      // If we're host, tell the newcomer about all existing peers
      if (this.isHost) {
        const existingPeers = [...this.peers.values()].map(p => ({ id: p.id, name: p.name }));
        conn.send({ type: 'peer-list', payload: existingPeers } satisfies PeerMessage);

        // Also tell all existing peers about the newcomer
        this.broadcastData({ type: 'join', payload: { id: peerId } });
      }

      // Call the new peer if we have media
      if (this.localStream) {
        this.callPeer(peerId, conn);
      }
    });
  }

  private setupDataConnection(conn: DataConnection, peerId: string) {
    const remotePeer: RemotePeer = {
      id: peerId,
      name: '...',
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
        if (peer) {
          peer.name = name;
        } else if (id) {
          // A joiner got a peer-list and is connecting to us
          // They sent their info, store it
          const newPeer = this.peers.get(fromId);
          if (newPeer) newPeer.name = name;
        }
        this.emit({ type: 'peer-joined', peer: this.peers.get(fromId)! });

        // Connect to this peer's data channel if we're not the host
        // and haven't connected yet
        if (!this.isHost && fromId !== this.myId) {
          const existingPeer = this.peers.get(fromId);
          if (!existingPeer?.conn) {
            this.connectToPeer(fromId);
          }
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

      case 'screen-start': {
        // Peer started screen sharing — we'll see it via the stream
        break;
      }

      case 'screen-stop': {
        this.emit({ type: 'screen-stop', peerId: fromId });
        break;
      }

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

    const conn = this.peer.connect(peerId, { reliable: true });
    conn.on('open', () => {
      conn.send({ type: 'join', payload: { name: this.userName, id: this.myId } } satisfies PeerMessage);
      this.setupDataConnection(conn, peerId);
      if (this.localStream) {
        this.callPeer(peerId, conn);
      }
    });
  }

  private callPeer(peerId: string, conn: DataConnection) {
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
    // Answer with our local stream
    if (this.localStream) {
      call.answer(this.localStream);
    } else {
      // Answer with empty stream if we haven't started media yet
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

  private getPeerConfig(): PeerOptions {
    return {
      config: {
        iceServers: ICE_SERVERS,
      },
    };
  }

  private generateCode(): string {
    const chars = 'abcdefghijkmnpqrstuvwxyz2345679'; // no confused chars
    let code = '';
    for (let i = 0; i < 9; i++) { // 9 chars = ~42 bits, hard to guess
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