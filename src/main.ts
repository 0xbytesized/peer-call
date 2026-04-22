import { PeerCallManager, getPeerConnection } from './peer.js'
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  Monitor,
  MessageSquare,
  PhoneOff,
  X,
  Copy,
  Send,
  Check,
  Settings,
  Volume2,
  VolumeX,
  ChevronUp,
} from 'lucide'
import { enableNoiseSuppression, disableNoiseSuppression, updateNoiseSuppressionSource } from './noise-suppression.js'
import {
  startCameraPipeline,
  loadFilters,
  saveFilters,
  filtersToCss,
  detectPipelineSupport,
  DEFAULT_FILTERS,
  type CameraFilters,
  type CameraPipeline,
} from './camera-filters.js'
import './style.css'

// ─── Icon rendering (Lucide, tree-shaken) ───

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const iconMap: Record<string, any> = {
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
  settings: Settings,
  'volume-2': Volume2,
  'volume-x': VolumeX,
  'chevron-up': ChevronUp,
}

function renderIcon(name: string, size = 24): string {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const children: any = iconMap[name]
  if (!children) return ''
  const svgContent = children
    .map((child: any) => {
      const tag = child[0]
      const attrs = child[1]
      const attrsStr = Object.entries(attrs)
        .map(([k, v]: [string, any]) => `${k}="${v}"`)
        .join(' ')
      return `<${tag} ${attrsStr}/>`
    })
    .join('')
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${svgContent}</svg>`
}

function initIcons() {
  document.querySelectorAll('[data-lucide]').forEach((el) => {
    const name = el.getAttribute('data-lucide') || ''
    if (name && iconMap[name]) {
      el.outerHTML = renderIcon(name)
    }
  })
}

function replaceIcon(btn: HTMLButtonElement, name: string) {
  btn.querySelectorAll('svg').forEach((s) => s.remove())
  btn.insertAdjacentHTML('beforeend', renderIcon(name))
}

// ─── DOM refs ───

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const lobby = $<HTMLDivElement>('lobby')
const callView = $<HTMLDivElement>('call')
const connecting = $<HTMLDivElement>('connecting')
const connectingDetail = $<HTMLParagraphElement>('connecting-detail')
const videoGrid = $<HTMLDivElement>('video-grid')
const chatPanel = $<HTMLDivElement>('chat-panel')
const chatMessages = $<HTMLDivElement>('chat-messages')
const chatInput = $<HTMLInputElement>('input-chat')
const roomCode = $<HTMLSpanElement>('room-code')
const btnCreate = $<HTMLButtonElement>('btn-create')
const btnMic = $<HTMLButtonElement>('btn-mic')
const btnCamera = $<HTMLButtonElement>('btn-camera')
const btnScreen = $<HTMLButtonElement>('btn-screen')
const btnNoise = $<HTMLButtonElement>('btn-noise')
const btnChat = $<HTMLButtonElement>('btn-chat')
const btnLeave = $<HTMLButtonElement>('btn-leave')
const btnCloseChat = $<HTMLButtonElement>('btn-close-chat')
const btnCopy = $<HTMLButtonElement>('btn-copy')
const btnSettings = $<HTMLButtonElement>('btn-settings')
const btnCloseSettings = $<HTMLButtonElement>('btn-close-settings')
const settingsPanel = $<HTMLDivElement>('settings-panel')
const btnCameraMenu = $<HTMLButtonElement>('btn-camera-menu')
const btnCloseCamera = $<HTMLButtonElement>('btn-close-camera')
const cameraPanel = $<HTMLDivElement>('camera-panel')
const btnResetFilters = $<HTMLButtonElement>('btn-reset-filters')
const filterBrightness = $<HTMLInputElement>('filter-brightness')
const filterContrast = $<HTMLInputElement>('filter-contrast')
const filterSaturation = $<HTMLInputElement>('filter-saturation')
const filterBlur = $<HTMLInputElement>('filter-blur')
const valBrightness = $<HTMLSpanElement>('val-brightness')
const valContrast = $<HTMLSpanElement>('val-contrast')
const valSaturation = $<HTMLSpanElement>('val-saturation')
const valBlur = $<HTMLSpanElement>('val-blur')
const selectAudioInput = $<HTMLSelectElement>('select-audio-input')
const selectAudioOutput = $<HTMLSelectElement>('select-audio-output')
const selectVideoInput = $<HTMLSelectElement>('select-video-input')
const formJoin = $<HTMLFormElement>('form-join')
const inputCode = $<HTMLInputElement>('input-code')
const inputName = $<HTMLInputElement>('input-name')
const inputDisplayName = $<HTMLInputElement>('input-display-name')
const formChat = $<HTMLFormElement>('form-chat')

// ─── State ───

let manager: PeerCallManager
let localStream: MediaStream | null = null
let micOn = true
let cameraOn = true
let screenSharing = false
let noiseSuppression = false
let chatOpen = false
let mediaReady = false
let cameraPipeline: CameraPipeline | null = null
let cameraFilters: CameraFilters = loadFilters()
// WebGL is available in virtually every browser, including iPad Safari,
// so the pipeline works everywhere. `pipelineSupported` only flips false
// in the rare case WebGL context creation fails; in that case we fall
// back to CSS filters on the local <video> (local-only, not retransmitted).
const pipelineSupported = detectPipelineSupport()

const videoTiles = new Map<
  string,
  { container: HTMLDivElement; video: HTMLVideoElement; nameTag: HTMLSpanElement; mutedInd: HTMLDivElement }
>()

// ─── Feature detection ───

const sinkSupported = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype

// ─── Init ───

function init() {
  initIcons()

  // Restore saved name from localStorage
  const savedName = localStorage.getItem('peercall-name')
  if (savedName) inputName.value = savedName

  const hash = window.location.hash.slice(1).trim()
  const params = new URLSearchParams(window.location.search)
  const room = params.get('room') || hash

  if (room && room.length >= 4) {
    inputCode.value = room
    joinRoom(room, getUserName())
    return
  }

  btnCreate.addEventListener('click', () => createRoom(getUserName()))
  formJoin.addEventListener('submit', (e) => {
    e.preventDefault()
    const code = inputCode.value.trim().toLowerCase()
    if (code) joinRoom(code, getUserName())
  })
}

function getUserName(): string {
  const name = inputName.value.trim()
  if (name) localStorage.setItem('peercall-name', name)
  return name
}

// ─── Create room ───

async function createRoom(name: string) {
  showView('connecting')
  connectingDetail.textContent = 'Creating room...'

  manager = new PeerCallManager(name || undefined)
  setupManagerEvents(manager)

  try {
    const code = await manager.createRoom()
    window.history.replaceState(null, '', `#${code}`)
    showCallView(code)
    await requestMedia()
  } catch (err: unknown) {
    showView('lobby')
    const message = err instanceof Error ? err.message : 'Unknown error'
    alert('Could not create room: ' + message)
    console.error('[PeerCall] createRoom failed:', err)
  }
}

