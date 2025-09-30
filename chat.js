// chat.js — Secure PeerChat (Agora RTM channel chat)

// ---------- Config ----------
const APP_ID = "6774bd10adcd4974ae9d320147124bc5";
const TOKEN_API_BASE = "/api";   // same-origin (Vercel functions)
const ROOM_PASSWORD = null;      // if set on server, pass in header below

// ---------- Elements ----------
const $messages = document.getElementById("messages");
const $composer = document.getElementById("composer");
const $input    = document.getElementById("msg");
const $roomIdEl = document.getElementById("room-id");
const $connDot  = document.getElementById("conn-dot");
const $connText = document.getElementById("conn-text");

// ---------- Params & sanitization ----------
const params = new URLSearchParams(window.location.search);
const rawRoom = (params.get("room") || "").trim();
const rawName = (params.get("name") || "").trim();

// Allow Unicode letters/numbers plus . _ - and spaces; collapse spaces to dashes
function cleanRoom(s) {
  const t = (s || "")
    .replace(/[^\p{L}\p{N}._\-\s]/gu, "")  // keep letters/numbers/._- and spaces
    .trim()
    .replace(/\s+/g, "-");                 // turn spaces into hyphens
  // Require at least 1 char and max 64
  return t && t.length <= 64 ? t : "";
}

// UI name: allow Unicode letters/numbers/space/._- and cap length
function cleanName(s) {
  return (s || "").replace(/[^\p{L}\p{N}\s._-]/gu, "").slice(0, 30) || "";
}

const roomId = cleanRoom(rawRoom);
const displayName = cleanName(rawName) || `Guest-${Math.random().toString(36).slice(2,6)}`;

if (!roomId) {
  console.warn("Invalid room param:", rawRoom);  // helpful for debugging
  alert("Missing or invalid room code. Redirecting to lobby.");
  window.location = "lobby.html";
}


// ---------- State ----------
let client = null;
let channel = null;
let joined = false;
let rtmAccount = null; // server-assigned opaque id

// ---------- Avatar (UI only) ----------
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
    body: JSON.stringify({ type: "rtm", channel: channelName, name: displayName }) // name is optional/UI-only
  });
  if (!res.ok) throw new Error(`RTM token HTTP ${res.status}`);
  const data = await res.json(); // { token, account, expiresIn }
  if (!data?.token || !data?.account) throw new Error("Bad RTM token payload");
  return data;
}

// Prevent double init (hot reloads)
if (!window.__chatInit) {
  window.__chatInit = true;
  init();
} else {
  console.warn("Chat already initialized; skipping.");
}

// ---------- UI helpers ----------
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = String(text);
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
  $connDot.classList.remove("online", "offline", "reconnecting");
  $connDot.classList.add(state);
  $connText.textContent =
    state === "online" ? "Online" :
    state === "reconnecting" ? "Reconnecting…" : "Offline";
}

// ---------- Core ----------
async function init() {
  try {
    if (!window.AgoraRTM || typeof AgoraRTM.createInstance !== "function") {
      alert("Agora RTM SDK not loaded. Check <script> tag for AgoraRTM.");
      return (window.location = "lobby.html");
    }

    client = await AgoraRTM.createInstance(APP_ID);

    client.on("ConnectionStateChanged", (newState) => {
      setStatus(newState === "CONNECTED" ? "online" :
                newState === "RECONNECTING" ? "reconnecting" : "offline");
    });

    // Token lifecycle (renew on expiry/will-expire)
    const renew = async () => {
      try {
        const t = await fetchRtmToken();
        await client.renewToken(t.token);
        console.log("[chat] RTM token renewed");
      } catch (e) { console.error("[chat] RTM token renew failed:", e); }
    };
    client.on("TokenExpired", renew);
    if (client.onTokenPrivilegeWillExpire) client.on("TokenPrivilegeWillExpire", renew);

    // Login
    const { token, account } = await fetchRtmToken();
    rtmAccount = account;
    await client.login({ uid: rtmAccount, token });

    channel = client.createChannel(channelName);
    await channel.join();
    joined = true;
    setStatus("online");

    // Channel events
    channel.on("ChannelMessage", (message, memberId) => {
      let payload = {};
      try { payload = JSON.parse(message?.text || "{}"); }
      catch { payload = { text: message?.text || "" }; }
      const name = (payload.name && cleanName(payload.name)) || "Anonymous";
      const isMe = memberId === rtmAccount || payload.from === rtmAccount;
      appendMessage({
        who: isMe ? "me" : "them",
        name,
        avatarInit: payload.avatarInit || initials(name),
        avatarColor: payload.avatarColor || hashColor(name),
        text: String(payload.text || "")
      });
    });

    channel.on("MemberJoined",  (memberId) => appendSystem(`🟢 ${memberId} joined`));
    channel.on("MemberLeft",    (memberId) => appendSystem(`🔴 ${memberId} left`));

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
    from: rtmAccount,           // server-assigned identity
    name: displayName,          // UI-only display name
    avatarInit: myAvatar.init,
    avatarColor: myAvatar.color,
    text
  };

  try {
    // Optimistic UI
    appendMessage({ who: "me", name: payload.name, avatarInit: payload.avatarInit, avatarColor: payload.avatarColor, text: payload.text });
    $input.value = "";

    // Send to channel as JSON
    await channel.sendMessage({ text: JSON.stringify(payload) });
  } catch (err) {
    console.error("[chat] send failed", err);
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
  try { $composer.removeEventListener("submit", onSend); } catch {}
  try { if (channel && joined) await channel.leave(); } catch {}
  try { if (client) await client.logout(); } catch {}
  setStatus("offline");
}

// ---------- Optional: UI-only typing indicator ----------
let typingTimer = null;
$input.addEventListener("input", () => {
  $input.dataset.typing = "1";
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => { delete $input.dataset.typing; }, 1200);
});
