'use strict';

import { fetchRuntimeReport } from './ecobeeApi.js';
import { parseRuntimeReport, getRuntimeSummary } from './runtimeReportParser.js';
import { upsertRuntimeReportInterval, getTotalRuntimeFromReport, pool } from './db.js';
import { buildCorePayload, postToCoreIngestAsync } from './coreIngest.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Fetch and store runtime report data from Ecobee for a specific date
 * @param {string} access_token - Ecobee access token
 * @param {string} hvac_id - Thermostat identifier
 * @param {string} date - Date in YYYY-MM-DD format
 * @returns {Promise<object>} Summary of stored data
 */
export async function fetchAndStoreRuntimeReport(access_token, hvac_id, date) {
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
  // Query for all sessions that occurred on this date
  // Note: This is a simplified version - you may need to adjust based on your actual session tracking
  const startOfDay = `${date}T00:00:00Z`;
  const endOfDay = `${date}T23:59:59Z`;

  // Since we don't have a sessions table, we'll need to query the last_state table
  // This is an approximation - ideally you'd store session history
  const { rows } = await pool.query(
    `SELECT last_payload FROM ecobee_last_state WHERE hvac_id = $1`,
    [hvac_id]
  );

  // This is a placeholder - you'd need to implement proper session history tracking
  // For now, we'll return zero to show the structure
  return {
    total_heating: 0,
    total_cooling: 0,
    total_aux_heat: 0,
    total_fan: 0,
    note: 'Session history tracking not yet implemented - values are zero'
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
    await fetchAndStoreRuntimeReport(access_token, hvac_id, date);

    // Get Ecobee's totals from database
    const ecobeeRuntime = await getTotalRuntimeFromReport(hvac_id, date);

    // Get our calculated runtime
    const calculatedRuntime = await getCalculatedRuntimeForDate(hvac_id, date);

    // Calculate discrepancies
    const discrepancies = {
      heating: Math.abs(ecobeeRuntime.total_heating - calculatedRuntime.total_heating),
      cooling: Math.abs(ecobeeRuntime.total_cooling - calculatedRuntime.total_cooling),
      aux_heat: Math.abs(ecobeeRuntime.total_aux_heat - calculatedRuntime.total_aux_heat),
      fan: Math.abs(ecobeeRuntime.total_fan - calculatedRuntime.total_fan)
    };

    const totalDiscrepancy = discrepancies.heating + discrepancies.cooling + discrepancies.aux_heat;

    // Determine if discrepancy is significant (>5 minutes = 300 seconds)
    const THRESHOLD_SECONDS = 300;
    const isSignificant = totalDiscrepancy > THRESHOLD_SECONDS;

    const result = {
      hvac_id,
      date,
      ecobee: {
        heating: ecobeeRuntime.total_heating,
        cooling: ecobeeRuntime.total_cooling,
        aux_heat: ecobeeRuntime.total_aux_heat,
        fan: ecobeeRuntime.total_fan,
        intervals: ecobeeRuntime.interval_count
      },
      calculated: calculatedRuntime,
      discrepancies,
      total_discrepancy: totalDiscrepancy,
      total_discrepancy_minutes: Math.round(totalDiscrepancy / 60 * 100) / 100,
      is_significant: isSignificant,
      threshold_seconds: THRESHOLD_SECONDS
    };

    // Log results
    if (isSignificant) {
      console.warn(`[RuntimeValidator] ⚠️ SIGNIFICANT DISCREPANCY DETECTED!`);
      console.warn(`[RuntimeValidator] Total discrepancy: ${result.total_discrepancy_minutes} minutes`);
      console.warn(`[RuntimeValidator] Ecobee total: ${Math.round((ecobeeRuntime.total_heating + ecobeeRuntime.total_cooling + ecobeeRuntime.total_aux_heat) / 60)} min`);
      console.warn(`[RuntimeValidator] Our total: ${Math.round((calculatedRuntime.total_heating + calculatedRuntime.total_cooling + calculatedRuntime.total_aux_heat) / 60)} min`);

      // Optionally post correction event to Core
      if (user_id) {
        const payload = buildCorePayload({
          deviceKey: hvac_id,
          userId: user_id,
          eventType: 'RUNTIME_VALIDATION_MISMATCH',
          equipmentStatus: 'VALIDATION',
          isActive: false,
          observedAt: new Date(),
          sourceEventId: uuidv4(),
          payloadRaw: {
            validation_date: date,
            ecobee_runtime_seconds: ecobeeRuntime.total_heating + ecobeeRuntime.total_cooling + ecobeeRuntime.total_aux_heat,
            calculated_runtime_seconds: calculatedRuntime.total_heating + calculatedRuntime.total_cooling + calculatedRuntime.total_aux_heat,
            discrepancy_seconds: totalDiscrepancy,
            discrepancy_minutes: result.total_discrepancy_minutes
          }
        });

        try {
          await postToCoreIngestAsync(payload, 'runtime-validation-mismatch');
        } catch (err) {
          console.error(`[RuntimeValidator] Failed to post validation mismatch:`, err.message);
        }
      }
    } else {
      console.log(`[RuntimeValidator] ✅ Runtime validation passed (discrepancy: ${result.total_discrepancy_minutes} min)`);
    }

    return result;
  } catch (err) {
    console.error(`[RuntimeValidator] Error validating runtime for ${hvac_id} on ${date}:`, err.message);
    throw err;
  }
}

/**
 * Validate runtime for yesterday (typical daily job)
 * @param {string} access_token - Ecobee access token
 * @param {string} user_id - User ID
 * @param {string} hvac_id - Thermostat identifier
 * @returns {Promise<object>} Validation results
 */
export async function validateYesterdayRuntime(access_token, user_id, hvac_id) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().split('T')[0]; // YYYY-MM-DD

  return validateRuntimeForDate(access_token, user_id, hvac_id, dateStr);
}
