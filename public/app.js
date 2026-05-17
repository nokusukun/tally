// TALLY — unified controller
// Mode detection by URL: `?join=CODE` → sender. Otherwise → viewer.

const $ = (id) => document.getElementById(id);
const app = $('app');
const screens = {
  loading:      document.querySelector('[data-screen="loading"]'),
  pairing:      document.querySelector('[data-screen="pairing"]'),
  viewer:       document.querySelector('[data-screen="viewer"]'),
  senderIntro:  document.querySelector('[data-screen="sender-intro"]'),
  sender:       document.querySelector('[data-screen="sender"]'),
  capture:      document.querySelector('[data-screen="capture"]'),
  error:        document.querySelector('[data-screen="error"]'),
};

function setScreen(name) {
  app.dataset.mode = name;
  for (const [key, el] of Object.entries(screens)) {
    const norm = key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
    const isOn = key === name || norm === name;
    if (isOn) {
      el.removeAttribute('hidden');
      el.removeAttribute('aria-hidden');
    } else {
      el.setAttribute('hidden', '');
      el.setAttribute('aria-hidden', 'true');
    }
  }
}

// ---------- pair codes ----------
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/I/L/1
function makePairCode(n = 4) {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  let s = '';
  for (let i = 0; i < n; i++) s += PAIR_ALPHABET[arr[i] % PAIR_ALPHABET.length];
  return s;
}

const params = new URLSearchParams(location.search);
const joinCode = params.get('join');

// ---------- shared signaling ----------
function openSignaling(room, role) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(room)}&role=${role}`);
}

const ICE = {
  iceServers: [
    // Multiple STUN providers so one DNS failure doesn't kill negotiation.
    // For pure LAN streaming, host candidates work without any of these.
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ],
};

// ---------- formatting ----------
function fmtBitrate(kbps) {
  if (!kbps || !isFinite(kbps)) return '—';
  if (kbps >= 1000) return (kbps / 1000).toFixed(2) + ' Mb/s';
  return Math.round(kbps) + ' kb/s';
}

// ---------- environment / base origin ----------
const isElectron = !!(window.webstream && window.webstream.isElectron);

function isTouchDevice() {
  return matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches;
}
function isStandalonePWA() {
  return window.navigator.standalone === true
    || matchMedia('(display-mode: standalone)').matches
    || matchMedia('(display-mode: fullscreen)').matches;
}
async function enterViewfinderFullscreen() {
  if (isElectron) return;
  if (!isTouchDevice()) return;
  if (isStandalonePWA()) return;          // PWA install already gives chromeless UI
  if (document.fullscreenElement) return;
  const el = document.documentElement;
  if (!el.requestFullscreen) return;       // iOS Safari falls through here
  try {
    await el.requestFullscreen({ navigationUI: 'hide' });
  } catch {}
}
async function exitViewfinderFullscreen() {
  if (document.fullscreenElement && document.exitFullscreen) {
    try { await document.exitFullscreen(); } catch {}
  }
}

async function fetchServerInfo() {
  if (isElectron) {
    try { return await window.webstream.getInfo(); } catch { return null; }
  }
  try {
    const r = await fetch('/api/info');
    return await r.json();
  } catch { return null; }
}

async function resolveBaseOrigin() {
  const info = await fetchServerInfo();
  if (info && info.tunnelUrl) return info.tunnelUrl;
  const host = location.hostname;
  const onLoopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (info && info.lanIps && info.lanIps[0] && (onLoopback || isElectron)) {
    const port = info.port || (location.port || (location.protocol === 'https:' ? 443 : 80));
    return `${location.protocol}//${info.lanIps[0]}:${port}`;
  }
  return location.origin;
}

// ---------- Electron bootstrap ----------
function bootstrapElectron() {
  if (!isElectron) return;
  document.body.classList.add('is-electron');
  document.body.classList.add('platform-' + window.webstream.platform);

  document.querySelectorAll('.winctrl').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      if (action === 'minimize') window.webstream.windowControls.minimize();
      else if (action === 'toggle-maximize') window.webstream.windowControls.toggleMaximize();
      else if (action === 'close') window.webstream.windowControls.close();
    });
  });

  window.webstream.onWindowState(({ maximized }) => {
    const btn = document.querySelector('.winctrl[data-action="toggle-maximize"]');
    if (!btn) return;
    btn.innerHTML = maximized
      ? '<svg viewBox="0 0 10 10" width="10" height="10"><rect x="3" y="1" width="6" height="6" stroke="currentColor" stroke-width="1" fill="none"/><rect x="1" y="3" width="6" height="6" stroke="currentColor" stroke-width="1" fill="none"/></svg>'
      : '<svg viewBox="0 0 10 10" width="10" height="10"><rect x="2" y="2" width="6" height="6" stroke="currentColor" stroke-width="1" fill="none"/></svg>';
  });
}

// =============================================================
// VIEWER
// =============================================================
const LAST_ROOM_KEY = 'webstream.viewer.lastRoom';

