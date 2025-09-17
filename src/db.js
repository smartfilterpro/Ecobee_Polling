import pg from "pg";
import { DATABASE_URL, PGSSLMODE, MAX_ACCUMULATE_SECONDS } from "./config.js";
import { nowUtc, sha, toMillis } from "./util.js";

const { Pool } = pg;
export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined,
});

export async function ensureSchema() {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS ecobee_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      hvac_id TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      scope TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, hvac_id)
    );

    CREATE TABLE IF NOT EXISTS ecobee_last_state (
      hvac_id TEXT PRIMARY KEY,
      last_hash TEXT NOT NULL,
      last_payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ecobee_runtime (
      hvac_id TEXT PRIMARY KEY,
      is_running BOOLEAN NOT NULL DEFAULT FALSE,
      current_session_started_at TIMESTAMPTZ,
      last_tick_at TIMESTAMPTZ,
      current_session_seconds INTEGER NOT NULL DEFAULT 0,
      last_running_mode TEXT,
      last_equipment_status TEXT,
      is_reachable BOOLEAN NOT NULL DEFAULT TRUE,
      last_seen_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ecobee_revisions (
      hvac_id TEXT PRIMARY KEY,
      last_revision TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // ensure columns exist (safe no-ops)
  await pool.query(`ALTER TABLE ecobee_runtime ADD COLUMN IF NOT EXISTS last_running_mode TEXT;`);
  await pool.query(`ALTER TABLE ecobee_runtime ADD COLUMN IF NOT EXISTS last_equipment_status TEXT;`);
  await pool.query(`ALTER TABLE ecobee_runtime ADD COLUMN IF NOT EXISTS is_reachable BOOLEAN NOT NULL DEFAULT TRUE;`);
  await pool.query(`ALTER TABLE ecobee_runtime ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;`);
}

export async function upsertTokens({ user_id, hvac_id, access_token, refresh_token, expires_in, scope }) {
  if (!user_id || !hvac_id || !access_token || !refresh_token || !expires_in) {
    throw new Error("Missing required fields for token upsert.");
  }
  const expiresAt = new Date(Date.now() + Number(expires_in) * 1000).toISOString();

  await pool.query(
    `INSERT INTO ecobee_tokens (user_id, hvac_id, access_token, refresh_token, expires_at, scope, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (user_id, hvac_id) DO UPDATE SET
       access_token=EXCLUDED.access_token,
       refresh_token=EXCLUDED.refresh_token,
       expires_at=EXCLUDED.expires_at,
       scope=EXCLUDED.scope,
       updated_at=NOW()`,
    [user_id, hvac_id, access_token, refresh_token, expiresAt, scope || null]
  );

  await pool.query(
    `INSERT INTO ecobee_runtime (hvac_id,is_running,current_session_started_at,last_tick_at,current_session_seconds,last_running_mode,last_equipment_status,is_reachable,last_seen_at,updated_at)
     VALUES ($1,FALSE,NULL,NULL,0,NULL,NULL,TRUE,NOW(),NOW())
     ON CONFLICT (hvac_id) DO NOTHING`,
    [hvac_id]
  );

  await pool.query(
    `INSERT INTO ecobee_revisions (hvac_id,last_revision,updated_at)
     VALUES ($1,'',NOW())
     ON CONFLICT (hvac_id) DO NOTHING`,
    [hvac_id]
  );
}

export async function loadAllTokens() {
  const { rows } = await pool.query(`SELECT * FROM ecobee_tokens ORDER BY updated_at DESC`);
  return rows;
}

export async function updateTokensAfterRefresh({ user_id, hvac_id, access_token, refresh_token, expires_in }) {
  const expiresAt = new Date(Date.now() + Number(expires_in) * 1000).toISOString();
  await pool.query(
    `UPDATE ecobee_tokens
     SET access_token=$3, refresh_token=$4, expires_at=$5, updated_at=NOW()
     WHERE user_id=$1 AND hvac_id=$2`,
    [user_id, hvac_id, access_token, refresh_token, expiresAt]
  );
}

export async function getLastHash(hvac_id) {
  const { rows } = await pool.query(`SELECT last_hash FROM ecobee_last_state WHERE hvac_id=$1`, [hvac_id]);
  return rows[0]?.last_hash || null;
}

export async function setLastState(hvac_id, payload) {
  const h = sha(payload);
  await pool.query(
    `INSERT INTO ecobee_last_state (hvac_id,last_hash,last_payload,updated_at)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (hvac_id) DO UPDATE SET last_hash=EXCLUDED.last_hash,last_payload=EXCLUDED.last_payload,updated_at=NOW()`,
    [hvac_id, h, JSON.stringify(payload)]
  );
  return h;
}

export async function getRuntime(hvac_id) {
  const { rows } = await pool.query(`SELECT * FROM ecobee_runtime WHERE hvac_id=$1`, [hvac_id]);
  return rows[0] || null;
}

export async function setRuntime(hvac_id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const vals = Object.values(fields);
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(", ");
  await pool.query(`UPDATE ecobee_runtime SET ${sets}, updated_at=NOW() WHERE hvac_id=$1`, [hvac_id, ...vals]);
}

export async function resetRuntime(hvac_id) {
  await setRuntime(hvac_id, {
    is_running: false,
    current_session_started_at: null,
    last_tick_at: null,
    current_session_seconds: 0,
    last_running_mode: null,
    last_equipment_status: null,
  });
}

export async function getLastRevision(hvac_id) {
  const { rows } = await pool.query(`SELECT last_revision FROM ecobee_revisions WHERE hvac_id=$1`, [hvac_id]);
  return rows[0]?.last_revision || "";
}

export async function setLastRevision(hvac_id, rev) {
  await pool.query(
    `INSERT INTO ecobee_revisions (hvac_id,last_revision,updated_at)
     VALUES ($1,$2,NOW())
     ON CONFLICT (hvac_id) DO UPDATE SET last_revision=EXCLUDED.last_revision, updated_at=NOW()`,
    [hvac_id, rev]
  );
}

// connectivity helpers
export async function getUserIdForHvac(hvac_id) {
  const { rows } = await pool.query(`SELECT user_id FROM ecobee_tokens WHERE hvac_id=$1 LIMIT 1`, [hvac_id]);
  return rows[0]?.user_id || null;
}

export async function markSeen(hvac_id) {
  await setRuntime(hvac_id, { is_reachable: true, last_seen_at: nowUtc() });
}

export async function markUnreachableIfStale(hvac_id, last_seen_at, staleMs) {
  const last = last_seen_at ? toMillis(last_seen_at) : 0;
  if (Date.now() - last <= staleMs) return false;
  const { rows } = await pool.query(`SELECT is_reachable FROM ecobee_runtime WHERE hvac_id=$1`, [hvac_id]);
  if (rows[0]?.is_reachable === false) return false;
  await setRuntime(hvac_id, { is_reachable: false });
  return true;
}
