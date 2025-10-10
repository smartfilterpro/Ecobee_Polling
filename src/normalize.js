export function normalizeFromDetails({ user_id, hvac_id, isReachable }, equipStatus, details) {
  const parsed = parseEquipStatus(equipStatus);

  let actualTemperatureF = null,
      desiredHeatF = null,
      desiredCoolF = null,
      thermostatName = null,
      hvacMode = null,
      humidity = null,
      outdoorTemperatureF = null,
      outdoorHumidity = null,
      pressureHpa = null;

  if (details?.thermostatList?.[0]) {
    const t = details.thermostatList[0];
    thermostatName = t.name || null;
    const runtime = t.runtime || {};
    const settings = t.settings || {};
    const weather = t.weather || {};

    actualTemperatureF = tenthsFToF(runtime.actualTemperature);
    desiredHeatF = tenthsFToF(runtime.desiredHeat);
    desiredCoolF = tenthsFToF(runtime.desiredCool);
    hvacMode = (settings.hvacMode || "").toLowerCase();

    if (typeof runtime.actualHumidity === "number") humidity = runtime.actualHumidity;
    if (typeof runtime.outdoorTemp === "number") outdoorTemperatureF = runtime.outdoorTemp;
    if (typeof runtime.outdoorHumidity === "number") outdoorHumidity = runtime.outdoorHumidity;
    if (typeof weather.temperature === "number" && outdoorTemperatureF === null)
      outdoorTemperatureF = weather.temperature;
    if (typeof weather.relativeHumidity === "number" && outdoorHumidity === null)
      outdoorHumidity = weather.relativeHumidity;

    // Ecobee does not provide pressure, but placeholder kept for future data model compatibility
    pressureHpa = weather.pressure ?? null;
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
    humidity,
    outdoorTemperatureF,
    outdoorHumidity,
    pressureHpa,
    ok: true,
    ts: new Date().toISOString(),
    isReachable
  };
}
