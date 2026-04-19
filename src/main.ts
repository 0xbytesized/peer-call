import { PeerCallManager } from './peer.js';
import { Mic, MicOff, Video, VideoOff, Monitor, MessageSquare, PhoneOff, X, Copy, Send, Check } from 'lucide';
import './style.css';
import './style.css';

// ─── DOM refs ───

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const lobby = $<HTMLDivElement>('lobby');
const callView = $<HTMLDivElement>('call');
const connecting = $<HTMLDivElement>('connecting');
const connectingDetail = $<HTMLParagraphElement>('connecting-detail');
const videoGrid = $<HTMLDivElement>('video-grid');
const chatPanel = $<HTMLDivElement>('chat-panel');
const chatMessages = $<HTMLDivElement>('chat-messages');
const chatInput = $<HTMLInputElement>('input-chat');
const roomCode = $<HTMLSpanElement>('room-code');
const btnCreate = $<HTMLButtonElement>('btn-create');
const btnMic = $<HTMLButtonElement>('btn-mic');
const btnCamera = $<HTMLButtonElement>('btn-camera');
const btnScreen = $<HTMLButtonElement>('btn-screen');
const btnChat = $<HTMLButtonElement>('btn-chat');
const btnLeave = $<HTMLButtonElement>('btn-leave');
const btnCloseChat = $<HTMLButtonElement>('btn-close-chat');
const btnCopy = $<HTMLButtonElement>('btn-copy');
const formJoin = $<HTMLFormElement>('form-join');
const inputCode = $<HTMLInputElement>('input-code');
const formChat = $<HTMLFormElement>('form-chat');

// ─── Icon rendering (no createIcons, direct SVG) ───

const iconMap = {
  mic: Mic,
  'mic-off': MicOff,
  video: Video,
  'video-off': VideoOff,
  monitor: Monitor,
  'message-square': MessageSquare,
  'phone-off': PhoneOff,
  x: X,
  copy: Copy,
  send: Send,
  check: Check,
  'video-start': Video,
} as const;

function renderIcon(name: keyof typeof iconMap, size = 24): string {
  const icon = iconMap[name];
  const [tag, attrs] = icon;
  const svgAttrs = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${svgAttrs}>${icon.slice(2).map((el: any) => typeof el === 'string' ? el : '').join('')}</svg>`;
}

// Replace all data-lucide icons with actual SVGs
function initIcons() {
  document.querySelectorAll('[data-lucide]').forEach(el => {
    const name = el.getAttribute('data-lucide') as keyof typeof iconMap;
    if (name && iconMap[name]) {
      el.outerHTML = renderIcon(name);
    }
  });
}

function replaceIcon(btn: HTMLButtonElement, name: keyof typeof iconMap) {
  // Remove existing SVGs
  btn.querySelectorAll('svg').forEach(s => s.remove());
  btn.insertAdjacentHTML('beforeend', renderIcon(name));
}

// ─── State ───

let manager: PeerCallManager;
let localStream: MediaStream | null = null;
let micOn = true;
let cameraOn = true;
let screenSharing = false;
let chatOpen = false;
let mediaReady = false;

const videoTiles = new Map<string, { container: HTMLDivElement; video: HTMLVideoElement; nameTag: HTMLSpanElement; mutedInd: HTMLDivElement }>();

// ─── Init ───

function init() {
  initIcons();

  const hash = window.location.hash.slice(1).trim();
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room') || hash;

  if (room && room.length >= 4) {
    inputCode.value = room;
    joinRoom(room);
    return;
  }

  btnCreate.addEventListener('click', createRoom);
  formJoin.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = inputCode.value.trim().toLowerCase();
    if (code) joinRoom(code);
  });
}

// ─── Create room ───

async function createRoom() {
  showView('connecting');
  connectingDetail.textContent = 'Creating room...';

  manager = new PeerCallManager();
  setupManagerEvents(manager);

  try {
    const code = await manager.createRoom();
    window.history.replaceState(null, '', `#${code}`);
    showCallView(code);
    await requestMedia();
  } catch (err: unknown) {
    showView('lobby');
    const message = err instanceof Error ? err.message : 'Unknown error';
    alert('Could not create room: ' + message);
    console.error('[PeerCall] createRoom failed:', err);
  }
}

