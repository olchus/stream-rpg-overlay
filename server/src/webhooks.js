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

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
    if (normalized) return normalized;
  }
  return "";
}

function createMessageDeduper(ttlMs, maxSize) {
  const seenIds = new Map();

  function buildKey(rawMessageId, rawTs) {
    const messageId = normalizeOptionalString(rawMessageId);
    if (!messageId) return "";
    const ts = normalizeOptionalString(rawTs);
    return ts ? `${messageId}::${ts}` : messageId;
  }

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

  function isDuplicate(rawMessageId, rawTs) {
    const key = buildKey(rawMessageId, rawTs);
    if (!key) return false;

    const now = Date.now();
    prune(now);

    const existingExpiresAt = seenIds.get(key);
    if (existingExpiresAt && existingExpiresAt > now) return true;

    seenIds.delete(key);
    seenIds.set(key, now + ttlMs);
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
    const user = firstNonEmpty(
      body.user,
      body.username,
      body?.sender?.username,
      body?.author?.username,
      body?.author,
      req.query?.user,
      req.query?.username
    );
    const text = firstNonEmpty(
      body.text,
      body.message,
      body.content,
      body.cmd,
      req.query?.text,
      req.query?.message,
      req.query?.content,
      req.query?.cmd
    );
    const level = firstNonEmpty(body.level, body.role, req.query?.level, req.query?.role) || "viewer";
    const role = roleFromLevel(level);
    const isSub = parseBooleanFlag(body.isSub ?? req.query?.isSub, false);
    const source = normalizeOptionalString(body.source ?? req.query?.source) || "n8n";
    const messageId = firstNonEmpty(
      body.messageId,
      body.message_id,
      body.id,
      req.query?.messageId,
      req.query?.message_id,
      req.query?.id
    );
    const tsInput = body.ts ?? body.timestamp ?? req.query?.ts ?? req.query?.timestamp ?? Date.now();

    if (messageId && deduper.isDuplicate(messageId, tsInput)) {
      console.log(
        "[chat][dedup]",
        JSON.stringify({
          ts: new Date().toISOString(),
          source,
          user,
          cmdRaw: text,
          messageId,
          tsInput
        })
      );
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
        reason: result?.reason,
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
