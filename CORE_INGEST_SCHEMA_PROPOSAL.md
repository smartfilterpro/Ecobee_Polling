# Core Ingest Schema Proposal for Runtime Validation

## Executive Summary

This document proposes **backward-compatible** schema changes to Core Ingest to support validated runtime data from Ecobee Runtime Reports, while ensuring compatibility with other thermostat brands (Nest, Honeywell, etc.).

**Key Principles:**
1. ✅ **100% Backward Compatible** - All existing fields remain unchanged
2. ✅ **Optional Fields Only** - New fields are nullable/optional
3. ✅ **Works for All Brands** - Ecobee-specific fields are clearly namespaced
4. ✅ **No Breaking Changes** - Existing integrations continue to work

---

## Current Payload Structure

### Endpoint
```
POST /ingest/v1/events:batch
Content-Type: application/json
Authorization: Bearer ${CORE_API_KEY}
```

### Current Event Schema

Based on `src/coreIngest.js:buildCorePayload()`:

```typescript
interface ThermostatEvent {
  // Device identification
  device_key: string;
  device_id: string;
  user_id: string | null;
  workspace_id: string | null;
  device_name: string;

  // Device metadata
  manufacturer: string;              // "Ecobee", "Nest", "Honeywell", etc.
  model: string;
  device_type: string;               // "thermostat"
  source: string;                    // "ecobee", "nest", etc.
  source_vendor: string;
  connection_source: string;
  firmware_version: string | null;
  serial_number: string | null;
  timezone: string | null;
  zip_prefix: string | null;
  zip_code_prefix: string | null;

  // Current equipment state
  last_mode: string | null;
  last_is_cooling: boolean;
  last_is_heating: boolean;
  last_is_fan_only: boolean;
  last_equipment_status: string | null;
  is_reachable: boolean;

  // Indoor telemetry
  last_temperature: number | null;
  temperature_f: number | null;
  temperature_c: number | null;
  last_humidity: number | null;
  humidity: number | null;
  last_heat_setpoint: number | null;
  heat_setpoint_f: number | null;
  last_cool_setpoint: number | null;
  cool_setpoint_f: number | null;
  thermostat_mode: string | null;

  // Outdoor telemetry
  outdoor_temperature_f: number | null;
  outdoor_humidity: number | null;
  pressure_hpa: number | null;

  // Event data
  event_type: string;                // "Mode_Change", "Connectivity_Change", "STATE_UPDATE"
  is_active: boolean;
  equipment_status: string;
  previous_status: string;
  runtime_seconds: number | null;    // ⭐ Current runtime field
  timestamp: string;                 // ISO 8601
  recorded_at: string;               // ISO 8601
  observed_at: string;               // ISO 8601

  // Metadata
  source_event_id: string;           // UUID
  payload_raw: object | null;        // Arbitrary JSON
}
```

### Current Event Types

**From Ecobee Integration:**
- `Mode_Change` - Equipment turns on/off
- `Connectivity_Change` - Device connects/disconnects
- `STATE_UPDATE` - Temperature/setpoint changes
- `RUNTIME_VALIDATION_MISMATCH` - Discrepancy detected (NEW, metadata only)

**Expected from Other Brands:**
- Similar event types with same field structure
- `runtime_seconds` populated on session end events

---

## Proposed Schema Extensions

### New Optional Fields (All Nullable)

Add these fields to the existing event schema. **All are optional and backward compatible.**

```typescript
interface ThermostatEvent {
  // ... all existing fields remain unchanged ...

  // ========================================
  // NEW FIELDS (all optional/nullable)
  // ========================================

  // Data provenance
  data_source?: 'realtime_polling' | 'runtime_report' | 'historical' | null;
  is_correction?: boolean;
  is_daily_summary?: boolean;

  // Daily summary metadata
  summary_date?: string;              // YYYY-MM-DD (for daily summaries)
  summary_interval_count?: number;    // Number of intervals in summary (e.g., 288)
  summary_coverage_percent?: number;  // % of day with data (0-100)

  // Runtime breakdown (for daily summaries)
  heating_runtime_seconds?: number;   // Primary heating (heat pump, furnace)
  cooling_runtime_seconds?: number;   // Cooling compressor
  aux_heat_runtime_seconds?: number;  // Auxiliary/emergency heat
  fan_runtime_seconds?: number;       // Fan (with or without equipment)

  // Discrepancy tracking (for corrections)
  calculated_runtime_seconds?: number;  // Original calculated value
  discrepancy_seconds?: number;         // Difference: ecobee - calculated

  // Historical/backfill support
  is_backfill?: boolean;                // True if posting historical data
  backfill_source?: string;             // "ecobee_runtime_report", etc.
}
```

