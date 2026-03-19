const urlInput = document.getElementById('urlInput');
const countrySelect = document.getElementById('countrySelect');
const openBtn = document.getElementById('openBtn');
const statusText = document.getElementById('statusText');
const countryLabel = document.getElementById('countryLabel');
const viewerVideo = document.getElementById('viewerVideo');

const socket = io();
let currentSessionId = null;
let serverViewport = { width: 1280, height: 720 };
let peerConnection = null;
let remoteStream = null;
let pendingIceCandidates = [];

function setStatus(message) {
  statusText.textContent = message;
}

function closePeerConnection() {
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
    peerConnection = null;
  }

  if (remoteStream) {
    remoteStream.getTracks().forEach((track) => track.stop());
    remoteStream = null;
  }

  viewerVideo.srcObject = null;
  pendingIceCandidates = [];
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

function viewerToRemotePoint(clientX, clientY) {
  const rect = viewerVideo.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width) * serverViewport.width;
  const y = ((clientY - rect.top) / rect.height) * serverViewport.height;

  return {
    x: Math.max(0, Math.min(serverViewport.width, x)),
    y: Math.max(0, Math.min(serverViewport.height, y))
  };
}

function emitMouseEvent(action, event, extras = {}) {
  if (!currentSessionId) return;
  const point = viewerToRemotePoint(event.clientX, event.clientY);
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

async function setupWebRtc(sessionId) {
  closePeerConnection();
  setStatus('Starting WebRTC stream...');

  const connection = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' }
    ]
  });

  peerConnection = connection;
  connection.addTransceiver('video', { direction: 'recvonly' });

  connection.ontrack = (event) => {
    remoteStream = event.streams[0] || new MediaStream([event.track]);
    viewerVideo.srcObject = remoteStream;
    setStatus('Live WebRTC stream connected. Interact in the player.');
  };

  connection.onicecandidate = (event) => {
    if (!event.candidate) return;

    socket.emit('webrtc-signal', {
      sessionId,
      targetRole: 'publisher',
      signal: {
        type: 'ice-candidate',
        candidate: event.candidate
      }
    });
  };

  connection.onconnectionstatechange = () => {
    if (connection.connectionState === 'failed') {
      setStatus('WebRTC connection failed.');
    }

    if (connection.connectionState === 'disconnected') {
      setStatus('WebRTC connection disconnected.');
    }
  };

  socket.emit('register-viewer', { sessionId });

  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);

  socket.emit('webrtc-signal', {
    sessionId,
    targetRole: 'publisher',
    signal: {
      type: 'offer',
      description: connection.localDescription
    }
  });
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
    closePeerConnection();

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
    setStatus('Connecting session...');

    socket.emit('join-session', { sessionId: currentSessionId });
    await setupWebRtc(currentSessionId);
    viewerVideo.focus();
  } catch (error) {
    setStatus(error.message);
  } finally {
    openBtn.disabled = false;
  }
});

socket.on('session-joined', ({ countryLabel: label, viewport }) => {
  serverViewport = viewport;
  countryLabel.textContent = `Browsing from: ${label}`;
  setStatus('Browser session ready. Waiting for WebRTC video...');
});

socket.on('session-error', ({ error }) => {
  setStatus(error || 'Session error');
});

socket.on('webrtc-signal', async ({ sessionId, signal }) => {
  if (sessionId !== currentSessionId || !peerConnection || !signal) return;

  try {
    if (signal.type === 'answer' && signal.description) {
      await peerConnection.setRemoteDescription(signal.description);
      while (pendingIceCandidates.length > 0) {
        const candidate = pendingIceCandidates.shift();
        await peerConnection.addIceCandidate(candidate);
      }
    }

    if (signal.type === 'ice-candidate' && signal.candidate) {
      if (peerConnection.remoteDescription) {
        await peerConnection.addIceCandidate(signal.candidate);
      } else {
        pendingIceCandidates.push(signal.candidate);
      }
    }
  } catch (error) {
    setStatus(error.message || 'Failed to process WebRTC signaling.');
  }
});

viewerVideo.addEventListener('mousemove', (event) => emitMouseEvent('mouseMoved', event));
viewerVideo.addEventListener('mousedown', (event) => {
  viewerVideo.focus();
  const button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left';
  emitMouseEvent('mousePressed', event, { button, clickCount: 1 });
});
viewerVideo.addEventListener('mouseup', (event) => {
  const button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left';
  emitMouseEvent('mouseReleased', event, { button, clickCount: 1 });
});
viewerVideo.addEventListener('wheel', (event) => {
  event.preventDefault();
  emitMouseEvent('mouseWheel', event, { deltaX: event.deltaX, deltaY: event.deltaY });
}, { passive: false });
viewerVideo.addEventListener('contextmenu', (event) => event.preventDefault());

viewerVideo.addEventListener('keydown', (event) => {
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

viewerVideo.addEventListener('keyup', (event) => {
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
  closePeerConnection();

  if (currentSessionId) {
    await fetch(`/api/session/${currentSessionId}`, { method: 'DELETE' });
  }
});

loadCountries().catch((error) => {
  setStatus(error.message);
});