async function runViewer(explicitCode) {
  // Capture the previous room BEFORE we save the new one so we can offer reconnect.
  let priorRoom = null;
  try { priorRoom = localStorage.getItem(LAST_ROOM_KEY); } catch {}

  const code = explicitCode || makePairCode();
  let baseOrigin = await resolveBaseOrigin();

  try { localStorage.setItem(LAST_ROOM_KEY, code); } catch {}

  // Tell Electron main the current room, so capture window can join it
  if (isElectron && window.webstream.capture) {
    window.webstream.capture.setRoom(code);
  }

  // If a prior session (different room) still has a sender hanging on, offer to reconnect.
  // Phone might take a few seconds to reconnect to the server after Electron restart, so poll.
  if (priorRoom && priorRoom !== code) {
    (async () => {
      const maxAttempts = 7; // ~14s window
      for (let i = 0; i < maxAttempts; i++) {
        try {
          const r = await fetch(`/api/room/${encodeURIComponent(priorRoom)}`);
          if (r.ok) {
            const info = await r.json();
            if (info.exists && info.hasSender) {
              $('pending-code').textContent = priorRoom;
              $('pending-banner').hidden = false;
              return;
            }
          }
        } catch {}
        // If banner already shown (race) or user dismissed, stop polling
        if (!$('pending-banner').hidden) return;
        await new Promise((res) => setTimeout(res, 2000));
      }
    })();
  }

  $('pending-reconnect').addEventListener('click', () => {
    if (!priorRoom) return;
    location.href = `${location.origin}/?room=${encodeURIComponent(priorRoom)}`;
  });
  $('pending-dismiss').addEventListener('click', () => {
    $('pending-banner').hidden = true;
  });

  $('paircode').textContent = code;

  function fullPairUrl() { return `${baseOrigin}/?join=${code}`; }
  function refreshPairTargets() {
    const url = fullPairUrl();
    $('pairurl').textContent = url.replace(/^https?:\/\//, '');
    $('qr').src = `/qr?data=${encodeURIComponent(url)}`;
    const isPublic = /trycloudflare\.com|ngrok/i.test(baseOrigin);
    $('bot-network').textContent = isPublic ? 'PUBLIC NETWORK' : 'LOCAL NETWORK';
  }
  refreshPairTargets();

  // click-to-copy pair URL
  $('pairurl').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(fullPairUrl());
      $('pairurl').classList.add('copied');
      setTimeout(() => $('pairurl').classList.remove('copied'), 1100);
    } catch {}
  });

  // tunnel toggle (Electron only)
  if (isElectron) {
    const toggle = $('tunnel-toggle');
    toggle.hidden = false;
    let tunnelState = 'closed';

    function setToggle(state, label) {
      tunnelState = state;
      toggle.dataset.state = state === 'closed' ? '' : state;
      $('tunnel-label').textContent = label;
    }

    window.webstream.tunnel.onState(async ({ url, status }) => {
      if (url) {
        baseOrigin = url;
        setToggle('open', 'PUBLIC TUNNEL · OPEN');
        refreshPairTargets();
      } else {
        baseOrigin = await resolveBaseOrigin();
        setToggle('closed', 'OPEN PUBLIC TUNNEL');
        refreshPairTargets();
      }
    });

    toggle.addEventListener('click', async () => {
      if (tunnelState === 'loading') return;
      if (tunnelState === 'closed') {
        setToggle('loading', 'OPENING TUNNEL…');
        toggle.disabled = true;
        try {
          await window.webstream.tunnel.start();
        } catch (e) {
          setToggle('error', 'TUNNEL FAILED — RETRY');
          setTimeout(() => setToggle('closed', 'OPEN PUBLIC TUNNEL'), 2400);
        } finally {
          toggle.disabled = false;
        }
      } else if (tunnelState === 'open') {
        setToggle('loading', 'CLOSING TUNNEL…');
        toggle.disabled = true;
        try { await window.webstream.tunnel.stop(); } finally { toggle.disabled = false; }
      }
    });

    // Reflect any tunnel already up at startup
    const info = await window.webstream.getInfo();
    if (info && info.tunnelUrl) {
      baseOrigin = info.tunnelUrl;
      setToggle('open', 'PUBLIC TUNNEL · OPEN');
      refreshPairTargets();
    }
  }

  setScreen('pairing');

  let pc = null;
  let ws = null;
  let statsTimer = null;
  let lastBytes = 0, lastTs = 0;
  let connected = false;
  let myId = null;
  let senderId = null;
  let senderState = null; // last sender-state payload

  function teardown() {
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
    if (pc) { try { pc.close(); } catch {} pc = null; }
    if (ws) { try { ws.close(); } catch {} ws = null; }
  }

  function fail(msg) {
    teardown();
    $('error-msg').textContent = msg;
    setScreen('error');
  }

  function setupPc() {
    pc = new RTCPeerConnection(ICE);
    pc.ontrack = (e) => {
      const v = $('stream');
      v.srcObject = e.streams[0];
      v.muted = $('v-mute')?.dataset.muted !== '0';
      if (!connected) {
        connected = true;
        setScreen('viewer');
        startStats();
      }
    };
    pc.onicecandidate = (e) => {
      if (e.candidate && senderId && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'ice', to: senderId, candidate: e.candidate }));
      }
    };
    pc.onconnectionstatechange = () => {
      const status = $('viewer-status');
      if (pc.connectionState === 'failed') {
        status.dataset.state = 'failed';
        status.lastElementChild.textContent = 'LOST';
      } else if (pc.connectionState === 'connected') {
        status.dataset.state = 'connected';
        status.lastElementChild.textContent = 'LIVE';
      }
    };
  }

  function connect() {
    ws = openSignaling(code, 'viewer');
    setupPc();

    ws.onmessage = async (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === 'welcome') {
        myId = msg.id;
        const sender = (msg.peers || []).find((p) => p.role === 'sender');
        if (sender) {
          senderId = sender.id;
          ws.send(JSON.stringify({ type: 'request-offer', to: senderId }));
        }
      } else if (msg.type === 'peer-joined' && msg.role === 'sender') {
        senderId = msg.id;
        ws.send(JSON.stringify({ type: 'request-offer', to: senderId }));
      } else if (msg.type === 'offer' && msg.from) {
        senderId = msg.from;
        await pc.setRemoteDescription(msg.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: 'answer', to: senderId, sdp: answer }));
      } else if (msg.type === 'ice' && msg.from === senderId && msg.candidate) {
        try { await pc.addIceCandidate(msg.candidate); } catch (e) { console.warn(e); }
      } else if (msg.type === 'peer-left' && msg.id === senderId) {
        const v = $('stream');
        v.srcObject = null;
        connected = false;
        senderId = null;
        senderState = null;
        if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
        try { pc.close(); } catch {}
        setupPc();
        setScreen('pairing');
      } else if (msg.type === 'sender-state' && msg.from === senderId) {
        senderState = msg.payload;
        renderControlPanel();
      }
    };
  }

  function sendControl(payload) {
    if (!ws || ws.readyState !== 1 || !senderId) return;
    ws.send(JSON.stringify({ type: 'control', to: senderId, payload }));
  }

  function renderControlPanel() {
    if (!senderState) return;
    const setSeg = (id, val) => {
      const seg = document.getElementById(id);
      if (!seg) return;
      [...seg.children].forEach((b) => {
        const on = String(b.dataset.val) === String(val);
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    };
    setSeg('vc-res', senderState.resolution);
    setSeg('vc-fps', senderState.framerate);
    setSeg('vc-bitrate', senderState.bitrate);
    setSeg('vc-facing', senderState.facing || 'environment');
    const aud = $('vc-audio');
    if (aud) aud.checked = !!senderState.audio;
  }

  function startStats() {
    if (statsTimer) clearInterval(statsTimer);
    lastBytes = 0; lastTs = 0;
    statsTimer = setInterval(async () => {
      if (!pc) return;
      const stats = await pc.getStats();
      let inbound;
      stats.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') inbound = s; });
      if (!inbound) return;
      const bytes = inbound.bytesReceived || 0;
      const ts = inbound.timestamp || 0;
      const kbps = lastTs ? Math.round(((bytes - lastBytes) * 8) / (ts - lastTs)) : 0;
      lastBytes = bytes; lastTs = ts;
      $('v-res').textContent = (inbound.frameWidth || '—') + '×' + (inbound.frameHeight || '—');
      $('v-fps').textContent = Math.round(inbound.framesPerSecond || 0) || '—';
      $('v-bitrate').textContent = fmtBitrate(kbps);
      $('v-drop').textContent = inbound.framesDropped || 0;
    }, 1000);
  }

  // controls
  const muteBtn = $('v-mute');
  muteBtn.dataset.muted = '1';
  muteBtn.addEventListener('click', () => {
    const v = $('stream');
    v.muted = !v.muted;
    muteBtn.dataset.muted = v.muted ? '1' : '0';
    muteBtn.title = v.muted ? 'Unmute (M)' : 'Mute (M)';
    muteBtn.setAttribute('aria-label', v.muted ? 'Unmute' : 'Mute');
    muteBtn.classList.toggle('on', !v.muted);
  });

  $('v-fullscreen').addEventListener('click', () => {
    const v = $('stream');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (v.requestFullscreen) v.requestFullscreen();
    else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
  });

  $('v-newroom').addEventListener('click', () => {
    try { localStorage.removeItem(LAST_ROOM_KEY); } catch {}
    teardown();
    location.href = location.origin + '/';
  });

  // ---- remote camera control sheet ----
  const ctrlBtn = $('v-control');
  const ctrlSheet = $('v-sheet');
  const ctrlBackdrop = $('v-sheet-backdrop');
  function openCtrlSheet() {
    ctrlSheet.hidden = false;
    ctrlBackdrop.hidden = false;
    requestAnimationFrame(() => {
      ctrlSheet.classList.add('open');
      ctrlBackdrop.classList.add('open');
    });
  }
  function closeCtrlSheet() {
    ctrlSheet.classList.remove('open');
    ctrlBackdrop.classList.remove('open');
    setTimeout(() => {
      ctrlSheet.hidden = true;
      ctrlBackdrop.hidden = true;
    }, 280);
  }
  ctrlBtn.addEventListener('click', () => {
    if (ctrlSheet.hidden) openCtrlSheet();
    else closeCtrlSheet();
  });
  $('v-sheet-close').addEventListener('click', closeCtrlSheet);
  ctrlBackdrop.addEventListener('click', closeCtrlSheet);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !ctrlSheet.hidden) closeCtrlSheet();
  });

  function wireRemoteSeg(id, key) {
    const seg = document.getElementById(id);
    if (!seg) return;
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      [...seg.children].forEach((b) => {
        b.classList.remove('on');
        b.setAttribute('aria-checked', 'false');
      });
      btn.classList.add('on');
      btn.setAttribute('aria-checked', 'true');
      const raw = btn.dataset.val;
      const val = isNaN(Number(raw)) || raw === '' ? raw : Number(raw);
      sendControl({ [key]: val });
    });
  }
  wireRemoteSeg('vc-res', 'resolution');
  wireRemoteSeg('vc-fps', 'framerate');
  wireRemoteSeg('vc-bitrate', 'bitrate');
  wireRemoteSeg('vc-facing', 'facing');
  $('vc-audio').addEventListener('change', (e) => {
    sendControl({ audio: e.target.checked });
  });

  // capture window toggle (Electron only)
  if (isElectron && window.webstream.capture) {
    const capBtn = $('v-capture');
    capBtn.hidden = false;
    capBtn.addEventListener('click', () => window.webstream.capture.toggle());
    window.webstream.capture.onState(({ open }) => {
      capBtn.classList.toggle('on', !!open);
      capBtn.title = open ? 'Close OBS capture window' : 'Open OBS capture window (Ctrl+Shift+C)';
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === 'm' || e.key === 'M') muteBtn.click();
    if (e.key === 'f' || e.key === 'F') $('v-fullscreen').click();
  });

  connect();
}

