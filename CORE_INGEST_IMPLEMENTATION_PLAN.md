# Core Ingest Implementation Plan for Runtime Validation

## Executive Summary

After reviewing the actual Core Ingest codebase, this document provides a **production-ready implementation plan** that integrates Ecobee Runtime Report validation with the existing infrastructure.

**Key Finding:** Core Ingest already has excellent runtime tracking infrastructure:
- ✅ `equipment_events` → raw thermostat events
- ✅ `runtime_sessions` → stitched sessions with calculated runtime
- ✅ `summaries_daily` → aggregated daily totals
- ✅ Workers: `sessionStitcher` + `summaryWorker`

**What We're Adding:**
- 📊 Ecobee Runtime Report ground truth data
- 🔍 Validation comparison logic
- ✅ Correction mechanism for discrepancies
- 📈 Data quality metrics

---

## Current Core Ingest Architecture

### Database Tables (Existing)

**1. equipment_events**
```sql
CREATE TABLE equipment_events (
  id UUID PRIMARY KEY,
  device_key VARCHAR(255),
  event_type VARCHAR(50),          -- "Mode_Change", "STATE_UPDATE", etc.
  is_active BOOLEAN,
  equipment_status VARCHAR(50),
  runtime_seconds INTEGER,          -- Runtime for session end events
  last_temperature NUMERIC,
  last_humidity NUMERIC,
  outdoor_temperature_f NUMERIC,
  recorded_at TIMESTAMPTZ,
  payload_raw JSONB,
  ...
);
```

**2. runtime_sessions**
```sql
CREATE TABLE runtime_sessions (
  session_id UUID PRIMARY KEY,
  device_key VARCHAR(255),
  mode VARCHAR(20),                 -- "heat", "cool", "fan", "auxheat"
  equipment_status VARCHAR(50),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  runtime_seconds INTEGER,          -- ⭐ Calculated runtime
  tick_count INTEGER,
  start_temperature NUMERIC,
  end_temperature NUMERIC,
  heat_setpoint NUMERIC,
  cool_setpoint NUMERIC,
  last_tick_at TIMESTAMPTZ,
  ...
);
```

**3. summaries_daily**
```sql
CREATE TABLE summaries_daily (
  id UUID PRIMARY KEY,
  device_id VARCHAR(255),
  date DATE,
  runtime_seconds_total INTEGER,    -- ⭐ Calculated total
  runtime_seconds_heat INTEGER,
  runtime_seconds_cool INTEGER,
  runtime_seconds_fan INTEGER,
  runtime_seconds_auxheat INTEGER,
  runtime_seconds_unknown INTEGER,
  runtime_sessions_count INTEGER,
  avg_temperature NUMERIC,
  avg_humidity NUMERIC,
  updated_at TIMESTAMPTZ,
  UNIQUE (device_id, date)
);
```

### Current Data Flow

```
Ecobee Poller
    ↓
POST /ingest/v1/events:batch
    ↓
equipment_events table
    ↓
sessionStitcher worker (continuous)
    ↓
runtime_sessions table
    ↓
summaryWorker (daily at 03:00 UTC)
    ↓
summaries_daily table
    ↓
Bubble.io Sync
```

---

## Proposed New Architecture

### New Database Tables

**1. ecobee_runtime_intervals** - Store 5-minute intervals from Ecobee Runtime Reports

```sql
CREATE TABLE ecobee_runtime_intervals (
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

CREATE INDEX idx_ecobee_intervals_device_date
  ON ecobee_runtime_intervals(device_key, report_date);
CREATE INDEX idx_ecobee_intervals_timestamp
  ON ecobee_runtime_intervals(interval_timestamp);
```

**2. Add Validation Columns to summaries_daily**

