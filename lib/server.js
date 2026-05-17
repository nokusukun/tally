// Tally signaling server, embeddable in Electron or run standalone.
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const express = require('express');
const { WebSocketServer } = require('ws');
const selfsigned = require('selfsigned');
const QRCode = require('qrcode');

function getLanIps() {
  const ips = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

function loadOrCreateCert(certDir) {
  if (!fs.existsSync(certDir)) fs.mkdirSync(certDir, { recursive: true });
  const keyFile = path.join(certDir, 'key.pem');
  const certFile = path.join(certDir, 'cert.pem');
  if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
    const altNames = [
      { type: 2, value: 'localhost' },
      { type: 7, ip: '127.0.0.1' },
      ...getLanIps().map((ip) => ({ type: 7, ip })),
    ];
    const pems = selfsigned.generate(
      [{ name: 'commonName', value: 'tally.local' }],
      {
        days: 365,
        keySize: 2048,
        algorithm: 'sha256',
        extensions: [{ name: 'subjectAltName', altNames }],
      }
    );
    fs.writeFileSync(keyFile, pems.private);
    fs.writeFileSync(certFile, pems.cert);
  }
  return {
    key: fs.readFileSync(keyFile),
    cert: fs.readFileSync(certFile),
  };
}

/**
 * Start the signaling server.
 * @param {object} opts
 * @param {number} [opts.port=3000]
 * @param {boolean} [opts.useHttps=true]
 * @param {string} [opts.publicDir]  Path to static assets.
 * @param {string} [opts.certDir]    Path where the self-signed cert is stored.
 * @returns {Promise<{server, port, lanIps, close}>}
 */
async function startServer(opts = {}) {
  const useHttps = opts.useHttps !== false;
  const publicDir = opts.publicDir || path.join(__dirname, '..', 'public');
  const certDir = opts.certDir || path.join(__dirname, '..', 'certs');
  const allowPortRetry = opts.allowPortRetry !== false;
  const port = await tryListen(opts.port || 3000, useHttps, publicDir, certDir, allowPortRetry);

  return port;
}

async function tryListen(startPort, useHttps, publicDir, certDir, allowPortRetry) {
  const app = express();
  app.disable('x-powered-by');

  // rooms map declared early so the /api/room route can read it
  const rooms = new Map();
  let nextPeerId = 1;

  app.get('/api/info', (_req, res) => {
    res.json({ lanIps: getLanIps(), port: startPort });
  });

  app.get('/api/room/:room', (req, res) => {
    const room = req.params.room;
    const peers = rooms.get(room);
    if (!peers || peers.size === 0) return res.json({ exists: false });
    const roles = Array.from(peers).map((p) => p.role);
    res.json({
      exists: true,
      count: peers.size,
      hasSender: roles.includes('sender'),
      hasViewer: roles.includes('viewer'),
      hasCapture: roles.includes('capture'),
    });
  });

  app.get('/qr', async (req, res) => {
    const data = String(req.query.data || '');
    if (!data || data.length > 1024) {
      res.status(400).send('bad data');
      return;
    }
    try {
      const svg = await QRCode.toString(data, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 0,
        color: {
          dark: req.query.dark || '#1a1612',
          light: '#00000000',
        },
      });
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'no-store');
      res.send(svg);
    } catch (e) {
      res.status(500).send('qr error: ' + e.message);
    }
  });

  app.use(express.static(publicDir, {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));

  const server = useHttps
    ? https.createServer(loadOrCreateCert(certDir), app)
    : http.createServer(app);

  const wss = new WebSocketServer({ server, path: '/ws' });

  function broadcast(room, payload, except) {
    const peers = rooms.get(room);
    if (!peers) return;
    const data = JSON.stringify(payload);
    for (const peer of peers) {
      if (peer !== except && peer.readyState === 1) peer.send(data);
    }
  }

  function findPeer(peers, id) {
    for (const p of peers) if (p.id === id) return p;
    return null;
  }

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    const room = url.searchParams.get('room') || 'main';
    const role = url.searchParams.get('role') || 'unknown';
    ws.room = room;
    ws.role = role;
    ws.id = `p${nextPeerId++}`;

    if (!rooms.has(room)) rooms.set(room, new Set());
    const peers = rooms.get(room);
    peers.add(ws);

    // Tell the new peer its ID + everyone else already in the room
    ws.send(JSON.stringify({
      type: 'welcome',
      id: ws.id,
      peers: Array.from(peers)
        .filter((p) => p !== ws)
        .map((p) => ({ id: p.id, role: p.role })),
    }));

    // Tell others someone new joined
    broadcast(room, { type: 'peer-joined', id: ws.id, role: ws.role }, ws);

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      msg.from = ws.id;
      if (msg.to) {
        const target = findPeer(peers, msg.to);
        if (target && target.readyState === 1) target.send(JSON.stringify(msg));
      } else {
        broadcast(room, msg, ws);
      }
    });

    ws.on('close', () => {
      peers.delete(ws);
      if (peers.size === 0) rooms.delete(room);
      else broadcast(room, { type: 'peer-left', id: ws.id, role: ws.role }, ws);
    });
  });

  return await new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && allowPortRetry && startPort < 3100) {
        server.close();
        resolve(tryListen(startPort + 1, useHttps, publicDir, certDir, allowPortRetry));
      } else {
        reject(err);
      }
    };
    server.once('error', onError);
    server.listen(startPort, '0.0.0.0', () => {
      server.removeListener('error', onError);
      resolve({
        server,
        port: startPort,
        lanIps: getLanIps(),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { startServer, getLanIps };