// ─── Join room ───

async function joinRoom(code: string, name?: string) {
  showView('connecting')
  connectingDetail.textContent = `Joining room ${code}...`

  manager = new PeerCallManager(name || undefined)
  setupManagerEvents(manager)

  try {
    await manager.joinRoom(code)
    window.history.replaceState(null, '', `#${code}`)
    showCallView(code)
    await requestMedia()
  } catch (err: unknown) {
    showView('lobby')
    const message = err instanceof Error ? err.message : 'Unknown error'
    alert('Could not join room: ' + message)
    console.error('[PeerCall] joinRoom failed:', err)
  }
}

// ─── Device preferences (persisted in localStorage) ───

const DEVICE_PREFS_KEY = 'peercall-devices'

function getDevicePrefs(): { mic?: string; speaker?: string; camera?: string } {
  try {
    return JSON.parse(localStorage.getItem(DEVICE_PREFS_KEY) || '{}')
  } catch {
    return {}
  }
}

function saveDevicePref(key: 'mic' | 'speaker' | 'camera', deviceId: string) {
  const prefs = getDevicePrefs()
  prefs[key] = deviceId
  localStorage.setItem(DEVICE_PREFS_KEY, JSON.stringify(prefs))
}

// ─── Mic acquisition helpers ───

/**
 * Acquire a microphone track. When RNNoise will handle noise suppression,
 * pass `useBrowserNS=false` so the browser's built-in NS and AGC are off —
 * double-processing degrades quality (AGC pumping, spectrum already altered).
 * Echo cancellation stays on either way; RNNoise doesn't replace AEC.
 */
