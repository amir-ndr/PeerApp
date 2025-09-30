// chat.js — Secure PeerChat (Agora RTM channel chat) — FIXED Unicode room + POST tokens

// ---------- Config ----------
const APP_ID = "6774bd10adcd4974ae9d320147124bc5";
const TOKEN_API_BASE = isFileLike
  ? 'https://peer-app-git-main-amirndrs-projects.vercel.app/api'   // 👈 your deployed site’s /api
  : '/api';
const ROOM_PASSWORD = null;      // if set on server, passed via header below

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

// Allow Unicode letters/numbers + . _ - and spaces; collapse spaces to "-"
function cleanRoom(s) {
  // Keep letters, numbers, dot, underscore, hyphen, spaces
  const t = (s || "")
    .replace(/[^\p{L}\p{N}._\-\s]/gu, "")
    .trim()
    .replace(/\s+/g, "-"); // spaces -> hyphen
  // Require 1..64 chars
  return t && t.length <= 64 ? t : "";
}

// UI name: allow Unicode letters/numbers/space/._- and cap length
function cleanName(s) {
  return (s || "").replace(/[^\p{L}\p{N}\s._-]/gu, "").slice(0, 30) || "";
}

const roomId = cleanRoom(rawRoom);
const displayName = cleanName(rawName) || `Guest-${Math.random().toString(36).slice(2,6)}`;

if (!roomId) {
  console.warn("[chat] Invalid room param:", rawRoom);
  // Don’t hard redirect; show a friendly tip:
  if ($roomIdEl) $roomIdEl.textContent = "Invalid room code";
  alert("Missing or invalid room code in URL. Example:\n/chat.html?room=شهسوار-123&name=Amir");
  // If you prefer redirect, uncomment:
  // window.location = "lobby.html";
}

// Channel name (separate namespace from RTC call)
// NOTE: Agora RTM allows Unicode for channel IDs; this is a client-side name.
// If your server validates channels, ensure it matches your server rule as well.
const channelName = roomId ? `chat_${roomId}` : "";

// Reflect room/name in UI if possible
if ($roomIdEl && roomId) $roomIdEl.textContent = `${roomId} — ${displayName}`;

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
  if (!channelName) throw new Error("No channel name (room missing)");
  const res = await fetch(tokenUrl("token"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(ROOM_PASSWORD ? { "x-room-password": ROOM_PASSWORD } : {})
    },
    cache: "no-store",
    body: JSON.stringify({ type: "rtm", channel: channelName, name: displayName }) // name is UI-only (optional)
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
    if (!roomId) return; // handled above
    if (!window.AgoraRTM || typeof AgoraRTM.createInstance !== "function") {
      alert("Agora RTM SDK not loaded. Check the <script> tag for AgoraRTM.");
      // window.location = "lobby.html"; // optional
      return;
    }

    client = await AgoraRTM.createInstance(APP_ID);

    client.on("ConnectionStateChanged", (newState, reason) => {
      console.log("[chat] ConnectionStateChanged:", newState, reason);
      setStatus(newState === "CONNECTED" ? "online" :
                newState === "RECONNECTING" ? "reconnecting" : "offline");
    });

    // Token lifecycle (renew on expiry/will-expire)
    const renew = async () => {
      try {
        const t = await fetchRtmToken();
        await client.renewToken(t.token);
        console.log("[chat] RTM token renewed");
      } catch (e) {
        console.error("[chat] RTM token renew failed:", e);
        appendSystem("⚠️ Token renewal failed; attempting reconnection…");
      }
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

    // Send handler
    if ($composer) $composer.addEventListener("submit", onSend);

    // Clean up
    window.addEventListener("beforeunload", cleanup);

    appendSystem(`Joined chat room: ${channelName}`);
  } catch (err) {
    console.error("[chat] init failed:", err);
    alert(`Failed to join chat (${err.message || err}). Check your room in the URL.`);
    // window.location = "lobby.html"; // optional
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
    from: rtmAccount,           // server-assigned identity
    name: displayName,          // UI-only display name
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
    if ($input) $input.value = "";

    // Send to channel as JSON
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
