// server.js — Ecobee summary poller (ESM) with runtime tracking and optional detail enrichment
// Node 18+, "type": "module" in package.json

import express from "express";
import axios from "axios";
import crypto from "crypto";
import pg from "pg";
const { Pool } = pg;

/* ──────────────────────────────────────────────────────────────────────────
   Config (env)
   ────────────────────────────────────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;

// Bubble webhook to receive updates (backend workflow URL)
const BUBBLE_THERMOSTAT_UPDATES_URL =
  (process.env.BUBBLE_THERMOSTAT_UPDATES_URL || "").trim();

// Ecobee OAuth app
const ECOBEE_CLIENT_ID = (process.env.ECOBEE_CLIENT_ID || "").trim();
const ECOBEE_TOKEN_URL = "https://api.ecobee.com/token";

// Polling/behavior
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60_000); // 1 min
const ERROR_BACKOFF_MS = Number(process.env.ERROR_BACKOFF_MS || 120_000);
const MAX_ACCUMULATE_SECONDS = Number(process.env.MAX_ACCUMULATE_SECONDS || 600);

// Optional: enrich posts (on state change or session end) with temps via /thermostat
const ENRICH_WITH_DETAILS = process.env.ENRICH_WITH_DETAILS === "1";

// Postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined,
});

/* ──────────────────────────────────────────────────────────────────────────
   Helpers
   ────────────────────────────────────────────────────────────────────────── */
const nowUtc = () => new Date().toISOString();
const toMillis = (iso) => new Date(iso).getTime();

function sha(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

function tenthsFToF(x) {
  if (x === undefined || x === null) return null;
  return Number((x / 10).toFixed(1));
}

function parseEquipStatus(equipmentStatus) {
  const s = (equipmentStatus || "").toLowerCase();
  const isCooling = s.includes("cooling");
  const isHeating = s.includes("heating");
  const isFanOnly = !isCooling && !isHeating && s.includes("fan");
  const isRunning = isCooling || isHeating || isFanOnly;
  return { isCooling, isHeating, isFanOnly, isRunning, raw: equipmentStatus || "" };
}

function isExpiringSoon(expiresAtISO, thresholdSec = 120) {
  if (!expiresAtISO) return true;
  return new Date(expiresAtISO).getTime() - Date.now() <= thresholdSec * 1000;
}

/* ──────────────────────────────────────────────────────────────────────────
   DB schema + helpers
   ────────────────────────────────────────────────────────────────────────── */
async function ensureSchema() {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS ecobee_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL,
      hvac_id TEXT NOT NULL,           -- Ecobee thermostat identifier string
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL, -- absolute expiry for access token
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
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function upsertTokens({ user_id, hvac_id, access_token, refresh_token, expires_in, scope }) {
  if (!user_id || !hvac_id || !access_token || !refresh_token || !expires_in) {
    throw new Error("Missing required fields for token upsert.");
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
  const h = sha(payload);
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

// runtime rows
async function getRuntime(hvac_id) {
  const { rows } = await pool.query(`SELECT * FROM ecobee_runtime WHERE hvac_id = $1`, [hvac_id]);
  return rows[0] || null;
}

async function setRuntime(hvac_id, fields) {
  const keys = Object.keys(fields);
  const vals = Object.values(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
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
    current_session_seconds: 0,
  });
}

/* ──────────────────────────────────────────────────────────────────────────
   Ecobee API
   ────────────────────────────────────────────────────────────────────────── */
async function refreshEcobeeTokens(refresh_token) {
  const params = new URLSearchParams();
  params.append("grant_type", "refresh_token");
  params.append("refresh_token", refresh_token);
  params.append("client_id", ECOBEE_CLIENT_ID);

  const res = await axios.post(ECOBEE_TOKEN_URL, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 20_000,
  });
  return res.data; // { access_token, token_type, refresh_token, expires_in, scope? }
}

// Lightweight summary (all registered thermostats on this account)
async function fetchThermostatSummary(access_token) {
  const sel = {
    selection: {
      selectionType: "registered",
      selectionMatch: "",
      includeEquipmentStatus: true,
    },
  };
  const url =
    "https://api.ecobee.com/1/thermostatSummary?json=" +
    encodeURIComponent(JSON.stringify(sel));

  const res = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/json;charset=UTF-8",
    },
    timeout: 20_000,
  });
  return res.data;
}