---

## New Event Types

Add support for two new event types **without breaking existing types:**

### 1. `DAILY_RUNTIME_SUMMARY`

**Purpose:** Post Ecobee's validated daily totals (ground truth)

**When:** Daily at 00:05 UTC for previous day

**Fields Used:**
```typescript
{
  event_type: "DAILY_RUNTIME_SUMMARY",
  data_source: "runtime_report",
  is_daily_summary: true,
  summary_date: "2024-11-02",
  summary_interval_count: 288,
  summary_coverage_percent: 100,

  // Runtime breakdown
  heating_runtime_seconds: 7200,      // 2 hours
  cooling_runtime_seconds: 10800,     // 3 hours
  aux_heat_runtime_seconds: 0,
  fan_runtime_seconds: 18000,         // 5 hours

  // Standard fields
  device_key: "hvac_123",
  user_id: "user_456",
  observed_at: "2024-11-02T23:59:59Z",

  // Comparison data
  calculated_runtime_seconds: 17500,
  discrepancy_seconds: 500,

  payload_raw: {
    intervals: 288,
    data_quality: "complete",
    source: "ecobee_runtime_report"
  }
}
```

### 2. `RUNTIME_CORRECTION`

**Purpose:** Post when significant discrepancy detected (>5 min)

**When:** Daily validation finds mismatch

**Fields Used:**
```typescript
{
  event_type: "RUNTIME_CORRECTION",
  data_source: "runtime_report",
  is_correction: true,
  summary_date: "2024-11-02",

  // Corrected values
  runtime_seconds: 18000,              // Ecobee's validated total
  heating_runtime_seconds: 7200,
  cooling_runtime_seconds: 10800,
  aux_heat_runtime_seconds: 0,

  // Original values for comparison
  calculated_runtime_seconds: 17500,
  discrepancy_seconds: 500,

  // Standard fields
  device_key: "hvac_123",
  user_id: "user_456",
  observed_at: "2024-11-02T23:59:59Z",

  payload_raw: {
    reason: "polling_missed_5min_during_runtime",
    original_event_ids: ["uuid1", "uuid2"],
    correction_source: "ecobee_runtime_report"
  }
}
```

---

## Database Schema Changes

### Option A: Add Columns to Existing Table (Simpler)

**If Core uses a single events table:**

```sql
-- Add new optional columns (all nullable)
ALTER TABLE thermostat_events
  ADD COLUMN data_source VARCHAR(50),
  ADD COLUMN is_correction BOOLEAN DEFAULT FALSE,
  ADD COLUMN is_daily_summary BOOLEAN DEFAULT FALSE,
  ADD COLUMN summary_date DATE,
  ADD COLUMN summary_interval_count INTEGER,
  ADD COLUMN summary_coverage_percent NUMERIC(5,2),
  ADD COLUMN heating_runtime_seconds INTEGER,
  ADD COLUMN cooling_runtime_seconds INTEGER,
  ADD COLUMN aux_heat_runtime_seconds INTEGER,
  ADD COLUMN fan_runtime_seconds INTEGER,
  ADD COLUMN calculated_runtime_seconds INTEGER,
  ADD COLUMN discrepancy_seconds INTEGER,
  ADD COLUMN is_backfill BOOLEAN DEFAULT FALSE,
  ADD COLUMN backfill_source VARCHAR(100);

-- Indexes for new query patterns
CREATE INDEX idx_events_data_source ON thermostat_events(data_source);
CREATE INDEX idx_events_summary_date ON thermostat_events(summary_date) WHERE is_daily_summary = TRUE;
CREATE INDEX idx_events_corrections ON thermostat_events(device_key, summary_date) WHERE is_correction = TRUE;
```

**Pros:**
- Simple migration
- All data in one place
- Existing queries unaffected

**Cons:**
- Table grows wider (but all columns nullable)
- Many NULL values for non-summary events

---

### Option B: Separate Table for Daily Summaries (Better Long-term)

**Keep real-time events separate from daily summaries:**

