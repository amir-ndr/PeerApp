// put this at the very top of main.js and use TOKEN_API_BASE below
const isFileLike = location.protocol === 'capacitor:' || location.protocol === 'file:';
const TOKEN_API_BASE = isFileLike
  ? 'https://peer-app-git-main-amirndrs-projects.vercel.app/api'   // 👈 your deployed site’s /api
  : '/api';

const APP_ID = "6774bd10adcd4974ae9d320147124bc5";
// const TOKEN_API_BASE = "/api";
// Optional: if you set ROOM_PASSWORD in the token function, put the same here.
// We pass it via query string to AVOID CORS preflight.
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
const audioList     = document.getElementById("audio-list");
const audioMicBtn   = document.getElementById("audio-mic");
const audioMicText  = document.getElementById("audio-mic-text");
const audioLeaveBtn = document.getElementById("audio-leave");

const grid   = document.getElementById("video-grid");
const camBtn = document.getElementById("camera-btn");
const micBtn = document.getElementById("mic-btn");
const leaveBtn = document.getElementById("leave-btn");

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

/* ====== Helpers ====== */
function tokenUrl(path){
  const base = TOKEN_API_BASE.replace(/\/$/, "");
  const p = String(path || "").replace(/^\//, "");
  return `${base}/${p}`;
}

/* ====== Token fetch/renew ====== */
// Replace your old fetchRtcToken with this:
function tokenUrl(path){
  const base = TOKEN_API_BASE.replace(/\/$/, "");
  const p = String(path || "").replace(/^\//, "");
  return `${base}/${p}`;
}

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
  const data = await res.json(); // { token, uid, expiresIn }
  if (!data?.token || typeof data?.uid !== "number") throw new Error("Bad token payload");
  return data;
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
  if (!audioList) return null;
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

/* ====== Fallback 2-avatar labels ====== */
function setSimpleAudioLabels(remoteName){
  if (localLabelEl)  localLabelEl.textContent  = displayName;
  if (remoteLabelEl) remoteLabelEl.textContent = remoteName || "Remote";
}

/* ====== Controls ====== */
// keep these at top-level state
let micOn = false;
let camOn = false;

function updateMicUI(on){
  const setBtn = (btn, on2) => {
    if (!btn) return;
    btn.style.backgroundColor = on2 ? 'rgba(179,102,249,0.9)' : 'rgba(255,80,80,1)';
    btn.setAttribute('aria-pressed', String(on2));
    btn.title = on2 ? 'Toggle mic (currently ON)' : 'Toggle mic (currently OFF)';
  };
  setBtn(micBtn, on);
  setBtn(audioMicBtn, on);
  if (audioMicText) audioMicText.textContent = on ? 'Mute' : 'Unmute';
  setAudioTileMuted('local', !on);
}

function updateCamUI(on){
  if (!camBtn) return;
  camBtn.style.backgroundColor = on ? 'rgba(179,102,249,0.9)' : 'rgba(255,80,80,1)';
  camBtn.setAttribute('aria-pressed', String(on));
  camBtn.title = on ? 'Toggle camera (currently ON)' : 'Toggle camera (currently OFF)';
}

async function toggleMic(){
  const track = localTracks.audio;
  if (!track) { console.warn("mic not ready"); return; }

  const next = !micOn;                 // desired ON state
  try {
    if (typeof track.setMuted === 'function') {
      await track.setMuted(!next);     // setMuted(true) => muted
    } else if (typeof track.setEnabled === 'function') {
      await track.setEnabled(next);    // fallback
    }
    micOn = next;
    updateMicUI(micOn);
  } catch (e) {
    console.error("toggleMic failed:", e);
  }
}

async function toggleCam(){
  const track = localTracks.video;
  if (isAudioMode || !track) { console.warn("cam not ready or audio mode"); return; }

  const next = !camOn;                 // desired ON state
  try {
    if (typeof track.setEnabled === 'function') {
      await track.setEnabled(next);    // preferred
    } else if (typeof track.setMuted === 'function') {
      await track.setMuted(!next);     // fallback
    }
    camOn = next;
    updateCamUI(camOn);
  } catch (e) {
    console.error("toggleCam failed:", e);
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
  if (window.__peerInit) return;   // guard
  window.__peerInit = true;
  if (isAudioMode){
    document.body.classList.add("audio-mode");
    if (audioUI) audioUI.hidden = false;
    const title = document.getElementById('call-title');
    if (title) title.textContent = `Audio call — ${displayName}`;
  }

  // Safari prefers h264 for HW decode
  client = AgoraRTC.createClient({ mode: "rtc", codec: isSafari ? "h264" : "vp8" });
  
  client.on("connection-state-change", (cur, prev, reason) => {
    console.log("[rtc] state", prev, "->", cur, "reason:", reason);
    const barId = "net-banner";
    let bar = document.getElementById(barId);
    if (cur === "DISCONNECTED" || cur === "RECONNECTING") {
      if (!bar){
        bar = document.createElement("div");
        bar.id = barId;
        bar.style.cssText = "position:fixed;top:0;left:0;right:0;padding:8px 12px;background:#2b2f3a;color:#ffd863;text-align:center;z-index:9999;font-weight:600";
        document.body.appendChild(bar);
      }
      bar.textContent = (cur === "RECONNECTING") ? "Reconnecting…" : "Disconnected";
    } else {
      bar?.remove();
    }
  });
  

  // Token renew handlers
  client.on("token-privilege-will-expire", async () => {
    try {
      const { token } = await fetchRtcToken({ channel: channelName });
      await client.renewToken(token);  // <-- pass string
      console.log("[rtc] token renewed before expiry");
    } catch (e) {
      console.error("[rtc] token renew failed (will-expire):", e);
    }
  });
  
  client.on("token-privilege-did-expire", async () => {
    try {
      const { token } = await fetchRtcToken({ channel: channelName });
      await client.renewToken(token);  // <-- pass string
      console.log("[rtc] token renewed after expiry");
    } catch (e) {
      console.error("[rtc] token renew failed (did-expire):", e);
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

  // ===== Fetch token & join =====
  const { token: joinToken, uid: serverUid } = await fetchRtcToken({ channel: channelName });
  await client.join(APP_ID, channelName, joinToken, serverUid);

  if (isAudioMode){
    try{
      localTracks.audio = await AgoraRTC.createMicrophoneAudioTrack({
        AEC: true, ANS: true, AGC: true    // (echo cancel, noise suppress, auto gain)
      });
      micOn = true;
      updateMicUI(true);
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
      setSimpleAudioLabels(null);
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
    micOn = true;
    camOn = true;
    updateMicUI(true);
    updateCamUI(true);

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
// init().catch(err => {
//   console.error("[RTC init] failed:", err);
//   alert(`Failed to start call: ${err.message || err}`);
//   window.location = "lobby.html";
// });

(async () => {
  try { await init(); }
  catch (e) {
    await new Promise(r => setTimeout(r, 600));
    try { await init(); }
    catch { window.location.replace("lobby.html"); }
  }
})();