// Optional: enrich with temps/setpoints for a specific thermostat
async function fetchThermostatDetails(access_token, hvac_id) {
  const q = {
    selection: {
      selectionType: "thermostats",
      selectionMatch: hvac_id || "",
      includeRuntime: true,
      includeSettings: true,
      includeEvents: false,
    },
  };
  const url =
    "https://api.ecobee.com/1/thermostat?json=" +
    encodeURIComponent(JSON.stringify(q));

  const res = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/json;charset=UTF-8",
    },
    timeout: 20_000,
  });
  return res.data;
}

/* ──────────────────────────────────────────────────────────────────────────
   Summary parsing + normalization
   ────────────────────────────────────────────────────────────────────────── */
/**
 * Build a map { thermostatId -> equipmentStatus } from thermostatSummary
 * - statusList looks like ["123456789:cooling,fan", "987654321:"]
 */
function mapStatusFromSummary(summary) {
  const statusList = Array.isArray(summary?.statusList) ? summary.statusList : [];
  const map = new Map();
  for (const item of statusList) {
    const idx = item.indexOf(":");
    if (idx > 0) {
      const id = item.slice(0, idx);
      const status = item.slice(idx + 1);
      map.set(id, status);
    }
  }
  return map;
}

function normalizeFromSummary({ user_id, hvac_id }, equipStatus, details) {
  const parsed = parseEquipStatus(equipStatus);

  // optional temps from details
  let actualTemperatureF = null;
  let desiredHeatF = null;
  let desiredCoolF = null;
  let thermostatName = null;
  let hvacMode = null;

  if (details?.thermostatList?.[0]) {
    const t = details.thermostatList[0];
    thermostatName = t.name || null;
    const runtime = t.runtime || {};
    const settings = t.settings || {};
    actualTemperatureF = tenthsFToF(runtime.actualTemperature);
    desiredHeatF = tenthsFToF(runtime.desiredHeat);
    desiredCoolF = tenthsFToF(runtime.desiredCool);
    hvacMode = (settings.hvacMode || "").toLowerCase();
  }

  return {
    userId: user_id,
    hvacId: hvac_id,
    thermostatName,           // may be null if not enriched
    hvacMode,                 // may be null if not enriched
    equipmentStatus: parsed.raw, // e.g., "cooling,fan" or ""
    isCooling: parsed.isCooling,
    isHeating: parsed.isHeating,
    isFanOnly: parsed.isFanOnly,
    isRunning: parsed.isRunning,
    actualTemperatureF,
    desiredHeatF,
    desiredCoolF,
    ok: true,
    ts: nowUtc(),
  };
}

/* ──────────────────────────────────────────────────────────────────────────
   Posting to Bubble
   ────────────────────────────────────────────────────────────────────────── */
async function postToBubble(payload) {
  if (!BUBBLE_THERMOSTAT_UPDATES_URL) {
    throw new Error("BUBBLE_THERMOSTAT_UPDATES_URL not set");
  }
  await axios.post(BUBBLE_THERMOSTAT_UPDATES_URL, payload, { timeout: 20_000 });
}

/* ──────────────────────────────────────────────────────────────────────────
   Runtime policy:
   - running := cooling || heating || fan-only
   - start (false->true): set started_at/last_tick_at; no post
   - tick (true->true): accumulate seconds (capped by MAX_ACCUMULATE_SECONDS)
   - stop (true->false): finalize, POST runtimeSeconds with stopped payload; reset session
   - state-change posts de-dup w/o runtimeSeconds; session-end always posts with runtimeSeconds
   ────────────────────────────────────────────────────────────────────────── */
