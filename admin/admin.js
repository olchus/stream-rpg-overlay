const API_ROOT = "/api/admin";

const refreshBtn = document.getElementById("refreshBtn");
const logoutBtn = document.getElementById("logoutBtn");

const bossHpEl = document.getElementById("bossHp");
const bossMaxHpEl = document.getElementById("bossMaxHp");
const phaseEl = document.getElementById("phase");
const pausedEl = document.getElementById("paused");
const logEl = document.getElementById("log");
const playersBodyEl = document.getElementById("playersBody");
const playersHeadEl = document.querySelector(".playersTable thead");

const pauseBtn = document.getElementById("pauseBtn");
const resumeBtn = document.getElementById("resumeBtn");
const resetXpBtn = document.getElementById("resetXpBtn");
const resetSkillsBtn = document.getElementById("resetSkillsBtn");
const seedUsersBtn = document.getElementById("seedUsersBtn");
const setHpForm = document.getElementById("setHpForm");
const setPhaseForm = document.getElementById("setPhaseForm");
const addXpForm = document.getElementById("addXpForm");
const toastEl = document.getElementById("toast");

let toastTimer = null;
let playersCache = [];
const sortState = { key: "xp", dir: "asc" };
let liveSocket = null;

function setLog(message) {
  logEl.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
}

function showToast(message, type = "ok") {
  if (!toastEl) return;
  if (toastTimer) clearTimeout(toastTimer);

  toastEl.hidden = false;
  toastEl.className = `toast ${type === "error" ? "toastError" : "toastOk"}`;
  toastEl.textContent = String(message || "");

  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, 2800);
}

function renderState(state) {
  bossHpEl.textContent = String(state?.bossHp ?? "--");
  bossMaxHpEl.textContent = String(state?.bossMaxHp ?? "--");
  phaseEl.textContent = String(state?.phase ?? "--");
  pausedEl.textContent = state?.paused ? "true" : "false";
}

