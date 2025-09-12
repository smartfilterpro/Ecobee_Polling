// server.js — Ecobee summary poller (ESM) with runtime tracking + detailed logging
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

const BUBBLE_THERMOSTAT_UPDATES_URL =
  (process.env.BUBBLE_THERMOSTAT_UPDATES_URL || "").trim();

const ECOBEE_CLIENT_ID = (process.env.ECOBEE_CLIENT_ID || "").trim();
const ECOBEE_TOKEN_URL = "https://api.ecobee.com/token";

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60_000);
const ERROR_BACKOFF_MS = Number(process.env.ERROR_BACKOFF_MS || 120_000);
const MAX_ACCUMULATE_SECONDS = Number(process.env.MAX_ACCUMULATE_SECONDS || 600);

// Enrich state-change / session-end posts with temps via /thermostat
const ENRICH_WITH_DETAILS = process.env.ENRICH_WITH_DETAILS === "1";

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

// Pretty logger for small JSON payloads
function j(obj) {
  try { return JSON.stringify(obj); } catch { return String(obj); }
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
  return res.data;
}

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
    thermostatName,
    hvacMode,
    equipmentStatus: parsed.raw,
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
   Posting to Bubble (with logging)
   ────────────────────────────────────────────────────────────────────────── */
async function postToBubble(payload, label = "state") {
  if (!BUBBLE_THERMOSTAT_UPDATES_URL) {
    throw new Error("BUBBLE_THERMOSTAT_UPDATES_URL not set");
  }
  await axios.post(BUBBLE_THERMOSTAT_UPDATES_URL, payload, { timeout: 20_000 });
  console.log(`[${payload.hvacId}] → POSTED to Bubble (${label}) ${nowUtc()} :: ${j(payload)}`);
}

/* ──────────────────────────────────────────────────────────────────────────
   Runtime policy (with logging)
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

  const current = (await getRuntime(hvac_id)) || {
    is_running: false,
    current_session_seconds: 0,
    last_tick_at: null,
  };

  if (!current.is_running && isRunning) {
    console.log(`[${hvac_id}] ▶️ session START at ${nowIso}`);
    await setRuntime(hvac_id, {
      is_running: true,
      current_session_started_at: nowIso,
      last_tick_at: nowIso,
    });
    return { postedSessionEnd: false };
  }

  if (current.is_running && isRunning) {
    const lastTick = current.last_tick_at ? toMillis(current.last_tick_at) : Date.now();
    const deltaSec = Math.min(
      Math.max(0, Math.round((Date.now() - lastTick) / 1000)),
      MAX_ACCUMULATE_SECONDS
    );
    const newTotal = (current.current_session_seconds || 0) + deltaSec;
    await setRuntime(hvac_id, {
      current_session_seconds: newTotal,
      last_tick_at: nowIso,
    });
    console.log(`[${hvac_id}] ⏱️ tick +${deltaSec}s (total=${newTotal}s)`);
    return { postedSessionEnd: false };
  }

  if (current.is_running && !isRunning) {
    const lastTick = current.last_tick_at ? toMillis(current.last_tick_at) : Date.now();
    const deltaSec = Math.min(
      Math.max(0, Math.round((Date.now() - lastTick) / 1000)),
      MAX_ACCUMULATE_SECONDS
    );
    const finalTotal = (current.current_session_seconds || 0) + deltaSec;

    console.log(`[${hvac_id}] ⏹️ session END (runtimeSeconds=${finalTotal}) at ${nowIso}`);
    const payload = { ...normalized, isRunning: false, runtimeSeconds: finalTotal };
    await postToBubble(payload, "session-end");

    await resetRuntime(hvac_id);
    return { postedSessionEnd: true };
  }

  // stayed idle
  return { postedSessionEnd: false };
}

/* ──────────────────────────────────────────────────────────────────────────
   Poller (summary-first) with logging
   ────────────────────────────────────────────────────────────────────────── */
