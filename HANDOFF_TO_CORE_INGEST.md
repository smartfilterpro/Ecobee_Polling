# Core-ingest Implementation Handoff

## 🎯 Mission

Implement Ecobee Runtime Report validation in the Core-ingest repository. All design work is complete, code is ready to copy-paste. Your job is to implement, test, and deploy.

**Estimated time:** 2-4 hours

---

## 📚 Required Reading

**Main Reference:** [CORE_INGEST_IMPLEMENTATION_PLAN.md](./CORE_INGEST_IMPLEMENTATION_PLAN.md)

This contains:
- Complete SQL for migrations
- Full TypeScript code for endpoint
- Complete worker implementation
- All testing instructions

**Supporting Docs:**
- [RUNTIME_VALIDATION.md](./RUNTIME_VALIDATION.md) - How runtime validation works
- [CORE_INGEST_INTEGRATION.md](./CORE_INGEST_INTEGRATION.md) - Integration analysis

---

## 🎯 Your Tasks

### Task 1: Create Database Migrations (30 min)

**File 1:** `src/db/migrations/008_add_ecobee_runtime_intervals.sql`

```sql
-- Migration 008: Add ecobee_runtime_intervals table
-- Purpose: Store 5-minute interval data from Ecobee Runtime Reports

CREATE TABLE IF NOT EXISTS ecobee_runtime_intervals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_key VARCHAR(255) NOT NULL,
  report_date DATE NOT NULL,
  interval_timestamp TIMESTAMPTZ NOT NULL,

  -- Equipment runtime (seconds, 0-300 per 5-min interval)
  aux_heat1_seconds INTEGER DEFAULT 0,
  aux_heat2_seconds INTEGER DEFAULT 0,
  aux_heat3_seconds INTEGER DEFAULT 0,
  comp_cool1_seconds INTEGER DEFAULT 0,
  comp_cool2_seconds INTEGER DEFAULT 0,
  comp_heat1_seconds INTEGER DEFAULT 0,
  comp_heat2_seconds INTEGER DEFAULT 0,
  fan_seconds INTEGER DEFAULT 0,

  -- Telemetry
  outdoor_temp_f NUMERIC(5,2),
  zone_avg_temp_f NUMERIC(5,2),
  zone_humidity INTEGER,
  hvac_mode VARCHAR(20),

  -- Metadata
  data_source VARCHAR(50) DEFAULT 'ecobee_runtime_report',
  created_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (device_key, interval_timestamp),
  CONSTRAINT valid_interval_seconds CHECK (
    aux_heat1_seconds BETWEEN 0 AND 300 AND
    aux_heat2_seconds BETWEEN 0 AND 300 AND
    aux_heat3_seconds BETWEEN 0 AND 300 AND
    comp_cool1_seconds BETWEEN 0 AND 300 AND
    comp_cool2_seconds BETWEEN 0 AND 300 AND
    comp_heat1_seconds BETWEEN 0 AND 300 AND
    comp_heat2_seconds BETWEEN 0 AND 300 AND
    fan_seconds BETWEEN 0 AND 300
  )
);

-- Indexes for performance
CREATE INDEX idx_ecobee_intervals_device_date
  ON ecobee_runtime_intervals(device_key, report_date);
CREATE INDEX idx_ecobee_intervals_timestamp
  ON ecobee_runtime_intervals(interval_timestamp);

-- Add comment
COMMENT ON TABLE ecobee_runtime_intervals IS
  'Stores 5-minute interval data from Ecobee Runtime Reports (ground truth)';
```

**File 2:** `src/db/migrations/009_add_validation_columns.sql`

