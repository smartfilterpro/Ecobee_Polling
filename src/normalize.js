import { tenthsFToF, parseEquipStatus } from "./util.js";

/**
 * Convert Ecobee summary statusList to a map of hvacId -> status
 */
export function mapStatusFromSummary(summary) {
  const list = Array.isArray(summary?.statusList) ? summary.statusList : [];
  const map = new Map();
  for (const item of list) {
    const idx = item.indexOf(":");
    if (idx > 0) map.set(item.slice(0, idx), item.slice(idx + 1));
  }
  return map;
}

/**
 * Convert Ecobee revisionList to a map of hvacId -> revision string
 */
export function mapRevisionFromSummary(summary) {
  const list = Array.isArray(summary?.revisionList) ? summary.revisionList : [];
  const map = new Map();
  for (const item of list) {
    const idx = item.indexOf(":");
    if (idx > 0) map.set(item.slice(0, idx), item);
  }
  return map;
}

/**
 * Parse the connected status from the revision string
 * Format: "identifier:name:connected:thermostatRev:alertsRev:runtimeRev:intervalRev"
 */
export function parseConnectedFromRevision(revisionString) {
  if (!revisionString) return false;
  const parts = revisionString.split(":");
  if (parts.length >= 3) {
    const connectedStr = parts[2].toLowerCase();
    return connectedStr === "true";
  }
  return false;
}

/**
 * Parse the runtimeRev from the revision string
 * Format: "identifier:name:connected:thermostatRev:alertsRev:runtimeRev:intervalRev"
 * @returns {string|null} - runtimeRev or null if not found
 */
export function parseRuntimeRevFromRevision(revisionString) {
  if (!revisionString) return null;
  const parts = revisionString.split(":");
  if (parts.length >= 6) {
    return parts[5] || null;
  }
  return null;
}

/**
 * Normalize full thermostat data from Ecobee details API
 * Includes indoor temp/humidity, outdoor weather, firmware, and serial metadata.
 *
 * @param {object} args - { user_id, hvac_id, isReachable }
 * @param {string} equipStatus - raw equipment status string
 * @param {object} details - response body from fetchThermostatDetails()
 * @param {string} revisionString - full revision string from Ecobee (optional)
 */
export function normalizeFromDetails({ user_id, hvac_id, isReachable }, equipStatus, details, revisionString = null) {
  const parsed = parseEquipStatus(equipStatus);
  const runtimeRev = parseRuntimeRevFromRevision(revisionString);

  let actualTemperatureF = null;
  let desiredHeatF = null;
  let desiredCoolF = null;
  let thermostatName = null;
  let hvacMode = null;
  let humidity = null;
  let outdoorTemperatureF = null;
  let outdoorHumidity = null;
  let pressureHpa = null;
  let firmwareVersion = null;
  let serialNumber = null;
  let modelNumber = null;

  if (details?.thermostatList?.[0]) {
    const t = details.thermostatList[0];
    thermostatName = t.name || null;

    const runtime = t.runtime || {};
    const settings = t.settings || {};
    const weather = t.weather || {};

    // Indoor metrics
    actualTemperatureF = tenthsFToF(runtime.actualTemperature);
    desiredHeatF = tenthsFToF(runtime.desiredHeat);
    desiredCoolF = tenthsFToF(runtime.desiredCool);
    hvacMode = (settings.hvacMode || "").toLowerCase();

    if (typeof runtime.actualHumidity === "number") humidity = runtime.actualHumidity;

    // Outdoor metrics (prefer runtime values, fallback to weather)
    if (typeof runtime.outdoorTemp === "number") outdoorTemperatureF = runtime.outdoorTemp;
    if (typeof runtime.outdoorHumidity === "number") outdoorHumidity = runtime.outdoorHumidity;

    if (typeof weather.temperature === "number" && outdoorTemperatureF === null)
      outdoorTemperatureF = weather.temperature;
    if (typeof weather.relativeHumidity === "number" && outdoorHumidity === null)
      outdoorHumidity = weather.relativeHumidity;

    // Pressure (Ecobee rarely provides this, but keep placeholder)
    pressureHpa = weather.pressure ?? null;

    // Firmware + model metadata
    serialNumber = t.identifier || null;
    firmwareVersion = t.version || t.runtimeVersion || null;
    modelNumber = t.modelNumber || null;
  }

  return {
    userId: user_id,
    hvacId: hvac_id,
    thermostatName,
    hvacMode,
    equipmentStatus: parsed.raw,
    isCooling: parsed.isCooling,
    isHeating: parsed.isHeating,
    isFanOnly: parsed.isFanOnly,
    isRunning: parsed.isRunning,

    // Indoor
    actualTemperatureF,
    desiredHeatF,
    desiredCoolF,
    humidity,

    // Outdoor
    outdoorTemperatureF,
    outdoorHumidity,
    pressureHpa,

    // Metadata
    firmwareVersion,
    serialNumber,
    modelNumber,
    runtimeRev,

    ok: true,
    ts: new Date().toISOString(),
    isReachable
  };
}
