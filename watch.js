// ===== Configuration =====
const isFileLike = location.protocol === 'capacitor:' || location.protocol === 'file:';
const TOKEN_API_BASE = isFileLike
  ? 'https://peer-app-git-main-amirndrs-projects.vercel.app/api'
  : '/api';

const APP_ID = "6774bd10adcd4974ae9d320147124bc5";
const ROOM_PASSWORD = null;

// ===== URL params =====
const params = new URLSearchParams(window.location.search);
const roomId = (params.get("room") || "").trim();
const providedName = (params.get("name") || "").trim();
if (!roomId) window.location = "lobby.html";
const channelName = `watch_${roomId}`;

// ===== User info =====
function makeGuestId(){ return `Guest-${Math.random().toString(36).slice(2, 6)}`; }
const displayName = providedName || makeGuestId();

// ===== DOM refs =====
const videoUrlInput = document.getElementById('video-url');
const loadVideoBtn = document.getElementById('load-video');
const videoPlaceholder = document.getElementById('video-placeholder');
const videoWrapper = document.getElementById('video-wrapper');
const videoPlayer = document.getElementById('video-player');
const videoTitle = document.getElementById('video-title');
const playPauseBtn = document.getElementById('play-pause');
const syncBtn = document.getElementById('sync-video');
const participantsList = document.getElementById('participants-list');
const chatMessages = document.getElementById('chat-messages');
const messageInput = document.getElementById('message-input');
const sendMessageBtn = document.getElementById('send-message');
const watchMicBtn = document.getElementById('watch-mic');
const watchLeaveBtn = document.getElementById('watch-leave');

// ===== State =====
let client;
let localTracks = { audio: null };
const remoteUsers = new Map();
let currentVideoUrl = '';
let isHost = false;
let videoState = {
  playing: false,
  currentTime: 0,
  url: '',
  title: 'No video loaded'
};

// ===== Video URL parsing =====
function extractVideoId(url) {
  // YouTube
  const ytMatch = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
  if (ytMatch) return { type: 'youtube', id: ytMatch[1] };
  
  // Vimeo
  const vimeoMatch = url.match(/vimeo\.com\/(?:channels\/(?:\w+\/)?|groups\/([^\/]*)\/videos\/|)(\d+)(?:|\/\?)/);
  if (vimeoMatch) return { type: 'vimeo', id: vimeoMatch[2] };
  
  return { type: 'unknown', id: null };
}

function createEmbedUrl(videoInfo) {
  if (videoInfo.type === 'youtube') {
    return `https://www.youtube.com/embed/${videoInfo.id}?enablejsapi=1&origin=${window.location.origin}`;
  } else if (videoInfo.type === 'vimeo') {
    return `https://player.vimeo.com/video/${videoInfo.id}`;
  }
  return null;
}

// ===== Video controls =====
function loadVideo(url) {
  const videoInfo = extractVideoId(url);
  const embedUrl = createEmbedUrl(videoInfo);
  
  if (!embedUrl) {
    alert('Unsupported video URL. Please use YouTube or Vimeo links.');
    return;
  }
  
  currentVideoUrl = url;
  videoPlayer.src = embedUrl;
  videoPlaceholder.hidden = true;
  videoWrapper.hidden = false;
  
  // Set video title
  if (videoInfo.type === 'youtube') {
    videoTitle.textContent = `YouTube Video (${videoInfo.id})`;
  } else if (videoInfo.type === 'vimeo') {
    videoTitle.textContent = `Vimeo Video (${videoInfo.id})`;
  }
  
  // Update video state
  videoState.url = url;
  videoState.title = videoTitle.textContent;
  
  // Broadcast to other participants if host
  if (isHost) {
    broadcastVideoState();
  }
}

function broadcastVideoState() {
  if (!client) return;
  
  try {
    client.sendStreamMessage({
      type: 'video-state',
      data: videoState
    });
  } catch (error) {
    console.error('Failed to broadcast video state:', error);
  }
}

function syncVideoWithHost() {
  if (isHost) return;
  
  try {
    client.sendStreamMessage({
      type: 'sync-request',
      data: { requester: displayName }
    });
  } catch (error) {
    console.error('Failed to send sync request:', error);
  }
}

// ===== UI Updates =====
function updateParticipantsList() {
  participantsList.innerHTML = '';
  
  // Add local participant
  const localParticipant = document.createElement('div');
  localParticipant.className = 'participant';
  localParticipant.innerHTML = `
    <div class="participant-avatar">${displayName.charAt(0).toUpperCase()}</div>
    <div class="participant-name">${displayName} (You)</div>
    <div class="participant-mic">${localTracks.audio ? '🎤' : '🔇'}</div>
  `;
  participantsList.appendChild(localParticipant);
  
  // Add remote participants
  remoteUsers.forEach((user, uid) => {
    const participant = document.createElement('div');
    participant.className = 'participant';
    participant.innerHTML = `
      <div class="participant-avatar">${String(uid).charAt(0).toUpperCase()}</div>
      <div class="participant-name">${user.displayName || uid}</div>
      <div class="participant-mic">${user.hasAudio ? '🎤' : '🔇'}</div>
    `;
    participantsList.appendChild(participant);
  });
}

