// server.js
// SmartFilterPro — Ecobee poller/bridge for Railway with runtime tracking
// Node 18+, Express, pg, axios

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { Pool } = require('pg');

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

const BUBBLE_THERMOSTAT_UPDATES_URL =
  (process.env.BUBBLE_THERMOSTAT_UPDATES_URL || '').trim();

const ECOBEE_CLIENT_ID = (process.env.ECOBEE_CLIENT_ID || '').trim();
const ECOBEE_TOKEN_URL = 'https://api.ecobee.com/token';

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60_000);
const ERROR_BACKOFF_MS = Number(process.env.ERROR_BACKOFF_MS || 120_000);

// Cap per-tick accumulation to protect against long gaps (optional safety)
const MAX_ACCUMULATE_SECONDS = Number(process.env.MAX_ACCUMULATE_SECONDS || 600);

// Postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : undefined
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function nowUtc() { return new Date().toISOString(); }
function toMillis(iso) { return new Date(iso).getTime(); }

function hashObj(o) {
  return crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
}

function tenthsFToF(x) {
  if (x === undefined || x === null) return null;
  return Number((x / 10).toFixed(1));
}

function parseEquipmentStatus(equipmentStatus) {
  const s = (equipmentStatus || '').toLowerCase();
  const isCooling = s.includes('cooling');
  const isHeating = s.includes('heating');
  const isFanOnly = !isCooling && !isHeating && s.includes('fan');
  const isRunning = isCooling || isHeating || isFanOnly;
  return { isCooling, isHeating, isFanOnly, isRunning, raw: equipmentStatus || '' };
}

function isExpiringSoon(expiresAtISO, thresholdSec = 120) {
  if (!expiresAtISO) return true;
  const expiresAt = new Date(expiresAtISO).getTime();
  const now = Date.now();
  return (expiresAt - now) <= thresholdSec * 1000;
}