function setupLiveStateUpdates() {
  if (typeof window.io !== "function") {
    setLog("live: socket.io client unavailable");
    return;
  }

  liveSocket = window.io();
  liveSocket.on("connect", () => setLog("live: connected"));
  liveSocket.on("disconnect", () => setLog("live: disconnected"));
  liveSocket.on("state", (payload) => {
    if (!payload || typeof payload !== "object") return;

    const prevPaused = pausedEl.textContent;
    renderState(payload);
    const nextPaused = payload?.paused ? "true" : "false";
    if (prevPaused !== nextPaused) {
      setLog(`live: paused=${nextPaused}`);
    }
    if (payload.toast) {
      showToast(payload.toast);
    }
  });
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escAttr(value) {
  return esc(value).replaceAll("\"", "&quot;").replaceAll("'", "&#39;");
}

function getSortDirectionForNewKey(key) {
  return "asc";
}

function applyPlayersSort(players) {
  const rows = Array.isArray(players) ? [...players] : [];
  const factor = sortState.dir === "desc" ? -1 : 1;

  rows.sort((a, b) => {
    let cmp = 0;
    if (sortState.key === "username") {
      const aa = String(a?.username || "");
      const bb = String(b?.username || "");
      cmp = aa.localeCompare(bb, undefined, { sensitivity: "base", numeric: true });
    } else {
      const aa = Number(a?.[sortState.key] || 0);
      const bb = Number(b?.[sortState.key] || 0);
      cmp = aa - bb;
    }

    if (cmp === 0) {
      const aa = String(a?.username || "");
      const bb = String(b?.username || "");
      cmp = aa.localeCompare(bb, undefined, { sensitivity: "base", numeric: true });
    }

    return cmp * factor;
  });

  return rows;
}

function updateSortHeaders() {
  const headers = playersHeadEl?.querySelectorAll("th[data-sort-key]") || [];
  for (const th of headers) {
    const key = String(th.dataset.sortKey || "");
    if (key === sortState.key) {
      th.dataset.sortDir = sortState.dir;
      th.title = `Sorted ${sortState.dir.toUpperCase()} (click to toggle)`;
    } else {
      th.dataset.sortDir = "";
      th.title = "Click to sort";
    }
  }
}

function renderPlayers(players) {
  const rows = applyPlayersSort(players);
  if (!rows.length) {
    playersBodyEl.innerHTML = `
      <tr>
        <td colspan="6" class="mutedCell">No players yet.</td>
      </tr>
    `;
    updateSortHeaders();
    return;
  }

  playersBodyEl.innerHTML = rows.map((player, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${esc(player.username)}</td>
      <td>${Number(player.xp || 0)}</td>
      <td>${Number(player.skill || 0)}</td>
      <td>${Number(player.dmg || 0)}</td>
      <td>
        <div class="rowActions">
          <button type="button" class="tinyBtn" data-skill-action="inc" data-user="${escAttr(player.username)}">Skill +1</button>
          <button type="button" class="tinyBtn" data-skill-action="dec" data-user="${escAttr(player.username)}">Skill -1</button>
          <button type="button" class="tinyBtn dangerBtn" data-skill-action="reset" data-user="${escAttr(player.username)}">Reset skill</button>
        </div>
      </td>
    </tr>
  `).join("");

  updateSortHeaders();
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
  playersCache = Array.isArray(data.players) ? data.players : [];
  renderPlayers(playersCache);
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
    showToast("XP reset completed");
  } catch (e) {
    setLog(`error: ${e.message}`);
    showToast(e.message, "error");
  }
});

resetSkillsBtn.addEventListener("click", async () => {
  const proceed = window.confirm("Reset skill for all users?");
  if (!proceed) return;

  const phrase = window.prompt("Type RESET to confirm global skill reset:", "");
  if (phrase !== "RESET") {
    setLog("cancelled: global skill reset confirmation failed");
    showToast("Reset skills cancelled", "error");
    return;
  }

  try {
    const data = await apiFetch("POST", "/skills/reset-all");
    const changed = Number(data?.summary?.changed || 0);
    setLog(`ok: /skills/reset-all (${changed} users)`);
    showToast(`Skills reset for ${changed} users`);
    await refreshState();
  } catch (e) {
    setLog(`error: ${e.message}`);
    showToast(e.message, "error");
  }
});

seedUsersBtn.addEventListener("click", async () => {
  try {
    await runAction("/users/seedtest");
    showToast("Test users added");
  } catch (e) {
    setLog(`error: ${e.message}`);
    showToast(e.message, "error");
  }
});

playersBodyEl.addEventListener("click", async (ev) => {
  const button = ev.target.closest("button[data-skill-action]");
  if (!button) return;

  const username = String(button.dataset.user || "").trim();
  const action = String(button.dataset.skillAction || "").trim();
  if (!username || !action) return;

  const label =
    action === "inc" ? "Skill +1" :
    action === "dec" ? "Skill -1" :
    "Reset skill";
  const route = `/users/${encodeURIComponent(username)}/skill/${encodeURIComponent(action)}`;

  button.disabled = true;
  try {
    await runAction(route);
    showToast(`${username}: ${label}`);
  } catch (e) {
    setLog(`error: ${e.message}`);
    showToast(e.message, "error");
  } finally {
    button.disabled = false;
  }
});

playersHeadEl?.addEventListener("click", (ev) => {
  const th = ev.target.closest("th[data-sort-key]");
  if (!th) return;

  const key = String(th.dataset.sortKey || "");
  if (!key) return;

  if (sortState.key === key) {
    sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
  } else {
    sortState.key = key;
    sortState.dir = getSortDirectionForNewKey(key);
  }

  renderPlayers(playersCache);
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

setupLiveStateUpdates();

setInterval(() => {
  refreshState().catch((e) => setLog(`error: ${e.message}`));
}, 5000);
