'use strict';

import { v4 as uuidv4 } from 'uuid';
import { nowUtc, toMillis } from './util.js';
import { getRuntime, setRuntime, resetRuntime, getBackfillState } from './db.js';
import { buildCorePayload, postToCoreIngestAsync } from './coreIngest.js';
import { MAX_ACCUMULATE_SECONDS } from './config.js';

const MIN_DELTA_SECONDS = 0;
const MS_TO_SECONDS = 1000;
const MIN_WRITE_INTERVAL_SECONDS = 60; // ✅ Don't write to DB more than once per minute

// Cache identical Ecobee status parses (since many thermostats report same strings)
const statusCache = new Map();

/* -------------------------------------------------------------------------- */
/*                           Parse Equipment Status                           */
/* -------------------------------------------------------------------------- */
function parseEcobeeEquipmentStatus(statusRaw) {
  if (statusCache.has(statusRaw)) return statusCache.get(statusRaw);

  const status = (statusRaw || '').toLowerCase().trim();
  let result;

  if (!status) {
    result = { eventType: 'Idle', equipmentStatus: 'IDLE', isActive: false, mode: 'off' };
  } else {
    const parts = status.split(',').map(s => s.trim());
    const hasFan = parts.includes('fan');
    const hasHeat = parts.some(p => p === 'heat' || p.startsWith('heat') || p === 'heatpump' || p.startsWith('heatpump'));
    const hasAuxHeat = parts.some(p => p.startsWith('auxheat') || p === 'auxheat' || p === 'emergency');
    const hasCool = parts.some(p => p === 'cool' || p.startsWith('cool') || p.startsWith('compcool'));

    if (hasAuxHeat) result = { eventType: hasFan ? 'AuxHeat_Fan' : 'AuxHeat', equipmentStatus: 'AUX_HEATING', isActive: true, mode: 'auxheat' };
    else if (hasHeat) result = { eventType: hasFan ? 'Heating_Fan' : 'Heating', equipmentStatus: 'HEATING', isActive: true, mode: 'heating' };
    else if (hasCool) result = { eventType: hasFan ? 'Cooling_Fan' : 'Cooling', equipmentStatus: 'COOLING', isActive: true, mode: 'cooling' };
    else if (hasFan) result = { eventType: 'Fan_only', equipmentStatus: 'FAN', isActive: true, mode: 'fan' };
    else result = { eventType: 'Idle', equipmentStatus: 'IDLE', isActive: false, mode: 'off' };
  }

  statusCache.set(statusRaw, result);
  return result;
}

