import { tenthsFToF, parseEquipStatus } from "./util.js";

export function mapStatusFromSummary(summary) {
  const list = Array.isArray(summary?.statusList) ? summary.statusList : [];
  const map = new Map();
  for (const item of list) {
    const idx = item.indexOf(":");
    if (idx > 0) map.set(item.slice(0, idx), item.slice(idx + 1));
  }
  return map;
}

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
 * Parse the connected status from revision string
 * Format: "identifier:name:connected:thermostatRev:alertsRev:runtimeRev:intervalRev"
 * 
 * NOTE: We don't actually use this anymore because Ecobee's "connected" field
 * can be false even when the API is responding. We trust API responses instead.
 * 
 * @param {string} revisionString 
 * @returns {boolean} true if connected, false otherwise
 */
export function parseConnectedFromRevision(revisionString) {
  if (!revisionString) return false;
  const parts = revisionString.split(":");
  // Third field (index 2) is the connected status
  if (parts.length >= 3) {
    const connectedStr = parts[2].toLowerCase();
    return connectedStr === "true";
  }
  return false;
}

/**
 * Normalize device data from Ecobee details API
 * If isReachable is not explicitly provided, default to TRUE since we got an API response
 */
export function normalizeFromDetails({ user_id, hvac_id, isReachable = true }, equipStatus, details) {
  const parsed = parseEquipStatus(equipStatus);
  let actualTemperatureF = null, desiredHeatF = null, desiredCoolF = null, thermostatName = null, hvacMode = null;

  if (details?.thermostatList?.[0]) {
    const t = details.thermostatList[0];
    thermostatName = t.name || null;
    const runtime = t.runtime || {};
    const settings = t.settings || {};
    actualTemperatureF = tenthsFToF(runtime.actualTemperature);
    desiredHeatF = tenthsFToF(runtime.desiredHeat);
    desiredCoolF = tenthsFToF(runtime.desiredCool);
    hvacMode = (settings.hvacMode || "").toLowerCase();
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
    actualTemperatureF,
    desiredHeatF,
    desiredCoolF,
    ok: true,
    ts: new Date().toISOString(),
    isReachable // Use the explicitly provided value (defaults to true if we got here)
  };
}
