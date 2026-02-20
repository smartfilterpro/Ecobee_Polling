'use strict';

import { fetchRuntimeReport } from './ecobeeApi.js';
import { parseRuntimeReport, getRuntimeSummary } from './runtimeReportParser.js';
import { upsertRuntimeReportInterval, getTotalRuntimeFromReport, getTotalRuntimeFromSessions, insertCoreEvent } from './db.js';
import { buildCorePayload, postToCoreIngestAsync } from './coreIngest.js';
import { CORE_INGEST_URL } from './config.js';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';

const CORE_API_KEY = process.env.CORE_API_KEY;

/**
 * Post runtime report intervals to Core Ingest
 * @param {string} hvac_id - Thermostat identifier
 * @param {string} user_id - User identifier
 * @param {string} date - Date in YYYY-MM-DD format
 * @param {Array} intervals - Parsed interval data
 * @returns {Promise<void>}
 */
async function postRuntimeReportToCore(hvac_id, user_id, date, intervals) {
  if (!CORE_INGEST_URL) {
    console.warn('[RuntimeValidator] ⚠️ CORE_INGEST_URL not set, skipping Core post');
    return;
  }

  if (!CORE_API_KEY) {
    console.warn('[RuntimeValidator] ⚠️ CORE_API_KEY missing — posting insecurely (dev only)');
  }

  // 1. Post detailed intervals to specialized endpoint (existing behavior)
  const intervalsPayload = {
    device_key: hvac_id,
    report_date: date,
    intervals: intervals.map(i => ({
      interval_timestamp: i.interval_timestamp,
      aux_heat1_seconds: i.aux_heat1 || 0,
      aux_heat2_seconds: i.aux_heat2 || 0,
      aux_heat3_seconds: i.aux_heat3 || 0,
      comp_cool1_seconds: i.comp_cool1 || 0,
      comp_cool2_seconds: i.comp_cool2 || 0,
      comp_heat1_seconds: i.comp_heat1 || 0,
      comp_heat2_seconds: i.comp_heat2 || 0,
      fan_seconds: i.fan || 0,
      outdoor_temp_f: i.outdoor_temp,
      zone_avg_temp_f: i.zone_avg_temp,
      zone_humidity: i.zone_humidity,
      hvac_mode: i.hvac_mode
    }))
  };

  try {
    const response = await axios.post(
      `${CORE_INGEST_URL}/ingest/v1/runtime-report`,
      intervalsPayload,
      {
        headers: {
          'Content-Type': 'application/json',
          ...(CORE_API_KEY ? { 'Authorization': `Bearer ${CORE_API_KEY}` } : {})
        },
        timeout: 30000
      }
    );
    console.log(`[RuntimeValidator] ✅ Posted ${intervals.length} intervals to Core for ${hvac_id} on ${date}`);
  } catch (err) {
    const status = err.response?.status || 'unknown';
    const msg = err.response?.data?.message || err.message;
    console.error(`[RuntimeValidator] ❌ Failed to post runtime intervals to Core [${status}]: ${msg}`);
    // Continue to summary event even if intervals fail
  }

  // 2. **NEW**: Post summary event to standard events pipeline for tracking
  const summary = getRuntimeSummary(intervals);
  
  const summaryPayload = buildCorePayload({
    deviceKey: hvac_id,
    userId: user_id,
    eventType: 'RUNTIME_REPORT',
    isReachable: true,
    recordedAt: intervals[0]?.interval_timestamp || new Date().toISOString(),
    payload: {
      report_date: date,
      total_heating_seconds: summary.heating_runtime,
      total_cooling_seconds: summary.cooling_runtime,
      total_auxheat_seconds: summary.aux_heat_runtime,
      total_fan_seconds: summary.fan_runtime,
      interval_count: intervals.length,
      coverage_percent: summary.coverage_percent,
      total_runtime_hours: summary.total_runtime_hours
    }
  });

  try {
    const result = await postToCoreIngestAsync(summaryPayload, 'RUNTIME_REPORT');
    console.log(`[RuntimeValidator] ✅ Posted RUNTIME_REPORT summary event to Core for ${hvac_id} on ${date}`);
    
    // Store the runtime report post locally (keep existing behavior)
    await insertCoreEvent({
      hvac_id,
      user_id,
      event_type: 'RUNTIME_REPORT',
      source_event_id: null,
      label: 'runtime-report',
      payload: summaryPayload
    });
    
    return result;
  } catch (err) {
    const status = err.response?.status || 'unknown';
    const msg = err.response?.data?.message || err.message;
    console.error(`[RuntimeValidator] ❌ Failed to post runtime report summary to Core [${status}]: ${msg}`);
    // Don't throw - we still want local storage to succeed even if Core post fails
  }
}

