# Core Ingest Integration Analysis

## Current Data Flow to Core Ingest

### Events Posted to Core (Real-time)

**From `runtime.js`:**
1. **Session Start** (`runtime.js:186-201`)
   - Event: `Mode_Change`
   - Runtime: `null` (no runtime yet)
   - When: Equipment turns on

2. **Session End** (`runtime.js:229-244`) ⭐ **PRIMARY RUNTIME DATA**
   - Event: `Mode_Change`
   - Runtime: `runtime_seconds` (accumulated total)
   - When: Equipment turns off

3. **Offline Session End** (`runtime.js:119-136`)
   - Event: `Mode_Change`
   - Runtime: `runtime_seconds` (accumulated total before disconnect)
   - When: Device goes offline while equipment was running

4. **Connectivity Changes** (`runtime.js:139-167`)
   - Event: `Connectivity_Change`
   - Runtime: `null`
   - When: Device connects/disconnects from Ecobee

**From `poller.js`:**
5. **State Updates** (`poller.js:187-220`)
   - Event: `STATE_UPDATE`
   - Runtime: `null`
   - When: Temperature/setpoint/mode changes significantly

6. **Forced State Updates** (`poller.js:252-284`)
   - Event: `STATE_UPDATE`
   - Runtime: `null`
   - When: No updates for >12 hours

**From `index.js`:**
7. **Stale Connectivity** (`index.js:42-63`)
   - Event: `CONNECTIVITY_CHANGE`
   - Runtime: `null`
   - When: Device hasn't been seen in >15 minutes

### Events Posted to Core (Validation - NEW)

**From `runtimeValidator.js`:**
8. **Validation Mismatch** (`runtimeValidator.js:149-175`)
   - Event: `RUNTIME_VALIDATION_MISMATCH`
   - Runtime: `null` (no runtime_seconds field)
   - Metadata: `payloadRaw.ecobee_runtime_seconds`, `payloadRaw.discrepancy_seconds`
   - When: Daily validation finds >5 minute discrepancy

## Risk Assessment: Double Posting?

### ✅ **NO CURRENT RISK** - Here's Why:

**Runtime data is ONLY posted in:**
- Session end events (points 2 & 3 above)
- These have `runtime_seconds` field populated

**Validation ONLY posts:**
- Diagnostic metadata about discrepancies
- Does NOT post actual runtime_seconds to Core
- Uses different event type: `RUNTIME_VALIDATION_MISMATCH`

### Example Timeline:

```
10:00 AM - Equipment turns on
           → POST Mode_Change (session-start, runtime_seconds: null)

10:15 AM - Equipment still running (tick)
           → No post to Core (just updates database)

10:30 AM - Equipment turns off
           → POST Mode_Change (session-end, runtime_seconds: 1800)
           ⭐ Core receives: 1800 seconds (30 min)

Next Day 12:05 AM - Daily validation runs
           → Fetch Ecobee report for yesterday
           → Ecobee says: 1800 seconds
           → Our calculated: 1800 seconds (from session-end)
           → Discrepancy: 0 seconds
           → No post to Core ✅

Next Day 12:05 AM - Validation finds discrepancy
           → Ecobee says: 2100 seconds (35 min)
           → Our calculated: 1800 seconds (30 min)
           → Discrepancy: 300 seconds (5 min)
           → POST RUNTIME_VALIDATION_MISMATCH
           ⭐ Core receives: metadata only, NOT corrected runtime
```

## The Problem: Core Has Inaccurate Data

**Current behavior:**
- Polling posts: 1800 seconds
- Validation detects: actually 2100 seconds
- Core still shows: 1800 seconds (never corrected!)

**Validation only posts diagnostic event, not corrected runtime.**

## What Should We Do? (Design Options)

### Option A: Keep Current Behavior (Status Quo)
**Pros:**
- No risk of double-counting
- Simple
- Core doesn't need changes

**Cons:**
- Core has inaccurate runtime data
- Validation is just logging, not fixing

**Core Changes:** None

---

### Option B: Post Corrected Runtime as New Event
Post the ground-truth runtime from Ecobee as a separate event.

**Implementation:**
```javascript
// In runtimeValidator.js after detecting discrepancy
const correctionPayload = buildCorePayload({
  deviceKey: hvac_id,
  userId: user_id,
  eventType: 'RUNTIME_CORRECTION',
  equipmentStatus: 'HISTORICAL',
  isActive: false,
  runtimeSeconds: ecobeeRuntime.total_heating + ecobeeRuntime.total_cooling + ecobeeRuntime.total_aux_heat,
  observedAt: new Date(`${date}T23:59:59Z`), // End of day
  payloadRaw: {
    data_source: 'ecobee_runtime_report',
    validation_date: date,
    ecobee_heating: ecobeeRuntime.total_heating,
    ecobee_cooling: ecobeeRuntime.total_cooling,
    ecobee_aux_heat: ecobeeRuntime.total_aux_heat,
    original_calculated: calculatedRuntime.total_heating + calculatedRuntime.total_cooling,
    is_correction: true
  }
});

await postToCoreIngestAsync(correctionPayload, 'runtime-correction');
```