/* -------------------------------------------------------------------------- */
/*                       Optimized Runtime & Posting Logic                    */
/* -------------------------------------------------------------------------- */
export async function handleRuntimeAndMaybePost({ user_id, hvac_id }, normalized) {
  const nowIso = nowUtc();
  const nowMs = Date.now();
  const parsed = parseEcobeeEquipmentStatus(normalized.equipmentStatus);
  const { eventType, equipmentStatus, isActive, mode } = parsed;
  const isReachable = normalized.isReachable !== false;
  const runtimeRev = normalized.runtimeRev || null; // ✅ Ecobee runtime revision hint
  const backfill = await getBackfillState(hvac_id);

  // Retrieve runtime state
  let rt = await getRuntime(hvac_id);
  if (!rt) {
    await setRuntime(hvac_id, {
      is_running: false,
      current_session_started_at: null,
      last_tick_at: null,
      current_session_seconds: 0,
      last_running_mode: null,
      last_event_type: null,
      last_equipment_status: null,
      is_reachable: true,
      last_seen_at: nowIso,
      last_runtime_rev: null,
    });
    rt = await getRuntime(hvac_id);
  }

  /* -------------------------------------------------------------------------- */
  /*                  🔕 Skip Poll if Runtime Revision Unchanged                */
  /* -------------------------------------------------------------------------- */
  if (runtimeRev && rt.last_runtime_rev === runtimeRev) {
    console.log(`[${hvac_id}] No runtime change (rev=${runtimeRev}) — skipping poll`);
    return { skipped: true };
  }

  // Update runtime revision
  await setRuntime(hvac_id, { last_runtime_rev: runtimeRev, last_seen_at: nowIso });

  const wasActive = rt.is_running;
  const prevEventType = rt.last_event_type || 'Idle';
  const prevEquipStatus = rt.last_equipment_status || 'IDLE';
  const modeChanged = wasActive && eventType !== prevEventType;
  const lastWriteMs = rt.last_tick_at ? toMillis(rt.last_tick_at) : 0;
  const shouldWrite = (nowMs - lastWriteMs) / 1000 >= MIN_WRITE_INTERVAL_SECONDS || modeChanged;

  /* -------------------------------------------------------------------------- */
  /*                        📴 Device Offline Handling                          */
  /* -------------------------------------------------------------------------- */
  if (!isReachable) {
    if (rt.is_reachable === false) return { postedSessionEnd: false }; // Already offline

    if (wasActive) {
      const deltaSec = Math.min(Math.max(0, (nowMs - lastWriteMs) / MS_TO_SECONDS), MAX_ACCUMULATE_SECONDS);
      const total = (rt.current_session_seconds || 0) + deltaSec;
      const payload = buildCorePayload({
        deviceKey: hvac_id,
        userId: user_id,
        deviceName: normalized.thermostatName,
        eventType: 'Mode_Change',
        equipmentStatus: 'IDLE',
        previousStatus: prevEquipStatus,
        isActive: false,
        isReachable: false,
        mode: 'off',
        runtimeSeconds: total,
        temperatureF: normalized.actualTemperatureF ?? backfill?.last_temperature,
        observedAt: new Date(nowIso),
        sourceEventId: uuidv4(),
      });
      await postToCoreIngestAsync(payload, 'offline-session-end');
      await resetRuntime(hvac_id);
    }

    const payload = buildCorePayload({
      deviceKey: hvac_id,
      userId: user_id,
      deviceName: normalized.thermostatName,
      eventType: 'Connectivity_Change',
      equipmentStatus: 'IDLE',
      previousStatus: 'ONLINE',
      isActive: false,
      isReachable: false,
      mode: 'off',
      runtimeSeconds: null,
      observedAt: new Date(nowIso),
      sourceEventId: uuidv4(),
    });
    await postToCoreIngestAsync(payload, 'connectivity-offline');
    await setRuntime(hvac_id, { is_reachable: false });
    return { postedSessionEnd: true };
  }

  /* -------------------------------------------------------------------------- */
  /*                         🟢 Device Reconnected                              */
  /* -------------------------------------------------------------------------- */
  if (rt.is_reachable === false && isReachable) {
    const payload = buildCorePayload({
      deviceKey: hvac_id,
      userId: user_id,
      deviceName: normalized.thermostatName,
      eventType: 'Connectivity_Change',
      equipmentStatus,
      previousStatus: 'OFFLINE',
      isActive,
      isReachable: true,
      mode,
      runtimeSeconds: null,
      observedAt: new Date(nowIso),
      sourceEventId: uuidv4(),
    });
    await postToCoreIngestAsync(payload, 'connectivity-online');
    await setRuntime(hvac_id, { is_reachable: true });
  }

  /* -------------------------------------------------------------------------- */
  /*                             ▶️ SESSION START                              */
  /* -------------------------------------------------------------------------- */
  if (!wasActive && isActive) {
    const sessionId = uuidv4();
    await setRuntime(hvac_id, {
      is_running: true,
      current_session_started_at: nowIso,
      last_tick_at: nowIso,
      current_session_seconds: 0,
      last_running_mode: mode,
      last_event_type: eventType,
      last_equipment_status: eventType,
    });
    const payload = buildCorePayload({
      deviceKey: hvac_id,
      userId: user_id,
      deviceName: normalized.thermostatName,
      eventType: 'Mode_Change',
      equipmentStatus: eventType,
      previousStatus: prevEventType,
      isActive: true,
      isReachable: true,
      mode,
      runtimeSeconds: undefined,
      observedAt: new Date(nowIso),
      sourceEventId: sessionId,
    });
    await postToCoreIngestAsync(payload, 'session-start');
    return { postedSessionEnd: false };
  }

  /* -------------------------------------------------------------------------- */
  /*                          ⏱️ SESSION ACTIVE TICK                           */
  /* -------------------------------------------------------------------------- */
  if (wasActive && isActive) {
    const deltaSec = Math.min(Math.max(0, (nowMs - lastWriteMs) / MS_TO_SECONDS), MAX_ACCUMULATE_SECONDS);
    const newTotal = (rt.current_session_seconds || 0) + deltaSec;

    // Debounce minor mode flaps — require 1 poll cycle of stability before posting
    if (modeChanged && rt.pending_mode_change === eventType) {
      const payload = buildCorePayload({
        deviceKey: hvac_id,
        userId: user_id,
        deviceName: normalized.thermostatName,
        eventType: 'Mode_Change',
        equipmentStatus: eventType,
        previousStatus: prevEventType,
        isActive: true,
        isReachable: true,
        mode,
        runtimeSeconds: newTotal,
        observedAt: new Date(nowIso),
        sourceEventId: uuidv4(),
      });
      await postToCoreIngestAsync(payload, 'mode-switch');
      await setRuntime(hvac_id, {
        current_session_seconds: 0,
        current_session_started_at: nowIso,
        last_tick_at: nowIso,
        last_running_mode: mode,
        last_event_type: eventType,
        last_equipment_status: equipmentStatus,
        pending_mode_change: null,
      });
    } else if (modeChanged) {
      await setRuntime(hvac_id, { pending_mode_change: eventType });
    } else if (shouldWrite) {
      await setRuntime(hvac_id, { current_session_seconds: newTotal, last_tick_at: nowIso });
    }

    return { postedSessionEnd: false };
  }

  /* -------------------------------------------------------------------------- */
  /*                             ⏹️ SESSION END                               */
  /* -------------------------------------------------------------------------- */
  if (wasActive && !isActive) {
    const deltaSec = Math.min(Math.max(0, (nowMs - lastWriteMs) / MS_TO_SECONDS), MAX_ACCUMULATE_SECONDS);
    const total = (rt.current_session_seconds || 0) + deltaSec;
    const payload = buildCorePayload({
      deviceKey: hvac_id,
      userId: user_id,
      deviceName: normalized.thermostatName,
      eventType: 'Mode_Change',
      equipmentStatus: 'IDLE',
      previousStatus: prevEquipStatus,
      isActive: false,
      isReachable: true,
      mode: 'off',
      runtimeSeconds: total,
      observedAt: new Date(nowIso),
      sourceEventId: uuidv4(),
    });
    await postToCoreIngestAsync(payload, 'session-end');
    await resetRuntime(hvac_id);
    return { postedSessionEnd: true };
  }

  /* -------------------------------------------------------------------------- */
  /*                         🌡️ Idle Telemetry Update                          */
  /* -------------------------------------------------------------------------- */
  if (!wasActive && !isActive && isReachable && shouldWrite && normalized.actualTemperatureF != null) {
    const prevTemp = backfill?.last_temperature ?? null;
    const tempChanged = prevTemp == null || Math.abs(normalized.actualTemperatureF - prevTemp) >= 0.5;
    if (tempChanged) {
      const payload = buildCorePayload({
        deviceKey: hvac_id,
        userId: user_id,
        deviceName: normalized.thermostatName,
        eventType: 'Telemetry_Update',
        equipmentStatus: 'IDLE',
        previousStatus: 'IDLE',
        isActive: false,
        isReachable: true,
        mode: 'off',
        runtimeSeconds: null,
        temperatureF: normalized.actualTemperatureF,
        humidity: normalized.humidity,
        observedAt: new Date(nowIso),
        sourceEventId: uuidv4(),
      });
      await postToCoreIngestAsync(payload, 'telemetry-update');
    }
  }

  return { postedSessionEnd: false };
}
