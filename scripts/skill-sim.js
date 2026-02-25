import { awardSkill, requiredSkillTries } from "../server/src/game.js";

function safeInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function safeNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const attacks = Math.max(1, safeInt(process.argv[2], 1000));
const logEvery = Math.max(1, safeInt(process.argv[3], 100));
const cfg = {
  SKILL_START: Math.max(1, safeInt(process.env.SKILL_START, 1)),
  SKILL_BASE_TRIES: Math.max(1, safeInt(process.env.SKILL_BASE_TRIES, 40)),
  SKILL_GROWTH: Math.max(1.01, safeNumber(process.env.SKILL_GROWTH, 1.16))
};
const tryPerAttack = Math.max(1, safeInt(process.env.SKILL_TRY_PER_ATTACK, 1));

let skill = cfg.SKILL_START;
let skillTries = 0;
let totalUps = 0;

console.log(`[skill-sim] attacks=${attacks} tryPerAttack=${tryPerAttack}`);
console.log(`[skill-sim] cfg=${JSON.stringify(cfg)}`);

for (let i = 1; i <= attacks; i++) {
  const next = awardSkill(skill, skillTries, tryPerAttack, cfg);
  skill = next.skill;
  skillTries = next.skillTries;
  totalUps += next.skillUps;

  if (i % logEvery === 0 || next.skillUps > 0 || i === attacks) {
    const need = requiredSkillTries(skill, cfg);
    console.log(
      `[skill-sim] attack=${i} skill=${skill} tries=${skillTries}/${need} skillUps=${totalUps}`
    );
  }
}
