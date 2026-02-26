import "dotenv/config";
import express from "express";
import crypto from "crypto";
import { buildAuth } from "./auth.js";
import { createServer } from "http";
import { Server } from "socket.io";

import { initDb } from "./db.js";
import { createGameState, applyDamage, awardXp, awardSkill, maybeChaos } from "./game.js";
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
import { nowMs, safeInt, safeNumber, normalizeUsername } from "./util.js";
import { registerWebhooks } from "./webhooks.js";
import { registerAdminApi } from "./admin.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const env = process.env;
const auth = buildAuth(env);
const streamlabsAuth = buildStreamlabsAuth(env);

const PORT = safeInt(env.PORT, 3001);
const STREAMLABS_SOCKET_TOKEN = env.STREAMLABS_SOCKET_TOKEN || "";

const BOSS_MAX_HP = safeInt(env.BOSS_MAX_HP, 5000);
const FOLLOW_DAMAGE = safeInt(env.FOLLOW_DAMAGE, 20);
const SUB_DAMAGE = safeInt(env.SUB_DAMAGE, 150);
const DONATE_DMG_MULT = safeNumber(env.DONATE_DMG_MULT, 2.5);

const SKILL_START = Math.max(1, safeInt(env.SKILL_START, 1));
const SKILL_BASE_TRIES = Math.max(1, safeInt(env.SKILL_BASE_TRIES, 40));
const SKILL_GROWTH = Math.max(1.01, safeNumber(env.SKILL_GROWTH, 1.16));
const SKILL_CFG = { SKILL_START, SKILL_BASE_TRIES, SKILL_GROWTH };

const CHAOS_ENABLED = (env.CHAOS_ENABLED || "true").toLowerCase() === "true";
const CHAOS_DONATE_THRESHOLD = safeInt(env.CHAOS_DONATE_THRESHOLD, 10);

const DAILY_CLEANUP_HOURS = 48; // ile trzymac eventy w bazie

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

function ensureUser(usernameRaw) {
  const username = normalizeUsername(usernameRaw);
  const row = dbh.getUser.get(username);
  if (row) return row;
  const init = { username, xp: 0, level: 1, skill: SKILL_START, skill_tries: 0, last_attack_ms: 0, last_heal_ms: 0 };
  dbh.upsertUser.run(init);
  return init;
}

function updateUser(username, xpAdd, maybeLastAttackMs = null, maybeLastHealMs = null, extra = {}) {
  const user = ensureUser(username);
  const nextXp = awardXp(user.xp, xpAdd);
  const skillTriesAdd = Math.max(0, safeInt(extra?.skillTriesAdd, 0));
  const nextSkill = awardSkill(user.skill, user.skill_tries, skillTriesAdd, SKILL_CFG);

  const last_attack_ms = maybeLastAttackMs !== null ? maybeLastAttackMs : user.last_attack_ms;
  const last_heal_ms = maybeLastHealMs !== null ? maybeLastHealMs : user.last_heal_ms;

  dbh.upsertUser.run({
    username: user.username,
    xp: nextXp.xp,
    level: nextXp.level,
    skill: nextSkill.skill,
    skill_tries: nextSkill.skillTries,
    last_attack_ms,
    last_heal_ms
  });

  return {
    username: user.username,
    xp: nextXp.xp,
    level: nextXp.level,
    skill: nextSkill.skill,
    skill_tries: nextSkill.skillTries,
    skillUps: nextSkill.skillUps,
    last_attack_ms,
    last_heal_ms
  };
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

function getPhaseWinners(_phaseStartMs) {
  const winners = dbh.topUsersByXp.all(3);
  return winners || [];
}

// Serve overlay as static
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const overlayDir = path.join(__dirname, "..", "..", "overlay");
const adminDir = path.join(__dirname, "..", "..", "admin");
const adminIndexFile = path.join(adminDir, "index.html");
if (!fs.existsSync(adminDir)) {
  console.log(`[admin] WARN: adminDir not found: ${adminDir}`);
} else {
  console.log(`[admin] serving static from: ${adminDir}`);
}

app.get(["/admin", "/admin/"], (_req, res, next) => {
  if (!fs.existsSync(adminIndexFile)) {
    return next();
  }
  return res.sendFile(adminIndexFile);
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

app.use("/admin", express.static(adminDir, { redirect: false }));

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
      toast: `${who} donated ${amount} -> HIT -${dmg}`,
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
      toast: `${who} SUB -> CRIT -${dmg}`
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
      toast: `${who} FOLLOW -> -${dmg}`
    });
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
