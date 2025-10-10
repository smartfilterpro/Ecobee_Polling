import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { CORE_INGEST_URL, CORE_POST_RETRIES, CORE_POST_RETRY_DELAY_MS } from "./config.js";
import { nowUtc, sleep } from "./util.js";

/**
 * Build Core Ingest payload matching Nest pattern
 */
export function buildCorePayload({
  deviceKey,
  userId,
  deviceName,
  // Ecobee-specific metadata
  manufacturer = 'Ecobee',
  model = 'Ecobee Thermostat',
  connectionSource = 'ecobee',
  source = 'ecobee',
  sourceVendor = 'ecobee',
  workspaceId = userId,
  deviceType = 'thermostat',
  firmwareVersion = null,
  serialNumber = null,
  timezone = null,
  zipPrefix = null,
  
  // Runtime state
  eventType,              // e.g., COOLING_ON, HEATING_ON, STATUS_CHANGE, FAN_ON
  equipmentStatus,        // HEATING/COOLING/OFF/FAN
  previousStatus,         // previous equipment status
  isActive,               // boolean
  mode,                   // 'heating' | 'cooling' | 'fanonly' | 'off'
  runtimeSeconds,         // integer or null
  
  // Telemetry
  temperatureF,           // number or null
  humidity = null,        // Ecobee doesn't provide this in basic API
  heatSetpoint,           // number or null
  coolSetpoint,           // number or null
  
  // Metadata
  observedAt,             // JS Date
  sourceEventId,          // stable session ID
  payloadRaw              // raw event for traceability
}) {
  const temperatureC = typeof temperatureF === 'number'
    ? Math.round(((temperatureF - 32) * 5 / 9) * 100) / 100
    : null;

  const isoNow = (observedAt || new Date()).toISOString();

  // ✅ Dynamically derive reachability instead of hardcoding true
  let isReachable = true;
  if (payloadRaw?.connectivity === 'OFFLINE' || payloadRaw?.isReachable === false) {
    isReachable = false;
  }

  return {
    // Identity
    device_key: deviceKey,
    device_id: deviceKey, // Ecobee uses identifier as device_id
    user_id: userId || null,
    workspace_id: workspaceId || userId || null,
    device_name: deviceName || 'Ecobee Thermostat',
    manufacturer,
    model,
    device_type: deviceType,
    source,
    source_vendor: sourceVendor,
    connection_source: connectionSource,
    firmware_version: firmwareVersion,
    serial_number: serialNumber,
    timezone,
    zip_prefix: zipPrefix,
    zip_code_prefix: zipPrefix,

    // State snapshot
    last_mode: mode || null,
    last_is_cooling: equipmentStatus === 'COOLING',
    last_is_heating: equipmentStatus === 'HEATING',
    last_is_fan_only: equipmentStatus === 'FAN',
    last_equipment_status: equipmentStatus || null,
    is_reachable: isReachable, // ✅ dynamically derived

    // Telemetry
    last_temperature: temperatureF ?? null,
    temperature_f: temperatureF ?? null,
    temperature_c: temperatureC,
    last_humidity: humidity,
    humidity: humidity,
    last_heat_setpoint: heatSetpoint ?? null,
    heat_setpoint_f: heatSetpoint ?? null,
    last_cool_setpoint: coolSetpoint ?? null,
    cool_setpoint_f: coolSetpoint ?? null,

    // Event
    event_type: eventType,
    is_active: !!isActive,
    equipment_status: equipmentStatus || 'OFF',
    previous_status: previousStatus || 'UNKNOWN',
    runtime_seconds: typeof runtimeSeconds === 'number' ? runtimeSeconds : null,
    timestamp: isoNow,
    recorded_at: isoNow,
    observed_at: isoNow,

    // Dedupe + trace
    source_event_id: sourceEventId || uuidv4(),
    payload_raw: payloadRaw || null
  };
}

/**
 * Post to Core Ingest with retry logic
 */
export async function postToCoreIngestAsync(payload, label = "event") {
  if (!CORE_INGEST_URL) {
    console.warn("[CoreIngest] CORE_INGEST_URL not set, skipping");
    return;
  }

  const endpoint = `${CORE_INGEST_URL}/ingest/v1/events:batch`;
  let lastError;

  for (let attempt = 0; attempt < CORE_POST_RETRIES; attempt++) {
    try {
      await axios.post(endpoint, payload, {
        timeout: 20_000,
        headers: { 'Content-Type': 'application/json' }
      });
      console.log(`[${payload.device_key}] ✓ POSTED to Core (${label}) ${nowUtc()}`);
      return;
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === CORE_POST_RETRIES - 1;

      if (isLastAttempt) {
        console.error(
          `[${payload.device_key}] ✗ FAILED to post to Core after ${CORE_POST_RETRIES} attempts (${label}):`,
          err?.response?.data || err.message
        );
        throw err;
      }

      const delayMs = CORE_POST_RETRY_DELAY_MS * Math.pow(2, attempt);
      console.warn(
        `[${payload.device_key}] ⚠️ Core post failed (attempt ${attempt + 1}/${CORE_POST_RETRIES}), retrying in ${delayMs}ms:`,
        err?.response?.data || err.message
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}