```sql
-- Migration 009: Add validation columns to summaries_daily
-- Purpose: Store validated runtime from Ecobee reports and track discrepancies

ALTER TABLE summaries_daily
  ADD COLUMN IF NOT EXISTS validated_runtime_seconds_total INTEGER,
  ADD COLUMN IF NOT EXISTS validated_runtime_seconds_heat INTEGER,
  ADD COLUMN IF NOT EXISTS validated_runtime_seconds_cool INTEGER,
  ADD COLUMN IF NOT EXISTS validated_runtime_seconds_auxheat INTEGER,
  ADD COLUMN IF NOT EXISTS validated_runtime_seconds_fan INTEGER,
  ADD COLUMN IF NOT EXISTS validation_source VARCHAR(50),
  ADD COLUMN IF NOT EXISTS validation_interval_count INTEGER,
  ADD COLUMN IF NOT EXISTS validation_coverage_percent NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS validation_discrepancy_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS validation_performed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_corrected BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS corrected_at TIMESTAMPTZ;

-- Indexes for querying validated summaries
CREATE INDEX IF NOT EXISTS idx_summaries_validation_source
  ON summaries_daily(validation_source)
  WHERE validation_source IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_summaries_corrected
  ON summaries_daily(is_corrected)
  WHERE is_corrected = TRUE;

-- Add comments
COMMENT ON COLUMN summaries_daily.validated_runtime_seconds_total IS
  'Runtime total from Ecobee Runtime Report (ground truth)';
COMMENT ON COLUMN summaries_daily.validation_discrepancy_seconds IS
  'Difference between calculated and validated runtime (absolute value)';
COMMENT ON COLUMN summaries_daily.is_corrected IS
  'TRUE if discrepancy > 300 seconds (5 minutes)';
```

**Run migrations:**
```bash
# Test on local DB first
psql $DATABASE_URL -f src/db/migrations/008_add_ecobee_runtime_intervals.sql
psql $DATABASE_URL -f src/db/migrations/009_add_validation_columns.sql

# Verify
psql $DATABASE_URL -c "\d ecobee_runtime_intervals"
psql $DATABASE_URL -c "\d summaries_daily" | grep validation
```

---

### Task 2: Create Runtime Report Endpoint (1 hour)

**File:** `src/routes/runtimeReport.ts`