```sql
-- Add validation fields to existing summaries_daily table
ALTER TABLE summaries_daily
  ADD COLUMN validated_runtime_seconds_total INTEGER,
  ADD COLUMN validated_runtime_seconds_heat INTEGER,
  ADD COLUMN validated_runtime_seconds_cool INTEGER,
  ADD COLUMN validated_runtime_seconds_auxheat INTEGER,
  ADD COLUMN validated_runtime_seconds_fan INTEGER,
  ADD COLUMN validation_source VARCHAR(50),           -- 'ecobee_runtime_report'
  ADD COLUMN validation_interval_count INTEGER,       -- How many intervals (0-288)
  ADD COLUMN validation_coverage_percent NUMERIC(5,2), -- % of day with data
  ADD COLUMN validation_discrepancy_seconds INTEGER,  -- Difference from calculated
  ADD COLUMN validation_performed_at TIMESTAMPTZ,
  ADD COLUMN is_corrected BOOLEAN DEFAULT FALSE,
  ADD COLUMN corrected_at TIMESTAMPTZ;

-- Index for querying validated summaries
CREATE INDEX idx_summaries_validation_source
  ON summaries_daily(validation_source)
  WHERE validation_source IS NOT NULL;

CREATE INDEX idx_summaries_corrected
  ON summaries_daily(is_corrected)
  WHERE is_corrected = TRUE;
```

---

## New API Endpoints

### 1. POST /ingest/v1/runtime-report

**Purpose:** Ingest Ecobee Runtime Report intervals

**Request:**
```typescript
POST /ingest/v1/runtime-report
Authorization: Bearer ${CORE_API_KEY}
Content-Type: application/json

{
  "device_key": "hvac_123",
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
    // ... 287 more intervals (288 total for full day)
  ]
}
```

**Response:**
```json
{
  "ok": true,
  "stored": 288,
  "summary": {
    "total_runtime_seconds": 18000,
    "heating_seconds": 7200,
    "cooling_seconds": 10800,
    "auxheat_seconds": 0,
    "fan_seconds": 18000,
    "coverage_percent": 100
  }
}
```

**Implementation:**
```typescript
// src/routes/runtimeReport.ts
import express, { Request, Response } from 'express';
import { pool } from '../db/pool';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

router.post('/', async (req: Request, res: Response) => {
  const { device_key, report_date, intervals } = req.body;

  if (!device_key || !report_date || !Array.isArray(intervals)) {
    return res.status(400).json({
      ok: false,
      error: 'Missing required fields: device_key, report_date, intervals'
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let stored = 0;
    for (const interval of intervals) {
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

    // Calculate summary
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
    const coverage_percent = (summary.interval_count / 288) * 100;

    await client.query('COMMIT');

    res.json({
      ok: true,
      stored,
      summary: {
        total_runtime_seconds: parseInt(summary.total_heating) + parseInt(summary.total_cooling) + parseInt(summary.total_auxheat),
        heating_seconds: parseInt(summary.total_heating),
        cooling_seconds: parseInt(summary.total_cooling),
        auxheat_seconds: parseInt(summary.total_auxheat),
        fan_seconds: parseInt(summary.total_fan),
        coverage_percent: Math.round(coverage_percent * 100) / 100
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

---

## New Worker: Runtime Validation

### Validation Worker

**Purpose:** Compare Ecobee ground truth with calculated runtime, update summaries

**Schedule:** Daily at 04:00 UTC (after summaryWorker runs at 03:00)

**Implementation:**
```typescript
// src/workers/runtimeValidator.ts
import { Pool } from 'pg';