/**
 * Fetch and store runtime report data from Ecobee for a specific date
 * @param {string} access_token - Ecobee access token
 * @param {string} hvac_id - Thermostat identifier
 * @param {string} user_id - User identifier
 * @param {string} date - Date in YYYY-MM-DD format
 * @returns {Promise<object>} Summary of stored data
 */
export async function fetchAndStoreRuntimeReport(access_token, hvac_id, user_id, date) {
  try {
    console.log(`[RuntimeValidator] Fetching runtime report for ${hvac_id} on ${date}`);

    // Fetch report from Ecobee API
    const reportData = await fetchRuntimeReport(access_token, hvac_id, date);

    // Parse CSV data into structured intervals
    const intervals = parseRuntimeReport(reportData, hvac_id);

    if (intervals.length === 0) {
      console.warn(`[RuntimeValidator] No intervals found in report for ${hvac_id} on ${date}`);
      return { stored: 0, summary: null };
    }

    // Store each interval in database
    let stored = 0;
    for (const interval of intervals) {
      await upsertRuntimeReportInterval(hvac_id, interval);
      stored++;
    }

    // Post intervals to Core Ingest (both detailed and summary)
    await postRuntimeReportToCore(hvac_id, user_id, date, intervals);

    // Get summary
    const summary = getRuntimeSummary(intervals);

    console.log(`[RuntimeValidator] Stored ${stored} intervals for ${hvac_id} on ${date}`);
    console.log(`[RuntimeValidator] Summary:`, {
      total_runtime_hours: summary.total_runtime_hours,
      coverage_percent: summary.coverage_percent,
      heating: Math.round(summary.heating_runtime / 60),
      cooling: Math.round(summary.cooling_runtime / 60),
      aux_heat: Math.round(summary.aux_heat_runtime / 60)
    });

    return { stored, summary };
  } catch (err) {
    console.error(`[RuntimeValidator] Error fetching/storing report for ${hvac_id} on ${date}:`, err.message);
    throw err;
  }
}

/**
 * Get our calculated runtime from session data for a specific date
 * @param {string} hvac_id - Thermostat identifier
 * @param {string} date - Date in YYYY-MM-DD format
 * @returns {Promise<object>} Calculated runtime totals
 */
export async function getCalculatedRuntimeForDate(hvac_id, date) {
  // Query the ecobee_runtime_sessions table for sessions that started on this date
  const sessionTotals = await getTotalRuntimeFromSessions(hvac_id, date);

  return {
    total_heating: Number(sessionTotals.total_heating) || 0,
    total_cooling: Number(sessionTotals.total_cooling) || 0,
    total_aux_heat: Number(sessionTotals.total_aux_heat) || 0,
    total_fan: Number(sessionTotals.total_fan) || 0,
    session_count: Number(sessionTotals.session_count) || 0
  };
}

/**
 * Compare our calculated runtime with Ecobee's ground truth
 * @param {string} access_token - Ecobee access token
 * @param {string} user_id - User ID
 * @param {string} hvac_id - Thermostat identifier
 * @param {string} date - Date in YYYY-MM-DD format
 * @returns {Promise<object>} Validation results with discrepancies
 */
