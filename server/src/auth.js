import { normalizeUsername } from "./util.js";

export function buildAuth(env) {
  const admin = normalizeUsername(env.ADMIN_USERNAME || "olcha_str");
  return { admin };
}

export function roleFromCloudbotLevel(levelRaw) {
  // Cloudbot ma poziomy typu: everyone/mod/sub/admin (zależnie od UI).
  // Normalizujemy do: viewer | mod | admin
  const level = String(levelRaw || "").toLowerCase();

  if (["broadcaster", "streamer", "owner", "admin"].includes(level)) return "admin";
  if (["mod", "moderator"].includes(level)) return "mod";
  return "viewer";
}

export function isAdmin(user, auth) {
  return normalizeUsername(user) === auth.admin;
}

export function canRun(command, user, role, auth) {
  // command = np. "reset", "phase", "pause"
  // role: viewer|mod|admin

  // Admin-only
  const adminOnly = new Set([
    "reset",
    "sethp",
    "bosshit",
    "phase",
    "pause",
    "resume",
    "setmult",
    "clearhits",
    "clearchaos",
    "resetxp",
    "resetall",
    "shutdown"
  ]);
  // Mod lub admin
  const modOrAdmin = new Set(["pause", "resume", "maybechaos"]);

  if (adminOnly.has(command)) return role === "admin" || isAdmin(user, auth);
  if (modOrAdmin.has(command)) return role === "mod" || role === "admin" || isAdmin(user, auth);

  // Viewer commands default allow
  return true;
}
