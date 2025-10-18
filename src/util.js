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
 * Parse equipment status and map to standardized state classifications
 * Returns standardized states: Cooling_on, Cooling_Fan, Heating_on, Heating_Fan, Fan_only, Fan_off
 */
export function parseEquipStatus(equipmentStatus) {
  try {
    const raw = String(equipmentStatus || "").toLowerCase();
    const tokens = raw.split(",").map(s => s.trim()).filter(Boolean);
    const has = (t) => tokens.includes(t);

    // Detect cooling compressor
    const compressorCooling = has("compcool1") || has("compcool2") || has("cooling");
    
    // Detect heating equipment (compressor, heat pump, or auxiliary heat)
    const compressorHeating = has("compheat1") || has("compheat2") || 
                               has("auxheat1") || has("auxheat2") || has("auxheat3") ||
                               has("heatpump") || has("heatpump1") || has("heatpump2") ||
                               has("heating");
    
    // Detect fan
    const fanRunning = has("fan") || has("fanonly") || has("fanonly1");

    // Determine standardized state
    let standardizedState = "Fan_off";
    let isCooling = false;
    let isHeating = false;
    let isFanOnly = false;
    let lastMode = null;

    if (compressorCooling) {
      standardizedState = "Cooling_on";
      isCooling = true;
      lastMode = "cooling";
    } else if (compressorHeating) {
      standardizedState = "Heating_on";
      isHeating = true;
      lastMode = "heating";
    } else if (fanRunning) {
      // Fan running without heating/cooling compressor
      // Check if we're in a heating or cooling mode (fan circulation between cycles)
      // For now, classify as Fan_only since we don't have mode context here
      standardizedState = "Fan_only";
      isFanOnly = true;
      lastMode = "fanonly";
    }

    const isRunning = isCooling || isHeating || isFanOnly;

    return { 
      isCooling, 
      isHeating, 
      isFanOnly, 
      isRunning, 
      lastMode,
      standardizedState,
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
      standardizedState: "Fan_off",
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
