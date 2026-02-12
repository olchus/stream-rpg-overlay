const socket = io("/", { transports: ["websocket"] });

const hpText = document.getElementById("hpText");
const barFill = document.getElementById("barFill");
const hits = document.getElementById("hits");
const phase = document.getElementById("phase");
const toast = document.getElementById("toast");
const chaos = document.getElementById("chaos");
const topDmg = document.getElementById("topDmg");
const topXp = document.getElementById("topXp");
const reward1 = document.getElementById("reward1");
const reward2 = document.getElementById("reward2");
const reward3 = document.getElementById("reward3");
const phaseWinnersTitle = document.getElementById("phaseWinnersTitle");
const phaseWinners = document.getElementById("phaseWinners");

let toastTimer = null;

socket.on("state", (s) => {
  const hp = s.bossHp ?? 0;
  const max = s.bossMaxHp ?? 1;
  const pct = Math.max(0, Math.min(1, hp / max));

  hpText.textContent = `HP: ${hp} / ${max}`;
  barFill.style.width = `${pct * 100}%`;

  const phaseRaw = Number(s.phase);
  const phaseNum = Number.isFinite(phaseRaw) && phaseRaw > 0
    ? Math.trunc(phaseRaw)
    : 1;
  phase.textContent = `PHASE ${phaseNum}`;
  document.body.dataset.phase = String(phaseNum);

  // reward pool grows by +25 TC for each place on every next phase
  const phaseBonus = Math.max(0, phaseNum - 1) * 25;
  if (reward1) reward1.textContent = `${100 + phaseBonus}TC`;
  if (reward2) reward2.textContent = `${50 + phaseBonus}TC`;
  if (reward3) reward3.textContent = `${25 + phaseBonus}TC`;

  // last hits
  hits.innerHTML = (s.lastHits || [])
    .slice(0, 3)
    .map(h => `<div class="hit">
        <span class="by">${esc(h.by)}</span>
        <span class="amt">-${h.amount}</span>
        <span class="src">${esc(h.source)}</span>
      </div>`)
    .join("");

  // toast
  if (s.toast) showToast(s.toast);

  // chaos: always overwrite text so clearchaos can blank the field immediately
  const c = s.chaos || s.chaosLast;
  chaos.textContent = c?.text || "";

  // leaderboards
  const lbs = s.leaderboards || {};
  const dmg = lbs.topDmg || [];
  const xp = lbs.topXp || [];

  topDmg.innerHTML = dmg.length
    ? dmg.slice(0, 5).map((r, i) => `<div class="lb"><span class="rank">#${i+1}</span><span class="name">${esc(r.username)}</span><span class="val">${r.dmg}</span></div>`).join("")
    : `<div class="muted">no data yet</div>`;

  topXp.innerHTML = xp.length
    ? xp.slice(0, 5).map((r, i) => `<div class="lb"><span class="rank">#${i+1}</span><span class="name">${esc(r.username)}</span><span class="val">lvl ${r.level} / ${r.xp}xp</span></div>`).join("")
    : `<div class="muted">no data yet</div>`;

  // phase winners
  const winners = s.phaseWinners || [];
  const winnersPhaseRaw = Number(s.phaseWinnersPhase);
  const winnersPhase = Number.isFinite(winnersPhaseRaw) && winnersPhaseRaw > 0
    ? Math.trunc(winnersPhaseRaw)
    : null;
  const showWinners = Boolean(winnersPhase) && winners.length > 0;
  if (phaseWinnersTitle) {
    phaseWinnersTitle.textContent = winnersPhase
      ? `PHASE ${winnersPhase} WINNERS`
      : "PHASE WINNERS";
  }
  phaseWinners.innerHTML = showWinners
    ? winners.map((w, i) => {
        const medals = ['🥇', '🥈', '🥉'];
        const medal = medals[i] || '•';
        return `<div class="winner"><span class="medal">${medal}</span><span class="name">${esc(w.username)} </span><span class="level">lvl ${w.level} / ${w.xp ?? 0}xp</span></div>`;
      }).join("")
    : `<div class="muted">no winners yet</div>`;
});

function showToast(text) {
  toast.textContent = text;
  toast.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2500);
}

function esc(s) {
  return String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}
