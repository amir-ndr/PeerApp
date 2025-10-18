// ======== Config & params ========
const isFileLike = location.protocol === 'capacitor:' || location.protocol === 'file:';
const TOKEN_API_BASE = isFileLike
  ? 'https://peer-app-git-main-amirndrs-projects.vercel.app/api'
  : '/api';

const APP_ID = "6774bd10adcd4974ae9d320147124bc5";
const ROOM_PASSWORD = null;

const params = new URLSearchParams(location.search);
const roomId = (params.get("room") || "").trim();
const providedName = (params.get("name") || "").trim();
if (!roomId) location.replace("lobby.html");
const channelName = `call_watch_${roomId}`;
const displayName = providedName || `Guest-${Math.random().toString(36).slice(2, 6)}`;

document.getElementById('room-label').textContent = `Room: ${roomId} — You: ${displayName}`;

// ======== DOM refs ========
const micBtn      = document.getElementById('mic-btn');
const leaveBtn    = document.getElementById('leave-btn');
const urlInput    = document.getElementById('video-url');
const loadBtn     = document.getElementById('load-btn');
const takeHostBtn = document.getElementById('take-host');
const releaseHostBtn = document.getElementById('release-host');
const syncNowBtn  = document.getElementById('sync-now');

const ytContainer = document.getElementById('yt-player');
const html5Video  = document.getElementById('html5-player');
const peopleList  = document.getElementById('people-list');

let client;
let localAudio = null;
let micOn = false;

// Data-stream (for sync)
let streamId = null;

// Peers
const peers = new Map(); // uid -> { name }
let myUid = null;

// Host logic
let hostUid = null;        // uid that controls playback
let iAmHost = false;

// Player state
let ytPlayer = null;
let activeKind = null; // 'youtube' | 'html5'
let currentUrl = "";

// Sync control
let suppressEvents = false;
let lastSyncTime = 0;
let syncThreshold = 2; // seconds difference to trigger sync