function addChatMessage(sender, message, isOwn = false) {
  const messageEl = document.createElement('div');
  messageEl.className = `chat-message ${isOwn ? 'own' : ''}`;
  messageEl.innerHTML = `
    <div class="message-sender">${sender}</div>
    <div class="message-content">${message}</div>
  `;
  chatMessages.appendChild(messageEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ===== Agora RTC =====
async function fetchRtcToken({ channel }) {
  const res = await fetch(tokenUrl("token"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(ROOM_PASSWORD ? { "x-room-password": ROOM_PASSWORD } : {})
    },
    cache: "no-store",
    body: JSON.stringify({ type: "rtc", channel })
  });
  if (!res.ok) throw new Error(`Token HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.token || typeof data?.uid !== "number") throw new Error("Bad token payload");
  return data;
}

function tokenUrl(path){
  const base = TOKEN_API_BASE.replace(/\/$/, "");
  const p = String(path || "").replace(/^\//, "");
  return `${base}/${p}`;
}

let micOn = true;

async function toggleMic() {
  const track = localTracks.audio;
  if (!track) return;

  try {
    await track.setMuted(micOn);
    micOn = !micOn;
    updateMicUI();
  } catch (error) {
    console.error('Toggle mic failed:', error);
  }
}

function updateMicUI() {
  if (!watchMicBtn) return;
  
  watchMicBtn.setAttribute('aria-pressed', String(micOn));
  watchMicBtn.querySelector('.label').textContent = micOn ? 'Mute' : 'Unmute';
  watchMicBtn.querySelector('.emoji').textContent = micOn ? '🎤' : '🔇';
}

async function leave() {
  try {
    if (localTracks.audio) {
      localTracks.audio.stop();
      localTracks.audio.close();
    }
    if (client) {
      await client.unpublish();
      await client.leave();
    }
  } catch (error) {
    console.error('Leave error:', error);
  } finally {
    window.location = "lobby.html";
  }
}

// ===== Initialize =====
async function init() {
  if (window.__watchInit) return;
  window.__watchInit = true;
  
  try {
    // Create client
    client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
    
    // Fetch token and join
    const tokenData = await fetchRtcToken({ channel: channelName });
    await client.join(APP_ID, channelName, tokenData.token, tokenData.uid);
    
    // Determine if host (first user in room)
    isHost = client.remoteUsers.length === 0;
    
    // Create and publish audio track
    localTracks.audio = await AgoraRTC.createMicrophoneAudioTrack({
      AEC: true, ANS: true, AGC: true
    });
    await client.publish([localTracks.audio]);
    
    micOn = true;
    updateMicUI();
    updateParticipantsList();
    
    // Enable volume indicator for audio visualization
    if (client.enableAudioVolumeIndicator) {
      client.enableAudioVolumeIndicator();
    }
    
    // Set up event listeners
    setupEventListeners();
    
    // Show success message
    addChatMessage('System', `Joined room "${roomId}" as ${isHost ? 'host' : 'participant'}`, false);
    
  } catch (error) {
    console.error('Initialization failed:', error);
    alert('Failed to join room. Please try again.');
    window.location = "lobby.html";
  }
}

function setupEventListeners() {
  // Video controls
  loadVideoBtn.addEventListener('click', () => {
    const url = videoUrlInput.value.trim();
    if (url) {
      loadVideo(url);
    }
  });
  
  videoUrlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      loadVideoBtn.click();
    }
  });
  
  playPauseBtn.addEventListener('click', () => {
    // This would need YouTube/Video API integration for actual control
    // For now, just broadcast the intent
    if (isHost) {
      videoState.playing = !videoState.playing;
      broadcastVideoState();
    }
  });
  
  syncBtn.addEventListener('click', syncVideoWithHost);
  
  // Chat
  sendMessageBtn.addEventListener('click', sendMessage);
  messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      sendMessage();
    }
  });
  
  // Audio controls
  watchMicBtn.addEventListener('click', toggleMic);
  watchLeaveBtn.addEventListener('click', leave);
  
  // Agora events
  client.on("user-published", async (user, mediaType) => {
    await client.subscribe(user, mediaType);
    remoteUsers.set(user.uid, {
      ...user,
      displayName: `User ${user.uid}`,
      hasAudio: mediaType === 'audio'
    });
    
    if (mediaType === "audio") {
      user.audioTrack.play();
    }
    
    updateParticipantsList();
    addChatMessage('System', `User ${user.uid} joined the room`, false);
  });
  
  client.on("user-unpublished", (user, mediaType) => {
    if (mediaType === "audio") {
      const remoteUser = remoteUsers.get(user.uid);
      if (remoteUser) {
        remoteUser.hasAudio = false;
      }
    }
    updateParticipantsList();
  });
  
  client.on("user-left", (user) => {
    remoteUsers.delete(user.uid);
    updateParticipantsList();
    addChatMessage('System', `User ${user.uid} left the room`, false);
  });
  
  // Data channel messages
  client.on("stream-message", (uid, streamId, data) => {
    try {
      const message = typeof data === 'string' ? JSON.parse(data) : data;
      
      switch (message.type) {
        case 'video-state':
          if (!isHost) {
            videoState = message.data;
            if (videoState.url && videoState.url !== currentVideoUrl) {
              loadVideo(videoState.url);
            }
            videoTitle.textContent = videoState.title;
          }
          break;
          
        case 'chat-message':
          addChatMessage(message.sender, message.text, false);
          break;
          
        case 'sync-request':
          if (isHost) {
            broadcastVideoState();
            addChatMessage('System', `${message.data.requester} requested sync`, false);
          }
          break;
      }
    } catch (error) {
      console.error('Error processing stream message:', error);
    }
  });
}

function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || !client) return;
  
  try {
    client.sendStreamMessage({
      type: 'chat-message',
      data: {
        sender: displayName,
        text: text
      }
    });
    
    addChatMessage(displayName, text, true);
    messageInput.value = '';
  } catch (error) {
    console.error('Failed to send message:', error);
  }
}

// Start initialization
(async () => {
  try {
    await init();
  } catch (error) {
    console.error('Watch initialization failed:', error);
    window.location = "lobby.html";
  }
})();