import axios from "axios";
import { BUBBLE_THERMOSTAT_UPDATES_URL, PUBLISH_CONNECTIVITY, BUBBLE_POST_RETRIES, BUBBLE_POST_RETRY_DELAY_MS } from "./config.js";
import { nowUtc, j, sleep } from "./util.js";

/**
 * Post to Bubble with exponential backoff retry logic
 */
export async function postToBubble(payload, label = "state-change") {
  if (!BUBBLE_THERMOSTAT_UPDATES_URL) throw new Error("BUBBLE_THERMOSTAT_UPDATES_URL not set");
  
  let lastError;
  for (let attempt = 0; attempt < BUBBLE_POST_RETRIES; attempt++) {
    try {
      await axios.post(BUBBLE_THERMOSTAT_UPDATES_URL, payload, { timeout: 20_000 });
      console.log(`[${payload.hvacId}] ✓ POSTED to Bubble (${label}) ${nowUtc()} :: ${j(payload)}`);
      return; // Success
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === BUBBLE_POST_RETRIES - 1;
      
      if (isLastAttempt) {
        console.error(
          `[${payload.hvacId}] ✗ FAILED to post to Bubble after ${BUBBLE_POST_RETRIES} attempts (${label}):`,
          err?.response?.data || err.message
        );
        throw err;
      }
      
      const delayMs = BUBBLE_POST_RETRY_DELAY_MS * Math.pow(2, attempt);
      console.warn(
        `[${payload.hvacId}] ⚠️ Bubble post failed (attempt ${attempt + 1}/${BUBBLE_POST_RETRIES}), retrying in ${delayMs}ms:`,
        err?.response?.data || err.message
      );
      await sleep(delayMs);
    }
  }
  
  throw lastError;
}

export async function postConnectivityChange({ userId, hvac_id, isReachable, reason }) {
  if (!PUBLISH_CONNECTIVITY) return;
  
  const payload = {
    userId,
    hvacId: hvac_id,
    thermostatName: null,
    hvacMode: null,
    equipmentStatus: "",
    isCooling: false,
    isHeating: false,
    isFanOnly: false,
    isRunning: false,
    actualTemperatureF: null,
    desiredHeatF: null,
    desiredCoolF: null,
    ok: true,
    ts: nowUtc(),
    isReachable,
    eventType: "ConnectivityStatusChanged",
    reason
  };
  
  await postToBubble(payload, "connectivity");
}