// ======== Helpers ========
function tokenUrl(path){
  const base = TOKEN_API_BASE.replace(/\/$/, "");
  const p = String(path || "").replace(/^\//, "");
  return `${base}/${p}`;
}

async function fetchRtcToken(channel){
  const res = await fetch(tokenUrl("token"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(ROOM_PASSWORD ? { "x-room-password": ROOM_PASSWORD } : {}) },
    cache: "no-store",
    body: JSON.stringify({ type: "rtc", channel })
  });
  if (!res.ok) throw new Error(`Token HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.token || typeof data?.uid !== "number") throw new Error("Bad token payload");
  return data;
}

function isYouTube(url){
  try {
    const u = new URL(url);
    return /(^|\.)youtube\.com$/.test(u.hostname) || u.hostname === 'youtu.be';
  } catch { return false; }
}

function ytIdFrom(url){
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1);
    if (/youtube\.com$/.test(u.hostname)) {
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const m = u.pathname.match(/\/shirts\/([^/]+)/);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

function broadcast(msg){
  try {
    if (streamId != null) {
      console.log("Broadcasting:", msg);
      client.sendStreamMessage(streamId, JSON.stringify(msg));
    }
  } catch (e) {
    console.warn("sendStreamMessage failed:", e);
  }
}

function seconds() {
  if (activeKind === 'youtube' && ytPlayer && ytPlayer.getCurrentTime) {
    return ytPlayer.getCurrentTime() || 0;
  }
  if (activeKind === 'html5' && html5Video) {
    return html5Video.currentTime || 0;
  }
  return 0;
}

function isPlaying() {
  if (activeKind === 'youtube' && ytPlayer && ytPlayer.getPlayerState) {
    // YT: 1=playing, 2=paused, 3=buffering, 0=ended
    return ytPlayer.getPlayerState() === 1;
  }
  if (activeKind === 'html5' && html5Video) {
    return !html5Video.paused && !html5Video.ended;
  }
  return false;
}

function setPeopleUI(){
  const items = [];
  for (const [uid, p] of peers) {
    const isHost = uid === hostUid;
    const me = uid === myUid;
    items.push(`<div ${me?'style="font-weight:bold"':''}>${isHost?'⭐ ':''}${p.name || uid}${me?' (you)':''}</div>`);
  }
  peopleList.innerHTML = items.join('');
}

// ======== Player load/sync ========
function showYouTubePlayer(){
  activeKind = 'youtube';
  ytContainer.hidden = false;
  html5Video.hidden = true;
  html5Video.pause?.();
}

function showHtml5Player(){
  activeKind = 'html5';
  ytContainer.hidden = true;
  html5Video.hidden = false;
  if (ytPlayer) try { ytPlayer.stopVideo(); } catch {}
}

function loadYouTube(id, start=0, autoPlay=false){
  showYouTubePlayer();
  
  if (!window.YT || !YT.Player) {
    window.onYouTubeIframeAPIReady = () => loadYouTube(id, start, autoPlay);
    return;
  }
  
  const onPlayerReady = () => {
    console.log("YT Player ready");
    if (start > 0) {
      ytPlayer.seekTo(start, true);
    }
    if (autoPlay) {
      ytPlayer.playVideo();
    } else {
      ytPlayer.pauseVideo();
    }
  };

  if (!ytPlayer) {
    ytPlayer = new YT.Player('yt-player', {
      videoId: id,
      playerVars: { 
        autoplay: autoPlay ? 1 : 0,
        controls: 1,
        rel: 0
      },
      events: {
        onReady: onPlayerReady,
        onStateChange: (e) => {
          console.log("YT State change:", e.data);
          if (!iAmHost || suppressEvents) return;
          
          const currentTime = ytPlayer.getCurrentTime();
          switch(e.data) {
            case 1: // Playing
              broadcast({ t: 'play', at: currentTime });
              break;
            case 2: // Paused
              broadcast({ t: 'pause', at: currentTime });
              break;
            case 0: // Ended
              broadcast({ t: 'pause', at: currentTime });
              break;
          }
        }
      }
    });
    
    // Add interval to detect seeks for YouTube (since API doesn't provide seek events)
    setInterval(() => {
      if (!iAmHost || suppressEvents || !ytPlayer) return;
      
      const currentTime = ytPlayer.getCurrentTime();
      if (Math.abs(currentTime - lastSyncTime) > syncThreshold) {
        console.log("Detected seek in YT player");
        broadcast({ t: 'seek', at: currentTime });
        lastSyncTime = currentTime;
      }
    }, 1000);
    
  } else {
    ytPlayer.loadVideoById({
      videoId: id,
      startSeconds: start
    });
    if (!autoPlay) {
      setTimeout(() => {
        suppressEvents = true;
        ytPlayer.pauseVideo();
        setTimeout(() => { suppressEvents = false; }, 500);
      }, 1000);
    }
  }
}

function attachHtml5Handlers(){
  // Remove existing handlers to avoid duplicates
  html5Video.onplay = null;
  html5Video.onpause = null;
  html5Video.onseeked = null;
  html5Video.ontimeupdate = null;
  
  html5Video.onplay = () => { 
    if (iAmHost && !suppressEvents) {
      console.log("HTML5 play event");
      broadcast({ t: 'play', at: html5Video.currentTime }); 
    }
  };
  
  html5Video.onpause = () => { 
    if (iAmHost && !suppressEvents) {
      console.log("HTML5 pause event");
      broadcast({ t: 'pause', at: html5Video.currentTime }); 
    }
  };
  
  html5Video.onseeked = () => { 
    if (iAmHost && !suppressEvents) {
      console.log("HTML5 seek event");
      broadcast({ t: 'seek', at: html5Video.currentTime }); 
    }
  };
  
  // Detect seeks through time updates (fallback)
  let lastTime = html5Video.currentTime;
  html5Video.ontimeupdate = () => {
    if (!iAmHost || suppressEvents) return;
    
    const currentTime = html5Video.currentTime;
    if (Math.abs(currentTime - lastTime) > syncThreshold) {
      console.log("Detected seek in HTML5 player");
      broadcast({ t: 'seek', at: currentTime });
      lastTime = currentTime;
    }
  };
}

function loadHtml5(url, start=0, autoPlay=false){
  showHtml5Player();
  html5Video.src = url;
  html5Video.currentTime = start || 0;
  attachHtml5Handlers();
  
  html5Video.onloadeddata = () => {
    console.log("HTML5 video loaded");
    if (autoPlay) {
      html5Video.play().catch(e => console.log("Autoplay blocked:", e));
    } else {
      suppressEvents = true;
      html5Video.pause();
      setTimeout(() => { suppressEvents = false; }, 500);
    }
  };
}

function handleLoadUrl(url, start=0, autoPlay=false){
  currentUrl = url;
  if (isYouTube(url)) {
    const id = ytIdFrom(url);
    if (!id) return alert("Could not parse YouTube link.");
    loadYouTube(id, start, autoPlay);
  } else if (/\.(mp4|webm|ogg)(\?|$)/i.test(url)) {
    loadHtml5(url, start, autoPlay);
  } else {
    alert("Unsupported link. Use YouTube or a direct .mp4/.webm/.ogg URL.");
  }
  
  if (iAmHost) {
    // Small delay to ensure player is ready before broadcasting
    setTimeout(() => {
      broadcast({ 
        t: 'load', 
        url, 
        start, 
        playing: autoPlay, 
        kind: activeKind, 
        hostUid 
      });
    }, 1000);
  }
}

function syncToHost(at, playing){
  console.log(`Syncing to host: time=${at}, playing=${playing}`);
  suppressEvents = true;
  
  if (activeKind === 'youtube' && ytPlayer) {
    try {
      ytPlayer.seekTo(at, true);
      if (playing) {
        ytPlayer.playVideo();
      } else {
        ytPlayer.pauseVideo();
      }
    } catch (e) {
      console.error("YT sync error:", e);
    }
  } else if (activeKind === 'html5' && html5Video) {
    html5Video.currentTime = at;
    if (playing) {
      html5Video.play().catch(e => console.log("Play blocked:", e));
    } else {
      html5Video.pause();
    }
  }
  
  lastSyncTime = at;
  setTimeout(() => { suppressEvents = false; }, 1000);
}

// ======== RTC join (audio + data stream) ========
async function join(){
  client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });

  client.on("connection-state-change", (cur) => {
    console.log("Connection state:", cur);
    if (cur === "DISCONNECTED" || cur === "RECONNECTING") {
      let bar = document.getElementById("net-banner");
      if (!bar){
        bar = document.createElement("div");
        bar.id = "net-banner";
        bar.textContent = (cur === "RECONNECTING") ? "Reconnecting…" : "Disconnected";
        document.body.appendChild(bar);
      }
    } else {
      document.getElementById("net-banner")?.remove();
    }
  });

  client.on("user-joined", (user) => {
    console.log("User joined:", user.uid);
    peers.set(user.uid, { name: `User-${user.uid}` });
    setPeopleUI();
    
    // If I'm the host and someone new joins, proactively push state
    if (iAmHost && currentUrl) {
      setTimeout(() => {
        broadcast({ 
          t: 'state', 
          url: currentUrl, 
          at: seconds(), 
          playing: isPlaying(), 
          kind: activeKind, 
          hostUid 
        });
      }, 1000);
    }
  });

  client.on("user-left", (user) => {
    console.log("User left:", user.uid);
    peers.delete(user.uid);
    if (user.uid === hostUid) { 
      hostUid = null; 
      iAmHost = false; 
      console.log("Host left, hostUid reset");
    }
    setPeopleUI();
  });

  client.on("stream-message", ({ uid, data }) => {
    try {
      const msg = JSON.parse(data);
      console.log("Received message from", uid, ":", msg);

      if (msg.t === 'announce') {
        peers.set(uid, { name: msg.name || String(uid) });
        setPeopleUI();
        // If I'm host, answer with full state
        if (iAmHost && currentUrl) {
          setTimeout(() => {
            broadcast({ 
              t: 'state', 
              url: currentUrl, 
              at: seconds(), 
              playing: isPlaying(), 
              kind: activeKind, 
              hostUid 
            });
          }, 500);
        }
        return;
      }

      if (msg.t === 'hello') {
        // Newcomer is asking for state; host replies
        if (iAmHost && currentUrl) {
          setTimeout(() => {
            broadcast({ 
              t: 'state', 
              url: currentUrl, 
              at: seconds(), 
              playing: isPlaying(), 
              kind: activeKind, 
              hostUid 
            });
          }, 500);
        }
        return;
      }

      if (msg.t === 'host') {
        hostUid = msg.uid || null;
        iAmHost = (hostUid === myUid);
        console.log(`Host updated: ${hostUid}, I am host: ${iAmHost}`);
        setPeopleUI();
        return;
      }

      if (msg.t === 'state' && uid === hostUid) {
        // Late joiner or resync
        const { url, at=0, playing=false, kind } = msg;
        if (!url) return;
        console.log("Received state from host:", { url, at, playing, kind });
        
        // Only load if different from current
        if (url !== currentUrl) {
          handleLoadUrl(url, at, playing);
        } else {
          syncToHost(at, playing);
        }
        return;
      }

      // Host-driven live controls
      if (uid === hostUid) {
        console.log("Processing host command:", msg.t);
        switch(msg.t) {
          case 'load':
            handleLoadUrl(msg.url, msg.start || msg.at || 0, !!msg.playing);
            break;
          case 'play':
            syncToHost(msg.at || 0, true);
            break;
          case 'pause':
            syncToHost(msg.at || 0, false);
            break;
          case 'seek':
            syncToHost(msg.at || 0, isPlaying());
            break;
          case 'ping':
            broadcast({ t: 'pong' });
            break;
        }
      }
    } catch (e) {
      console.error("Error processing message:", e);
    }
  });

  // Join
  try {
    const first = await fetchRtcToken(channelName);
    myUid = first.uid;
    await client.join(APP_ID, channelName, first.token, myUid);
    console.log("Joined channel, my UID:", myUid);

    // Data stream for sync
    try {
      streamId = await client.createDataStream({ reliable: true, ordered: true });
      console.log("Data stream created:", streamId);
    } catch (e) {
      console.warn("createDataStream failed:", e);
    }

    // Publish mic (audio call)
    try {
      localAudio = await AgoraRTC.createMicrophoneAudioTrack({ 
        AEC: true, 
        ANS: true, 
        AGC: true 
      });
      await client.publish([localAudio]);
      micOn = true; 
      updateMicBtn();
      console.log("Mic published");
    } catch (e) {
      console.error("Mic error:", e);
      alert("Microphone access denied or unavailable.");
    }

    // Announce presence (name) and request state
    if (streamId != null) {
      broadcast({ t: 'announce', name: displayName });
      broadcast({ t: 'hello' });
    }

    // If no host yet, first taker wins after a moment
    setTimeout(() => {
      if (!hostUid) { 
        console.log("No host detected, becoming host");
        becomeHost(); 
      }
    }, 2000);

  } catch (e) {
    console.error("Join failed:", e);
    alert("Failed to join room: " + e.message);
  }
}

function updateMicBtn(){
  micBtn.setAttribute('aria-pressed', micOn ? 'true' : 'false');
  micBtn.classList.toggle('muted', !micOn);
  micBtn.title = micOn ? 'Toggle mic (currently ON)' : 'Toggle mic (currently OFF)';
}

async function toggleMic(){
  if (!localAudio) return;
  const next = !micOn;
  try {
    if (typeof localAudio.setMuted === 'function') {
      await localAudio.setMuted(!next);
    } else if (typeof localAudio.setEnabled === 'function') {
      await localAudio.setEnabled(next);
    }
    micOn = next; 
    updateMicBtn();
  } catch (e) {
    console.error("Toggle mic failed:", e);
  }
}

async function leave(){
  try {
    if (localAudio) { 
      try{ localAudio.stop(); localAudio.close(); }catch{} 
    }
    try{ await client.unpublish(); }catch{}
    try{ await client.leave(); }catch{}
  } finally {
    location.replace("lobby.html");
  }
}

// ======== Host controls ========
function becomeHost(){
  hostUid = myUid;
  iAmHost = true;
  console.log("I am now the host");
  broadcast({ t: 'host', uid: myUid });
  setPeopleUI();
  // Immediately push state if we already have a video
  if (currentUrl) {
    setTimeout(() => {
      broadcast({ 
        t: 'state', 
        url: currentUrl, 
        at: seconds(), 
        playing: isPlaying(), 
        kind: activeKind, 
        hostUid 
      });
    }, 500);
  }
}

function releaseHost(){
  iAmHost = false;
  if (hostUid === myUid) hostUid = null;
  console.log("Released host role");
  broadcast({ t: 'host', uid: hostUid });
  setPeopleUI();
}

// ======== Wire UI ========
micBtn.addEventListener('click', toggleMic);
leaveBtn.addEventListener('click', leave);
takeHostBtn.addEventListener('click', becomeHost);
releaseHostBtn.addEventListener('click', releaseHost);
syncNowBtn.addEventListener('click', () => {
  if (hostUid && !iAmHost) {
    console.log("Requesting sync from host");
    broadcast({ t: 'hello' });
  } else if (iAmHost) {
    alert("You are the host!");
  } else {
    alert("No host in the room!");
  }
});

loadBtn.addEventListener('click', () => {
  const url = (urlInput.value || '').trim();
  if (!url) return;
  if (!iAmHost) { 
    alert("Only the Host can load a video. Click 'Take Host' first."); 
    return; 
  }
  handleLoadUrl(url, 0, false);
});

// Enter key for URL input
urlInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    loadBtn.click();
  }
});

// ======== Kickoff ========
// Ensure YouTube API is loaded
(function(){
  if (!window.YT) {
    const tag = document.createElement('script');
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  }
})();

// Start the application
join();