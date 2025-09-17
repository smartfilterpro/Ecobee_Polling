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
    isReachable
  };
}
