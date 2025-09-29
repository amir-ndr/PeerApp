// api/token.js — Vercel Serverless Function (Node runtime, CJS)
const { RtcTokenBuilder, RtcRole } = require("agora-access-token");

// Force Node runtime
module.exports.config = { runtime: "nodejs" };

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "method_not_allowed" });
    }

    const REQUIRED_PASS = process.env.ROOM_PASSWORD || null;
    if (REQUIRED_PASS) {
      const pass = req.headers["x-room-password"] || req.query.pw;
      if (pass !== REQUIRED_PASS) return res.status(401).json({ error: "unauthorized" });
    }

    const appId = process.env.AGORA_APP_ID;
    const cert  = process.env.AGORA_APP_CERTIFICATE;
    if (!appId || !cert) return res.status(500).json({ error: "server_not_configured" });

    const channel = (req.query.channel || "").trim();
    const uid     = (req.query.uid || "").trim();
    const roleQ   = (req.query.role || "publisher").toLowerCase();
    const role    = roleQ === "audience" ? RtcRole.SUBSCRIBER : RtcRole.PUBLISHER;

    if (!channel || !uid) return res.status(400).json({ error: "channel_and_uid_required" });
    if (channel.length > 64 || uid.length > 64) return res.status(400).json({ error: "invalid_input" });

    const now = Math.floor(Date.now() / 1000);
    const expireTs = now + Number(process.env.TOKEN_TTL_SECONDS || 120);

    const token = RtcTokenBuilder.buildTokenWithAccount(appId, cert, channel, uid, role, expireTs, now);

    res.setHeader("Cache-Control", "no-store");
    // Same-origin, so CORS header not required—but harmless if present:
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");

    return res.status(200).json({ appId, token, expiresAt: expireTs });
  } catch (e) {
    console.error("token_error:", e);
    return res.status(500).json({ error: "token_generation_failed" });
  }
};
