// api/token.js
// Secure token issuer for Agora RTC + RTM
// - POST JSON only (no secrets in URLs)
// - Strict CORS (single allowed origin)
// - Server-generated identities (no trusting client uid/role)
// - Short-lived tokens
// - Optional room password
// - Preview guard for production-only issuance

const { RtcTokenBuilder, RtcRole, RtmTokenBuilder } = require("agora-access-token");
const crypto = require("crypto");

// ---- Env (set in Vercel Project Settings) ----
const APP_ID        = process.env.AGORA_APP_ID;
const APP_CERT      = process.env.AGORA_APP_CERTIFICATE;
const APP_ORIGIN    = process.env.APP_ORIGIN;          // e.g. "https://peer-app.example"
const ROOM_PASSWORD = process.env.ROOM_PASSWORD || ""; // optional shared secret
const TTL_SECONDS   = Number(process.env.TOKEN_TTL_SECONDS || 120);
const PROD_ONLY     = process.env.TOKEN_PROD_ONLY !== "false"; // default true

// Channel allowlist pattern (adjust if needed)
const CHAN_RE = /^[A-Za-z0-9._-]{3,64}$/;

module.exports.config = { runtime: "nodejs" };

module.exports = async function handler(req, res) {
  try {
    // -------- CORS / preflight --------
    const origin = req.headers.origin || "";
    if (APP_ORIGIN && origin === APP_ORIGIN) {
      res.setHeader("Access-Control-Allow-Origin", APP_ORIGIN);
    }
    res.setHeader("Vary", "Origin");

    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "content-type, x-room-password");
      return res.status(204).end();
    }

    // -------- Method / env guards --------
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      return res.status(405).json({ error: "method_not_allowed" });
    }
    if (PROD_ONLY && process.env.VERCEL_ENV !== "production") {
      return res.status(403).json({ error: "forbidden_env" });
    }
    if (!APP_ID || !APP_CERT) {
      return res.status(500).json({ error: "server_not_configured" });
    }

    // -------- Security headers --------
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    // -------- Parse JSON --------
    const body = await readJSON(req);
    const type = String(body?.type || "rtc").toLowerCase(); // "rtc" | "rtm"
    const channel = String(body?.channel || "").trim();

    // Optional shared secret (prefer header to avoid logs)
    if (ROOM_PASSWORD) {
      const pass = req.headers["x-room-password"] || body?.pw || "";
      if (pass !== ROOM_PASSWORD) return res.status(401).json({ error: "unauthorized" });
    }

    const now = Math.floor(Date.now() / 1000);
    const expireTs = now + TTL_SECONDS;

    // ===== RTM token (chat) =====
    if (type === "rtm") {
      // Generate an opaque account id (do NOT trust client ids)
      const account = crypto.randomUUID();
      const token = RtmTokenBuilder.buildToken(APP_ID, APP_CERT, account, expireTs);
      return res.status(200).json({ type: "rtm", token, account, expiresIn: TTL_SECONDS });
    }

    // ===== RTC token (audio/video call) =====
    if (!CHAN_RE.test(channel)) {
      return res.status(400).json({ error: "bad_channel" });
    }

    // Server-generated integer UID (Agora RTC requires 32-bit int)
    const uid = crypto.randomInt(1, 2 ** 31 - 2);
    const role = RtcRole.PUBLISHER; // pin the role server-side

    const token = RtcTokenBuilder.buildTokenWithUid(APP_ID, APP_CERT, channel, uid, role, expireTs);
    return res.status(200).json({ type: "rtc", token, uid, expiresIn: TTL_SECONDS });

  } catch (e) {
    console.error("token_error:", e);
    return res.status(500).json({ error: "token_generation_failed" });
  }
};

// ---- helpers ----
async function readJSON(req) {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}
