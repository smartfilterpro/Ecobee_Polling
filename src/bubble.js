import axios from "axios";
import { BUBBLE_THERMOSTAT_UPDATES_URL, PUBLISH_CONNECTIVITY } from "./config.js";
import { nowUtc, j } from "./util.js";

export async function postToBubble(payload, label = "state-change") {
  if (!BUBBLE_THERMOSTAT_UPDATES_URL) throw new Error("BUBBLE_THERMOSTAT_UPDATES_URL not set");
  await axios.post(BUBBLE_THERMOSTAT_UPDATES_URL, payload, { timeout: 20_000 });
  console.log(`[${payload.hvacId}] → POSTED to Bubble (${label}) ${nowUtc()} :: ${j(payload)}`);
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