async function getMicTrack(deviceId: string | undefined, useBrowserNS: boolean): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: useBrowserNS },
      autoGainControl: { ideal: useBrowserNS },
    },
    video: false,
  })
  return stream.getAudioTracks()[0]
}

function currentMicDeviceId(): string | undefined {
  const track = localStream?.getAudioTracks()[0]
  return track?.getSettings().deviceId || getDevicePrefs().mic
}

/**
 * Replace the audio track in localStream and on every outgoing sender,
 * stopping and dropping the previous one.
 */
async function replaceLocalAudioTrack(newTrack: MediaStreamTrack) {
  if (!localStream) return
  const oldTrack = localStream.getAudioTracks()[0]
  if (oldTrack) {
    oldTrack.stop()
    localStream.removeTrack(oldTrack)
  }
  localStream.addTrack(newTrack)
  for (const remotePeer of manager.peerList) {
    const pc = getPeerConnection(remotePeer)
    if (pc) {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'audio')
      if (sender) await sender.replaceTrack(newTrack)
    }
  }
}

/**
 * Replace the video track in localStream and on every outgoing sender.
 * The previous track is removed but NOT stopped — the caller (or the
 * pipeline) owns it. Use for pipeline swaps where we don't want to kill
 * the raw camera that the pipeline is still rendering from.
 */
async function replaceLocalVideoTrack(newTrack: MediaStreamTrack, stopOld: boolean) {
  if (!localStream) return
  const oldTrack = localStream.getVideoTracks()[0]
  if (oldTrack) {
    if (stopOld) oldTrack.stop()
    localStream.removeTrack(oldTrack)
  }
  localStream.addTrack(newTrack)
  for (const remotePeer of manager.peerList) {
    const pc = getPeerConnection(remotePeer)
    if (pc) {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
      if (sender) await sender.replaceTrack(newTrack)
    }
  }
}

/**
 * Wrap the current raw camera track in localStream with a filter pipeline
 * (on browsers that support canvas filter) or just apply filters as CSS on
 * the local preview. Safe to call after `startMedia` populated localStream
 * with a fresh camera track.
 */
async function applyCameraPipeline() {
  if (!localStream) return
  const rawTrack = localStream.getVideoTracks()[0]
  if (!rawTrack) return

  if (pipelineSupported) {
    // If an old pipeline exists (e.g. camera device change), tear it down
    // first. The pipeline owns its input track and will stop it.
    cameraPipeline?.stop()
    cameraPipeline = startCameraPipeline(rawTrack, cameraFilters)
    await replaceLocalVideoTrack(cameraPipeline.output, false)
  } else {
    // Raw track stays in localStream. Filters apply as CSS only locally.
    applyCssFiltersToLocalPreview()
  }
  refreshLocalPreview()
}

function applyCssFiltersToLocalPreview() {
  const localTile = videoTiles.get('local')
  if (localTile) {
    localTile.video.style.filter = filtersToCss(cameraFilters)
  }
}

/**
 * Reassign the local tile's video srcObject to pick up a new track cleanly.
 * MediaStream track changes propagate automatically to HTMLMediaElement, but
 * in practice detached-video → canvas → captureStream setups sometimes need
 * a kick to render the new track.
 */
function refreshLocalPreview() {
  const localTile = videoTiles.get('local')
  if (localTile && localStream) {
    localTile.video.srcObject = localStream
  }
}

/**
 * The deviceId of the camera currently in use. Prefer the pipeline's raw
 * input track (the canvas track has no meaningful deviceId), fall back to
 * whatever is in localStream, then to saved prefs.
 */
function currentCameraDeviceId(): string | undefined {
  const raw = cameraPipeline?.input ?? localStream?.getVideoTracks()[0]
  return raw?.getSettings().deviceId || getDevicePrefs().camera
}

// ─── Media request ───

