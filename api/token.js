// api/token.js
const { RtcTokenBuilder, RtcRole } = require("agora-access-token");
const crypto = require("crypto");

// Config
const APP_ID  = process.env.AGORA_APP_ID;
const APP_CERT = process.env.AGORA_APP_CERTIFICATE;
const APP_ORIGIN = process.env.APP_ORIGIN; // e.g. "https://peer-app.example"
const ROOM_PASSWORD = process.env.ROOM_PASSWORD || null;
const TTL_SECONDS = Number(process.env.TOKEN_TTL_SECONDS || 120);
const PROD_ONLY = true;

// Simple allowlist for channels (optional)
const ALLOW_CHANNEL_RE = /^[A-Za-z0-9._-]{3,64}$/;

module.exports.config = { runtime: "nodejs" };

module.exports = async function handler(req, res) {
  try {
    if (PROD_ONLY && process.env.VERCEL_ENV !== "production") {
      return res.status(403).json({ error: "forbidden_env" });
    }

    // CORS / preflight
    const origin = req.headers.origin || "";
    if (APP_ORIGIN && origin === APP_ORIGIN) {
      res.setHeader("Access-Control-Allow-Origin", APP_ORIGIN);
    }
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      return res.status(204).end();
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      return res.status(405).json({ error: "method_not_allowed" });
    }

    if (!APP_ID || !APP_CERT) {
      return res.status(500).json({ error: "server_not_configured" });
    }

    // Security headers
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    // Parse JSON
    const body = await readJSON(req);
    const channel = String(body?.channel || "").trim();

    // Optional room password check (header preferred to avoid logs)
    if (ROOM_PASSWORD) {
      const pass = req.headers["x-room-password"] || body?.pw || null;
      if (pass !== ROOM_PASSWORD) {
        return res.status(401).json({ error: "unauthorized" });
      }
    }

    // Validate channel
    if (!ALLOW_CHANNEL_RE.test(channel)) {
      return res.status(400).json({ error: "bad_channel" });
    }

    // Server-generated UID and pinned role
    const uid = crypto.randomInt(1, 2 ** 31 - 2); // Agora UID must be 32-bit int
    const role = RtcRole.PUBLISHER; // or SUBSCRIBER if you segment roles server-side

    // Short-lived token
    const now = Math.floor(Date.now() / 1000);
    const expireTs = now + TTL_SECONDS;

    const token = RtcTokenBuilder.buildTokenWithUid(
      APP_ID, APP_CERT, channel, uid, role, expireTs
    );

    // (Optional) basic rate limit (pseudo: plug your KV/Redis here)
    // await assertNotRateLimited(req, res);

    return res.status(200).json({
      type: "rtc",
      token,
      uid,           // client uses this UID when joining
      expiresIn: TTL_SECONDS
    });

  } catch (e) {
    console.error("token_error:", e);
    return res.status(500).json({ error: "token_generation_failed" });
  }
};

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
