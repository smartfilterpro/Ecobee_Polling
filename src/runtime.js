'use strict';

import { v4 as uuidv4 } from 'uuid';
import { parseEquipStatus, modeFromParsed, nowUtc, toMillis } from './util.js';
import { getRuntime, setRuntime, resetRuntime, getBackfillState } from './db.js';
import { buildCorePayload, postToCoreIngestAsync } from './coreIngest.js';
import { MAX_ACCUMULATE_SECONDS } from './config.js';

const MIN_DELTA_SECONDS = 0;
const MS_TO_SECONDS = 1000;

/**
 * Tracks runtime sessions, reachability, and state updates.
 * Posts ONLY to Core Ingest using standardized state classifications.
 */
export async function handleRuntimeAndMaybePost({ user_id, hvac_id }, normalized) {
  const nowIso = nowUtc();
  const parsed = parseEquipStatus(normalized.equipmentStatus);
  const currentMode = modeFromParsed(parsed);
  const standardizedState = parsed.standardizedState || "Fan_off";

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

  // Get backfill for sticky outdoor data
  const backfill = await getBackfillState(hvac_id);

  /* -------------------------------------------------------------------------- */
  /*                      DEVICE UNREACHABLE (OFFLINE HANDLING)                 */
  /* -------------------------------------------------------------------------- */
  if (!isReachable) {
    // Prevent repeated offline posts
    if (rt.is_reachable === false) {
      console.log(`[${hvac_id}] ⚠️ Still offline — skipping all posts`);
      return { postedSessionEnd: false };
    }

    // End any active session first
    if (rt.is_running) {
      const lastTick = rt.last_tick_at ? toMillis(rt.last_tick_at) : Date.now();
      const deltaSec = Math.min(
        Math.max(MIN_DELTA_SECONDS, Math.round((Date.now() - lastTick) / MS_TO_SECONDS)),
        MAX_ACCUMULATE_SECONDS
      );
      const finalTotal = (rt.current_session_seconds || 0) + deltaSec;

      const lastMode = rt.last_running_mode || currentMode || null;
      const lastEquipmentStatus = rt.last_equipment_status || standardizedState;

      const corePayload = buildCorePayload({
        deviceKey: hvac_id,
        userId: user_id,
        deviceName: normalized.thermostatName,
        firmwareVersion: normalized.firmwareVersion,
        serialNumber: normalized.serialNumber,
        eventType: 'OFFLINE_SESSION_END',
        equipmentStatus: 'Fan_off',
        previousStatus: lastEquipmentStatus,
        isActive: false,
        mode: 'off',
        runtimeSeconds: finalTotal,
        temperatureF: normalized.actualTemperatureF ?? backfill?.last_temperature ?? null,
        humidity: normalized.humidity ?? backfill?.last_humidity ?? null,
        heatSetpoint: normalized.desiredHeatF ?? backfill?.last_heat_setpoint ?? null,
        coolSetpoint: normalized.desiredCoolF ?? backfill?.last_cool_setpoint ?? null,
        thermostatMode: normalized.hvacMode ?? backfill?.thermostat_mode ?? null,
        outdoorTemperatureF: normalized.outdoorTemperatureF ?? backfill?.outdoor_temperature_f ?? null,
        outdoorHumidity: normalized.outdoorHumidity ?? backfill?.outdoor_humidity ?? null,
        pressureHpa: normalized.pressureHpa ?? backfill?.pressure_hpa ?? null,
        observedAt: new Date(nowIso),
        sourceEventId: uuidv4(),
        payloadRaw: normalized,
      });

      console.log(`[${hvac_id}] 📴 OFFLINE - ending session ${finalTotal}s; lastMode=${lastMode || 'n/a'}`);

      try {
        await postToCoreIngestAsync(corePayload, 'offline-session-end');
        await resetRuntime(hvac_id);
      } catch (e) {
        console.error(`[${hvac_id}] ✗ Failed to post offline session end:`, e.message);
        await resetRuntime(hvac_id);
      }
    }

    // Post connectivity offline once
    const corePayload = buildCorePayload({
      deviceKey: hvac_id,
      userId: user_id,
      deviceName: normalized.thermostatName || backfill?.device_name || null,
      firmwareVersion: normalized.firmwareVersion || backfill?.firmware_version || null,
      serialNumber: normalized.serialNumber || backfill?.serial_number || null,
      eventType: 'CONNECTIVITY_CHANGE',
      equipmentStatus: 'Fan_off',
      previousStatus: 'ONLINE',
      isActive: false,
      mode: 'off',
      runtimeSeconds: null,
      temperatureF: backfill?.last_temperature ?? null,
      humidity: backfill?.last_humidity ?? null,
      heatSetpoint: backfill?.last_heat_setpoint ?? null,
      coolSetpoint: backfill?.last_cool_setpoint ?? null,
      thermostatMode: backfill?.thermostat_mode ?? null,
      outdoorTemperatureF: backfill?.outdoor_temperature_f ?? null,
      outdoorHumidity: backfill?.outdoor_humidity ?? null,
      pressureHpa: backfill?.pressure_hpa ?? null,
      observedAt: new Date(nowIso),
      sourceEventId: uuidv4(),
      payloadRaw: { connectivity: 'OFFLINE', reason: 'ecobee_disconnected' },
    });

    console.log(`[${hvac_id}] 🔴 Device went OFFLINE - posting once to Core`);
    await postToCoreIngestAsync(corePayload, 'connectivity-offline');

    // Persist flag so next cycles know it's offline
    await setRuntime(hvac_id, { is_reachable: false });
    console.log(`[${hvac_id}] 🚫 Marked as offline — will not post again until online`);
    return { postedSessionEnd: false };
  }

  /* -------------------------------------------------------------------------- */
  /*                      DEVICE ONLINE (RECOVERY HANDLING)                     */
  /* -------------------------------------------------------------------------- */
  if (rt.is_reachable === false && isReachable) {
    const corePayload = buildCorePayload({
      deviceKey: hvac_id,
      userId: user_id,
      deviceName: normalized.thermostatName || backfill?.device_name || null,
      firmwareVersion: normalized.firmwareVersion || backfill?.firmware_version || null,
      serialNumber: normalized.serialNumber || backfill?.serial_number || null,
      eventType: 'CONNECTIVITY_CHANGE',
      equipmentStatus: standardizedState,
      previousStatus: 'OFFLINE',
      isActive: true,
      mode: currentMode || 'off',
      runtimeSeconds: null,
      temperatureF: normalized.actualTemperatureF ?? backfill?.last_temperature ?? null,
      humidity: normalized.humidity ?? backfill?.last_humidity ?? null,
      heatSetpoint: normalized.desiredHeatF ?? backfill?.last_heat_setpoint ?? null,
      coolSetpoint: normalized.desiredCoolF ?? backfill?.last_cool_setpoint ?? null,
      thermostatMode: normalized.hvacMode ?? backfill?.thermostat_mode ?? null,
      outdoorTemperatureF: normalized.outdoorTemperatureF ?? backfill?.outdoor_temperature_f ?? null,
      outdoorHumidity: normalized.outdoorHumidity ?? backfill?.outdoor_humidity ?? null,
      pressureHpa: normalized.pressureHpa ?? backfill?.pressure_hpa ?? null,
      observedAt: new Date(nowIso),
      sourceEventId: uuidv4(),
      payloadRaw: { connectivity: 'ONLINE', reason: 'ecobee_reconnected' },
    });

    console.log(`[${hvac_id}] 🟢 Device came back ONLINE - posting to Core`);
    await postToCoreIngestAsync(corePayload, 'connectivity-online');
    await setRuntime(hvac_id, { is_reachable: true });
  }

  /* -------------------------------------------------------------------------- */
  /*                              SESSION START                                 */
  /* -------------------------------------------------------------------------- */
  if (!rt.is_running && isRunning) {
    const sessionId = uuidv4();
    await setRuntime(hvac_id, {
      is_running: true,
      current_session_started_at: nowIso,
      last_tick_at: nowIso,
      last_running_mode: currentMode,
      last_equipment_status: standardizedState,
      is_reachable: true,
    });

    console.log(`[${hvac_id}] ▶️ session START @ ${nowIso} (mode=${currentMode || 'n/a'}, status="${standardizedState}")`);

    const corePayload = buildCorePayload({
      deviceKey: hvac_id,
      userId: user_id,
      deviceName: normalized.thermostatName,
      firmwareVersion: normalized.firmwareVersion,
      serialNumber: normalized.serialNumber,
      eventType: `${currentMode?.toUpperCase() || 'UNKNOWN'}_START`,
      equipmentStatus: standardizedState,
      previousStatus: 'Fan_off',
      isActive: true,
      mode: currentMode,
      runtimeSeconds: null,
      temperatureF: normalized.actualTemperatureF,
      humidity: normalized.humidity,
      heatSetpoint: normalized.desiredHeatF,
      coolSetpoint: normalized.desiredCoolF,
      thermostatMode: normalized.hvacMode,
      outdoorTemperatureF: normalized.outdoorTemperatureF ?? backfill?.outdoor_temperature_f ?? null,
      outdoorHumidity: normalized.outdoorHumidity ?? backfill?.outdoor_humidity ?? null,
      pressureHpa: normalized.pressureHpa ?? backfill?.pressure_hpa ?? null,
      observedAt: new Date(nowIso),
      sourceEventId: sessionId,
      payloadRaw: normalized,
    });

    await postToCoreIngestAsync(corePayload, 'session-start');
    return { postedSessionEnd: false };
  }

  /* -------------------------------------------------------------------------- */
  /*                              SESSION TICK                                  */
  /* -------------------------------------------------------------------------- */
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
      last_equipment_status: standardizedState || rt.last_equipment_status,
    });

    console.log(`[${hvac_id}] ⏱️ tick +${deltaSec}s (total=${newTotal}s) mode=${currentMode || 'n/a'} status="${standardizedState}"`);
    return { postedSessionEnd: false };
  }

  /* -------------------------------------------------------------------------- */
  /*                              SESSION END                                   */
  /* -------------------------------------------------------------------------- */
  if (rt.is_running && !isRunning) {
    const lastTick = rt.last_tick_at ? toMillis(rt.last_tick_at) : Date.now();
    const deltaSec = Math.min(
      Math.max(MIN_DELTA_SECONDS, Math.round((Date.now() - lastTick) / MS_TO_SECONDS)),
      MAX_ACCUMULATE_SECONDS
    );
    const finalTotal = (rt.current_session_seconds || 0) + deltaSec;

    const lastMode = rt.last_running_mode || currentMode || null;
    const lastEquipmentStatus = rt.last_equipment_status || standardizedState;

    const corePayload = buildCorePayload({
      deviceKey: hvac_id,
      userId: user_id,
      deviceName: normalized.thermostatName,
      firmwareVersion: normalized.firmwareVersion,
      serialNumber: normalized.serialNumber,
      eventType: 'STATUS_CHANGE',
      equipmentStatus: 'Fan_off',
      previousStatus: lastEquipmentStatus,
      isActive: false,
      mode: 'off',
      runtimeSeconds: finalTotal,
      temperatureF: normalized.actualTemperatureF ?? backfill?.last_temperature ?? null,
      humidity: normalized.humidity ?? backfill?.last_humidity ?? null,
      heatSetpoint: normalized.desiredHeatF ?? backfill?.last_heat_setpoint ?? null,
      coolSetpoint: normalized.desiredCoolF ?? backfill?.last_cool_setpoint ?? null,
      thermostatMode: normalized.hvacMode ?? backfill?.thermostat_mode ?? null,
      outdoorTemperatureF: normalized.outdoorTemperatureF ?? backfill?.outdoor_temperature_f ?? null,
      outdoorHumidity: normalized.outdoorHumidity ?? backfill?.outdoor_humidity ?? null,
      pressureHpa: normalized.pressureHpa ?? backfill?.pressure_hpa ?? null,
      observedAt: new Date(nowIso),
      sourceEventId: uuidv4(),
      payloadRaw: normalized,
    });

    console.log(`[${hvac_id}] ⏹️ session END ${finalTotal}s; lastMode=${lastMode || 'n/a'} lastStatus="${lastEquipmentStatus}"`);

    try {
      await postToCoreIngestAsync(corePayload, 'session-end');
      await resetRuntime(hvac_id);
      return { postedSessionEnd: true };
    } catch (e) {
      console.error(`[${hvac_id}] ✗ Failed to post session end:`, e.message);
      await resetRuntime(hvac_id);
      throw e;
    }
  }

  /* -------------------------------------------------------------------------- */
  /*                              IDLE STATE UPDATE                             */
  /* -------------------------------------------------------------------------- */
  if (!rt.is_running && !isRunning && isReachable && normalized.actualTemperatureF != null) {
    const prevTemp = backfill?.last_temperature ?? null;
    const prevHum = backfill?.last_humidity ?? null;

    const tempChanged = prevTemp == null || Math.abs(normalized.actualTemperatureF - prevTemp) >= 0.5;
    const humidityChanged = prevHum == null || Math.abs((normalized.humidity ?? 0) - (prevHum ?? 0)) >= 2;

    if (tempChanged || humidityChanged) {
      const corePayload = buildCorePayload({
        deviceKey: hvac_id,
        userId: user_id,
        deviceName: normalized.thermostatName,
        firmwareVersion: normalized.firmwareVersion,
        serialNumber: normalized.serialNumber,
        eventType: 'STATE_UPDATE',
        equipmentStatus: 'Fan_off',
        previousStatus: 'Fan_off',
        isActive: false,
        mode: 'off',
        runtimeSeconds: null,
        temperatureF: normalized.actualTemperatureF ?? null,
        humidity: normalized.humidity ?? null,
        heatSetpoint: normalized.desiredHeatF ?? backfill?.last_heat_setpoint ?? null,
        coolSetpoint: normalized.desiredCoolF ?? backfill?.last_cool_setpoint ?? null,
        thermostatMode: normalized.hvacMode ?? backfill?.thermostat_mode ?? null,
        outdoorTemperatureF: normalized.outdoorTemperatureF ?? backfill?.outdoor_temperature_f ?? null,
        outdoorHumidity: normalized.outdoorHumidity ?? backfill?.outdoor_humidity ?? null,
        pressureHpa: normalized.pressureHpa ?? backfill?.pressure_hpa ?? null,
        observedAt: new Date(nowIso),
        sourceEventId: uuidv4(),
        payloadRaw: normalized,
      });

      console.log(
        `[${hvac_id}] 🌡️ STATE_UPDATE (idle) temp=${normalized.actualTemperatureF}F humidity=${normalized.humidity ?? '—'}`
      );

      await postToCoreIngestAsync(corePayload, 'state-update');
    }
  }

  return { postedSessionEnd: false };
}
