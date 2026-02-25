import "dotenv/config";
import express from "express";
import crypto from "crypto";
import { handleCommand } from "./commands.js";
import { buildAuth, roleFromCloudbotLevel } from "./auth.js";
import { createServer } from "http";
import { Server } from "socket.io";

import { initDb } from "./db.js";
import { createGameState, applyDamage, awardXp, maybeChaos } from "./game.js";
import { connectStreamlabs } from "./streamlabs.js";
import { registerTipplyWebhook, startTipplyGoalPoller } from "./tipply.js";
import {
  buildAuthorizeUrl,
  buildStreamlabsAuth,
  exchangeCodeForToken,
  fetchSocketToken,
  hasStreamlabsAuth,
  loadStreamlabsToken,
  saveStreamlabsToken
} from "./streamlabsAuth.js";
import { connectKick } from "./kick.js";
import { nowMs, safeInt, safeNumber, normalizeUsername } from "./util.js";
import { registerWebhooks } from "./webhooks.js";
import { registerAdminApi } from "./admin.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";


const env = process.env;
const auth = buildAuth(env);
const CLOUDBOT_WEBHOOK_SECRET = env.CLOUDBOT_WEBHOOK_SECRET || "";
const streamlabsAuth = buildStreamlabsAuth(env);

const PORT = safeInt(env.PORT, 3001);

const STREAMLABS_SOCKET_TOKEN = env.STREAMLABS_SOCKET_TOKEN || "";
const KICK_CHANNEL = env.KICK_CHANNEL || "";
const KICK_ENABLED = (env.KICK_ENABLED || "true").toLowerCase() === "true";
const KICK_ADMIN_USERS = new Set(
  String(env.KICK_ADMIN_USERS || "")
    .split(",")
    .map((s) => normalizeUsername(s).toLowerCase())
    .filter(Boolean)
);
const KICK_MOD_USERS = new Set(
  String(env.KICK_MOD_USERS || "")
    .split(",")
    .map((s) => normalizeUsername(s).toLowerCase())
    .filter(Boolean)
);

const BOSS_MAX_HP = safeInt(env.BOSS_MAX_HP, 5000);
const CHAT_ATTACK_DAMAGE = safeInt(env.CHAT_ATTACK_DAMAGE, 5);
const FOLLOW_DAMAGE = safeInt(env.FOLLOW_DAMAGE, 20);
const SUB_DAMAGE = safeInt(env.SUB_DAMAGE, 150);
const DONATE_DMG_MULT = safeNumber(env.DONATE_DMG_MULT, 2.5);

const CHAT_ATTACK_COOLDOWN_MS = safeInt(env.CHAT_ATTACK_COOLDOWN_MS, 60000);
const CHAT_HEAL_COOLDOWN_MS = safeInt(env.CHAT_HEAL_COOLDOWN_MS, 120000);

const CHAOS_ENABLED = (env.CHAOS_ENABLED || "true").toLowerCase() === "true";
const CHAOS_DONATE_THRESHOLD = safeInt(env.CHAOS_DONATE_THRESHOLD, 10);

const DAILY_CLEANUP_HOURS = 48; // ile trzymać eventy w bazie

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
const oauthStates = new Set();

function newOauthState() {
  const s = crypto.randomUUID();
  oauthStates.add(s);
  const t = setTimeout(() => oauthStates.delete(s), 10 * 60 * 1000);
  if (t.unref) t.unref();
  return s;
}
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

const dbh = initDb();
const state = createGameState({ BOSS_MAX_HP });
state.paused = false;
state.chaosForced = null; // null = normal, true/false = forced
let streamlabsClient = null;

function broadcastState(extra = {}) {
  io.emit("state", {
    ...state,
    ...extra
  });
}

function roleFromKickUser(userRaw) {
  const u = normalizeUsername(userRaw).toLowerCase();
  if (!u) return "viewer";
  if (u === auth.admin || KICK_ADMIN_USERS.has(u)) return "admin";
  if (KICK_MOD_USERS.has(u)) return "mod";
  return "viewer";
}