```typescript
import express, { Request, Response } from 'express';
import { pool } from '../db/pool';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

/**
 * POST /ingest/v1/runtime-report
 * Ingest Ecobee Runtime Report intervals
 *
 * Body: {
 *   device_key: string,
 *   report_date: string (YYYY-MM-DD),
 *   intervals: Array<{
 *     interval_timestamp: string (ISO 8601),
 *     aux_heat1_seconds: number (0-300),
 *     comp_cool1_seconds: number (0-300),
 *     comp_heat1_seconds: number (0-300),
 *     fan_seconds: number (0-300),
 *     outdoor_temp_f: number,
 *     zone_avg_temp_f: number,
 *     zone_humidity: number,
 *     hvac_mode: string
 *   }>
 * }
 */
router.post('/', async (req: Request, res: Response) => {
  const { device_key, report_date, intervals } = req.body;

  // Validation
  if (!device_key || typeof device_key !== 'string') {
    return res.status(400).json({
      ok: false,
      error: 'device_key is required and must be a string'
    });
  }

  if (!report_date || !/^\d{4}-\d{2}-\d{2}$/.test(report_date)) {
    return res.status(400).json({
      ok: false,
      error: 'report_date is required and must be YYYY-MM-DD format'
    });
  }

  if (!Array.isArray(intervals) || intervals.length === 0) {
    return res.status(400).json({
      ok: false,
      error: 'intervals must be a non-empty array'
    });
  }

  console.log(`[runtime-report] Ingesting ${intervals.length} intervals for ${device_key} on ${report_date}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let stored = 0;
    for (const interval of intervals) {
      // Validate interval
      if (!interval.interval_timestamp) {
        console.warn(`[runtime-report] Skipping interval with missing timestamp`);
        continue;
      }

      await client.query(`
        INSERT INTO ecobee_runtime_intervals (
          device_key, report_date, interval_timestamp,
          aux_heat1_seconds, aux_heat2_seconds, aux_heat3_seconds,
          comp_cool1_seconds, comp_cool2_seconds,
          comp_heat1_seconds, comp_heat2_seconds,
          fan_seconds,
          outdoor_temp_f, zone_avg_temp_f, zone_humidity, hvac_mode
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT (device_key, interval_timestamp)
        DO UPDATE SET
          aux_heat1_seconds = EXCLUDED.aux_heat1_seconds,
          aux_heat2_seconds = EXCLUDED.aux_heat2_seconds,
          aux_heat3_seconds = EXCLUDED.aux_heat3_seconds,
          comp_cool1_seconds = EXCLUDED.comp_cool1_seconds,
          comp_cool2_seconds = EXCLUDED.comp_cool2_seconds,
          comp_heat1_seconds = EXCLUDED.comp_heat1_seconds,
          comp_heat2_seconds = EXCLUDED.comp_heat2_seconds,
          fan_seconds = EXCLUDED.fan_seconds,
          outdoor_temp_f = EXCLUDED.outdoor_temp_f,
          zone_avg_temp_f = EXCLUDED.zone_avg_temp_f,
          zone_humidity = EXCLUDED.zone_humidity,
          hvac_mode = EXCLUDED.hvac_mode
      `, [
        device_key,
        report_date,
        interval.interval_timestamp,
        interval.aux_heat1_seconds || 0,
        interval.aux_heat2_seconds || 0,
        interval.aux_heat3_seconds || 0,
        interval.comp_cool1_seconds || 0,
        interval.comp_cool2_seconds || 0,
        interval.comp_heat1_seconds || 0,
        interval.comp_heat2_seconds || 0,
        interval.fan_seconds || 0,
        interval.outdoor_temp_f || null,
        interval.zone_avg_temp_f || null,
        interval.zone_humidity || null,
        interval.hvac_mode || null
      ]);
      stored++;
    }

    // Calculate summary totals
    const { rows } = await client.query(`
      SELECT
        COALESCE(SUM(aux_heat1_seconds + aux_heat2_seconds + aux_heat3_seconds), 0) as total_auxheat,
        COALESCE(SUM(comp_cool1_seconds + comp_cool2_seconds), 0) as total_cooling,
        COALESCE(SUM(comp_heat1_seconds + comp_heat2_seconds), 0) as total_heating,
        COALESCE(SUM(fan_seconds), 0) as total_fan,
        COUNT(*) as interval_count
      FROM ecobee_runtime_intervals
      WHERE device_key = $1 AND report_date = $2
    `, [device_key, report_date]);

    const summary = rows[0];
    const total_runtime = parseInt(summary.total_heating) +
                         parseInt(summary.total_cooling) +
                         parseInt(summary.total_auxheat);
    const coverage_percent = (parseInt(summary.interval_count) / 288) * 100;

    await client.query('COMMIT');

    console.log(`[runtime-report] ✅ Stored ${stored} intervals for ${device_key}`);
    console.log(`[runtime-report] Summary: ${total_runtime}s total, ${coverage_percent.toFixed(1)}% coverage`);

    res.json({
      ok: true,
      stored,
      summary: {
        total_runtime_seconds: total_runtime,
        heating_seconds: parseInt(summary.total_heating),
        cooling_seconds: parseInt(summary.total_cooling),
        auxheat_seconds: parseInt(summary.total_auxheat),
        fan_seconds: parseInt(summary.total_fan),
        coverage_percent: Math.round(coverage_percent * 100) / 100,
        interval_count: parseInt(summary.interval_count)
      }
    });

  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('[runtime-report/POST] Error:', err);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    client.release();
  }
});

export default router;
```

**Register route in `src/server.ts`:**

```typescript
// Add import at top
import runtimeReportRouter from "./routes/runtimeReport";

// Add route registration (around line 40-50, with other routes)
app.use("/ingest/v1/runtime-report", runtimeReportRouter);
```

---

### Task 3: Create Validation Worker (1 hour)

**File:** `src/workers/runtimeValidator.ts`

```typescript
import { Pool } from 'pg';

