// chat.js — Secure PeerChat (Agora RTM channel chat)

// ---------- Config ----------
const isFileLike = location.protocol === 'capacitor:' || location.protocol === 'file:';
const APP_ID = "6774bd10adcd4974ae9d320147124bc5";
const TOKEN_API_BASE = isFileLike
  ? 'https://peer-app-git-main-amirndrs-projects.vercel.app/api' // full origin when running from file:// / Capacitor
  : '/api';                                                      // same-origin in normal deploy
const ROOM_PASSWORD = null; // if set on server, passed via header below

// ---------- Elements (guard each so missing nodes don't crash) ----------
const $messages = document.getElementById("messages");
const $composer = document.getElementById("composer");
const $input    = document.getElementById("msg");
const $roomIdEl = document.getElementById("room-id");
const $connDot  = document.getElementById("conn-dot");
const $connText = document.getElementById("conn-text");

// ---------- Params & sanitization (Unicode-friendly) ----------
const params  = new URLSearchParams(window.location.search);
const rawRoom = (params.get("room") || "").trim();
const rawName = (params.get("name") || "").trim();

function cleanRoom(s) {
  const t = (s || "")
    .replace(/[^\p{L}\p{N}._\-\s]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
  return t && t.length <= 64 ? t : "";
}
function cleanName(s) {
  return (s || "").replace(/[^\p{L}\p{N}\s._-]/gu, "").slice(0, 30) || "";
}

const roomId = cleanRoom(rawRoom);
const displayName = cleanName(rawName) || `Guest-${Math.random().toString(36).slice(2,6)}`;

if (!roomId) {
  alert("Missing or invalid room code. Redirecting to lobby.");
  window.location = "lobby.html";
  // IMPORTANT: return so nothing else runs on this page
  throw new Error("no-room"); // stops script execution in some bundlers
}

const channelName = `chat_${roomId}`;
if ($roomIdEl) $roomIdEl.textContent = `${roomId} — ${displayName}`;

// ---------- State ----------
let client = null;
let channel = null;
let joined = false;
let rtmAccount = null; // server-assigned opaque id
let renewTimer = null; // optional proactive renew

// ---------- Avatar (UI only) ----------
function initials(s) {
  const parts = s.split(/\s+/).filter(Boolean);
  const a = (parts[0]?.[0] || "").toUpperCase();
  const b = (parts[1]?.[0] || "");
  return (a + b).toUpperCase();
}
function hashColor(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}deg, 60%, 55%)`;
}
const myAvatar = { name: displayName, init: initials(displayName), color: hashColor(displayName) };

// ---------- Token helpers ----------
function tokenUrl(path){
  const base = TOKEN_API_BASE.replace(/\/$/, "");
  return `${base}/${String(path || "").replace(/^\//, "")}`;
}
async function fetchRtmToken() {
  const res = await fetch(tokenUrl("token"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(ROOM_PASSWORD ? { "x-room-password": ROOM_PASSWORD } : {})
    },
    cache: "no-store",
    body: JSON.stringify({ type: "rtm", channel: channelName, name: displayName })
  });
  if (!res.ok) {
    const txt = await res.text().catch(()=>res.statusText);
    console.error("[chat] RTM token HTTP", res.status, txt);
    throw new Error(`RTM token HTTP ${res.status}`);
  }
  const data = await res.json(); // { token, account, expiresIn }
  if (!data?.token || !data?.account) throw new Error("Bad RTM token payload");
  return data;
}
function scheduleProactiveRenew(expiresIn) {
  clearTimeout(renewTimer);
  if (!expiresIn || !Number.isFinite(expiresIn)) return;
  const ms = Math.max(10_000, (expiresIn - 60) * 1000); // renew ~60s early
  renewTimer = setTimeout(async () => {
    try {
      const t = await fetchRtmToken();
      await client.renewToken(t.token);
      console.log("[chat] proactive RTM token renewed");
      if (t.expiresIn) scheduleProactiveRenew(t.expiresIn);
    } catch (e) {
      console.error("[chat] proactive RTM renew failed:", e);
    }
  }, ms);
}

// Prevent double init (hot reloads)
if (!window.__chatInit) {
  window.__chatInit = true;
  init();
} else {
  console.warn("[chat] Chat already initialized; skipping.");
}

// ---------- UI helpers ----------
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = String(text);
  return n;
}
function appendMessage({ who, name, avatarInit, avatarColor, text }) {
  if (!$messages) return;
  const wrap = el("div", `msg ${who}`);
  const head = el("div", "msg-head");
  const av = el("span", "msg-avatar", avatarInit || "👤");
  if (avatarColor) av.style.background = avatarColor;
  const nm = el("span", "msg-name", name || "Anonymous");
  head.appendChild(av);
  head.appendChild(nm);
  const body = el("div", "msg-body", text || "");
  wrap.appendChild(head);
  wrap.appendChild(body);
  $messages.appendChild(wrap);
  $messages.scrollTop = $messages.scrollHeight;
}
function appendSystem(text) {
  if (!$messages) return;
  const wrap = el("div", "msg sys", text);
  $messages.appendChild(wrap);
  $messages.scrollTop = $messages.scrollHeight;
}
function setStatus(state) {
  if ($connDot) {
    $connDot.classList.remove("online", "offline", "reconnecting");
    $connDot.classList.add(state);
  }
  if ($connText) {
    $connText.textContent =
      state === "online" ? "Online" :
      state === "reconnecting" ? "Reconnecting…" : "Offline";
  }
}