function parseKickGiftMessage(text, raw) {
  if (!text) return null;
  const amountMatch = String(text).match(/(\d+)\s*kicks?\b/i);
  if (!amountMatch) return null;
  const kicks = safeInt(amountMatch[1], 0);
  if (kicks <= 0) return null;

  const senderRaw =
    raw?.sender?.username ||
    raw?.sender?.slug ||
    raw?.sender?.name ||
    raw?.username ||
    raw?.user?.username ||
    raw?.user?.name ||
    "";

  let giver = normalizeUsername(String(senderRaw).replace(/^@/, ""));
  const senderHint = String(senderRaw || "").toLowerCase();
  if (!giver || giver === "unknown" || senderHint === "kick" || senderHint === "system") {
    const nameMatch = String(text).match(/^@?([A-Za-z0-9_-]{2,})\b/);
    if (nameMatch) giver = normalizeUsername(nameMatch[1]);
  }
  if (!giver || giver === "unknown") return null;

  const typeHint = String(raw?.type || raw?.message_type || raw?.event || raw?.kind || "").toLowerCase();
  const looksLikeSystem =
    raw?.system === true ||
    raw?.is_system === true ||
    ["system", "event", "gift", "kicks"].some((k) => typeHint.includes(k));
  const looksLikeGift = /gift|podarow|sent/i.test(String(text));
  if (!looksLikeSystem && !looksLikeGift) return null;

  return { giver, kicks };
}

function ensureUser(usernameRaw) {
  const username = normalizeUsername(usernameRaw);
  const row = dbh.getUser.get(username);
  if (row) return row;
  const init = { username, xp: 0, level: 1, last_attack_ms: 0, last_heal_ms: 0 };
  dbh.upsertUser.run(init);
  return init;
}

function updateUser(username, xpAdd, maybeLastAttackMs = null, maybeLastHealMs = null) {
  const user = ensureUser(username);
  const next = awardXp(user.xp, xpAdd);

  const last_attack_ms = maybeLastAttackMs !== null ? maybeLastAttackMs : user.last_attack_ms;
  const last_heal_ms = maybeLastHealMs !== null ? maybeLastHealMs : user.last_heal_ms;

  dbh.upsertUser.run({
    username: user.username,
    xp: next.xp,
    level: next.level,
    last_attack_ms,
    last_heal_ms
  });

  return { username: user.username, xp: next.xp, level: next.level, last_attack_ms, last_heal_ms };
}

function recordEvent(username, kind, amount = 0, meta = "") {
  dbh.addEvent.run(nowMs(), username, kind, amount, meta);
}

function getLeaderboards() {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayStartMs = dayStart.getTime();

  const topXp = dbh.topUsersByXp.all(5);
  const topDmg = dbh.topHittersToday.all(dayStartMs, 5);

  return { topXp, topDmg };
}

function getPhaseWinners(phaseStartMs) {
  const winners = dbh.topUsersByXp.all(3);
  return winners || [];
}

// Serve overlay as static
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const overlayDir = path.join(__dirname, "..", "..", "overlay");
const adminDir = path.join(__dirname, "..", "..", "admin");
if (!fs.existsSync(adminDir)) {
  console.log(`[admin] WARN: adminDir not found: ${adminDir}`);
} else {
  console.log(`[admin] serving static from: ${adminDir}`);
}

app.get("/admin", (_req, res) => {
  return res.redirect(301, "/admin/");
});

app.use("/overlay", express.static(overlayDir));

// Health endpoint
app.get("/health", (_req, res) => {
  res.json({ ok: true, bossHp: state.bossHp, phase: state.phase });
});

// Debug endpoint (optional)
app.get("/api/state", (_req, res) => {
  res.json({ ...state, leaderboards: getLeaderboards() });
});

// Streamlabs OAuth (authorize app to get socket token)
app.get("/auth/streamlabs/start", (_req, res) => {
  if (!hasStreamlabsAuth(streamlabsAuth)) {
    return res.status(500).json({ ok: false, error: "missing streamlabs oauth config" });
  }

  const state = newOauthState();
  const url = buildAuthorizeUrl(streamlabsAuth, state);
  return res.redirect(url);
});

