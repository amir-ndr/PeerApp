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
let currentVideoInfo = null;
let isHost = false;
let micOn = true;
let dataStream = null;
let isInitialized = false;

// ===== Data Stream Utilities =====
async function waitForDataStream(maxWaitTime = 5000) {
  const startTime = Date.now();
  while (!dataStream && (Date.now() - startTime) < maxWaitTime) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!dataStream) {
    throw new Error('Data stream not available after waiting');
  }
  return dataStream;
}

function isDataStreamReady() {
  return dataStream && dataStream.sendData;
}

// ===== Video URL parsing =====
function extractVideoInfo(url) {
  console.log("Parsing URL:", url);
  
  // YouTube - handle multiple formats
  const ytRegexes = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&?\s]+)/,
    /youtube\.com\/embed\/([^&?\s]+)/,
    /youtube\.com\/v\/([^&?\s]+)/
  ];
  
  for (const regex of ytRegexes) {
    const match = url.match(regex);
    if (match && match[1]) {
      const videoId = match[1].split('?')[0].split('&')[0];
      return {
        type: 'youtube',
        id: videoId,
        embedUrl: `https://www.youtube.com/embed/${videoId}?autoplay=1&controls=1`
      };
    }
  }
  
  // Vimeo
  const vimeoMatch = url.match(/vimeo\.com\/(?:channels\/\w+\/)?(\d+)/);
  if (vimeoMatch) {
    return {
      type: 'vimeo',
      id: vimeoMatch[1],
      embedUrl: `https://player.vimeo.com/video/${vimeoMatch[1]}?autoplay=1&controls=1`
    };
  }
  
  console.log("URL not recognized as YouTube or Vimeo");
  return { type: 'unknown', id: null, embedUrl: null };
}

function createVideoEmbed(videoInfo) {
  console.log("Creating embed for:", videoInfo);
  
  if (videoInfo.type === 'youtube') {
    return `
      <iframe 
        width="100%" 
        height="100%" 
        src="${videoInfo.embedUrl}"
        frameborder="0" 
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
        allowfullscreen
        style="border: none;"
        id="video-iframe">
      </iframe>
    `;
  } else if (videoInfo.type === 'vimeo') {
    return `
      <iframe 
        width="100%" 
        height="100%" 
        src="${videoInfo.embedUrl}"
        frameborder="0" 
        allow="autoplay; fullscreen; picture-in-picture" 
        allowfullscreen
        style="border: none;"
        id="video-iframe">
      </iframe>
    `;
  }
  
  throw new Error('Unsupported video platform');
}

async function loadVideo(url) {
  console.log("Loading video:", url);
  
  // Show loading state
  loadVideoBtn.disabled = true;
  loadVideoBtn.textContent = 'Loading...';
  
  try {
    const videoInfo = extractVideoInfo(url);
    console.log("Video info:", videoInfo);
    
    if (!videoInfo.embedUrl) {
      alert('Please use a valid YouTube or Vimeo URL.\n\nExamples:\nYouTube: https://www.youtube.com/watch?v=VIDEO_ID\nVimeo: https://vimeo.com/VIDEO_ID');
      return;
    }
    
    currentVideoUrl = url;
    currentVideoInfo = videoInfo;
    
    // Create and insert the embed
    const embedHTML = createVideoEmbed(videoInfo);
    videoPlayer.innerHTML = embedHTML;
    
    // Show video, hide placeholder
    videoPlaceholder.hidden = true;
    videoWrapper.hidden = false;
    
    // Set video title
    let title = videoInfo.type === 'youtube' ? 'YouTube Video' : 'Vimeo Video';
    videoTitle.textContent = title;
    
    // Broadcast to other participants if host
    if (isHost) {
      await broadcastVideoState(url, title, videoInfo);
    }
    
    console.log("Video loaded successfully");
    
  } catch (error) {
    console.error('Error loading video:', error);
    addChatMessage('System', `Error loading video: ${error.message}`, false);
    alert('Error loading video. Please check the URL and try again.\n\nMake sure you are using a valid YouTube or Vimeo URL.');
  } finally {
    loadVideoBtn.disabled = false;
    loadVideoBtn.textContent = 'Load Video';
  }
}

