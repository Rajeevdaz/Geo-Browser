const params = new URLSearchParams(window.location.search);
const sessionId = params.get('sessionId');

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

  capturedStream = canvas.captureStream(30);
  capturedStream.getTracks().forEach((track) => {
    peerConnection.addTrack(track, capturedStream);
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

window.receiveFrame = async ({ data, viewport }) => new Promise((resolve, reject) => {
  const image = new Image();

  image.onload = () => {
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    ctx.drawImage(image, 0, 0, viewport.width, viewport.height);
    resolve();
  };

  image.onerror = reject;
  image.src = `data:image/jpeg;base64,${data}`;
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
