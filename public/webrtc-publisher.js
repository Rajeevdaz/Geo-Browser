const params = new URLSearchParams(window.location.search);
const sessionId = params.get('sessionId');
const targetFps = Math.max(1, Number(params.get('fps') || 30));
const maxBitrate = Math.max(250000, Number(params.get('maxBitrate') || 8000000));

const socket = io();
const canvas = document.getElementById('frameCanvas');
const ctx = canvas.getContext('2d');

let peerConnection = null;
let capturedStream = null;
let pendingIceCandidates = [];

function getPeerConnection() {
  if (peerConnection) {
    return peerConnection;
  }

  peerConnection = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' }
    ]
  });

  capturedStream = canvas.captureStream(targetFps);
  capturedStream.getTracks().forEach((track) => {
    track.contentHint = 'detail';
    const sender = peerConnection.addTrack(track, capturedStream);
    const parameters = sender.getParameters();
    parameters.encodings = parameters.encodings || [{}];
    parameters.encodings[0].maxBitrate = maxBitrate;
    parameters.encodings[0].maxFramerate = targetFps;
    parameters.encodings[0].scaleResolutionDownBy = 1;

    sender.setParameters(parameters).catch(() => {
      // Browsers may reject some sender parameter changes; keep the stream alive with defaults.
    });
  });

  peerConnection.onicecandidate = (event) => {
    if (!event.candidate) return;

    socket.emit('webrtc-signal', {
      sessionId,
      targetRole: 'viewer',
      signal: {
        type: 'ice-candidate',
        candidate: event.candidate
      }
    });
  };

  return peerConnection;
}

window.receiveFrame = async ({ data, viewport, format }) => new Promise((resolve, reject) => {
  const image = new Image();

  image.onload = () => {
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, viewport.width, viewport.height);
    resolve();
  };

  image.onerror = reject;
  image.src = `data:image/${format || 'png'};base64,${data}`;
});

socket.on('connect', () => {
  socket.emit('register-publisher', { sessionId });
});

socket.on('webrtc-signal', async ({ sessionId: signalSessionId, signal }) => {
  if (signalSessionId !== sessionId || !signal) return;

  const connection = getPeerConnection();

  try {
    if (signal.type === 'offer' && signal.description) {
      await connection.setRemoteDescription(signal.description);
      while (pendingIceCandidates.length > 0) {
        const candidate = pendingIceCandidates.shift();
        await connection.addIceCandidate(candidate);
      }
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);

      socket.emit('webrtc-signal', {
        sessionId,
        targetRole: 'viewer',
        signal: {
          type: 'answer',
          description: connection.localDescription
        }
      });
    }

    if (signal.type === 'ice-candidate' && signal.candidate) {
      if (connection.remoteDescription) {
        await connection.addIceCandidate(signal.candidate);
      } else {
        pendingIceCandidates.push(signal.candidate);
      }
    }
  } catch (_error) {
    // Ignore transient signaling problems; the viewer can renegotiate on refresh.
  }
});
