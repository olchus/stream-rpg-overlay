import { normalizeUsername, safeInt, clamp, nowMs, pickRandom } from "./util.js";
import { applyDamage, maybeChaos, setBossPhase } from "./game.js";
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
  "Musisz utrzymac min. X exp/h – jesli spadnie -> zmiana spawna.",
  "20 minut bez healowania exura (med) ico (tylko poty).",
  "MSem solo na miejscu \"nie dla MS\"."
];

function sendChaosTaskWebhook(env, task, user) {
  const url = String(env?.CHAOS_TASK_WEBHOOK_URL || "").trim();
  if (!url) return;
  const message = `😵‍💫💥CHAOS TASK: ${task} 😵‍💫💥`;
  const messageAscii = `CHAOS TASK: ${task}`;
  const target = new URL(url);
  // Keep query params as fallback for workflows reading webhook query instead of JSON body.
  target.searchParams.set("message", message);
  target.searchParams.set("text", message);
  target.searchParams.set("content", message);
  target.searchParams.set("message_ascii", messageAscii);
  target.searchParams.set("task", task);
  target.searchParams.set("by", user);

  fetch(target.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message,
      text: message,
      content: message,
      message_ascii: messageAscii,
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

export function handleCommand(ctx) {
  // ctx:
  // { user, role, rawText, state, env, db, broadcastState, recordEvent, updateUser, getLeaderboards, auth }
//console.log("[cmd]", { user: ctx.user, role: ctx.role, rawText: ctx.rawText });
  const userRaw = ctx?.userRaw ?? ctx?.user ?? "";
  const cmdRaw = ctx?.cmdRaw ?? ctx?.rawText ?? "";
  const roleRaw = ctx?.roleRaw ?? ctx?.role ?? "";
  const envName = ctx?.env?.NODE_ENV || process.env.NODE_ENV || "unknown";
  const source = ctx?.source || "unknown";
  const eventId = ctx?.eventId || "na";

  const user = normalizeUsername(ctx.user);
  const { cmd, args } = parseArgs(ctx.rawText);
  let cmdNorm = cmd;
  let bosshitInline = null;
  const bosshitMatch = cmd.match(/^bosshit\+?(-?\d+)$/);
  if (bosshitMatch) {
    cmdNorm = "bosshit";
    bosshitInline = bosshitMatch[1];
  }
  if (cmdNorm === "makechaos") {
    cmdNorm = "maybechaos";
  }

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

  if (ctx.state.paused && (ctx.role === "viewer")) {
    return { ok: false, message: "paused" };
 }

  if (!cmd) return { ok: false, silent: true };

  // routing komend: viewer
  if (cmd === "attack") {
    if (ctx.state.paused) return { ok: false, message: "paused" };

    const dmgBase = safeInt(ctx.env.CHAT_ATTACK_DAMAGE, 5);
    const dmg = clamp(dmgBase, 1, 9999);
    const cooldownMs = safeInt(ctx.env.CHAT_ATTACK_COOLDOWN_MS, 60000);
    const now = nowMs();
    const row = ctx.db?.getUser?.get ? ctx.db.getUser.get(user) : null;
    const lastAttackMs = row?.last_attack_ms ?? 0;

    if (now - lastAttackMs < cooldownMs) {
      return { ok: false, silent: true };
    }

    ctx.updateUser(user, 2, now);
    ctx.recordEvent(user, "chat_attack", dmg, "cloudbot");
    applyDamage(ctx.state, user, dmg, "cloudbot_attack");

    ctx.broadcastState({ leaderboards: ctx.getLeaderboards(), toast: `${user} !attack → -${dmg}` });
    return { ok: true };
  }

  if (cmd === "heal") {
    if (ctx.state.paused) return { ok: false, message: "paused" };

    const cooldownMs = safeInt(ctx.env.CHAT_HEAL_COOLDOWN_MS, 120000);
    const now = nowMs();
    const row = ctx.db?.getUser?.get ? ctx.db.getUser.get(user) : null;
    const lastHealMs = row?.last_heal_ms ?? 0;
    if (now - lastHealMs < cooldownMs) {
      return { ok: false, silent: true };
    }

    const heal = 15;
    ctx.state.bossHp = Math.min(ctx.state.bossMaxHp, ctx.state.bossHp + heal);

    ctx.updateUser(user, 5, null, now);
    ctx.recordEvent(user, "chat_heal", heal, "cloudbot");

    ctx.broadcastState({ leaderboards: ctx.getLeaderboards(), toast: `${user} !heal → +${heal} 😈` });
    return { ok: true };
  }

  // ---- ADMIN / MOD ----
  // mapujemy aliasy admin komend
  const adminCmd = cmdNorm === "boss" ? (args[0] || "").toLowerCase() : cmdNorm; // np. !boss reset
  const adminArgs = cmdNorm === "boss" ? args.slice(1) : args;

  // Ustal “nazwa komendy do autoryzacji”
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
      applyDamage(ctx.state, user, dmg, "admin_bosshit");
      ctx.broadcastState({ leaderboards: ctx.getLeaderboards(), toast: `BOSS HIT -${dmg} by ${user}` });
      return { ok: true };
    }

    if (authKey === "phase") {
      const p = clamp(safeInt(adminArgs[0], ctx.state.phase), 1, 9999);
      setBossPhase(ctx.state, p);
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
      // przykład: !setmult donate 12
      // przechowujemy w state.runtimeOverrides
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
        ctx.db.db.exec("UPDATE users SET xp=0, level=1, last_attack_ms=0, last_heal_ms=0;");
        ctx.broadcastState({ leaderboards: ctx.getLeaderboards(), toast: `XP reset by ${user}` });
        return { ok: true };
      } catch (e) {
        return { ok: false, message: "db error" };
      }
    }

    if (authKey === "resetall") {
      if (!ctx.db?.db) return { ok: false, message: "db missing" };
      try {
        setBossPhase(ctx.state, 1);
        ctx.state.lastHits = [];
        ctx.db.db.exec("DELETE FROM events; UPDATE users SET xp=0, level=1, last_attack_ms=0, last_heal_ms=0;");
        ctx.broadcastState({ leaderboards: ctx.getLeaderboards(), toast: `RESET ALL by ${user}` });
        return { ok: true };
      } catch (e) {
        return { ok: false, message: "db error" };
      }
    }
  }

  return { ok: false, silent: true };
}