```sql
-- New table for daily runtime summaries
CREATE TABLE thermostat_runtime_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_key VARCHAR(255) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  summary_date DATE NOT NULL,

  -- Runtime totals (seconds)
  heating_runtime_seconds INTEGER DEFAULT 0,
  cooling_runtime_seconds INTEGER DEFAULT 0,
  aux_heat_runtime_seconds INTEGER DEFAULT 0,
  fan_runtime_seconds INTEGER DEFAULT 0,
  total_runtime_seconds INTEGER GENERATED ALWAYS AS
    (heating_runtime_seconds + cooling_runtime_seconds + aux_heat_runtime_seconds) STORED,

  -- Data quality
  interval_count INTEGER,
  coverage_percent NUMERIC(5,2),
  data_source VARCHAR(50) DEFAULT 'runtime_report',

  -- Comparison with real-time calculations
  calculated_runtime_seconds INTEGER,
  discrepancy_seconds INTEGER,
  was_corrected BOOLEAN DEFAULT FALSE,
  corrected_at TIMESTAMPTZ,

  -- Metadata
  manufacturer VARCHAR(100),
  source_vendor VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Constraints
  UNIQUE (device_key, summary_date),
  CHECK (coverage_percent >= 0 AND coverage_percent <= 100)
);

-- Indexes
CREATE INDEX idx_runtime_daily_device_date ON thermostat_runtime_daily(device_key, summary_date);
CREATE INDEX idx_runtime_daily_user_date ON thermostat_runtime_daily(user_id, summary_date);
CREATE INDEX idx_runtime_daily_corrections ON thermostat_runtime_daily(was_corrected) WHERE was_corrected = TRUE;

-- Optional: corrections audit table
CREATE TABLE thermostat_runtime_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_key VARCHAR(255) NOT NULL,
  correction_date DATE NOT NULL,
  original_runtime_seconds INTEGER,
  corrected_runtime_seconds INTEGER,
  discrepancy_seconds INTEGER,
  reason TEXT,
  source_event_ids JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  FOREIGN KEY (device_key, correction_date)
    REFERENCES thermostat_runtime_daily(device_key, summary_date)
);
```

**Pros:**
- Clean separation of concerns
- Optimized for different query patterns
- No NULL pollution in events table
- Easier to query daily summaries

**Cons:**
- More complex migration
- Need to maintain two tables

---

## API Endpoint Changes

### Current Endpoint
```
POST /ingest/v1/events:batch
```

**Required Changes:** ✅ **None** - Existing endpoint accepts new event types

**Validation Logic to Add:**
1. Accept new event types: `DAILY_RUNTIME_SUMMARY`, `RUNTIME_CORRECTION`
2. Validate new optional fields when present
3. Route to appropriate storage (Option A or B above)

### Pseudo-code for Endpoint Handler

```typescript
// In Core Ingest event handler
async function handleThermostatEvent(event: ThermostatEvent) {
  // Validate event
  validateEventSchema(event);

  // Route based on event type
  switch (event.event_type) {
    case 'DAILY_RUNTIME_SUMMARY':
      await storeDailySum summary(event);
      break;

    case 'RUNTIME_CORRECTION':
      await handleRuntimeCorrection(event);
      break;

    case 'Mode_Change':
    case 'Connectivity_Change':
    case 'STATE_UPDATE':
      await storeRealtimeEvent(event);
      break;

    default:
      // Unknown event type - log and store in events table
      console.warn(`Unknown event type: ${event.event_type}`);
      await storeRealtimeEvent(event);
  }
}

async function storeDailySummary(event: ThermostatEvent) {
  if (USE_SEPARATE_TABLE) { // Option B
    await db.query(`
      INSERT INTO thermostat_runtime_daily
        (device_key, user_id, summary_date, heating_runtime_seconds,
         cooling_runtime_seconds, aux_heat_runtime_seconds, fan_runtime_seconds,
         interval_count, coverage_percent, calculated_runtime_seconds,
         discrepancy_seconds, data_source, manufacturer, source_vendor)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (device_key, summary_date)
      DO UPDATE SET
        heating_runtime_seconds = EXCLUDED.heating_runtime_seconds,
        cooling_runtime_seconds = EXCLUDED.cooling_runtime_seconds,
        aux_heat_runtime_seconds = EXCLUDED.aux_heat_runtime_seconds,
        fan_runtime_seconds = EXCLUDED.fan_runtime_seconds,
        calculated_runtime_seconds = EXCLUDED.calculated_runtime_seconds,
        discrepancy_seconds = EXCLUDED.discrepancy_seconds,
        updated_at = NOW()
    `, [
      event.device_key,
      event.user_id,
      event.summary_date,
      event.heating_runtime_seconds,
      event.cooling_runtime_seconds,
      event.aux_heat_runtime_seconds,
      event.fan_runtime_seconds,
      event.summary_interval_count,
      event.summary_coverage_percent,
      event.calculated_runtime_seconds,
      event.discrepancy_seconds,
      event.data_source,
      event.manufacturer,
      event.source_vendor
    ]);
  } else { // Option A
    await storeRealtimeEvent(event); // Just store in events table
  }
}

async function handleRuntimeCorrection(event: ThermostatEvent) {
  // Update daily summary with corrected values
  await db.query(`
    UPDATE thermostat_runtime_daily
    SET
      heating_runtime_seconds = $3,
      cooling_runtime_seconds = $4,
      aux_heat_runtime_seconds = $5,
      was_corrected = TRUE,
      corrected_at = NOW()
    WHERE device_key = $1 AND summary_date = $2
  `, [
    event.device_key,
    event.summary_date,
    event.heating_runtime_seconds,
    event.cooling_runtime_seconds,
    event.aux_heat_runtime_seconds
  ]);

  // Optionally store correction audit record
  await storeRealtimeEvent(event); // Also keep in events table
}
```

