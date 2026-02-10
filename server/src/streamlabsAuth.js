import fs from "fs";
import path from "path";

const API_BASE = "https://streamlabs.com/api/v2.0";

function getDataDir(env) {
  return env.DATA_DIR || "/app/data";
}

function getTokenPath(env) {
  return env.STREAMLABS_TOKEN_PATH || path.join(getDataDir(env), "streamlabs.json");
}

export function buildStreamlabsAuth(env) {
  return {
    clientId: env.STREAMLABS_CLIENT_ID || "",
    clientSecret: env.STREAMLABS_CLIENT_SECRET || "",
    redirectUri: env.STREAMLABS_REDIRECT_URI || "",
    scopes: env.STREAMLABS_SCOPES || "socket.token",
    tokenPath: getTokenPath(env)
  };
}

export function hasStreamlabsAuth(cfg) {
  return Boolean(cfg.clientId && cfg.clientSecret && cfg.redirectUri);
}

export function buildAuthorizeUrl(cfg, state = "") {
  const url = new URL(`${API_BASE}/authorize`);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("response_type", "code");
  if (cfg.scopes) url.searchParams.set("scope", cfg.scopes);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

export function loadStreamlabsToken(env) {
  const p = getTokenPath(env);
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch (e) {
    console.log("[streamlabs] token read error:", e?.message || e);
    return null;
  }
}

export function saveStreamlabsToken(env, token) {
  const p = getTokenPath(env);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(token, null, 2));
}

export async function exchangeCodeForToken(cfg, code) {
  const body = {
    grant_type: "authorization_code",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    code
  };

  const resp = await fetch(`${API_BASE}/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest"
    },
    body: JSON.stringify(body)
  });

  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`streamlabs token: invalid json (${text})`);
  }

  if (!resp.ok) {
    const msg = json?.error || json?.message || text;
    throw new Error(`streamlabs token error ${resp.status}: ${msg}`);
  }

  return json;
}

export async function fetchSocketToken(accessToken) {
  const resp = await fetch(`${API_BASE}/socket/token`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Requested-With": "XMLHttpRequest"
    }
  });

  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`streamlabs socket: invalid json (${text})`);
  }

  if (!resp.ok) {
    const msg = json?.error || json?.message || text;
    throw new Error(`streamlabs socket error ${resp.status}: ${msg}`);
  }

  const socketToken = json?.socket_token || json?.socketToken || json?.token || "";
  if (!socketToken) {
    throw new Error("streamlabs socket token missing in response");
  }

  return socketToken;
}
