import { clamp, nowMs, pickRandom, safeInt, normalizeUsername } from "./util.js";

function computeLevelFromXp(xp) {
  // prosta krzywa: lvl rośnie co 100xp + rosnący próg
  // możesz później zmienić bez ruszania reszty
  let level = 1;
  let need = 100;
  let remain = xp;
  while (remain >= need && level < 999) {
    remain -= need;
    level++;
    need = Math.floor(need * 1.15);
  }
  return level;
}

export function createGameState(env) {
  const bossMax = safeInt(env.BOSS_MAX_HP, 5000);
  return {
    bossMaxHp: bossMax,
    bossHp: bossMax,
    phase: 1,
    lastHits: [], // {by, amount, source, ts}
    chaosLast: null, // {kind, ts, text}
    startedAtMs: nowMs()
  };
}

export function bossPhaseFor(hpPct) {
  if (hpPct <= 0.10) return 4;
  if (hpPct <= 0.40) return 3;
  if (hpPct <= 0.70) return 2;
  return 1;
}

export function applyDamage(state, byRaw, amountRaw, source) {
  const by = normalizeUsername(byRaw);
  const amount = clamp(safeInt(amountRaw, 0), 0, 999999);

  state.bossHp = clamp(state.bossHp - amount, 0, state.bossMaxHp);

  const hpPct = state.bossHp / state.bossMaxHp;
  state.phase = bossPhaseFor(hpPct);

  state.lastHits.unshift({ by, amount, source, ts: nowMs() });
  state.lastHits = state.lastHits.slice(0, 10);

  // boss defeated -> reset
  if (state.bossHp === 0) {
    state.lastHits.unshift({ by: "SYSTEM", amount: 0, source: "BOSS_DEFEATED → RESET", ts: nowMs() });
    state.bossHp = state.bossMaxHp;
    state.phase = 1;
    state.lastHits = state.lastHits.slice(0, 10);
    return { defeated: true };
  }
  return { defeated: false };
}

export function maybeChaos(state, enabled, thresholdAmount, donationAmount) {
  if (!enabled) return null;
  if (donationAmount < thresholdAmount) return null;

  const options = [
    { kind: "SCREEN_SHAKE", text: "CHAOS: Screen shake!" },
    { kind: "ZOOM_PUNCH", text: "CHAOS: Zoom punch!" },
    { kind: "INVERT_HINT", text: "CHAOS: Invert controls (hint)!" },
    { kind: "CRIT_RAIN", text: "CHAOS: Critical rain!" },
    { kind: "SLOWMO", text: "CHAOS: Slow motion vibe!" }
  ];

  const chosen = pickRandom(options);
  state.chaosLast = { kind: chosen.kind, text: chosen.text, ts: nowMs() };
  return state.chaosLast;
}

export function awardXp(xpCurrent, add) {
  const xp = clamp(xpCurrent + safeInt(add, 0), 0, 2_000_000_000);
  const level = computeLevelFromXp(xp);
  return { xp, level };
}