async function requestMedia() {
  const prefs = getDevicePrefs()
  const deviceIds = { mic: prefs.mic, camera: prefs.camera }
  try {
    localStream = await manager.startMedia(true, true, deviceIds)
    addLocalVideo(localStream)
    mediaReady = true
    updateMicCameraButtons()
    await applyCameraPipeline()
  } catch {
    try {
      localStream = await manager.startMedia(false, true, deviceIds)
      addLocalVideo(localStream)
      cameraOn = false
      mediaReady = true
      updateMicCameraButtons()
      btnCamera.classList.add('off')
    } catch {
      try {
        localStream = await manager.startMedia(true, false, deviceIds)
        addLocalVideo(localStream)
        micOn = false
        mediaReady = true
        updateMicCameraButtons()
        btnMic.classList.add('off')
        await applyCameraPipeline()
      } catch {
        addNoMediaTile()
        micOn = false
        cameraOn = false
        mediaReady = false
        updateMicCameraButtons()
        btnMic.classList.add('off')
        btnCamera.classList.add('off')
      }
    }
  }
}

function addNoMediaTile() {
  const tile = createVideoTile('local', manager.myName, true)
  const placeholder = document.createElement('div')
  placeholder.className = 'no-camera-placeholder'
  placeholder.textContent = '📷'
  placeholder.style.cssText =
    'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:3rem;background:#1a1a2e;z-index:1;'
  tile.container.style.position = 'relative'
  tile.container.insertBefore(placeholder, tile.video)
  videoGrid.appendChild(tile.container)
  updateGridCount()
}

// ─── Manager events ───

function setupManagerEvents(mgr: PeerCallManager) {
  mgr.on((event) => {
    switch (event.type) {
      case 'peer-joined':
        updatePeerName(event.peer.id, event.peer.name)
        break
      case 'peer-left':
        removeVideoTile(event.peerId)
        break
      case 'stream':
        addRemoteVideo(event.peerId, event.stream)
        break
      case 'stream-removed':
        removeVideoTile(event.peerId)
        break
      case 'chat':
        addChatMessage(event.peerId, event.text, false)
        break
      case 'audio-toggle':
        updateMuteIndicator(event.peerId, !event.enabled)
        break
      case 'rename':
        updatePeerName(event.peerId, event.name)
        break
      case 'video-toggle':
      case 'screen-stop':
      case 'error':
        break
    }
  })
}

// ─── UI Helpers ───

function showView(name: 'lobby' | 'call' | 'connecting') {
  lobby.classList.toggle('hidden', name !== 'lobby')
  callView.classList.toggle('hidden', name !== 'call')
  connecting.classList.toggle('hidden', name !== 'connecting')
}

function showCallView(code: string) {
  roomCode.textContent = code
  showView('call')
  setupCallControls()
}

function updateMicCameraButtons() {
  replaceIcon(btnMic, micOn ? 'mic' : 'mic-off')
  replaceIcon(btnCamera, cameraOn ? 'video' : 'video-off')
}

// ─── Rename helper ───

function applyRename(newName: string) {
  if (!newName.trim()) return
  manager.rename(newName.trim())
  localStorage.setItem('peercall-name', newName.trim())
  updateLocalNameTag()
  inputDisplayName.value = manager.myName
}

function updateLocalNameTag() {
  const localTile = videoTiles.get('local')
  if (localTile) {
    localTile.nameTag.textContent = `${manager.myName} (you)`
  }
}

