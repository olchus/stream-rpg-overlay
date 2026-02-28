import { clamp, normalizeUsername, nowMs, pickRandom, safeInt, safeNumber } from "./util.js";

const EVENT_TYPES = ["shield", "silence", "mark", "exhaust", "roleswap", "totem"];
const OFFENSIVE_COMMANDS = new Set(["attack", "ue"]);

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function randomBetween(min, max) {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

function getEventTitle(type) {
  if (type === "shield") return "Break the Shield";
  if (type === "silence") return "Silence - UE disabled";
  if (type === "mark") return "Mark";
  if (type === "exhaust") return "Exhaust - rotate attackers";
  if (type === "roleswap") return "Role Swap - heal deals dmg / attack heals boss";
  if (type === "totem") return "Hunt the Totem";
  return "Unknown Event";
}

function getEventDescription(type) {
  if (type === "shield") return "Boss shield active";
  if (type === "silence") return "UE disabled";
  if (type === "mark") return "Protect mark objective";
  if (type === "exhaust") return "Recent attackers deal less damage";
  if (type === "roleswap") return "Heal damages boss, attack heals boss";
  if (type === "totem") return "Destroy the totem";
  return "";
}

function eventDurationMs(type, cfg) {
  if (type === "shield" || type === "roleswap") return 300000;
  return randomBetween(cfg.eventMinDurationMs, cfg.eventMaxDurationMs);
}

function shouldApplyExhaust(command) {
  return OFFENSIVE_COMMANDS.has(String(command || "").toLowerCase());
}

export function createEventEngine(deps) {
  const {
    state,
    env,
    db,
    updateUser,
    broadcastState,
    getLeaderboards
  } = deps;

  const cfg = {
    eventMinDurationMs: clamp(safeInt(env.EVENT_MIN_DURATION_MS, 120000), 1000, 3_600_000),
    eventMaxDurationMs: clamp(safeInt(env.EVENT_MAX_DURATION_MS, 300000), 1000, 3_600_000),
    eventBreakMinMs: clamp(safeInt(env.EVENT_BREAK_MIN_MS, 30000), 0, 3_600_000),
    eventBreakMaxMs: clamp(safeInt(env.EVENT_BREAK_MAX_MS, 120000), 0, 3_600_000),
    shieldDmgMult: clamp(safeNumber(env.SHIELD_DMG_MULT, 0.2), 0, 10),
    markChargeTarget: clamp(safeInt(env.MARK_CHARGE_TARGET, 3), 1, 100),
    markBonusXp: clamp(safeInt(env.MARK_BONUS_XP, 100), 0, 100000),
    vulnerableDmgMult: clamp(safeNumber(env.VULNERABLE_DMG_MULT, 1.5), 0, 10),
    markActiveWindowMs: clamp(safeInt(env.MARK_ACTIVE_WINDOW_MS, 10 * 60 * 1000), 1000, 24 * 60 * 60 * 1000),
    exhaustWindowMs: clamp(safeInt(env.EXHAUST_WINDOW_MS, 180000), 1000, 24 * 60 * 60 * 1000),
    dmgMultExhausted: clamp(safeNumber(env.DMG_MULT_EXHAUSTED, 0.5), 0, 10),
    xpMultExhausted: clamp(safeNumber(env.XP_MULT_EXHAUSTED, 0.5), 0, 10),
    totemBaseHp: clamp(safeInt(env.TOTEM_BASE_HP, 120), 1, 10_000_000),
    totemHpPerPhase: clamp(safeInt(env.TOTEM_HP_PER_PHASE, 40), 0, 10_000_000),
    totemBossReduction: clamp(safeNumber(env.TOTEM_BOSS_REDUCTION, 0.7), 0, 1),
    totemXpExtra: clamp(safeInt(env.TOTEM_XP_EXTRA, 10), 0, 100000)
  };

  if (cfg.eventMaxDurationMs < cfg.eventMinDurationMs) {
    cfg.eventMaxDurationMs = cfg.eventMinDurationMs;
  }
  if (cfg.eventBreakMaxMs < cfg.eventBreakMinMs) {
    cfg.eventBreakMaxMs = cfg.eventBreakMinMs;
  }

  if (typeof state.streamLive !== "boolean") {
    state.streamLive = parseBoolean(env.STREAM_LIVE_DEFAULT, true);
  }
  if (!state.activeEvent || typeof state.activeEvent !== "object") state.activeEvent = null;
  if (!Number.isFinite(Number(state.nextEventAt)) || Number(state.nextEventAt) <= 0) state.nextEventAt = null;
  if (!Number.isFinite(Number(state.nextEventPausedRemainingMs)) || Number(state.nextEventPausedRemainingMs) <= 0) {
    state.nextEventPausedRemainingMs = null;
  }
  state.lastEventType = String(state.lastEventType || "").trim() || null;

  const userActivityMs = new Map();
  let tickTimer = null;

  function log(label, payload = {}) {
    console.log(`[event] ${label}`, JSON.stringify(payload));
  }

  function broadcast(extra = {}) {
    if (typeof broadcastState !== "function") return;
    const payload = { ...extra };
    if (!payload.leaderboards && typeof getLeaderboards === "function") {
      payload.leaderboards = getLeaderboards();
    }
    broadcastState(payload);
  }

  function pruneUserActivity(now = nowMs()) {
    for (const [username, seenAt] of userActivityMs.entries()) {
      if (now - seenAt > cfg.markActiveWindowMs) userActivityMs.delete(username);
    }
  }

  function touchUserActivity(usernameRaw, whenRaw = nowMs()) {
    const username = normalizeUsername(usernameRaw);
    if (!username || username === "unknown") return;
    const when = safeInt(whenRaw, nowMs());
    userActivityMs.set(username, when);
    pruneUserActivity(when);
  }

  function pickMarkedUser(now = nowMs()) {
    pruneUserActivity(now);

    const activeCandidates = Array.from(userActivityMs.keys());
    if (activeCandidates.length > 0) return pickRandom(activeCandidates);

    const fallback = [];
    try {
      if (db?.usersByXpAscWithDmg?.all) {
        for (const row of db.usersByXpAscWithDmg.all(500)) {
          const user = normalizeUsername(row?.username || "");
          if (user && user !== "unknown") fallback.push(user);
        }
      } else if (db?.topUsersByXp?.all) {
        for (const row of db.topUsersByXp.all(500)) {
          const user = normalizeUsername(row?.username || "");
          if (user && user !== "unknown") fallback.push(user);
        }
      }
    } catch (e) {
      log("MARK_FALLBACK_QUERY_ERROR", { error: e?.message || String(e) });
    }

    if (fallback.length > 0) return pickRandom(fallback);
    return "unknown";
  }

  function currentTotemHpForPhase(phaseRaw) {
    const phase = Math.max(1, safeInt(phaseRaw, 1));
    return cfg.totemBaseHp + phase * cfg.totemHpPerPhase;
  }

  function buildMetaForType(type, now = nowMs()) {
    if (type === "mark") {
      return {
        markedUser: pickMarkedUser(now),
        charges: 0,
        chargeTarget: cfg.markChargeTarget,
        broken: false,
        bonusGranted: false
      };
    }
    if (type === "totem") {
      const hp = currentTotemHpForPhase(state.phase);
      return {
        hpMax: hp,
        hp,
        destroyed: false
      };
    }
    return {};
  }

  function scheduleNextEvent(now = nowMs()) {
    if (!state.streamLive || state.activeEvent || safeInt(state.phase, 1) < 2) {
      state.nextEventAt = null;
      state.nextEventPausedRemainingMs = null;
      return;
    }
    const breakMs = randomBetween(cfg.eventBreakMinMs, cfg.eventBreakMaxMs);
    state.nextEventAt = now + breakMs;
    state.nextEventPausedRemainingMs = null;
    log("SCHEDULE_NEXT", { inMs: breakMs, at: state.nextEventAt });
  }

  function clearEventSchedule() {
    state.nextEventAt = null;
    state.nextEventPausedRemainingMs = null;
  }

  function pickNextEventType() {
    const candidates = EVENT_TYPES.filter((type) => type !== state.lastEventType);
    if (candidates.length === 0) return pickRandom(EVENT_TYPES);
    return pickRandom(candidates);
  }

  function startEvent(type, now = nowMs()) {
    const durationMs = eventDurationMs(type, cfg);
    const title = getEventTitle(type);
    const description = getEventDescription(type);
    const meta = buildMetaForType(type, now);

    state.activeEvent = {
      type,
      title,
      description,
      startedAt: now,
      endsAt: now + durationMs,
      durationMs,
      pausedRemainingMs: null,
      meta
    };
    state.lastEventType = type;
    state.nextEventAt = null;
    state.nextEventPausedRemainingMs = null;

    log("START", { type, durationMs, meta });
    broadcast({ toast: `${title} started` });
  }

  function endActiveEvent(reason = "timeout", now = nowMs(), options = {}) {
    if (!state.activeEvent) return false;

    const ended = state.activeEvent;
    state.activeEvent = null;
    if (state.streamLive && safeInt(state.phase, 1) >= 2) scheduleNextEvent(now);
    else clearEventSchedule();

    log("END", {
      type: ended.type,
      reason,
      startedAt: ended.startedAt,
      endedAt: now,
      meta: ended.meta
    });

    if (options.broadcast !== false) {
      const extra = {};
      if (options.toast) extra.toast = options.toast;
      broadcast(extra);
    }
    return true;
  }

  function pauseEventTimers(now = nowMs()) {
    if (state.activeEvent && state.activeEvent.endsAt) {
      state.activeEvent.pausedRemainingMs = Math.max(0, safeInt(state.activeEvent.endsAt, now) - now);
      state.activeEvent.endsAt = null;
    }
    if (state.nextEventAt) {
      state.nextEventPausedRemainingMs = Math.max(0, safeInt(state.nextEventAt, now) - now);
      state.nextEventAt = null;
    }
  }

  function resumeEventTimers(now = nowMs()) {
    if (state.activeEvent && state.activeEvent.pausedRemainingMs !== null && state.activeEvent.pausedRemainingMs !== undefined) {
      const remaining = Math.max(0, safeInt(state.activeEvent.pausedRemainingMs, 0));
      state.activeEvent.endsAt = now + remaining;
      state.activeEvent.pausedRemainingMs = null;
      if (remaining <= 0) {
        endActiveEvent("resume_expired", now, { broadcast: false });
      }
    }

    if (!state.activeEvent) {
      if (state.nextEventPausedRemainingMs !== null && state.nextEventPausedRemainingMs !== undefined) {
        const remaining = Math.max(0, safeInt(state.nextEventPausedRemainingMs, 0));
        state.nextEventAt = now + remaining;
        state.nextEventPausedRemainingMs = null;
      } else if (!state.nextEventAt && safeInt(state.phase, 1) >= 2) {
        scheduleNextEvent(now);
      }
    }
  }

  function setStreamLive(liveRaw, source = "unknown") {
    const live = parseBoolean(liveRaw, state.streamLive);
    if (state.streamLive === live) return false;

    const now = nowMs();
    state.streamLive = live;
    if (!live) {
      pauseEventTimers(now);
      log("STREAM_OFFLINE", { source, activeEvent: state.activeEvent?.type || null });
      broadcast({ toast: "Stream OFFLINE - events paused" });
      return true;
    }

    resumeEventTimers(now);
    log("STREAM_LIVE", { source, activeEvent: state.activeEvent?.type || null, nextEventAt: state.nextEventAt });
    broadcast({ toast: "Stream LIVE - events resumed" });
    return true;
  }

  function tick() {
    const now = nowMs();
    pruneUserActivity(now);

    if (safeInt(state.phase, 1) < 2) {
      if (state.activeEvent) {
        endActiveEvent("phase_below_2", now, { toast: "Events disabled below phase 2" });
      } else {
        clearEventSchedule();
      }
      return;
    }

    if (!state.streamLive) return;

    if (state.activeEvent) {
      if (state.activeEvent.endsAt && now >= safeInt(state.activeEvent.endsAt, now + 1)) {
        endActiveEvent("timeout", now, { toast: `${state.activeEvent.title} ended` });
      }
      return;
    }

    if (!state.nextEventAt) {
      scheduleNextEvent(now);
      return;
    }

    if (now >= safeInt(state.nextEventAt, now + 1)) {
      startEvent(pickNextEventType(), now);
    }
  }

  function start() {
    if (tickTimer) return;
    tick();
    tickTimer = setInterval(tick, 1000);
    if (tickTimer.unref) tickTimer.unref();
  }

  function stop() {
    if (!tickTimer) return;
    clearInterval(tickTimer);
    tickTimer = null;
  }

  function isSilenceActive() {
    return state.activeEvent?.type === "silence";
  }

  function isRoleSwapActive() {
    return state.activeEvent?.type === "roleswap";
  }

  function isTotemActive() {
    return state.activeEvent?.type === "totem" && safeInt(state.activeEvent?.meta?.hp, 0) > 0;
  }

  function computeBossDamageMultiplier(input = {}) {
    const command = String(input.command || "").toLowerCase();
    const now = safeInt(input.now, nowMs());
    const row = input.row || {};
    let mult = 1;
    const reasons = [];

    if (state.activeEvent?.type === "shield") {
      mult *= cfg.shieldDmgMult;
      reasons.push(`shield:${cfg.shieldDmgMult}`);
    }
    if (state.activeEvent?.type === "mark" && state.activeEvent?.meta?.broken) {
      mult *= cfg.vulnerableDmgMult;
      reasons.push(`vulnerable:${cfg.vulnerableDmgMult}`);
    }
    if (state.activeEvent?.type === "totem" && safeInt(state.activeEvent?.meta?.hp, 0) > 0) {
      mult *= cfg.totemBossReduction;
      reasons.push(`totem:${cfg.totemBossReduction}`);
    }
    if (state.activeEvent?.type === "exhaust" && shouldApplyExhaust(command)) {
      const lastOffensiveMs = safeInt(row?.last_offensive_ms, 0);
      if (lastOffensiveMs > 0 && (now - lastOffensiveMs) < cfg.exhaustWindowMs) {
        mult *= cfg.dmgMultExhausted;
        reasons.push(`exhaust:${cfg.dmgMultExhausted}`);
      }
    }

    return { mult, reasons };
  }

  function computeXpMultiplier(input = {}) {
    const command = String(input.command || "").toLowerCase();
    const now = safeInt(input.now, nowMs());
    const row = input.row || {};
    let mult = 1;
    const reasons = [];

    if (state.activeEvent?.type === "exhaust" && shouldApplyExhaust(command)) {
      const lastOffensiveMs = safeInt(row?.last_offensive_ms, 0);
      if (lastOffensiveMs > 0 && (now - lastOffensiveMs) < cfg.exhaustWindowMs) {
        mult *= cfg.xpMultExhausted;
        reasons.push(`exhaust:${cfg.xpMultExhausted}`);
      }
    }

    return { mult, reasons };
  }

  function onBossHitByCommand(input = {}) {
    if (state.activeEvent?.type !== "mark") return { updated: false };

    const command = String(input.command || "").toLowerCase();
    if (!OFFENSIVE_COMMANDS.has(command)) return { updated: false };

    const meta = state.activeEvent.meta || {};
    const hitter = normalizeUsername(input.user || "");
    const markedUser = normalizeUsername(meta.markedUser || "");
    if (!hitter || hitter !== markedUser) return { updated: false };

    const current = safeInt(meta.charges, 0);
    const target = Math.max(1, safeInt(meta.chargeTarget, cfg.markChargeTarget));
    meta.charges = clamp(current + 1, 0, target);
    meta.chargeTarget = target;

    let brokenNow = false;
    let bonusXp = 0;
    if (!meta.broken && meta.charges >= target) {
      meta.broken = true;
      brokenNow = true;
      if (!meta.bonusGranted) {
        meta.bonusGranted = true;
        bonusXp = cfg.markBonusXp;
        if (bonusXp > 0 && typeof updateUser === "function") {
          updateUser(markedUser, bonusXp);
        }
      }
    }
    state.activeEvent.meta = meta;

    return {
      updated: true,
      markedUser,
      charges: meta.charges,
      chargeTarget: target,
      broken: Boolean(meta.broken),
      brokenNow,
      bonusXp
    };
  }

  function damageTotem(input = {}) {
    if (state.activeEvent?.type !== "totem") return { ok: false, reason: "totem_inactive" };
    const meta = state.activeEvent.meta || {};
    const currentHp = Math.max(0, safeInt(meta.hp, 0));
    if (currentHp <= 0) return { ok: false, reason: "totem_destroyed" };

    const dmg = clamp(safeInt(input.amount, 0), 0, 999999);
    if (dmg <= 0) return { ok: false, reason: "no_damage" };

    const nextHp = Math.max(0, currentHp - dmg);
    meta.hp = nextHp;
    meta.hpMax = Math.max(nextHp, safeInt(meta.hpMax, nextHp));
    meta.destroyed = nextHp <= 0;
    state.activeEvent.meta = meta;

    const destroyed = nextHp <= 0;
    if (destroyed) {
      endActiveEvent("totem_destroyed", safeInt(input.now, nowMs()), { broadcast: false });
    }

    return {
      ok: true,
      dmg,
      hp: nextHp,
      hpMax: safeInt(meta.hpMax, nextHp),
      destroyed
    };
  }

  function getConfig() {
    return { ...cfg };
  }

  function syncNow() {
    tick();
  }

  return {
    start,
    stop,
    syncNow,
    getConfig,
    setStreamLive,
    touchUserActivity,
    isSilenceActive,
    isRoleSwapActive,
    isTotemActive,
    computeBossDamageMultiplier,
    computeXpMultiplier,
    onBossHitByCommand,
    damageTotem
  };
}
