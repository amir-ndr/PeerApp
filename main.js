// main.js — Multi-user video & audio UI with Agora RTC, named tiles

const APP_ID = "6774bd10adcd4974ae9d320147124bc5";
let token = null; // set a valid RTC token if your app uses certificates

const params = new URLSearchParams(window.location.search);
const roomId = (params.get("room") || "").trim();
const rawMode = (params.get("mode") || "video").trim().toLowerCase();
const mode = (rawMode === "audio" || rawMode === "video") ? rawMode : "video";
const providedName = (params.get("name") || "").trim();
if (!roomId) window.location = "lobby.html";
const channelName = `call_${mode}_${roomId}`;

const isAudioMode = mode === "audio";

/* === Name/UID handling ===
   Agora supports string UIDs. We'll use the provided name if present;
   otherwise generate a short random guest ID.
*/
function makeGuestId() {
  return `Guest-${Math.random().toString(36).slice(2, 6)}`;
}
const displayName = providedName || makeGuestId();
// IMPORTANT: using the *name* as the RTC uid so peers see it as user.uid
const uid = displayName; // (string uid is OK)

/* ---- DOM refs ---- */
const audioUI       = document.getElementById("audio-call");
const audioList     = document.getElementById("audio-list");
const audioMicBtn   = document.getElementById("audio-mic");
const audioMicText  = document.getElementById("audio-mic-text");
const audioLeaveBtn = document.getElementById("audio-leave");

const grid   = document.getElementById("video-grid");
const camBtn = document.getElementById("camera-btn");
const micBtn = document.getElementById("mic-btn");
const leaveBtn = document.getElementById("leave-btn");

let client;
let localTracks = { audio: null, video: null };
const remoteUsers = new Map(); // uid -> user
const tiles = new Map();       // video tiles
const audioTiles = new Map();  // audio tiles

let timerInt = null;

/* ---- Timer ---- */
function startTimer(){
  const el = document.getElementById("call-timer");
  if (!el) return;
  const t0 = Date.now();
  timerInt = setInterval(() => {
    const s = Math.floor((Date.now()-t0)/1000);
    el.textContent = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
  }, 1000);
}

/* ---- Video tile helpers ---- */
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
  // remoteUid will be the *name string* if others did the same
  return makeTile(remoteUid, String(remoteUid));
}
function removeTile(id){
  const tile = tiles.get(id);
  if (tile && tile.parentNode) tile.parentNode.removeChild(tile);
  tiles.delete(id);
}

/* ---- Audio tile helpers ---- */
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

/* ---- Control handlers ---- */
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

/* ---- RTC flow ---- */
async function init(){
  if (isAudioMode){
    document.body.classList.add("audio-mode");
    if (audioUI) audioUI.hidden = false;
    // Update the title with your name
    const title = document.getElementById('call-title');
    if (title) title.textContent = `Audio call — ${displayName}`;
  }

  client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });

  client.on("user-published", async (user, mediaType) => {
    remoteUsers.set(user.uid, user);
    await client.subscribe(user, mediaType);

    if (mediaType === "video"){
      // Label with their *string uid* (the name)
      ensureRemoteTile(user.uid);
      user.videoTrack.play(`player-${user.uid}`);
    }
    if (mediaType === "audio"){
      user.audioTrack.play();
      if (isAudioMode){
        // For audio tiles, label with their *string uid* (the name)
        ensureAudioTile(user.uid, String(user.uid));
        setAudioTileMuted(user.uid, false);
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
    if (isAudioMode) removeAudioTile(user.uid);
  });

  // Join with your *name* as uid (string)
  await client.join(APP_ID, channelName, token, uid);

  if (isAudioMode){
    localTracks.audio = await AgoraRTC.createMicrophoneAudioTrack();
    await client.publish([localTracks.audio]);

    // Local tile in audio grid labeled with *your name*
    ensureAudioTile('local', displayName);
    setAudioTileMuted('local', false);

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
  } else {
    const [mic, cam] = await AgoraRTC.createMicrophoneAndCameraTracks(
      {},
      { encoderConfig: { width: 1280, height: 720, frameRate: 30 } }
    );
    localTracks.audio = mic;
    localTracks.video = cam;

    // Local video tile label with your name
    ensureLocalTile();
    cam.play(`player-local`);
    await client.publish([mic, cam]);
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

/* Kickoff */
init().catch(err => {
  console.error("[RTC init] failed:", err);
  alert(`Failed to start call: ${err.message || err}`);
  window.location = "lobby.html";
});
