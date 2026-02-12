import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DATA_DIR = process.env.DATA_DIR || "/app/data";
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "game.sqlite");

export function initDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      xp INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 1,
      last_attack_ms INTEGER NOT NULL DEFAULT 0,
      last_heal_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_ms INTEGER NOT NULL,
      username TEXT NOT NULL,
      kind TEXT NOT NULL,
      amount INTEGER NOT NULL DEFAULT 0,
      meta TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts_ms);
  `);

  const userColumns = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!userColumns.includes("last_heal_ms")) {
    db.exec("ALTER TABLE users ADD COLUMN last_heal_ms INTEGER NOT NULL DEFAULT 0;");
  }

  const upsertUser = db.prepare(`
    INSERT INTO users (username, xp, level, last_attack_ms, last_heal_ms)
    VALUES (@username, @xp, @level, @last_attack_ms, @last_heal_ms)
    ON CONFLICT(username) DO UPDATE SET
      xp=excluded.xp,
      level=excluded.level,
      last_attack_ms=excluded.last_attack_ms,
      last_heal_ms=excluded.last_heal_ms
  `);

  const getUser = db.prepare(`SELECT username, xp, level, last_attack_ms, last_heal_ms FROM users WHERE username=?`);

  const setLastAttack = db.prepare(`UPDATE users SET last_attack_ms=? WHERE username=?`);

  const addEvent = db.prepare(`
    INSERT INTO events (ts_ms, username, kind, amount, meta)
    VALUES (?, ?, ?, ?, ?)
  `);

  const topUsersByXp = db.prepare(`
    SELECT username, xp, level FROM users
    ORDER BY xp DESC
    LIMIT ?
  `);

  const topHittersToday = db.prepare(`
    SELECT username, SUM(amount) AS dmg
    FROM events
    WHERE kind IN ('chat_attack','sub_hit','donation_hit','follow_hit','kick_gift')
      AND ts_ms >= ?
    GROUP BY username
    ORDER BY dmg DESC
    LIMIT ?
  `);

  const topHittersInRange = db.prepare(`
    SELECT username, SUM(amount) AS dmg
    FROM events
    WHERE kind IN ('chat_attack','sub_hit','donation_hit','follow_hit','kick_gift')
      AND ts_ms >= ? AND ts_ms <= ?
    GROUP BY username
    ORDER BY dmg DESC
    LIMIT ?
  `);

  const resetDaily = db.prepare(`
    DELETE FROM events WHERE ts_ms < ?
  `);

  return {
    db,
    getUser,
    upsertUser,
    setLastAttack,
    addEvent,
    topUsersByXp,
    topHittersToday,
    topHittersInRange,
    resetDaily
  };
}