function setupCallControls() {
  btnMic.addEventListener('click', async () => {
    if (!mediaReady && !micOn) {
      try {
        localStream = await manager.startMedia(cameraOn, true)
        addLocalVideo(localStream)
        mediaReady = true
        micOn = true
      } catch (err) {
        console.error('[PeerCall] Could not enable mic:', err)
        return
      }
    } else {
      micOn = !micOn
    }
    manager.toggleAudio(micOn)
    btnMic.classList.toggle('off', !micOn)
    replaceIcon(btnMic, micOn ? 'mic' : 'mic-off')
  })

  btnCamera.addEventListener('click', async () => {
    if (!mediaReady && !cameraOn) {
      try {
        localStream = await manager.startMedia(true, micOn)
        addLocalVideo(localStream)
        mediaReady = true
        cameraOn = true
        await applyCameraPipeline()
      } catch (err) {
        console.error('[PeerCall] Could not enable camera:', err)
        return
      }
    } else {
      cameraOn = !cameraOn
      manager.toggleVideo(cameraOn)
    }
    btnCamera.classList.toggle('off', !cameraOn)
    replaceIcon(btnCamera, cameraOn ? 'video' : 'video-off')
  })

  btnScreen.addEventListener('click', async () => {
    if (!screenSharing) {
      const stream = await manager.startScreenShare()
      if (stream) {
        screenSharing = true
        btnScreen.classList.add('active')
      }
    } else {
      manager.stopScreenShare()
      screenSharing = false
      btnScreen.classList.remove('active')
    }
  })

  // ─── Noise suppression ───

  btnNoise.addEventListener('click', async () => {
    if (!localStream) return
    const deviceId = currentMicDeviceId()

    if (!noiseSuppression) {
      try {
        // Re-acquire the mic with browser NS + AGC off so RNNoise sees
        // untouched audio. Browser NS alters the spectrum and AGC pumps
        // the level — both break RNNoise's trained assumptions.
        const cleanTrack = await getMicTrack(deviceId, false)
        const cleanStream = new MediaStream([cleanTrack])
        const processedStream = await enableNoiseSuppression(cleanStream)
        const processedTrack = processedStream.getAudioTracks()[0]
        if (processedTrack) {
          await replaceLocalAudioTrack(processedTrack)
        }
        noiseSuppression = true
        btnNoise.classList.add('active')
        replaceIcon(btnNoise, 'volume-2')
      } catch (err) {
        console.error('[PeerCall] Failed to enable noise suppression:', err)
        disableNoiseSuppression()?.stop()
        noiseSuppression = false
        btnNoise.classList.remove('active')
        replaceIcon(btnNoise, 'volume-x')
      }
    } else {
      try {
        disableNoiseSuppression()?.stop()
        // Re-acquire with browser NS + AGC back on so the user still gets
        // some noise suppression when RNNoise is off.
        const restoredTrack = await getMicTrack(deviceId, true)
        await replaceLocalAudioTrack(restoredTrack)
      } catch (err) {
        console.error('[PeerCall] Failed to disable noise suppression:', err)
      }
      noiseSuppression = false
      btnNoise.classList.remove('active')
      replaceIcon(btnNoise, 'volume-x')
    }
  })

  btnChat.addEventListener('click', () => {
    chatOpen = !chatOpen
    chatPanel.classList.toggle('hidden', !chatOpen)
    if (chatOpen) chatInput.focus()
  })

  btnCloseChat.addEventListener('click', () => {
    chatOpen = false
  })

  btnLeave.addEventListener('click', () => {
    manager.leave()
    window.location.hash = ''
    window.location.reload()
  })

  btnCopy.addEventListener('click', () => {
    const url = `${window.location.origin}${window.location.pathname}#${manager.roomCode}`
    navigator.clipboard.writeText(url).then(() => {
      replaceIcon(btnCopy, 'check')
      setTimeout(() => replaceIcon(btnCopy, 'copy'), 2000)
    })
  })

  formChat.addEventListener('submit', (e) => {
    e.preventDefault()
    const text = chatInput.value.trim()
    if (!text) return
    manager.sendChat(text)
    addChatMessage('self', text, true)
    chatInput.value = ''
  })

  // ─── Settings panel (device selection + rename) ───

  let settingsOpen = false

  btnSettings.addEventListener('click', async () => {
    settingsOpen = !settingsOpen
    settingsPanel.classList.toggle('hidden', !settingsOpen)
    if (settingsOpen) {
      await populateDeviceSelectors()
      inputDisplayName.value = manager.myName
    }
  })

  btnCloseSettings.addEventListener('click', () => {
    settingsOpen = false
    settingsPanel.classList.add('hidden')
  })

  // Rename from settings input
  inputDisplayName.addEventListener('change', () => {
    applyRename(inputDisplayName.value)
  })
  inputDisplayName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      inputDisplayName.blur()
    }
  })

  // ─── Camera panel (device + filters) ───

  let cameraPanelOpen = false

  function updateFilterLabels() {
    valBrightness.textContent = `${Math.round(cameraFilters.brightness * 100)}%`
    valContrast.textContent = `${Math.round(cameraFilters.contrast * 100)}%`
    valSaturation.textContent = `${Math.round(cameraFilters.saturation * 100)}%`
    valBlur.textContent = `${cameraFilters.blur}px`
  }

  function syncFilterInputs() {
    filterBrightness.value = String(cameraFilters.brightness)
    filterContrast.value = String(cameraFilters.contrast)
    filterSaturation.value = String(cameraFilters.saturation)
    filterBlur.value = String(cameraFilters.blur)
    updateFilterLabels()
  }

  syncFilterInputs()

  btnCameraMenu.addEventListener('click', async () => {
    cameraPanelOpen = !cameraPanelOpen
    cameraPanel.classList.toggle('hidden', !cameraPanelOpen)
    if (cameraPanelOpen) {
      await populateDeviceSelectors()
      syncFilterInputs()
    }
  })

  btnCloseCamera.addEventListener('click', () => {
    cameraPanelOpen = false
    cameraPanel.classList.add('hidden')
  })

  function applyFilterChange() {
    cameraFilters = {
      brightness: parseFloat(filterBrightness.value),
      contrast: parseFloat(filterContrast.value),
      saturation: parseFloat(filterSaturation.value),
      blur: parseFloat(filterBlur.value),
    }
    if (cameraPipeline) {
      cameraPipeline.setFilters(cameraFilters)
    } else {
      applyCssFiltersToLocalPreview()
    }
    updateFilterLabels()
    saveFilters(cameraFilters)
  }

  filterBrightness.addEventListener('input', applyFilterChange)
  filterContrast.addEventListener('input', applyFilterChange)
  filterSaturation.addEventListener('input', applyFilterChange)
  filterBlur.addEventListener('input', applyFilterChange)

  btnResetFilters.addEventListener('click', () => {
    cameraFilters = { ...DEFAULT_FILTERS }
    if (cameraPipeline) {
      cameraPipeline.setFilters(cameraFilters)
    } else {
      applyCssFiltersToLocalPreview()
    }
    saveFilters(cameraFilters)
    syncFilterInputs()
  })

  selectAudioInput.addEventListener('change', async () => {
    const deviceId = selectAudioInput.value
    if (!deviceId) return
    saveDevicePref('mic', deviceId)
    try {
      if (!localStream) return

      // Browser NS off when RNNoise is handling it, on otherwise.
      const newTrack = await getMicTrack(deviceId, !noiseSuppression)

      let trackToPublish: MediaStreamTrack = newTrack
      if (noiseSuppression) {
        const newStream = new MediaStream([newTrack])
        const processedStream = await updateNoiseSuppressionSource(newStream)
        if (processedStream) {
          trackToPublish = processedStream.getAudioTracks()[0]
        } else {
          // Pipeline failed — release the NS-off track and re-acquire one
          // with browser NS on so the user isn't left with raw mic audio.
          newTrack.stop()
          trackToPublish = await getMicTrack(deviceId, true)
          noiseSuppression = false
          btnNoise.classList.remove('active')
          replaceIcon(btnNoise, 'volume-x')
        }
      }

      await replaceLocalAudioTrack(trackToPublish)
    } catch (err) {
      console.error('[PeerCall] Failed to switch mic:', err)
    }
  })

  if (sinkSupported) {
    selectAudioOutput.addEventListener('change', async () => {
      const deviceId = selectAudioOutput.value
      if (!deviceId) return
      saveDevicePref('speaker', deviceId)
      for (const tile of videoTiles.values()) {
        try {
          await (tile.video as unknown as { setSinkId: (id: string) => Promise<void> }).setSinkId(deviceId)
        } catch (err) {
          console.error('[PeerCall] Failed to set speaker:', err)
        }
      }
    })
  }

  selectVideoInput.addEventListener('change', async () => {
    const deviceId = selectVideoInput.value
    if (!deviceId) return
    saveDevicePref('camera', deviceId)
    try {
      if (!localStream) return
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          deviceId: { exact: deviceId },
        },
      })
      const rawTrack = newStream.getVideoTracks()[0]
      if (!rawTrack) return

      if (pipelineSupported) {
        // Tear down the old pipeline (which stops the old raw track) and
        // start a fresh one on the new camera.
        cameraPipeline?.stop()
        cameraPipeline = startCameraPipeline(rawTrack, cameraFilters)
        await replaceLocalVideoTrack(cameraPipeline.output, false)
      } else {
        // No pipeline — publish the new raw track directly; CSS handles local filtering.
        await replaceLocalVideoTrack(rawTrack, true)
        applyCssFiltersToLocalPreview()
      }
      refreshLocalPreview()
    } catch (err) {
      console.error('[PeerCall] Failed to switch camera:', err)
    }
  })
}

