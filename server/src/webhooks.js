import crypto from "crypto";
import { roleFromCloudbotLevel } from "./auth.js";
import { handleCommand } from "./commands.js";

function timingSafeEq(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
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
    broadcastState,
    updateUser,
    recordEvent,
    getLeaderboards
  } = deps;

  const secret = env.CLOUDBOT_WEBHOOK_SECRET || "";

  app.post("/api/cmd", (req, res) => {
    if (!secret) return res.status(500).json({ ok: false, error: "missing secret" });

    const sig = req.header("x-cloudbot-secret") || "";
    if (!timingSafeEq(sig, secret)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const user = String(req.body?.user || req.query?.user || "");
    const text = String(req.body?.text || req.query?.text || "");
    const level = String(req.body?.level || req.query?.level || "viewer");
    const role = roleFromCloudbotLevel(level);

    const result = handleCommand({
      user,
      role,
      rawText: text,
      state,
      env,
      auth,
      updateUser,
      recordEvent,
      getLeaderboards,
      broadcastState
    });

    return res.json({ ok: true, result });
  });
}
