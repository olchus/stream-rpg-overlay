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
const eventBox = document.getElementById("eventBox");
const eventTitle = document.getElementById("eventTitle");
const eventTimer = document.getElementById("eventTimer");
const eventMeta = document.getElementById("eventMeta");

let toastTimer = null;
let activeEvent = null;
let currentPhase = 1;
let streamLive = true;

socket.on("state", (s) => {
  const hp = s.bossHp ?? 0;
  const max = s.bossMaxHp ?? 1;
  const pct = Math.max(0, Math.min(1, hp / max));

  hpText.textContent = `HP: ${hp} / ${max}`;
  barFill.style.width = `${pct * 100}%`;

  const phaseRaw = Number(s.phase);
  currentPhase = Number.isFinite(phaseRaw) && phaseRaw > 0
    ? Math.trunc(phaseRaw)
    : 1;
  phase.textContent = `PHASE ${currentPhase}`;
  document.body.dataset.phase = String(currentPhase);

  const phaseBonus = Math.max(0, currentPhase - 1) * 25;
  if (reward1) reward1.textContent = `${100 + phaseBonus}TC`;
  if (reward2) reward2.textContent = `${50 + phaseBonus}TC`;
  if (reward3) reward3.textContent = `${25 + phaseBonus}TC`;

  hits.innerHTML = (s.lastHits || [])
    .slice(0, 3)
    .map((h) => `<div class="hit">
        <span class="by">${esc(h.by)}</span>
        <span class="amt">-${h.amount}</span>
        <span class="src">${esc(h.source)}</span>
      </div>`)
    .join("");

  if (s.toast) showToast(s.toast);

  const c = s.chaos || s.chaosLast;
  chaos.textContent = c?.text || "";

  const lbs = s.leaderboards || {};
  const dmg = lbs.topDmg || [];
  const xp = lbs.topXp || [];

  topDmg.innerHTML = dmg.length
    ? dmg.slice(0, 5).map((r, i) => `<div class="lb"><span class="rank">#${i + 1}</span><span class="name">${esc(r.username)}</span><span class="val">${r.dmg}</span></div>`).join("")
    : `<div class="muted">no data yet</div>`;

  topXp.innerHTML = xp.length
    ? xp.slice(0, 5).map((r, i) => {
        const skill = Number.isFinite(Number(r.skill)) ? Math.trunc(Number(r.skill)) : "-";
        return `<div class="lb"><span class="rank">#${i + 1}</span><span class="name">${esc(r.username)}</span><span class="val">${r.xp}xp / sk${skill}</span></div>`;
      }).join("")
    : `<div class="muted">no data yet</div>`;

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
        const medals = ["#1", "#2", "#3"];
        const medal = medals[i] || "*";
        const skill = Number.isFinite(Number(w.skill)) ? Math.trunc(Number(w.skill)) : "-";
        return `<div class="winner"><span class="medal">${medal}</span><span class="name">${esc(w.username)} </span><span class="level">${w.xp ?? 0}xp / sk${skill}</span></div>`;
      }).join("")
    : `<div class="muted">no winners yet</div>`;

  streamLive = s.streamLive !== false;
  activeEvent = s.activeEvent || null;
  renderEvent();
});

setInterval(renderEventTimerOnly, 1000);

function renderEvent() {
  if (!eventBox || !eventTitle || !eventTimer || !eventMeta) return;

  if (!activeEvent) {
    eventTitle.textContent = "No active event";
    eventTimer.textContent = "--:--";
    if (!streamLive) {
      eventMeta.textContent = "Stream offline - event timers paused";
    } else if (currentPhase < 2) {
      eventMeta.textContent = "Events start from phase 2";
    } else {
      eventMeta.textContent = "Waiting for next random event";
    }
    return;
  }

  eventTitle.textContent = String(activeEvent.title || "Active event");
  eventMeta.textContent = buildEventMetaText(activeEvent);
  renderEventTimerOnly();
}

function renderEventTimerOnly() {
  if (!eventTimer) return;
  if (!activeEvent) {
    eventTimer.textContent = "--:--";
    return;
  }
  const remainingMs = getRemainingMs(activeEvent);
  eventTimer.textContent = formatMmSs(remainingMs);
}

function getRemainingMs(ev) {
  const endsAt = Number(ev?.endsAt);
  if (Number.isFinite(endsAt) && endsAt > 0) {
    return Math.max(0, endsAt - Date.now());
  }
  const pausedRemaining = Number(ev?.pausedRemainingMs);
  if (Number.isFinite(pausedRemaining) && pausedRemaining >= 0) {
    return pausedRemaining;
  }
  return 0;
}

function formatMmSs(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function buildEventMetaText(ev) {
  const type = String(ev?.type || "").toLowerCase();
  const meta = ev?.meta || {};

  if (type === "shield") {
    return "Break the Shield: boss damage reduced";
  }
  if (type === "silence") {
    return "Silence active: !ue disabled";
  }
  if (type === "mark") {
    const marked = meta.markedUser || "unknown";
    const charges = Number.isFinite(Number(meta.charges)) ? Math.trunc(Number(meta.charges)) : 0;
    const target = Number.isFinite(Number(meta.chargeTarget)) ? Math.trunc(Number(meta.chargeTarget)) : 0;
    const status = meta.broken ? " | Vulnerable active" : "";
    return `Mark: ${marked} | Charges ${charges}/${target}${status}`;
  }
  if (type === "exhaust") {
    return "Exhaust active: rotate attackers";
  }
  if (type === "roleswap") {
    return "Role Swap: !heal deals dmg / !attack heals boss";
  }
  if (type === "totem") {
    const hp = Number.isFinite(Number(meta.hp)) ? Math.trunc(Number(meta.hp)) : 0;
    const hpMax = Number.isFinite(Number(meta.hpMax)) ? Math.trunc(Number(meta.hpMax)) : 0;
    return `Totem HP: ${hp}/${hpMax}`;
  }
  return String(ev?.description || "");
}

function showToast(text) {
  toast.textContent = text;
  toast.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2500);
}

function esc(s) {
  return String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
