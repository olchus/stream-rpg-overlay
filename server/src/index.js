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
    .map((s) => normalizeUsername(s))
    .filter(Boolean)
);
const KICK_MOD_USERS = new Set(
  String(env.KICK_MOD_USERS || "")
    .split(",")
    .map((s) => normalizeUsername(s))
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
  const u = normalizeUsername(userRaw);
  if (!u) return "viewer";
  if (u === auth.admin || KICK_ADMIN_USERS.has(u)) return "admin";
  if (KICK_MOD_USERS.has(u)) return "mod";
  return "viewer";
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

// Serve overlay as static
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const overlayDir = path.join(__dirname, "..", "..", "overlay");
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
  getLeaderboards
});

registerTipplyWebhook(app, {
  env,
  state,
  broadcastState,
  updateUser,
  recordEvent,
  getLeaderboards
});

startTipplyGoalPoller({
  env,
  state,
  broadcastState,
  updateUser,
  recordEvent,
  getLeaderboards
});


io.on("connection", (socket) => {
  socket.emit("state", { ...state, leaderboards: getLeaderboards() });
});

// ----- Kick commands -----
function handleKickMessage({ user, text }) {
  const t = String(text || "").trim();

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

    applyDamage(state, u.username, scaled, "kick_chat");
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
    broadcastState
  });

  if (result?.ok) return;
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
    applyDamage(state, who, dmg, "streamlabs_donation");

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

    applyDamage(state, who, dmg, "streamlabs_sub");

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

    applyDamage(state, who, dmg, "streamlabs_follow");

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