/**
 * Runtime Validation Worker
 *
 * Compares Ecobee's ground-truth runtime data (from Runtime Reports)
 * with our calculated runtime (from sessionStitcher + summaryWorker).
 *
 * Updates summaries_daily with validated values and flags discrepancies.
 *
 * Schedule: Daily at 04:00 UTC (runs after summaryWorker at 03:00 UTC)
 */
export async function runRuntimeValidator(pool: Pool, options?: { days?: number }) {
  const days = options?.days || 1; // Default: validate yesterday
  console.log(`\n🔍 [RuntimeValidator] Starting validation for last ${days} day(s)...`);
  const startTime = Date.now();

  try {
    const query = `
      WITH ecobee_daily_totals AS (
        -- Aggregate Ecobee's ground truth from 5-minute intervals
        SELECT
          device_key,
          report_date,
          SUM(aux_heat1_seconds + aux_heat2_seconds + aux_heat3_seconds) as validated_auxheat,
          SUM(comp_cool1_seconds + comp_cool2_seconds) as validated_cooling,
          SUM(comp_heat1_seconds + comp_heat2_seconds) as validated_heating,
          SUM(fan_seconds) as validated_fan,
          COUNT(*) as interval_count,
          (COUNT(*) * 100.0 / 288) as coverage_percent
        FROM ecobee_runtime_intervals
        WHERE report_date >= CURRENT_DATE - INTERVAL '${days} days'
        GROUP BY device_key, report_date
      ),
      calculated_totals AS (
        -- Get our calculated runtime from summaries_daily
        SELECT
          d.device_key,
          s.date,
          s.runtime_seconds_heat as calculated_heating,
          s.runtime_seconds_cool as calculated_cooling,
          s.runtime_seconds_auxheat as calculated_auxheat,
          s.runtime_seconds_fan as calculated_fan,
          s.runtime_seconds_total as calculated_total
        FROM summaries_daily s
        INNER JOIN devices d ON d.device_id = s.device_id
        WHERE s.date >= CURRENT_DATE - INTERVAL '${days} days'
      )
      UPDATE summaries_daily s
      SET
        -- Store validated values
        validated_runtime_seconds_heat = edt.validated_heating,
        validated_runtime_seconds_cool = edt.validated_cooling,
        validated_runtime_seconds_auxheat = edt.validated_auxheat,
        validated_runtime_seconds_fan = edt.validated_fan,
        validated_runtime_seconds_total = edt.validated_heating + edt.validated_cooling + edt.validated_auxheat,

        -- Validation metadata
        validation_source = 'ecobee_runtime_report',
        validation_interval_count = edt.interval_count,
        validation_coverage_percent = edt.coverage_percent,
        validation_discrepancy_seconds = ABS(
          (edt.validated_heating + edt.validated_cooling + edt.validated_auxheat) -
          COALESCE(ct.calculated_total, 0)
        ),
        validation_performed_at = NOW(),

        -- Flag significant discrepancies (>5 minutes)
        is_corrected = CASE
          WHEN ABS(
            (edt.validated_heating + edt.validated_cooling + edt.validated_auxheat) -
            COALESCE(ct.calculated_total, 0)
          ) > 300 THEN TRUE
          ELSE FALSE
        END,
        corrected_at = CASE
          WHEN ABS(
            (edt.validated_heating + edt.validated_cooling + edt.validated_auxheat) -
            COALESCE(ct.calculated_total, 0)
          ) > 300 THEN NOW()
          ELSE NULL
        END
      FROM ecobee_daily_totals edt
      INNER JOIN devices d ON d.device_key = edt.device_key
      LEFT JOIN calculated_totals ct ON ct.device_key = edt.device_key AND ct.date = edt.report_date
      WHERE s.device_id = d.device_id AND s.date = edt.report_date
    `;

    const result = await pool.query(query);
    const duration = Math.round((Date.now() - startTime) / 1000);

    console.log(`[RuntimeValidator] ✅ Validated ${result.rowCount} daily summaries in ${duration}s`);

    // Log significant discrepancies
    const { rows: discrepancies } = await pool.query(`
      SELECT
        device_id,
        date,
        runtime_seconds_total as calculated,
        validated_runtime_seconds_total as validated,
        validation_discrepancy_seconds as discrepancy,
        validation_coverage_percent as coverage
      FROM summaries_daily
      WHERE validation_discrepancy_seconds > 300
        AND validation_performed_at >= NOW() - INTERVAL '1 hour'
      ORDER BY validation_discrepancy_seconds DESC
      LIMIT 20
    `);

    if (discrepancies.length > 0) {
      console.warn(`[RuntimeValidator] ⚠️ Found ${discrepancies.length} significant discrepancies (>5 min):`);
      discrepancies.forEach(r => {
        const discrepMin = Math.round(r.discrepancy / 60);
        console.warn(
          `  ${r.device_id} on ${r.date}: ` +
          `calculated=${r.calculated}s, validated=${r.validated}s, ` +
          `discrepancy=${discrepMin}min, coverage=${r.coverage?.toFixed(1)}%`
        );
      });
    } else {
      console.log(`[RuntimeValidator] ✅ No significant discrepancies found`);
    }

    // Summary stats
    const { rows: stats } = await pool.query(`
      SELECT
        COUNT(*) as total_validated,
        COUNT(*) FILTER (WHERE is_corrected = TRUE) as corrected_count,
        AVG(validation_coverage_percent) as avg_coverage,
        AVG(validation_discrepancy_seconds) as avg_discrepancy
      FROM summaries_daily
      WHERE validation_performed_at >= NOW() - INTERVAL '1 hour'
    `);

    if (stats[0]) {
      console.log(`[RuntimeValidator] 📊 Stats:`);
      console.log(`  Total validated: ${stats[0].total_validated}`);
      console.log(`  Corrected: ${stats[0].corrected_count}`);
      console.log(`  Avg coverage: ${stats[0].avg_coverage?.toFixed(1)}%`);
      console.log(`  Avg discrepancy: ${Math.round(stats[0].avg_discrepancy || 0)}s`);
    }

    return {
      validated: result.rowCount,
      discrepancies: discrepancies.length,
      stats: stats[0]
    };

  } catch (err: any) {
    console.error('[RuntimeValidator] ❌ Error:', err.message);
    throw err;
  }
}
```

**File:** `src/workers/runRuntimeValidator.ts` (wrapper for CLI)

```typescript
import { pool } from '../db/pool';
import { runRuntimeValidator } from './runtimeValidator';

