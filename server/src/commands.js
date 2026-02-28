import { normalizeUsername, safeInt, clamp, nowMs, pickRandom } from "./util.js";
import { applyDamage, setBossPhase } from "./game.js";
import { canRun } from "./auth.js";

const CHAOS_TASKS = [
  "Expisz bez kola przez 30 min.",
  "Boss run -> rolada i profit dla widza.",
  "Zdejmujesz 1 losowy item i expisz bez niego przez 10 min.",
  "Zmieniasz spawn na 30 minut.",
  "Hunt bez uzywania jednego spella.",
  "Grasz bez SSA / bez might ringa przez 10 minut.",
  "Uzywasz tylko 1 rodzaju potow przez 15 minut.",
  "Czat wybiera kolejny spawn z 3 opcji.",
  "Idziesz solo na spawn, ktory zwykle robisz w teamie.",
  "Otwierasz stash i losujesz jeden item do uzycia na hunt.",
  "Grasz na full waste przez 30 minut (liczymy straty).",
  "Jesli padniesz -> robisz giveaway 1kk.",
  "Musisz utrzymac min. X exp/h, jesli spadnie -> zmiana spawna.",
  "20 minut bez healowania exura (med) ico (tylko poty).",
  "MSem solo na miejscu \"nie dla MS\"."
];

const COMMAND_COOLDOWN_SLOTS = {
  attack: "attack",
  heal: "heal",
  ue: "ue",
  totem: "attack"
};

const COMMAND_COOLDOWN_ENV_KEYS = {
  attack: "CHAT_ATTACK_COOLDOWN_MS",
  heal: "CHAT_HEAL_COOLDOWN_MS",
  ue: "CHAT_UE_COOLDOWN_MS"
};

const COMMAND_COOLDOWN_DEFAULT_MS = {
  attack: 60000,
  heal: 120000,
  ue: 213700
};

const COOLDOWN_FIELD_BY_SLOT = {
  attack: "last_attack_ms",
  heal: "last_heal_ms",
  ue: "last_ue_ms"
};

function sendChaosTaskWebhook(env, task, user) {
  const url = String(env?.CHAOS_TASK_WEBHOOK_URL || "").trim();
  if (!url) return;

  const secret = String(env?.CMD_WEBHOOK_SECRET || "").trim();
  const message = `CHAOS TASK: ${task}`;
  const target = new URL(url);
  target.searchParams.set("message", message);
  target.searchParams.set("text", message);
  target.searchParams.set("content", message);
  target.searchParams.set("message_ascii", message);
  target.searchParams.set("task", task);
  target.searchParams.set("by", user);

  const headers = { "content-type": "application/json" };
  if (secret) headers["x-cmd-secret"] = secret;

  fetch(target.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify({
      message,
      text: message,
      content: message,
      message_ascii: message,
      task,
      by: user
    })
  }).then(async (resp) => {
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.log("[chaos][webhook] non-2xx:", resp.status, body.slice(0, 300));
      return;
    }
    console.log("[chaos][webhook] sent:", JSON.stringify({ status: resp.status, task, by: user }));
  }).catch((e) => {
    console.log("[chaos][webhook] error:", e?.message || e);
  });
}

function parseArgs(text) {
  const parts = String(text || "").trim().split(/\s+/g);
  const cmd = (parts.shift() || "").replace(/^!/, "").toLowerCase();
  return { cmd, args: parts };
}

function resolveCooldownMs(env, command) {
  const slot = COMMAND_COOLDOWN_SLOTS[command] || command;
  const envKey = COMMAND_COOLDOWN_ENV_KEYS[slot];
  const fallback = COMMAND_COOLDOWN_DEFAULT_MS[slot] ?? 60000;
  return safeInt(env?.[envKey], fallback);
}