**Pros:**
- Core receives accurate data
- Separate event type prevents confusion
- Can track both real-time and validated data

**Cons:**
- Core receives two runtime totals for same day
- Core must decide which to use

**Core Changes Needed:**
1. Handle new event type: `RUNTIME_CORRECTION`
2. Decide correction strategy:
   - Replace original runtime? (complex)
   - Store both and use correction? (simpler)
   - Add delta to original? (error-prone)
3. Add fields to event schema:
   - `data_source` (string): "realtime_polling" | "ecobee_runtime_report"
   - `is_correction` (boolean)
   - `corrected_date` (date)

---

### Option C: Post Detailed Interval Data
Post all 288 five-minute intervals from Ecobee report.

**Implementation:**
```javascript
// In runtimeValidator.js after storing intervals
const intervals = await getRuntimeReportForDate(hvac_id, date);

for (const interval of intervals) {
  const intervalPayload = buildCorePayload({
    deviceKey: hvac_id,
    userId: user_id,
    eventType: 'RUNTIME_INTERVAL',
    equipmentStatus: interval.hvac_mode,
    isActive: (interval.comp_heat1 + interval.comp_cool1 + interval.aux_heat1) > 0,
    runtimeSeconds: interval.comp_heat1 + interval.comp_cool1 + interval.aux_heat1,
    temperatureF: interval.zone_avg_temp,
    observedAt: new Date(interval.interval_timestamp),
    payloadRaw: {
      data_source: 'ecobee_runtime_report',
      interval_duration: 300, // 5 minutes
      aux_heat1: interval.aux_heat1,
      comp_cool1: interval.comp_cool1,
      comp_heat1: interval.comp_heat1,
      fan: interval.fan,
      outdoor_temp: interval.outdoor_temp
    }
  });

  await postToCoreIngestAsync(intervalPayload, 'runtime-interval');
}
```

**Pros:**
- Core gets highest resolution data (5-min intervals)
- Core can aggregate however it wants
- Enables detailed analytics
- Ground truth from Ecobee

**Cons:**
- 288 API calls per thermostat per day
- Much higher data volume
- Could overwhelm Core if many thermostats

**Core Changes Needed:**
1. Handle new event type: `RUNTIME_INTERVAL`
2. Aggregation logic to sum intervals into daily/hourly totals
3. Handle large volume of interval events
4. Schema changes:
   - `interval_duration` (integer seconds)
   - `data_source` field
   - Separate columns for heat/cool/aux/fan

---

### Option D: Batch Post Daily Summary
Post one event per day with Ecobee's validated totals.

**Implementation:**
```javascript
// In runtimeValidator.js after validation
const dailySummaryPayload = buildCorePayload({
  deviceKey: hvac_id,
  userId: user_id,
  eventType: 'DAILY_RUNTIME_SUMMARY',
  equipmentStatus: 'SUMMARY',
  isActive: false,
  observedAt: new Date(`${date}T23:59:59Z`),
  payloadRaw: {
    data_source: 'ecobee_runtime_report',
    summary_date: date,
    heating_seconds: ecobeeRuntime.total_heating,
    cooling_seconds: ecobeeRuntime.total_cooling,
    aux_heat_seconds: ecobeeRuntime.total_aux_heat,
    fan_seconds: ecobeeRuntime.total_fan,
    interval_count: ecobeeRuntime.interval_count,
    coverage_percent: (ecobeeRuntime.interval_count / 288) * 100,

    // Include discrepancy info
    calculated_heating: calculatedRuntime.total_heating,
    calculated_cooling: calculatedRuntime.total_cooling,
    discrepancy_seconds: totalDiscrepancy
  }
});

await postToCoreIngestAsync(dailySummaryPayload, 'daily-runtime-summary');
```

**Pros:**
- One event per day per thermostat (low volume)
- Contains both Ecobee and calculated runtime
- Core can see discrepancies
- Easy to implement

**Cons:**
- Loses 5-minute granularity
- Still need to reconcile with real-time events

**Core Changes Needed:**
1. Handle new event type: `DAILY_RUNTIME_SUMMARY`
2. Schema for daily summaries:
   - `summary_date` (date)
   - `heating_seconds`, `cooling_seconds`, etc.
   - `coverage_percent` (data quality metric)
   - `calculated_*` fields for comparison

---

## Recommended Approach

