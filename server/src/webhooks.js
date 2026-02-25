import crypto from "crypto";
import { roleFromCloudbotLevel } from "./auth.js";
import { handleCommand } from "./commands.js";

function timingSafeEq(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function parseBooleanFlag(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return null;

  const text = value.trim().toLowerCase();
  if (!text) return null;
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return null;
}

function hasSubMarker(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some(hasSubMarker);
  if (typeof value === "object") {
    return Object.entries(value).some(([k, v]) => hasSubMarker(k) || hasSubMarker(v));
  }

  const text = String(value).trim().toLowerCase();
  if (!text) return false;
  return ["sub", "subscriber", "subscription", "subscribed", "prime"].some((k) => text.includes(k));
}

function parseIsSub(req) {
  const explicit = parseBooleanFlag(req.body?.isSub ?? req.query?.isSub);
  if (explicit !== null) return explicit;

  const level = String(req.body?.level || req.query?.level || "").trim().toLowerCase();
  if (["sub", "subscriber"].includes(level)) return true;

  const roleCandidates = [
    req.body?.role,
    req.query?.role,
    req.body?.roles,
    req.query?.roles,
    req.body?.badges,
    req.query?.badges
  ];
  return roleCandidates.some(hasSubMarker);
}

/**
 * Rejestruje webhook Cloudbot: POST /api/cmd
 * Wymaga header: x-cloudbot-secret
 */
export function registerWebhooks(app, deps) {
  const {
    env,
    state,
    auth, // buildAuth(env)
    db,
    broadcastState,
    updateUser,
    recordEvent,
    getLeaderboards,
    getPhaseWinners
  } = deps;

  const secret = env.CLOUDBOT_WEBHOOK_SECRET || "";

  app.post("/api/cmd", (req, res) => {
    if (!secret) return res.status(500).json({ ok: false, error: "missing secret" });

    const sig = req.header("x-cloudbot-secret") || req.query?.secret || "";
    if (!timingSafeEq(sig, secret)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const user = String(req.body?.user || req.query?.user || "");
    const text = String(req.body?.text || req.query?.text || "");
    const level = String(req.body?.level || req.query?.level || "viewer");
    const role = roleFromCloudbotLevel(level);
    const isSub = parseIsSub(req);
    const eventId = crypto.randomUUID();
    const envName = env.NODE_ENV || process.env.NODE_ENV || "unknown";
    const source = "cloudbot";
    const ts = new Date().toISOString();
    const contentType = req.header("content-type") || "";

    console.log(
      "[chat][recv]",
      JSON.stringify({
        ts,
        env: envName,
        source,
        eventId,
        contentType,
        userRaw: user,
        cmdRaw: text,
        roleRaw: level,
        role,
        isSub
      })
    );

    const result = handleCommand({
      user,
      role,
      rawText: text,
      userRaw: user,
      roleRaw: level,
      cmdRaw: text,
      isSub,
      eventId,
      source,
      state,
      env,
      db,
      auth,
      updateUser,
      recordEvent,
      getLeaderboards,
      getPhaseWinners,
      broadcastState
    });

    console.log(
      "[chat][result]",
      JSON.stringify({
        ts: new Date().toISOString(),
        env: envName,
        source,
        eventId,
        ok: result?.ok,
        message: result?.message,
        silent: result?.silent
      })
    );

    return res.json({ ok: true, result });
  });
}
