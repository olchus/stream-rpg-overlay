import crypto from "crypto";
import { roleFromLevel } from "./auth.js";
import { handleCommand } from "./commands.js";

const DEDUP_TTL_MS = 5 * 60 * 1000;
const DEDUP_MAX_IDS = 500;

function timingSafeEq(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function parseBooleanFlag(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return fallback;

  const text = value.trim().toLowerCase();
  if (!text) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return fallback;
}

function normalizeOptionalString(value) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  return text;
}

function createMessageDeduper(ttlMs, maxSize) {
  const seenIds = new Map();

  function prune(now) {
    for (const [id, expiresAt] of seenIds) {
      if (expiresAt <= now) seenIds.delete(id);
    }

    while (seenIds.size > maxSize) {
      const oldest = seenIds.keys().next().value;
      if (oldest === undefined) break;
      seenIds.delete(oldest);
    }
  }

  function isDuplicate(rawMessageId) {
    const messageId = normalizeOptionalString(rawMessageId);
    if (!messageId) return false;

    const now = Date.now();
    prune(now);

    const existingExpiresAt = seenIds.get(messageId);
    if (existingExpiresAt && existingExpiresAt > now) return true;

    seenIds.delete(messageId);
    seenIds.set(messageId, now + ttlMs);
    prune(now);
    return false;
  }

  return { isDuplicate };
}

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

  const secret = String(env.CMD_WEBHOOK_SECRET || "").trim();
  const deduper = createMessageDeduper(DEDUP_TTL_MS, DEDUP_MAX_IDS);

  app.post("/api/cmd", (req, res) => {
    if (!secret) return res.status(500).json({ ok: false, error: "missing secret" });

    const sig = req.header("x-cmd-secret") || req.query?.secret || "";
    if (!timingSafeEq(sig, secret)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const user = normalizeOptionalString(body.user ?? req.query?.user);
    const text = normalizeOptionalString(body.text ?? req.query?.text);
    const level = normalizeOptionalString(body.level ?? req.query?.level) || "viewer";
    const role = roleFromLevel(level);
    const isSub = parseBooleanFlag(body.isSub ?? req.query?.isSub, false);
    const source = normalizeOptionalString(body.source ?? req.query?.source) || "n8n";
    const messageId = normalizeOptionalString(body.messageId ?? req.query?.messageId);
    const tsInput = body.ts ?? req.query?.ts ?? Date.now();

    if (messageId && deduper.isDuplicate(messageId)) {
      return res.json({
        ok: true,
        result: { ok: true, dedup: true, messageId }
      });
    }

    const eventId = crypto.randomUUID();
    const envName = env.NODE_ENV || process.env.NODE_ENV || "unknown";
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
        isSub,
        sourceInput: source,
        messageId,
        tsInput
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
      ts: tsInput,
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
        msg: result?.msg,
        message: result?.message,
        xp: result?.xp,
        silent: result?.silent
      })
    );

    if (text.toLowerCase() === "!xp") {
      console.log(
        "[chat][xp]",
        JSON.stringify({
          ts: new Date().toISOString(),
          eventId,
          user,
          ok: result?.ok,
          msg: result?.msg,
          xp: result?.xp
        })
      );
    }

    const toastMessage = result?.message ?? result?.msg;
    if (!result?.silent && toastMessage !== undefined && toastMessage !== null) {
      broadcastState({ toast: String(toastMessage) });
    }

    return res.json({ ok: true, result });
  });
}