async function handleRuntimeAndMaybePost({ user_id, hvac_id }, normalized) {
  const rt = await getRuntime(hvac_id);
  const nowIso = nowUtc();
  const isRunning = !!normalized.isRunning;

  if (!rt) {
    await pool.query(
      `INSERT INTO ecobee_runtime (hvac_id, is_running, current_session_started_at, last_tick_at, current_session_seconds, updated_at)
       VALUES ($1, FALSE, NULL, NULL, 0, NOW())
       ON CONFLICT (hvac_id) DO NOTHING`,
      [hvac_id]
    );
  }

  // Load again (cheap)
  const current = (await getRuntime(hvac_id)) || {
    is_running: false,
    current_session_seconds: 0,
    last_tick_at: null,
  };

  if (!current.is_running && isRunning) {
    // start
    await setRuntime(hvac_id, {
      is_running: true,
      current_session_started_at: nowIso,
      last_tick_at: nowIso,
    });
    return { postedSessionEnd: false };
  }

  if (current.is_running && isRunning) {
    // accumulate
    const lastTick = current.last_tick_at ? toMillis(current.last_tick_at) : Date.now();
    const deltaSec = Math.min(
      Math.max(0, Math.round((Date.now() - lastTick) / 1000)),
      MAX_ACCUMULATE_SECONDS
    );
    await setRuntime(hvac_id, {
      current_session_seconds: (current.current_session_seconds || 0) + deltaSec,
      last_tick_at: nowIso,
    });
    return { postedSessionEnd: false };
  }

  if (current.is_running && !isRunning) {
    // finalize and post runtime
    const lastTick = current.last_tick_at ? toMillis(current.last_tick_at) : Date.now();
    const deltaSec = Math.min(
      Math.max(0, Math.round((Date.now() - lastTick) / 1000)),
      MAX_ACCUMULATE_SECONDS
    );
    const finalTotal = (current.current_session_seconds || 0) + deltaSec;

    const payload = { ...normalized, isRunning: false, runtimeSeconds: finalTotal };
    await postToBubble(payload);

   await postToBubble(payload);
   console.log(`[${hvac_id}] → posted update to Bubble at ${nowUtc()}`);


    await resetRuntime(hvac_id);
    return { postedSessionEnd: true };
  }

  // stayed idle
  return { postedSessionEnd: false };
}

/* ──────────────────────────────────────────────────────────────────────────
   Poller (summary-first)
   ────────────────────────────────────────────────────────────────────────── */