function getCooldownInfo(env, row, command, now) {
  const slot = COMMAND_COOLDOWN_SLOTS[command] || command;
  const field = COOLDOWN_FIELD_BY_SLOT[slot];
  const cooldownMs = resolveCooldownMs(env, slot);
  const lastMs = safeInt(row?.[field], 0);
  const remainingMs = Math.max(0, cooldownMs - (now - lastMs));
  return {
    slot,
    cooldownMs,
    remainingMs,
    blocked: remainingMs > 0
  };
}

function cooldownUpdateForCommand(command, now) {
  const slot = COMMAND_COOLDOWN_SLOTS[command] || command;
  return { [slot]: now };
}

function computeAttackBase(ctx, row) {
  const dmgBase = safeInt(ctx.env.CHAT_ATTACK_DAMAGE, 5);
  const skillStart = Math.max(1, safeInt(ctx.env.SKILL_START, 1));
  const skillTryPerAttack = Math.max(0, safeInt(ctx.env.SKILL_TRY_PER_ATTACK, 1));
  const userSkill = Math.max(skillStart, safeInt(row?.skill, skillStart));
  const isSub = ctx.isSub === true;
  const subBonus = isSub ? 5 : 0;
  const dmg = clamp(dmgBase + userSkill + subBonus, 1, 9999);
  return {
    dmgBase,
    skillTryPerAttack,
    userSkill,
    isSub,
    subBonus,
    dmg,
    breakdown: `base ${dmgBase} + skill ${userSkill} + sub ${subBonus}`
  };
}

function markBrokenSuffix(markResult) {
  if (!markResult?.brokenNow) return "";
  return ` | MARK BROKEN by ${markResult.markedUser} (+${markResult.bonusXp} XP)`;
}

