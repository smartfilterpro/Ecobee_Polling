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
 * Uses fan presence in equipment status to determine filter usage states
 * 
 * @param {string} equipmentStatus - Raw Ecobee equipment status (e.g., "compCool1,fan", "auxHeat1", "fan")
 * @returns {object} Parsed state with standardizedState for filter health tracking
 * 
 * State Logic (8 states):
 * - Cooling_Fan / Cooling = cooling equipment ± fan
 * - Heating_Fan / Heating = primary heating (heat pump, furnace) ± fan
 * - AuxHeat_Fan / AuxHeat = auxiliary/emergency heat ± fan (higher energy cost)
 * - Fan_only = just fan (filter usage)
 * - Fan_off = system idle
 */
export function parseEquipStatus(equipmentStatus) {
  try {
    const raw = String(equipmentStatus || "").toLowerCase();
    const tokens = raw.split(",").map(s => s.trim()).filter(Boolean);
    const has = (t) => tokens.includes(t);

    // Detect cooling compressor
    const compressorCooling = has("compcool1") || has("compcool2") || has("cooling");
    
    // Detect auxiliary/emergency heat (typically expensive electric resistance)
    const auxHeat = has("auxheat1") || has("auxheat2") || has("auxheat3");
    
    // Detect primary heating equipment (heat pump, furnace)
    const primaryHeating = has("compheat1") || has("compheat2") || 
                           has("heatpump") || has("heatpump1") || has("heatpump2") ||
                           has("heating");
    
    // Detect fan presence in equipment status
    const fanRunning = has("fan") || has("fanonly") || has("fanonly1");

    // Determine standardized state based on equipment + fan presence
    let standardizedState = "Fan_off";
    let isCooling = false;
    let isHeating = false;
    let isAuxHeat = false;
    let isFanOnly = false;
    let lastMode = null;

    if (compressorCooling && fanRunning) {
      // Cooling with fan = filter usage
      standardizedState = "Cooling_Fan";
      isCooling = true;
      lastMode = "cooling";
    } else if (compressorCooling && !fanRunning) {
      // Cooling without fan = rare, but possible (e.g., water-cooled chiller)
      standardizedState = "Cooling";
      isCooling = true;
      lastMode = "cooling";
    } else if (auxHeat && fanRunning) {
      // Auxiliary/emergency heat with fan = filter usage + high energy cost
      standardizedState = "AuxHeat_Fan";
      isAuxHeat = true;
      lastMode = "auxheat";
    } else if (auxHeat && !fanRunning) {
      // Auxiliary heat without fan = rare (hydronic aux heat)
      standardizedState = "AuxHeat";
      isAuxHeat = true;
      lastMode = "auxheat";
    } else if (primaryHeating && fanRunning) {
      // Primary heating with fan = filter usage
      standardizedState = "Heating_Fan";
      isHeating = true;
      lastMode = "heating";
    } else if (primaryHeating && !fanRunning) {
      // Primary heating without fan = hydronic/radiant (no filter usage)
      standardizedState = "Heating";
      isHeating = true;
      lastMode = "heating";
    } else if (fanRunning) {
      // Just fan = filter usage
      standardizedState = "Fan_only";
      isFanOnly = true;
      lastMode = "fanonly";
    }
    // else: Fan_off (idle)

    const isRunning = isCooling || isHeating || isAuxHeat || isFanOnly;

    return { 
      isCooling, 
      isHeating,
      isAuxHeat,
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
      isAuxHeat: false,
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
  if (parsed.isAuxHeat) return "auxheat";
  if (parsed.isHeating) return "heating";
  if (parsed.isFanOnly) return "fanonly";
  return null;
}
