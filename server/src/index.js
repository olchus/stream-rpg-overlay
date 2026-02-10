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
import { connectKick } from "./kick.js";
import { nowMs, safeInt, normalizeUsername } from "./util.js";
import { registerWebhooks } from "./webhooks.js";
import path from "path";
import { fileURLToPath } from "url";


const env = process.env;
const auth = buildAuth(env);
const CLOUDBOT_WEBHOOK_SECRET = env.CLOUDBOT_WEBHOOK_SECRET || "";

const PORT = safeInt(env.PORT, 3001);

const STREAMLABS_SOCKET_TOKEN = env.STREAMLABS_SOCKET_TOKEN || "";
const KICK_CHANNEL = env.KICK_CHANNEL || "";
const KICK_ENABLED = (env.KICK_ENABLED || "true").toLowerCase() === "true";

const BOSS_MAX_HP = safeInt(env.BOSS_MAX_HP, 5000);
const CHAT_ATTACK_DAMAGE = safeInt(env.CHAT_ATTACK_DAMAGE, 5);
const FOLLOW_DAMAGE = safeInt(env.FOLLOW_DAMAGE, 20);
const SUB_DAMAGE = safeInt(env.SUB_DAMAGE, 150);
const DONATE_DMG_MULT = safeInt(env.DONATE_DMG_MULT, 10);

const CHAT_ATTACK_COOLDOWN_MS = safeInt(env.CHAT_ATTACK_COOLDOWN_MS, 5000);

const CHAOS_ENABLED = (env.CHAOS_ENABLED || "true").toLowerCase() === "true";
const CHAOS_DONATE_THRESHOLD = safeInt(env.CHAOS_DONATE_THRESHOLD, 10);

const DAILY_CLEANUP_HOURS = 48; // ile trzymać eventy w bazie

const app = express();
app.use(express.json());
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

const dbh = initDb();
const state = createGameState({ BOSS_MAX_HP });
state.paused = false;
state.chaosForced = null; // null = normal, true/false = forced

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
  const init = { username, xp: 0, level: 1, last_attack_ms: 0 };
  dbh.upsertUser.run(init);
  return init;
}

function updateUser(username, xpAdd, maybeLastAttackMs = null) {
  const user = ensureUser(username);
  const next = awardXp(user.xp, xpAdd);

  const last_attack_ms = maybeLastAttackMs !== null ? maybeLastAttackMs : user.last_attack_ms;

  dbh.upsertUser.run({
    username: user.username,
    xp: next.xp,
    level: next.level,
    last_attack_ms
  });

  return { username: user.username, xp: next.xp, level: next.level, last_attack_ms };
}

function recordEvent(username, kind, amount = 0, meta = "") {
  dbh.addEvent.run(nowMs(), username, kind, amount, meta);
}

function getLeaderboards() {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayStartMs = dayStart.getTime();

  const topXp = dbh.topUsersByXp.all(10);
  const topDmg = dbh.topHittersToday.all(dayStartMs, 10);

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

registerWebhooks(app, {
  env,
  state,
  auth,
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

  if (t === "!attack") {
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
    const u = ensureUser(user);
    const heal = 15;
    state.bossHp = Math.min(state.bossMaxHp, state.bossHp + heal);
    updateUser(u.username, 5);
    recordEvent(u.username, "chat_heal", heal, "kick");
    broadcastState({ leaderboards: getLeaderboards(), toast: `${u.username} healed boss +${heal} 😈` });
    return;
  }

  if (t === "!stats") {
    const u = ensureUser(user);
    // overlay doesn't show chat replies; you can later add "bot message" to Kick
    recordEvent(u.username, "chat_stats", 0, "kick");
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
    const phaseMult = state.phase === 4 ? 2 : state.phase === 3 ? 1.5 : state.phase === 2 ? 1.2 : 1;
    const dmg = Math.max(10, Math.floor(amount * DONATE_DMG_MULT * phaseMult));

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

connectStreamlabs(STREAMLABS_SOCKET_TOKEN, handleStreamlabsEvent);

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
