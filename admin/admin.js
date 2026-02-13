const API_ROOT = "/api/admin";

const refreshBtn = document.getElementById("refreshBtn");
const logoutBtn = document.getElementById("logoutBtn");

const bossHpEl = document.getElementById("bossHp");
const bossMaxHpEl = document.getElementById("bossMaxHp");
const phaseEl = document.getElementById("phase");
const pausedEl = document.getElementById("paused");
const logEl = document.getElementById("log");
const playersBodyEl = document.getElementById("playersBody");

const pauseBtn = document.getElementById("pauseBtn");
const resumeBtn = document.getElementById("resumeBtn");
const resetXpBtn = document.getElementById("resetXpBtn");
const seedUsersBtn = document.getElementById("seedUsersBtn");
const setHpForm = document.getElementById("setHpForm");
const setPhaseForm = document.getElementById("setPhaseForm");
const addXpForm = document.getElementById("addXpForm");

function setLog(message) {
  logEl.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
}

function renderState(state) {
  bossHpEl.textContent = String(state?.bossHp ?? "--");
  bossMaxHpEl.textContent = String(state?.bossMaxHp ?? "--");
  phaseEl.textContent = String(state?.phase ?? "--");
  pausedEl.textContent = state?.paused ? "true" : "false";
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderPlayers(players) {
  const rows = Array.isArray(players) ? players : [];
  if (!rows.length) {
    playersBodyEl.innerHTML = `
      <tr>
        <td colspan="4" class="mutedCell">No players yet.</td>
      </tr>
    `;
    return;
  }

  playersBodyEl.innerHTML = rows.map((player, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${esc(player.username)}</td>
      <td>${Number(player.xp || 0)}</td>
      <td>${Number(player.dmg || 0)}</td>
    </tr>
  `).join("");
}

async function apiFetch(method, path, body) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const resp = await fetch(`${API_ROOT}${path}`, {
    method,
    credentials: "include",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  let data = {};
  try {
    data = await resp.json();
  } catch {
    data = {};
  }

  if (!resp.ok || !data?.ok) {
    const msg = data?.error || `request failed (${resp.status})`;
    if (resp.status === 401) {
      window.location.href = "/admin/";
      return;
    }
    throw new Error(msg);
  }

  return data;
}

async function refreshState() {
  const data = await apiFetch("GET", "/state");
  renderState(data.state);
  renderPlayers(data.players);
  setLog(`state loaded (phase=${data.state?.phase}, hp=${data.state?.bossHp})`);
}

async function runAction(path, body) {
  const data = await apiFetch("POST", path, body);
  setLog(`ok: ${path}`);
  if (data.state) renderState(data.state);
  await refreshState();
}

refreshBtn.addEventListener("click", async () => {
  try {
    await refreshState();
  } catch (e) {
    setLog(`error: ${e.message}`);
  }
});

pauseBtn.addEventListener("click", async () => {
  try {
    await runAction("/pause");
  } catch (e) {
    setLog(`error: ${e.message}`);
  }
});

resumeBtn.addEventListener("click", async () => {
  try {
    await runAction("/resume");
  } catch (e) {
    setLog(`error: ${e.message}`);
  }
});

resetXpBtn.addEventListener("click", async () => {
  const proceed = window.confirm("Reset XP for all users?");
  if (!proceed) return;
  try {
    await runAction("/users/resetxp");
  } catch (e) {
    setLog(`error: ${e.message}`);
  }
});

seedUsersBtn.addEventListener("click", async () => {
  try {
    await runAction("/users/seedtest");
  } catch (e) {
    setLog(`error: ${e.message}`);
  }
});

addXpForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const userInput = document.getElementById("xpUserInput");
  const xpInput = document.getElementById("xpAmountInput");
  const username = String(userInput.value || "").trim();
  const xp = Number(xpInput.value);

  if (!username) {
    setLog("error: username is required");
    return;
  }
  if (!Number.isFinite(xp) || xp <= 0) {
    setLog("error: xp must be > 0");
    return;
  }

  try {
    await runAction("/users/addxp", { username, xp });
  } catch (e) {
    setLog(`error: ${e.message}`);
  }
});

setHpForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const hpInput = document.getElementById("hpInput");
  const hp = Number(hpInput.value);
  if (!Number.isFinite(hp)) {
    setLog("error: hp must be a number");
    return;
  }
  try {
    await runAction("/boss/sethp", { hp });
  } catch (e) {
    setLog(`error: ${e.message}`);
  }
});

setPhaseForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const phaseInput = document.getElementById("phaseInput");
  const n = Number(phaseInput.value);
  if (!Number.isFinite(n)) {
    setLog("error: phase must be a number");
    return;
  }
  try {
    await runAction("/boss/phase", { n });
  } catch (e) {
    setLog(`error: ${e.message}`);
  }
});

logoutBtn.addEventListener("click", async () => {
  try {
    await fetch(`${API_ROOT}/logout`, {
      method: "POST",
      credentials: "include"
    });
  } finally {
    window.location.href = "/admin/";
  }
});

apiFetch("GET", "/session")
  .then(() => refreshState())
  .catch((e) => setLog(`error: ${e.message}`));

setInterval(() => {
  refreshState().catch((e) => setLog(`error: ${e.message}`));
}, 5000);
