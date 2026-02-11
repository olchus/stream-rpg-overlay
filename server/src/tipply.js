import crypto from "crypto";
import { applyDamage } from "./game.js";
import { normalizeUsername, safeInt, safeNumber } from "./util.js";

function getPath(obj, path) {
  if (!obj || !path) return undefined;
  const parts = String(path).split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in cur) cur = cur[p];
    else return undefined;
  }
  return cur;
}

function parseNumber(raw) {
  if (raw === null || raw === undefined) return NaN;
  const s = String(raw).replace(",", ".").trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function extractAmountPln(body, env) {
  const field = env.TIPPLY_AMOUNT_FIELD || "amount";
  let raw = getPath(body, field);
  if (raw === undefined) {
    // common fallbacks
    raw =
      body?.amount ??
      body?.amount_pln ??
      body?.amountPLN ??
      body?.gross_amount ??
      body?.value ??
      body?.sum ??
      body?.total ??
      undefined;
  }

  const n = parseNumber(raw);
  if (!Number.isFinite(n)) return { ok: false, reason: "amount_missing" };

  const scaleRaw = env.TIPPLY_AMOUNT_SCALE;
  const inGrosz = String(env.TIPPLY_AMOUNT_IN_GROSZ || "false").toLowerCase() === "true";
  const scale = Number.isFinite(Number(scaleRaw)) ? Number(scaleRaw) : inGrosz ? 0.01 : 1;
  const pln = n * scale;
  return { ok: true, amountPln: pln };
}

function extractPayer(body, env) {
  const field = env.TIPPLY_NAME_FIELD || "payer_name";
  let raw = getPath(body, field);
  if (raw === undefined) {
    raw = body?.payer_name ?? body?.name ?? body?.user ?? body?.nickname ?? "donator";
  }
  return normalizeUsername(raw) || "donator";
}

function extractCurrency(body, env) {
  const field = env.TIPPLY_CURRENCY_FIELD || "currency";
  return getPath(body, field) ?? body?.currency ?? null;
}

function extractGoalTotalPln(body, env) {
  const amountPath = env.TIPPLY_GOAL_AMOUNT_PATH || "stats.amount";
  const initialPath = env.TIPPLY_GOAL_INITIAL_PATH || "config.initial_value";

  const amountRaw = getPath(body, amountPath);
  const initialRaw = getPath(body, initialPath);

  const amount = parseNumber(amountRaw);
  if (!Number.isFinite(amount)) return { ok: false, reason: "amount_missing" };

  const includeInitial = String(env.TIPPLY_GOAL_INCLUDE_INITIAL || "true").toLowerCase() === "true";
  const initial = parseNumber(initialRaw);
  const totalRaw = includeInitial && Number.isFinite(initial) ? amount + initial : amount;

  const scaleRaw = env.TIPPLY_GOAL_SCALE;
  const inGrosz = String(env.TIPPLY_GOAL_IN_GROSZ || "true").toLowerCase() === "true";
  const scale = Number.isFinite(Number(scaleRaw)) ? Number(scaleRaw) : inGrosz ? 0.01 : 1;

  const totalPln = totalRaw * scale;
  if (!Number.isFinite(totalPln)) return { ok: false, reason: "total_invalid" };

  return { ok: true, totalPln };
}

export function registerTipplyWebhook(app, deps) {
  const { env, state, broadcastState, updateUser, recordEvent, getLeaderboards } = deps;

  const enabled = String(env.TIPPLY_WEBHOOK_ENABLED || "true").toLowerCase() === "true";
  if (!enabled) return;

  const donateMult = safeNumber(env.DONATE_DMG_MULT, 2.5);

  const path = env.TIPPLY_WEBHOOK_PATH || "/api/tipply";
  const secret = env.TIPPLY_WEBHOOK_SECRET || "";
  const headerName = String(env.TIPPLY_WEBHOOK_HEADER || "x-tipply-secret").toLowerCase();
  const expectCurrency = String(env.TIPPLY_EXPECT_CURRENCY || "PLN").toUpperCase();

  app.post(path, (req, res) => {
    const eventId = crypto.randomUUID();
    const envName = env.NODE_ENV || process.env.NODE_ENV || "unknown";
    const source = "tipply";
    const contentType = req.header("content-type") || "";

    if (secret) {
      const sig = req.header(headerName) || "";
      if (sig !== secret) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }
    }

    if (state.paused) {
      return res.json({ ok: true, paused: true });
    }

    const body = req.body || {};
    const currency = extractCurrency(body, env);
    if (currency && String(currency).toUpperCase() !== expectCurrency) {
      return res.json({ ok: true, ignored: true, reason: "currency_mismatch" });
    }

    const amount = extractAmountPln(body, env);
    if (!amount.ok) {
      console.log("[tipply][recv]", JSON.stringify({ env: envName, source, eventId, contentType, error: amount.reason }));
      return res.json({ ok: true, ignored: true, reason: amount.reason });
    }

    const pln = amount.amountPln;
    const dmg = Math.floor(pln) * donateMult;
    if (dmg <= 0) {
      return res.json({ ok: true, ignored: true, reason: "amount_lt_1" });
    }

    const who = extractPayer(body, env);

    updateUser(who, 20 + Math.min(100, dmg / 10));
    recordEvent(who, "donation_hit", dmg, JSON.stringify({ amountPln: pln, source }));
    applyDamage(state, who, dmg, "tipply_donation");

    broadcastState({
      leaderboards: getLeaderboards(),
      toast: `${who} donated ${pln.toFixed(2)} PLN → HIT -${dmg}`
    });

    return res.json({ ok: true });
  });
}

