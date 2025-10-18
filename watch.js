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

// Prevent echo loops when programmatic changes fire events
let suppressNextEvent = false;

// Periodic sync interval
let syncInterval = null;

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
      const m = u.pathname.match(/\/shorts\/([^/]+)/);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

function broadcast(msg){
  try {
    if (streamId != null) client.sendStreamMessage(streamId, JSON.stringify(msg));
  } catch (e) {
    console.warn("sendStreamMessage failed:", e);
  }
}

function seconds() {
  if (activeKind === 'youtube' && ytPlayer && ytPlayer.getCurrentTime) return ytPlayer.getCurrentTime();
  if (activeKind === 'html5' && html5Video) return html5Video.currentTime || 0;
  return 0;
}

function isPlaying() {
  if (activeKind === 'youtube' && ytPlayer && ytPlayer.getPlayerState) {
    // YT: 1=playing
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
    items.push(`<div ${me?'class="me"':''}>${isHost?'⭐ ':''}${p.name || uid}${me?' (you)':''}</div>`);
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
  const doSeekAndMaybePlay = () => {
    try {
      if (start>0) ytPlayer.seekTo(start, true);
      if (autoPlay) ytPlayer.playVideo();
      else ytPlayer.pauseVideo();
    } catch {}
  };

  if (!window.YT || !YT.Player) {
    window.onYouTubeIframeAPIReady = () => loadYouTube(id, start, autoPlay);
    return;
  }
  if (!ytPlayer) {
    ytPlayer = new YT.Player('yt-player', {
      videoId: id,
      playerVars: { autoplay: 0 },
      events: {
        onReady: () => { doSeekAndMaybePlay(); },
        onStateChange: (e) => {
          if (!iAmHost) return;
          if (suppressNextEvent) { suppressNextEvent = false; return; }
          
          // YouTube player states: -1 (unstarted), 0 (ended), 1 (playing), 2 (paused), 3 (buffering), 5 (video cued)
          if (e.data === 1) { // Playing
            broadcast({ t:'play', at: ytPlayer.getCurrentTime() });
          } else if (e.data === 2) { // Paused
            broadcast({ t:'pause', at: ytPlayer.getCurrentTime() });
          } else if (e.data === 0) { // Ended
            broadcast({ t:'pause', at: ytPlayer.getCurrentTime() });
          }
        }
      }
    });
  } else {
    ytPlayer.loadVideoById(id, start);
    if (!autoPlay) {
      // YT auto-plays on loadVideoById; pause if needed
      suppressNextEvent = true;
      ytPlayer.pauseVideo();
    }
  }
}

function attachHtml5Handlers(){
  html5Video.onplay = () => { 
    if (iAmHost && !suppressNextEvent) {
      broadcast({ t:'play', at: html5Video.currentTime }); 
      suppressNextEvent = false;
    }
  };
  
  html5Video.onpause = () => { 
    if (iAmHost && !suppressNextEvent) {
      broadcast({ t:'pause', at: html5Video.currentTime }); 
      suppressNextEvent = false;
    }
  };
  
  html5Video.onseeked = () => { 
    if (iAmHost && !suppressNextEvent) {
      broadcast({ t:'seek', at: html5Video.currentTime }); 
      suppressNextEvent = false;
    }
  };
  
  html5Video.onended = () => { 
    if (iAmHost && !suppressNextEvent) {
      broadcast({ t:'pause', at: html5Video.currentTime }); 
      suppressNextEvent = false;
    }
  };
  
  // Add seeking event for better sync during seeking
  html5Video.onseeking = () => {
    if (iAmHost && !suppressNextEvent) {
      broadcast({ t:'seeking', at: html5Video.currentTime }); 
    }
  };
}

function loadHtml5(url, start=0, autoPlay=false){
  showHtml5Player();
  html5Video.src = url;
  html5Video.currentTime = start || 0;
  attachHtml5Handlers();
  if (autoPlay) {
    html5Video.play().catch(()=>{});
  } else {
    suppressNextEvent = true;
    html5Video.pause();
  }
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
  if (iAmHost) broadcast({ t:'load', url, start, playing: autoPlay, kind: activeKind, hostUid });
}

function syncToHost(at, playing){
  suppressNextEvent = true;
  
  if (activeKind === 'youtube' && ytPlayer) {
    const currentTime = ytPlayer.getCurrentTime();
    const timeDiff = Math.abs(currentTime - at);
    
    // Only seek if the time difference is significant (more than 0.5 seconds)
    if (timeDiff > 0.5) {
      ytPlayer.seekTo(at, true);
    }
    
    if (playing) {
      ytPlayer.playVideo();
    } else {
      ytPlayer.pauseVideo();
    }
  } else if (activeKind === 'html5' && html5Video) {
    const currentTime = html5Video.currentTime;
    const timeDiff = Math.abs(currentTime - at);
    
    // Only seek if the time difference is significant (more than 0.5 seconds)
    if (timeDiff > 0.5) {
      html5Video.currentTime = at;
    }
    
    if (playing) {
      html5Video.play().catch(e => console.error("Error playing video:", e));
    } else {
      html5Video.pause();
    }
  }
  
  // Reset suppressNextEvent after a short delay
  setTimeout(() => {
    suppressNextEvent = false;
  }, 100);
}

// ======== RTC join (audio + data stream) ========
async function join(){
  client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });

  client.on("connection-state-change", (cur) => {
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
    peers.set(user.uid, { name: String(user.uid) });
    setPeopleUI();
    // If I'm the host and someone new joins, proactively push state
    if (iAmHost && currentUrl) {
      broadcast({ t:'state', url: currentUrl, at: seconds(), playing: isPlaying(), kind: activeKind, hostUid });
    }
  });

  client.on("user-left", (user) => {
    peers.delete(user.uid);
    if (user.uid === hostUid) { 
      hostUid = null; 
      iAmHost = false;
      // Stop periodic sync if we were the host
      if (syncInterval) {
        clearInterval(syncInterval);
        syncInterval = null;
      }
    }
    setPeopleUI();
  });

  client.on("stream-message", ({ uid, data }) => {
    try {
      const msg = JSON.parse(data);

      if (msg.t === 'announce') {
        peers.set(uid, { name: msg.name || String(uid) });
        setPeopleUI();
        // If I'm host, answer with full state
        if (iAmHost && currentUrl) {
          broadcast({ t:'state', url: currentUrl, at: seconds(), playing: isPlaying(), kind: activeKind, hostUid });
        }
        return;
      }

      if (msg.t === 'hello') {
        // Newcomer is asking for state; host replies
        if (iAmHost && currentUrl) {
          broadcast({ t:'state', url: currentUrl, at: seconds(), playing: isPlaying(), kind: activeKind, hostUid });
        }
        return;
      }

      if (msg.t === 'host') {
        hostUid = msg.uid || null;
        iAmHost = (hostUid === myUid);
        setPeopleUI();
        // If I'm not the host, request current state
        if (!iAmHost && hostUid) {
          setTimeout(() => {
            broadcast({ t:'hello' });
          }, 500);
        }
        return;
      }

      if (msg.t === 'state' && uid === hostUid) {
        // Late joiner or resync
        const { url, at=0, playing=false, kind } = msg;
        if (!url) return;
        // Load and align to host
        handleLoadUrl(url, at, playing);
        // Do not rebroadcast; handleLoadUrl will only broadcast if iAmHost (false here)
        return;
      }

      // Host-driven live controls
      if (uid === hostUid) {
        if (msg.t === 'load') handleLoadUrl(msg.url, msg.start || msg.at || 0, !!msg.playing);
        if (msg.t === 'play') syncToHost(msg.at || 0, true);
        if (msg.t === 'pause') syncToHost(msg.at || 0, false);
        if (msg.t === 'seek' || msg.t === 'seeking') syncToHost(msg.at || 0, isPlaying());
        if (msg.t === 'ping') broadcast({ t:'pong' });
      }
    } catch (e) {
      console.error("Error processing stream message:", e);
    }
  });

  // Join
  const first = await fetchRtcToken(channelName);
  myUid = first.uid;
  await client.join(APP_ID, channelName, first.token, myUid);

  // Data stream for sync
  try {
    streamId = await client.createDataStream({ reliable: true, ordered: true });
  } catch (e) {
    console.warn("createDataStream unsupported; sync will be limited.", e);
  }

  // Publish mic (audio call)
  try {
    localAudio = await AgoraRTC.createMicrophoneAudioTrack({ AEC: true, ANS: true, AGC: true });
    await client.publish([localAudio]);
    micOn = true; updateMicBtn();
  } catch (e) {
    console.error("Mic error:", e);
    alert("Microphone access denied or unavailable.");
  }

  // Announce presence (name) and request state
  if (streamId != null) {
    broadcast({ t:'announce', name: displayName });
    broadcast({ t:'hello' });
  }

  // If no host yet, first taker wins after a moment
  setTimeout(() => {
    if (!hostUid) { 
      becomeHost(); 
    }
  }, 1000);
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
    micOn = next; updateMicBtn();
  } catch {}
}

