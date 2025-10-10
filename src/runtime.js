import { parseEquipStatus, modeFromParsed, nowUtc, toMillis } from "./util.js";
import { getRuntime, setRuntime, resetRuntime, getBackfillState } from "./db.js";
import { postToBubble } from "./bubble.js";
import { buildCorePayload, postToCoreIngestAsync } from "./coreIngest.js";
import { MAX_ACCUMULATE_SECONDS } from "./config.js";
import { v4 as uuidv4 } from "uuid";

const MIN_DELTA_SECONDS = 0;
const MS_TO_SECONDS = 1000;

/**
 * Handle runtime tracking and post session-end events when appropriate
 * Now posts to BOTH Core Ingest AND Bubble
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

    // Post to Core Ingest - SESSION START
    const corePayload = buildCorePayload({
      deviceKey: hvac_id,
      userId: user_id,
      deviceName: normalized.thermostatName,
      eventType: `${parsed.raw.toUpperCase()}_ON`,
      equipmentStatus: parsed.isCooling ? 'COOLING' : parsed.isHeating ? 'HEATING' : 'FAN',
      previousStatus: 'OFF',
      isActive: true,
      mode: currentMode,
      runtimeSeconds: null,
      temperatureF: normalized.actualTemperatureF,
      heatSetpoint: normalized.desiredHeatF,
      coolSetpoint: normalized.desiredCoolF,
      observedAt: new Date(nowIso),
      sourceEventId: sessionId,
      payloadRaw: normalized
    });

    // Post to Core (non-blocking)
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

    // Post to Core Ingest - SESSION TICK
    const corePayload = buildCorePayload({
      deviceKey: hvac_id,
      userId: user_id,
      deviceName: normalized.thermostatName,
      eventType: 'STATUS_UPDATE',
      equipmentStatus: parsed.isCooling ? 'COOLING' : parsed.isHeating ? 'HEATING' : 'FAN',
      previousStatus: rt.last_equipment_status || 'UNKNOWN',
      isActive: true,
      mode: currentMode || rt.last_running_mode,
      runtimeSeconds: newTotal,
      temperatureF: normalized.actualTemperatureF,
      heatSetpoint: normalized.desiredHeatF,
      coolSetpoint: normalized.desiredCoolF,
      observedAt: new Date(nowIso),
      sourceEventId: uuidv4(),
      payloadRaw: normalized
    });

    await Promise.allSettled([
      postToCoreIngestAsync(corePayload, "session-tick")
    ]);

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
      runtimeSeconds: finalTotal,
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
      runtimeSeconds: finalTotal,
      temperatureF: normalized.actualTemperatureF ?? backfill?.last_temperature ?? null,
      heatSetpoint: normalized.desiredHeatF ?? backfill?.last_heat_setpoint ?? null,
      coolSetpoint: normalized.desiredCoolF ?? backfill?.last_cool_setpoint ?? null,
      observedAt: new Date(nowIso),
      sourceEventId: uuidv4(),
      payloadRaw: normalized
    });

    console.log(`[${hvac_id}] ⏹️ session END ${finalTotal}s; lastMode=${lastMode || "n/a"} lastStatus="${lastEquipmentStatus}"`);

    try {
      // Post to BOTH Core and Bubble
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
