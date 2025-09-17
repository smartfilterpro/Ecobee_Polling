import { parseEquipStatus, modeFromParsed, nowUtc, toMillis } from "./util.js";
import { getRuntime, setRuntime, resetRuntime } from "./db.js";
import { postToBubble } from "./bubble.js";
import { MAX_ACCUMULATE_SECONDS } from "./config.js";

export async function handleRuntimeAndMaybePost({ user_id, hvac_id }, normalized) {
  const nowIso = nowUtc();
  const parsed = parseEquipStatus(normalized.equipmentStatus);
  const currentMode = modeFromParsed(parsed);

  let rt = await getRuntime(hvac_id);
  if (!rt) {
    await setRuntime(hvac_id, {
      is_running: false,
      current_session_started_at: null,
      last_tick_at: null,
      current_session_seconds: 0,
      last_running_mode: null,
      last_equipment_status: null,
      is_reachable: true,
      last_seen_at: nowIso,
    });
    rt = await getRuntime(hvac_id);
  }

  const isRunning = !!parsed.isRunning;

  // idle -> running
  if (!rt.is_running && isRunning) {
    await setRuntime(hvac_id, {
      is_running: true,
      current_session_started_at: nowIso,
      last_tick_at: nowIso,
      last_running_mode: currentMode,
      last_equipment_status: parsed.raw,
    });
    console.log(`[${hvac_id}] ▶️ session START @ ${nowIso} (mode=${currentMode || "n/a"}, status="${parsed.raw}")`);
    return { postedSessionEnd: false };
  }

  // running -> running
  if (rt.is_running && isRunning) {
    const lastTick = rt.last_tick_at ? toMillis(rt.last_tick_at) : Date.now();
    const deltaSec = Math.min(Math.max(0, Math.round((Date.now() - lastTick) / 1000)), MAX_ACCUMULATE_SECONDS);
    const newTotal = (rt.current_session_seconds || 0) + deltaSec;
    await setRuntime(hvac_id, {
      current_session_seconds: newTotal,
      last_tick_at: nowIso,
      last_running_mode: currentMode || rt.last_running_mode,
      last_equipment_status: parsed.raw || rt.last_equipment_status,
    });
    console.log(`[${hvac_id}] ⏱️ tick +${deltaSec}s (total=${newTotal}s) mode=${currentMode || rt.last_running_mode || "n/a"} status="${parsed.raw}"`);
    return { postedSessionEnd: false };
  }

  // running -> idle
  if (rt.is_running && !isRunning) {
    const lastTick = rt.last_tick_at ? toMillis(rt.last_tick_at) : Date.now();
    const deltaSec = Math.min(Math.max(0, Math.round((Date.now() - lastTick) / 1000)), MAX_ACCUMULATE_SECONDS);
    const finalTotal = (rt.current_session_seconds || 0) + deltaSec;

    const lastMode = rt.last_running_mode || currentMode || null;
    const lastIsCooling = lastMode === "cooling";
    const lastIsHeating = lastMode === "heating";
    const lastIsFanOnly = lastMode === "fanonly";
    const lastEquipmentStatus = rt.last_equipment_status || parsed.raw || "";

    const payload = {
      ...normalized,
      isRunning: false,
      runtimeSeconds: finalTotal,
      lastMode,
      lastIsCooling,
      lastIsHeating,
      lastIsFanOnly,
      lastEquipmentStatus,
      isReachable: (rt?.is_reachable !== undefined ? rt.is_reachable : normalized.isReachable)
    };

    console.log(`[${hvac_id}] ⏹️ session END ${finalTotal}s; lastMode=${lastMode || "n/a"} lastStatus="${lastEquipmentStatus}"`);
    await postToBubble(payload, "session-end");
    await resetRuntime(hvac_id);
    return { postedSessionEnd: true };
  }

  return { postedSessionEnd: false };
}
