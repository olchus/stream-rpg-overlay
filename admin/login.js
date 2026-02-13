const form = document.getElementById("loginForm");
const identifierInput = document.getElementById("identifierInput");
const passwordInput = document.getElementById("passwordInput");
const errorBox = document.getElementById("errorBox");

function showError(message) {
  errorBox.hidden = false;
  errorBox.textContent = message;
}

function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = "";
}

async function checkSession() {
  try {
    const resp = await fetch("/api/admin/session", { credentials: "include" });
    if (!resp.ok) return;
    const data = await resp.json();
    if (data?.ok) {
      window.location.href = "/admin/panel";
    }
  } catch {
    // no-op
  }
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  clearError();

  const identifier = String(identifierInput.value || "").trim();
  const password = String(passwordInput.value || "");
  if (!identifier || !password) {
    showError("Podaj email/login oraz haslo.");
    return;
  }

  try {
    const resp = await fetch("/api/admin/login", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password })
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data?.ok) {
      showError(data?.error || "Niepoprawne dane logowania.");
      return;
    }
    window.location.href = "/admin/panel";
  } catch (e) {
    showError(e?.message || "Blad polaczenia.");
  }
});

checkSession();
