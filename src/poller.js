'use strict';

import { isExpiringSoon, parseEquipStatus, nowUtc, sha } from './util.js';
import {
  loadAllTokens,
  updateTokensAfterRefresh,
  markSeenAndGetTransition,
  getLastRevision,
  setLastRevision,
  getRuntime,
  setRuntime,
  getLastHash,
  setLastState,
  pool
} from './db.js';
import {
  refreshEcobeeTokens,
  fetchThermostatSummary,
  fetchThermostatDetails
} from './ecobeeApi.js';
import {
  mapStatusFromSummary,
  mapRevisionFromSummary,
  normalizeFromDetails,
  parseConnectedFromRevision
} from './normalize.js';
import { handleRuntimeAndMaybePost } from './runtime.js';
import { postToBubble, postConnectivityChange } from './bubble.js';
import { buildCorePayload, postToCoreIngestAsync } from './coreIngest.js';
import { v4 as uuidv4 } from 'uuid';
import { ERROR_BACKOFF_MS, POLL_CONCURRENCY } from './config.js';

/* -------------------------------------------------------------------------- */
/*                            TOKEN MANAGEMENT                                */
/* -------------------------------------------------------------------------- */
async function ensureValidToken(row) {
  const { user_id, hvac_id } = row;
  let { access_token, refresh_token, expires_at } = row;

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
        expires_in: refreshed.expires_in
      });
      console.log(`[${hvac_id}] 🔄 token refreshed`);
    } catch (e) {
      console.warn(`[${hvac_id}] ⚠️ token refresh failed:`, e?.response?.data || e.message);
      throw e;
    }
  }

  return { access_token, refresh_token };
}

/* -------------------------------------------------------------------------- */
/*                         FETCH SUMMARY WITH RETRY                           */
/* -------------------------------------------------------------------------- */
async function fetchSummaryWithRetry(row, access_token, refresh_token) {
  const { user_id, hvac_id } = row;
  try {
    return await fetchThermostatSummary(access_token);
  } catch (e) {
    if (e?.response?.status === 401) {
      console.log(`[${hvac_id}] 🔄 401 error, refreshing token...`);
      const refreshed = await refreshEcobeeTokens(refresh_token);
      await updateTokensAfterRefresh({
        user_id,
        hvac_id,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        expires_in: refreshed.expires_in
      });
      return await fetchThermostatSummary(refreshed.access_token);
    }
    throw e;
  }
}

/* -------------------------------------------------------------------------- */
/*                  DETECT SIGNIFICANT STATE CHANGES                           */
/* -------------------------------------------------------------------------- */
function hasSignificantStateChange(prev, current) {
  if (!prev) return true;

  const tempChanged =
    prev.actualTemperatureF &&
    current.actualTemperatureF &&
    Math.abs(prev.actualTemperatureF - current.actualTemperatureF) > 1;

  const heatSetpointChanged = prev.desiredHeatF !== current.desiredHeatF;
  const coolSetpointChanged = prev.desiredCoolF !== current.desiredCoolF;
  const modeChanged = prev.hvacMode !== current.hvacMode;
  const reachabilityChanged = prev.isReachable !== current.isReachable;

  return tempChanged || heatSetpointChanged || coolSetpointChanged || modeChanged || reachabilityChanged;
}