// =============================================================
// SENDER
// =============================================================
async function runSender(code) {
  $('intro-code').textContent = '· ' + code;
  $('sender-room').textContent = code;
  setScreen('sender-intro');

  const pcs = new Map();        // viewerId -> RTCPeerConnection
  const pcStats = new Map();    // viewerId -> { lastBytes, lastTs }
  let ws = null;
  let myId = null;
  let localStream = null;
  let statsTimer = null;
  let wakeLock = null;

  const cfg = {
    facing: 'environment',
    resolution: 720,
    framerate: 30,
    bitrate: 1500,
    audio: true,
    camera: '', // deviceId override
    mic: '',
  };

  // ---- cfg persistence ----
  const CFG_STORAGE_KEY = 'webstream.sender.cfg.v1';
  function loadStoredCfg() {
    try {
      const raw = localStorage.getItem(CFG_STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      for (const k of Object.keys(cfg)) {
        if (k in saved && saved[k] !== null && saved[k] !== undefined) cfg[k] = saved[k];
      }
    } catch (e) { console.warn('failed to load saved sender cfg', e); }
  }
  function saveStoredCfg() {
    try { localStorage.setItem(CFG_STORAGE_KEY, JSON.stringify(cfg)); } catch {}
  }
  loadStoredCfg();

  const RES = {
    360: [640, 360], 480: [854, 480], 720: [1280, 720],
    1080: [1920, 1080], 2160: [3840, 2160],
  };

  function buildConstraints() {
    const [w, h] = RES[cfg.resolution] || RES[720];
    const video = {
      width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: cfg.framerate },
    };
    if (cfg.camera) video.deviceId = { exact: cfg.camera };
    else video.facingMode = { ideal: cfg.facing };
    const audio = cfg.audio ? (cfg.mic ? { deviceId: { exact: cfg.mic } } : true) : false;
    return { video, audio };
  }

  async function listDevices() {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const camSel = $('cfg-camera');
    const micSel = $('cfg-mic');
    camSel.innerHTML = '<option value="">Auto · facing</option>';
    micSel.innerHTML = '<option value="">Default</option>';
    let cN = 1, mN = 1;
    for (const d of devs) {
      if (d.kind === 'videoinput') camSel.add(new Option(d.label || `Camera ${cN++}`, d.deviceId));
      else if (d.kind === 'audioinput') micSel.add(new Option(d.label || `Mic ${mN++}`, d.deviceId));
    }
    camSel.value = cfg.camera;
    micSel.value = cfg.mic;
  }

  async function arm() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia(buildConstraints());
    } catch (e) {
      // The saved camera or mic deviceId might no longer exist — clear & retry once.
      if ((cfg.camera || cfg.mic) && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) {
        console.warn('Saved device unavailable, retrying with defaults:', e.name);
        cfg.camera = '';
        cfg.mic = '';
        saveStoredCfg();
        try {
          localStream = await navigator.mediaDevices.getUserMedia(buildConstraints());
        } catch (e2) {
          console.error(e2);
          $('error-msg').textContent = 'Could not access camera/microphone. ' + e2.message;
          setScreen('error');
          return;
        }
      } else {
        console.error(e);
        $('error-msg').textContent = 'Could not access camera/microphone. ' + e.message;
        setScreen('error');
        return;
      }
    }
    $('preview').srcObject = localStream;
    setScreen('sender');
    enterViewfinderFullscreen();
    acquireWakeLock();
    setupTorchControl();
    listDevices().catch(() => {});
    await connect();
  }

  function isViewerRole(role) { return role === 'viewer' || role === 'capture'; }

  function refreshSenderStatus() {
    const status = $('sender-status');
    const anyConnected = [...pcs.values()].some((p) => p.connectionState === 'connected');
    const total = pcs.size;
    if (anyConnected) {
      status.dataset.state = 'connected';
      status.lastElementChild.textContent = total > 1 ? `BROADCAST · ${total}` : 'BROADCAST';
    } else if (total > 0) {
      status.dataset.state = 'waiting';
      status.lastElementChild.textContent = 'CONNECTING';
    } else {
      status.dataset.state = 'waiting';
      status.lastElementChild.textContent = 'STANDBY';
    }
  }

  let reconnectAttempt = 0;
  let reconnectTimer = null;

  async function connect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    ws = openSignaling(code, 'sender');

    ws.onopen = () => { reconnectAttempt = 0; };
    ws.onerror = () => { /* close handler will reconnect */ };
    ws.onclose = () => {
      // Whatever PCs we had used the old signaling — their peer IDs are stale.
      for (const pc of pcs.values()) { try { pc.close(); } catch {} }
      pcs.clear();
      pcStats.clear();
      myId = null;
      refreshSenderStatus();

      if (!localStream) return; // user stopped explicitly
      const delay = Math.min(8000, 1000 * Math.pow(1.5, reconnectAttempt++));
      console.log(`WS closed — reconnecting in ${Math.round(delay)}ms`);
      const status = $('sender-status');
      status.dataset.state = 'waiting';
      status.lastElementChild.textContent = 'RECONNECTING';
      reconnectTimer = setTimeout(() => {
        if (localStream) connect();
      }, delay);
    };

    ws.onmessage = async (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === 'welcome') {
        myId = msg.id;
        for (const peer of msg.peers || []) {
          if (isViewerRole(peer.role)) await negotiateWith(peer.id);
        }
      } else if (msg.type === 'peer-joined' && isViewerRole(msg.role)) {
        await negotiateWith(msg.id);
      } else if (msg.type === 'request-offer' && msg.from) {
        await negotiateWith(msg.from);
      } else if (msg.type === 'answer' && msg.from) {
        const pc = pcs.get(msg.from);
        if (pc) await pc.setRemoteDescription(msg.sdp);
      } else if (msg.type === 'ice' && msg.from && msg.candidate) {
        const pc = pcs.get(msg.from);
        if (pc) { try { await pc.addIceCandidate(msg.candidate); } catch (e) { console.warn(e); } }
      } else if (msg.type === 'peer-left' && msg.id) {
        const pc = pcs.get(msg.id);
        if (pc) { try { pc.close(); } catch {} }
        pcs.delete(msg.id);
        pcStats.delete(msg.id);
        refreshSenderStatus();
      } else if (msg.type === 'control' && msg.payload) {
        applyRemoteControl(msg.payload);
      }
    };

    startStats();
  }

  async function negotiateWith(viewerId) {
    if (pcs.has(viewerId)) return;
    const pc = new RTCPeerConnection(ICE);
    pcs.set(viewerId, pc);
    pcStats.set(viewerId, { lastBytes: 0, lastTs: 0 });
    for (const t of localStream.getTracks()) pc.addTrack(t, localStream);
    applyBitrateTo(pc);

    pc.onicecandidate = (e) => {
      if (e.candidate && ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'ice', to: viewerId, candidate: e.candidate }));
      }
    };
    pc.onconnectionstatechange = () => {
      refreshSenderStatus();
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        pcs.delete(viewerId);
        pcStats.delete(viewerId);
        refreshSenderStatus();
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'offer', to: viewerId, sdp: offer }));
    }
    // Send current sender state so the new viewer's control panel can populate
    setTimeout(() => broadcastSenderState(), 200);
  }

  function applyBitrate() {
    for (const pc of pcs.values()) applyBitrateTo(pc);
    broadcastSenderState();
    saveStoredCfg();
  }
  function applyBitrateTo(pc) {
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    if (cfg.bitrate > 0) params.encodings[0].maxBitrate = cfg.bitrate * 1000;
    else delete params.encodings[0].maxBitrate;
    sender.setParameters(params).catch(() => {});
  }

  async function applyRemoteControl(p) {
    let needsMediaReconfigure = false;
    if (typeof p.resolution === 'number' && p.resolution !== cfg.resolution) {
      cfg.resolution = p.resolution; needsMediaReconfigure = true;
    }
    if (typeof p.framerate === 'number' && p.framerate !== cfg.framerate) {
      cfg.framerate = p.framerate; needsMediaReconfigure = true;
    }
    if (typeof p.bitrate === 'number' && p.bitrate !== cfg.bitrate) {
      cfg.bitrate = p.bitrate; applyBitrate();
    }
    if (typeof p.audio === 'boolean' && p.audio !== cfg.audio) {
      cfg.audio = p.audio;
      if (localStream) localStream.getAudioTracks().forEach((t) => (t.enabled = cfg.audio));
    }
    if (p.facing && p.facing !== cfg.facing) {
      cfg.facing = p.facing; cfg.camera = '';
      screens.sender.classList.toggle('flipped', cfg.facing === 'user');
      needsMediaReconfigure = true;
    }
    if (needsMediaReconfigure) await reconfigureMedia();
    reflectConfigInUI();
    broadcastSenderState();
    saveStoredCfg();
  }

  function reflectConfigInUI() {
    const setSeg = (id, val) => {
      const seg = document.getElementById(id);
      if (!seg) return;
      [...seg.children].forEach((b) => {
        const on = String(b.dataset.val) === String(val);
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    };
    setSeg('cfg-res', cfg.resolution);
    setSeg('cfg-fps', cfg.framerate);
    setSeg('cfg-bitrate', cfg.bitrate);
    const aud = $('cfg-audio');
    if (aud) aud.checked = cfg.audio;
  }

  function broadcastSenderState() {
    if (!ws || ws.readyState !== 1) return;
    const settings = localStream && localStream.getVideoTracks()[0]?.getSettings() || {};
    ws.send(JSON.stringify({
      type: 'sender-state',
      payload: {
        resolution: cfg.resolution,
        framerate: cfg.framerate,
        bitrate: cfg.bitrate,
        audio: cfg.audio,
        facing: cfg.facing,
        actualWidth: settings.width,
        actualHeight: settings.height,
        actualFps: settings.frameRate ? Math.round(settings.frameRate) : null,
      },
    }));
  }

  function setupTorchControl() {
    const track = localStream && localStream.getVideoTracks()[0];
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};
    const btn = $('s-torch');
    if (caps && caps.torch) {
      btn.hidden = false;
      btn.onclick = async () => {
        const on = btn.dataset.on !== '1';
        try {
          await track.applyConstraints({ advanced: [{ torch: on }] });
          btn.dataset.on = on ? '1' : '0';
          btn.classList.toggle('on', on);
        } catch {}
      };
    } else {
      btn.hidden = true;
    }
  }

  async function reconfigureMedia() {
    if (!localStream) return;
    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia(buildConstraints());
    } catch (e) {
      console.warn('reconfigure failed', e);
      return;
    }
    const newV = newStream.getVideoTracks()[0];
    const newA = newStream.getAudioTracks()[0];
    for (const pc of pcs.values()) {
      const vs = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      const as = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
      if (vs && newV) await vs.replaceTrack(newV);
      if (as && newA) await as.replaceTrack(newA);
      else if (newA && !as) pc.addTrack(newA, newStream);
    }
    localStream.getTracks().forEach((t) => t.stop());
    localStream = newStream;
    $('preview').srcObject = newStream;
    setupTorchControl();
    applyBitrate();
    broadcastSenderState();
    saveStoredCfg();
  }

  function startStats() {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = setInterval(async () => {
      let totalKbps = 0;
      let samples = 0;
      for (const [viewerId, pc] of pcs) {
        const stats = await pc.getStats();
        let outbound;
        stats.forEach((s) => { if (s.type === 'outbound-rtp' && s.kind === 'video') outbound = s; });
        if (!outbound) continue;
        const bookkeeping = pcStats.get(viewerId);
        const bytes = outbound.bytesSent || 0;
        const ts = outbound.timestamp || 0;
        const kbps = bookkeeping.lastTs ? Math.round(((bytes - bookkeeping.lastBytes) * 8) / (ts - bookkeeping.lastTs)) : 0;
        bookkeeping.lastBytes = bytes; bookkeeping.lastTs = ts;
        totalKbps += kbps;
        samples++;
      }
      const v = localStream && localStream.getVideoTracks()[0];
      const settings = v ? v.getSettings() : {};
      $('s-bitrate').textContent = samples ? fmtBitrate(totalKbps) : '—';
      $('s-res').textContent = (settings.width || '—') + '×' + (settings.height || '—');
      $('s-fps').textContent = Math.round(settings.frameRate || 0) || '—';
    }, 1000);
  }

  function stop() {
    if (statsTimer) clearInterval(statsTimer);
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    for (const pc of pcs.values()) { try { pc.close(); } catch {} }
    pcs.clear();
    pcStats.clear();
    if (ws) { try { ws.close(); } catch {} }
    $('preview').srcObject = null;
    releaseWakeLock();
    exitViewfinderFullscreen();
    location.href = location.origin + '/';
  }

  async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { console.warn('wake lock', e.message); }
  }
  function releaseWakeLock() {
    if (wakeLock) { try { wakeLock.release(); } catch {} wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !wakeLock && localStream) {
      acquireWakeLock();
    }
  });

  // ---- control wiring ----
  $('arm').addEventListener('click', arm);
  $('s-stop').addEventListener('click', stop);
  $('s-flip').addEventListener('click', () => {
    cfg.facing = cfg.facing === 'environment' ? 'user' : 'environment';
    cfg.camera = ''; // clear explicit device when toggling facing
    screens.sender.classList.toggle('flipped', cfg.facing === 'user');
    reconfigureMedia();
  });

  // ---- idle mode ----
  const idleOverlay = $('idle-overlay');
  function enterIdle() {
    idleOverlay.hidden = false;
    refreshOperatorTiles();
  }
  function exitIdle() {
    idleOverlay.hidden = true;
    refreshOperatorTiles();
  }
  $('s-idle').addEventListener('click', enterIdle);
  idleOverlay.addEventListener('click', exitIdle);
  idleOverlay.addEventListener('touchend', exitIdle);
  idleOverlay.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') exitIdle();
  });

  // settings sheet
  const sheet = $('sheet');
  const backdrop = $('sheet-backdrop');
  function openSheet() {
    sheet.hidden = false;
    backdrop.hidden = false;
    requestAnimationFrame(() => {
      sheet.classList.add('open');
      backdrop.classList.add('open');
    });
  }
  function closeSheet() {
    sheet.classList.remove('open');
    backdrop.classList.remove('open');
    setTimeout(() => {
      sheet.hidden = true;
      backdrop.hidden = true;
    }, 280);
  }
  $('s-settings').addEventListener('click', openSheet);
  $('sheet-close').addEventListener('click', closeSheet);
  backdrop.addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sheet.hidden) closeSheet();
  });

  $('cfg-camera').addEventListener('change', (e) => { cfg.camera = e.target.value; reconfigureMedia(); });
  $('cfg-mic').addEventListener('change', (e) => { cfg.mic = e.target.value; reconfigureMedia(); });
  $('cfg-audio').addEventListener('change', (e) => {
    cfg.audio = e.target.checked;
    if (localStream) localStream.getAudioTracks().forEach((t) => (t.enabled = cfg.audio));
    broadcastSenderState();
    saveStoredCfg();
  });

  function wireSeg(id, onChange) {
    const seg = document.getElementById(id);
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      [...seg.children].forEach((b) => { b.classList.remove('on'); b.setAttribute('aria-checked', 'false'); });
      btn.classList.add('on');
      btn.setAttribute('aria-checked', 'true');
      onChange(btn.dataset.val);
    });
  }
  wireSeg('cfg-res', (v) => { cfg.resolution = +v; reconfigureMedia(); });
  wireSeg('cfg-fps', (v) => { cfg.framerate = +v; reconfigureMedia(); });
  wireSeg('cfg-bitrate', (v) => { cfg.bitrate = +v; applyBitrate(); });

  // ---- layout (default vs operator) ----
  const OP_RES_STEPS = [360, 480, 720, 1080, 2160];
  const OP_FPS_STEPS = [15, 24, 30, 60];
  const OP_BITRATE_STEPS = [0, 1500, 3000, 6000, 12000];

  function resUnit(p) {
    if (p >= 2160) return '4K';
    if (p >= 1080) return 'FHD';
    if (p >= 720) return 'HD';
    return 'SD';
  }
  function bitrateLabel(kbps) {
    if (!kbps) return 'AUTO';
    if (kbps >= 1000) {
      const v = kbps / 1000;
      return v % 1 === 0 ? String(v) : v.toFixed(1);
    }
    return String(kbps);
  }
  function bitrateUnit(kbps) {
    if (!kbps) return '';
    return kbps >= 1000 ? 'Mb/s' : 'kb/s';
  }
  function nextIn(arr, value) {
    const i = arr.indexOf(value);
    return arr[(i + 1) % arr.length];
  }

  function refreshOperatorTiles() {
    const setText = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };
    setText('op-val-res', String(cfg.resolution));
    setText('op-unit-res', resUnit(cfg.resolution));
    setText('op-val-fps', String(cfg.framerate));
    setText('op-val-bitrate', bitrateLabel(cfg.bitrate));
    setText('op-unit-bitrate', bitrateUnit(cfg.bitrate));
    setText('op-val-audio', cfg.audio ? 'ON' : 'OFF');
    document.querySelectorAll('.op-tile[data-op="audio"]').forEach((t) => {
      t.dataset.on = cfg.audio ? 'true' : 'false';
    });
    document.querySelectorAll('.op-tile[data-op="idle"]').forEach((t) => {
      t.dataset.on = $('idle-overlay').hidden ? 'false' : 'true';
    });
  }

  function setLayout(mode) {
    screens.sender.classList.toggle('layout-operator', mode === 'operator');
    const seg = $('cfg-layout');
    if (seg) {
      [...seg.children].forEach((b) => {
        const on = b.dataset.val === mode;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    }
    if (mode === 'operator') {
      closeSheet();
      refreshOperatorTiles();
    }
  }
  wireSeg('cfg-layout', (v) => setLayout(v));

  // Operator panel tile actions
  const opActions = {
    res: () => {
      cfg.resolution = nextIn(OP_RES_STEPS, cfg.resolution);
      reflectConfigInUI();
      refreshOperatorTiles();
      reconfigureMedia();
    },
    fps: () => {
      cfg.framerate = nextIn(OP_FPS_STEPS, cfg.framerate);
      reflectConfigInUI();
      refreshOperatorTiles();
      reconfigureMedia();
    },
    bitrate: () => {
      cfg.bitrate = nextIn(OP_BITRATE_STEPS, cfg.bitrate);
      reflectConfigInUI();
      refreshOperatorTiles();
      applyBitrate();
    },
    audio: () => {
      cfg.audio = !cfg.audio;
      if (localStream) localStream.getAudioTracks().forEach((t) => (t.enabled = cfg.audio));
      reflectConfigInUI();
      refreshOperatorTiles();
      broadcastSenderState();
      saveStoredCfg();
    },
    flip: () => $('s-flip').click(),
    idle: () => $('s-idle').click(),
    stop: () => $('s-stop').click(),
  };
  document.querySelectorAll('.op-tile, .op-stop').forEach((btn) => {
    const op = btn.dataset.op;
    if (op && opActions[op]) btn.addEventListener('click', opActions[op]);
  });
  $('operator-exit').addEventListener('click', () => setLayout('default'));

  // After remote control (control msg) or initial config sync, refresh tiles
  const _origReflect = reflectConfigInUI;
  reflectConfigInUI = function() {
    _origReflect();
    refreshOperatorTiles();
  };

  // Sync controls with loaded/persisted cfg now that handlers are wired
  reflectConfigInUI();
  // Reflect facing on the preview right away too
  screens.sender.classList.toggle('flipped', cfg.facing === 'user');

  // sheet swipe-to-close (touch)
  let touchStartY = null;
  sheet.addEventListener('touchstart', (e) => { touchStartY = e.touches[0].clientY; }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (touchStartY == null) return;
    const dy = e.touches[0].clientY - touchStartY;
    if (dy > 0) sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  sheet.addEventListener('touchend', (e) => {
    if (touchStartY == null) return;
    const dy = (e.changedTouches[0].clientY - touchStartY);
    sheet.style.transform = '';
    if (dy > 80) closeSheet();
    touchStartY = null;
  });
}

// =============================================================
// CAPTURE — chromeless video receiver for OBS Window Capture
// =============================================================
async function runCapture(room) {
  document.title = 'Tally Capture';
  document.body.classList.add('role-capture');
  setScreen('capture');

  const ws = openSignaling(room, 'capture');
  let pc = new RTCPeerConnection(ICE);
  let myId = null;
  let senderId = null;

  function attachPcHandlers() {
    pc.ontrack = (e) => {
      $('capture-stream').srcObject = e.streams[0];
      $('capture-stream').muted = true;
    };
    pc.onicecandidate = (e) => {
      if (e.candidate && senderId && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'ice', to: senderId, candidate: e.candidate }));
      }
    };
  }
  attachPcHandlers();

  ws.onmessage = async (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'welcome') {
      myId = msg.id;
      const sender = (msg.peers || []).find((p) => p.role === 'sender');
      if (sender) {
        senderId = sender.id;
        ws.send(JSON.stringify({ type: 'request-offer', to: senderId }));
      }
    } else if (msg.type === 'peer-joined' && msg.role === 'sender') {
      senderId = msg.id;
      ws.send(JSON.stringify({ type: 'request-offer', to: senderId }));
    } else if (msg.type === 'offer' && msg.from) {
      senderId = msg.from;
      await pc.setRemoteDescription(msg.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'answer', to: senderId, sdp: answer }));
    } else if (msg.type === 'ice' && msg.from === senderId && msg.candidate) {
      try { await pc.addIceCandidate(msg.candidate); } catch (e) { console.warn(e); }
    } else if (msg.type === 'peer-left' && msg.id === senderId) {
      $('capture-stream').srcObject = null;
      senderId = null;
      try { pc.close(); } catch {}
      pc = new RTCPeerConnection(ICE);
      attachPcHandlers();
    }
  };
}

