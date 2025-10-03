import express from "express";
import { pool, upsertTokens } from "./db.js";
import { nowUtc } from "./util.js";

export function buildServer() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ ok: true, time: nowUtc() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/ecobee/link", async (req, res) => {
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

  app.post("/ecobee/unlink", async (req, res) => {
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
      
      console.log(`[${trimmedHvacId}] 🗑️ unlink cleanup @ ${nowUtc()}`);
      res.json({ ok: true, removed: true });
    } catch (e) {
      console.error("unlink error:", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return app;
}