(async () => {
  try {
    console.log('Starting Runtime Validator...\n');

    // Get days from command line args (default: 1)
    const days = parseInt(process.argv[2]) || 1;

    const result = await runRuntimeValidator(pool, { days });

    console.log('\n✅ Validation complete');
    process.exit(0);
  } catch (err: any) {
    console.error('\n❌ Validation failed:', err.message);
    process.exit(1);
  }
})();
```

**Update `package.json`:**

```json
{
  "scripts": {
    "worker:validate": "ts-node src/workers/runRuntimeValidator.ts",
    "worker:validate:week": "ts-node src/workers/runRuntimeValidator.ts 7"
  }
}
```

---

### Task 4: Testing (30-60 min)

**Test 1: Run Migrations**
```bash
npm run migrate
# Verify tables exist
psql $DATABASE_URL -c "\dt ecobee_runtime_intervals"
```

**Test 2: Test Endpoint Manually**

Create `test-runtime-report.json`:
```json
{
  "device_key": "test_device_123",
  "report_date": "2024-11-02",
  "intervals": [
    {
      "interval_timestamp": "2024-11-02T00:00:00Z",
      "aux_heat1_seconds": 0,
      "comp_cool1_seconds": 180,
      "comp_heat1_seconds": 0,
      "fan_seconds": 180,
      "outdoor_temp_f": 45.2,
      "zone_avg_temp_f": 72.1,
      "zone_humidity": 45,
      "hvac_mode": "cool"
    },
    {
      "interval_timestamp": "2024-11-02T00:05:00Z",
      "aux_heat1_seconds": 0,
      "comp_cool1_seconds": 300,
      "comp_heat1_seconds": 0,
      "fan_seconds": 300,
      "outdoor_temp_f": 45.3,
      "zone_avg_temp_f": 71.8,
      "zone_humidity": 46,
      "hvac_mode": "cool"
    }
  ]
}
```

Test it:
```bash
# Start server
npm run dev

