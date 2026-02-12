import {
  PORT,
  CONNECTIVITY_CHECK_EVERY_MS,
  REACHABILITY_STALE_MS,
  PUBLISH_CONNECTIVITY,
  POLL_INTERVAL_MS,
  BUBBLE_THERMOSTAT_UPDATES_URL
} from "./config.js";
import { ensureSchema, pool, markUnreachableIfStale, closePool, cleanupOutboundEventLog } from "./db.js";
import { buildServer } from "./server.js";
import { startPoller, stopPoller } from "./poller.js";
import { postConnectivityChange } from "./bubble.js";
import { buildCorePayload, postToCoreIngestAsync } from "./coreIngest.js";
import { scheduleDailyRuntimeValidation } from "./runtimeValidationScheduler.js";
import { v4 as uuidv4 } from "uuid";

let connectivityInterval;
let eventLogCleanupInterval;
let stopRuntimeValidation;
let isShuttingDown = false;

const EVENT_LOG_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day

async function connectivityScanner() {
  if (isShuttingDown) return;
  
  try {
    const { rows } = await pool.query(`SELECT hvac_id, last_seen_at, is_reachable FROM ecobee_runtime`);
    for (const r of rows) {
      if (isShuttingDown) break;
      
      const { flipped, userId } = await markUnreachableIfStale(r.hvac_id, r.last_seen_at, REACHABILITY_STALE_MS);
      if (flipped && userId) {
        // Post to Bubble
        if (PUBLISH_CONNECTIVITY) {
          await postConnectivityChange({ 
            userId, 
            hvac_id: r.hvac_id, 
            isReachable: false, 
            reason: "stale_timeout" 
          });
        }
        
        // Post to Core
        const corePayload = buildCorePayload({
          deviceKey: r.hvac_id,
          userId,
          deviceName: null,
          eventType: 'CONNECTIVITY_CHANGE',
          equipmentStatus: 'OFF',
          previousStatus: 'ONLINE',
          isActive: false,
          mode: 'off',
          runtimeSeconds: null,
          temperatureF: null,
          heatSetpoint: null,
          coolSetpoint: null,
          observedAt: new Date(),
          sourceEventId: uuidv4(),
          payloadRaw: { connectivity: 'OFFLINE', reason: 'stale_timeout' }
        });
        
        console.log(`[${r.hvac_id}] 🔴 Device marked offline (stale) - posting to Core`);
        await postToCoreIngestAsync(corePayload, "connectivity-offline").catch(e =>
          console.error(`[${r.hvac_id}] Failed to post connectivity to Core:`, e.message)
        );
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

    // Start daily runtime validation scheduler
    stopRuntimeValidation = scheduleDailyRuntimeValidation();
    console.log(`✅ Runtime validation scheduler started (runs daily at 00:05 UTC)`);

    // Start outbound event log cleanup (daily, 7-day retention)
    eventLogCleanupInterval = setInterval(() => {
      cleanupOutboundEventLog().catch(e =>
        console.warn("[EventLog] Cleanup error:", e.message)
      );
    }, EVENT_LOG_CLEANUP_INTERVAL_MS);
    // Run once on startup to clear any stale entries
    cleanupOutboundEventLog().catch(() => {});
    console.log(`✅ Outbound event log cleanup scheduled (daily, 7-day retention)`);

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

        console.log("⏸️  Stopping runtime validation scheduler...");
        if (stopRuntimeValidation) {
          stopRuntimeValidation();
        }

        console.log("⏸️  Stopping event log cleanup...");
        if (eventLogCleanupInterval) {
          clearInterval(eventLogCleanupInterval);
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
