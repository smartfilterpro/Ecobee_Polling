import axios from "axios";
import { ECOBEE_CLIENT_ID, ECOBEE_TOKEN_URL } from "./config.js";

export async function refreshEcobeeTokens(refresh_token) {
  const params = new URLSearchParams();
  params.append("grant_type", "refresh_token");
  params.append("refresh_token", refresh_token);
  params.append("client_id", ECOBEE_CLIENT_ID);

  const res = await axios.post(ECOBEE_TOKEN_URL, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 20_000,
  });
  return res.data;
}

export async function fetchThermostatSummary(access_token) {
  const sel = { selection: { selectionType: "registered", selectionMatch: "", includeEquipmentStatus: true } };
  const url = "https://api.ecobee.com/1/thermostatSummary?json=" + encodeURIComponent(JSON.stringify(sel));
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json;charset=UTF-8" },
    timeout: 20_000,
  });
  return res.data;
}

export async function fetchThermostatDetails(access_token, hvac_id) {
  const q = { selection: { selectionType: "thermostats", selectionMatch: hvac_id || "", includeRuntime: true, includeSettings: true, includeEvents: false } };
  const url = "https://api.ecobee.com/1/thermostat?json=" + encodeURIComponent(JSON.stringify(q));
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json;charset=UTF-8" },
    timeout: 20_000,
  });
  return res.data;
}