async function pollOnce() {
  const tokens = await loadAllTokens();
  if (!tokens.length) return;

  for (const row of tokens) {
    const { user_id, hvac_id } = row;
    let { access_token, refresh_token, expires_at } = row;

    try {
      // refresh if expiring
      if (isExpiringSoon(expires_at)) {
        try {
          const refreshed = await refreshEcobeeTokens(refresh_token);
          access_token = refreshed.access_token;
          refresh_token = refreshed.refresh_token;
          await updateTokensAfterRefresh({
            user_id,
            hvac_id,
            access_token,
            refresh_token,
            expires_in: refreshed.expires_in,
          });
        } catch (e) {
          console.warn(`[${hvac_id}] refresh (pre-summary) failed`, e?.response?.data || e.message);
        }
      }

      // summary poll (single call returns all ids on the account)
      let summary;
      try {
        summary = await fetchThermostatSummary(access_token);
      } catch (e) {
        if (e?.response?.status === 401) {
          // forced refresh
          const refreshed = await refreshEcobeeTokens(refresh_token);
          access_token = refreshed.access_token;
          refresh_token = refreshed.refresh_token;
          await updateTokensAfterRefresh({
            user_id,
            hvac_id,
            access_token,
            refresh_token,
            expires_in: refreshed.expires_in,
          });
          summary = await fetchThermostatSummary(access_token);
        } else {
          throw e;
        }
      }

      // pull equipmentStatus for THIS hvac_id
      const statusMap = mapStatusFromSummary(summary);
      const equipStatus = statusMap.get(hvac_id) ?? "";

      // optionally fetch details only when we need them
      let details = null;

      // Minimal normalized payload (may be enriched below)
      let normalized = normalizeFromSummary({ user_id, hvac_id }, equipStatus, null);

      // runtime/session handling (may post immediately on session end)
      const result = await handleRuntimeAndMaybePost({ user_id, hvac_id }, normalized);

      // For de-dup hash, we ignore runtimeSeconds
      let payloadForHash = { ...normalized, runtimeSeconds: null };

      // If we’re enriching, and either state changed or session ended, fetch details now
      let shouldPostStateChange = false;

      // compute hash vs last
      const newHash = sha(payloadForHash);
      const lastHash = await getLastHash(hvac_id);

      if (!result.postedSessionEnd && newHash !== lastHash) {
        shouldPostStateChange = true;
      }

      if ((ENRICH_WITH_DETAILS && (shouldPostStateChange || result.postedSessionEnd))) {
        try {
          details = await fetchThermostatDetails(access_token, hvac_id);
        } catch (e) {
          // non-fatal; we'll post without temps
          console.warn(`[${hvac_id}] enrich fetch failed`, e?.response?.data || e.message);
        }
        // rebuild normalized with details
        normalized = normalizeFromSummary({ user_id, hvac_id }, equipStatus, details);
        payloadForHash = { ...normalized, runtimeSeconds: null };
      }

      // Post state-change (not session end path)
      if (!result.postedSessionEnd && shouldPostStateChange) {
        await postToBubble({ ...normalized, runtimeSeconds: null });
        await setLastState(hvac_id, { ...normalized, runtimeSeconds: null });
      } else if (result.postedSessionEnd) {
        // after session end we still update last state hash with runtimeSeconds null
        await setLastState(hvac_id, { ...normalized, runtimeSeconds: null });
      }
    } catch (err) {
      console.error(`[${row.hvac_id}] poll error:`, err?.response?.data || err.message || String(err));
      await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
    }
  }
}

function startPoller() {
  // kick off quickly, then interval
  pollOnce().catch(() => {});
  setInterval(() => pollOnce().catch(() => {}), POLL_INTERVAL_MS);
}

/* ──────────────────────────────────────────────────────────────────────────
   HTTP (Bubble -> Railway)
   ────────────────────────────────────────────────────────────────────────── */
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, time: nowUtc() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Bubble link → upsert tokens
 * {
 *   "user_id": "bubble_user_id",
 *   "hvac_id": "thermostat_identifier",
 *   "access_token": "…",
 *   "refresh_token": "…",
 *   "expires_in": 599,
 *   "scope": "smartRead" // optional
 * }
 */
app.post("/ecobee/link", async (req, res) => {
  try {
    const { user_id, hvac_id, access_token, refresh_token, expires_in, scope } = req.body || {};
    await upsertTokens({ user_id, hvac_id, access_token, refresh_token, expires_in, scope });
    res.json({ ok: true, saved: true });
  } catch (e) {
    console.error("link error:", e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post("/ecobee/unlink", async (req, res) => {
  const { user_id, hvac_id } = req.body || {};
  if (!user_id || !hvac_id) return res.status(400).json({ ok: false, error: "user_id and hvac_id required" });
  await pool.query(`DELETE FROM ecobee_tokens WHERE user_id = $1 AND hvac_id = $2`, [user_id, hvac_id]);
  await pool.query(`DELETE FROM ecobee_last_state WHERE hvac_id = $1`, [hvac_id]);
  await pool.query(`DELETE FROM ecobee_runtime WHERE hvac_id = $1`, [hvac_id]);
  res.json({ ok: true, removed: true });
});

// boot
(async () => {
  await ensureSchema();
  app.listen(PORT, () => console.log(`✅ Ecobee summary poller listening on :${PORT}`));
  startPoller();
})();
