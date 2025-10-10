import pg from "pg";
import { DATABASE_URL, PGSSLMODE } from "./config.js";
import { nowUtc, sha, toMillis } from "./util.js";

const { Pool } = pg;
export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
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

  // Add indices for performance
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ecobee_tokens_hvac_id ON ecobee_tokens(hvac_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ecobee_tokens_user_id ON ecobee_tokens(user_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ecobee_runtime_is_reachable ON ecobee_runtime(is_reachable);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ecobee_runtime_last_seen ON ecobee_runtime(last_seen_at);`);
}

/**
 * Get last known telemetry for backfilling Core events
 */
export async function getBackfillState(hvac_id) {
  try {
    const { rows } = await pool.query(`
      SELECT 
        hvac_id,
        is_running,
        current_session_started_at,
        last_running_mode,
        last_equipment_status,
        is_reachable,
        last_seen_at
      FROM ecobee_runtime 
      WHERE hvac_id = $1
    `, [hvac_id]);
    
    if (!rows[0]) return null;
    
    // Try to get last telemetry from last_state
    const { rows: stateRows } = await pool.query(`
      SELECT last_payload 
      FROM ecobee_last_state 
      WHERE hvac_id = $1
    `, [hvac_id]);
    
    const lastPayload = stateRows[0]?.last_payload || {};
    
    return {
      ...rows[0],
      last_temperature: lastPayload.actualTemperatureF ?? null,
      last_humidity: null, // Ecobee doesn't provide humidity in standard API
      last_heat_setpoint: lastPayload.desiredHeatF ?? null,
      last_cool_setpoint: lastPayload.desiredCoolF ?? null,
      current_mode: rows[0].last_running_mode || 'off',
      current_equipment_status: rows[0].last_equipment_status || 'OFF'
    };
  } catch (err) {
    console.error('[getBackfillState] error:', err.message);
    return null;
  }
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

/**
 * Mark device as seen (reachable now).
 * Returns connectivity transition info to prevent race conditions.
 * @returns {object} { wasUnreachable: boolean, userId: string|null }
 */
export async function markSeenAndGetTransition(hvac_id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { rows } = await client.query(
      `SELECT is_reachable FROM ecobee_runtime WHERE hvac_id=$1 FOR UPDATE`,
      [hvac_id]
    );
    const wasUnreachable = rows[0]?.is_reachable === false;
    
    await client.query(
      `UPDATE ecobee_runtime 
       SET is_reachable=TRUE, last_seen_at=$2, updated_at=NOW() 
       WHERE hvac_id=$1`,
      [hvac_id, nowUtc()]
    );
    
    let userId = null;
    if (wasUnreachable) {
      const userResult = await client.query(
        `SELECT user_id FROM ecobee_tokens WHERE hvac_id=$1 LIMIT 1`,
        [hvac_id]
      );
      userId = userResult.rows[0]?.user_id || null;
    }
    
    await client.query('COMMIT');
    return { wasUnreachable, userId };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function markUnreachableIfStale(hvac_id, last_seen_at, staleMs) {
  const last = last_seen_at ? toMillis(last_seen_at) : 0;
  if (Date.now() - last <= staleMs) return { flipped: false, userId: null };
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const { rows } = await client.query(
      `SELECT is_reachable FROM ecobee_runtime WHERE hvac_id=$1 FOR UPDATE`,
      [hvac_id]
    );
    
    if (rows[0]?.is_reachable === false) {
      await client.query('COMMIT');
      return { flipped: false, userId: null };
    }
    
    await client.query(
      `UPDATE ecobee_runtime SET is_reachable=FALSE, updated_at=NOW() WHERE hvac_id=$1`,
      [hvac_id]
    );
    
    const userResult = await client.query(
      `SELECT user_id FROM ecobee_tokens WHERE hvac_id=$1 LIMIT 1`,
      [hvac_id]
    );
    const userId = userResult.rows[0]?.user_id || null;
    
    await client.query('COMMIT');
    return { flipped: true, userId };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}