export function startTipplyGoalPoller(deps) {
  const { env, state, broadcastState, updateUser, recordEvent, getLeaderboards } = deps;

  const enabled = String(env.TIPPLY_GOAL_ENABLED || "false").toLowerCase() === "true";
  const url = env.TIPPLY_GOAL_API_URL || "";
  if (!enabled || !url) return;

  const donateMult = safeNumber(env.DONATE_DMG_MULT, 2.5);
  const pollMs = Math.max(2000, safeInt(env.TIPPLY_GOAL_POLL_MS, 15000));
  const actor = normalizeUsername(env.TIPPLY_GOAL_USER || "donator");
  const envName = env.NODE_ENV || process.env.NODE_ENV || "unknown";

  let lastTotalPln = null;
  let running = false;

  console.log(`[tipply][goal] polling ${url} every ${pollMs}ms`);

  async function tick() {
    if (running) return;
    running = true;

    try {
      const resp = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": "stream-rpg-overlay/1.0" }
      });

      if (!resp.ok) {
        console.log("[tipply][goal]", JSON.stringify({ env: envName, status: resp.status, url }));
        return;
      }

      const body = await resp.json();
      const total = extractGoalTotalPln(body, env);
      if (!total.ok) {
        console.log("[tipply][goal]", JSON.stringify({ env: envName, error: total.reason }));
        return;
      }

      if (lastTotalPln === null) {
        lastTotalPln = total.totalPln;
        console.log("[tipply][goal] baseline", total.totalPln.toFixed(2));
        return;
      }

      if (state.paused) {
        lastTotalPln = total.totalPln;
        return;
      }

      const delta = total.totalPln - lastTotalPln;
      if (delta < 0) {
        console.log("[tipply][goal] total decreased; resetting baseline");
        lastTotalPln = total.totalPln;
        return;
      }

      const dmg = Math.floor(delta) * donateMult;
      if (dmg <= 0) {
        lastTotalPln = total.totalPln;
        return;
      }

      lastTotalPln = total.totalPln;

      updateUser(actor, 20 + Math.min(100, dmg / 10));
      recordEvent(actor, "donation_hit", dmg, JSON.stringify({ amountPln: delta, source: "tipply_goal" }));
      applyDamage(state, actor, dmg, "tipply_goal");

      broadcastState({
        leaderboards: getLeaderboards(),
        toast: `${actor} donated ${delta.toFixed(2)} PLN â†’ HIT -${dmg}`
      });
    } catch (e) {
      console.log("[tipply][goal] error:", e?.message || e);
    } finally {
      running = false;
    }
  }

  tick();
  const timer = setInterval(tick, pollMs);
  if (timer.unref) timer.unref();
}