// ─── Settings Panel ───

async function populateDeviceSelectors() {
  // On iOS Safari, device labels are empty until getUserMedia has been
  // granted.  Re-enumerate after permission is already active.
  // Also, iOS does not support audiooutput / setSinkId — we hide the
  // speaker selector in that case.

  try {
    const devices = await navigator.mediaDevices.enumerateDevices()

    // Audio inputs (microphones)
    const audioInputs = devices.filter((d) => d.kind === 'audioinput')
    selectAudioInput.innerHTML = ''
    if (audioInputs.length === 0) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = 'No microphones found'
      opt.disabled = true
      selectAudioInput.appendChild(opt)
    } else {
      audioInputs.forEach((d, i) => {
        const opt = document.createElement('option')
        opt.value = d.deviceId
        // Label may be empty on iOS until permission is granted;
        // fall back to generic name
        opt.textContent = d.label || `Microphone ${i + 1}`
        selectAudioInput.appendChild(opt)
      })
    }

    // Audio outputs (speakers) — not supported on iOS/Safari
    const audioOutputs = devices.filter((d) => d.kind === 'audiooutput')
    const outputLabel = selectAudioOutput.closest('label')
    if (!sinkSupported || audioOutputs.length === 0) {
      // Hide speaker selector entirely on unsupported browsers
      if (outputLabel) outputLabel.classList.add('hidden')
    } else {
      if (outputLabel) outputLabel.classList.remove('hidden')
      selectAudioOutput.innerHTML = ''
      audioOutputs.forEach((d, i) => {
        const opt = document.createElement('option')
        opt.value = d.deviceId
        opt.textContent = d.label || `Speaker ${i + 1}`
        selectAudioOutput.appendChild(opt)
      })
    }

    // Video inputs (cameras)
    const videoInputs = devices.filter((d) => d.kind === 'videoinput')
    selectVideoInput.innerHTML = ''
    if (videoInputs.length === 0) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = 'No cameras found'
      opt.disabled = true
      selectVideoInput.appendChild(opt)
    } else {
      videoInputs.forEach((d, i) => {
        const opt = document.createElement('option')
        opt.value = d.deviceId
        opt.textContent = d.label || `Camera ${i + 1}`
        selectVideoInput.appendChild(opt)
      })
    }

    // Select saved device preferences, fall back to current active device
    const saved = getDevicePrefs()
    if (saved.mic && audioInputs.some((d) => d.deviceId === saved.mic)) {
      selectAudioInput.value = saved.mic
    } else if (localStream) {
      const currentAudio = localStream.getAudioTracks()[0]
      if (currentAudio) {
        const settings = currentAudio.getSettings()
        if (settings.deviceId) selectAudioInput.value = settings.deviceId
      }
    }

    if (saved.speaker && audioOutputs.some((d) => d.deviceId === saved.speaker)) {
      selectAudioOutput.value = saved.speaker
    }

    if (saved.camera && videoInputs.some((d) => d.deviceId === saved.camera)) {
      selectVideoInput.value = saved.camera
    } else {
      const activeId = currentCameraDeviceId()
      if (activeId && videoInputs.some((d) => d.deviceId === activeId)) {
        selectVideoInput.value = activeId
      }
    }
  } catch (err) {
    console.error('[PeerCall] enumerateDevices failed:', err)
  }
}