# In another terminal:
curl -X POST http://localhost:3000/ingest/v1/runtime-report \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${CORE_API_KEY}" \
  -d @test-runtime-report.json

# Expected response:
# {
#   "ok": true,
#   "stored": 2,
#   "summary": {
#     "total_runtime_seconds": 480,
#     "cooling_seconds": 480,
#     ...
#   }
# }
```

**Test 3: Verify Data Stored**
```bash
psql $DATABASE_URL -c "
  SELECT * FROM ecobee_runtime_intervals
  WHERE device_key = 'test_device_123'
  ORDER BY interval_timestamp
"
```

**Test 4: Run Validation Worker**
```bash
# First ensure you have summary data
psql $DATABASE_URL -c "
  INSERT INTO devices (device_key, device_id, workspace_id, user_id)
  VALUES ('test_device_123', 'test_123', 'test_workspace', 'test_user')
  ON CONFLICT DO NOTHING;

  INSERT INTO summaries_daily (device_id, date, runtime_seconds_total, runtime_seconds_cool)
  VALUES ('test_123', '2024-11-02', 400, 400)
  ON CONFLICT (device_id, date) DO UPDATE
  SET runtime_seconds_total = 400, runtime_seconds_cool = 400;
"

# Run validator
npm run worker:validate

# Check results
psql $DATABASE_URL -c "
  SELECT
    device_id,
    date,
    runtime_seconds_total as calculated,
    validated_runtime_seconds_total as validated,
    validation_discrepancy_seconds as discrepancy,
    is_corrected
  FROM summaries_daily
  WHERE device_id = 'test_123'
    AND date = '2024-11-02'
"

# Expected: discrepancy = 80 seconds (480 - 400)
```

---

### Task 5: Deploy (30 min)

**Commit Changes:**
```bash
git add .
git status  # Verify files

git commit -m "Add Ecobee Runtime Report validation

Implements ground-truth runtime validation:
- New table: ecobee_runtime_intervals (5-min interval data)
- New columns in summaries_daily for validated values
- New endpoint: POST /ingest/v1/runtime-report
- New worker: runtimeValidator (compares calculated vs validated)

Changes are 100% backward compatible:
- Other thermostat brands unaffected
- All new columns nullable
- Existing queries unchanged

Migrations:
- 008_add_ecobee_runtime_intervals.sql
- 009_add_validation_columns.sql

Files added:
- src/routes/runtimeReport.ts
- src/workers/runtimeValidator.ts
- src/workers/runRuntimeValidator.ts"

git push
```

**Deploy to Production:**
```bash
# If using Railway, Heroku, etc., push triggers deploy
# Or manually deploy however you normally do

# After deploy, verify endpoint is live
curl https://your-core-ingest-url.com/ingest/v1/runtime-report
# Should return 400 (missing body) not 404 (route not found)
```

**Set up Cron Job (Railway):**
```bash
# In Railway dashboard:
# Add new cron trigger:
# Name: worker-validate-daily
# Schedule: 0 4 * * * (daily at 04:00 UTC)
# Command: npm run worker:validate
```

---

## 🧪 Comprehensive Testing Checklist

After deployment, verify:

- [ ] Migrations ran successfully
- [ ] `ecobee_runtime_intervals` table exists
- [ ] New columns in `summaries_daily` exist
- [ ] POST /ingest/v1/runtime-report endpoint responds
- [ ] Can post test runtime report
- [ ] Data appears in `ecobee_runtime_intervals`
- [ ] Validation worker runs without errors
- [ ] Validation updates `summaries_daily` correctly
- [ ] Existing Nest/Honeywell devices unaffected
- [ ] Existing summary queries still work
- [ ] Cron job scheduled (if using Railway/Heroku)

---

## 📊 Monitoring

**Check validation is running:**
```sql
SELECT
  MAX(validation_performed_at) as last_validation,
  COUNT(*) as validated_days,
  COUNT(*) FILTER (WHERE is_corrected = TRUE) as corrections