---

## Compatibility Matrix

### Thermostat Brand Compatibility

| Brand | Current Events | New Fields Impact | Changes Needed |
|-------|---------------|-------------------|----------------|
| **Ecobee** | ✅ Mode_Change, STATE_UPDATE | ✅ Will populate new fields | Update integration to post summaries |
| **Nest** | ✅ Similar events | ✅ NULL for new fields | ❌ None - backward compatible |
| **Honeywell** | ✅ Similar events | ✅ NULL for new fields | ❌ None - backward compatible |
| **Generic** | ✅ Any thermostat | ✅ NULL for new fields | ❌ None - backward compatible |

**Key Insight:** New fields are **optional/nullable**, so existing integrations send NULL/undefined and everything works.

### Event Type Compatibility

| Event Type | Existing Behavior | New Behavior | Breaking? |
|------------|-------------------|--------------|-----------|
| `Mode_Change` | Store runtime_seconds | Same + optional fields | ❌ No |
| `STATE_UPDATE` | Store state changes | Same + optional fields | ❌ No |
| `Connectivity_Change` | Store connectivity | Same + optional fields | ❌ No |
| `DAILY_RUNTIME_SUMMARY` | ❌ Not recognized | ✅ Store daily totals | ❌ No (new type) |
| `RUNTIME_CORRECTION` | ❌ Not recognized | ✅ Apply correction | ❌ No (new type) |

---

## Query Pattern Changes

### For Analytics/Reports (Use Daily Summaries)

**Before (real-time events only):**
```sql
SELECT
  device_key,
  DATE(observed_at) as day,
  SUM(runtime_seconds) as total_runtime
FROM thermostat_events
WHERE event_type = 'Mode_Change'
  AND runtime_seconds IS NOT NULL
  AND device_key = 'hvac_123'
  AND observed_at BETWEEN '2024-11-01' AND '2024-11-30'
GROUP BY device_key, DATE(observed_at);
```

**Issues with old query:**
- May miss runtime if poller was down
- Sums partial sessions
- Less accurate

**After (daily summaries):**
```sql
-- Option B (separate table)
SELECT
  device_key,
  summary_date,
  heating_runtime_seconds,
  cooling_runtime_seconds,
  aux_heat_runtime_seconds,
  total_runtime_seconds,
  coverage_percent
FROM thermostat_runtime_daily
WHERE device_key = 'hvac_123'
  AND summary_date BETWEEN '2024-11-01' AND '2024-11-30'
ORDER BY summary_date;
```

