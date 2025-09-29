const APP_ID = "6774bd10adcd4974ae9d320147124bc5";

// CHANGE THIS to your Vercel token function (or "/api" if token lives in same project)
const TOKEN_API_BASE = "https://peerapp-token-server.vercel.app/api";
// If you protected /api/token with a shared pass, set it here, else leave null
const ROOM_PASSWORD = null;

/* ====== URL params & mode ====== */
const params = new URLSearchParams(window.location.search);
const roomId = (params.get("room") || "").trim();
const rawMode = (params.get("mode") || "video").trim().toLowerCase();
const mode = (rawMode === "audio" || rawMode === "video") ? rawMode : "video";
const providedName = (params.get("name") || "").trim();
if (!roomId) window.location = "lobby.html";
const channelName = `call_${mode}_${roomId}`;
const isAudioMode = mode === "audio";

/* ====== Names & UIDs ====== */
function makeGuestId(){ return `Guest-${Math.random().toString(36).slice(2, 6)}`; }
const displayName = providedName || makeGuestId();
// Use the name as the Agora RTC UID (string)
const uid = displayName;

/* ====== DOM refs ====== */
const audioUI       = document.getElementById("audio-call");
const audioList     = document.getElementById("audio-list"); // optional custom list; may be null
const audioMicBtn   = document.getElementById("audio-mic");
const audioMicText  = document.getElementById("audio-mic-text");
const audioLeaveBtn = document.getElementById("audio-leave");

const grid   = document.getElementById("video-grid");
const camBtn = document.getElementById("camera-btn");
const micBtn = document.getElementById("mic-btn");
const leaveBtn = document.getElementById("leave-btn");

// Fallback labels if you use the simple 2-avatar audio UI
const localLabelEl  = document.getElementById("local-label");
const remoteLabelEl = document.getElementById("remote-label");

/* ====== RTC state ====== */
let client;
let localTracks = { audio: null, video: null };
const remoteUsers = new Map(); // uid -> user
const tiles = new Map();       // video tiles
const audioTiles = new Map();  // audio tiles if #audio-list exists
let timerInt = null;

/* ====== Browser quirks ====== */
const ua = navigator.userAgent.toLowerCase();
const isSafari = ua.includes("safari") && !ua.includes("chrome") && !ua.includes("android");

/* ====== Token fetch/renew ====== */
async function fetchRtcToken({ channel, uid, role = "publisher" }){
  const url = new URL("token", TOKEN_API_BASE);
  url.searchParams.set("channel", channel);
  url.searchParams.set("uid", uid);
  url.searchParams.set("role", role);
  const headers = {};
  if (ROOM_PASSWORD) headers["x-room-password"] = ROOM_PASSWORD;

  const res = await fetch(url.toString(), { headers, cache: "no-store" });
  if (!res.ok) {
    const msg = await res.text().catch(()=>res.statusText);
    throw new Error(`Token request failed: ${res.status} ${msg}`);
  }
  const data = await res.json();
  if (!data?.token) throw new Error("Token server did not return a token");
  return data.token;
}

