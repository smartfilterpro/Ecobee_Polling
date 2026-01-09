import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import {
  CORE_INGEST_URL,
  CORE_POST_RETRIES,
  CORE_POST_RETRY_DELAY_MS
} from "./config.js";
import { nowUtc, sleep } from "./util.js";

const CORE_API_KEY = process.env.CORE_API_KEY;

/**
 * Build Core Ingest payload matching standardized pattern
 */
export function buildCorePayload({
  deviceKey,
  userId,
  deviceName,
  
  // Device metadata
  manufacturer = "Ecobee",
  model = "Ecobee Thermostat",
  connectionSource = "ecobee",
  source = "ecobee",
  sourceVendor = "ecobee",
  workspaceId = userId,
  deviceType = "thermostat",
  firmwareVersion = null,
  serialNumber = null,
  timezone = null,
  zipPrefix = null,

  // Runtime state
  eventType,
  equipmentStatus,
  previousStatus,
  isActive,
  mode,
  runtimeSeconds,

  // Telemetry - indoor
  temperatureF,
  humidity = null,
  heatSetpoint,
  coolSetpoint,
  thermostatMode = null,

  // Telemetry - outdoor (sticky)
  outdoorTemperatureF = null,
  outdoorHumidity = null,
  pressureHpa = null,

  // Metadata
  observedAt,
  sourceEventId,
  payloadRaw
}) {
  const temperatureC =
    typeof temperatureF === "number"
      ? Math.round(((temperatureF - 32) * 5) / 9 * 100) / 100
      : null;

  const isoNow = (observedAt || new Date()).toISOString();

  let isReachable = true;
  if (payloadRaw?.connectivity === "OFFLINE" || payloadRaw?.isReachable === false)
    isReachable = false;

  return {
    device_key: deviceKey,
    device_id: deviceKey,
    user_id: userId || null,
    workspace_id: workspaceId || userId || null,
    device_name: deviceName || "Ecobee Thermostat",
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

    last_mode: mode || null,
    // When transitioning to IDLE, use previousStatus to determine what session type just ended
    // This ensures runtime_seconds is correctly associated with the session type
    last_is_cooling: equipmentStatus === "IDLE"
      ? (previousStatus === "Cooling" || previousStatus === "Cooling_Fan")
      : (equipmentStatus === "Cooling" || equipmentStatus === "Cooling_Fan"),
    last_is_heating: equipmentStatus === "IDLE"
      ? (previousStatus === "Heating" || previousStatus === "Heating_Fan" ||
         previousStatus === "AuxHeat" || previousStatus === "AuxHeat_Fan")
      : (equipmentStatus === "Heating" || equipmentStatus === "Heating_Fan" ||
         equipmentStatus === "AuxHeat" || equipmentStatus === "AuxHeat_Fan"),
    last_is_fan_only: equipmentStatus === "IDLE"
      ? previousStatus === "Fan_only"
      : equipmentStatus === "Fan_only",
    last_equipment_status: equipmentStatus || null,
    is_reachable: isReachable,

    // Indoor telemetry
    last_temperature: temperatureF ?? null,
    temperature_f: temperatureF ?? null,
    temperature_c: temperatureC,
    last_humidity: humidity,
    humidity,
    last_heat_setpoint: heatSetpoint ?? null,
    heat_setpoint_f: heatSetpoint ?? null,
    last_cool_setpoint: coolSetpoint ?? null,
    cool_setpoint_f: coolSetpoint ?? null,
    thermostat_mode: thermostatMode,

    // Outdoor telemetry (always include, sticky)
    outdoor_temperature_f: outdoorTemperatureF,
    outdoor_humidity: outdoorHumidity,
    pressure_hpa: pressureHpa,

    // Event data
    event_type: eventType,
    is_active: !!isActive,
    equipment_status: equipmentStatus || "Idle",
    previous_status: previousStatus || "UNKNOWN",
    runtime_seconds: typeof runtimeSeconds === "number" ? runtimeSeconds : null,
    timestamp: isoNow,
    recorded_at: isoNow,
    observed_at: isoNow,

    source_event_id: sourceEventId || uuidv4(),
    payload_raw: payloadRaw || null
  };
}

/**
 * Post to Core Ingest with JWT auth and retries
 */
export async function postToCoreIngestAsync(payload, label = "event") {
  if (!CORE_INGEST_URL) {
    console.warn("[CoreIngest] ⚠️ CORE_INGEST_URL not set — skipping post");
    return;
  }

  if (!CORE_API_KEY) {
    console.warn("[CoreIngest] ⚠️ CORE_API_KEY missing — posting insecurely (dev only)");
  }

  const endpoint = `${CORE_INGEST_URL}/ingest/v1/events:batch`;
  const headers = {
    "Content-Type": "application/json",
    ...(CORE_API_KEY ? { Authorization: `Bearer ${CORE_API_KEY}` } : {})
  };

  // Core expects a flat array of events
  const body = Array.isArray(payload) ? payload : [payload];
  let lastError;

  for (let attempt = 0; attempt < CORE_POST_RETRIES; attempt++) {
    try {
      await axios.post(endpoint, body, { timeout: 20_000, headers });
      console.log(`[${body[0]?.device_key}] ✅ Posted to Core (${label}) ${nowUtc()}`);
      return;
    } catch (err) {
      lastError = err;
      const isLast = attempt === CORE_POST_RETRIES - 1;
      const status = err.response?.status || "unknown";
      const msg = err.response?.data?.error || err.message;

      if (isLast) {
        console.error(
          `[${body[0]?.device_key}] 💥 Core post failed after ${CORE_POST_RETRIES} attempts (${label}) — ${status}: ${msg}`
        );
        throw err;
      }

      const delayMs = CORE_POST_RETRY_DELAY_MS * Math.pow(2, attempt);
      console.warn(
        `[${body[0]?.device_key}] ⚠️ Core post failed (attempt ${attempt + 1}/${CORE_POST_RETRIES}) [${status}] — retrying in ${delayMs}ms`
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}
