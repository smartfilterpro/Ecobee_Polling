import { parseEquipStatus, modeFromParsed, nowUtc, toMillis } from "./util.js";
import { getRuntime, setRuntime, resetRuntime, getBackfillState } from "./db.js";
import { postToBubble } from "./bubble.js";
import { buildCorePayload, postToCoreIngestAsync } from "./coreIngest.js";
import { MAX_ACCUMULATE_SECONDS } from "./config.js";
import { v4 as uuidv4 } from "uuid";

const MIN_DELTA_SECONDS = 0;
const MS_TO_SECONDS = 1000;

/**
 * Handle runtime tracking and post to Core only on START/END
 * Post to Bubble only on session END
 */
export async function handleRuntimeAndMaybePost({ user_id, hvac_id }, normalized) {
  const nowIso = nowUtc();
  const parsed = parseEquipStatus(normalized.equipmentStatus);
  const currentMode = modeFromParsed(parsed);

  let rt = await getRuntime(hvac_id);
  if (!rt) {
    await setRuntime(hvac_id, {
      is_running: false,
      current_session_started_at: null,
      last_tick_at: null,
      current_session_seconds: 0,
      last_running_mode: null,
      last_equipment_status: null,
      is_reachable: true,
      last_seen_at: nowIso,
    });
    rt = await getRuntime(hvac_id);
  }

  const isRunning = !!parsed.isRunning;
  const isReachable = normalized.isReachable !== false; // default to true if undefined

  // If device is unreachable and has a running session, end it immediately
  if (!isReachable && rt.is_running) {
    const lastTick = rt.last_tick_at ? toMillis(rt.last_tick_at) : Date.now();
    const deltaSec = Math.min(
      Math.max(MIN_DELTA_SECONDS, Math.round((Date.now() - lastTick) / MS_TO_SECONDS)),
      MAX_ACCUMULATE_SECONDS
    );
    const finalTotal = (rt.current_session_seconds || 0) + deltaSec;

    const lastMode = rt.last_running_mode || currentMode || null;
    const lastEquipmentStatus = rt.last_equipment_status || parsed.raw || "";
    const backfill = await getBackfillState(hvac_id);

    const bubblePayload = {
      ...normalized,
      isRunning: false,
      runtimeSeconds: finalTotal,
      lastMode,
      lastIsCooling: lastMode === "cooling",
      lastIsHeating: lastMode === "heating",
      lastIsFanOnly: lastMode === "fanonly",
      lastEquipmentStatus,
      isReachable: false
    };

    const corePayload = buildCorePayload({
      deviceKey: hvac_id,
      userId: user_id,
      deviceName: normalized.thermostatName,
      eventType: 'OFFLINE_SESSION_END',
      equipmentStatus: 'OFF',
      previousStatus: lastEquipmentStatus,
      isActive: false,
      mode: 'off',
      runtimeSeconds: finalTotal,
      temperatureF: normalized.actualTemperatureF ?? backfill?.last_temperature ?? null,
      heatSetpoint: normalized.desiredHeatF ?? backfill?.last_heat_setpoint ?? null,
      coolSetpoint: normalized.desiredCoolF ?? backfill?.last_cool_setpoint ?? null,
      observedAt: new Date(nowIso),
      sourceEventId: uuidv4(),
      payloadRaw: normalized
    });

    console.log(`[${hvac_id}] 📴 OFFLINE - ending session ${finalTotal}s; lastMode=${lastMode || "n/a"}`);

    try {
      await Promise.allSettled([
        postToCoreIngestAsync(corePayload, "offline-session-end"),
        postToBubble(bubblePayload, "offline-session-end")
      ]);
      await resetRuntime(hvac_id);
      return { postedSessionEnd: true };
    } catch (e) {
      console.error(`[${hvac_id}] ✗ Failed to post offline session end:`, e.message);
      await resetRuntime(hvac_id);
      throw e;
    }
  }

  // Don't accumulate runtime if device is unreachable
  // But check if we need to post a connectivity change
  if (!isReachable) {
    // Check if reachability status changed
    const prevReachable = rt.is_reachable;
    if (prevReachable !== false) {
      // Device just went offline - post connectivity change
      const backfill = await getBackfillState(hvac_id);
      const corePayload = buildCorePayload({
        deviceKey: hvac_id,
        userId: user_id,
        deviceName: normalized.thermostatName || backfill?.device_name || null,
        eventType: 'CONNECTIVITY_CHANGE',
        equipmentStatus: 'OFF',
        previousStatus: 'ONLINE',
        isActive: false,
        mode: 'off',
        runtimeSeconds: null,
        temperatureF: backfill?.last_temperature ?? null,
        heatSetpoint: backfill?.last_heat_setpoint ?? null,
        coolSetpoint: backfill?.last_cool_setpoint ?? null,
        observedAt: new Date(nowIso),
        sourceEventId: uuidv4(),
        payloadRaw: { connectivity: 'OFFLINE', reason: 'ecobee_disconnected' }
      });

      console.log(`[${hvac_id}] 🔴 Device went OFFLINE - posting to Core`);
      
      await Promise.allSettled([
        postToCoreIngestAsync(corePayload, "connectivity-offline")
      ]);

      // Update reachability in local state
      await setRuntime(hvac_id, { is_reachable: false });
    }
    
    console.log(`[${hvac_id}] ⚠️ Device unreachable, skipping runtime tracking`);
    return { postedSessionEnd: false };
  }

  // Device is reachable - check if it just came back online
  const prevReachable = rt.is_reachable;
  if (prevReachable === false) {
    // Device just came back online - post connectivity change
    const backfill = await getBackfillState(hvac_id);
    const corePayload = buildCorePayload({
      deviceKey: hvac_id,
      userId: user_id,
      deviceName: normalized.thermostatName || backfill?.device_name || null,
      eventType: 'CONNECTIVITY_CHANGE',
      equipmentStatus: parsed.isCooling ? 'COOLING' : parsed.isHeating ? 'HEATING' : 'OFF',
      previousStatus: 'OFFLINE',
      isActive: isReachable,
      mode: currentMode || 'off',
      runtimeSeconds: null,
      temperatureF: normalized.actualTemperatureF ?? backfill?.last_temperature ?? null,
      heatSetpoint: normalized.desiredHeatF ?? backfill?.last_heat_setpoint ?? null,
      coolSetpoint: normalized.desiredCoolF ?? backfill?.last_cool_setpoint ?? null,
      observedAt: new Date(nowIso),
      sourceEventId: uuidv4(),
      payloadRaw: { connectivity: 'ONLINE', reason: 'ecobee_reconnected' }
    });

    console.log(`[${hvac_id}] 🟢 Device came back ONLINE - posting to Core`);
    
    await Promise.allSettled([
      postToCoreIngestAsync(corePayload, "connectivity-online")
    ]);

    // Update reachability in local state
    await setRuntime(hvac_id, { is_reachable: true });
  }

  // Transition: idle -> running (SESSION START)
  if (!rt.is_running && isRunning) {
    const sessionId = uuidv4();
    
    await setRuntime(hvac_id, {
      is_running: true,
      current_session_started_at: nowIso,
      last_tick_at: nowIso,
      last_running_mode: currentMode,
      last_equipment_status: parsed.raw,
    });

    console.log(`[${hvac_id}] ▶️ session START @ ${nowIso} (mode=${currentMode || "n/a"}, status="${parsed.raw}")`);

    // Post to Core Ingest ONLY - SESSION START (no runtime_seconds)
    const corePayload = buildCorePayload({
      deviceKey: hvac_id,
      userId: user_id,
      deviceName: normalized.thermostatName,
      eventType: `${currentMode?.toUpperCase() || 'UNKNOWN'}_START`,
      equipmentStatus: parsed.isCooling ? 'COOLING' : parsed.isHeating ? 'HEATING' : 'FAN',
      previousStatus: 'OFF',
      isActive: true,
      mode: currentMode,
      runtimeSeconds: null, // ✅ NO runtime on start
      temperatureF: normalized.actualTemperatureF,
      heatSetpoint: normalized.desiredHeatF,
      coolSetpoint: normalized.desiredCoolF,
      observedAt: new Date(nowIso),
      sourceEventId: sessionId,
      payloadRaw: normalized
    });

    // Post to Core only (non-blocking)
    await Promise.allSettled([
      postToCoreIngestAsync(corePayload, "session-start")
    ]);

    return { postedSessionEnd: false };
  }

  // Continuing: running -> running (SESSION TICK)
  if (rt.is_running && isRunning) {
    const lastTick = rt.last_tick_at ? toMillis(rt.last_tick_at) : Date.now();
    const deltaSec = Math.min(
      Math.max(MIN_DELTA_SECONDS, Math.round((Date.now() - lastTick) / MS_TO_SECONDS)),
      MAX_ACCUMULATE_SECONDS
    );
    const newTotal = (rt.current_session_seconds || 0) + deltaSec;

    await setRuntime(hvac_id, {
      current_session_seconds: newTotal,
      last_tick_at: nowIso,
      last_running_mode: currentMode || rt.last_running_mode,
      last_equipment_status: parsed.raw || rt.last_equipment_status,
    });

    console.log(`[${hvac_id}] ⏱️ tick +${deltaSec}s (total=${newTotal}s) mode=${currentMode || rt.last_running_mode || "n/a"} status="${parsed.raw}"`);

    // ✅ DON'T POST TO CORE ON TICKS - just update local state
    return { postedSessionEnd: false };
  }

  // Transition: running -> idle (SESSION END)
  if (rt.is_running && !isRunning) {
    const lastTick = rt.last_tick_at ? toMillis(rt.last_tick_at) : Date.now();
    const deltaSec = Math.min(
      Math.max(MIN_DELTA_SECONDS, Math.round((Date.now() - lastTick) / MS_TO_SECONDS)),
      MAX_ACCUMULATE_SECONDS
    );
    const finalTotal = (rt.current_session_seconds || 0) + deltaSec;

    const lastMode = rt.last_running_mode || currentMode || null;
    const lastIsCooling = lastMode === "cooling";
    const lastIsHeating = lastMode === "heating";
    const lastIsFanOnly = lastMode === "fanonly";
    const lastEquipmentStatus = rt.last_equipment_status || parsed.raw || "";

    // Backfill telemetry from last known state
    const backfill = await getBackfillState(hvac_id);

    const bubblePayload = {
      ...normalized,
      isRunning: false,
      runtimeSeconds: finalTotal, // ✅ Runtime ONLY on END
      lastMode,
      lastIsCooling,
      lastIsHeating,
      lastIsFanOnly,
      lastEquipmentStatus,
      isReachable: (rt?.is_reachable !== undefined ? rt.is_reachable : normalized.isReachable)
    };

    const corePayload = buildCorePayload({
      deviceKey: hvac_id,
      userId: user_id,
      deviceName: normalized.thermostatName,
      eventType: 'STATUS_CHANGE',
      equipmentStatus: 'OFF',
      previousStatus: lastEquipmentStatus,
      isActive: false,
      mode: 'off',
      runtimeSeconds: finalTotal, // ✅ Runtime ONLY on END
      temperatureF: normalized.actualTemperatureF ?? backfill?.last_temperature ?? null,
      heatSetpoint: normalized.desiredHeatF ?? backfill?.last_heat_setpoint ?? null,
      coolSetpoint: normalized.desiredCoolF ?? backfill?.last_cool_setpoint ?? null,
      observedAt: new Date(nowIso),
      sourceEventId: uuidv4(),
      payloadRaw: normalized
    });

    console.log(`[${hvac_id}] ⏹️ session END ${finalTotal}s; lastMode=${lastMode || "n/a"} lastStatus="${lastEquipmentStatus}"`);

    try {
      // Post to BOTH Core and Bubble ONLY on session END
      await Promise.allSettled([
        postToCoreIngestAsync(corePayload, "session-end"),
        postToBubble(bubblePayload, "session-end")
      ]);
      
      await resetRuntime(hvac_id);
      return { postedSessionEnd: true };
    } catch (e) {
      console.error(`[${hvac_id}] ✗ Failed to post session end:`, e.message);
      // Still reset runtime to prevent stale data
      await resetRuntime(hvac_id);
      throw e;
    }
  }

  // idle -> idle (no change)
  return { postedSessionEnd: false };
}
