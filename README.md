# Global Website Viewer (MVP)

A minimal full-stack web app to open live browser sessions through country-specific proxies.

## Project structure

```text
.
├── public/
│   ├── app.js                  # Frontend logic + socket events + interaction forwarding
│   ├── index.html              # UI (URL input, country dropdown, viewer canvas)
│   └── styles.css              # Basic styling
├── proxy.config.example.json   # Example country -> proxy mapping
├── proxy.config.json           # Active proxy mapping used by backend
├── server.js                   # Express API + Playwright launch + live CDP frame/input bridge
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

The backend creates a Chromium page and opens a Chrome DevTools Protocol session:

- `Page.startScreencast` streams JPEG frames from the live page.
- Frames are emitted to frontend through Socket.IO.
- Frontend paints frames onto a `<canvas>`.
- Mouse and keyboard events on the canvas are sent back through Socket.IO.
- Backend forwards those events to Chrome CDP (`Input.dispatchMouseEvent` and `Input.dispatchKeyEvent`).

Result: users can click, type, and scroll in a real remote browser session.

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
- Basic error handling included for invalid URL, missing country, and proxy/session issues.
- For production: add auth, rate limiting, secure secrets management, and stricter isolation.