async function broadcastVideoState(url, title, videoInfo, maxRetries = 3) {
  if (!isHost) return;
  
  try {
    await waitForDataStream();
    
    let retries = 0;
    const sendWithRetry = async () => {
      try {
        const message = {
          type: 'video-state',
          url: url,
          title: title,
          videoInfo: videoInfo,
          timestamp: Date.now(),
          sender: displayName
        };
        sendDataMessage(message);
        addChatMessage('System', `Host loaded a new ${videoInfo.type} video`, false);
        console.log('Video state broadcast successfully');
      } catch (error) {
        retries++;
        if (retries <= maxRetries) {
          console.warn(`Retrying video state broadcast (${retries}/${maxRetries})...`);
          await new Promise(resolve => setTimeout(resolve, 500 * retries));
          return sendWithRetry();
        } else {
          throw new Error(`Failed to broadcast video after ${maxRetries} attempts`);
        }
      }
    };
    
    await sendWithRetry();
  } catch (error) {
    console.error('Failed to broadcast video state:', error);
    addChatMessage('System', 'Warning: Could not sync video with all participants', false);
  }
}

// ===== Data Channel Messaging =====
function sendDataMessage(message) {
  if (!isDataStreamReady()) {
    console.warn('Data stream not available or not ready');
    return false;
  }
  
  try {
    const data = JSON.stringify(message);
    dataStream.sendData(data);
    console.log('Sent data message:', message.type);
    return true;
  } catch (error) {
    console.error('Failed to send data message:', error);
    return false;
  }
}

function handleDataMessage(message) {
  try {
    const data = JSON.parse(message);
    console.log('Received data message:', data.type);
    
    switch (data.type) {
      case 'video-state':
        if (!isHost) {
          handleRemoteVideoState(data);
        }
        break;
        
      case 'chat-message':
        addChatMessage(data.sender, data.text, false);
        break;
        
      case 'sync-request':
        if (isHost && currentVideoUrl) {
          handleSyncRequest(data);
        }
        break;
        
      case 'user-joined':
        updateParticipantsList();
        break;
    }
  } catch (error) {
    console.error('Error processing data message:', error);
  }
}

function handleSyncRequest(data) {
  // Re-broadcast current video state to the requester
  if (currentVideoUrl && currentVideoInfo) {
    const videoState = {
      type: 'video-state',
      url: currentVideoUrl,
      title: videoTitle.textContent,
      videoInfo: currentVideoInfo,
      timestamp: Date.now(),
      sender: displayName,
      isSyncResponse: true
    };
    sendDataMessage(videoState);
    addChatMessage('System', `${data.requester} requested video sync`, false);
  }
}

function handleRemoteVideoState(data) {
  console.log('Handling remote video state:', data);
  
  // Prevent infinite loop if this is our own message
  if (data.sender === displayName) return;
  
  if (data.url && data.url !== currentVideoUrl) {
    // Load the new video
    loadVideo(data.url);
  }
  
  // Update video metadata
  if (data.title) {
    videoTitle.textContent = data.title;
  }
  if (data.videoInfo) {
    currentVideoInfo = data.videoInfo;
  }
  
  if (data.isSyncResponse) {
    addChatMessage('System', 'Video synced with host', false);
  }
}

function syncVideoWithHost() {
  if (isHost) {
    addChatMessage('System', 'You are the host - others sync with you', true);
    return;
  }
  
  try {
    const message = {
      type: 'sync-request',
      requester: displayName,
      timestamp: Date.now()
    };
    
    if (sendDataMessage(message)) {
      addChatMessage('System', 'Requested video sync with host', true);
    } else {
      addChatMessage('System', 'Failed to send sync request - try again', true);
    }
  } catch (error) {
    console.error('Failed to send sync request:', error);
    addChatMessage('System', 'Error requesting sync', true);
  }
}

