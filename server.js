const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;
const VIEWPORT = { width: 1280, height: 720 };
const SESSION_TTL_MS = 2 * 60 * 1000;
const proxyConfigPath = path.join(__dirname, 'proxy.config.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();

function loadProxyConfig() {
  if (!fs.existsSync(proxyConfigPath)) {
    throw new Error('proxy.config.json is missing. Copy proxy.config.example.json and update credentials.');
  }

  return JSON.parse(fs.readFileSync(proxyConfigPath, 'utf8'));
}

function sanitizeUrl(value) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Only http/https URLs are supported.');
    }
    return parsed.toString();
  } catch (_error) {
    throw new Error('Invalid website URL.');
  }
}

function resolveProxy(proxyConfig, countryCode) {
  if (!proxyConfig || typeof proxyConfig !== 'object') {
    throw new Error('Proxy config entry must be an object.');
  }

  if (proxyConfig.proxyUrl) {
    const parsed = new URL(proxyConfig.proxyUrl);
    return {
      server: `${parsed.protocol}//${parsed.hostname}:${parsed.port}`,
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password)
    };
  }

  if (proxyConfig.provider === 'dataimpulse') {
    const { login, password, host, port, countryProxyCode } = proxyConfig;
    if (!login || !password || !host || !port || !countryProxyCode) {
      throw new Error(`Invalid dataimpulse proxy config for ${countryCode}`);
    }

    return {
      server: `http://${host}:${port}`,
      username: `${login}__cr.${countryProxyCode.toLowerCase()}`,
      password
    };
  }

  if (proxyConfig.server) {
    return {
      server: proxyConfig.server,
      username: proxyConfig.username,
      password: proxyConfig.password
    };
  }

  throw new Error(`Unsupported proxy format for country: ${countryCode}`);
}

function getCountryConfig(countryCode) {
  const config = loadProxyConfig();
  const country = config[countryCode];

  if (!country || !country.proxy) {
    throw new Error(`No proxy configured for country: ${countryCode}`);
  }

  const proxy = resolveProxy(country.proxy, countryCode);
  if (!proxy.server) {
    throw new Error(`No proxy server configured for country: ${countryCode}`);
  }

  return {
    label: country.label || countryCode,
    proxy
  };
}

function normalizeKeyForPlaywright(key) {
  if (!key) return key;

  const map = {
    ' ': 'Space',
    Escape: 'Escape',
    Esc: 'Escape',
    ArrowUp: 'ArrowUp',
    ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight',
    Enter: 'Enter',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown'
  };

  return map[key] || key;
}

async function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  clearTimeout(session.idleTimer);

  try {
    await session.cdp.send('Page.stopScreencast');
  } catch (_error) {
    // ignore cleanup errors
  }

  try {
    await session.browser.close();
  } catch (_error) {
    // ignore cleanup errors
  }

  sessions.delete(sessionId);
}

function resetIdleTimer(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    closeSession(sessionId);
  }, SESSION_TTL_MS);
}

app.get('/api/countries', (_req, res) => {
  try {
    const config = loadProxyConfig();
    const countries = Object.entries(config).map(([code, entry]) => ({
      code,
      label: entry.label || code
    }));

    res.json({ countries });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/session', async (req, res) => {
  const { url, countryCode } = req.body || {};

  try {
    const safeUrl = sanitizeUrl(url);
    const country = getCountryConfig(countryCode);

    const browser = await chromium.launch({
      headless: true,
      proxy: country.proxy,
      args: ['--disable-dev-shm-usage']
    });

    const context = await browser.newContext({
      viewport: VIEWPORT,
      locale: 'en-US'
    });

    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);

    await page.goto(safeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 70,
      maxWidth: VIEWPORT.width,
      maxHeight: VIEWPORT.height,
      everyNthFrame: 1
    });

    const sessionId = uuidv4();

    const session = {
      id: sessionId,
      browser,
      context,
      page,
      cdp,
      countryLabel: country.label,
      clients: new Set(),
      idleTimer: null
    };

    cdp.on('Page.screencastFrame', async (frame) => {
      io.to(sessionId).emit('frame', {
        data: frame.data,
        metadata: frame.metadata,
        viewport: VIEWPORT
      });

      try {
        await cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
      } catch (_error) {
        // If session is closing, ack may fail.
      }
    });

    sessions.set(sessionId, session);
    resetIdleTimer(sessionId);

    res.json({
      sessionId,
      countryLabel: country.label,
      viewport: VIEWPORT
    });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Failed to create session' });
  }
});

app.delete('/api/session/:id', async (req, res) => {
  const { id } = req.params;
  await closeSession(id);
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  socket.on('join-session', ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (!session) {
      socket.emit('session-error', { error: 'Session not found or expired.' });
      return;
    }

    socket.join(sessionId);
    session.clients.add(socket.id);
    resetIdleTimer(sessionId);

    socket.emit('session-joined', {
      sessionId,
      countryLabel: session.countryLabel,
      viewport: VIEWPORT
    });
  });

  socket.on('input-event', async ({ sessionId, event }) => {
    const session = sessions.get(sessionId);
    if (!session || !event) return;

    const { page } = session;
    resetIdleTimer(sessionId);

    try {
      if (event.type === 'mouse') {
        const x = Number.isFinite(event.x) ? event.x : 0;
        const y = Number.isFinite(event.y) ? event.y : 0;
        const button = event.button || 'left';

        if (event.action === 'mouseMoved') {
          await page.mouse.move(x, y);
        }

        if (event.action === 'mousePressed') {
          await page.mouse.move(x, y);
          await page.mouse.down({ button });
        }

        if (event.action === 'mouseReleased') {
          await page.mouse.move(x, y);
          await page.mouse.up({ button });
        }

        if (event.action === 'mouseWheel') {
          await page.mouse.move(x, y);
          await page.mouse.wheel(event.deltaX || 0, event.deltaY || 0);
        }
      }

      if (event.type === 'keyboard') {
        const key = normalizeKeyForPlaywright(event.key);

        if (event.action === 'keyDown') {
          if (event.text && event.text.length === 1) {
            await page.keyboard.insertText(event.text);
          } else {
            await page.keyboard.down(key);
          }
        }

        if (event.action === 'keyUp' && !(event.text && event.text.length === 1)) {
          await page.keyboard.up(key);
        }
      }
    } catch (_error) {
      // Input can fail transiently during page navigation.
    }
  });

  socket.on('disconnect', async () => {
    for (const [sessionId, session] of sessions.entries()) {
      if (session.clients.has(socket.id)) {
        session.clients.delete(socket.id);

        if (session.clients.size === 0) {
          setTimeout(async () => {
            const current = sessions.get(sessionId);
            if (current && current.clients.size === 0) {
              await closeSession(sessionId);
            }
          }, 15000);
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Global Website Viewer listening on http://localhost:${PORT}`);
});