// ─── Video Tiles ───

function addLocalVideo(stream: MediaStream) {
  removeVideoTile('local')
  const tile = createVideoTile('local', manager.myName, true)
  tile.video.srcObject = stream
  tile.video.autoplay = true
  tile.video.muted = true
  tile.video.playsInline = true
  tile.video.classList.add('mirror')
  // Make local name tag clickable for inline rename
  tile.nameTag.classList.add('editable')
  tile.nameTag.title = 'Click to change your name'
  tile.nameTag.addEventListener('click', () => startInlineRename(tile.nameTag))
  videoGrid.appendChild(tile.container)
  updateGridCount()
}

function addRemoteVideo(peerId: string, stream: MediaStream) {
  removeVideoTile(peerId)
  const peer = manager.peerList.find((p) => p.id === peerId)
  const name = peer?.name || '...'
  const tile = createVideoTile(peerId, name, false)
  tile.video.srcObject = stream
  tile.video.autoplay = true
  tile.video.playsInline = true
  videoGrid.appendChild(tile.container)
  updateGridCount()
}

function createVideoTile(id: string, name: string, isLocal: boolean) {
  const container = document.createElement('div')
  container.className = 'video-tile'
  container.dataset.peerId = id

  const video = document.createElement('video')
  video.autoplay = true
  video.playsInline = true
  if (isLocal) video.muted = true

  const nameTag = document.createElement('span')
  nameTag.className = 'name-tag'
  nameTag.textContent = isLocal ? `${name} (you)` : name

  const mutedInd = document.createElement('div')
  mutedInd.className = 'muted-indicator hidden'
  mutedInd.textContent = '🔇'

  container.appendChild(video)
  container.appendChild(nameTag)
  container.appendChild(mutedInd)

  const tile = { container, video, nameTag, mutedInd }
  videoTiles.set(id, tile)
  return tile
}

