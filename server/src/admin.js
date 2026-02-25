import crypto from "crypto";
import path from "path";
import { awardXp, setBossPhase } from "./game.js";
import { clamp, nowMs, safeInt } from "./util.js";

const ADMIN_SESSION_COOKIE = "admin_session";

function timingSafeEq(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function readBearerToken(req) {
  const authHeader = String(req.header("authorization") || "");
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? String(match[1] || "").trim() : "";
}

function readHeaderAdminToken(req) {
  return String(req.header("x-admin-token") || req.header("x-api-token") || "").trim();
}

function parseCookies(req) {
  const raw = String(req.header("cookie") || "");
  const out = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function auditPayload(payload) {
  try {
    const text = JSON.stringify(payload ?? {});
    return text.length > 4000 ? `${text.slice(0, 4000)}...` : text;
  } catch {
    return "{}";
  }
}

function actorFromRequest(req) {
  const actorRaw =
    req.adminActor ||
    req.header("x-admin-actor") ||
    req.body?.actor ||
    req.query?.actor ||
    "admin-api";
  return String(actorRaw).trim().slice(0, 80) || "admin-api";
}

export function registerAdminApi(app, deps) {
  const {
    env,
    state,
    db,
    broadcastState,
    getLeaderboards,
    updateUser,
    adminDir
  } = deps;

  const adminToken = String(env.ADMIN_TOKEN || env.ADMIN_API_TOKEN || "").trim();
  const loginEmail = String(env.ADMIN_LOGIN_EMAIL || "bartoszolszowski@gmail.com").trim().toLowerCase();
  const loginUsername = String(env.ADMIN_LOGIN_USERNAME || "bart").trim().toLowerCase();
  const loginPassword = String(env.ADMIN_LOGIN_PASSWORD || "campus");
  const skillStart = Math.max(1, safeInt(env.SKILL_START, 1));
  const sessionTtlMs = Math.max(5 * 60 * 1000, safeInt(env.ADMIN_SESSION_TTL_MS, 12 * 60 * 60 * 1000));
  const isSecureCookie = String(env.NODE_ENV || "").toLowerCase() === "production";
  const sessions = new Map();

  function pruneExpiredSessions() {
    const now = nowMs();
    for (const [sessionId, session] of sessions.entries()) {
      if (!session || session.expiresAtMs <= now) {
        sessions.delete(sessionId);
      }
    }
  }

  function createSession(actor) {
    pruneExpiredSessions();
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, {
      actor,
      expiresAtMs: nowMs() + sessionTtlMs
    });
    return sessionId;
  }

  function clearSession(res) {
    const cookie = `${ADMIN_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isSecureCookie ? "; Secure" : ""}`;
    res.setHeader("Set-Cookie", cookie);
  }

  function setSession(res, sessionId) {
    const maxAgeSec = Math.floor(sessionTtlMs / 1000);
    const cookie = `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${isSecureCookie ? "; Secure" : ""}`;
    res.setHeader("Set-Cookie", cookie);
  }

  function readSession(req) {
    pruneExpiredSessions();
    const cookies = parseCookies(req);
    const sessionId = String(cookies[ADMIN_SESSION_COOKIE] || "").trim();
    if (!sessionId) return null;

    const session = sessions.get(sessionId);
    if (!session) return null;

    if (session.expiresAtMs <= nowMs()) {
      sessions.delete(sessionId);
      return null;
    }

    return { sessionId, ...session };
  }

  function checkCredentials(identifierRaw, passwordRaw) {
    const identifier = String(identifierRaw || "").trim().toLowerCase();
    const password = String(passwordRaw || "");
    if (!identifier || !password) return false;

    const loginOk = identifier === loginEmail || identifier === loginUsername;
    if (!loginOk) return false;
    return timingSafeEq(password, loginPassword);
  }

  function authenticate(req) {
    const token = readHeaderAdminToken(req) || readBearerToken(req);
    if (adminToken && token && timingSafeEq(token, adminToken)) {
      req.adminActor = actorFromRequest(req);
      return true;
    }

    const session = readSession(req);
    if (session) {
      req.adminActor = session.actor;
      return true;
    }

    return false;
  }

  function writeAudit(req, action, payload = {}) {
    const actor = actorFromRequest(req);
    if (!db?.addAdminAudit?.run) return actor;

    try {
      const ip = String(req.ip || req.socket?.remoteAddress || "").slice(0, 120);
      db.addAdminAudit.run(nowMs(), actor, action, auditPayload(payload), ip);
    } catch (e) {
      console.log("[admin][audit] error:", e?.message || e);
    }
    return actor;
  }

  function getPlayersList(limitRaw = 500) {
    if (!db?.usersByXpAscWithDmg?.all) return [];
    const limit = clamp(safeInt(limitRaw, 500), 1, 5000);
    return db.usersByXpAscWithDmg.all(limit);
  }

  function upsertUserWithExactXp(usernameRaw, xpRaw) {
    const username = String(usernameRaw || "").trim().slice(0, 40);
    if (!username) return null;
    if (!db?.upsertUser?.run) return null;

    const existing = db?.getUser?.get ? db.getUser.get(username) : null;
    const xp = clamp(safeInt(xpRaw, 0), 0, 2_000_000_000);
    const level = awardXp(0, xp).level;
    db.upsertUser.run({
      username,
      xp,
      level,
      skill: existing?.skill ?? skillStart,
      skill_tries: existing?.skill_tries ?? 0,
      last_attack_ms: existing?.last_attack_ms ?? 0,
      last_heal_ms: existing?.last_heal_ms ?? 0
    });
    return { username, xp, level, skill: existing?.skill ?? skillStart };
  }

  function readRouteUsername(req) {
    return String(req.params?.id || "").trim().slice(0, 40);
  }

  function playerSnapshot(row) {
    if (!row) return null;
    return {
      username: row.username,
      xp: safeInt(row.xp, 0),
      level: safeInt(row.level, 1),
      skill: safeInt(row.skill, skillStart),
      skillTries: safeInt(row.skill_tries, 0),
      lastAttackMs: safeInt(row.last_attack_ms, 0),
      lastHealMs: safeInt(row.last_heal_ms, 0)
    };
  }

  function mutateUserSkill(req, res, action) {
    if (!db?.getUser?.get || !db?.updateUserSkill?.run) {
      return res.status(500).json({ ok: false, error: "skill update not available" });
    }

    const username = readRouteUsername(req);
    if (!username) {
      return res.status(400).json({ ok: false, error: "user id is required" });
    }

    const existing = db.getUser.get(username);
    if (!existing) {
      return res.status(404).json({ ok: false, error: "user not found" });
    }

    const beforeSkill = safeInt(existing.skill, skillStart);
    const beforeSkillTries = safeInt(existing.skill_tries, 0);
    let nextSkill = beforeSkill;

    if (action === "inc") {
      nextSkill = clamp(beforeSkill + 1, skillStart, 9999);
    } else if (action === "dec") {
      nextSkill = Math.max(skillStart, beforeSkill - 1);
    } else if (action === "reset") {
      nextSkill = skillStart;
    } else {
      return res.status(400).json({ ok: false, error: "unknown action" });
    }

    db.updateUserSkill.run({
      username,
      skill: nextSkill,
      skill_tries: 0
    });

    const updated = db.getUser.get(username);
    const actor = writeAudit(req, `users_skill_${action}`, {
      username,
      beforeSkill,
      beforeSkillTries,
      skill: safeInt(updated?.skill, nextSkill),
      skillTries: safeInt(updated?.skill_tries, 0),
      minSkill: skillStart
    });
    const leaderboards = getLeaderboards();
    const players = getPlayersList(500);
    const actionLabel =
      action === "inc" ? "Skill +1" :
      action === "dec" ? "Skill -1" :
      "Skill reset";
    broadcastState({ leaderboards, toast: `${username} ${actionLabel} by ${actor}` });

    return res.json({
      ok: true,
      user: playerSnapshot(updated),
      summary: { action, minSkill: skillStart },
      players
    });
  }

  function requireAdminApi(req, res, next) {
    if (!authenticate(req)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    return next();
  }

  function requireAdminPage(req, res, next) {
    if (!authenticate(req)) return res.redirect("/admin/");
    return next();
  }

  app.post("/api/admin/login", (req, res) => {
    const identifier = req.body?.identifier ?? req.body?.email ?? req.body?.login ?? "";
    const password = req.body?.password ?? "";

    if (!checkCredentials(identifier, password)) {
      return res.status(401).json({ ok: false, error: "invalid credentials" });
    }

    const actor = String(identifier || loginUsername).trim().slice(0, 80) || loginUsername;
    const sessionId = createSession(actor);
    setSession(res, sessionId);
    req.adminActor = actor;
    writeAudit(req, "login", { actor });
    return res.json({ ok: true, actor });
  });

  app.post("/api/admin/logout", (req, res) => {
    const session = readSession(req);
    if (session?.sessionId) sessions.delete(session.sessionId);
    clearSession(res);
    req.adminActor = session?.actor || "admin-api";
    writeAudit(req, "logout", {});
    return res.json({ ok: true });
  });

  app.get("/api/admin/session", (req, res) => {
    if (authenticate(req)) {
      return res.json({ ok: true, loggedIn: true, actor: actorFromRequest(req) });
    }
    return res.status(401).json({ ok: false, loggedIn: false });
  });

  if (adminDir) {
    app.get("/admin/panel", requireAdminPage, (_req, res) => {
      return res.sendFile(path.join(adminDir, "panel.html"));
    });
    app.get("/admin/panel.html", requireAdminPage, (_req, res) => {
      return res.sendFile(path.join(adminDir, "panel.html"));
    });
  }

  app.use("/api/admin", requireAdminApi);

  app.get("/api/admin/state", (_req, res) => {
    return res.json({
      ok: true,
      state: { ...state },
      leaderboards: getLeaderboards(),
      players: getPlayersList(500)
    });
  });

  app.get("/api/admin/users", (req, res) => {
    return res.json({
      ok: true,
      players: getPlayersList(req.query?.limit)
    });
  });

  const handleSkillInc = (req, res) => mutateUserSkill(req, res, "inc");
  const handleSkillDec = (req, res) => mutateUserSkill(req, res, "dec");
  const handleSkillReset = (req, res) => mutateUserSkill(req, res, "reset");

  function handleResetAllSkills(req, res) {
    if (!db?.db || !db?.resetAllUserSkills?.run) {
      return res.status(500).json({ ok: false, error: "db missing" });
    }

    try {
      const resetAll = db.db.transaction((start) => db.resetAllUserSkills.run(start));
      const result = resetAll(skillStart);
      const changed = safeInt(result?.changes, 0);
      const actor = writeAudit(req, "skills_reset_all", {
        changed,
        skill: skillStart,
        skillTries: 0
      });
      const leaderboards = getLeaderboards();
      const players = getPlayersList(500);
      broadcastState({ leaderboards, toast: `Skills reset (${changed}) by ${actor}` });
      return res.json({
        ok: true,
        summary: {
          changed,
          skill: skillStart,
          skillTries: 0
        },
        players
      });
    } catch {
      return res.status(500).json({ ok: false, error: "db error" });
    }
  }

  app.post("/api/admin/users/:id/skill/inc", handleSkillInc);
  app.post("/api/admin/users/:id/skill/dec", handleSkillDec);
  app.post("/api/admin/users/:id/skill/reset", handleSkillReset);
  app.post("/api/admin/skills/reset-all", handleResetAllSkills);

  // Compatibility aliases (without /api prefix).
  app.post("/admin/users/:id/skill/inc", requireAdminApi, handleSkillInc);
  app.post("/admin/users/:id/skill/dec", requireAdminApi, handleSkillDec);
  app.post("/admin/users/:id/skill/reset", requireAdminApi, handleSkillReset);
  app.post("/admin/skills/reset-all", requireAdminApi, handleResetAllSkills);

  app.post("/api/admin/users/addxp", (req, res) => {
    if (typeof updateUser !== "function") {
      return res.status(500).json({ ok: false, error: "updateUser missing" });
    }

    const username = String(req.body?.username || "").trim().slice(0, 40);
    const xpAdd = clamp(safeInt(req.body?.xp, 0), 0, 1_000_000);

    if (!username) {
      return res.status(400).json({ ok: false, error: "username is required" });
    }
    if (xpAdd <= 0) {
      return res.status(400).json({ ok: false, error: "xp must be > 0" });
    }

    const updated = updateUser(username, xpAdd);
    const actor = writeAudit(req, "users_addxp", { username: updated.username, xpAdd });
    const leaderboards = getLeaderboards();
    const players = getPlayersList(500);
    broadcastState({ leaderboards, toast: `${updated.username} +${xpAdd} XP by ${actor}` });

    return res.json({
      ok: true,
      user: updated,
      players
    });
  });

  app.post("/api/admin/users/seedtest", (req, res) => {
    const seeded = [];
    const defs = [
      { username: "test_user_100", xp: 100 },
      { username: "test_user_70", xp: 70 },
      { username: "test_user_50", xp: 50 }
    ];

    for (const def of defs) {
      const row = upsertUserWithExactXp(def.username, def.xp);
      if (row) seeded.push(row);
    }

    const actor = writeAudit(req, "users_seedtest", { count: seeded.length });
    const leaderboards = getLeaderboards();
    const players = getPlayersList(500);
    broadcastState({ leaderboards, toast: `Seeded test users by ${actor}` });

    return res.json({
      ok: true,
      seeded,
      players
    });
  });

  app.post("/api/admin/pause", (req, res) => {
    state.paused = true;
    const actor = writeAudit(req, "pause", { paused: true });
    const leaderboards = getLeaderboards();
    broadcastState({ leaderboards, toast: `PAUSED by ${actor}` });
    return res.json({ ok: true, paused: state.paused });
  });

  app.post("/api/admin/resume", (req, res) => {
    state.paused = false;
    const actor = writeAudit(req, "resume", { paused: false });
    const leaderboards = getLeaderboards();
    broadcastState({ leaderboards, toast: `RESUMED by ${actor}` });
    return res.json({ ok: true, paused: state.paused });
  });

  app.post("/api/admin/boss/sethp", (req, res) => {
    const hp = clamp(safeInt(req.body?.hp, state.bossHp), 0, state.bossMaxHp);
    state.bossHp = hp;
    const actor = writeAudit(req, "boss_sethp", { hp: state.bossHp });
    const leaderboards = getLeaderboards();
    broadcastState({ leaderboards, toast: `HP set to ${state.bossHp} by ${actor}` });
    return res.json({
      ok: true,
      bossHp: state.bossHp,
      bossMaxHp: state.bossMaxHp
    });
  });

  app.post("/api/admin/boss/phase", (req, res) => {
    const phase = clamp(safeInt(req.body?.n, state.phase), 1, 9999);
    setBossPhase(state, phase);
    const actor = writeAudit(req, "boss_phase", { phase: state.phase });
    const leaderboards = getLeaderboards();
    broadcastState({ leaderboards, toast: `PHASE ${state.phase} forced by ${actor}` });
    return res.json({
      ok: true,
      phase: state.phase,
      bossHp: state.bossHp,
      bossMaxHp: state.bossMaxHp
    });
  });

  app.post("/api/admin/users/resetxp", (req, res) => {
    if (!db?.db) {
      return res.status(500).json({ ok: false, error: "db missing" });
    }

    try {
      db.db.exec("UPDATE users SET xp=0, level=1, last_attack_ms=0, last_heal_ms=0;");
      const actor = writeAudit(req, "users_resetxp", {});
      const leaderboards = getLeaderboards();
      broadcastState({ leaderboards, toast: `XP reset by ${actor}` });
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: "db error" });
    }
  });
}
