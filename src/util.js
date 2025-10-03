import crypto from "crypto";

export const nowUtc = () => new Date().toISOString();
export const toMillis = (iso) => new Date(iso).getTime();
export const sha = (o) => crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex");
export const j = (o) => { try { return JSON.stringify(o); } catch { return String(o); } };
export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export function tenthsFToF(x) {
  if (x === undefined || x === null) return null;
  return Number((x / 10).toFixed(1));
}

export function isExpiringSoon(expiresAtISO, thresholdSec = 120) {
  if (!expiresAtISO) return true;
  return new Date(expiresAtISO).getTime() - Date.now() <= thresholdSec * 1000;
}

/**
 * Parse equipment status with error handling
 * Handles compCool/compHeat/auxHeat/heatPump variations
 */
export function parseEquipStatus(equipmentStatus) {
  try {
    const raw = String(equipmentStatus || "").toLowerCase();
    const tokens = raw.split(",").map(s => s.trim()).filter(Boolean);
    const has = (t) => tokens.includes(t);

    const isCooling = has("cooling") || has("compcool1") || has("compcool2");
    const isHeating = has("heating") || has("compheat1") || has("compheat2") ||
                      has("auxheat1") || has("auxheat2") || has("auxheat3") ||
                      has("heatpump") || has("heatpump1") || has("heatpump2");

    const fanRunning = has("fan") || has("fanonly") || has("fanonly1");
    const isFanOnly = fanRunning && !isCooling && !isHeating;
    const isRunning = isCooling || isHeating || isFanOnly;

    let lastMode = null;
    if (isCooling) lastMode = "cooling";
    else if (isHeating) lastMode = "heating";
    else if (isFanOnly) lastMode = "fanonly";

    return { 
      isCooling, 
      isHeating, 
      isFanOnly, 
      isRunning, 
      lastMode, 
      raw: equipmentStatus || "" 
    };
  } catch (err) {
    console.warn('Failed to parse equipment status:', err.message, 'input:', equipmentStatus);
    return { 
      isCooling: false, 
      isHeating: false, 
      isFanOnly: false, 
      isRunning: false, 
      lastMode: null, 
      raw: String(equipmentStatus || "") 
    };
  }
}

export function modeFromParsed(parsed) {
  if (parsed.isCooling) return "cooling";
  if (parsed.isHeating) return "heating";
  if (parsed.isFanOnly) return "fanonly";
  return null;
}