async function pollOnce() {
  const tokens = await loadAllTokens();
  if (!tokens.length) return;

  console.log(`\n🕒 poll tick @ ${nowUtc()} — ${tokens.length} thermostat(s)`);
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
          console.log(`[${hvac_id}] 🔁 token refreshed`);
        } catch (e) {
          console.warn(`[${hvac_id}] ⚠️ refresh (pre-summary) failed`, e?.response?.data || e.message);
        }
      }

      // summary poll
      let summary;
      try {
        summary = await fetchThermostatSummary(access_token);
      } catch (e) {
        if (e?.response?.status === 401) {
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
          console.log(`[${hvac_id}] 🔁 token refreshed after 401`);
          summary = await fetchThermostatSummary(access_token);
        } else {
          throw e;
        }
      }

      // Extract my hvac status
      const statusMap = mapStatusFromSummary(summary);
      const equipStatus = statusMap.get(hvac_id) ?? "";
      const parsed = parseEquipStatus(equipStatus);
      console.log(
        `[${hvac_id}] 📥 summary equipmentStatus="${equipStatus}" ` +
        `(cooling=${parsed.isCooling}, heating=${parsed.isHeating}, fanOnly=${parsed.isFanOnly}, running=${parsed.isRunning})`
      );

      // Optionally enrich details (only when posting later; we fetch lazily below)

      // Build normalized (no details yet)
      let normalized = normalizeFromSummary({ user_id, hvac_id }, equipStatus, null);

      // runtime/session handling (may post immediately on session end)
      const result = await handleRuntimeAndMaybePost({ user_id, hvac_id }, normalized);

      // De-dup hash (ignore runtimeSeconds)
      let payloadForHash = { ...normalized, runtimeSeconds: null };
      const newHash = sha(payloadForHash);
      const lastHash = await getLastHash(hvac_id);
      let shouldPostStateChange = !result.postedSessionEnd && newHash !== lastHash;

      // If we plan to post, optionally enrich with temps/name/mode
      if ((ENRICH_WITH_DETAILS && (shouldPostStateChange || result.postedSessionEnd))) {
        try {
          const details = await fetchThermostatDetails(access_token, hvac_id);
          normalized = normalizeFromSummary({ user_id, hvac_id }, equipStatus, details);
          payloadForHash = { ...normalized, runtimeSeconds: null };

          // Log what we pulled from /thermostat (only the fields we care about)
          console.log(
            `[${hvac_id}] 📥 details name="${normalized.thermostatName}" mode=${normalized.hvacMode || "n/a"} ` +
            `T=${normalized.actualTemperatureF ?? "n/a"}F setHeat=${normalized.desiredHeatF ?? "n/a"}F setCool=${normalized.desiredCoolF ?? "n/a"}F`
          );
        } catch (e) {
          console.warn(`[${hvac_id}] ⚠️ enrich fetch failed`, e?.response?.data || e.message);
        }
      }

      // Post state-change (not session end path)
      if (shouldPostStateChange) {
        const outgoing = { ...normalized, runtimeSeconds: null };
        await postToBubble(outgoing, "state-change");
        await setLastState(hvac_id, outgoing);
      } else if (result.postedSessionEnd) {
        // After a session-end post, still update last-state hash with runtimeSeconds null
        await setLastState(hvac_id, { ...normalized, runtimeSeconds: null });
      }
    } catch (err) {
      console.error(`[${row.hvac_id}] ❌ poll error:`, err?.response?.data || err.message || String(err));
      await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
    }
  }
}

function startPoller() {
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
    console.log(`[${hvac_id}] 🔗 link/upsert from Bubble @ ${nowUtc()}`);
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
  console.log(`[${hvac_id}] 🗑️ unlink cleanup complete @ ${nowUtc()}`);
  res.json({ ok: true, removed: true });
});

// boot
(async () => {
  if (!BUBBLE_THERMOSTAT_UPDATES_URL || /your-bubble-app\.com/.test(BUBBLE_THERMOSTAT_UPDATES_URL)) {
    console.error("❌ BUBBLE_THERMOSTAT_UPDATES_URL is not set to a real Bubble URL.");
  }
  await ensureSchema();
  app.listen(PORT, () => console.log(`✅ Ecobee summary poller listening on :${PORT}`));
  startPoller();
})();
