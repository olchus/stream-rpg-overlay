import { normalizeUsername } from "./util.js";

function authUserKey(user) {
  return normalizeUsername(user).toLowerCase();
}

export function buildAuth(env) {
  const admin = authUserKey(env.ADMIN_USERNAME || "olcha_str");
  return { admin };
}

export function roleFromLevel(levelRaw) {
  // Normalize upstream role labels to: viewer | mod | admin.
  const level = String(levelRaw || "").toLowerCase();

  if (["broadcaster", "streamer", "owner", "admin"].includes(level)) return "admin";
  if (["mod", "moderator"].includes(level)) return "mod";
  return "viewer";
}

// Backward-compatible alias for existing imports.
export const roleFromCloudbotLevel = roleFromLevel;

export function isAdmin(user, auth) {
  return authUserKey(user) === auth.admin;
}

export function canRun(command, user, role, auth) {
  // command = e.g. "reset", "phase", "pause"
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
  // Mod or admin
  const modOrAdmin = new Set(["pause", "resume", "maybechaos"]);

  if (adminOnly.has(command)) return role === "admin" || isAdmin(user, auth);
  if (modOrAdmin.has(command)) return role === "mod" || role === "admin" || isAdmin(user, auth);

  // Viewer commands default allow
  return true;
}
