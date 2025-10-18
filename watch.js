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
  if (activeKind === 'youtube' && ytPlayer) return ytPlayer.getCurrentTime();
  if (activeKind === 'html5' && html5Video) return html5Video.currentTime || 0;
  return 0;
}

function duration() {
  if (activeKind === 'youtube' && ytPlayer) return ytPlayer.getDuration();
  if (activeKind === 'html5' && html5Video) return html5Video.duration || 0;
  return 0;
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

function loadYouTube(id, start=0){
  showYouTubePlayer();
  if (!window.YT || !YT.Player) {
    // Wait until the API is ready
    window.onYouTubeIframeAPIReady = () => loadYouTube(id, start);
    return;
  }
  if (!ytPlayer) {
    ytPlayer = new YT.Player('yt-player', {
      videoId: id,
      playerVars: { autoplay: 0 },
      events: {
        onReady: () => { if (start>0) ytPlayer.seekTo(start, true); },
        onStateChange: (e) => {
          // 1=play, 2=pause, 0=ended, 3=buffering, 5=cued
          if (!iAmHost) return;
          if (e.data === 1) broadcast({ t:'play', at: ytPlayer.getCurrentTime() });
          if (e.data === 2) broadcast({ t:'pause', at: ytPlayer.getCurrentTime() });
        }
      }
    });
  } else {
    ytPlayer.loadVideoById(id, start);
  }
}

function loadHtml5(url, start=0){
  showHtml5Player();
  html5Video.src = url;
  html5Video.currentTime = start || 0;
  // Host events
  const ensureHandlers = () => {
    html5Video.onplay = () => { if (iAmHost) broadcast({ t:'play', at: html5Video.currentTime }); };
    html5Video.onpause = () => { if (iAmHost) broadcast({ t:'pause', at: html5Video.currentTime }); };
    html5Video.onseeked = () => { if (iAmHost) broadcast({ t:'seek', at: html5Video.currentTime }); };
  };
  ensureHandlers();
}

function handleLoadUrl(url, start=0){
  currentUrl = url;
  if (isYouTube(url)) {
    const id = ytIdFrom(url);
    if (!id) return alert("Could not parse YouTube link.");
    loadYouTube(id, start);
  } else if (/\.(mp4|webm|ogg)(\?|$)/i.test(url)) {
    loadHtml5(url, start);
  } else {
    alert("Unsupported link. Use YouTube or a direct .mp4/.webm/.ogg URL.");
  }
  if (iAmHost) broadcast({ t:'load', url, start });
}

function syncToHost(at, playing){
  if (activeKind === 'youtube' && ytPlayer) {
    ytPlayer.seekTo(at, true);
    if (playing) ytPlayer.playVideo(); else ytPlayer.pauseVideo();
  } else if (activeKind === 'html5' && html5Video) {
    html5Video.currentTime = at;
    if (playing) html5Video.play().catch(()=>{}); else html5Video.pause();
  }
}

// ======== RTC join (audio + data stream) ========
async function join(){
  // Create client (audio only)
  client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });

  client.on("connection-state-change", (cur, prev) => {
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

  // Remote users join/leave
  client.on("user-joined", (user) => {
    peers.set(user.uid, { name: String(user.uid) });
    setPeopleUI();
  });
  client.on("user-left", (user) => {
    peers.delete(user.uid);
    if (user.uid === hostUid) { hostUid = null; iAmHost = false; }
    setPeopleUI();
  });

  // Data stream messages
  client.on("stream-message", ({ uid, streamId: sid, data }) => {
    try {
      const msg = JSON.parse(data);
      if (msg.t === 'announce') {
        peers.set(uid, { name: msg.name || String(uid) });
        setPeopleUI();
        return;
      }
      if (msg.t === 'host') {
        hostUid = msg.uid;
        iAmHost = (hostUid === myUid);
        setPeopleUI();
        return;
      }
      if (uid === hostUid) {
        if (msg.t === 'load') handleLoadUrl(msg.url, msg.start || 0);
        if (msg.t === 'play') syncToHost(msg.at || 0, true);
        if (msg.t === 'pause') syncToHost(msg.at || 0, false);
        if (msg.t === 'seek') syncToHost(msg.at || 0, !html5Video.paused); // try to keep state
        if (msg.t === 'ping') broadcast({ t:'pong' });
      }
    } catch (e) {}
  });

  // Join
  const first = await fetchRtcToken(channelName);
  myUid = first.uid;
  await client.join(APP_ID, channelName, first.token, myUid);

  // Create a reliable, ordered data stream for sync (if available)
  try {
    streamId = await client.createDataStream({ reliable: true, ordered: true });
  } catch (e) {
    console.warn("createDataStream unsupported in this SDK build; sync will be limited.", e);
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

  // Announce presence (name)
  if (streamId != null) {
    broadcast({ t:'announce', name: displayName });
  }

  // If no host yet, first taker wins (optional)
  setTimeout(() => {
    if (!hostUid) { becomeHost(); }
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
function becomeHost(){
  hostUid = myUid;
  iAmHost = true;
  broadcast({ t:'host', uid: myUid });
  setPeopleUI();
}
function releaseHost(){
  iAmHost = false;
  if (hostUid === myUid) hostUid = null;
  broadcast({ t:'host', uid: hostUid }); // may be null; someone else can Take Host
  setPeopleUI();
}

// ======== Wire UI ========
micBtn.addEventListener('click', toggleMic);
leaveBtn.addEventListener('click', leave);
takeHostBtn.addEventListener('click', becomeHost);
releaseHostBtn.addEventListener('click', releaseHost);
syncNowBtn.addEventListener('click', () => {
  // Ask host to ping (will trigger a play/pause shortly after user action anyway)
  if (hostUid && !iAmHost) broadcast({ t:'ping' });
});

loadBtn.addEventListener('click', () => {
  const url = (urlInput.value || '').trim();
  if (!url) return;
  if (!iAmHost) { alert("Only the Host can load a video. Click 'Take Host' first."); return; }
  handleLoadUrl(url, 0);
});

// ======== Kickoff ========
join();