// ---------- Core ----------
async function init() {
  try {
    // 1) Make sure RTM SDK is on the page
    if (!window.AgoraRTM || typeof AgoraRTM.createInstance !== "function") {
      console.error("[chat] Agora RTM SDK not loaded (missing <script src='AgoraRTM_*.js'>)");
      alert("Agora RTM SDK not loaded. Check the <script> tag for AgoraRTM.");
      return;
    }

    // 2) Create client
    client = await AgoraRTM.createInstance(APP_ID);

    client.on("ConnectionStateChanged", (newState, reason) => {
      console.log("[chat] ConnectionStateChanged:", newState, reason);
      setStatus(newState === "CONNECTED" ? "online" :
                newState === "RECONNECTING" ? "reconnecting" : "offline");
    });

    // 3) Login with RTM token
    const { token, account, expiresIn } = await fetchRtmToken();
    rtmAccount = account;
    await client.login({ uid: rtmAccount, token });
    if (expiresIn) scheduleProactiveRenew(expiresIn);

    // 4) Join channel
    channel = client.createChannel(channelName);
    await channel.join();
    joined = true;
    setStatus("online");
    appendSystem(`Joined chat room: ${channelName}`);

    // 5) Renew token automatically (SDK-driven)
    const renew = async () => {
      try {
        const t = await fetchRtmToken();
        await client.renewToken(t.token);
        console.log("[chat] RTM token renewed");
        if (t.expiresIn) scheduleProactiveRenew(t.expiresIn);
      } catch (e) {
        console.error("[chat] RTM token renew failed:", e);
        appendSystem("⚠️ Token renewal failed; attempting reconnection…");
      }
    };
    client.on("TokenExpired", renew);
    if (client.onTokenPrivilegeWillExpire) client.on("TokenPrivilegeWillExpire", renew);

    // 6) Events
    channel.on("ChannelMessage", (message, memberId) => {
      let payload = {};
      try { payload = JSON.parse(message?.text || "{}"); }
      catch { payload = { text: message?.text || "" }; }
      const safeName = (payload.name && cleanName(payload.name)) || "Anonymous";
      const isMe = memberId === rtmAccount || payload.from === rtmAccount;
      appendMessage({
        who: isMe ? "me" : "them",
        name: safeName,
        avatarInit: payload.avatarInit || initials(safeName),
        avatarColor: payload.avatarColor || hashColor(safeName),
        text: String(payload.text || "")
      });
    });

    channel.on("MemberJoined",  (memberId) => appendSystem(`🟢 ${memberId} joined`));
    channel.on("MemberLeft",    (memberId) => appendSystem(`🔴 ${memberId} left`));

    // 7) Send handler
    if ($composer) $composer.addEventListener("submit", onSend);

    // 8) Clean up
    window.addEventListener("beforeunload", cleanup);

  } catch (err) {
    console.error("[chat] init failed:", err);
    alert(`Failed to join chat (${err.message || err}). Check your room in the URL and token API.`);
  }
}

async function onSend(e) {
  e.preventDefault();
  const text = ($input?.value || "").trim();
  if (!text) return;
  if (!joined || !channel) {
    appendSystem("⚠️ Not connected yet. Please wait…");
    return;
  }

  const payload = {
    from: rtmAccount,
    name: displayName,
    avatarInit: myAvatar.init,
    avatarColor: myAvatar.color,
    text
  };

  try {
    appendMessage({ who: "me", name: payload.name, avatarInit: payload.avatarInit, avatarColor: payload.avatarColor, text: payload.text });
    if ($input) $input.value = "";
    await channel.sendMessage({ text: JSON.stringify(payload) });
  } catch (err) {
    console.error("[chat] send failed:", err);
    appendSystem("⚠️ Message failed to send. Retrying…");
    try {
      await channel.sendMessage({ text: JSON.stringify(payload) });
      appendSystem("✅ Delivered on retry");
    } catch {
      appendSystem("❌ Still failed. Check your connection.");
    }
  }
}

async function cleanup() {
  clearTimeout(renewTimer);
  try { if ($composer) $composer.removeEventListener("submit", onSend); } catch {}
  try { if (channel && joined) await channel.leave(); } catch {}
  try { if (client) await client.logout(); } catch {}
  setStatus("offline");
}

// ---------- Optional: UI-only typing indicator ----------
let typingTimer = null;
if ($input) {
  $input.addEventListener("input", () => {
    $input.dataset.typing = "1";
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => { delete $input.dataset.typing; }, 1200);
  });
}
