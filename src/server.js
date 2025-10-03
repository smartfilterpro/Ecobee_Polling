import { 
  PORT, 
  CONNECTIVITY_CHECK_EVERY_MS, 
  REACHABILITY_STALE_MS, 
  PUBLISH_CONNECTIVITY, 
  POLL_INTERVAL_MS, 
  BUBBLE_THERMOSTAT_UPDATES_URL 
} from "./config.js";
import { ensureSchema, pool, markUnreachableIfStale, closePool } from "./db.js";
import { buildServer } from "./server.js";
import { startPoller, stopPoller } from "./poller.js";
import { postConnectivityChange } from "./bubble.js";

let connectivityInterval;
let isShuttingDown = false;

async function connectivityScanner() {
  if (isShuttingDown) return;
  
  try {
    const { rows } = await pool.query(`SELECT hvac_id, last_seen_at, is_reachable FROM ecobee_runtime`);
    for (const r of rows) {
      if (isShuttingDown) break;
      
      const { flipped, userId } = await markUnreachableIfStale(r.hvac_id, r.last_seen_at, REACHABILITY_STALE_MS);
      if (flipped && userId && PUBLISH_CONNECTIVITY) {
        await postConnectivityChange({ 
          userId, 
          hvac_id: r.hvac_id, 
          isReachable: false, 
          reason: "stale_timeout" 
        });
      }
    }
  } catch (e) {
    if (!isShuttingDown) {
      console.warn("connectivity scan error:", e.message);
    }
  }
}

(async () => {
  try {
    // Validate configuration
    if (!BUBBLE_THERMOSTAT_UPDATES_URL || /your-bubble-app\.com/.test(BUBBLE_THERMOSTAT_UPDATES_URL)) {
      console.error("❌ BUBBLE_THERMOSTAT_UPDATES_URL is not set to a real Bubble URL.");
    }

    // Initialize database
    await ensureSchema();
    console.log("✅ Database schema ready");

    // Start HTTP server
    const app = buildServer();
    const srv = app.listen(PORT, () => console.log(`✅ Ecobee summary-driven poller on :${PORT}`));

    // Start poller
    startPoller(POLL_INTERVAL_MS);
    console.log(`✅ Poller started (interval: ${POLL_INTERVAL_MS}ms)`);

    // Start connectivity staleness scanner
    connectivityInterval = setInterval(connectivityScanner, CONNECTIVITY_CHECK_EVERY_MS);
    console.log(`✅ Connectivity scanner started (interval: ${CONNECTIVITY_CHECK_EVERY_MS}ms)`);

    // Graceful shutdown handler
    const shutdown = (signal) => async () => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      
      console.log(`\n${signal} received, shutting down gracefully...`);
      
      try {
        // Stop accepting new work
        console.log("⏸️  Stopping poller...");
        stopPoller();
        
        console.log("⏸️  Stopping connectivity scanner...");
        if (connectivityInterval) {
          clearInterval(connectivityInterval);
        }
        
        // Close HTTP server (waits for existing connections)
        console.log("⏸️  Closing HTTP server...");
        await new Promise((resolve, reject) => {
          srv.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        });
        
        // Close database pool
        console.log("⏸️  Closing database pool...");
        await closePool();
        
        console.log("✅ Graceful shutdown complete");
        process.exit(0);
      } catch (err) {
        console.error("❌ Error during shutdown:", err);
        process.exit(1);
      }
    };

    process.on("SIGINT", shutdown("SIGINT"));
    process.on("SIGTERM", shutdown("SIGTERM"));
    
    // Handle uncaught errors
    process.on("uncaughtException", (err) => {
      console.error("❌ Uncaught exception:", err);
      shutdown("UNCAUGHT_EXCEPTION")();
    });
    
    process.on("unhandledRejection", (reason, promise) => {
      console.error("❌ Unhandled rejection at:", promise, "reason:", reason);
      shutdown("UNHANDLED_REJECTION")();
    });
    
  } catch (err) {
    console.error("❌ Fatal startup error:", err);
    process.exit(1);
  }
})();