async function leave(){
  try {
    if (localAudio) { try{ localAudio.stop(); localAudio.close(); }catch{} }
    try{ await client.unpublish(); }catch{}
    try{ await client.leave(); }catch{}
  } finally {
    location.replace("lobby.html");
  }
}

// ======== Host controls ========
function startPeriodicSync() {
  if (syncInterval) clearInterval(syncInterval);
  
  syncInterval = setInterval(() => {
    if (iAmHost && currentUrl) {
      broadcast({ 
        t:'state', 
        url: currentUrl, 
        at: seconds(), 
        playing: isPlaying(), 
        kind: activeKind, 
        hostUid 
      });
    }
  }, 5000); // Sync every 5 seconds
}

function becomeHost(){
  hostUid = myUid;
  iAmHost = true;
  broadcast({ t:'host', uid: myUid });
  setPeopleUI();
  // Immediately push state if we already have a video
  if (currentUrl) {
    broadcast({ t:'state', url: currentUrl, at: seconds(), playing: isPlaying(), kind: activeKind, hostUid });
  }
  // Start periodic sync
  startPeriodicSync();
  // Also request current state from all clients to ensure we're in sync
  setTimeout(() => {
    broadcast({ t:'ping' });
  }, 500);
}

function releaseHost(){
  iAmHost = false;
  if (hostUid === myUid) hostUid = null;
  broadcast({ t:'host', uid: hostUid });
  setPeopleUI();
  // Stop periodic sync
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

// ======== Wire UI ========
micBtn.addEventListener('click', toggleMic);
leaveBtn.addEventListener('click', leave);
takeHostBtn.addEventListener('click', becomeHost);
releaseHostBtn.addEventListener('click', releaseHost);
syncNowBtn.addEventListener('click', () => {
  if (hostUid && !iAmHost) {
    broadcast({ t:'hello' }); // ask host to send state
    // Provide visual feedback
    syncNowBtn.textContent = "Syncing...";
    setTimeout(() => {
      syncNowBtn.textContent = "Sync to Host";
    }, 2000);
  }
});

loadBtn.addEventListener('click', () => {
  const url = (urlInput.value || '').trim();
  if (!url) return;
  if (!iAmHost) { alert("Only the Host can load a video. Click 'Take Host' first."); return; }
  handleLoadUrl(url, 0, false);
});

// ======== Kickoff ========
// Inject YouTube API tag (in case watch.html didn't already load it)
(function(){
  if (!window.YT) {
    const tag = document.createElement('script');
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  }
})();
join();