export function handleCommand(ctx) {
  // ctx:
  // { user, role, rawText, isSub, state, env, db, eventEngine, broadcastState, recordEvent, updateUser, getLeaderboards, auth }
  const userRaw = ctx?.userRaw ?? ctx?.user ?? "";
  const cmdRaw = ctx?.cmdRaw ?? ctx?.rawText ?? "";
  const roleRaw = ctx?.roleRaw ?? ctx?.role ?? "";
  const envName = ctx?.env?.NODE_ENV || process.env.NODE_ENV || "unknown";
  const source = ctx?.source || "unknown";
  const commandSource = source === "unknown" ? "cmd_api" : source;
  const eventId = ctx?.eventId || "na";

  const user = normalizeUsername(ctx.user);
  const now = nowMs();
  ctx.eventEngine?.touchUserActivity?.(user, now);

  const { cmd, args } = parseArgs(ctx.rawText);
  let cmdNorm = cmd;
  let bosshitInline = null;
  const bosshitMatch = cmd.match(/^bosshit\+?(-?\d+)$/);
  if (bosshitMatch) {
    cmdNorm = "bosshit";
    bosshitInline = bosshitMatch[1];
  }
  if (cmdNorm === "makechaos") cmdNorm = "maybechaos";

  console.log(
    "[chat][parse]",
    JSON.stringify({
      ts: new Date().toISOString(),
      env: envName,
      source,
      eventId,
      userRaw,
      cmdRaw,
      roleRaw,
      cmd,
      args
    })
  );

  if (!cmd) return { ok: false, silent: true, reason: "missing_cmd" };

  const viewerInfoCommands = new Set(["bosshp", "xp"]);
  if (ctx.state.paused && (ctx.role === "viewer") && !viewerInfoCommands.has(cmdNorm)) {
    return { ok: false, message: "paused" };
  }

  if (cmdNorm === "bosshp") {
    const hp = safeInt(ctx.state?.bossHp, 0);
    const max = safeInt(ctx.state?.bossMaxHp, 0);
    const phase = Math.max(1, safeInt(ctx.state?.phase, 1));
    return {
      ok: true,
      message: `Boss HP: ${hp}/${max} (phase ${phase})`
    };
  }

  if (cmdNorm === "xp") {
    const row = ctx.db?.getUser?.get ? ctx.db.getUser.get(user) : null;
    const xp = safeInt(row?.xp, 0);
    return {
      ok: true,
      msg: `@${user} XP: ${xp}`,
      xp
    };
  }

  if (cmd === "attack") {
    if (ctx.state.paused) return { ok: false, message: "paused" };

    const row = ctx.db?.getUser?.get ? ctx.db.getUser.get(user) : null;
    const cooldown = getCooldownInfo(ctx.env, row, "attack", now);
    if (cooldown.blocked) {
      return { ok: false, silent: true, reason: `cooldown_${cooldown.slot}` };
    }

    const attack = computeAttackBase(ctx, row);
    const cooldowns = cooldownUpdateForCommand("attack", now);
    const xpBase = 2;

    if (ctx.eventEngine?.isRoleSwapActive?.()) {
      const healAmount = attack.dmg;
      ctx.state.bossHp = Math.min(ctx.state.bossMaxHp, ctx.state.bossHp + healAmount);

      const updated = ctx.updateUser(user, xpBase, null, null, {
        skillTriesAdd: attack.skillTryPerAttack,
        cooldowns,
        lastOffensiveMs: now
      });

      ctx.recordEvent(user, "chat_attack_roleswap_heal", healAmount, JSON.stringify({
        source: commandSource,
        base: attack.dmgBase,
        skill: attack.userSkill,
        subBonus: attack.subBonus,
        isSub: attack.isSub,
        total: healAmount
      }));

      const actionToast = `${user} !attack -> +${healAmount} boss HP (Role Swap)`;
      const toast = updated?.skillUps > 0
        ? `${user} skill up! (skill: ${updated.skill}) | ${actionToast}`
        : actionToast;
      ctx.broadcastState({ leaderboards: ctx.getLeaderboards(), toast });
      return { ok: true };
    }

    const dmgMult = ctx.eventEngine?.computeBossDamageMultiplier?.({ user, command: "attack", now, row })?.mult ?? 1;
    const xpMult = ctx.eventEngine?.computeXpMultiplier?.({ user, command: "attack", now, row })?.mult ?? 1;
    const dmg = clamp(Math.round(attack.dmg * dmgMult), 0, 999999);
    const xpGain = Math.max(0, Math.round(xpBase * xpMult));

    const updated = ctx.updateUser(user, xpGain, null, null, {
      skillTriesAdd: attack.skillTryPerAttack,
      cooldowns,
      lastOffensiveMs: now
    });

    ctx.recordEvent(user, "chat_attack", dmg, JSON.stringify({
      source: commandSource,
      base: attack.dmgBase,
      skill: attack.userSkill,
      subBonus: attack.subBonus,
      isSub: attack.isSub,
      totalBeforeMult: attack.dmg,
      totalAfterMult: dmg,
      dmgMult,
      xpBase,
      xpMult,
      xpGain
    }));

    const result = applyDamage(ctx.state, user, dmg, `${commandSource}_attack`);
    if (result.defeated) {
      ctx.state.phaseWinners = ctx.getPhaseWinners?.(ctx.state.phaseStartMs) || [];
      ctx.state.phaseStartMs = nowMs();
    }

    const markResult = ctx.eventEngine?.onBossHitByCommand?.({ user, command: "attack", now });
    const actionToast = `${user} !attack -> -${dmg} (${attack.breakdown})${markBrokenSuffix(markResult)}`;
    const toast = updated?.skillUps > 0
      ? `${user} skill up! (skill: ${updated.skill}) | ${actionToast}`
      : actionToast;
    ctx.broadcastState({ leaderboards: ctx.getLeaderboards(), toast });
    return { ok: true };
  }

  if (cmd === "ue") {
    if (ctx.state.paused) return { ok: false, message: "paused" };
    if (ctx.eventEngine?.isSilenceActive?.()) {
      return { ok: false, message: "UE disabled during Silence" };
    }

    const row = ctx.db?.getUser?.get ? ctx.db.getUser.get(user) : null;
    const cooldown = getCooldownInfo(ctx.env, row, "ue", now);
    if (cooldown.blocked) {
      return { ok: false, silent: true, reason: `cooldown_${cooldown.slot}` };
    }

    const attack = computeAttackBase(ctx, row);
    const ueBaseDamage = clamp(attack.dmg * 3, 1, 999999);
    const dmgMult = ctx.eventEngine?.computeBossDamageMultiplier?.({ user, command: "ue", now, row })?.mult ?? 1;
    const xpMult = ctx.eventEngine?.computeXpMultiplier?.({ user, command: "ue", now, row })?.mult ?? 1;
    const dmg = clamp(Math.round(ueBaseDamage * dmgMult), 0, 999999);
    const xpBase = 4;
    const xpGain = Math.max(0, Math.round(xpBase * xpMult));

    const updated = ctx.updateUser(user, xpGain, null, null, {
      skillTriesAdd: attack.skillTryPerAttack,
      cooldowns: cooldownUpdateForCommand("ue", now),
      lastOffensiveMs: now
    });

    ctx.recordEvent(user, "chat_ue", dmg, JSON.stringify({
      source: commandSource,
      baseAttack: attack.dmg,
      totalBeforeMult: ueBaseDamage,
      totalAfterMult: dmg,
      dmgMult,
      xpBase,
      xpMult,
      xpGain
    }));

    const result = applyDamage(ctx.state, user, dmg, `${commandSource}_ue`);
    if (result.defeated) {
      ctx.state.phaseWinners = ctx.getPhaseWinners?.(ctx.state.phaseStartMs) || [];
      ctx.state.phaseStartMs = nowMs();
    }

    const markResult = ctx.eventEngine?.onBossHitByCommand?.({ user, command: "ue", now });
    const actionToast = `${user} !ue -> -${dmg}${markBrokenSuffix(markResult)}`;
    const toast = updated?.skillUps > 0
      ? `${user} skill up! (skill: ${updated.skill}) | ${actionToast}`
      : actionToast;
    ctx.broadcastState({ leaderboards: ctx.getLeaderboards(), toast });
    return { ok: true };
  }

  if (cmd === "totem") {
    if (ctx.state.paused) return { ok: false, message: "paused" };
    if (!(ctx.eventEngine?.isTotemActive?.())) {
      return { ok: false, message: "Totem is not active" };
    }

    const row = ctx.db?.getUser?.get ? ctx.db.getUser.get(user) : null;
    const cooldown = getCooldownInfo(ctx.env, row, "totem", now);
    if (cooldown.blocked) {
      return { ok: false, silent: true, reason: `cooldown_${cooldown.slot}` };
    }

    const attack = computeAttackBase(ctx, row);
    const totemHit = ctx.eventEngine?.damageTotem?.({ user, amount: attack.dmg, now }) || { ok: false };
    if (!totemHit.ok) {
      return { ok: false, message: "Totem cannot be damaged now" };
    }

    const totemXpExtra = safeInt(ctx.eventEngine?.getConfig?.()?.totemXpExtra, 10);
    const xpGain = Math.max(0, 2 + totemXpExtra);

    const updated = ctx.updateUser(user, xpGain, null, null, {
      skillTriesAdd: attack.skillTryPerAttack,
      cooldowns: cooldownUpdateForCommand("totem", now)
    });

    ctx.recordEvent(user, "chat_totem_hit", attack.dmg, JSON.stringify({
      source: commandSource,
      baseAttack: attack.dmg,
      hp: totemHit.hp,
      hpMax: totemHit.hpMax,
      destroyed: totemHit.destroyed,
      xpGain
    }));

    const destroyedText = totemHit.destroyed ? " | Totem destroyed! Event ended." : "";
    const actionToast = `${user} !totem -> -${attack.dmg} [${totemHit.hp}/${totemHit.hpMax}]${destroyedText}`;
    const toast = updated?.skillUps > 0
      ? `${user} skill up! (skill: ${updated.skill}) | ${actionToast}`
      : actionToast;
    ctx.broadcastState({ leaderboards: ctx.getLeaderboards(), toast });
    return { ok: true };
  }

  if (cmd === "heal") {
    if (ctx.state.paused) return { ok: false, message: "paused" };

    const row = ctx.db?.getUser?.get ? ctx.db.getUser.get(user) : null;
    const cooldown = getCooldownInfo(ctx.env, row, "heal", now);
    if (cooldown.blocked) {
      return { ok: false, silent: true, reason: `cooldown_${cooldown.slot}` };
    }

    const heal = 15;
    const cooldowns = cooldownUpdateForCommand("heal", now);

    if (ctx.eventEngine?.isRoleSwapActive?.()) {
      const dmgMult = ctx.eventEngine?.computeBossDamageMultiplier?.({ user, command: "heal", now, row })?.mult ?? 1;
      const dmg = clamp(Math.round(heal * dmgMult), 0, 999999);
      ctx.updateUser(user, 5, null, null, { cooldowns });
      ctx.recordEvent(user, "chat_heal_roleswap_dmg", dmg, JSON.stringify({
        source: commandSource,
        base: heal,
        dmgMult,
        total: dmg
      }));

      const result = applyDamage(ctx.state, user, dmg, `${commandSource}_heal_roleswap`);
      if (result.defeated) {
        ctx.state.phaseWinners = ctx.getPhaseWinners?.(ctx.state.phaseStartMs) || [];
        ctx.state.phaseStartMs = nowMs();
      }

      ctx.broadcastState({ leaderboards: ctx.getLeaderboards(), toast: `${user} !heal -> -${dmg} (Role Swap)` });
      return { ok: true };
    }

    ctx.state.bossHp = Math.min(ctx.state.bossMaxHp, ctx.state.bossHp + heal);
    ctx.updateUser(user, 5, null, null, { cooldowns });
    ctx.recordEvent(user, "chat_heal", heal, commandSource);
    ctx.broadcastState({ leaderboards: ctx.getLeaderboards(), toast: `${user} !heal -> +${heal} boss HP` });
    return { ok: true };
  }

  // ---- ADMIN / MOD ----
  const adminCmd = cmdNorm === "boss" ? (args[0] || "").toLowerCase() : cmdNorm;
  const adminArgs = cmdNorm === "boss" ? args.slice(1) : args;

  const authKey =
    adminCmd === "reset" ? "reset" :
    adminCmd === "sethp" ? "sethp" :
    adminCmd === "bosshit" ? "bosshit" :
    adminCmd === "phase" ? "phase" :
    adminCmd === "pause" ? "pause" :
    adminCmd === "resume" ? "resume" :
    adminCmd === "setmult" ? "setmult" :
    adminCmd === "maybechaos" ? "maybechaos" :
    adminCmd === "clearchaos" ? "clearchaos" :
    adminCmd === "clearhits" ? "clearhits" :
    adminCmd === "resetxp" ? "resetxp" :
    adminCmd === "resetall" ? "resetall" :
    "";

  if (authKey) {
    if (!canRun(authKey, user, ctx.role, ctx.auth)) {
      return { ok: false, message: "nope" };
    }

    if (authKey === "reset") {
      setBossPhase(ctx.state, 1);
      ctx.eventEngine?.syncNow?.();
      ctx.state.lastHits.unshift({ by: "SYSTEM", amount: 0, source: `RESET by ${user}`, ts: Date.now() });
      ctx.broadcastState({ leaderboards: ctx.getLeaderboards(), toast: `BOSS RESET by ${user}` });
      return { ok: true };
    }

    if (authKey === "sethp") {
      const hp = safeInt(adminArgs[0], ctx.state.bossHp);
      ctx.state.bossHp = clamp(hp, 0, ctx.state.bossMaxHp);
      ctx.broadcastState({ leaderboards: ctx.getLeaderboards(), toast: `HP set to ${ctx.state.bossHp} by ${user}` });
      return { ok: true };
    }

    if (authKey === "bosshit") {
      const raw = bosshitInline ?? adminArgs[0];
      const dmg = clamp(safeInt(raw, 0), 0, 999999);
      if (dmg <= 0) return { ok: false, message: "usage: !bosshit 500" };
      ctx.recordEvent(user, "admin_bosshit", dmg, "admin");
      const result = applyDamage(ctx.state, user, dmg, "admin_bosshit");
      if (result.defeated) {
        ctx.state.phaseWinners = ctx.getPhaseWinners?.(ctx.state.phaseStartMs) || [];
        ctx.state.phaseStartMs = nowMs();
      }
      ctx.broadcastState({ leaderboards: ctx.getLeaderboards(), toast: `BOSS HIT -${dmg} by ${user}` });
      return { ok: true };
    }

    if (authKey === "phase") {
      const p = clamp(safeInt(adminArgs[0], ctx.state.phase), 1, 9999);
      setBossPhase(ctx.state, p);
      ctx.eventEngine?.syncNow?.();
      ctx.broadcastState({ leaderboards: ctx.getLeaderboards(), toast: `PHASE ${p} forced by ${user}` });
      return { ok: true };
    }

    if (authKey === "pause") {
      ctx.state.paused = true;
      ctx.broadcastState({ toast: `PAUSED by ${user}` });
      return { ok: true };
    }

    if (authKey === "resume") {
      ctx.state.paused = false;
      ctx.broadcastState({ toast: `RESUMED by ${user}` });
      return { ok: true };
    }

    if (authKey === "setmult") {
      ctx.state.runtimeOverrides ||= {};
      const key = String(adminArgs[0] || "");
      const val = safeInt(adminArgs[1], 0);
      if (!key) return { ok: false, message: "usage: !setmult donate 12" };

      ctx.state.runtimeOverrides[key] = val;
      ctx.broadcastState({ toast: `MULT ${key}=${val} by ${user}` });
      return { ok: true };
    }

    if (authKey === "maybechaos") {
      const task = pickRandom(CHAOS_TASKS);
      ctx.state.chaosLast = { kind: "TASK", text: task, ts: Date.now() };
      sendChaosTaskWebhook(ctx.env, task, user);
      ctx.broadcastState({ chaos: ctx.state.chaosLast, toast: `CHAOS TASK by ${user}` });
      return { ok: true };
    }

    if (authKey === "clearchaos") {
      ctx.state.chaosLast = null;
      ctx.broadcastState({ chaos: null, toast: `CHAOS cleared by ${user}` });
      return { ok: true };
    }

    if (authKey === "clearhits") {
      ctx.state.lastHits = [];
      ctx.broadcastState({ leaderboards: ctx.getLeaderboards(), toast: `HITS cleared by ${user}` });
      return { ok: true };
    }

    if (authKey === "resetxp") {
      if (!ctx.db?.db) return { ok: false, message: "db missing" };
      try {
        ctx.db.db.exec("UPDATE users SET xp=0, level=1, last_attack_ms=0, last_heal_ms=0, last_ue_ms=0, last_offensive_ms=0;");
        ctx.broadcastState({ leaderboards: ctx.getLeaderboards(), toast: `XP reset by ${user}` });
        return { ok: true };
      } catch {
        return { ok: false, message: "db error" };
      }
    }

    if (authKey === "resetall") {
      if (!ctx.db?.db) return { ok: false, message: "db missing" };
      try {
        setBossPhase(ctx.state, 1);
        ctx.eventEngine?.syncNow?.();
        ctx.state.lastHits = [];
        ctx.db.db.exec("DELETE FROM events; UPDATE users SET xp=0, level=1, last_attack_ms=0, last_heal_ms=0, last_ue_ms=0, last_offensive_ms=0;");
        ctx.broadcastState({ leaderboards: ctx.getLeaderboards(), toast: `RESET ALL by ${user}` });
        return { ok: true };
      } catch {
        return { ok: false, message: "db error" };
      }
    }
  }

  return { ok: false, silent: true, reason: "unknown_cmd" };
}
