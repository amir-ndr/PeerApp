// api/token.js
const { RtcTokenBuilder, RtcRole, RtmTokenBuilder } = require("agora-access-token");
const crypto = require("crypto");

const APP_ID        = process.env.AGORA_APP_ID;
const APP_CERT      = process.env.AGORA_APP_CERTIFICATE;
const APP_ORIGIN    = process.env.APP_ORIGIN;          // e.g. "https://peer-app.example" (optional if using list)
const ORIGIN_LIST   = (process.env.APP_ORIGIN_LIST || "").split(",").map(s => s.trim()).filter(Boolean);
const ROOM_PASSWORD = process.env.ROOM_PASSWORD || "";
const TTL_SECONDS   = Number(process.env.TOKEN_TTL_SECONDS || 3600);
const PROD_ONLY     = process.env.TOKEN_PROD_ONLY !== "false"; // default true

const CHAN_RE = /^[A-Za-z0-9._-]{3,64}$/;

module.exports.config = { runtime: "nodejs" };

module.exports = async function handler(req, res) {
  try {
    // ---- CORS ----
    const origin = req.headers.origin || "";
    const allow =
      (APP_ORIGIN && origin === APP_ORIGIN) ||
      (ORIGIN_LIST.length && ORIGIN_LIST.includes(origin));
    if (allow) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");

    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "content-type, x-room-password");
      return res.status(204).end();
    }

    // ---- Method / env guards ----
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

    // ---- Security headers ----
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Security-Policy", "default-src 'none'");

    // ---- Parse JSON ----
    const body = await readJSON(req);
    const type = String(body?.type || "rtc").toLowerCase();
    const channel = String(body?.channel || "").trim();

    // Optional shared secret
    if (ROOM_PASSWORD) {
      const pass = req.headers["x-room-password"] || body?.pw || "";
      if (pass !== ROOM_PASSWORD) return res.status(401).json({ error: "unauthorized" });
    }

    const now = Math.floor(Date.now() / 1000);
    const expireTs = now + TTL_SECONDS;

    // ===== RTM =====
    if (type === "rtm") {
      const account = crypto.randomUUID();
      const token = RtmTokenBuilder.buildToken(APP_ID, APP_CERT, account, expireTs);
      return res.status(200).json({ type: "rtm", token, account, expiresIn: TTL_SECONDS });
    }

    // ===== RTC =====
    if (!CHAN_RE.test(channel)) {
      return res.status(400).json({ error: "bad_channel" });
    }

    const uid = crypto.randomInt(1, 2 ** 31 - 2);
    const role = RtcRole.PUBLISHER;

    const token = RtcTokenBuilder.buildTokenWithUid(APP_ID, APP_CERT, channel, uid, role, expireTs);
    return res.status(200).json({ type: "rtc", token, uid, expiresIn: TTL_SECONDS });

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
      catch { resolve({}); }  // <- be forgiving; treat as empty object
    });
    req.on("error", reject);
  });
}
