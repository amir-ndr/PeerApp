const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const dotenv = require("dotenv");
const { RtcTokenBuilder, RtcRole } = require("agora-access-token");

dotenv.config();

const app = express();

// Security
app.use(helmet());
const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // allow Postman/curl
    return allowed.includes(origin) ? cb(null, true) : cb(new Error("Not allowed by CORS"));
  }
}));
const limiter = rateLimit({ windowMs: 60_000, max: 60 });
app.use("/token", limiter);

// Endpoint: GET /token?channel=demo&uid=Amir&role=publisher
app.get("/token", (req, res) => {
  try {
    const appId = process.env.AGORA_APP_ID;
    const cert  = process.env.AGORA_APP_CERTIFICATE;
    const channel = (req.query.channel || "").trim();
    const uid    = (req.query.uid || "").trim(); // string uid is fine
    const roleQ  = (req.query.role || "publisher").toLowerCase();
    const role   = roleQ === "audience" ? RtcRole.SUBSCRIBER : RtcRole.PUBLISHER;

    if (!appId || !cert) return res.status(500).json({ error: "Server not configured" });
    if (!channel || !uid) return res.status(400).json({ error: "channel and uid required" });

    const now = Math.floor(Date.now() / 1000);
    const expireTs = now + Number(process.env.TOKEN_TTL_SECONDS || 120);

    const token = RtcTokenBuilder.buildTokenWithAccount(appId, cert, channel, uid, role, expireTs, now);

    res.json({ appId, token, expiresAt: expireTs });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create token" });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Token server running on port ${port}`));
