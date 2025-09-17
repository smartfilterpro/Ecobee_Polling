import { PORT, CONNECTIVITY_CHECK_EVERY_MS, REACHABILITY_STALE_MS, PUBLISH_CONNECTIVITY, POLL_INTERVAL_MS, BUBBLE_THERMOSTAT_UPDATES_URL } from "./config.js";
import { ensureSchema, pool, markUnreachableIfStale, getUserIdForHvac } from "./db.js";
import { buildServer } from "./server.js";
import { startPoller } from "./poller.js";
import { postConnectivityChange } from "./bubble.js";

(async () => {
  if (!BUBBLE_THERMOSTAT_UPDATES_URL || /your-bubble-app\.com/.test(BUBBLE_THERMOSTAT_UPDATES_URL)) {
    console.error("❌ BUBBLE_THERMOSTAT_UPDATES_URL is not set to a real Bubble URL.");
  }

  await ensureSchema();

  const app = buildServer();
  const srv = app.listen(PORT, () => console.log(`✅ Ecobee summary-driven poller on :${PORT}`));

  // start poller
  startPoller(POLL_INTERVAL_MS);

  // connectivity staleness scanner
  setInterval(async () => {
    try {
      const { rows } = await pool.query(`SELECT hvac_id, last_seen_at, is_reachable FROM ecobee_runtime`);
      for (const r of rows) {
        const flipped = await markUnreachableIfStale(r.hvac_id, r.last_seen_at, REACHABILITY_STALE_MS);
        if (flipped && PUBLISH_CONNECTIVITY) {
          const userId = await getUserIdForHvac(r.hvac_id);
          await postConnectivityChange({ userId, hvac_id: r.hvac_id, isReachable: false, reason: "stale_timeout" });
        }
      }
    } catch (e) {
      console.warn("connectivity scan error:", e.message);
    }
  }, CONNECTIVITY_CHECK_EVERY_MS).unref();

  // graceful-ish shutdown
  const shutdown = (sig) => async () => {
    console.log(`${sig} received, closing…`);
    try { srv.close(() => process.exit(0)); } catch { process.exit(1); }
  };
  process.on("SIGINT", shutdown("SIGINT"));
  process.on("SIGTERM", shutdown("SIGTERM"));
})();
