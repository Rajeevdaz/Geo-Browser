# Global Website Viewer (MVP)

A minimal full-stack web app to open live browser sessions through country-specific proxies.

## Project structure

```text
.
├── public/
│   ├── app.js                  # Frontend logic + WebRTC viewer + interaction forwarding
│   ├── index.html              # UI (URL input, country dropdown, viewer video)
│   └── styles.css              # Basic styling
│   ├── webrtc-publisher.html   # Hidden publisher page loaded in a local Chromium instance
│   └── webrtc-publisher.js     # WebRTC publisher that turns frames into a video track
├── proxy.config.example.json   # Example country -> proxy mapping
├── proxy.config.json           # Active proxy mapping used by backend
├── server.js                   # Express API + Playwright launch + WebRTC signaling/media bridge
├── package.json
└── README.md
```

## How it works

### Proxy routing

1. Frontend sends `url` + `countryCode` to `POST /api/session`.
2. Backend reads `proxy.config.json`.
3. Selected country resolves to proxy config.
4. Playwright Chromium launches with that proxy (`server`, `username`, `password`).

The backend supports 3 proxy formats per country:

- **DataImpulse template mode** (recommended for your credential style)
- **Playwright object mode** (`server`, `username`, `password`)
- **Single `proxyUrl` mode** (`http://username:password@host:port`)

### DataImpulse template mode (your format)

If your credential looks like:

`c0f8...__cr.us:fe0...@gw.dataimpulse.com:823`

configure this in JSON:

```json
{
  "US": {
    "label": "United States",
    "proxy": {
      "provider": "dataimpulse",
      "host": "gw.dataimpulse.com",
      "port": 823,
      "login": "c0f8d21aaafd0c83fc66",
      "password": "fe0ca78877485269",
      "countryProxyCode": "us"
    }
  }
}
```

The server automatically builds username as:

`<login>__cr.<countryProxyCode>`

Examples:

- India: `in`
- US: `us`
- UK: `gb`
- UAE: `ae`

### Browser streaming and interactivity

The backend creates two Chromium instances per session:

1. **Target browser**: opens the requested site through the selected country proxy.
2. **Publisher browser**: opens a local `webrtc-publisher.html` page with a canvas-backed WebRTC sender.

The media flow is:

- `Page.startScreencast` captures frames from the target browser page.
- The Node backend forwards the latest frame to the hidden publisher page.
- The publisher page draws frames to a canvas and exposes `canvas.captureStream(30)` as a WebRTC video track.
- The frontend receives that WebRTC track in a `<video>` element.
- Mouse and keyboard events on the video element are still sent back through Socket.IO and executed with Playwright’s native input APIs.

Result: users still interact with a real remote browser, but the visual path now uses WebRTC instead of directly repainting JPEG frames in the user-facing page.

### Visual quality tuning

The default configuration now favors sharper output:

- `SCREENCAST_FORMAT=png` for lossless CDP frames before they enter the WebRTC publisher
- `PUBLISHER_FPS=30` for the canvas capture stream
- `WEBRTC_MAX_BITRATE=8000000` to give the outbound video track more room for text-heavy pages

If you need to trade image quality against CPU/network usage, you can override:

```bash
SCREENCAST_FORMAT=jpeg SCREENCAST_QUALITY=90 WEBRTC_MAX_BITRATE=6000000 npm start
```

## Run locally

1. Install dependencies:

   ```bash
   npm install
   npx playwright install chromium
   ```

2. Configure proxies:

   - Edit `proxy.config.json` with your credentials.
   - Or copy from example:

   ```bash
   cp proxy.config.example.json proxy.config.json
   ```

3. Start server:

   ```bash
   npm start
   ```

4. Open app:

   - `http://localhost:3000`

## How to add/change proxies

Open `proxy.config.json`, then add/edit country entries.

You can use either:

1. `provider: "dataimpulse"` template
2. direct Playwright proxy object
3. `proxyUrl`

`GET /api/countries` auto-populates the frontend dropdown using top-level country keys.

## Notes / MVP scope

- Session closes after inactivity.
- Basic error handling included for invalid URL, missing country, proxy/session issues, and WebRTC signaling failures.
- For production: add auth, rate limiting, secure secrets management, and stricter isolation.