export async function validateRuntimeForDate(access_token, user_id, hvac_id, date) {
  try {
    console.log(`\n[RuntimeValidator] 📊 Validating runtime for ${hvac_id} on ${date}`);

    // Fetch and store Ecobee's ground truth
    await fetchAndStoreRuntimeReport(access_token, hvac_id, user_id, date);

    // Get Ecobee's totals from database
    const ecobeeRuntime = await getTotalRuntimeFromReport(hvac_id, date);

    // Get our calculated totals
    const calculatedRuntime = await getCalculatedRuntimeForDate(hvac_id, date);

    // Calculate discrepancies
    const heating_diff = Math.abs(calculatedRuntime.total_heating - (ecobeeRuntime.total_heating || 0));
    const cooling_diff = Math.abs(calculatedRuntime.total_cooling - (ecobeeRuntime.total_cooling || 0));
    const aux_heat_diff = Math.abs(calculatedRuntime.total_aux_heat - (ecobeeRuntime.total_aux_heat || 0));
    const total_diff = heating_diff + cooling_diff + aux_heat_diff;

    // Define thresholds (5 minutes = 300 seconds per mode)
    const THRESHOLD_SECONDS = 300;
    const has_discrepancy = total_diff > THRESHOLD_SECONDS;

    const result = {
      hvac_id,
      date,
      ecobee_runtime: ecobeeRuntime,
      calculated_runtime: calculatedRuntime,
      discrepancies: {
        heating_diff_seconds: heating_diff,
        cooling_diff_seconds: cooling_diff,
        aux_heat_diff_seconds: aux_heat_diff,
        total_diff_seconds: total_diff,
        has_discrepancy
      }
    };

    if (has_discrepancy) {
      console.warn(`[RuntimeValidator] ⚠️ Discrepancy detected for ${hvac_id} on ${date}: ${Math.round(total_diff / 60)} min difference`);
    } else {
      console.log(`[RuntimeValidator] ✅ Runtime matches for ${hvac_id} on ${date} (within ${THRESHOLD_SECONDS}s threshold)`);
    }

    return result;

  } catch (err) {
    console.error(`[RuntimeValidator] Error validating runtime for ${hvac_id} on ${date}:`, err.message);
    throw err;
  }
}

/**
 * Validate yesterday's runtime for a single thermostat
 * Convenience wrapper around validateRuntimeForDate that auto-computes yesterday's date
 * @param {string} access_token - Ecobee access token
 * @param {string} user_id - User ID
 * @param {string} hvac_id - Thermostat identifier
 * @returns {Promise<object>} Validation results with discrepancies
 */
export async function validateYesterdayRuntime(access_token, user_id, hvac_id) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const date = yesterday.toISOString().split('T')[0];

  return validateRuntimeForDate(access_token, user_id, hvac_id, date);
}

/**
 * Run runtime validation for all thermostats for yesterday
 * @param {Array} thermostats - Array of thermostat objects with access_token, hvac_id, user_id
 * @returns {Promise<Array>} Array of validation results
 */
export async function runDailyRuntimeValidation(thermostats) {
  // Get yesterday's date (Ecobee reports are available the next day)
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const date = yesterday.toISOString().split('T')[0];

  console.log(`\n========================================`);
  console.log(`🔍 Running daily runtime validation for ${date}`);
  console.log(`Processing ${thermostats.length} thermostats`);
  console.log(`========================================\n`);

  const results = [];
  const discrepancies = [];

  for (const t of thermostats) {
    try {
      const result = await validateRuntimeForDate(t.access_token, t.user_id, t.hvac_id, date);
      results.push(result);

      if (result.discrepancies.has_discrepancy) {
        discrepancies.push({
          hvac_id: t.hvac_id,
          total_diff_minutes: Math.round(result.discrepancies.total_diff_seconds / 60),
          ecobee_total: result.ecobee_runtime.total_runtime_hours,
          calculated_total: (result.calculated_runtime.total_heating + result.calculated_runtime.total_cooling + result.calculated_runtime.total_aux_heat) / 3600
        });
      }
    } catch (err) {
      console.error(`[RuntimeValidator] Failed to validate ${t.hvac_id}: ${err.message}`);
      results.push({
        hvac_id: t.hvac_id,
        date,
        error: err.message
      });
    }
  }

  console.log(`\n========================================`);
  console.log(`✅ Runtime validation complete`);
  console.log(`Total validated: ${results.length}`);
  console.log(`Discrepancies found: ${discrepancies.length}`);
  
  if (discrepancies.length > 0) {
    console.log(`\n⚠️  Devices with discrepancies:`);
    discrepancies.forEach(d => {
      console.log(`  ${d.hvac_id}: ${d.total_diff_minutes} min difference (Ecobee: ${d.ecobee_total.toFixed(2)}h, Calc: ${d.calculated_total.toFixed(2)}h)`);
    });
  }
  console.log(`========================================\n`);

  return results;
}
