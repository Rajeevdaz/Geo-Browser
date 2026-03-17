const urlInput = document.getElementById('urlInput');
const countrySelect = document.getElementById('countrySelect');
const openBtn = document.getElementById('openBtn');
const statusText = document.getElementById('statusText');
const countryLabel = document.getElementById('countryLabel');
const canvas = document.getElementById('viewerCanvas');
const ctx = canvas.getContext('2d');

const socket = io();
let currentSessionId = null;
let serverViewport = { width: 1280, height: 720 };

function setStatus(message) {
  statusText.textContent = message;
}

async function loadCountries() {
  const response = await fetch('/api/countries');
  const { countries, error } = await response.json();
  if (!response.ok) throw new Error(error || 'Failed to load countries');

  countries.forEach((country) => {
    const option = document.createElement('option');
    option.value = country.code;
    option.textContent = `${country.label} (${country.code})`;
    countrySelect.appendChild(option);
  });
}

function canvasToRemotePoint(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width) * serverViewport.width;
  const y = ((clientY - rect.top) / rect.height) * serverViewport.height;

  return {
    x: Math.max(0, Math.min(serverViewport.width, x)),
    y: Math.max(0, Math.min(serverViewport.height, y))
  };
}

function emitMouseEvent(action, event, extras = {}) {
  if (!currentSessionId) return;
  const point = canvasToRemotePoint(event.clientX, event.clientY);
  socket.emit('input-event', {
    sessionId: currentSessionId,
    event: {
      type: 'mouse',
      action,
      x: point.x,
      y: point.y,
      button: extras.button || 'none',
      clickCount: extras.clickCount || 0,
      deltaX: extras.deltaX || 0,
      deltaY: extras.deltaY || 0
    }
  });
}

function isPrintableKey(event) {
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

openBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  const countryCode = countrySelect.value;

  if (!url || !countryCode) {
    setStatus('Enter URL and select country.');
    return;
  }

  openBtn.disabled = true;
  setStatus('Launching browser session...');

  try {
    if (currentSessionId) {
      await fetch(`/api/session/${currentSessionId}`, { method: 'DELETE' });
    }

    const response = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, countryCode })
    });

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Failed to create session.');
    }

    currentSessionId = payload.sessionId;
    serverViewport = payload.viewport;
    countryLabel.textContent = `Browsing from: ${payload.countryLabel}`;
    setStatus('Connecting stream...');

    socket.emit('join-session', { sessionId: currentSessionId });
    canvas.focus();
  } catch (error) {
    setStatus(error.message);
  } finally {
    openBtn.disabled = false;
  }
});

socket.on('session-joined', ({ countryLabel: label, viewport }) => {
  serverViewport = viewport;
  countryLabel.textContent = `Browsing from: ${label}`;
  setStatus('Live session connected. Interact on canvas.');
});

socket.on('session-error', ({ error }) => {
  setStatus(error || 'Session error');
});

socket.on('frame', ({ data, viewport }) => {
  serverViewport = viewport;
  const img = new Image();
  img.onload = () => {
    canvas.width = serverViewport.width;
    canvas.height = serverViewport.height;
    ctx.drawImage(img, 0, 0, serverViewport.width, serverViewport.height);
  };
  img.src = `data:image/jpeg;base64,${data}`;
});

canvas.addEventListener('mousemove', (event) => emitMouseEvent('mouseMoved', event));
canvas.addEventListener('mousedown', (event) => {
  canvas.focus();
  const button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left';
  emitMouseEvent('mousePressed', event, { button, clickCount: 1 });
});
canvas.addEventListener('mouseup', (event) => {
  const button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left';
  emitMouseEvent('mouseReleased', event, { button, clickCount: 1 });
});
canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  emitMouseEvent('mouseWheel', event, { deltaX: event.deltaX, deltaY: event.deltaY });
}, { passive: false });
canvas.addEventListener('contextmenu', (event) => event.preventDefault());

canvas.addEventListener('keydown', (event) => {
  if (!currentSessionId) return;
  event.preventDefault();

  socket.emit('input-event', {
    sessionId: currentSessionId,
    event: {
      type: 'keyboard',
      action: 'keyDown',
      key: event.key,
      code: event.code,
      text: isPrintableKey(event) ? event.key : '',
      keyCode: event.keyCode
    }
  });
});

canvas.addEventListener('keyup', (event) => {
  if (!currentSessionId) return;
  event.preventDefault();

  socket.emit('input-event', {
    sessionId: currentSessionId,
    event: {
      type: 'keyboard',
      action: 'keyUp',
      key: event.key,
      code: event.code,
      text: '',
      keyCode: event.keyCode
    }
  });
});

window.addEventListener('beforeunload', async () => {
  if (currentSessionId) {
    await fetch(`/api/session/${currentSessionId}`, { method: 'DELETE' });
  }
});

loadCountries().catch((error) => {
  setStatus(error.message);
});
