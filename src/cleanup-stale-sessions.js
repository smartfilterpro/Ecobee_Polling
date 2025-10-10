import { pool } from "./src/db.js";

/**
 * ONE-TIME CLEANUP SCRIPT
 * Resets all stale runtime sessions (especially for offline devices)
 * Run with: node cleanup-stale-sessions.js
 */

async function cleanupStaleSessions() {
  console.log("🧹 Starting cleanup of stale sessions...\n");

  try {
    // Find all running sessions
    const { rows } = await pool.query(`
      SELECT 
        hvac_id,
        is_running,
        is_reachable,
        current_session_seconds,
        current_session_started_at,
        last_tick_at
      FROM ecobee_runtime 
      WHERE is_running = TRUE
    `);

    console.log(`Found ${rows.length} active session(s)\n`);

    for (const row of rows) {
      const hours = (row.current_session_seconds || 0) / 3600;
      const startedAgo = row.current_session_started_at 
        ? Math.floor((Date.now() - new Date(row.current_session_started_at).getTime()) / 3600000)
        : 0;

      console.log(`[${row.hvac_id}]`);
      console.log(`  - Running: ${row.is_running}`);
      console.log(`  - Reachable: ${row.is_reachable}`);
      console.log(`  - Runtime: ${hours.toFixed(1)} hours`);
      console.log(`  - Started: ${startedAgo} hours ago`);

      // Reset any session that's:
      // 1. Offline OR
      // 2. Running > 24 hours OR
      // 3. Started > 48 hours ago
      const shouldReset = 
        !row.is_reachable || 
        hours > 24 || 
        startedAgo > 48;

      if (shouldReset) {
        await pool.query(`
          UPDATE ecobee_runtime 
          SET 
            is_running = FALSE,
            current_session_started_at = NULL,
            last_tick_at = NULL,
            current_session_seconds = 0,
            last_running_mode = NULL,
            last_equipment_status = NULL,
            updated_at = NOW()
          WHERE hvac_id = $1
        `, [row.hvac_id]);
        console.log(`  ✅ RESET stale session\n`);
      } else {
        console.log(`  ✓ Looks OK\n`);
      }
    }

    console.log("🧹 Cleanup complete!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Cleanup failed:", err);
    process.exit(1);
  }
}

cleanupStaleSessions();