### **Option D + Option B (Hybrid)**

**For normal operation:**
- Post `DAILY_RUNTIME_SUMMARY` every day with Ecobee's validated data

**For significant discrepancies:**
- Also post `RUNTIME_CORRECTION` event
- Core can use correction to adjust analytics

### Why This Approach?

1. **Low volume** - Only 1 event/day + corrections when needed
2. **Accurate data** - Core gets ground truth from Ecobee
3. **Flexibility** - Core can use real-time OR validated data
4. **Visibility** - Corrections are explicit
5. **Backward compatible** - Doesn't change existing real-time flow

### Implementation Checklist for Core Ingest

#### 1. New Event Types
- [ ] `DAILY_RUNTIME_SUMMARY` - Daily validated totals from Ecobee
- [ ] `RUNTIME_CORRECTION` - Posted when discrepancy >threshold

#### 2. Schema Changes
Add these fields to event schema:

```typescript
interface ThermostatEvent {
  // Existing fields...
  event_type: string;
  runtime_seconds?: number;

  // NEW fields
  data_source?: 'realtime_polling' | 'ecobee_runtime_report';
  is_correction?: boolean;
  summary_date?: string; // YYYY-MM-DD for daily summaries

  // Runtime breakdown (for DAILY_RUNTIME_SUMMARY)
  heating_seconds?: number;
  cooling_seconds?: number;
  aux_heat_seconds?: number;
  fan_seconds?: number;

  // Data quality metrics
  coverage_percent?: number; // % of day with data
  interval_count?: number;

  // Discrepancy tracking
  calculated_runtime_seconds?: number;
  discrepancy_seconds?: number;
}
```

#### 3. Storage Strategy

**Option 3A: Dual Storage**
- Keep real-time events in `thermostat_events` table
- Store daily summaries in `thermostat_runtime_daily` table
- Analytics queries use daily summaries (more accurate)

**Option 3B: Unified Storage with Source Flag**
- Store all events in same table
- Add `data_source` column
- Queries filter by data_source

#### 4. Query Logic

**For daily/monthly reports:**
```sql
-- Use validated daily summaries (100% accurate)
SELECT
  summary_date,
  SUM(heating_seconds) as total_heating,
  SUM(cooling_seconds) as total_cooling
FROM thermostat_runtime_daily
WHERE hvac_id = ? AND summary_date BETWEEN ? AND ?
GROUP BY summary_date;
```

**For real-time dashboard:**
```sql
-- Use real-time events (up-to-the-minute)
SELECT
  event_type,
  runtime_seconds,
  observed_at
FROM thermostat_events
WHERE hvac_id = ?
  AND data_source = 'realtime_polling'
  AND observed_at > NOW() - INTERVAL '24 hours';
```

#### 5. Correction Handling

When `RUNTIME_CORRECTION` event arrives:

**Option A: Update existing records**
```sql
UPDATE thermostat_runtime_daily
SET
  heating_seconds = ?,
  cooling_seconds = ?,
  corrected_at = NOW(),
  was_corrected = true
WHERE hvac_id = ? AND summary_date = ?;
```

**Option B: Store corrections separately**
```sql
-- Keep original + correction
INSERT INTO thermostat_runtime_corrections
(hvac_id, correction_date, original_runtime, corrected_runtime, discrepancy)
VALUES (?, ?, ?, ?, ?);
```

## Migration Path

### Phase 1: Add Support (No Breaking Changes)
1. Update Core schema to accept new event types
2. New events go to separate tables initially
3. Existing real-time events unchanged

### Phase 2: Dual Mode
1. Ecobee poller posts both real-time AND daily summaries
2. Analytics queries use daily summaries
3. Dashboards still use real-time

### Phase 3: Validation
1. Compare real-time vs daily summary accuracy
2. Tune discrepancy thresholds
3. Monitor for double-counting

### Phase 4: Production
1. Switch analytics to use daily summaries
2. Keep real-time for dashboards
3. Corrections automatically applied

## Summary

**Current State:**
- ✅ No double-posting risk
- ❌ Core has inaccurate data (missing runtime during outages)
- ❌ Validation only logs, doesn't fix

**Recommended:**
- Post `DAILY_RUNTIME_SUMMARY` with Ecobee's ground truth
- Post `RUNTIME_CORRECTION` when discrepancy >5 min
- Core stores both real-time and validated data
- Analytics use validated data, dashboards use real-time

**Core Changes Required:**
1. Accept new event types
2. Add schema fields for daily summaries
3. Implement storage strategy (dual table recommended)
4. Update analytics queries

**Next Steps:**
1. Review this analysis with Core Ingest team
2. Decide on Option D+B or alternative
3. Define exact schema changes
4. Implement in Core first, then update Ecobee poller
