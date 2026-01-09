'use strict';

import { v4 as uuidv4 } from 'uuid';
import { nowUtc, toMillis } from './util.js';
import { getRuntime, setRuntime, resetRuntime, getBackfillState, insertSession } from './db.js';
import { buildCorePayload, postToCoreIngestAsync } from './coreIngest.js';
import { MAX_ACCUMULATE_SECONDS } from './config.js';

const MS_TO_SECONDS = 1000;
const MIN_WRITE_INTERVAL_SECONDS = 60;
const LONG_RUNTIME_THRESHOLD_SECONDS = 30 * 60; // 30 min continuous operation

const statusCache = new Map();

/* -------------------------------------------------------------------------- */
/*                     Parse Ecobee equipmentStatus String                    */
/* -------------------------------------------------------------------------- */
function parseEcobeeEquipmentStatusCached(statusRaw) {
  if (statusCache.has(statusRaw)) return statusCache.get(statusRaw);

  const status = (statusRaw || '').toLowerCase().trim();
  let result;

  if (!status) result = { eventType: 'Idle', equipmentStatus: 'IDLE', isActive: false, mode: 'off' };
  else {
    const parts = status.split(',').map(s => s.trim());
    const hasFan = parts.includes('fan');
    const hasHeat = parts.some(p => p.startsWith('heat') || p.startsWith('heatpump'));
    const hasAux = parts.some(p => p.startsWith('auxheat') || p === 'emergency');
    const hasCool = parts.some(p => p.startsWith('cool') || p.startsWith('compcool'));

    if (hasAux) result = { eventType: hasFan ? 'AuxHeat_Fan' : 'AuxHeat', equipmentStatus: 'AUX_HEATING', isActive: true, mode: 'auxheat' };
    else if (hasHeat) result = { eventType: hasFan ? 'Heating_Fan' : 'Heating', equipmentStatus: 'HEATING', isActive: true, mode: 'heating' };
    else if (hasCool) result = { eventType: hasFan ? 'Cooling_Fan' : 'Cooling', equipmentStatus: 'COOLING', isActive: true, mode: 'cooling' };
    else if (hasFan) result = { eventType: 'Fan_only', equipmentStatus: 'FAN', isActive: true, mode: 'fan' };
    else result = { eventType: 'Idle', equipmentStatus: 'IDLE', isActive: false, mode: 'off' };
  }

  statusCache.set(statusRaw, result);
  return result;
}

/* -------------------------------------------------------------------------- */
/*                   Calculate Next Poll Interval Dynamically                 */
/* -------------------------------------------------------------------------- */
export function calculateNextPollSeconds(rt, parsed, lastRuntimeRevChangedAt) {
  const now = Date.now();
  const ageSec = lastRuntimeRevChangedAt ? (now - toMillis(lastRuntimeRevChangedAt)) / 1000 : 0;

  if (!rt.is_reachable) return 600; // offline → 10 min
  if (!parsed.isActive) return 360; // idle → 6 min
  if (parsed.isActive && rt.current_session_seconds > LONG_RUNTIME_THRESHOLD_SECONDS) return 180; // long run
  if (rt.pending_mode_change) return 60; // verifying transition
  if (ageSec < 60) return 90; // fresh update, poll soon again

  return 120; // default active → 2 min
}

