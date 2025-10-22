'use strict';

import { v4 as uuidv4 } from 'uuid';
import { nowUtc, toMillis } from './util.js';
import { getRuntime, setRuntime, resetRuntime, getBackfillState } from './db.js';
import { buildCorePayload, postToCoreIngestAsync } from './coreIngest.js';
import { MAX_ACCUMULATE_SECONDS } from './config.js';

const MIN_DELTA_SECONDS = 0;
const MS_TO_SECONDS = 1000;

/**
 * Parse Ecobee equipmentStatus string into 8-state classification
 * 
 * Ecobee explicitly states fan presence via ",fan" in status
 * Examples:
 *   "" → Idle
 *   "heat" → Heating
 *   "heat,fan" → Heating_Fan
 *   "compCool1,fan" → Cooling_Fan
 *   "auxHeat1,fan" → AuxHeat_Fan
 *   "fan" → Fan_only
 */
function parseEcobeeEquipmentStatus(equipmentStatus) {
  const status = (equipmentStatus || '').toLowerCase().trim();
  
  if (!status) {
    return {
      eventType: 'Idle',
      equipmentStatus: 'IDLE',
      isActive: false,
      mode: 'off'
    };
  }

  const parts = status.split(',').map(s => s.trim());
  const hasFan = parts.includes('fan');
  
  // Check for heating modes (heat, heat2, heat3, heatPump, heatPump2, heatPump3)
  const hasHeat = parts.some(p => 
    p === 'heat' || p.startsWith('heat') || 
    p === 'heatpump' || p.startsWith('heatpump')
  );
  
  // Check for auxiliary heat (auxHeat1, auxHeat2, auxHeat3, auxHeat, emergency)
  const hasAuxHeat = parts.some(p => 
    p.startsWith('auxheat') || p === 'auxheat' || p === 'emergency'
  );
  
  // Check for cooling modes (cool, cool2, compCool1, compCool2, etc.)
  const hasCool = parts.some(p => 
    p === 'cool' || p.startsWith('cool') || p.startsWith('compcool')
  );
  
  // Auxiliary heat (emergency/backup heat)
  if (hasAuxHeat) {
    if (hasFan) {
      return { eventType: 'AuxHeat_Fan', equipmentStatus: 'AUX_HEATING', isActive: true, mode: 'auxheat' };
    } else {
      return { eventType: 'AuxHeat', equipmentStatus: 'AUX_HEATING', isActive: true, mode: 'auxheat' };
    }
  }
  
  // Heating (furnace or heat pump)
  if (hasHeat) {
    if (hasFan) {
      return { eventType: 'Heating_Fan', equipmentStatus: 'HEATING', isActive: true, mode: 'heating' };
    } else {
      return { eventType: 'Heating', equipmentStatus: 'HEATING', isActive: true, mode: 'heating' };
    }
  }
  
  // Cooling
  if (hasCool) {
    if (hasFan) {
      return { eventType: 'Cooling_Fan', equipmentStatus: 'COOLING', isActive: true, mode: 'cooling' };
    } else {
      return { eventType: 'Cooling', equipmentStatus: 'COOLING', isActive: true, mode: 'cooling' };
    }
  }
  
  // Fan only (no heating or cooling)
  if (hasFan) {
    return { eventType: 'Fan_only', equipmentStatus: 'FAN', isActive: true, mode: 'fan' };
  }
  
  // Accessories only (ventilator, humidifier, dehumidifier) - treat as idle
  return { eventType: 'Idle', equipmentStatus: 'IDLE', isActive: false, mode: 'off' };
}

/**
 * Tracks runtime sessions for Ecobee thermostats (polled data)
 * Posts ONLY to Core Ingest using 8-state classifications
 */
