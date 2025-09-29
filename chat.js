// chat.js — PeerChat (Agora RTM channel chat with name + avatar)

// ---------- Config ----------
const APP_ID = "6774bd10adcd4974ae9d320147124bc5";
let token = null; // if certificates are ON, replace with a valid RTM token

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
const displayName = (params.get("name") || "Guest").trim();

if (!roomId) {
  alert("Missing room code. Redirecting to lobby.");
  window.location = "lobby.html";
}

$roomIdEl.textContent = `${roomId} — ${displayName}`;

// Channel name is separate from call channels
const channelName = `chat_${roomId}`;

// ---------- State ----------
const uid = String(Math.floor(Math.random() * 10000));
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

    // SDK presence check (defensive)
    if (!window.AgoraRTM || typeof AgoraRTM.createInstance !== "function") {
      alert("Agora RTM SDK not loaded. Check <script> tag.");
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

    await client.login({ uid, token });

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
      appendMessage({
        who: isMe ? "me" : "them",
        name: payload.name || memberId,
        avatarInit: payload.avatarInit || initials(payload.name || memberId),
        avatarColor: payload.avatarColor || hashColor(payload.name || memberId),
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
    // simple retry once
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
