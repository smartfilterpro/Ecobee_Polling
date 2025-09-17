import express from "express";
import { pool, ensureSchema, upsertTokens } from "./db.js";
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
      await upsertTokens({ user_id, hvac_id, access_token, refresh_token, expires_in, scope });
      console.log(`[${hvac_id}] 🔗 link/upsert from Bubble @ ${nowUtc()}`);
      res.json({ ok: true, saved: true });
    } catch (e) {
      console.error("link error:", e);
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post("/ecobee/unlink", async (req, res) => {
    const { user_id, hvac_id } = req.body || {};
    if (!user_id || !hvac_id) return res.status(400).json({ ok: false, error: "user_id and hvac_id required" });
    await pool.query(`DELETE FROM ecobee_tokens WHERE user_id=$1 AND hvac_id=$2`, [user_id, hvac_id]);
    await pool.query(`DELETE FROM ecobee_last_state WHERE hvac_id=$1`, [hvac_id]);
    await pool.query(`DELETE FROM ecobee_runtime WHERE hvac_id=$1`, [hvac_id]);
    await pool.query(`DELETE FROM ecobee_revisions WHERE hvac_id=$1`, [hvac_id]);
    console.log(`[${hvac_id}] 🗑️ unlink cleanup @ ${nowUtc()}`);
    res.json({ ok: true, removed: true });
  });

  return app;
}
