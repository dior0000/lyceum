const { Pool, types } = require('pg');

// BIGINT (tg_id, COUNT) вяртаць лікам — id Telegram змяшчаюцца ў 2^53
types.setTypeParser(20, (v) => parseInt(v, 10));

// Neon праз Vercel Marketplace дадае зменныя з прэфіксам праекта — падтрымліваем абодва варыянты
const CONNECTION_STRING =
  process.env.DATABASE_URL ||
  process.env.lyceum_DATABASE_URL ||
  process.env.lyceum_POSTGRES_URL ||
  process.env.POSTGRES_URL;

const pool = new Pool({
  connectionString: CONNECTION_STRING,
  ssl: { rejectUnauthorized: false },
  max: 1, // serverless: адно злучэнне на інстанс
});

let readyPromise = null;
function ready() {
  if (!readyPromise) {
    readyPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        tg_id      BIGINT PRIMARY KEY,
        username   TEXT,
        name       TEXT NOT NULL,
        klass      TEXT NOT NULL,
        gender     TEXT NOT NULL CHECK (gender IN ('m', 'f')),
        looking    INT NOT NULL DEFAULT 1,
        photo      TEXT NOT NULL,
        banned     INT NOT NULL DEFAULT 0,
        hidden     INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS likes (
        from_id    BIGINT NOT NULL,
        to_id      BIGINT NOT NULL,
        liked      INT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (from_id, to_id)
      );
      CREATE TABLE IF NOT EXISTS reports (
        from_id    BIGINT NOT NULL,
        to_id      BIGINT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (from_id, to_id)
      );
      CREATE TABLE IF NOT EXISTS photos (
        id         UUID PRIMARY KEY,
        mime       TEXT NOT NULL,
        data       BYTEA NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);
  }
  return readyPromise;
}

async function q(text, params) {
  await ready();
  const res = await pool.query(text, params);
  return res.rows;
}

async function one(text, params) {
  const rows = await q(text, params);
  return rows[0] || null;
}

module.exports = { q, one };