// ─── Join room ───

async function joinRoom(code: string) {
  showView('connecting');
  connectingDetail.textContent = `Joining room ${code}...`;

  manager = new PeerCallManager();
  setupManagerEvents(manager);

  try {
    await manager.joinRoom(code);
    window.history.replaceState(null, '', `#${code}`);
    showCallView(code);
    await requestMedia();
  } catch (err: unknown) {
    showView('lobby');
    const message = err instanceof Error ? err.message : 'Unknown error';
    alert('Could not join room: ' + message);
    console.error('[PeerCall] joinRoom failed:', err);
  }
}

// ─── Media request ───

async function requestMedia() {
  try {
    localStream = await manager.startMedia(true, true);
    addLocalVideo(localStream);
    mediaReady = true;
    updateMicCameraButtons();
  } catch {
    try {
      localStream = await manager.startMedia(false, true);
      addLocalVideo(localStream);
      cameraOn = false;
      mediaReady = true;
      updateMicCameraButtons();
      btnCamera.classList.add('off');
    } catch {
      addNoMediaTile();
      micOn = false;
      cameraOn = false;
      updateMicCameraButtons();
      btnMic.classList.add('off');
      btnCamera.classList.add('off');
    }
  }
}

function addNoMediaTile() {
  const tile = createVideoTile('local', manager.myName, true);
  const placeholder = document.createElement('div');
  placeholder.className = 'no-camera-placeholder';
  placeholder.textContent = '📷';
  placeholder.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:3rem;background:#1a1a2e;z-index:1;';
  tile.container.style.position = 'relative';
  tile.container.insertBefore(placeholder, tile.video);
  videoGrid.appendChild(tile.container);
  updateGridCount();
}

// ─── Manager events ───

function setupManagerEvents(mgr: PeerCallManager) {
  mgr.on((event) => {
    switch (event.type) {
      case 'peer-joined':
        updatePeerName(event.peer.id, event.peer.name);
        break;
      case 'peer-left':
        removeVideoTile(event.peerId);
        break;
      case 'stream':
        addRemoteVideo(event.peerId, event.stream);
        break;
      case 'stream-removed':
        removeVideoTile(event.peerId);
        break;
      case 'chat':
        addChatMessage(event.peerId, event.text, false);
        break;
      case 'audio-toggle':
        updateMuteIndicator(event.peerId, !event.enabled);
        break;
      case 'video-toggle':
      case 'screen-stop':
      case 'error':
        break;
    }
  });
}

// ─── UI Helpers ───

function showView(name: 'lobby' | 'call' | 'connecting') {
  lobby.classList.toggle('hidden', name !== 'lobby');
  callView.classList.toggle('hidden', name !== 'call');
  connecting.classList.toggle('hidden', name !== 'connecting');
}

function showCallView(code: string) {
  roomCode.textContent = code;
  showView('call');
  setupCallControls();
}

function updateMicCameraButtons() {
  replaceIcon(btnMic, micOn ? 'mic' : 'mic-off');
  replaceIcon(btnCamera, cameraOn ? 'video' : 'video-off');
}

function setupCallControls() {
  btnMic.addEventListener('click', async () => {
    if (!mediaReady && !micOn) {
      try {
        localStream = await manager.startMedia(cameraOn, true);
        addLocalVideo(localStream);
        mediaReady = true;
        micOn = true;
      } catch { return; }
    } else {
      micOn = !micOn;
    }
    manager.toggleAudio(micOn);
    btnMic.classList.toggle('off', !micOn);
    replaceIcon(btnMic, micOn ? 'mic' : 'mic-off');
  });

  btnCamera.addEventListener('click', async () => {
    if (!mediaReady && !cameraOn) {
      try {
        localStream = await manager.startMedia(true, micOn);
        addLocalVideo(localStream);
        mediaReady = true;
        cameraOn = true;
      } catch { return; }
    } else {
      cameraOn = !cameraOn;
      manager.toggleVideo(cameraOn);
    }
    btnCamera.classList.toggle('off', !cameraOn);
    replaceIcon(btnCamera, cameraOn ? 'video' : 'video-off');
  });

  btnScreen.addEventListener('click', async () => {
    if (!screenSharing) {
      const stream = await manager.startScreenShare();
      if (stream) { screenSharing = true; btnScreen.classList.add('active'); }
    } else {
      manager.stopScreenShare();
      screenSharing = false;
      btnScreen.classList.remove('active');
    }
  });

  btnChat.addEventListener('click', () => {
    chatOpen = !chatOpen;
    chatPanel.classList.toggle('hidden', !chatOpen);
    if (chatOpen) chatInput.focus();
  });

  btnCloseChat.addEventListener('click', () => {
    chatOpen = false;
    chatPanel.classList.add('hidden');
  });

  btnLeave.addEventListener('click', () => {
    manager.leave();
    window.location.hash = '';
    window.location.reload();
  });

  btnCopy.addEventListener('click', () => {
    const url = `${window.location.origin}${window.location.pathname}#${manager.roomCode}`;
    navigator.clipboard.writeText(url).then(() => {
      replaceIcon(btnCopy, 'check');
      setTimeout(() => replaceIcon(btnCopy, 'copy'), 2000);
    });
  });

  formChat.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    manager.sendChat(text);
    addChatMessage('self', text, true);
    chatInput.value = '';
  });
}