app.get("/auth/streamlabs/callback", async (req, res) => {
  if (!hasStreamlabsAuth(streamlabsAuth)) {
    return res.status(500).json({ ok: false, error: "missing streamlabs oauth config" });
  }

  const code = String(req.query?.code || "");
  const state = String(req.query?.state || "");
  if (!code) return res.status(400).json({ ok: false, error: "missing code" });
  if (state && !oauthStates.has(state)) {
    return res.status(400).json({ ok: false, error: "invalid state" });
  }
  if (state) oauthStates.delete(state);

  try {
    const token = await exchangeCodeForToken(streamlabsAuth, code);
    saveStreamlabsToken(env, { ...token, acquired_at_ms: Date.now() });

    let socketConnected = false;
    try {
      const socketToken = await fetchSocketToken(token.access_token);
      connectStreamlabsWithToken(socketToken, "oauth");
      socketConnected = true;
    } catch (e) {
      console.log("[streamlabs] socket token error:", e?.message || e);
    }

    return res.json({ ok: true, socketConnected });
  } catch (e) {
    console.log("[streamlabs] oauth error:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

registerWebhooks(app, {
  env,
  state,
  auth,
  db: dbh,
  broadcastState,
  updateUser,
  recordEvent,
  getLeaderboards,
  getPhaseWinners
});

registerAdminApi(app, {
  env,
  state,
  db: dbh,
  broadcastState,
  getLeaderboards,
  updateUser,
  adminDir
});

app.use("/admin", express.static(adminDir));

registerTipplyWebhook(app, {
  env,
  state,
  broadcastState,
  updateUser,
  recordEvent,
  getLeaderboards,
  getPhaseWinners
});

startTipplyGoalPoller({
  env,
  state,
  broadcastState,
  updateUser,
  recordEvent,
  getLeaderboards,
  getPhaseWinners
});


io.on("connection", (socket) => {
  socket.emit("state", { ...state, leaderboards: getLeaderboards() });
});

// ----- Kick commands -----
function handleKickMessage({ user, text, raw }) {
  const t = String(text || "").trim();

  const gift = parseKickGiftMessage(t, raw);
  if (gift) {
    if (state.paused) return;
    const u = ensureUser(gift.giver);
    const dmg = gift.kicks;
    updateUser(u.username, 2);
    recordEvent(u.username, "kick_gift", dmg, JSON.stringify({ kicks: gift.kicks, source: "kick" }));
    const result = applyDamage(state, u.username, dmg, "kick_gift");
    if (result.defeated) {
      state.phaseWinners = getPhaseWinners(state.phaseStartMs);
      state.phaseStartMs = nowMs();
    }
    broadcastState({ leaderboards: getLeaderboards(), toast: `${u.username} gifted ${gift.kicks} KICKS -> HIT -${dmg}` });
    return;
  }

  if (!t.startsWith("!")) return;
  const role = roleFromKickUser(user);

  if (t === "!attack") {
    if (state.paused) return;
    const u = ensureUser(user);
    const now = nowMs();

    if (now - u.last_attack_ms < CHAT_ATTACK_COOLDOWN_MS) {
      // silent cooldown (żeby nie spamować)
      return;
    }

    // damage scales a bit with level (hardcore)
    const scaled = CHAT_ATTACK_DAMAGE + Math.floor((u.level - 1) * 0.5);

    updateUser(u.username, 2, now); // xp za aktywność
    recordEvent(u.username, "chat_attack", scaled, "kick");

    const result = applyDamage(state, u.username, scaled, "kick_chat");
    if (result.defeated) {
      state.phaseWinners = getPhaseWinners(state.phaseStartMs);
      state.phaseStartMs = nowMs();
    }
    broadcastState({ leaderboards: getLeaderboards() });
    return;
  }

  if (t === "!heal") {
    // Heal to boss (hardcore chaos): chat can troll - heals boss a bit, but gives XP.
    if (state.paused) return;
    const u = ensureUser(user);
    const now = nowMs();
    if (now - u.last_heal_ms < CHAT_HEAL_COOLDOWN_MS) {
      // silent cooldown (żeby nie spamować)
      return;
    }
    const heal = 15;
    state.bossHp = Math.min(state.bossMaxHp, state.bossHp + heal);
    updateUser(u.username, 5, null, now);
    recordEvent(u.username, "chat_heal", heal, "kick");
    broadcastState({ leaderboards: getLeaderboards(), toast: `${u.username} healed boss +${heal} 😈` });
    return;
  }

  if (t === "!stats") {
    const u = ensureUser(user);
    // overlay doesn't show chat replies; you can later add "bot message" to Kick
    recordEvent(u.username, "chat_stats", 0, "kick");
    return;
  }

  // Other commands (admin/mod) via shared handler
  const result = handleCommand({
    user,
    role,
    rawText: t,
    userRaw: user,
    roleRaw: role,
    cmdRaw: t,
    eventId: crypto.randomUUID(),
    source: "kick",
    state,
    env,
    db: dbh,
    auth,
    updateUser,
    recordEvent,
    getLeaderboards,
    getPhaseWinners,
    broadcastState
  });

  if (result?.ok) return;
  if (result?.message && !result?.silent) {
    console.log("[kick][cmd]", JSON.stringify({ user, role, cmd: t, ok: result.ok, message: result.message }));
  }
}

// ----- Streamlabs events -----
function handleStreamlabsEvent(data) {
  if (state.paused) return;
  const type = data?.type;
  const msg = data?.message?.[0] || {};

  if (type === "donation") {
    const who = normalizeUsername(msg?.from || "donator");
    const amount = safeInt(msg?.amount, 0);

    // dmg: amount * mult; also scale by phase (hardcore)
    const phaseMult = state.phase >= 4 ? 2 : state.phase === 3 ? 1.5 : state.phase === 2 ? 1.2 : 1;
    const dmg = amount * DONATE_DMG_MULT * phaseMult;
    if (dmg <= 0) return;

    updateUser(who, 20 + Math.min(100, dmg / 10));
    recordEvent(who, "donation_hit", dmg, JSON.stringify({ amount }));

    const chaos = maybeChaos(state, CHAOS_ENABLED, CHAOS_DONATE_THRESHOLD, amount);
    const result = applyDamage(state, who, dmg, "streamlabs_donation");
    if (result.defeated) {
      state.phaseWinners = getPhaseWinners(state.phaseStartMs);
      state.phaseStartMs = nowMs();
    }

    broadcastState({
      leaderboards: getLeaderboards(),
      toast: `${who} donated ${amount} → HIT -${dmg}`,
      chaos
    });
    return;
  }

  if (type === "subscription") {
    const who = normalizeUsername(msg?.name || "sub");
    const dmg = SUB_DAMAGE;

    updateUser(who, 50);
    recordEvent(who, "sub_hit", dmg, "sub");

    const result = applyDamage(state, who, dmg, "streamlabs_sub");
    if (result.defeated) {
      state.phaseWinners = getPhaseWinners(state.phaseStartMs);
      state.phaseStartMs = nowMs();
    }

    broadcastState({
      leaderboards: getLeaderboards(),
      toast: `${who} SUB → CRIT -${dmg}`
    });
    return;
  }

  if (type === "follow") {
    const who = normalizeUsername(msg?.name || "follow");
    const dmg = FOLLOW_DAMAGE;

    updateUser(who, 10);
    recordEvent(who, "follow_hit", dmg, "follow");

    const result = applyDamage(state, who, dmg, "streamlabs_follow");
    if (result.defeated) {
      state.phaseWinners = getPhaseWinners(state.phaseStartMs);
      state.phaseStartMs = nowMs();
    }

    broadcastState({
      leaderboards: getLeaderboards(),
      toast: `${who} FOLLOW → -${dmg}`
    });
    return;
  }
}

function disconnectStreamlabsClient() {
  if (!streamlabsClient) return;
  if (typeof streamlabsClient.disconnect === "function") streamlabsClient.disconnect();
  else if (typeof streamlabsClient.close === "function") streamlabsClient.close();
  streamlabsClient = null;
}

function connectStreamlabsWithToken(socketToken, source = "unknown") {
  if (!socketToken) {
    console.log(`[streamlabs] socket token missing (source=${source})`);
    return;
  }
  disconnectStreamlabsClient();
  streamlabsClient = connectStreamlabs(socketToken, handleStreamlabsEvent);
}

async function resolveStreamlabsSocketToken() {
  if (STREAMLABS_SOCKET_TOKEN) {
    return { token: STREAMLABS_SOCKET_TOKEN, source: "env" };
  }

  const stored = loadStreamlabsToken(env);
  if (stored?.access_token) {
    try {
      const token = await fetchSocketToken(stored.access_token);
      return { token, source: "oauth" };
    } catch (e) {
      console.log("[streamlabs] socket token error:", e?.message || e);
    }
  }

  return { token: "", source: "none" };
}

(async () => {
  const { token, source } = await resolveStreamlabsSocketToken();
  if (!token && hasStreamlabsAuth(streamlabsAuth)) {
    console.log("[streamlabs] authorize at /auth/streamlabs/start");
  }
  connectStreamlabsWithToken(token, source);
})();

if (KICK_ENABLED && KICK_CHANNEL) {
  (async () => {
    try {
      await connectKick(KICK_CHANNEL, (m) => handleKickMessage(m));
    } catch (e) {
      console.log("[kick] disabled:", e?.message || e);
    }
  })();
} else {
  console.log("[kick] disabled by env");
}

// Cleanup old events periodically (keeps DB small)
setInterval(() => {
  const cutoff = Date.now() - DAILY_CLEANUP_HOURS * 60 * 60 * 1000;
  try {
    dbh.resetDaily.run(cutoff);
  } catch (e) {
    console.log("[db] cleanup error:", e?.message || e);
  }
}, 60 * 60 * 1000);

httpServer.listen(PORT, () => {
  console.log(`[app] listening on :${PORT}`);
});