/* -------------------------------------------------------------------------- */
/*                        MAIN THERMOSTAT PROCESSOR                            */
/* -------------------------------------------------------------------------- */
async function processThermostat(row) {
  const { user_id, hvac_id } = row;

  try {
    const { access_token, refresh_token } = await ensureValidToken(row);
    const summary = await fetchSummaryWithRetry(row, access_token, refresh_token);

    const statusMap = mapStatusFromSummary(summary);
    const revMap = mapRevisionFromSummary(summary);
    const equipStatus = statusMap.get(hvac_id) ?? '';
    const currentRev = revMap.get(hvac_id) ?? '';
    const isConnectedToEcobee = parseConnectedFromRevision(currentRev);

    const prevRev = await getLastRevision(hvac_id);
    const rt = await getRuntime(hvac_id);
    const isReachable = isConnectedToEcobee;

    /* ----------------------- Connectivity Change Detection ----------------------- */
    const prevReachable = rt?.is_reachable;
    if (prevReachable !== null && prevReachable !== undefined && prevReachable !== isReachable) {
      await setRuntime(hvac_id, { is_reachable: isReachable });

      if (isReachable) {
        console.log(`[${hvac_id}] 🟢 Thermostat reconnected to Ecobee`);
        await postConnectivityChange({
          userId: user_id,
          hvac_id,
          isReachable: true,
          reason: 'thermostat_reconnected'
        });
      } else {
        console.log(`[${hvac_id}] 🔴 Thermostat disconnected from Ecobee`);
        await postConnectivityChange({
          userId: user_id,
          hvac_id,
          isReachable: false,
          reason: 'thermostat_disconnected'
        });
      }

      // ✅ Delegate posting to Core to runtime.js
      console.log(`[${hvac_id}] 🧠 Delegating connectivity post to runtime.js`);
    }

    /* ----------------------------- Log Summary ----------------------------- */
    const parsed = parseEquipStatus(equipStatus);
    console.log(
      `[${hvac_id}] 📥 summary equip="${equipStatus}" rev="${currentRev}" (prev="${prevRev}") running=${parsed.isRunning} ecobee_connected=${isConnectedToEcobee} reachable=${isReachable}`
    );

    const revisionChanged = !!currentRev && currentRev !== prevRev;

    /* ---------------------- Revision Changed → Fetch Details ---------------------- */
    if (revisionChanged) {
      let details = null;
      try {
        details = await fetchThermostatDetails(access_token, hvac_id);
      } catch (e) {
        console.warn(`[${hvac_id}] ⚠️ details fetch failed:`, e?.response?.data || e.message);
      }

      const normalized = normalizeFromDetails({ user_id, hvac_id, isReachable }, equipStatus, details);

      // Handle runtime and post to Core/Bubble if session ends
      const runtimeResult = await handleRuntimeAndMaybePost({ user_id, hvac_id }, normalized);

      // Dedupe by hash + significance check
      const lastHash = await getLastHash(hvac_id);
      const payloadForHash = { ...normalized, runtimeSeconds: null };
      const newHash = sha(payloadForHash);

      let lastStateData = null;
      try {
        const { rows } = await pool.query(`SELECT last_payload FROM ecobee_last_state WHERE hvac_id = $1`, [hvac_id]);
        lastStateData = rows[0]?.last_payload || null;
      } catch {
        console.warn(`[${hvac_id}] Could not retrieve last state for comparison`);
      }

      const shouldPostStateChange = hasSignificantStateChange(lastStateData, normalized);
      const hasHashChanged = newHash !== lastHash;

      if (shouldPostStateChange && hasHashChanged && !runtimeResult.postedSessionEnd) {
        const corePayload = buildCorePayload({
          deviceKey: hvac_id,
          userId: user_id,
          deviceName: normalized.thermostatName,
          eventType: 'STATE_UPDATE',
          equipmentStatus: parsed.isCooling
            ? 'COOLING'
            : parsed.isHeating
            ? 'HEATING'
            : parsed.isFanOnly
            ? 'FAN'
            : 'OFF',
          previousStatus: lastStateData?.equipmentStatus || 'UNKNOWN',
          isActive: !!parsed.isRunning,
          mode: normalized.hvacMode,
          runtimeSeconds: null,
          temperatureF: normalized.actualTemperatureF,
          heatSetpoint: normalized.desiredHeatF,
          coolSetpoint: normalized.desiredCoolF,
          observedAt: new Date(),
          sourceEventId: uuidv4(),
          payloadRaw: normalized
        });

        try {
          await postToCoreIngestAsync(corePayload, 'state-update');
        } catch (e) {
          console.error(`[${hvac_id}] ✗ Failed to post state update to Core:`, e.message);
        }
      }

      // Post to Bubble for state change if hash changed
      if (hasHashChanged && !runtimeResult.postedSessionEnd) {
        try {
          await postToBubble({ ...normalized, runtimeSeconds: null }, 'state-change');
          await setLastState(hvac_id, { ...normalized, runtimeSeconds: null });
        } catch (e) {
          console.error(`[${hvac_id}] ✗ Failed to post state change to Bubble:`, e.message);
          throw e;
        }
      } else if (runtimeResult.postedSessionEnd) {
        await setLastState(hvac_id, { ...normalized, runtimeSeconds: null });
      }

      await setLastRevision(hvac_id, currentRev);
    }

    /* ----------------------- Revision Unchanged → Tick ----------------------- */
    else {
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
        isReachable
      };

      const runtimeResult = await handleRuntimeAndMaybePost({ user_id, hvac_id }, normalized);
      if (runtimeResult.postedSessionEnd) {
        await setLastState(hvac_id, { ...normalized, runtimeSeconds: null });
      }
    }
  } catch (err) {
    console.error(`[${hvac_id}] ✗ poll error:`, err?.response?.data || err.message || String(err));
    await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*                            POLL ALL THERMOSTATS                            */
/* -------------------------------------------------------------------------- */
export async function pollOnce() {
  const tokens = await loadAllTokens();
  if (!tokens.length) return;

  console.log(`\n🕐 tick ${nowUtc()} — ${tokens.length} thermostat(s)`);

  const results = [];
  for (let i = 0; i < tokens.length; i += POLL_CONCURRENCY) {
    const batch = tokens.slice(i, i + POLL_CONCURRENCY);
    const batchResults = await Promise.allSettled(batch.map((token) => processThermostat(token)));
    results.push(...batchResults);
  }

  const successful = results.filter((r) => r.status === 'fulfilled').length;
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed > 0) {
    console.log(`📊 Poll complete: ${successful} succeeded, ${failed} failed`);
  }
}

/* -------------------------------------------------------------------------- */
/*                             POLLER LIFECYCLE                              */
/* -------------------------------------------------------------------------- */
let pollerInterval;

export function startPoller(intervalMs) {
  pollOnce().catch((e) => console.error('Initial poll error:', e));
  pollerInterval = setInterval(() => {
    pollOnce().catch((e) => console.error('Poll error:', e));
  }, intervalMs);
  return pollerInterval;
}

export function stopPoller() {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
  }
}
