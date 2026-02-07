const socket = io("/", { transports: ["websocket"] });

const hpText = document.getElementById("hpText");
const barFill = document.getElementById("barFill");
const hits = document.getElementById("hits");

socket.on("state", (state) => {
  hpText.textContent = `HP: ${state.bossHp} / ${state.bossMaxHp}`;
  const pct = Math.max(0, Math.min(1, state.bossHp / state.bossMaxHp));
  barFill.style.width = `${pct * 100}%`;

  hits.innerHTML = state.lastHits
    .map(h => `<div class="hit"><span class="by">${escapeHtml(h.by)}</span> <span class="amt">-${h.amount}</span> <span class="src">${h.source}</span></div>`)
    .join("");
});

function escapeHtml(s) {
  return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}
