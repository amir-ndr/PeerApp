// chat.js — PeerChat (Agora RTM channel chat with name + avatar), with Vercel RTM tokens

// ---------- Config ----------
const APP_ID = "6774bd10adcd4974ae9d320147124bc5";
// If your token function lives in the same Vercel project as the frontend, keep "/api"
const TOKEN_API_BASE = "/api";
// Optional shared password (if you set ROOM_PASSWORD in the function). We pass via query to avoid CORS preflight.
const ROOM_PASSWORD = null;

// ---------- Elements ----------
const $messages = document.getElementById("messages");
const $composer = document.getElementById("composer");
const $input    = document.getElementById("msg");
const $roomIdEl = document.getElementById("room-id");
const $connDot  = document.getElementById("conn-dot");
const $connText = document.getElementById("conn-text");

// ---------- Params ----------
const params = new URLSearchParams(window.location.search);
const roomId = (params.get("room") || "").trim();
const displayNameParam = (params.get("name") || "").trim();
const displayName = displayNameParam || `Guest-${Math.random().toString(36).slice(2,6)}`;
const uid = displayName; // use same string ID as your call app

if (!roomId) {
  alert("Missing room code. Redirecting to lobby.");
  window.location = "lobby.html";
}
$roomIdEl.textContent = `${roomId} — ${displayName}`;

// Channel name is separate from call channels
const channelName = `chat_${roomId}`;

// ---------- State ----------
let client = null;
let channel = null;
let joined = false;