/* ====== Mobile: unlock audio & wakelock ====== */
let audioUnlockShown = false;
function showAudioUnlockOverlay(tryPlayAgain) {
  if (audioUnlockShown) return;
  audioUnlockShown = true;

  const overlay = document.createElement("div");
  overlay.style.cssText = `
    position:fixed; inset:0; display:grid; place-items:center;
    background:rgba(0,0,0,.6); z-index:9999; color:#fff; font-weight:700;
  `;
  overlay.innerHTML = `
    <button id="unlock-audio" style="
      padding:12px 18px; border-radius:999px; border:1px solid #999;
      background:#1d212a; color:#fff; font-size:16px;">Tap to enable audio</button>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector("#unlock-audio").addEventListener("click", async () => {
    try { await tryPlayAgain(); } finally { overlay.remove(); }
  }, { once: true });
}

async function replayRemoteAudioTracks() {
  for (const [, user] of remoteUsers) {
    if (user.audioTrack) {
      try { user.audioTrack.play(); } catch {}
    }
  }
}

let wakeLock = null;
async function requestWakeLock(){
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible') {
          try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
        }
      });
    }
  } catch {}
}

/* ====== Timer ====== */
function startTimer(){
  const el = document.getElementById("call-timer");
  if (!el) return;
  const t0 = Date.now();
  timerInt = setInterval(() => {
    const s = Math.floor((Date.now()-t0)/1000);
    el.textContent = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
  }, 1000);
}

/* ====== Video tiles ====== */
function makeTile(id, labelText){
  const tile = document.createElement("div");
  tile.className = "tile";
  tile.id = `tile-${id}`;

  const v = document.createElement("div");
  v.className = "video-wrap";
  v.id = `player-${id}`;
  tile.appendChild(v);

  const badge = document.createElement("div");
  badge.className = "badge";
  badge.textContent = labelText;
  tile.appendChild(badge);

  grid?.appendChild(tile);
  tiles.set(id, tile);
  return tile;
}
function ensureLocalTile(){
  if (tiles.has("local")) return tiles.get("local");
  return makeTile("local", displayName || "You");
}
function ensureRemoteTile(remoteUid){
  if (tiles.has(remoteUid)) return tiles.get(remoteUid);
  return makeTile(remoteUid, String(remoteUid));
}
function removeTile(id){
  const tile = tiles.get(id);
  if (tile && tile.parentNode) tile.parentNode.removeChild(tile);
  tiles.delete(id);
}

/* ====== Audio tiles (optional list) ====== */
function makeAudioTile(id, labelText, isLocal=false){
  const root = document.createElement('div');
  root.className = `a-tile${isLocal ? ' local' : ''}`;
  root.id = `a-tile-${id}`;

  const avatar = document.createElement('div');
  avatar.className = 'a-avatar';
  avatar.innerHTML = '<div class="a-ring"></div><div class="a-emoji">🎧</div>';
  root.appendChild(avatar);

  const name = document.createElement('div');
  name.className = 'a-name';
  name.textContent = labelText;
  root.appendChild(name);

  const mic = document.createElement('div');
  mic.className = 'a-mic';
  mic.title = 'Mic status';
  mic.textContent = '🎙️';
  root.appendChild(mic);

  audioList?.appendChild(root);
  audioTiles.set(id, { root, nameEl: name, micEl: mic });
  return root;
}
function ensureAudioTile(uidKey, label){
  if (!audioList) return null; // if your HTML doesn't have #audio-list, skip tiles
  if (audioTiles.has(uidKey)) return audioTiles.get(uidKey).root;
  return makeAudioTile(uidKey, label, uidKey === 'local');
}
function removeAudioTile(uidKey){
  const t = audioTiles.get(uidKey);
  if (t?.root?.parentNode) t.root.parentNode.removeChild(t.root);
  audioTiles.delete(uidKey);
}
function setAudioTileMuted(uidKey, muted){
  const t = audioTiles.get(uidKey);
  if (!t) return;
  t.root.classList.toggle('muted', !!muted);
  t.micEl.textContent = muted ? '🔇' : '🎙️';
  t.micEl.title = muted ? 'Muted' : 'Mic on';
}
function setAudioTileSpeaking(uidKey, speaking){
  const t = audioTiles.get(uidKey);
  if (!t) return;
  t.root.classList.toggle('speaking', !!speaking);
}

/* ====== Fallback: 2-avatar audio UI labels ====== */
function setSimpleAudioLabels(remoteName){
  if (localLabelEl)  localLabelEl.textContent  = displayName;
  if (remoteLabelEl) remoteLabelEl.textContent = remoteName || "Remote";
}

/* ====== Controls ====== */
async function toggleMic(){
  if (!localTracks.audio) return;
  const wasEnabled = localTracks.audio.isEnabled;
  const willEnable = !wasEnabled;
  await localTracks.audio.setEnabled(willEnable);

  const setBtnState = (btn, enabled) => {
    if (!btn) return;
    btn.style.backgroundColor = enabled ? 'rgba(179,102,249,0.9)' : 'rgba(255,80,80,1)';
    btn.setAttribute('aria-pressed', String(enabled));
    btn.title = enabled ? 'Toggle mic (currently ON)' : 'Toggle mic (currently OFF)';
  };

  setBtnState(micBtn, willEnable);
  if (audioMicBtn) setBtnState(audioMicBtn, willEnable);
  if (audioMicText) audioMicText.textContent = willEnable ? 'Mute' : 'Unmute';

  setAudioTileMuted('local', !willEnable);
}

async function toggleCam(){
  if (isAudioMode || !localTracks.video) return;
  const wasEnabled = localTracks.video.isEnabled;
  const willEnable = !wasEnabled;
  await localTracks.video.setEnabled(willEnable);

  if (camBtn){
    camBtn.style.backgroundColor = willEnable ? 'rgba(179,102,249,0.9)' : 'rgba(255,80,80,1)';
    camBtn.setAttribute('aria-pressed', String(willEnable));
    camBtn.title = willEnable ? 'Toggle camera (currently ON)' : 'Toggle camera (currently OFF)';
  }
}

async function leave(){
  try{
    Object.values(localTracks).forEach(t => { try{ t && t.stop(); t && t.close(); }catch{} });
    try{ await client.unpublish(); }catch{}
    try{ await client.leave(); }catch{}
  } finally {
    clearInterval(timerInt);
    window.location = "lobby.html";
  }
}

/* ====== Init / RTC flow ====== */
async function init(){
  if (isAudioMode){
    document.body.classList.add("audio-mode");
    if (audioUI) audioUI.hidden = false;
    const title = document.getElementById('call-title');
    if (title) title.textContent = `Audio call — ${displayName}`;
  }

  // Safari tends to prefer h264 for better HW decode
  client = AgoraRTC.createClient({ mode: "rtc", codec: isSafari ? "h264" : "vp8" });

  // Token renew handlers
  client.on("token-privilege-will-expire", async () => {
    try {
      const newToken = await fetchRtcToken({ channel: channelName, uid, role: "publisher" });
      await client.renewToken(newToken);
    } catch (e) { console.error("[token] renew failed:", e); }
  });
  client.on("token-privilege-did-expire", async () => {
    try {
      const newToken = await fetchRtcToken({ channel: channelName, uid, role: "publisher" });
      await client.renewToken(newToken);
    } catch (e) {
      console.error("[token] renew after expiry failed:", e);
      alert("Your session expired. Please rejoin.");
      window.location = "lobby.html";
    }
  });

  // Remote events
  client.on("user-published", async (user, mediaType) => {
    remoteUsers.set(user.uid, user);
    await client.subscribe(user, mediaType);

    if (mediaType === "video"){
      ensureRemoteTile(user.uid);
      try { user.videoTrack.play(`player-${user.uid}`); } catch {}
    }
    if (mediaType === "audio"){
      try { user.audioTrack.play(); }
      catch { showAudioUnlockOverlay(replayRemoteAudioTracks); }

      // Audio UI: either rich list (if #audio-list exists) or simple labels
      if (isAudioMode){
        if (audioList) {
          ensureAudioTile(user.uid, String(user.uid));
          setAudioTileMuted(user.uid, false);
        } else {
          setSimpleAudioLabels(String(user.uid));
        }
      }
    }
  });

  client.on("user-unpublished", (user, mediaType) => {
    if (mediaType === "video"){
      removeTile(user.uid);
    }
    if (mediaType === "audio" && isAudioMode){
      setAudioTileMuted(user.uid, true);
    }
  });

  client.on("user-left", (user) => {
    remoteUsers.delete(user.uid);
    removeTile(user.uid);
    if (isAudioMode) {
      if (audioList) removeAudioTile(user.uid);
      else setSimpleAudioLabels(null);
    }
  });

  // ===== Join with secure short-lived token =====
  const joinToken = await fetchRtcToken({ channel: channelName, uid, role: "publisher" });
  await client.join(APP_ID, channelName, joinToken, uid);

  if (isAudioMode){
    try{
      localTracks.audio = await AgoraRTC.createMicrophoneAudioTrack();
    }catch(e){
      console.error("Mic error:", e);
      alert("Microphone access denied or unavailable.");
      throw e;
    }
    await client.publish([localTracks.audio]);

    if (audioList) {
      ensureAudioTile('local', displayName);
      setAudioTileMuted('local', false);
    } else {
      setSimpleAudioLabels(null); // set local name; remote remains "Remote" until someone joins
    }

    if (client.enableAudioVolumeIndicator) client.enableAudioVolumeIndicator();
    client.on('volume-indicator', (volumes) => {
      volumes.forEach(v => {
        const level = (typeof v.level === 'number') ? v.level :
                      (typeof v.volumeLevel === 'number') ? v.volumeLevel : 0;
        const speaking = level > 0.06 || level > 6;
        const who = (String(v.uid) === String(uid)) ? 'local' : v.uid;
        setAudioTileSpeaking(who, speaking);
      });
    });

    startTimer();
    requestWakeLock();

    // Try to start any already-subscribed remote audio; fix autoplay on iOS if blocked
    try { await replayRemoteAudioTracks(); } catch { showAudioUnlockOverlay(replayRemoteAudioTracks); }

  } else {
    let mic, cam;
    try{
      [mic, cam] = await AgoraRTC.createMicrophoneAndCameraTracks(
        {},
        { encoderConfig: { width: 1280, height: 720, frameRate: 30 } }
      );
    }catch(e){
      console.error("Cam/Mic error:", e);
      alert("Camera/Microphone access denied or unavailable.");
      throw e;
    }
    localTracks.audio = mic;
    localTracks.video = cam;

    ensureLocalTile();
    cam.play(`player-local`);
    await client.publish([mic, cam]);

    requestWakeLock();
  }

  /* Wire controls */
  audioMicBtn?.addEventListener("click", (e)=>{ e.preventDefault(); toggleMic(); });
  micBtn?.addEventListener("click", toggleMic);
  camBtn?.addEventListener("click", toggleCam);

  leaveBtn?.addEventListener("click", (e)=>{ e.preventDefault(); leave(); });
  leaveBtn?.addEventListener("keydown", (e)=>{ if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); leave(); } });
  audioLeaveBtn?.addEventListener("click", (e)=>{ e.preventDefault(); leave(); });

  [micBtn, camBtn].forEach(btn => {
    btn?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        btn.id === 'mic-btn' ? toggleMic() : toggleCam();
      }
    });
  });

  window.addEventListener("beforeunload", leave);

  if (micBtn){ micBtn.setAttribute('aria-pressed','true'); micBtn.title = 'Toggle mic (currently ON)'; }
  if (camBtn && !isAudioMode){ camBtn.setAttribute('aria-pressed','true'); camBtn.title = 'Toggle camera (currently ON)'; }
  if (audioMicBtn){ audioMicBtn.setAttribute('aria-pressed','true'); audioMicBtn.title = 'Toggle mic (currently ON)'; }
}

/* ===== Kickoff ===== */
init().catch(err => {
  console.error("[RTC init] failed:", err);
  alert(`Failed to start call: ${err.message || err}`);
  window.location = "lobby.html";
});