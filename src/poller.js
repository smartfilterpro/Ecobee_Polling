import { isExpiringSoon, parseEquipStatus, nowUtc, sha } from "./util.js";
import {
  loadAllTokens,
  updateTokensAfterRefresh,
  markSeen,
  getLastRevision,
  setLastRevision,
  getRuntime,
  getLastHash,
  setLastState,
  getUserIdForHvac
} from "./db.js";
import {
  refreshEcobeeTokens,
  fetchThermostatSummary,
  fetchThermostatDetails
} from "./ecobeeApi.js";
import {
  mapStatusFromSummary,
  mapRevisionFromSummary,
  normalizeFromDetails
} from "./normalize.js";
import { handleRuntimeAndMaybePost } from "./runtime.js";
import { postToBubble, postConnectivityChange } from "./bubble.js";
import { ERROR_BACKOFF_MS } from "./config.js";

export async function pollOnce() {
  const tokens = await loadAllTokens();
  if (!tokens.length) return;
  console.log(`\n🕒 tick ${nowUtc()} — ${tokens.length} thermostat(s)`);

  for (const row of tokens) {
    const { user_id, hvac_id } = row;
    let { access_token, refresh_token, expires_at } = row;

    try {
      // pre-emptive refresh
      if (isExpiringSoon(expires_at)) {
        try {
          const refreshed = await refreshEcobeeTokens(refresh_token);
          access_token = refreshed.access_token;
          refresh_token = refreshed.refresh_token;
          await updateTokensAfterRefresh({
            user_id,
            hvac_id,
            access_token,
            refresh_token,
            expires_in: refreshed.expires_in
          });
          console.log(`[${hvac_id}] 🔁 token refreshed`);
        } catch (e) {
          console.warn(`[${hvac_id}] ⚠️ refresh (pre-summary) failed`, e?.response?.data || e.message);
        }
      }

      // fetch summary, handle reachable flip true
      let summary;
      try {
        summary = await fetchThermostatSummary(access_token);
        const flippedTrue = await markSeen(hvac_id);
        if (flippedTrue) {
          const userId = await getUserIdForHvac(hvac_id);
          await postConnectivityChange({ userId, hvac_id, isReachable: true, reason: "api_seen" });
        }
      } catch (e) {
        if (e?.response?.status === 401) {
          const refreshed = await refreshEcobeeTokens(refresh_token);
          access_token = refreshed.access_token;
          refresh_token = refreshed.refresh_token;
          await updateTokensAfterRefresh({
            user_id,
            hvac_id,
            access_token,
            refresh_token,
            expires_in: refreshed.expires_in
          });
          console.log(`[${hvac_id}] 🔁 token refreshed after 401`);
          // retry
          summary = await fetchThermostatSummary(access_token);
          const flippedTrue = await markSeen(hvac_id);
          if (flippedTrue) {
            const userId = await getUserIdForHvac(hvac_id);
            await postConnectivityChange({ userId, hvac_id, isReachable: true, reason: "api_seen" });
          }
        } else {
          throw e;
        }
      }

      const statusMap = mapStatusFromSummary(summary);
      const revMap = mapRevisionFromSummary(summary);
      const equipStatus = statusMap.get(hvac_id) ?? "";
      const currentRev = revMap.get(hvac_id) ?? "";
      const prevRev = await getLastRevision(hvac_id);
      const rt = await getRuntime(hvac_id);
      const isReachable = rt?.is_reachable !== false; // default true

      const parsed = parseEquipStatus(equipStatus);
      console.log(
        `[${hvac_id}] 📥 summary equip="${equipStatus}" rev="${currentRev}" (prev="${prevRev}") running=${parsed.isRunning} reachable=${isReachable}`
      );

      const revisionChanged = !!currentRev && currentRev !== prevRev;

      if (revisionChanged) {
        // details enrich
        let details = null;
        try {
          details = await fetchThermostatDetails(access_token, hvac_id);
          // seen again on details success (won’t double post; markSeen only flips once)
          const flippedTrue = await markSeen(hvac_id);
          if (flippedTrue) {
            const userId = await getUserIdForHvac(hvac_id);
            await postConnectivityChange({ userId, hvac_id, isReachable: true, reason: "api_seen" });
          }
        } catch (e) {
          console.warn(`[${hvac_id}] ⚠️ details fetch failed`, e?.response?.data || e.message);
        }

        let normalized = normalizeFromDetails({ user_id, hvac_id, isReachable }, equipStatus, details);

        // runtime handling (may post session-end)
        const runtimeResult = await handleRuntimeAndMaybePost({ user_id, hvac_id }, normalized);

        // dedupe state-change by hash (ignore runtimeSeconds)
        const payloadForHash = { ...normalized, runtimeSeconds: null };
        const newHash = sha(payloadForHash);
        const lastHash = await getLastHash(hvac_id);
        const shouldPostStateChange = !runtimeResult.postedSessionEnd && newHash !== lastHash;

        if (shouldPostStateChange) {
          await postToBubble({ ...normalized, runtimeSeconds: null }, "state-change");
          await setLastState(hvac_id, { ...normalized, runtimeSeconds: null });
        } else if (runtimeResult.postedSessionEnd) {
          await setLastState(hvac_id, { ...normalized, runtimeSeconds: null });
        }

        await setLastRevision(hvac_id, currentRev);
      } else {
        // No revision change → tick runtime with equipmentStatus only
        const normalized = {
          userId: user_id,
          hvacId: hvac_id,
          thermostatName: null,
          hvacMode: null,
          equipmentStatus: equipStatus,
          ...parseEquipStatus(equipStatus),
          actualTemperatureF: null,
          desiredHeatF: null,
          desiredCoolF: null,
          ok: true,
          ts: nowUtc(),
          isReachable
        };

        const runtimeResult = await handleRuntimeAndMaybePost({ user_id, hvac_id }, normalized);
        if (runtimeResult.postedSessionEnd) {
          await setLastState(hvac_id, { ...normalized, runtimeSeconds: null });
        }
      }
    } catch (err) {
      console.error(`[${row.hvac_id}] ❌ poll error:`, err?.response?.data || err.message || String(err));
      // allow brief backoff to avoid tight error loops
      await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
    }
  }
}

export function startPoller(intervalMs) {
  // fire immediately, then interval
  pollOnce().catch(() => {});
  setInterval(() => pollOnce().catch(() => {}), intervalMs);
}
