// server.js — Summary-driven detail fetch (ESM)
// Polls /thermostatSummary; on change → fetches /thermostat to enrich + post
// Adds last-run-state (mode + equipmentStatus) to session-end posts

import express from "express";
import axios from "axios";
import crypto from "crypto";
import pg from "pg";
const { Pool } = pg;

/* ───────────── Config ───────────── */
const PORT = process.env.PORT || 3000;
const BUBBLE_THERMOSTAT_UPDATES_URL = (process.env.BUBBLE_THERMOSTAT_UPDATES_URL || "").trim();
const ECOBEE_CLIENT_ID = (process.env.ECOBEE_CLIENT_ID || "").trim();
const ECOBEE_TOKEN_URL = "https://api.ecobee.com/token";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60_000);
const ERROR_BACKOFF_MS = Number(process.env.ERROR_BACKOFF_MS || 120_000);
const MAX_ACCUMULATE_SECONDS = Number(process.env.MAX_ACCUMULATE_SECONDS || 600);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined,
});

/* ───────────── Helpers ───────────── */
const nowUtc = () => new Date().toISOString();
const toMillis = (iso) => new Date(iso).getTime();
const sha = (o) => crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex");
const j = (o) => { try { return JSON.stringify(o); } catch { return String(o); } };

function tenthsFToF(x) {
  if (x === undefined || x === null) return null;
  return Number((x / 10).toFixed(1));
}

// Updated parser: handles compCool/compHeat/auxHeat/heatPump
function parseEquipStatus(equipmentStatus) {
  const raw = (equipmentStatus || "").toLowerCase();
  const tokens = raw.split(",").map(s => s.trim()).filter(Boolean);
  const has = (t) => tokens.includes(t);

  const isCooling =
    has("cooling") || has("compcool1") || has("compcool2");

  const isHeating =
    has("heating") || has("compheat1") || has("compheat2") ||
    has("auxheat1") || has("auxheat2") || has("auxheat3") ||
    has("heatpump");

  const fanRunning = has("fan") || has("fanonly") || has("fanonly1");
  const isFanOnly = fanRunning && !isCooling && !isHeating;
  const isRunning = isCooling || isHeating || isFanOnly;

  let lastMode = null;
  if (isCooling) lastMode = "cooling";
  else if (isHeating) lastMode = "heating";
  else if (isFanOnly) lastMode = "fanonly";

  return { isCooling, isHeating, isFanOnly, isRunning, lastMode, raw: equipmentStatus || "" };
}

function isExpiringSoon(expiresAtISO, thresholdSec = 120) {
  if (!expiresAtISO) return true;
  return new Date(expiresAtISO).getTime() - Date.now() <= thresholdSec * 1000;
}

/* ───────────── DB & schema ───────────── */
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
      -- NEW: track last running state while session is active
      last_running_mode TEXT,                -- 'cooling' | 'heating' | 'fanonly' | null
      last_equipment_status TEXT,            -- raw equipmentStatus
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Backfill columns for older deployments (no-op if already exist)
  await pool.query(`ALTER TABLE ecobee_runtime ADD COLUMN IF NOT EXISTS last_running_mode TEXT;`);
  await pool.query(`ALTER TABLE ecobee_runtime ADD COLUMN IF NOT EXISTS last_equipment_status TEXT;`);
}

async function upsertTokens({ user_id, hvac_id, access_token, refresh_token, expires_in, scope }) {
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
    `INSERT INTO ecobee_runtime (hvac_id,is_running,current_session_started_at,last_tick_at,current_session_seconds,last_running_mode,last_equipment_status,updated_at)
     VALUES ($1,FALSE,NULL,NULL,0,NULL,NULL,NOW())
     ON CONFLICT (hvac_id) DO NOTHING`,
    [hvac_id]
  );

  await pool.query(
    `CREATE TABLE IF NOT EXISTS ecobee_revisions (
       hvac_id TEXT PRIMARY KEY,
       last_revision TEXT NOT NULL,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     );`
  );
  await pool.query(
    `INSERT INTO ecobee_revisions (hvac_id,last_revision,updated_at)
     VALUES ($1,'',NOW())
     ON CONFLICT (hvac_id) DO NOTHING`,
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
    `UPDATE ecobee_tokens
     SET access_token=$3, refresh_token=$4, expires_at=$5, updated_at=NOW()
     WHERE user_id=$1 AND hvac_id=$2`,
    [user_id, hvac_id, access_token, refresh_token, expiresAt]
  );
}

