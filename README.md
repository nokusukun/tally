# Tally

> Phone camera → browser, on-air.

Tally turns a phone into a wireless camera for a desktop viewer. Open Tally on the desktop, scan the QR code with the phone's camera, and the phone's lens is live in the desktop window in under ten seconds. No accounts, no cloud, no install on the phone — the phone runs the sender as a PWA in the mobile browser.

The name is a reference to the broadcast **tally light** — the red LED on a camera that signals "on-air."

---

## What it does

- **Pairing** — the desktop viewer renders a QR code containing the sender URL. The phone scans it, opens the PWA, and joins the room.
- **Streaming** — phone → desktop over WebRTC, peer-to-peer. Video + audio, low latency, no media server.
- **OBS capture window** — `View → Toggle OBS Capture Window` opens a chromeless window of just the video, sized 16:9, ready for OBS Studio's *Window Capture* source.
- **Internet mode** — bundled `cloudflared` opens a one-tap public `*.trycloudflare.com` tunnel for streaming when the phone isn't on the same LAN.
- **Remote camera controls** — resolution, framerate, bitrate, audio on/off, front/back camera are all controllable from the desktop viewer.
- **Idle mode** — the phone screen goes black with a small REC indicator and stays awake via the Screen Wake Lock API.

## Install

Download the latest installer for your platform from the [Releases page](https://github.com/nokusukun/tally/releases).

- **Windows** — `Tally-Setup-x.y.z.exe` (NSIS installer)
- **macOS** — `Tally-x.y.z-arm64.dmg` (Apple Silicon) or `Tally-x.y.z.dmg` (Intel)

> The macOS build is unsigned. On first launch, right-click the app → **Open** to bypass Gatekeeper, or run `xattr -dr com.apple.quarantine /Applications/Tally.app`.
>
> The Windows installer is unsigned too; SmartScreen will warn on first run.

## Usage

1. Launch Tally on the desktop. The viewer window opens with a pair code and QR.
2. Scan the QR with your phone's camera. The phone browser opens the sender PWA.
3. Tap **GO LIVE** on the phone. The viewer crossfades to the live feed.

For internet use (phone not on the same Wi-Fi), click the tunnel toggle in the viewer — the QR re-encodes to a public Cloudflare URL.

To pipe into OBS: `View → Toggle OBS Capture Window` (or **Ctrl/Cmd + Shift + C**), then in OBS add a *Window Capture* source pointing at "Tally Capture".

## Run from source

Requires Node 20+.

```bash
git clone https://github.com/nokusukun/tally
cd tally
npm install
npm run icons      # generates PWA + build icons from public/icon.svg
npm start          # launches the Electron app
```

Standalone server (no Electron, for testing on a server):

```bash
npm run server     # https://localhost:3000
```

## Build installers locally

```bash
npm run dist:win   # Windows NSIS installer (run on Windows)
npm run dist:mac   # macOS DMG (run on macOS — code signing requires Apple Developer setup)
npm run dist       # current platform
```

Output lands in `release/`.

## Architecture

```
┌─────────────────────┐     WebRTC      ┌──────────────────────┐
│  Phone (PWA)        │  ◀────────────▶ │  Desktop (Electron)  │
│  getUserMedia       │                 │  signaling server    │
│  sends camera/audio │   WSS signaling │  viewer + capture    │
└─────────────────────┘  ◀────────────▶ │  cloudflared tunnel  │
                                        └──────────────────────┘
```

- Electron main process embeds an Express + `ws` signaling server on `https://localhost:3000` with a self-signed cert (auto-generated, stored under `app.getPath('userData')/certs`).
- Renderer loads `https://localhost:3000/` and the same page serves as sender or viewer based on URL (`?join=CODE` → sender, otherwise → viewer).
- Signaling is multi-peer: each WebSocket gets a peer ID, messages route by `to:` field, sender keeps a `Map<viewerId, RTCPeerConnection>` so the OBS capture window and main viewer share one camera stream.
- WebRTC uses Google STUN; no TURN configured (LAN + Cloudflare tunnel covers the current use case).

## Project layout

```
electron/      Electron main + preload
lib/           server.js — embeddable signaling server
public/        Static assets served by Express (PWA shell, manifest, icons)
scripts/       build-icons.js
server.js      CLI entry to run the signaling server standalone
```

## License

[MIT](LICENSE)
