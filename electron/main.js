// Electron main process — boots the signaling server, hosts the renderer window,
// and brokers cloudflared tunnel control via IPC.

const { app, BrowserWindow, Menu, ipcMain, shell, nativeTheme } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

const { startServer, getLanIps } = require('../lib/server');

let mainWindow = null;
let captureWindow = null;
let captureRoom = null;
let serverInfo = null;
let tunnelProcess = null;
let tunnelUrl = null;

const isMac = process.platform === 'darwin';
const isDev = !app.isPackaged;

const ICON_PATH = path.join(__dirname, '..', 'public', 'icons', 'icon-512.png');
app.setName('Tally');

// Only one instance allowed — keeps port 3000 stable so renderer localStorage
// (per-origin) persists across restarts, which is what the reconnect flow relies on.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  console.error('Another Tally instance is already running. Focusing it instead.');
  console.error('If no window is visible, run: taskkill /F /IM electron.exe  (then relaunch).');
  app.quit();
  return;
}
app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

// Self-signed cert: trust localhost only.
app.commandLine.appendSwitch('ignore-certificate-errors-spki-list');
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
      event.preventDefault();
      callback(true);
      return;
    }
  } catch {}
  callback(false);
});

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0e0d0a',
    show: false,
    autoHideMenuBar: true,
    icon: ICON_PATH,
    frame: isMac ? true : false,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: isMac ? { x: 14, y: 14 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Open <a target="_blank"> links externally instead of in the renderer.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Notify renderer when fullscreen / maximize state changes.
  const emitState = () => {
    if (!mainWindow) return;
    mainWindow.webContents.send('window:state', {
      maximized: mainWindow.isMaximized(),
      fullscreen: mainWindow.isFullScreen(),
    });
  };
  mainWindow.on('maximize', emitState);
  mainWindow.on('unmaximize', emitState);
  mainWindow.on('enter-full-screen', emitState);
  mainWindow.on('leave-full-screen', emitState);

  await mainWindow.loadURL(`https://localhost:${serverInfo.port}/`);
}

function buildMenu() {
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New session',
          accelerator: 'CmdOrCtrl+N',
          click: () => { if (mainWindow) mainWindow.webContents.loadURL(`https://localhost:${serverInfo.port}/`); },
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        {
          label: 'Toggle OBS Capture Window',
          accelerator: 'CmdOrCtrl+Shift+C',
          click: async () => {
            if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close();
            else await openCaptureWindow();
          },
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        ...(isMac ? [{ role: 'zoom' }] : [{ role: 'close' }]),
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Project page',
          click: () => shell.openExternal('https://github.com'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- IPC ----------
ipcMain.handle('webstream:info', () => ({
  port: serverInfo.port,
  lanIps: serverInfo.lanIps,
  platform: process.platform,
  tunnelUrl,
}));

ipcMain.on('window:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('window:toggle-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow && mainWindow.close());

ipcMain.handle('tunnel:start', async () => {
  if (tunnelProcess) return { url: tunnelUrl };
  return await startTunnel();
});
ipcMain.handle('tunnel:stop', async () => {
  await stopTunnel();
  return { url: null };
});

ipcMain.on('capture:set-room', (_evt, room) => { captureRoom = room || null; });
ipcMain.handle('capture:toggle', async () => {
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.close();
    return { open: false };
  }
  await openCaptureWindow();
  return { open: !!captureWindow };
});

async function openCaptureWindow() {
  if (!captureRoom) {
    if (mainWindow) mainWindow.webContents.send('capture:state', { open: false, error: 'no-room' });
    return;
  }
  if (captureWindow && !captureWindow.isDestroyed()) {
    captureWindow.focus();
    return;
  }
  captureWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: '#000000',
    frame: false,
    titleBarStyle: 'hidden',
    show: false,
    title: 'Tally Capture',
    icon: ICON_PATH,
    useContentSize: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  captureWindow.setAspectRatio(16 / 9);
  captureWindow.setMenu(null);
  captureWindow.once('ready-to-show', () => captureWindow.show());
  captureWindow.on('closed', () => {
    captureWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('capture:state', { open: false });
    }
  });
  await captureWindow.loadURL(
    `https://localhost:${serverInfo.port}/?role=capture&room=${encodeURIComponent(captureRoom)}`
  );
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('capture:state', { open: true });
  }
}

function resolveCloudflaredBin() {
  // The `cloudflared` npm package downloads the binary on install and
  // exposes its absolute path as `require('cloudflared').bin`.
  let bin;
  try { bin = require('cloudflared').bin; } catch {}
  if (!bin || typeof bin !== 'string') return 'cloudflared';

  // In a packaged Electron app, require() resolves inside app.asar — a
  // virtual filesystem that spawn() cannot execute from. asarUnpack puts
  // the real binary alongside, in app.asar.unpacked.
  if (bin.includes(`app.asar${path.sep}`) && !bin.includes('app.asar.unpacked')) {
    bin = bin.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  }
  return bin;
}

async function startTunnel() {
  if (tunnelProcess) return { url: tunnelUrl };
  const bin = resolveCloudflaredBin();
  const args = [
    'tunnel',
    '--no-autoupdate',
    '--no-tls-verify',
    '--url', `https://localhost:${serverInfo.port}`,
  ];
  return await new Promise((resolve, reject) => {
    let resolved = false;
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    tunnelProcess = proc;

    const urlRegex = /(https?:\/\/[a-z0-9-]+\.trycloudflare\.com)/i;

    const onData = (chunk) => {
      const s = chunk.toString();
      if (process.env.WEBSTREAM_DEBUG) process.stdout.write('[cloudflared] ' + s);
      const m = s.match(urlRegex);
      if (m && !resolved) {
        tunnelUrl = m[1];
        resolved = true;
        if (mainWindow) mainWindow.webContents.send('tunnel:state', { url: tunnelUrl, status: 'open' });
        resolve({ url: tunnelUrl });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('exit', (code) => {
      tunnelProcess = null;
      tunnelUrl = null;
      if (mainWindow) mainWindow.webContents.send('tunnel:state', { url: null, status: 'closed', code });
      if (!resolved) reject(new Error(`cloudflared exited (code ${code}) — is the binary installed?`));
    });
    proc.on('error', (err) => {
      tunnelProcess = null;
      tunnelUrl = null;
      if (!resolved) reject(err);
    });

    setTimeout(() => {
      if (!resolved) reject(new Error('Timed out waiting for tunnel URL (15s).'));
    }, 15000);
  });
}

async function stopTunnel() {
  if (!tunnelProcess) return;
  const proc = tunnelProcess;
  tunnelProcess = null;
  tunnelUrl = null;
  try { proc.kill('SIGINT'); } catch {}
  // give it a moment to clean up; force-kill if still around
  await new Promise((r) => setTimeout(r, 400));
  try { proc.kill('SIGKILL'); } catch {}
}

// ---------- lifecycle ----------
app.whenReady().then(async () => {
  try {
    serverInfo = await startServer({
      port: 3000,
      useHttps: true,
      allowPortRetry: false,
      publicDir: path.join(__dirname, '..', 'public'),
      certDir: path.join(app.getPath('userData'), 'certs'),
    });
  } catch (e) {
    console.error('Server failed to start:', e);
    app.quit();
    return;
  }
  buildMenu();
  await createWindow();
});

app.on('window-all-closed', async () => {
  await stopTunnel();
  if (!isMac) app.quit();
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) await createWindow();
});

app.on('before-quit', async (e) => {
  if (tunnelProcess) {
    e.preventDefault();
    await stopTunnel();
    app.exit(0);
  }
});
