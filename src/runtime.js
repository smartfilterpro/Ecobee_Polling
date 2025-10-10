import { parseEquipStatus, modeFromParsed, nowUtc, toMillis } from "./util.js";
import { getRuntime, setRuntime, resetRuntime, getBackfillState } from "./db.js";
import { postToBubble } from "./bubble.js";
import { buildCorePayload, postToCoreIngestAsync } from "./coreIngest.js";
import { MAX_ACCUMULATE_SECONDS } from "./config.js";
import { v4 as uuidv4 } from "uuid";

const MIN_DELTA_SECONDS = 0;
const MS_TO_SECONDS = 1000;

/**
 * Handle runtime tracking and post to Core only on START/END/STATE_UPDATE
 * Post to Bubble only on END
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
  const isReachable = normalized.isReachable !== false;

  /* ---------------------- Device Unreachable ---------------------- */
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
      eventType: "OFFLINE_SESSION_END",
      equipmentStatus: "OFF",
      previousStatus: lastEquipmentStatus,
      isActive: false,
      mode: "off",
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

  // Reachability handling
  if (!isReachable) {
    const prevReachable = rt.is_reachable;
    if (prevReachable !== false) {
      const backfill = await getBackfillState(hvac_id);
      const corePayload = buildCorePayload({
        deviceKey: hvac_id,
        userId: user_id,
        deviceName: normalized.thermostatName || backfill?.device_name || null,
        eventType: "CONNECTIVITY_CHANGE",
        equipmentStatus: "OFF",
        previousStatus: "ONLINE",
        isActive: false,
        mode: "off",
        runtimeSeconds: null,
        temperatureF: backfill?.last_temperature ?? null,
        heatSetpoint: backfill?.last_heat_setpoint ?? null,
        coolSetpoint: backfill?.last_cool_setpoint ?? null,
        observedAt: new Date(nowIso),
        sourceEventId: uuidv4(),
        payloadRaw: { connectivity: "OFFLINE", reason: "ecobee_disconnected" }
      });
      console.log(`[${hvac_id}] 🔴 Device went OFFLINE - posting to Core`);
      await postToCoreIngestAsync(corePayload, "connectivity-offline");
      await setRuntime(hvac_id, { is_reachable: false });
    }
    console.log(`[${hvac_id}] ⚠️ Device unreachable, skipping runtime tracking`);
    return { postedSessionEnd: false };
  }

  const prevReachable = rt.is_reachable;
  if (prevReachable === false) {
    const backfill = await getBackfillState(hvac_id);
    const corePayload = buildCorePayload({
      deviceKey: hvac_id,
      userId: user_id,
      deviceName: normalized.thermostatName || backfill?.device_name || null,
      eventType: "CONNECTIVITY_CHANGE",
      equipmentStatus: parsed.isCooling ? "COOLING" : parsed.isHeating ? "HEATING" : "OFF",
      previousStatus: "OFFLINE",
      isActive: isReachable,
      mode: currentMode || "off",
      runtimeSeconds: null,
      temperatureF: normalized.actualTemperatureF ?? backfill?.last_temperature ?? null,
      heatSetpoint: normalized.desiredHeatF ?? backfill?.last_heat_setpoint ?? null,
      coolSetpoint: normalized.desiredCoolF ?? backfill?.last_cool_setpoint ?? null,
      observedAt: new Date(nowIso),
      sourceEventId: uuidv4(),
      payloadRaw: { connectivity: "ONLINE", reason: "ecobee_reconnected" }
    });

    console.log(`[${hvac_id}] 🟢 Device came back ONLINE - posting to Core`);
    await postToCoreIngestAsync(corePayload, "connectivity-online");
    await setRuntime(hvac_id, { is_reachable: true });
  }

  /* ---------------------- SESSION START ---------------------- */
  if (!rt.is_running && isRunning) {
    const sessionId = uuidv4();
    await setRuntime(hvac_id, {
      is_running: true,
      current_session_started_at: nowIso,
      last_tick_at: nowIso,
      last_running_mode: currentMode,
      last_equipment_status: parsed.raw
    });

    console.log(`[${hvac_id}] ▶️ session START @ ${nowIso} (mode=${currentMode || "n/a"}, status="${parsed.raw}")`);

    const corePayload = buildCorePayload({
      deviceKey: hvac_id,
      userId: user_id,
      deviceName: normalized.thermostatName,
      eventType: `${currentMode?.toUpperCase() || "UNKNOWN"}_START`,
      equipmentStatus: parsed.isCooling ? "COOLING" : parsed.isHeating ? "HEATING" : "FAN",
      previousStatus: "OFF",
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

    await postToCoreIngestAsync(corePayload, "session-start");
    return { postedSessionEnd: false };
  }

  /* ---------------------- SESSION TICK ---------------------- */
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
      last_equipment_status: parsed.raw || rt.last_equipment_status
    });

    console.log(`[${hvac_id}] ⏱️ tick +${deltaSec}s (total=${newTotal}s) mode=${currentMode || "n/a"} status="${parsed.raw}"`);
    return { postedSessionEnd: false };
  }

  /* ---------------------- SESSION END ---------------------- */
  if (rt.is_running && !isRunning) {
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
      isReachable: rt?.is_reachable !== undefined ? rt.is_reachable : normalized.isReachable
    };

    const corePayload = buildCorePayload({
      deviceKey: hvac_id,
      userId: user_id,
      deviceName: normalized.thermostatName,
      eventType: "STATUS_CHANGE",
      equipmentStatus: "OFF",
      previousStatus: lastEquipmentStatus,
      isActive: false,
      mode: "off",
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
      await Promise.allSettled([
        postToCoreIngestAsync(corePayload, "session-end"),
        postToBubble(bubblePayload, "session-end")
      ]);
      await resetRuntime(hvac_id);
      return { postedSessionEnd: true };
    } catch (e) {
      console.error(`[${hvac_id}] ✗ Failed to post session end:`, e.message);
      await resetRuntime(hvac_id);
      throw e;
    }
  }

  /* ---------------------- IDLE STATE UPDATE ---------------------- */
  if (!rt.is_running && !isRunning && isReachable && normalized.actualTemperatureF != null) {
    const backfill = await getBackfillState(hvac_id);

    const prevTemp = backfill?.last_temperature ?? null;
    const prevHum = backfill?.last_humidity ?? null;

    const tempChanged = prevTemp == null || Math.abs(normalized.actualTemperatureF - prevTemp) >= 0.5;
    const humidityChanged = prevHum == null || Math.abs((normalized.humidity ?? 0) - (prevHum ?? 0)) >= 2;

    if (tempChanged || humidityChanged) {
      const corePayload = buildCorePayload({
        deviceKey: hvac_id,
        userId: user_id,
        deviceName: normalized.thermostatName,
        eventType: "STATE_UPDATE",
        equipmentStatus: "OFF",
        previousStatus: "OFF",
        isActive: false,
        mode: "off",
        runtimeSeconds: null,
        temperatureF: normalized.actualTemperatureF ?? null,
        heatSetpoint: normalized.desiredHeatF ?? backfill?.last_heat_setpoint ?? null,
        coolSetpoint: normalized.desiredCoolF ?? backfill?.last_cool_setpoint ?? null,
        observedAt: new Date(nowIso),
        sourceEventId: uuidv4(),
        payloadRaw: normalized
      });

      console.log(
        `[${hvac_id}] 🌡️ STATE_UPDATE (idle) temp=${normalized.actualTemperatureF}F humidity=${normalized.humidity ?? "—"}`
      );

      await postToCoreIngestAsync(corePayload, "state-update");
    }
  }

  return { postedSessionEnd: false };
}