// ─── Video Tiles ───

function addLocalVideo(stream: MediaStream) {
  removeVideoTile('local');
  const tile = createVideoTile('local', manager.myName, true);
  tile.video.srcObject = stream;
  tile.video.autoplay = true;
  tile.video.muted = true;
  tile.video.playsInline = true;
  tile.video.classList.add('mirror');
  videoGrid.appendChild(tile.container);
  updateGridCount();
}

function addRemoteVideo(peerId: string, stream: MediaStream) {
  removeVideoTile(peerId);
  const peer = manager.peerList.find(p => p.id === peerId);
  const name = peer?.name || '...';
  const tile = createVideoTile(peerId, name, false);
  tile.video.srcObject = stream;
  tile.video.autoplay = true;
  tile.video.playsInline = true;
  videoGrid.appendChild(tile.container);
  updateGridCount();
}

function createVideoTile(id: string, name: string, isLocal: boolean) {
  const container = document.createElement('div');
  container.className = 'video-tile';
  container.dataset.peerId = id;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  if (isLocal) video.muted = true;

  const nameTag = document.createElement('span');
  nameTag.className = 'name-tag';
  nameTag.textContent = isLocal ? `${name} (you)` : name;

  const mutedInd = document.createElement('div');
  mutedInd.className = 'muted-indicator hidden';
  mutedInd.textContent = '🔇';

  container.appendChild(video);
  container.appendChild(nameTag);
  container.appendChild(mutedInd);

  const tile = { container, video, nameTag, mutedInd };
  videoTiles.set(id, tile);
  return tile;
}

function removeVideoTile(peerId: string) {
  const tile = videoTiles.get(peerId);
  if (tile) { tile.container.remove(); videoTiles.delete(peerId); updateGridCount(); }
}

function updatePeerName(peerId: string, name: string) {
  const tile = videoTiles.get(peerId);
  if (tile) tile.nameTag.textContent = name;
}

function updateMuteIndicator(peerId: string, muted: boolean) {
  const tile = videoTiles.get(peerId);
  if (tile) tile.mutedInd.classList.toggle('hidden', !muted);
}

function updateGridCount() {
  videoGrid.dataset.count = String(videoTiles.size);
}

// ─── Chat ───

function addChatMessage(from: string, text: string, isSelf: boolean) {
  const msg = document.createElement('div');
  msg.className = `chat-msg ${isSelf ? 'self' : ''}`;

  if (!isSelf) {
    const peer = manager.peerList.find(p => p.id === from);
    const nameDiv = document.createElement('div');
    nameDiv.className = 'chat-msg-name';
    nameDiv.textContent = peer?.name || from.slice(0, 8);
    msg.appendChild(nameDiv);
  }

  const textDiv = document.createElement('div');
  textDiv.className = 'chat-msg-text';
  textDiv.textContent = text;
  msg.appendChild(textDiv);

  chatMessages.appendChild(msg);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ─── URL hash change ───

window.addEventListener('hashchange', () => {
  const code = window.location.hash.slice(1).trim();
  if (code && code.length >= 4) joinRoom(code);
});

// ─── Start ───

init();