export async function runRuntimeValidator(pool: Pool, options?: { days?: number }) {
  const days = options?.days || 1; // Default: validate yesterday
  console.log(`🔍 Starting runtime validation worker (last ${days} day(s))...`);

  const query = `
    WITH ecobee_daily_totals AS (
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
      validated_runtime_seconds_heat = edt.validated_heating,
      validated_runtime_seconds_cool = edt.validated_cooling,
      validated_runtime_seconds_auxheat = edt.validated_auxheat,
      validated_runtime_seconds_fan = edt.validated_fan,
      validated_runtime_seconds_total = edt.validated_heating + edt.validated_cooling + edt.validated_auxheat,
      validation_source = 'ecobee_runtime_report',
      validation_interval_count = edt.interval_count,
      validation_coverage_percent = edt.coverage_percent,
      validation_discrepancy_seconds = ABS(
        (edt.validated_heating + edt.validated_cooling + edt.validated_auxheat) -
        COALESCE(ct.calculated_total, 0)
      ),
      validation_performed_at = NOW(),
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
  console.log(`✅ Validated ${result.rowCount} daily summaries`);

  // Log significant discrepancies
  const { rows } = await pool.query(`
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
  `);

  if (rows.length > 0) {
    console.warn(`⚠️ Found ${rows.length} significant discrepancies (>5 min):`);
    rows.forEach(r => {
      console.warn(`  ${r.device_id} on ${r.date}: ${r.calculated}s → ${r.validated}s (${Math.round(r.discrepancy / 60)}min off, ${r.coverage}% coverage)`);
    });
  }

  return { validated: result.rowCount, discrepancies: rows.length };
}
```

**Add to package.json:**
```json
{
  "scripts": {
    "worker:validate": "ts-node src/workers/runRuntimeValidator.ts"
  }
}
```

**Add to Procfile for Railway:**
```
worker-validate-daily: npm run worker:validate
```

**Railway Cron Schedule:** `0 4 * * *` (daily at 04:00 UTC)

---

## Updated Query Patterns

### For Analytics (Use Validated Runtime When Available)

```sql
-- Get daily runtime with validation status
SELECT
  device_id,
  date,
  CASE
    WHEN validation_source IS NOT NULL THEN validated_runtime_seconds_total
    ELSE runtime_seconds_total
  END as runtime_seconds,
  CASE
    WHEN validation_source IS NOT NULL THEN validated_runtime_seconds_heat
    ELSE runtime_seconds_heat
  END as heating_seconds,
  CASE
    WHEN validation_source IS NOT NULL THEN validated_runtime_seconds_cool
    ELSE runtime_seconds_cool
  END as cooling_seconds,
  validation_coverage_percent,
  validation_discrepancy_seconds,
  is_corrected
FROM summaries_daily
WHERE device_id = 'device_123'
  AND date BETWEEN '2024-11-01' AND '2024-11-30'
ORDER BY date;
```

### For Data Quality Reporting

```sql
-- Find devices with frequent discrepancies
SELECT
  device_id,
  COUNT(*) as days_with_discrepancies,
  AVG(validation_discrepancy_seconds) as avg_discrepancy_seconds,
  MAX(validation_discrepancy_seconds) as max_discrepancy_seconds,
  AVG(validation_coverage_percent) as avg_coverage_percent
FROM summaries_daily
WHERE validation_discrepancy_seconds > 300
  AND date >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY device_id
ORDER BY avg_discrepancy_seconds DESC;
```

---

## Migration Plan

### Phase 1: Database Changes (Week 1)

**Day 1-2:**
```bash
# Create new tables
psql $DATABASE_URL < migrations/008_add_ecobee_runtime_intervals.sql
psql $DATABASE_URL < migrations/009_add_validation_to_summaries.sql
```

**Day 3-4:**
- Deploy new `/ingest/v1/runtime-report` endpoint
- Test with sample Ecobee data
- Verify storage

**Day 5:**
- Deploy validation worker
- Test on staging with backfilled data

### Phase 2: Ecobee Integration (Week 2)

**Day 1-2:**
- Update Ecobee poller to post runtime reports
- Test daily validation job
- Monitor logs

**Day 3-4:**
- Enable for production devices
- Verify validation runs daily
- Check for discrepancies

**Day 5:**
- Performance testing
- Query optimization if needed

### Phase 3: Analytics Migration (Week 3)

**Day 1-3:**
- Update Bubble.io sync to use validated runtime
- Add validation metrics to dashboards
- Show data quality indicators

**Day 4-5:**
- User testing
- Documentation
- Training

---

## Rollback Plan

### If Issues Arise

**Option 1: Disable Validation (No Data Loss)**
```sql
-- Stop using validated values in queries
-- Just query runtime_seconds_total (original calculated values)
SELECT runtime_seconds_total FROM summaries_daily;
```

**Option 2: Revert Columns**
```sql
-- Drop validation columns (keep intervals table for future use)
ALTER TABLE summaries_daily
  DROP COLUMN validated_runtime_seconds_total,
  DROP COLUMN validated_runtime_seconds_heat,
  DROP COLUMN validated_runtime_seconds_cool,
  DROP COLUMN validated_runtime_seconds_auxheat,
  DROP COLUMN validated_runtime_seconds_fan,
  DROP COLUMN validation_source,
  DROP COLUMN validation_interval_count,
  DROP COLUMN validation_coverage_percent,
  DROP COLUMN validation_discrepancy_seconds,
  DROP COLUMN validation_performed_at,
  DROP COLUMN is_corrected,
  DROP COLUMN corrected_at;
```

**Option 3: Drop Intervals Table**
```sql
DROP TABLE ecobee_runtime_intervals;
```

**All rollback options are non-destructive - original data preserved.**

---

## Testing Checklist

### Unit Tests
- [ ] POST /ingest/v1/runtime-report with valid data
- [ ] POST with invalid data (bad timestamps, out-of-range values)
- [ ] POST with duplicate intervals (idempotency)
- [ ] Validation worker with matching data
- [ ] Validation worker with discrepancies
- [ ] Query patterns with validated vs calculated runtime

### Integration Tests
- [ ] End-to-end: Ecobee poller → Core Ingest → Validation
- [ ] Verify summaries_daily gets validated fields
- [ ] Check is_corrected flag on significant discrepancies
- [ ] Ensure existing summaries without validation still work

### Performance Tests
- [ ] Bulk insert 288 intervals per device
- [ ] Validation worker on 100 devices
- [ ] Query performance with new indexes

### Compatibility Tests
- [ ] Nest devices without validation data still work
- [ ] Honeywell devices without validation data still work
- [ ] Existing summaries API unchanged
- [ ] Bubble.io sync compatibility

---

## Monitoring & Alerts

### Metrics to Track

1. **Validation Coverage**
   - % of devices with validated runtime
   - Average coverage % per day

2. **Discrepancy Rate**
   - % of days with >5min discrepancy
   - Average discrepancy per device

3. **Worker Health**
   - Validation worker success rate
   - Processing time

4. **Data Quality**
   - Interval completeness (288/288)
   - Missing days

### Alerts to Configure

```sql
-- Alert if validation hasn't run in 25 hours
SELECT device_id, MAX(validation_performed_at)
FROM summaries_daily
WHERE validation_source = 'ecobee_runtime_report'
GROUP BY device_id
HAVING MAX(validation_performed_at) < NOW() - INTERVAL '25 hours';

-- Alert if >20% of devices have significant discrepancies
SELECT
  COUNT(DISTINCT device_id) * 100.0 / (SELECT COUNT(DISTINCT device_id) FROM summaries_daily) as pct
FROM summaries_daily
WHERE validation_discrepancy_seconds > 300
  AND date = CURRENT_DATE - 1;
```

---

## Summary

**What We're Building:**
- ✅ New table to store Ecobee's 5-minute interval data
- ✅ Validation columns in existing summaries_daily table
- ✅ New endpoint to ingest runtime reports
- ✅ Validation worker to compare and correct
- ✅ Zero breaking changes to existing functionality

**Benefits:**
- 📊 100% accurate runtime from Ecobee's ground truth
- 🔍 Automated discrepancy detection
- ✅ Corrections applied automatically
- 📈 Data quality metrics for monitoring
- 🏗️ Works alongside existing architecture

**Risk Level:** **VERY LOW**
- New tables are independent
- Existing tables only get new nullable columns
- Existing queries unchanged
- Can rollback at any time

**Timeline:** 3 weeks total
- Week 1: Database + API
- Week 2: Ecobee integration
- Week 3: Analytics migration

---

## Next Steps

1. **Review this plan** with Core Ingest team
2. **Create migrations** (008, 009)
3. **Implement `/ingest/v1/runtime-report`** endpoint
4. **Implement validation worker**
5. **Update Ecobee poller** to post runtime reports
6. **Deploy to staging** for testing
7. **Production rollout**

**Questions?** See CORE_INGEST_SCHEMA_PROPOSAL.md for more detailed schema design options.