// ===== UI Updates =====
function updateParticipantsList() {
  if (!participantsList) return;
  
  participantsList.innerHTML = '';
  
  // Add local participant (You)
  const localParticipant = document.createElement('div');
  localParticipant.className = 'participant';
  localParticipant.innerHTML = `
    <div class="participant-avatar">${displayName.charAt(0).toUpperCase()}</div>
    <div class="participant-name">${displayName} (You) ${isHost ? '👑' : ''}</div>
    <div class="participant-mic">${localTracks.audio && micOn ? '🎤' : '🔇'}</div>
  `;
  participantsList.appendChild(localParticipant);
  
  // Add remote participants
  remoteUsers.forEach((user, uid) => {
    const participant = document.createElement('div');
    participant.className = 'participant';
    participant.innerHTML = `
      <div class="participant-avatar">${String(uid).charAt(0).toUpperCase()}</div>
      <div class="participant-name">${user.displayName || `User ${uid}`}</div>
      <div class="participant-mic">${user.hasAudio ? '🎤' : '🔇'}</div>
    `;
    participantsList.appendChild(participant);
  });
}

function addChatMessage(sender, message, isOwn = false) {
  if (!chatMessages) return;
  
  const messageEl = document.createElement('div');
  messageEl.className = `chat-message ${isOwn ? 'own' : ''}`;
  messageEl.innerHTML = `
    <div class="message-sender">${sender} ${isOwn ? '(You)' : ''}</div>
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

function tokenUrl(path) {
  const base = TOKEN_API_BASE.replace(/\/$/, "");
  const p = String(path || "").replace(/^\//, "");
  return `${base}/${p}`;
}

async function toggleMic() {
  if (!localTracks.audio) return;

  try {
    await localTracks.audio.setMuted(micOn);
    micOn = !micOn;
    updateMicUI();
    updateParticipantsList();
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
    // Notify others about leaving
    if (isDataStreamReady()) {
      const leaveMessage = {
        type: 'user-left',
        user: displayName,
        timestamp: Date.now()
      };
      sendDataMessage(leaveMessage);
    }
    
    if (localTracks.audio) {
      localTracks.audio.stop();
      localTracks.audio.close();
    }
    if (dataStream) {
      dataStream.close();
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

// ===== Event Handlers =====
function setupEventListeners() {
  console.log("Setting up event listeners...");
  
  // Video controls
  loadVideoBtn.addEventListener('click', () => {
    const url = videoUrlInput.value.trim();
    if (url) {
      loadVideo(url);
      videoUrlInput.value = '';
    } else {
      alert('Please enter a video URL');
    }
  });
  
  videoUrlInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      loadVideoBtn.click();
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
}

function setupAgoraEventListeners() {
  if (!client) return;
  
  // User events
  client.on("user-published", async (user, mediaType) => {
    console.log("User published:", user.uid, mediaType);
    await client.subscribe(user, mediaType);
    
    remoteUsers.set(user.uid, {
      ...user,
      displayName: `User ${user.uid}`,
      hasAudio: mediaType === 'audio'
    });
    
    if (mediaType === "audio") {
      try {
        user.audioTrack.play();
      } catch (error) {
        console.warn('Could not play remote audio:', error);
      }
    }
    
    updateParticipantsList();
    addChatMessage('System', `User ${user.uid} joined the room`, false);
    
    // If host, send current video state to new user
    if (isHost && currentVideoUrl && isInitialized) {
      setTimeout(async () => {
        try {
          await broadcastVideoState(currentVideoUrl, videoTitle.textContent, currentVideoInfo);
          console.log('Sent video state to new user:', user.uid);
        } catch (error) {
          console.error('Failed to send video state to new user:', error);
        }
      }, 1000);
    }
  });
  
  client.on("user-unpublished", (user, mediaType) => {
    console.log("User unpublished:", user.uid, mediaType);
    if (mediaType === "audio") {
      const remoteUser = remoteUsers.get(user.uid);
      if (remoteUser) {
        remoteUser.hasAudio = false;
      }
    }
    updateParticipantsList();
  });
  
  client.on("user-left", (user) => {
    console.log("User left:", user.uid);
    remoteUsers.delete(user.uid);
    updateParticipantsList();
    addChatMessage('System', `User ${user.uid} left the room`, false);
  });
  
  // Connection state monitoring
  client.on("connection-state-change", (curState, prevState) => {
    console.log('Connection state changed:', prevState, '->', curState);
    if (curState === 'DISCONNECTED') {
      addChatMessage('System', 'Connection lost. Attempting to reconnect...', false);
    } else if (curState === 'CONNECTED') {
      addChatMessage('System', 'Connection restored', false);
      // Resync video if host reconnects
      if (isHost && currentVideoUrl && isInitialized) {
        setTimeout(() => {
          broadcastVideoState(currentVideoUrl, videoTitle.textContent, currentVideoInfo);
        }, 1000);
      }
    } else if (curState === 'RECONNECTING') {
      addChatMessage('System', 'Reconnecting...', false);
    }
  });
}

function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || !isDataStreamReady()) return;
  
  try {
    const message = {
      type: 'chat-message',
      sender: displayName,
      text: text,
      timestamp: Date.now()
    };
    
    if (sendDataMessage(message)) {
      addChatMessage(displayName, text, true);
      messageInput.value = '';
    } else {
      addChatMessage('System', 'Failed to send message - try again', true);
    }
  } catch (error) {
    console.error('Failed to send message:', error);
    addChatMessage('System', 'Error sending message', true);
  }
}

// ===== Initialize =====
async function init() {
  if (window.__watchInit) return;
  window.__watchInit = true;
  
  try {
    console.log("Initializing watch room...");
    
    // Set up UI event listeners first
    setupEventListeners();
    
    // Create client
    client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
    
    // Set up Agora event listeners
    setupAgoraEventListeners();
    
    // Fetch token and join
    const tokenData = await fetchRtcToken({ channel: channelName });
    await client.join(APP_ID, channelName, tokenData.token, tokenData.uid);
    
    // Determine if host (first user in room)
    isHost = client.remoteUsers.length === 0;
    console.log("Is host:", isHost);
    
    // Create data stream with retry
    let dataStreamCreated = false;
    let retries = 3;
    
    while (!dataStreamCreated && retries > 0) {
      try {
        dataStream = await client.createDataStream({
          ordered: true,
          reliable: true
        });
        
        // Set up data stream event listener immediately
        dataStream.on("message", (message) => {
          handleDataMessage(message);
        });
        
        dataStreamCreated = true;
        console.log('Data stream created successfully');
      } catch (streamError) {
        retries--;
        console.warn(`Data stream creation failed, ${retries} retries left:`, streamError);
        if (retries > 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
    
    if (!dataStreamCreated) {
      console.error('Failed to create data stream after 3 attempts');
      addChatMessage('System', 'Warning: Some features may not work properly', false);
    }
    
    // Create and publish audio track
    try {
      localTracks.audio = await AgoraRTC.createMicrophoneAudioTrack({
        AEC: true, ANS: true, AGC: true
      });
      await client.publish([localTracks.audio]);
      console.log('Audio track published');
    } catch (audioError) {
      console.warn('Microphone access denied, continuing without audio:', audioError);
      addChatMessage('System', 'Microphone access denied - you can still watch and chat', false);
    }
    
    micOn = true;
    updateMicUI();
    updateParticipantsList();
    
    // Mark as initialized
    isInitialized = true;
    
    // Show success message
    addChatMessage('System', `Joined room "${roomId}" as ${isHost ? 'host 👑' : 'participant'}`, false);
    if (isHost) {
      addChatMessage('System', 'You are the host - you can load videos for everyone', false);
    }
    
    console.log("Watch room initialized successfully");
    
  } catch (error) {
    console.error('Initialization failed:', error);
    alert('Failed to join room. Please try again.');
    window.location = "lobby.html";
  }
}

// Start initialization
console.log("Starting watch initialization...");
(async () => {
  try {
    await init();
  } catch (error) {
    console.error('Watch initialization failed:', error);
    window.location = "lobby.html";
  }
})();

// Handle page unload
window.addEventListener('beforeunload', leave);