async function getLastHash(hvac_id) {
  const { rows } = await pool.query(`SELECT last_hash FROM ecobee_last_state WHERE hvac_id=$1`, [hvac_id]);
  return rows[0]?.last_hash || null;
}

async function setLastState(hvac_id, payload) {
  const h = sha(payload);
  await pool.query(
    `INSERT INTO ecobee_last_state (hvac_id,last_hash,last_payload,updated_at)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (hvac_id) DO UPDATE SET last_hash=EXCLUDED.last_hash,last_payload=EXCLUDED.last_payload,updated_at=NOW()`,
    [hvac_id, h, JSON.stringify(payload)]
  );
  return h;
}

async function getRuntime(hvac_id) {
  const { rows } = await pool.query(`SELECT * FROM ecobee_runtime WHERE hvac_id=$1`, [hvac_id]);
  return rows[0] || null;
}

async function setRuntime(hvac_id, fields) {
  const keys = Object.keys(fields);
  const vals = Object.values(fields);
  const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(", ");
  await pool.query(`UPDATE ecobee_runtime SET ${sets}, updated_at=NOW() WHERE hvac_id=$1`, [hvac_id, ...vals]);
}

async function resetRuntime(hvac_id) {
  await setRuntime(hvac_id, {
    is_running: false,
    current_session_started_at: null,
    last_tick_at: null,
    current_session_seconds: 0,
    last_running_mode: null,
    last_equipment_status: null,
  });
}

async function getLastRevision(hvac_id) {
  const { rows } = await pool.query(`SELECT last_revision FROM ecobee_revisions WHERE hvac_id=$1`, [hvac_id]);
  return rows[0]?.last_revision || "";
}

async function setLastRevision(hvac_id, rev) {
  await pool.query(
    `INSERT INTO ecobee_revisions (hvac_id,last_revision,updated_at)
     VALUES ($1,$2,NOW())
     ON CONFLICT (hvac_id) DO UPDATE SET last_revision=EXCLUDED.last_revision, updated_at=NOW()`,
    [hvac_id, rev]
  );
}

/* ───────────── Ecobee API ───────────── */
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
  const sel = { selection: { selectionType: "registered", selectionMatch: "", includeEquipmentStatus: true } };
  const url = "https://api.ecobee.com/1/thermostatSummary?json=" + encodeURIComponent(JSON.stringify(sel));
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json;charset=UTF-8" },
    timeout: 20_000,
  });
  return res.data;
}

async function fetchThermostatDetails(access_token, hvac_id) {
  const q = { selection: { selectionType: "thermostats", selectionMatch: hvac_id || "", includeRuntime: true, includeSettings: true, includeEvents: false } };
  const url = "https://api.ecobee.com/1/thermostat?json=" + encodeURIComponent(JSON.stringify(q));
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json;charset=UTF-8" },
    timeout: 20_000,
  });
  return res.data;
}

/* ───────────── Summary parsing ───────────── */
function mapStatusFromSummary(summary) {
  const list = Array.isArray(summary?.statusList) ? summary.statusList : [];
  const map = new Map();
  for (const item of list) {
    const idx = item.indexOf(":");
    if (idx > 0) map.set(item.slice(0, idx), item.slice(idx + 1));
  }
  return map;
}

function mapRevisionFromSummary(summary) {
  const list = Array.isArray(summary?.revisionList) ? summary.revisionList : [];
  const map = new Map();
  for (const item of list) {
    const idx = item.indexOf(":");
    if (idx > 0) map.set(item.slice(0, idx), item);
  }
  return map;
}

