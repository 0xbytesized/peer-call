import { PeerCallManager } from './peer.js';
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

// ─── State ───

let manager: PeerCallManager;
let localStream: MediaStream | null = null;
let micOn = true;
let cameraOn = true;
let screenSharing = false;
let chatOpen = false;

// Video tile map: peerId -> HTMLVideoElement
const videoTiles = new Map<string, { container: HTMLDivElement; video: HTMLVideoElement; nameTag: HTMLSpanElement; mutedInd: HTMLDivElement }>();

// ─── Init ───

function init() {
  // Check URL for room code
  const hash = window.location.hash.slice(1).trim();
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room') || hash;

  if (room && room.length >= 4) {
    inputCode.value = room;
    joinRoom(room);
    return;
  }

  // Setup lobby events
  btnCreate.addEventListener('click', createRoom);
  formJoin.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = inputCode.value.trim().toLowerCase();
    if (code) joinRoom(code);
  });

  // Focus input
  inputCode.focus();
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
    localStream = await manager.startMedia(true, true);
    addLocalVideo(localStream);
  } catch (err: unknown) {
    showView('lobby');
    const message = err instanceof Error ? err.message : 'Unknown error'; alert('Could not create room: ' + message);
    console.error(err);
  }
}

// ─── Join room ───

async function joinRoom(code: string) {
  showView('connecting');
  connectingDetail.textContent = `Join room ${code}...`;

  manager = new PeerCallManager();
  setupManagerEvents(manager);

  try {
    await manager.joinRoom(code);
    window.history.replaceState(null, '', `#${code}`);
    showCallView(code);
    localStream = await manager.startMedia(true, true);
    addLocalVideo(localStream);
  } catch (err: unknown) {
    showView('lobby');
    alert('Could not join room. Check the code and try again.');
    console.error(err);
  }
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
        // Could add video-off indicator here
        break;
      case 'screen-stop':
        // Could handle screen share stop indicator
        break;
      case 'error':
        console.error('PeerCall error:', event.message);
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

function setupCallControls() {
  btnMic.addEventListener('click', () => {
    micOn = !micOn;
    manager.toggleAudio(micOn);
    btnMic.classList.toggle('off', !micOn);
    toggleIcon(btnMic, 'icon-mic-on', 'icon-mic-off', !micOn);
  });

  btnCamera.addEventListener('click', () => {
    cameraOn = !cameraOn;
    manager.toggleVideo(cameraOn);
    btnCamera.classList.toggle('off', !cameraOn);
    toggleIcon(btnCamera, 'icon-cam-on', 'icon-cam-off', !cameraOn);
  });

  btnScreen.addEventListener('click', async () => {
    if (!screenSharing) {
      const stream = await manager.startScreenShare();
      if (stream) {
        screenSharing = true;
        btnScreen.classList.add('active');
      }
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
      btnCopy.textContent = '✅';
      setTimeout(() => { btnCopy.textContent = '📋'; }, 2000);
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

function toggleIcon(btn: HTMLButtonElement, onClass: string, offClass: string, isOff: boolean) {
  const onIcon = btn.querySelector(`.${onClass}`);
  const offIcon = btn.querySelector(`.${offClass}`);
  if (onIcon) onIcon.classList.toggle('hidden', isOff);
  if (offIcon) offIcon.classList.toggle('hidden', !isOff);
}

// ─── Video Tiles ───

function addLocalVideo(stream: MediaStream) {
  const tile = createVideoTile('local', manager.myName, true);
  tile.video.srcObject = stream;
  tile.video.autoplay = true;
  tile.video.muted = true;
  tile.video.classList.add('mirror');
  videoGrid.appendChild(tile.container);
  updateGridCount();
}

function addRemoteVideo(peerId: string, stream: MediaStream) {
  // Remove existing tile for this peer if any
  removeVideoTile(peerId);

  const peer = manager.peerList.find(p => p.id === peerId);
  const name = peer?.name || '...';
  const tile = createVideoTile(peerId, name, false);
  tile.video.srcObject = stream;
  tile.video.autoplay = true;
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
  if (tile) {
    tile.container.remove();
    videoTiles.delete(peerId);
    updateGridCount();
  }
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
  const count = videoTiles.size;
  videoGrid.dataset.count = String(count);
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
  if (code && code.length >= 4) {
    joinRoom(code);
  }
});

// ─── Start ───

init();