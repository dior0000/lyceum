const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, '..', 'data.sqlite'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    tg_id      INTEGER PRIMARY KEY,
    username   TEXT,
    name       TEXT NOT NULL,
    klass      TEXT NOT NULL,
    gender     TEXT NOT NULL CHECK (gender IN ('m', 'f')),
    looking    INTEGER NOT NULL DEFAULT 1,
    photo      TEXT NOT NULL,
    banned     INTEGER NOT NULL DEFAULT 0,
    hidden     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS likes (
    from_id    INTEGER NOT NULL,
    to_id      INTEGER NOT NULL,
    liked      INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (from_id, to_id)
  );

  CREATE TABLE IF NOT EXISTS reports (
    from_id    INTEGER NOT NULL,
    to_id      INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (from_id, to_id)
  );
`);

module.exports = db;