// ---------- Avatar (initials + deterministic color from name) ----------
function initials(s) {
  const parts = s.split(/\s+/).filter(Boolean);
  const a = (parts[0]?.[0] || "").toUpperCase();
  const b = (parts[1]?.[0] || "");
  return (a + b).toUpperCase();
}
function hashColor(s) {
  let h = 0;
  for (let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}deg, 60%, 55%)`;
}
const myAvatar = { name: displayName, init: initials(displayName), color: hashColor(displayName) };

// ---------- Token helpers ----------
function tokenUrl(path){
  const base = TOKEN_API_BASE.replace(/\/$/, "");
  const p = String(path || "").replace(/^\//, "");
  return `${base}/${p}`;
}

async function fetchRtmToken({ uid }){
  const qs = new URLSearchParams({ type: "rtm", uid });
  if (ROOM_PASSWORD) qs.set("pw", ROOM_PASSWORD);
  const url = `${tokenUrl("token")}?${qs.toString()}`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const msg = await res.text().catch(()=>res.statusText);
    throw new Error(`RTM token HTTP ${res.status} ${msg}`);
  }
  const data = await res.json();
  if (!data?.token) throw new Error("No RTM token returned");
  return data.token;
}

// Prevent double init (hot reloads)
if (window.__chatInit) {
  console.warn("Chat already initialized; skipping.");
} else {
  window.__chatInit = true;
  init();
}

// ---------- UI helpers ----------
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function appendMessage({ who, name, avatarInit, avatarColor, text }) {
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
  const wrap = el("div", "msg sys", text);
  $messages.appendChild(wrap);
  $messages.scrollTop = $messages.scrollHeight;
}

function setStatus(state) {
  // state: 'online' | 'offline' | 'reconnecting'
  $connDot.classList.remove("online", "offline", "reconnecting");
  $connDot.classList.add(state);
  $connText.textContent =
    state === "online" ? "Online" :
    state === "reconnecting" ? "Reconnecting…" :
    "Offline";
}

// ---------- Core ----------
async function init() {
  try {
    console.log("[chat] start", { roomId, channelName, uid, displayName });

    // RTM SDK presence check
    if (!window.AgoraRTM || typeof AgoraRTM.createInstance !== "function") {
      alert("Agora RTM SDK not loaded. Check <script> tag for AgoraRTM.");
      return (window.location = "lobby.html");
    }

    client = await AgoraRTM.createInstance(APP_ID);

    // Connection state UI
    client.on("ConnectionStateChanged", (newState, reason) => {
      console.log("[chat] state:", newState, "reason:", reason);
      if (newState === "CONNECTED") setStatus("online");
      else if (newState === "RECONNECTING") setStatus("reconnecting");
      else setStatus("offline");
    });

    // Token lifecycle (auto-renew)
    const renew = async () => {
      try {
        const t = await fetchRtmToken({ uid });
        await client.renewToken(t);
        console.log("[chat] RTM token renewed");
      } catch (e) {
        console.error("[chat] RTM token renew failed:", e);
      }
    };
    // Older RTM SDKs fire only TokenExpired; newer add TokenPrivilegeWillExpire
    client.on("TokenExpired", renew);
    if (client.onTokenPrivilegeWillExpire) client.on("TokenPrivilegeWillExpire", renew);

    // Login with RTM token
    const rtmToken = await fetchRtmToken({ uid });
    if (!rtmToken || rtmToken.length < 10) throw new Error("Invalid RTM token");
    await client.login({ uid, token: rtmToken });

    channel = client.createChannel(channelName);
    await channel.join();
    joined = true;
    setStatus("online");

    // Events
    channel.on("ChannelMessage", (message, memberId) => {
      let payload = {};
      try {
        payload = JSON.parse(message?.text || "{}");
      } catch {
        payload = { text: message?.text || "" };
      }
      const isMe = memberId === uid || payload.from === uid;
      const name = payload.name || memberId;
      appendMessage({
        who: isMe ? "me" : "them",
        name,
        avatarInit: payload.avatarInit || initials(name),
        avatarColor: payload.avatarColor || hashColor(name),
        text: payload.text || ""
      });
    });

    channel.on("MemberJoined", (memberId) => {
      appendSystem(`🟢 ${memberId} joined`);
    });

    channel.on("MemberLeft", (memberId) => {
      appendSystem(`🔴 ${memberId} left`);
    });

    // Send handler
    $composer.addEventListener("submit", onSend);

    // Clean up
    window.addEventListener("beforeunload", cleanup);

    appendSystem(`Joined chat room: ${channelName}`);
  } catch (err) {
    console.error("[chat] init failed", err);
    alert(`Failed to join chat (${err.message || err}). Returning to lobby.`);
    window.location = "lobby.html";
  }
}

async function onSend(e) {
  e.preventDefault();
  const text = ($input.value || "").trim();
  if (!text) return;

  if (!joined || !channel) {
    appendSystem("⚠️ Not connected yet. Please wait…");
    return;
  }

  const payload = {
    from: uid,
    name: displayName,
    avatarInit: myAvatar.init,
    avatarColor: myAvatar.color,
    text
  };

  try {
    // Optimistic UI
    appendMessage({
      who: "me",
      name: payload.name,
      avatarInit: payload.avatarInit,
      avatarColor: payload.avatarColor,
      text: payload.text
    });
    $input.value = "";

    // Send to channel as JSON
    await channel.sendMessage({ text: JSON.stringify(payload) });
  } catch (err) {
    console.error("[chat] send failed", err);
    appendSystem("⚠️ Message failed to send. Retrying…");
    try {
      await channel.sendMessage({ text: JSON.stringify(payload) });
      appendSystem("✅ Delivered on retry");
    } catch (e2) {
      appendSystem("❌ Still failed. Check your connection.");
    }
  }
}

async function cleanup() {
  try {
    $composer.removeEventListener("submit", onSend);
    if (channel && joined) await channel.leave();
  } catch {}
  try {
    if (client) await client.logout();
  } catch {}
  setStatus("offline");
}

// ---------- Optional: UI-only typing indicator ----------
let typingTimer = null;
$input.addEventListener("input", () => {
  $input.dataset.typing = "1";
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => { delete $input.dataset.typing; }, 1200);
});