// ─────────────────────────────────────────────────────────────────────────────
// Database
// ─────────────────────────────────────────────────────────────────────────────
async function ensureSchema() {
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

    -- Tracks the CURRENT running session for each hvac_id.
    -- We only post runtimeSeconds when a session ends (running -> not running).
    CREATE TABLE IF NOT EXISTS ecobee_runtime (
      hvac_id TEXT PRIMARY KEY,
      is_running BOOLEAN NOT NULL DEFAULT FALSE,
      current_session_started_at TIMESTAMPTZ, -- when running turned true
      last_tick_at TIMESTAMPTZ,               -- last time we accumulated
      current_session_seconds INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function upsertTokens({ user_id, hvac_id, access_token, refresh_token, expires_in, scope }) {
  if (!user_id || !hvac_id || !access_token || !refresh_token || !expires_in) {
    throw new Error('Missing required fields for token upsert.');
  }
  const expiresAt = new Date(Date.now() + Number(expires_in) * 1000).toISOString();

  await pool.query(
    `
    INSERT INTO ecobee_tokens (user_id, hvac_id, access_token, refresh_token, expires_at, scope, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW())
    ON CONFLICT (user_id, hvac_id)
    DO UPDATE SET
      access_token = EXCLUDED.access_token,
      refresh_token = EXCLUDED.refresh_token,
      expires_at = EXCLUDED.expires_at,
      scope = EXCLUDED.scope,
      updated_at = NOW()
    `,
    [user_id, hvac_id, access_token, refresh_token, expiresAt, scope || null]
  );

  // Ensure runtime row exists
  await pool.query(
    `
    INSERT INTO ecobee_runtime (hvac_id, is_running, current_session_started_at, last_tick_at, current_session_seconds, updated_at)
    VALUES ($1, FALSE, NULL, NULL, 0, NOW())
    ON CONFLICT (hvac_id) DO NOTHING
    `,
    [hvac_id]
  );
}

async function loadAllTokens() {
  const { rows } = await pool.query(`SELECT * FROM ecobee_tokens ORDER BY updated_at DESC`);
  return rows;
}

async function updateTokensAfterRefresh({ user_id, hvac_id, access_token, refresh_token, expires_in }) {
  const expiresAt = new Date(Date.now() + Number(expires_in) * 1000).toISOString();
  await pool.query(
    `
    UPDATE ecobee_tokens
    SET access_token = $3, refresh_token = $4, expires_at = $5, updated_at = NOW()
    WHERE user_id = $1 AND hvac_id = $2
    `,
    [user_id, hvac_id, access_token, refresh_token, expiresAt]
  );
}

async function getLastHash(hvac_id) {
  const { rows } = await pool.query(`SELECT last_hash FROM ecobee_last_state WHERE hvac_id = $1`, [hvac_id]);
  return rows[0]?.last_hash || null;
}

async function setLastState(hvac_id, payload) {
  const h = hashObj(payload);
  await pool.query(
    `
    INSERT INTO ecobee_last_state (hvac_id, last_hash, last_payload, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (hvac_id)
    DO UPDATE SET last_hash = EXCLUDED.last_hash, last_payload = EXCLUDED.last_payload, updated_at = NOW()
    `,
    [hvac_id, h, JSON.stringify(payload)]
  );
  return h;
}

// Runtime helpers
async function getRuntime(hvac_id) {
  const { rows } = await pool.query(`SELECT * FROM ecobee_runtime WHERE hvac_id = $1`, [hvac_id]);
  return rows[0] || null;
}

async function setRuntime(hvac_id, fields) {
  const keys = Object.keys(fields);
  const vals = Object.values(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await pool.query(
    `UPDATE ecobee_runtime SET ${sets}, updated_at = NOW() WHERE hvac_id = $1`,
    [hvac_id, ...vals]
  );
}

async function resetRuntime(hvac_id) {
  await setRuntime(hvac_id, {
    is_running: false,
    current_session_started_at: null,
    last_tick_at: null,
    current_session_seconds: 0
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Ecobee API
// ─────────────────────────────────────────────────────────────────────────────
async function refreshEcobeeTokens(refresh_token) {
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', refresh_token);
  params.append('client_id', ECOBEE_CLIENT_ID);

  const res = await axios.post(ECOBEE_TOKEN_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20_000
  });
  return res.data;
}

async function fetchThermostat(access_token, hvac_id) {
  const q = {
    selection: {
      selectionType: 'thermostats',
      selectionMatch: hvac_id || '',
      includeRuntime: true,
      includeEvents: true,
      includeSettings: true
    }
  };
  const url = `https://api.ecobee.com/1/thermostat?json=${encodeURIComponent(JSON.stringify(q))}`;

  const res = await axios.get(url, {
    headers: {
      'Authorization': `Bearer ${access_token}`,
      'Content-Type': 'application/json;charset=UTF-8',
      'cache-control': 'no-cache'
    },
    timeout: 20_000
  });
  return res.data;
}

function normalizeForBubble({ user_id, hvac_id }, ecobeeData) {
  const t = (ecobeeData?.thermostatList && ecobeeData.thermostatList[0]) || null;
  if (!t) {
    return {
      userId: user_id,
      hvacId: hvac_id,
      ok: false,
      error: 'No thermostatList[0] in Ecobee response',
      raw: ecobeeData || null
    };
  }

  const name = t.name;
  const runtime = t.runtime || {};
  const settings = t.settings || {};
  const equipmentStatus = t.equipmentStatus || '';

  const temps = {
    actualTemperatureF: tenthsFToF(runtime.actualTemperature),
    desiredHeatF: tenthsFToF(runtime.desiredHeat),
    desiredCoolF: tenthsFToF(runtime.desiredCool)
  };

  const mode = (settings.hvacMode || '').toLowerCase();
  const status = parseEquipmentStatus(equipmentStatus);

  return {
    userId: user_id,
    hvacId: hvac_id,
    thermostatName: name || null,
    hvacMode: mode,                     // auto/heat/cool/off
    equipmentStatus: status.raw,        // e.g., "cooling,fan"
    isCooling: status.isCooling,
    isHeating: status.isHeating,
    isFanOnly: status.isFanOnly,
    isRunning: status.isRunning,
    ...temps,
    ok: true,
    ts: nowUtc()
  };
}

async function postToBubble(payload) {
  if (!BUBBLE_THERMOSTAT_UPDATES_URL) throw new Error('BUBBLE_THERMOSTAT_UPDATES_URL not set');
  await axios.post(BUBBLE_THERMOSTAT_UPDATES_URL, payload, { timeout: 20_000 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime accumulation + posting policy
// ─────────────────────────────────────────────────────────────────────────────
/*
Policy:
- running := isCooling || isHeating || isFanOnly
- Transition false -> true:
    - start session: set started_at = now, last_tick_at = now, is_running = true
    - runtimeSeconds stays accumulating (no post yet)
- While true -> true:
    - accumulate (now - last_tick_at), capped at MAX_ACCUMULATE_SECONDS
- Transition true -> false:
    - finalize seconds, POST payload with runtimeSeconds = total for this session
    - reset current_session_seconds = 0 and clear started_at/last_tick_at, is_running = false
- While false -> false:
    - nothing
- State-change posts:
    - We still de-dup normalized state and post *state* changes (hash diff).
    - Session end always posts (even if hash unchanged) with runtimeSeconds set.
- While running, runtimeSeconds in posts should be null.
*/

async function handleRuntimeAndMaybePost({ user_id, hvac_id }, normalized) {
  const hvac = hvac_id;
  const rt = (await getRuntime(hvac)) || null;
  const nowIso = nowUtc();

  if (!rt) {
    // Initialize row if missing (shouldn’t happen due to upsertTokens)
    await pool.query(
      `INSERT INTO ecobee_runtime (hvac_id, is_running, current_session_started_at, last_tick_at, current_session_seconds, updated_at)
       VALUES ($1, FALSE, NULL, NULL, 0, NOW())
       ON CONFLICT (hvac_id) DO NOTHING`,
      [hvac]
    );
  }

  const isRunning = !!normalized.isRunning;

  // Session logic
  if (!rt || (rt.is_running === false && isRunning === true)) {
    // Start session
    await setRuntime(hvac, {
      is_running: true,
      current_session_started_at: nowIso,
      last_tick_at: nowIso
    });
  } else if (rt.is_running === true && isRunning === true) {
    // Accumulate
    const lastTick = rt.last_tick_at ? toMillis(rt.last_tick_at) : Date.now();
    const deltaSec = Math.min(Math.max(0, Math.round((Date.now() - lastTick) / 1000)), MAX_ACCUMULATE_SECONDS);
    const newTotal = (rt.current_session_seconds || 0) + deltaSec;
    await setRuntime(hvac, {
      current_session_seconds: newTotal,
      last_tick_at: nowIso
    });
  } else if (rt.is_running === true && isRunning === false) {
    // End session → finalize seconds and POST runtimeSeconds
    const lastTick = rt.last_tick_at ? toMillis(rt.last_tick_at) : Date.now();
    const deltaSec = Math.min(Math.max(0, Math.round((Date.now() - lastTick) / 1000)), MAX_ACCUMULATE_SECONDS);
    const finalTotal = (rt.current_session_seconds || 0) + deltaSec;

    const endPayload = {
      ...normalized,
      // override with stopped state to be explicit
      isRunning: false,
      runtimeSeconds: finalTotal
    };
    await postToBubble(endPayload);

    // Reset for next session
    await resetRuntime(hvac);
    return { postedSessionEnd: true };
  }

  // While running, we do NOT report runtimeSeconds (keep it null)
  return { postedSessionEnd: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Poller
// ─────────────────────────────────────────────────────────────────────────────
async function pollOnce() {
  const tokens = await loadAllTokens();
  if (!tokens.length) return;

  for (const row of tokens) {
    const { user_id, hvac_id } = row;
    let { access_token, refresh_token, expires_at } = row;

    try {
      // Refresh early if near expiry
      if (isExpiringSoon(expires_at)) {
        try {
          const refreshed = await refreshEcobeeTokens(refresh_token);
          access_token = refreshed.access_token;
          refresh_token = refreshed.refresh_token;
          await updateTokensAfterRefresh({
            user_id, hvac_id,
            access_token,
            refresh_token,
            expires_in: refreshed.expires_in
          });
        } catch (e) {
          console.warn(`[${hvac_id}] Refresh failed (pre-fetch)`, e?.response?.data || e.message);
        }
      }

      // Fetch data
      let data;
      try {
        data = await fetchThermostat(access_token, hvac_id);
      } catch (e) {
        if (e?.response?.status === 401) {
          console.warn(`[${hvac_id}] 401 on fetch → attempting refresh`);
          const refreshed = await refreshEcobeeTokens(refresh_token);
          access_token = refreshed.access_token;
          refresh_token = refreshed.refresh_token;
          await updateTokensAfterRefresh({
            user_id, hvac_id,
            access_token,
            refresh_token,
            expires_in: refreshed.expires_in
          });
          data = await fetchThermostat(access_token, hvac_id);
        } else {
          throw e;
        }
      }

      // Normalize
      const payload = normalizeForBubble({ user_id, hvac_id }, data);

      // Runtime/session handling (may post at session end)
      const { postedSessionEnd } = await handleRuntimeAndMaybePost({ user_id, hvac_id }, payload);

      // De-dup + state-change posting
      const stateHash = hashObj({ ...payload, runtimeSeconds: null }); // exclude runtimeSeconds from hash
      const lastHash = await getLastHash(hvac_id);

      if (!postedSessionEnd && stateHash !== lastHash) {
        // While running, runtimeSeconds should be null; when not running, also null unless session ended
        await postToBubble({ ...payload, runtimeSeconds: null });
        await setLastState(hvac_id, { ...payload, runtimeSeconds: null });
        // console.log(`[${hvac_id}] ➜ posted state change`);
      } else if (postedSessionEnd) {
        // After posting a session end with runtimeSeconds, also update last state hash (with null runtimeSeconds)
        await setLastState(hvac_id, { ...payload, runtimeSeconds: null });
        // console.log(`[${hvac_id}] ➜ posted session end`);
      }
    } catch (err) {
      const msg = err?.response?.data || err.message || String(err);
      console.error(`[${hvac_id}] Poll error:`, msg);
      await new Promise(r => setTimeout(r, ERROR_BACKOFF_MS));
    }
  }
}

function startPoller() {
  pollOnce().catch(() => {});
  setInterval(() => { pollOnce().catch(() => {}); }, POLL_INTERVAL_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, time: nowUtc() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/*
Bubble → POST /ecobee/link
{
  "user_id": "bubble_user_id",
  "hvac_id": "thermostat_identifier",
  "access_token": "…",
  "refresh_token": "…",
  "expires_in": 599,
  "scope": "smartRead" // optional
}
*/
app.post('/ecobee/link', async (req, res) => {
  try {
    const { user_id, hvac_id, access_token, refresh_token, expires_in, scope } = req.body || {};
    await upsertTokens({ user_id, hvac_id, access_token, refresh_token, expires_in, scope });
    res.json({ ok: true, saved: true });
  } catch (e) {
    console.error('link error:', e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/ecobee/unlink', async (req, res) => {
  const { user_id, hvac_id } = req.body || {};
  if (!user_id || !hvac_id) return res.status(400).json({ ok: false, error: 'user_id and hvac_id required' });
  await pool.query(`DELETE FROM ecobee_tokens WHERE user_id = $1 AND hvac_id = $2`, [user_id, hvac_id]);
  await pool.query(`DELETE FROM ecobee_last_state WHERE hvac_id = $1`, [hvac_id]);
  await pool.query(`DELETE FROM ecobee_runtime WHERE hvac_id = $1`, [hvac_id]);
  res.json({ ok: true, removed: true });
});

// Boot
(async () => {
  await ensureSchema();
  app.listen(PORT, () => console.log(`✅ Ecobee poller listening on :${PORT}`));
  startPoller();
})();
