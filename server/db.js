/* Uses Node's built-in SQLite (node:sqlite) rather than better-sqlite3, so the
   app has zero native dependencies and `npm ci` never needs a compiler.
   Requires Node 22.5+; stable from Node 24. */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'huddle.db'));

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  color        TEXT NOT NULL DEFAULT '#e4e4e2',
  status_text  TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS servers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS server_members (
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id)
);

CREATE TABLE IF NOT EXISTS channels (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  type      TEXT NOT NULL DEFAULT 'text',   -- text | voice | dm
  position  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dm_participants (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  content    TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'user',  -- user | system
  reply_to   INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  edited_at  INTEGER,
  deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);

CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
`);

/** node:sqlite has no transaction() helper, so wrap one by hand. */
function transaction(fn) {
  return function () {
    db.exec('BEGIN');
    try {
      const result = fn.apply(null, arguments);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (e) {}
      throw err;
    }
  };
}

module.exports = db;
module.exports.transaction = transaction;