/* -------------------------------------------------------------------------- */
/*              Main runtime handler with adaptive polling hint               */
/* -------------------------------------------------------------------------- */
export async function handleRuntimeAndMaybePostAdaptive({ user_id, hvac_id }, normalized) {
  const nowIso = nowUtc();
  const nowMs = Date.now();
  const parsed = parseEcobeeEquipmentStatusCached(normalized.equipmentStatus);
  const { eventType, equipmentStatus, isActive, mode } = parsed;
  const isReachable = normalized.isReachable !== false;
  const runtimeRev = normalized.runtimeRev || null;
  const backfill = await getBackfillState(hvac_id);

  // merge new + backfill telemetry
  const temperatureF = normalized.actualTemperatureF ?? backfill?.last_temperature ?? null;
  const humidity = normalized.humidity ?? backfill?.last_humidity ?? null;
  const heatSetpoint = normalized.desiredHeatF ?? backfill?.last_heat_setpoint ?? null;
  const coolSetpoint = normalized.desiredCoolF ?? backfill?.last_cool_setpoint ?? null;
  const thermostatMode = normalized.hvacMode ?? backfill?.thermostat_mode ?? null;

  let rt = await getRuntime(hvac_id);
  if (!rt) {
    await setRuntime(hvac_id, {
      is_running: false,
      last_event_type: 'Idle',
      current_session_seconds: 0,
      is_reachable: true,
      last_runtime_rev: null,
      last_runtime_rev_changed_at: nowIso,
    });
    rt = await getRuntime(hvac_id);
  }

  const prevEquipStatus = rt.last_equipment_status || backfill?.last_equipment_status || 'IDLE';

  /* -------------------------- Skip identical runtime -------------------------- */
  if (runtimeRev && rt.last_runtime_rev === runtimeRev) {
    const nextPollSeconds = calculateNextPollSeconds(rt, parsed, rt.last_runtime_rev_changed_at);
    console.log(`[${hvac_id}] ⏳ No runtime change (rev=${runtimeRev}); next poll in ${nextPollSeconds}s`);
    return { skipped: true, nextPollSeconds };
  }

  // Update runtime revision + timestamp of change
  await setRuntime(hvac_id, {
    last_runtime_rev: runtimeRev,
    last_runtime_rev_changed_at: nowIso,
    last_seen_at: nowIso,
  });

  const wasActive = rt.is_running;
  const lastTickMs = rt.last_tick_at ? toMillis(rt.last_tick_at) : nowMs;
  const deltaSec = Math.min(Math.max(0, (nowMs - lastTickMs) / MS_TO_SECONDS), MAX_ACCUMULATE_SECONDS);

  /* --------------------------- Connectivity handling --------------------------- */
  if (!isReachable) {
    if (rt.is_reachable === false) {
      return { skipped: true, nextPollSeconds: 600 };
    }

    if (wasActive) {
      const total = Math.round((rt.current_session_seconds || 0) + deltaSec);
      const payload = buildCorePayload({
        deviceKey: hvac_id,
        userId: user_id,
        eventType: 'Mode_Change',
        equipmentStatus: 'IDLE',
        previousStatus: prevEquipStatus,
        isActive: false,
        isReachable: false,
        runtimeSeconds: total,
        temperatureF,
        humidity,
        heatSetpoint,
        coolSetpoint,
        thermostatMode,
        observedAt: new Date(nowIso),
      });
      await postToCoreIngestAsync(payload, 'offline-session-end');

      // Persist session to database for runtime validation
      if (rt.current_session_started_at && total > 0) {
        try {
          await insertSession({
            hvac_id,
            user_id,
            started_at: rt.current_session_started_at,
            ended_at: nowIso,
            runtime_seconds: total,
            equipment_type: prevEquipStatus,
            avg_temperature: temperatureF,
            avg_humidity: humidity,
            thermostat_mode: thermostatMode,
          });
          console.log(`[${hvac_id}] 💾 Persisted offline session: ${prevEquipStatus} for ${total}s`);
        } catch (err) {
          console.error(`[${hvac_id}] Failed to persist offline session:`, err.message);
        }
      }

      await resetRuntime(hvac_id);
    }

    const payload = buildCorePayload({
      deviceKey: hvac_id,
      userId: user_id,
      eventType: 'Connectivity_Change',
      equipmentStatus: 'IDLE',
      previousStatus: prevEquipStatus,
      isActive: false,
      isReachable: false,
      observedAt: new Date(nowIso),
    });
    await postToCoreIngestAsync(payload, 'connectivity-offline');
    await setRuntime(hvac_id, { is_reachable: false });
    return { postedSessionEnd: true, nextPollSeconds: 600 };
  }

  if (rt.is_reachable === false && isReachable) {
    const payload = buildCorePayload({
      deviceKey: hvac_id,
      userId: user_id,
      eventType: 'Connectivity_Change',
      equipmentStatus,
      previousStatus: prevEquipStatus,
      isActive,
      isReachable: true,
      observedAt: new Date(nowIso),
    });
    await postToCoreIngestAsync(payload, 'connectivity-online');
    await setRuntime(hvac_id, { is_reachable: true });
  }

  /* ----------------------------- Session start ----------------------------- */
  if (!wasActive && isActive) {
    const id = uuidv4();
    await setRuntime(hvac_id, {
      is_running: true,
      current_session_started_at: nowIso,
      last_tick_at: nowIso,
      current_session_seconds: 0,
      last_event_type: eventType,
      last_equipment_status: eventType,
      last_temperature: temperatureF,
      last_humidity: humidity,
      last_heat_setpoint: heatSetpoint,
      last_cool_setpoint: coolSetpoint,
      thermostat_mode: thermostatMode,
    });

    const payload = buildCorePayload({
      deviceKey: hvac_id,
      userId: user_id,
      eventType: 'Mode_Change',
      equipmentStatus: eventType,
      previousStatus: prevEquipStatus,
      isActive: true,
      temperatureF,
      humidity,
      heatSetpoint,
      coolSetpoint,
      thermostatMode,
      observedAt: new Date(nowIso),
      sourceEventId: id,
    });
    await postToCoreIngestAsync(payload, 'session-start');
    return { postedSessionEnd: false, nextPollSeconds: 90 };
  }

  /* ----------------------------- Session tick ------------------------------ */
  if (wasActive && isActive) {
    const total = Math.round((rt.current_session_seconds || 0) + deltaSec);
    const shouldWrite = (nowMs - lastTickMs) / 1000 >= MIN_WRITE_INTERVAL_SECONDS;
    if (shouldWrite) {
      await setRuntime(hvac_id, {
        current_session_seconds: total,
        last_tick_at: nowIso,
        last_temperature: temperatureF,
        last_humidity: humidity,
        last_heat_setpoint: heatSetpoint,
        last_cool_setpoint: coolSetpoint,
        thermostat_mode: thermostatMode,
        last_equipment_status: eventType,
      });
    }
    const nextPollSeconds = calculateNextPollSeconds(rt, parsed, rt.last_runtime_rev_changed_at);
    console.log(`[${hvac_id}] Active ${eventType} tick +${deltaSec}s (total=${total}s) → next poll ${nextPollSeconds}s`);
    return { postedSessionEnd: false, nextPollSeconds };
  }

  /* ----------------------------- Session end ------------------------------- */
  if (wasActive && !isActive) {
    const total = Math.round((rt.current_session_seconds || 0) + deltaSec);
    const payload = buildCorePayload({
      deviceKey: hvac_id,
      userId: user_id,
      eventType: 'Mode_Change',
      equipmentStatus: 'IDLE',
      previousStatus: prevEquipStatus,
      isActive: false,
      runtimeSeconds: total,
      temperatureF,
      humidity,
      heatSetpoint,
      coolSetpoint,
      thermostatMode,
      observedAt: new Date(nowIso),
    });
    await postToCoreIngestAsync(payload, 'session-end');

    // Persist session to database for runtime validation
    if (rt.current_session_started_at && total > 0) {
      try {
        await insertSession({
          hvac_id,
          user_id,
          started_at: rt.current_session_started_at,
          ended_at: nowIso,
          runtime_seconds: total,
          equipment_type: prevEquipStatus,
          avg_temperature: temperatureF,
          avg_humidity: humidity,
          thermostat_mode: thermostatMode,
        });
        console.log(`[${hvac_id}] 💾 Persisted session: ${prevEquipStatus} for ${total}s`);
      } catch (err) {
        console.error(`[${hvac_id}] Failed to persist session:`, err.message);
      }
    }

    await setRuntime(hvac_id, {
      last_equipment_status: 'IDLE',
      last_temperature: temperatureF,
      last_humidity: humidity,
      last_heat_setpoint: heatSetpoint,
      last_cool_setpoint: coolSetpoint,
      thermostat_mode: thermostatMode,
    });
    await resetRuntime(hvac_id);
    return { postedSessionEnd: true, nextPollSeconds: 360 };
  }

  /* ----------------------------- Idle updates ------------------------------ */
  if (!wasActive && !isActive) {
    const nextPollSeconds = 360;
    await setRuntime(hvac_id, {
      last_temperature: temperatureF,
      last_humidity: humidity,
      last_heat_setpoint: heatSetpoint,
      last_cool_setpoint: coolSetpoint,
      thermostat_mode: thermostatMode,
      last_equipment_status: 'IDLE',
    });
    return { skipped: true, nextPollSeconds };
  }

  return { nextPollSeconds: 180 };
}
