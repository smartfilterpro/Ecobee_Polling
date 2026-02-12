import express from "express";
import { pool, upsertTokens, deleteUser, deleteThermostat, queryOutboundEventLog } from "./db.js";
import { nowUtc } from "./util.js";
import { runValidationNow } from "./runtimeValidationScheduler.js";
import { CORE_API_KEY } from "./config.js";

export function buildServer() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Authentication middleware
  const requireApiKey = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const providedKey = authHeader?.replace(/^Bearer\s+/i, "");

    if (!CORE_API_KEY) {
      console.error("CORE_API_KEY not configured - rejecting request");
      return res.status(500).json({ ok: false, error: "Server authentication not configured" });
    }

    if (!providedKey || providedKey !== CORE_API_KEY) {
      return res.status(401).json({ ok: false, error: "Unauthorized - invalid or missing API key" });
    }

    next();
  };

  app.get("/health", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ ok: true, time: nowUtc() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/ecobee/link", requireApiKey, async (req, res) => {
    try {
      const { user_id, hvac_id, access_token, refresh_token, expires_in, scope } = req.body || {};
      
      // Validate required fields
      if (!user_id || typeof user_id !== 'string' || !user_id.trim()) {
        return res.status(400).json({ ok: false, error: "Invalid or missing user_id" });
      }
      
      if (!hvac_id || typeof hvac_id !== 'string' || !hvac_id.trim()) {
        return res.status(400).json({ ok: false, error: "Invalid or missing hvac_id" });
      }
      
      if (!access_token || typeof access_token !== 'string' || !access_token.trim()) {
        return res.status(400).json({ ok: false, error: "Invalid or missing access_token" });
      }
      
      if (!refresh_token || typeof refresh_token !== 'string' || !refresh_token.trim()) {
        return res.status(400).json({ ok: false, error: "Invalid or missing refresh_token" });
      }
      
      if (typeof expires_in !== 'number' || expires_in <= 0) {
        return res.status(400).json({ ok: false, error: "Invalid or missing expires_in (must be positive number)" });
      }
      
      await upsertTokens({ 
        user_id: user_id.trim(), 
        hvac_id: hvac_id.trim(), 
        access_token: access_token.trim(), 
        refresh_token: refresh_token.trim(), 
        expires_in, 
        scope 
      });
      
      console.log(`[${hvac_id.trim()}] 🔗 link/upsert from Bubble @ ${nowUtc()}`);
      res.json({ ok: true, saved: true });
    } catch (e) {
      console.error("link error:", e);
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post("/ecobee/unlink", requireApiKey, async (req, res) => {
    try {
      const { user_id, hvac_id } = req.body || {};
      
      if (!user_id || typeof user_id !== 'string' || !user_id.trim()) {
        return res.status(400).json({ ok: false, error: "Invalid or missing user_id" });
      }
      
      if (!hvac_id || typeof hvac_id !== 'string' || !hvac_id.trim()) {
        return res.status(400).json({ ok: false, error: "Invalid or missing hvac_id" });
      }
      
      const trimmedUserId = user_id.trim();
      const trimmedHvacId = hvac_id.trim();
      
      await pool.query(`DELETE FROM ecobee_tokens WHERE user_id=$1 AND hvac_id=$2`, [trimmedUserId, trimmedHvacId]);
      await pool.query(`DELETE FROM ecobee_last_state WHERE hvac_id=$1`, [trimmedHvacId]);
      await pool.query(`DELETE FROM ecobee_runtime WHERE hvac_id=$1`, [trimmedHvacId]);
      await pool.query(`DELETE FROM ecobee_revisions WHERE hvac_id=$1`, [trimmedHvacId]);
      await pool.query(`DELETE FROM ecobee_runtime_reports WHERE hvac_id=$1`, [trimmedHvacId]);
      
      console.log(`[${trimmedHvacId}] 🗑️ unlink cleanup @ ${nowUtc()}`);
      res.json({ ok: true, removed: true });
    } catch (e) {
      console.error("unlink error:", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/runtime/validate", requireApiKey, async (req, res) => {
    try {
      const { hvac_id } = req.body || {};

      console.log(`[RuntimeValidation] Manual validation triggered for ${hvac_id || 'all thermostats'}`);

      // Run validation asynchronously and return immediately
      runValidationNow(hvac_id).catch(err => {
        console.error('[RuntimeValidation] Manual validation failed:', err.message);
      });

      res.json({
        ok: true,
        message: 'Runtime validation started',
        hvac_id: hvac_id || 'all',
        note: 'Validation running in background - check logs for results'
      });
    } catch (e) {
      console.error("runtime validation error:", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get("/runtime/debug/:hvac_id", requireApiKey, async (req, res) => {
    try {
      const { hvac_id } = req.params;

      // Get runtime state
      const rtResult = await pool.query(
        `SELECT * FROM ecobee_runtime WHERE hvac_id = $1`,
        [hvac_id]
      );

      // Get today's runtime report summary
      const today = new Date().toISOString().split('T')[0];
      const reportResult = await pool.query(
        `SELECT
          COUNT(*) as interval_count,
          SUM(aux_heat1 + aux_heat2 + aux_heat3) as total_aux_heat_seconds,
          SUM(comp_cool1 + comp_cool2) as total_cooling_seconds,
          SUM(comp_heat1 + comp_heat2) as total_heating_seconds,
          SUM(fan) as total_fan_seconds
        FROM ecobee_runtime_reports
        WHERE hvac_id = $1 AND report_date = $2`,
        [hvac_id, today]
      );

      res.json({
        ok: true,
        hvac_id,
        runtime_state: rtResult.rows[0] || null,
        todays_report: reportResult.rows[0] || null
      });
    } catch (e) {
      console.error("runtime debug error:", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.delete("/user/:user_id", requireApiKey, async (req, res) => {
    try {
      const { user_id } = req.params;

      if (!user_id || typeof user_id !== 'string' || !user_id.trim()) {
        return res.status(400).json({ ok: false, error: "Invalid or missing user_id" });
      }

      const trimmedUserId = user_id.trim();
      const deletedHvacIds = await deleteUser(trimmedUserId);

      console.log(`[${trimmedUserId}] 🗑️ user deletion - removed ${deletedHvacIds.length} thermostats @ ${nowUtc()}`);
      res.json({
        ok: true,
        removed: true,
        user_id: trimmedUserId,
        thermostats_deleted: deletedHvacIds.length,
        hvac_ids: deletedHvacIds
      });
    } catch (e) {
      console.error("user delete error:", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get("/api/v1/backfill", requireApiKey, async (req, res) => {
    try {
      const { device_key, seq_start, seq_end } = req.query;

      if (!device_key || !seq_start || !seq_end) {
        return res.status(400).json({ error: "Missing required parameters: device_key, seq_start, seq_end" });
      }

      const start = parseInt(seq_start, 10);
      const end = parseInt(seq_end, 10);

      if (isNaN(start) || isNaN(end) || start < 1 || end < start) {
        return res.status(400).json({ error: "Invalid seq_start or seq_end" });
      }

      const events = await queryOutboundEventLog(device_key, start, end);

      if (events.length === 0) {
        return res.status(404).json({ error: "Events not found" });
      }

      return res.json({ events });
    } catch (e) {
      console.error("backfill error:", e);
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/thermostat/:hvac_id", requireApiKey, async (req, res) => {
    try {
      const { hvac_id } = req.params;

      if (!hvac_id || typeof hvac_id !== 'string' || !hvac_id.trim()) {
        return res.status(400).json({ ok: false, error: "Invalid or missing hvac_id" });
      }

      const trimmedHvacId = hvac_id.trim();
      await deleteThermostat(trimmedHvacId);

      console.log(`[${trimmedHvacId}] 🗑️ thermostat deletion @ ${nowUtc()}`);
      res.json({
        ok: true,
        removed: true,
        hvac_id: trimmedHvacId
      });
    } catch (e) {
      console.error("thermostat delete error:", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return app;
}