// =============================================================
// boot
// =============================================================
function init() {
  if (!navigator.mediaDevices || !window.RTCPeerConnection) {
    $('error-msg').textContent = 'This browser does not support WebRTC or camera access.';
    setScreen('error');
    return;
  }
  const role = params.get('role');
  const room = params.get('room');
  if (role === 'capture' && room) {
    runCapture(room).catch((e) => {
      console.error(e);
      $('error-msg').textContent = e.message;
      setScreen('error');
    });
    return;
  }
  if (joinCode && /^[A-Z0-9]{3,8}$/.test(joinCode.toUpperCase())) {
    runSender(joinCode.toUpperCase()).catch((e) => {
      console.error(e);
      $('error-msg').textContent = e.message;
      setScreen('error');
    });
  } else {
    // Optional ?room=X forces the viewer to use that room code (reconnect flow)
    const explicitRoom = room && /^[A-Z0-9]{3,8}$/i.test(room) ? room.toUpperCase() : null;
    runViewer(explicitRoom).catch((e) => {
      console.error(e);
      $('error-msg').textContent = e.message;
      setScreen('error');
    });
  }
}

$('err-retry').addEventListener('click', () => location.reload());

bootstrapElectron();

// brief loading screen for visual smoothness
setTimeout(init, 320);
