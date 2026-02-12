import { clamp, nowMs, pickRandom, safeInt, safeNumber, normalizeUsername } from "./util.js";

const PHASE_HP_STEP = 2000;

function maxHpForPhase(baseHp, phase) {
  const p = Math.max(1, safeInt(phase, 1));
  return baseHp + (p - 1) * PHASE_HP_STEP;
}

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
  const bossBase = safeInt(env.BOSS_MAX_HP, 5000);
  return {
    bossBaseHp: bossBase,
    bossMaxHp: bossBase,
    bossHp: bossBase,
    phase: 1,
    phaseStartMs: nowMs(),
    lastHits: [], // {by, amount, source, ts}
    chaosLast: null, // {kind, ts, text}
    phaseWinners: [], // {username, dmg} top 3 from last phase
    startedAtMs: nowMs()
  };
}

export function setBossPhase(state, phase) {
  const base = safeInt(state.bossBaseHp ?? state.bossMaxHp, 1);
  const p = Math.max(1, safeInt(phase, 1));
  const maxHp = maxHpForPhase(base, p);
  state.bossBaseHp = base;
  state.phase = p;
  state.bossMaxHp = maxHp;
  state.bossHp = maxHp;
}

export function applyDamage(state, byRaw, amountRaw, source) {
  const by = normalizeUsername(byRaw);
  const amount = clamp(safeNumber(amountRaw, 0), 0, 999999);

  state.bossHp = clamp(state.bossHp - amount, 0, state.bossMaxHp);

  state.lastHits.unshift({ by, amount, source, ts: nowMs() });
  state.lastHits = state.lastHits.slice(0, 10);

  // boss defeated -> next phase
  if (state.bossHp === 0) {
    const nextPhase = Math.max(1, safeInt(state.phase, 1)) + 1;
    setBossPhase(state, nextPhase);
    state.lastHits.unshift({ by: "SYSTEM", amount: 0, source: `BOSS DEFEATED -> PHASE ${nextPhase}`, ts: nowMs() });
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