function removeVideoTile(peerId: string) {
  const tile = videoTiles.get(peerId)
  if (tile) {
    tile.container.remove()
    videoTiles.delete(peerId)
    updateGridCount()
  }
}

function updatePeerName(peerId: string, name: string) {
  const tile = videoTiles.get(peerId)
  if (tile) {
    tile.nameTag.textContent = peerId === 'local' ? `${name} (you)` : name
  }
}

function updateMuteIndicator(peerId: string, muted: boolean) {
  const tile = videoTiles.get(peerId)
  if (tile) tile.mutedInd.classList.toggle('hidden', !muted)
}

function updateGridCount() {
  videoGrid.dataset.count = String(videoTiles.size)
}

// ─── Inline rename (click on name tag) ───

function startInlineRename(nameTag: HTMLSpanElement) {
  const currentName = manager.myName
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'name-tag-input'
  input.value = currentName
  input.maxLength = 24
  input.style.width = `${Math.max(60, currentName.length * 9)}px`

  nameTag.style.display = 'none'
  nameTag.parentElement!.appendChild(input)
  input.focus()
  input.select()

  const finishRename = () => {
    const newName = input.value.trim()
    input.remove()
    nameTag.style.display = ''
    if (newName && newName !== currentName) {
      applyRename(newName)
    } else {
      updateLocalNameTag()
    }
  }

  input.addEventListener('blur', finishRename)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      input.blur()
    } else if (e.key === 'Escape') {
      input.value = currentName
      input.blur()
    }
  })
}

// ─── Chat ───

function addChatMessage(from: string, text: string, isSelf: boolean) {
  const msg = document.createElement('div')
  msg.className = `chat-msg ${isSelf ? 'self' : ''}`

  if (!isSelf) {
    const peer = manager.peerList.find((p) => p.id === from)
    const nameDiv = document.createElement('div')
    nameDiv.className = 'chat-msg-name'
    nameDiv.textContent = peer?.name || from.slice(0, 8)
    msg.appendChild(nameDiv)
  }

  const textDiv = document.createElement('div')
  textDiv.className = 'chat-msg-text'
  textDiv.textContent = text
  msg.appendChild(textDiv)

  chatMessages.appendChild(msg)
  chatMessages.scrollTop = chatMessages.scrollHeight
}

// ─── URL hash change ───

window.addEventListener('hashchange', () => {
  const code = window.location.hash.slice(1).trim()
  if (code && code.length >= 4) joinRoom(code)
})

// ─── Start ───

init()
