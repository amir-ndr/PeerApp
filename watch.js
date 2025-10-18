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
let dataStreamEnabled = false;

// ===== Token Fallback =====
async function fetchRtcTokenWithFallback({ channel, maxRetries = 2 }) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const tokenUrl = `${TOKEN_API_BASE.replace(/\/$/, "")}/token`;
      console.log(`Fetching token from: ${tokenUrl} (attempt ${attempt})`);
      
      const res = await fetch(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(ROOM_PASSWORD ? { "x-room-password": ROOM_PASSWORD } : {})
        },
        body: JSON.stringify({ type: "rtc", channel })
      });
      
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      
      const data = await res.json();
      if (!data?.token || typeof data?.uid !== "number") {
        throw new Error("Invalid token response format");
      }
      
      console.log("Token fetched successfully");
      return data;
      
    } catch (error) {
      console.warn(`Token fetch attempt ${attempt} failed:`, error);
      
      if (attempt === maxRetries) {
        // Final fallback: Use null token (works for testing/development)
        console.warn("Using null token as fallback");
        return { token: null, uid: 0 };
      }
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

// ===== Data Stream Utilities =====
async function initializeDataStream(maxRetries = 3) {
  if (!client) {
    console.error("Client not initialized for data stream");
    return false;
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Creating data stream (attempt ${attempt})...`);
      
      dataStream = await client.createDataStream({
        ordered: true,
        reliable: false, // Changed to false for better compatibility
        retry: true
      });
      
      // Set up message handler
      dataStream.on("message", (message) => {
        handleDataMessage(message);
      });
      
      dataStream.on("error", (error) => {
        console.error("Data stream error:", error);
        dataStreamEnabled = false;
      });
      
      dataStreamEnabled = true;
      console.log('Data stream created successfully');
      return true;
      
    } catch (error) {
      console.warn(`Data stream creation failed (attempt ${attempt}):`, error);
      
      if (attempt === maxRetries) {
        console.error("Data stream creation failed after all retries");
        dataStreamEnabled = false;
        return false;
      }
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

function isDataStreamReady() {
  return dataStreamEnabled && dataStream && typeof dataStream.sendData === 'function';
}

async function waitForDataStream(maxWaitTime = 3000) {
  const startTime = Date.now();
  while (!isDataStreamReady() && (Date.now() - startTime) < maxWaitTime) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!isDataStreamReady()) {
    throw new Error('Data stream not available after waiting');
  }
  return true;
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
  const originalText = loadVideoBtn.textContent;
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
    alert('Error loading video. Please check the URL and try again.');
  } finally {
    loadVideoBtn.disabled = false;
    loadVideoBtn.textContent = originalText;
  }
}

async function broadcastVideoState(url, title, videoInfo, maxRetries = 2) {
  if (!isHost) return;
  
  try {
    // Try to use data stream if available
    if (await initializeDataStream(1)) { // Quick retry
      const message = {
        type: 'video-state',
        url: url,
        title: title,
        videoInfo: videoInfo,
        timestamp: Date.now(),
        sender: displayName
      };
      
      if (sendDataMessage(message)) {
        addChatMessage('System', `Host loaded a new ${videoInfo.type} video`, false);
        console.log('Video state broadcast successfully');
        return;
      }
    }
    
    // Fallback: Inform users they need to load manually
    addChatMessage('System', `Host loaded a ${videoInfo.type} video. Other users may need to load it manually.`, false);
    
  } catch (error) {
    console.error('Failed to broadcast video state:', error);
    addChatMessage('System', 'Note: Video loaded but sync with others may not work', false);
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
    dataStreamEnabled = false;
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
    }
  } catch (error) {
    console.error('Error processing data message:', error);
  }
}

function handleSyncRequest(data) {
  if (currentVideoUrl && currentVideoInfo && isDataStreamReady()) {
    const videoState = {
      type: 'video-state',
      url: currentVideoUrl,
      title: videoTitle.textContent,
      videoInfo: currentVideoInfo,
      timestamp: Date.now(),
      sender: displayName,
      isSyncResponse: true
    };
    
    if (sendDataMessage(videoState)) {
      addChatMessage('System', `${data.requester} requested video sync`, false);
    }
  }
}

function handleRemoteVideoState(data) {
  console.log('Handling remote video state:', data);
  
  if (data.sender === displayName) return;
  
  if (data.url && data.url !== currentVideoUrl) {
    loadVideo(data.url);
  }
  
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
  
  if (!isDataStreamReady()) {
    addChatMessage('System', 'Sync not available - data connection issue', true);
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
      addChatMessage('System', 'Failed to send sync request', true);
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
    <div class="participant-data">${dataStreamEnabled ? '📡' : '❌'}</div>
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
        } catch (error) {
          console.error('Failed to send video state to new user:', error);
        }
      }, 1500);
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
  
  client.on("connection-state-change", (curState, prevState) => {
    console.log('Connection state changed:', prevState, '->', curState);
    if (curState === 'DISCONNECTED') {
      addChatMessage('System', 'Connection lost. Attempting to reconnect...', false);
    } else if (curState === 'CONNECTED') {
      addChatMessage('System', 'Connection restored', false);
      // Try to reinitialize data stream
      if (isHost && currentVideoUrl) {
        setTimeout(() => {
          initializeDataStream(1);
        }, 1000);
      }
    }
  });
}

function sendMessage() {
  const text = messageInput.value.trim();
  if (!text) return;
  
  // Try to use data stream if available
  if (isDataStreamReady()) {
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
        return;
      }
    } catch (error) {
      console.error('Failed to send message via data stream:', error);
    }
  }
  
  // Fallback: local chat only
  addChatMessage(displayName, text, true);
  addChatMessage('System', 'Note: Message not sent to others (connection issue)', true);
  messageInput.value = '';
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
    
    // Fetch token with fallback
    const tokenData = await fetchRtcTokenWithFallback({ channel: channelName });
    
    // Join channel
    await client.join(APP_ID, channelName, tokenData.token, tokenData.uid);
    
    // Determine if host (first user in room)
    isHost = client.remoteUsers.length === 0;
    console.log("Is host:", isHost);
    
    // Initialize data stream (but don't block if it fails)
    initializeDataStream().then(success => {
      if (success) {
        console.log("Data stream initialized successfully");
        addChatMessage('System', 'Sync features enabled', false);
      } else {
        console.warn("Data stream initialization failed - limited functionality");
        addChatMessage('System', 'Note: Video sync may not work', false);
      }
      updateParticipantsList();
    });
    
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
    alert('Failed to join room. Please check your connection and try again.');
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
    alert('Failed to initialize: ' + error.message);
    window.location = "lobby.html";
  }
})();

// Handle page unload
window.addEventListener('beforeunload', leave);