export async function handleRuntimeAndMaybePost({ user_id, hvac_id }, normalized) {
  const nowIso = nowUtc();
  const nowMs = Date.now();
  
  const parsed = parseEcobeeEquipmentStatus(normalized.equipmentStatus);
  const { eventType, equipmentStatus, isActive, mode } = parsed;

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
      last_posted_temp: null,
      last_posted_humidity: null,
      last_posted_heat_setpoint: null,
      last_posted_cool_setpoint: null,
    });
    rt = await getRuntime(hvac_id);
  }

  const isReachable = normalized.isReachable !== false;
  const wasActive = rt.is_running;
  const prevEventType = rt.last_event_type || 'Idle';
  const prevEquipmentStatus = rt.last_equipment_status || 'IDLE';
  const equipmentModeChanged = wasActive && (eventType !== prevEventType);

  // Get backfill for sticky outdoor data
  const backfill = await getBackfillState(hvac_id);

  console.log(`[${hvac_id}] Status: "${normalized.equipmentStatus}" → ${eventType} (prev: ${prevEventType}) active=${isActive} wasActive=${wasActive} modeChanged=${equipmentModeChanged} prevEquipStatus=${prevEquipmentStatus}`);

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
    if (wasActive) {
      const lastTick = rt.last_tick_at ? toMillis(rt.last_tick_at) : nowMs;
      const deltaSec = Math.min(
        Math.max(MIN_DELTA_SECONDS, Math.round((nowMs - lastTick) / MS_TO_SECONDS)),
        MAX_ACCUMULATE_SECONDS
      );
      const finalTotal = (rt.current_session_seconds || 0) + deltaSec;

      const corePayload = buildCorePayload({
        deviceKey: hvac_id,
        userId: user_id,
        deviceName: normalized.thermostatName,
        firmwareVersion: normalized.firmwareVersion,
        serialNumber: normalized.serialNumber,
        eventType: 'Mode_Change',
        equipmentStatus: 'IDLE',
        previousStatus: prevEquipmentStatus,
        isActive: false,
        isReachable: false,
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

      console.log(`[${hvac_id}] 📴 OFFLINE - ending session ${finalTotal}s; mode=${mode}`);
      await postToCoreIngestAsync(corePayload, 'offline-session-end');
      await resetRuntime(hvac_id);
    }

    // Post connectivity offline ONCE
    const corePayload = buildCorePayload({
      deviceKey: hvac_id,
      userId: user_id,
      deviceName: normalized.thermostatName || backfill?.device_name || null,
      firmwareVersion: normalized.firmwareVersion || backfill?.firmware_version || null,
      serialNumber: normalized.serialNumber || backfill?.serial_number || null,
      eventType: 'Connectivity_Change',
      equipmentStatus: 'IDLE',
      previousStatus: 'ONLINE',
      isActive: false,
      isReachable: false,
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
    await setRuntime(hvac_id, { is_reachable: false, last_seen_at: nowIso });
    
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
      eventType: 'Connectivity_Change',
      equipmentStatus: equipmentStatus,
      previousStatus: 'OFFLINE',
      isActive: isActive,
      isReachable: true,
      mode: mode,
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
    await setRuntime(hvac_id, { is_reachable: true, last_seen_at: nowIso });
  }

  // Update last seen
  await setRuntime(hvac_id, { last_seen_at: nowIso });

  /* -------------------------------------------------------------------------- */
  /*                              SESSION START                                 */
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
      last_equipment_status: equipmentStatus,
      is_reachable: true,
    });

    console.log(`[${hvac_id}] ▶️ SESSION START: ${eventType} (mode=${mode})`);

    const corePayload = buildCorePayload({
      deviceKey: hvac_id,
      userId: user_id,
      deviceName: normalized.thermostatName,
      firmwareVersion: normalized.firmwareVersion,
      serialNumber: normalized.serialNumber,
      eventType: 'Mode_Change',
      equipmentStatus: eventType,  // ✅ Use full classification (e.g., "Cooling_Fan")
      previousStatus: prevEventType,
      isActive: true,
      isReachable: true,
      mode: mode,
      runtimeSeconds: undefined,
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
  /*                              SESSION TICK / MODE SWITCH                    */
  /* -------------------------------------------------------------------------- */
  if (wasActive && isActive) {
    const lastTick = rt.last_tick_at ? toMillis(rt.last_tick_at) : nowMs;
    const deltaSec = Math.min(
      Math.max(MIN_DELTA_SECONDS, Math.round((nowMs - lastTick) / MS_TO_SECONDS)),
      MAX_ACCUMULATE_SECONDS
    );
    const newTotal = (rt.current_session_seconds || 0) + deltaSec;

    if (equipmentModeChanged) {
      // MODE SWITCH - Equipment changed state (e.g., Heating_Fan → Cooling_Fan)
      console.log(`[${hvac_id}] 🔄 MODE SWITCH: ${prevEventType} → ${eventType} (runtime=${newTotal}s)`);

      const corePayload = buildCorePayload({
        deviceKey: hvac_id,
        userId: user_id,
        deviceName: normalized.thermostatName,
        firmwareVersion: normalized.firmwareVersion,
        serialNumber: normalized.serialNumber,
        eventType: 'Mode_Change',
        equipmentStatus: eventType,  // ✅ Use full classification
        previousStatus: prevEventType,
        isActive: true,
        isReachable: true,
        mode: mode,
        runtimeSeconds: newTotal,
        temperatureF: normalized.actualTemperatureF,
        humidity: normalized.humidity,
        heatSetpoint: normalized.desiredHeatF,
        coolSetpoint: normalized.desiredCoolF,
        thermostatMode: normalized.hvacMode,
        outdoorTemperatureF: normalized.outdoorTemperatureF ?? backfill?.outdoor_temperature_f ?? null,
        outdoorHumidity: normalized.outdoorHumidity ?? backfill?.outdoor_humidity ?? null,
        pressureHpa: normalized.pressureHpa ?? backfill?.pressure_hpa ?? null,
        observedAt: new Date(nowIso),
        sourceEventId: uuidv4(),
        payloadRaw: normalized,
      });

      await postToCoreIngestAsync(corePayload, 'mode-switch');

      // Reset session for new mode
      await setRuntime(hvac_id, {
        current_session_seconds: 0,
        current_session_started_at: nowIso,
        last_tick_at: nowIso,
        last_running_mode: mode,
        last_event_type: eventType,
        last_equipment_status: equipmentStatus,
      });
    } else {
      // Just accumulate runtime
      await setRuntime(hvac_id, {
        current_session_seconds: newTotal,
        last_tick_at: nowIso,
      });

      console.log(`[${hvac_id}] ⏱️ TICK +${deltaSec}s (total=${newTotal}s) ${eventType}`);
    }

    return { postedSessionEnd: false };
  }

  /* -------------------------------------------------------------------------- */
  /*                              SESSION END                                   */
  /* -------------------------------------------------------------------------- */
  if (wasActive && !isActive) {
    const lastTick = rt.last_tick_at ? toMillis(rt.last_tick_at) : nowMs;
    const deltaSec = Math.min(
      Math.max(MIN_DELTA_SECONDS, Math.round((nowMs - lastTick) / MS_TO_SECONDS)),
      MAX_ACCUMULATE_SECONDS
    );
    const finalTotal = (rt.current_session_seconds || 0) + deltaSec;

    console.log(`[${hvac_id}] ⏹️ SESSION END: ${prevEventType} → ${eventType} (runtime=${finalTotal}s)`);

    const corePayload = buildCorePayload({
      deviceKey: hvac_id,
      userId: user_id,
      deviceName: normalized.thermostatName,
      firmwareVersion: normalized.firmwareVersion,
      serialNumber: normalized.serialNumber,
      eventType: 'Mode_Change',
      equipmentStatus: 'IDLE',
      previousStatus: prevEquipmentStatus,
      isActive: false,
      isReachable: true,
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

    await postToCoreIngestAsync(corePayload, 'session-end');
    await resetRuntime(hvac_id);
    return { postedSessionEnd: true };
  }

  /* -------------------------------------------------------------------------- */
  /*                              IDLE TELEMETRY UPDATE                         */
  /* -------------------------------------------------------------------------- */
  if (!wasActive && !isActive && isReachable && normalized.actualTemperatureF != null) {
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
        eventType: 'Telemetry_Update',
        equipmentStatus: 'IDLE',
        previousStatus: 'IDLE',
        isActive: false,
        isReachable: true,
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

      console.log(`[${hvac_id}] 🌡️ TELEMETRY_UPDATE (idle) temp=${normalized.actualTemperatureF}F humidity=${normalized.humidity ?? '—'}`);
      await postToCoreIngestAsync(corePayload, 'telemetry-update');
    }
  }

  return { postedSessionEnd: false };
}
