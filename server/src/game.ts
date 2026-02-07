export type GameState = {
  bossHp: number;
  bossMaxHp: number;
  lastHits: Array<{ by: string; amount: number; source: string }>;
};

export function createGame(): GameState {
  return { bossHp: 5000, bossMaxHp: 5000, lastHits: [] };
}

export function applyHit(state: GameState, by: string, amount: number, source: string) {
  state.bossHp = Math.max(0, state.bossHp - amount);
  state.lastHits.unshift({ by, amount, source });
  state.lastHits = state.lastHits.slice(0, 8);

  // respawn bossa
  if (state.bossHp === 0) {
    state.bossHp = state.bossMaxHp;
    state.lastHits.unshift({ by: "SYSTEM", amount: 0, source: "BOSS DEFEATED → RESET" });
    state.lastHits = state.lastHits.slice(0, 8);
  }
}