**Benefits:**
- 100% accurate (from Ecobee's ground truth)
- One row per day (simple aggregation)
- Data quality metrics included

### For Real-time Dashboards (Use Real-time Events)

**No change needed:**
```sql
SELECT
  device_key,
  event_type,
  equipment_status,
  is_active,
  temperature_f,
  observed_at
FROM thermostat_events
WHERE device_key = 'hvac_123'
  AND observed_at > NOW() - INTERVAL '24 hours'
ORDER BY observed_at DESC
LIMIT 100;
```

---

## Migration Plan

### Phase 1: Schema Changes (Week 1)

**Day 1-2: Database Migration**
1. Create new columns (Option A) OR new table (Option B)
2. Run migration on staging environment
3. Test with sample data
4. Deploy to production (non-breaking)

**Day 3-4: API Updates**
1. Update event validation to accept new event types
2. Implement routing logic for DAILY_RUNTIME_SUMMARY
3. Implement routing logic for RUNTIME_CORRECTION
4. Deploy to staging

**Day 5: Testing**
1. Send test events with new types
2. Verify storage
3. Verify existing events still work
4. Test with Nest/Honeywell mock data

### Phase 2: Ecobee Integration (Week 2)

**Day 1-2: Enable Posting**
1. Update Ecobee poller to post DAILY_RUNTIME_SUMMARY
2. Update Ecobee poller to post RUNTIME_CORRECTION when needed
3. Test on staging

**Day 3-4: Validation**
1. Compare real-time vs daily summary data
2. Verify discrepancy detection
3. Check correction logic

**Day 5: Production Deploy**
1. Deploy Ecobee poller changes
2. Monitor for 24 hours
3. Verify daily summaries arrive

### Phase 3: Analytics Migration (Week 3)

**Day 1-3: Update Queries**
1. Update report queries to use daily summaries
2. Add data quality checks
3. Handle missing summaries gracefully

**Day 4-5: Dashboard Updates**
1. Add data source indicator (real-time vs validated)
2. Show coverage % on reports
3. Highlight corrected days

### Phase 4: Other Brands (Future)

**Optional:** Extend to other brands when they provide runtime reports

**Nest:**
- Check if Google Nest API provides historical runtime
- If yes, implement similar validation

**Honeywell:**
- Check API capabilities
- Implement if supported

---

## Rollback Plan

### If Issues Arise

**Option A (Single Table):**
1. New columns are nullable - no impact on existing queries
2. Can disable new event types in API
3. Ecobee stops posting summaries
4. Zero data loss

**Option B (Separate Table):**
1. New table independent - zero impact on existing data
2. Can drop table if needed
3. Ecobee stops posting summaries
4. Zero data loss

**Both options are non-destructive and reversible.**

---

## Testing Checklist

### Unit Tests
- [ ] Validate DAILY_RUNTIME_SUMMARY event schema
- [ ] Validate RUNTIME_CORRECTION event schema
- [ ] Ensure existing event types still validate
- [ ] Test with NULL values for new fields

### Integration Tests
- [ ] Post DAILY_RUNTIME_SUMMARY to staging
- [ ] Post RUNTIME_CORRECTION to staging
- [ ] Post existing event types (Mode_Change, etc.)
- [ ] Verify storage in correct table/columns
- [ ] Query daily summaries
- [ ] Query real-time events (ensure unchanged)

### Compatibility Tests
- [ ] Send Nest mock event (no new fields) - should work
- [ ] Send Honeywell mock event (no new fields) - should work
- [ ] Send Ecobee event with new fields - should work
- [ ] Mix events from different brands - all should work

### Performance Tests
- [ ] Bulk insert 1000 daily summaries
- [ ] Query daily summaries for 1 year
- [ ] Query real-time events (ensure no regression)
- [ ] Check index usage

---

## Recommendation

**Use Option B: Separate Table for Daily Summaries**

**Rationale:**
1. Clean separation of real-time vs validated data
2. Optimized queries for different use cases
3. No NULL pollution in events table
4. Easier to extend in future
5. Better performance for analytics

**Implementation Priority:**
1. ✅ **Week 1:** Add `thermostat_runtime_daily` table
2. ✅ **Week 2:** Update API to handle new event types
3. ✅ **Week 2:** Enable Ecobee to post summaries
4. ✅ **Week 3:** Migrate analytics queries
5. ⏭️ **Future:** Extend to other brands if APIs support it

---

## Questions for Core Team

Before implementing, please confirm:

1. **Storage Strategy:** Option A (single table) or Option B (separate table)?
2. **Correction Handling:** Update in place or store audit trail?
3. **Retention Policy:** How long to keep daily summaries? Real-time events?
4. **Other Integrations:** Any other thermostat brands that could benefit?
5. **Analytics Impact:** Which queries/dashboards need updating?
6. **API Versioning:** Should we version the events:batch endpoint?

---

## Summary

**Proposed Changes:**
- ✅ Add 14 new optional fields to event schema
- ✅ Add 2 new event types (DAILY_RUNTIME_SUMMARY, RUNTIME_CORRECTION)
- ✅ Create new table OR add columns (recommend new table)
- ✅ Update API to route new event types
- ✅ Enable Ecobee to post daily validated data

**Benefits:**
- ✅ Core gets 100% accurate runtime data
- ✅ Detects and corrects discrepancies
- ✅ Zero risk of breaking existing integrations
- ✅ Works for all thermostat brands

**Risk:** **ZERO** - All changes are backward compatible and optional.