FROM summaries_daily
WHERE validation_source = 'ecobee_runtime_report';
```

**Check for discrepancies:**
```sql
SELECT
  device_id,
  date,
  validation_discrepancy_seconds / 60.0 as discrepancy_minutes,
  validation_coverage_percent
FROM summaries_daily
WHERE is_corrected = TRUE
ORDER BY validation_discrepancy_seconds DESC
LIMIT 10;
```

**Check data quality:**
```sql
SELECT
  report_date,
  COUNT(DISTINCT device_key) as device_count,
  AVG(interval_count) as avg_intervals,
  AVG(interval_count * 100.0 / 288) as avg_coverage_pct
FROM (
  SELECT
    device_key,
    report_date,
    COUNT(*) as interval_count
  FROM ecobee_runtime_intervals
  GROUP BY device_key, report_date
) sub
GROUP BY report_date
ORDER BY report_date DESC
LIMIT 7;
```

---

## 🚨 Troubleshooting

**Endpoint returns 404:**
- Check `src/server.ts` has route registered
- Restart server
- Check route path is exactly `/ingest/v1/runtime-report`

**Validation worker finds no data:**
- Check `ecobee_runtime_intervals` has data
- Check `summaries_daily` has data for same date
- Check device_key matches between tables

**Other brands stopped working:**
- This should NOT happen (backward compatible)
- Check existing `/ingest/v1/events:batch` endpoint
- Check `equipment_events` table still accepting data
- Check sessionStitcher still running

---

## 🎯 Success Criteria

You're done when:

✅ Migrations applied successfully
✅ Endpoint `/ingest/v1/runtime-report` accepting data
✅ `ecobee_runtime_intervals` table receiving intervals
✅ Validation worker running and updating `summaries_daily`
✅ Test shows validated values and discrepancy calculated
✅ Existing Nest/Honeywell devices still working
✅ Cron job scheduled (if applicable)
✅ Changes committed and pushed

---

## 📞 Handoff Back to Ecobee_Polling Session

After Core-ingest is deployed, return to the Ecobee_Polling session and say:

```
Core-ingest changes deployed successfully.

Endpoint available: POST /ingest/v1/runtime-report
Validation worker running daily at 04:00 UTC

Ready to enable Ecobee poller to post runtime reports.
```

Then we'll update the Ecobee poller to call the new endpoint.

---

## 📚 Quick Reference

**Endpoint:** `POST /ingest/v1/runtime-report`
**Auth:** Bearer token in Authorization header
**Body:** `{ device_key, report_date, intervals: [...] }`

**Worker:** `npm run worker:validate`
**Schedule:** Daily at 04:00 UTC (via cron)

**Tables:**
- `ecobee_runtime_intervals` - Raw 5-min intervals from Ecobee
- `summaries_daily` - Existing, now has validation columns

**Validation columns:**
- `validated_runtime_seconds_total` - Ground truth from Ecobee
- `validation_discrepancy_seconds` - Difference from calculated
- `is_corrected` - TRUE if discrepancy > 5 minutes
- `validation_coverage_percent` - % of day with data (0-100)

---

## 🎓 Need Help?

Reference documents in Ecobee_Polling repo:
- `CORE_INGEST_IMPLEMENTATION_PLAN.md` - Detailed technical spec
- `RUNTIME_VALIDATION.md` - How validation works
- `CORE_INGEST_INTEGRATION.md` - Integration architecture

All code above is copy-paste ready. If you hit issues:
1. Check migrations ran
2. Check route is registered
3. Check auth headers
4. Check database has test data

Good luck! 🚀