function normalizeFromDetails({ user_id, hvac_id }, equipStatus, details) {
  const parsed = parseEquipStatus(equipStatus);
  let actualTemperatureF = null, desiredHeatF = null, desiredCoolF = null, thermostatName = null, hvacMode = null;
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

/* ───────────── Bubble POST ───────────── */
async function postToBubble(payload, label = "state-change") {
  if (!BUBBLE_THERMOSTAT_UPDATES_URL) throw new Error("BUBBLE_THERMOSTAT_UPDATES_URL not set");
  await axios.post(BUBBLE_THERMOSTAT_UPDATES_URL, payload, { timeout: 20_000 });
  console.log(`[${payload.hvacId}] → POSTED to Bubble (${label}) ${nowUtc()} :: ${j(payload)}`);
}

/* ───────────── Runtime/session ───────────── */
function modeFromParsed(parsed) {
  if (parsed.isCooling) return "cooling";
  if (parsed.isHeating) return "heating";
  if (parsed.isFanOnly) return "fanonly";
  return null;
}

async function handleRuntimeAndMaybePost({ user_id, hvac_id }, normalized) {
  const nowIso = nowUtc();
  const parsed = parseEquipStatus(normalized.equipmentStatus);
  const currentMode = modeFromParsed(parsed);

  let rt = await getRuntime(hvac_id);
  if (!rt) {
    await pool.query(
      `INSERT INTO ecobee_runtime (hvac_id,is_running,current_session_started_at,last_tick_at,current_session_seconds,last_running_mode,last_equipment_status,updated_at)
       VALUES ($1,FALSE,NULL,NULL,0,NULL,NULL,NOW())
       ON CONFLICT (hvac_id) DO NOTHING`,
      [hvac_id]
    );
    rt = await getRuntime(hvac_id);
  }

  const isRunning = !!parsed.isRunning;

  // Transition: idle -> running
  if (!rt.is_running && isRunning) {
    await setRuntime(hvac_id, {
      is_running: true,
      current_session_started_at: nowIso,
      last_tick_at: nowIso,
      last_running_mode: currentMode,                 // start tracking last state
      last_equipment_status: parsed.raw,
    });
    console.log(`[${hvac_id}] ▶️ session START @ ${nowIso} (mode=${currentMode || "n/a"}, status="${parsed.raw}")`);
    return { postedSessionEnd: false };
  }

  // Running -> running (tick & update last state while active)
  if (rt.is_running && isRunning) {
    const lastTick = rt.last_tick_at ? toMillis(rt.last_tick_at) : Date.now();
    const deltaSec = Math.min(Math.max(0, Math.round((Date.now() - lastTick) / 1000)), MAX_ACCUMULATE_SECONDS);
    const newTotal = (rt.current_session_seconds || 0) + deltaSec;
    await setRuntime(hvac_id, {
      current_session_seconds: newTotal,
      last_tick_at: nowIso,
      last_running_mode: currentMode || rt.last_running_mode,
      last_equipment_status: parsed.raw || rt.last_equipment_status,
    });
    console.log(`[${hvac_id}] ⏱️ tick +${deltaSec}s (total=${newTotal}s) mode=${currentMode || rt.last_running_mode || "n/a"} status="${parsed.raw}"`);
    return { postedSessionEnd: false };
  }

  // Running -> idle (stop & POST runtime with last-state)
  if (rt.is_running && !isRunning) {
    const lastTick = rt.last_tick_at ? toMillis(rt.last_tick_at) : Date.now();
    const deltaSec = Math.min(Math.max(0, Math.round((Date.now() - lastTick) / 1000)), MAX_ACCUMULATE_SECONDS);
    const finalTotal = (rt.current_session_seconds || 0) + deltaSec;

    // Determine last-state booleans from stored last_running_mode
    const lastMode = rt.last_running_mode || currentMode || null;
    const lastIsCooling = lastMode === "cooling";
    const lastIsHeating = lastMode === "heating";
    const lastIsFanOnly = lastMode === "fanonly";
    const lastEquipmentStatus = rt.last_equipment_status || parsed.raw || "";

    const payload = {
      ...normalized,
      // normalized here reflects current (stopped) state; include last-run snapshot too:
      isRunning: false,
      runtimeSeconds: finalTotal,
      lastMode,
      lastIsCooling,
      lastIsHeating,
      lastIsFanOnly,
      lastEquipmentStatus,
    };

    console.log(`[${hvac_id}] ⏹️ session END ${finalTotal}s; lastMode=${lastMode || "n/a"} lastStatus="${lastEquipmentStatus}"`);
    await postToBubble(payload, "session-end");

    await resetRuntime(hvac_id);
    return { postedSessionEnd: true };
  }

  // Idle -> idle
  return { postedSessionEnd: false };
}

/* ───────────── Poller ───────────── */
async function pollOnce() {
  const tokens = await loadAllTokens();
  if (!tokens.length) return;
  console.log(`\n🕒 tick ${nowUtc()} — ${tokens.length} thermostat(s)`);

  for (const row of tokens) {
    const { user_id, hvac_id } = row;
    let { access_token, refresh_token, expires_at } = row;

    try {
      if (isExpiringSoon(expires_at)) {
        try {
          const refreshed = await refreshEcobeeTokens(refresh_token);
          access_token = refreshed.access_token;
          refresh_token = refreshed.refresh_token;
          await updateTokensAfterRefresh({ user_id, hvac_id, access_token, refresh_token, expires_in: refreshed.expires_in });
          console.log(`[${hvac_id}] 🔁 token refreshed`);
        } catch (e) {
          console.warn(`[${hvac_id}] ⚠️ refresh (pre-summary) failed`, e?.response?.data || e.message);
        }
      }

      let summary;
      try {
        summary = await fetchThermostatSummary(access_token);
      } catch (e) {
        if (e?.response?.status === 401) {
          const refreshed = await refreshEcobeeTokens(refresh_token);
          access_token = refreshed.access_token;
          refresh_token = refreshed.refresh_token;
          await updateTokensAfterRefresh({ user_id, hvac_id, access_token, refresh_token, expires_in: refreshed.expires_in });
          console.log(`[${hvac_id}] 🔁 token refreshed after 401`);
          summary = await fetchThermostatSummary(access_token);
        } else {
          throw e;
        }
      }

      const statusMap = mapStatusFromSummary(summary);
      const revMap = mapRevisionFromSummary(summary);
      const equipStatus = statusMap.get(hvac_id) ?? "";
      const currentRev = revMap.get(hvac_id) ?? "";
      const prevRev = await getLastRevision(hvac_id);

      const parsed = parseEquipStatus(equipStatus);
      console.log(`[${hvac_id}] 📥 summary equip="${equipStatus}" rev="${currentRev}" (prev="${prevRev}") running=${parsed.isRunning}`);

      const revisionChanged = !!currentRev && currentRev !== prevRev;

      if (revisionChanged) {
        // Fetch details for enrichment
        let details = null;
        try {
          details = await fetchThermostatDetails(access_token, hvac_id);
        } catch (e) {
          console.warn(`[${hvac_id}] ⚠️ details fetch failed`, e?.response?.data || e.message);
        }

        let normalized = normalizeFromDetails({ user_id, hvac_id }, equipStatus, details);

        // Runtime/session handling (may post immediately on session end)
        const runtimeResult = await handleRuntimeAndMaybePost({ user_id, hvac_id }, normalized);

        // De-dup state-change (ignore runtimeSeconds in hash)
        const payloadForHash = { ...normalized, runtimeSeconds: null };
        const newHash = sha(payloadForHash);
        const lastHash = await getLastHash(hvac_id);
        const shouldPostStateChange = !runtimeResult.postedSessionEnd && newHash !== lastHash;

        if (shouldPostStateChange) {
          await postToBubble({ ...normalized, runtimeSeconds: null }, "state-change");
          await setLastState(hvac_id, { ...normalized, runtimeSeconds: null });
        } else if (runtimeResult.postedSessionEnd) {
          await setLastState(hvac_id, { ...normalized, runtimeSeconds: null });
        }

        // Persist new revision after handling
        await setLastRevision(hvac_id, currentRev);
      } else {
        // No revision change → tick runtime accurately using equipmentStatus only
        const normalized = {
          userId: user_id,
          hvacId: hvac_id,
          thermostatName: null,
          hvacMode: null,
          equipmentStatus: equipStatus,
          ...parseEquipStatus(equipStatus),
          actualTemperatureF: null,
          desiredHeatF: null,
          desiredCoolF: null,
          ok: true,
          ts: nowUtc(),
        };
        const runtimeResult = await handleRuntimeAndMaybePost({ user_id, hvac_id }, normalized);
        if (runtimeResult.postedSessionEnd) {
          await setLastState(hvac_id, { ...normalized, runtimeSeconds: null });
        }
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

/* ───────────── HTTP ───────────── */
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
  await pool.query(`DELETE FROM ecobee_tokens WHERE user_id=$1 AND hvac_id=$2`, [user_id, hvac_id]);
  await pool.query(`DELETE FROM ecobee_last_state WHERE hvac_id=$1`, [hvac_id]);
  await pool.query(`DELETE FROM ecobee_runtime WHERE hvac_id=$1`, [hvac_id]);
  await pool.query(`DELETE FROM ecobee_revisions WHERE hvac_id=$1`, [hvac_id]);
  console.log(`[${hvac_id}] 🗑️ unlink cleanup @ ${nowUtc()}`);
  res.json({ ok: true, removed: true });
});

/* ───────────── Boot ───────────── */
(async () => {
  if (!BUBBLE_THERMOSTAT_UPDATES_URL || /your-bubble-app\.com/.test(BUBBLE_THERMOSTAT_UPDATES_URL)) {
    console.error("❌ BUBBLE_THERMOSTAT_UPDATES_URL is not set to a real Bubble URL.");
  }
  await ensureSchema();
  app.listen(PORT, () => console.log(`✅ Ecobee summary-driven poller on :${PORT}`));
  startPoller();
})();
