'use strict';

/**
 * Parse Ecobee runtime report CSV data into structured intervals
 *
 * Ecobee runtime reports are returned as CSV strings with format:
 * Date,Time,auxHeat1,auxHeat2,auxHeat3,compCool1,compCool2,compHeat1,compHeat2,fan,outdoorTemp,zoneAveTemp,zoneHumidity,hvacMode
 *
 * Runtime values (auxHeat1, compCool1, etc.) are in SECONDS (0-300 for 5-min intervals)
 * Temperature values are in tenths of degrees Fahrenheit
 *
 * @param {object} reportData - Response from fetchRuntimeReport API
 * @param {string} hvac_id - Thermostat identifier
 * @returns {object[]} Array of parsed interval objects
 */
export function parseRuntimeReport(reportData, hvac_id) {
  if (!reportData?.reportList || !Array.isArray(reportData.reportList) || reportData.reportList.length === 0) {
    console.warn('[parseRuntimeReport] No report data found');
    return [];
  }

  const thermostatReport = reportData.reportList[0];
  if (!thermostatReport?.rowList || !Array.isArray(thermostatReport.rowList)) {
    console.warn('[parseRuntimeReport] No row data in report');
    return [];
  }

  const columns = reportData.columns?.split(',') || [];
  const rows = thermostatReport.rowList;

  const intervals = [];

  for (const row of rows) {
    const values = row.split(',');

    // First two columns are always Date and Time
    const date = values[0];
    const time = values[1];

    if (!date || !time) {
      console.warn('[parseRuntimeReport] Skipping row with missing date/time:', row);
      continue;
    }

    // Combine date and time into ISO timestamp
    const interval_timestamp = new Date(`${date}T${time}Z`).toISOString();

    // Map remaining columns to their values
    const dataMap = {};
    for (let i = 0; i < columns.length; i++) {
      const columnName = columns[i].trim();
      const value = values[i + 2]; // +2 to skip Date and Time columns

      // Parse numeric values
      if (value !== undefined && value !== null && value !== '') {
        const numValue = parseFloat(value);
        if (!isNaN(numValue)) {
          dataMap[columnName] = numValue;
        } else {
          dataMap[columnName] = value; // Keep as string (e.g., hvacMode)
        }
      }
    }

    // Convert column names to our database field names
    const interval = {
      hvac_id,
      report_date: date,
      interval_timestamp,
      aux_heat1: dataMap.auxHeat1 || 0,
      aux_heat2: dataMap.auxHeat2 || 0,
      aux_heat3: dataMap.auxHeat3 || 0,
      comp_cool1: dataMap.compCool1 || 0,
      comp_cool2: dataMap.compCool2 || 0,
      comp_heat1: dataMap.compHeat1 || 0,
      comp_heat2: dataMap.compHeat2 || 0,
      fan: dataMap.fan || 0,
      outdoor_temp: dataMap.outdoorTemp ? dataMap.outdoorTemp / 10 : null, // Convert tenths to degrees
      zone_avg_temp: dataMap.zoneAveTemp ? dataMap.zoneAveTemp / 10 : null, // Convert tenths to degrees
      zone_humidity: dataMap.zoneHumidity || null,
      hvac_mode: dataMap.hvacMode || null
    };

    intervals.push(interval);
  }

  console.log(`[parseRuntimeReport] Parsed ${intervals.length} intervals for ${hvac_id} on ${intervals[0]?.report_date || 'unknown date'}`);
  return intervals;
}

/**
 * Calculate total equipment runtime from parsed intervals
 * @param {object[]} intervals - Array of parsed interval objects
 * @returns {object} Total runtime in seconds by equipment type
 */
export function calculateTotalRuntime(intervals) {
  const totals = {
    aux_heat: 0,
    cooling: 0,
    heating: 0,
    fan: 0,
    interval_count: intervals.length
  };

  for (const interval of intervals) {
    totals.aux_heat += (interval.aux_heat1 || 0) + (interval.aux_heat2 || 0) + (interval.aux_heat3 || 0);
    totals.cooling += (interval.comp_cool1 || 0) + (interval.comp_cool2 || 0);
    totals.heating += (interval.comp_heat1 || 0) + (interval.comp_heat2 || 0);
    totals.fan += interval.fan || 0;
  }

  return totals;
}

/**
 * Get summary statistics from parsed intervals
 * @param {object[]} intervals - Array of parsed interval objects
 * @returns {object} Summary statistics
 */
export function getRuntimeSummary(intervals) {
  if (intervals.length === 0) {
    return {
      interval_count: 0,
      total_runtime: 0,
      aux_heat_runtime: 0,
      cooling_runtime: 0,
      heating_runtime: 0,
      fan_runtime: 0,
      coverage_percent: 0
    };
  }

  const totals = calculateTotalRuntime(intervals);
  const total_runtime = totals.aux_heat + totals.cooling + totals.heating;

  // Expected intervals per day: 288 (24 hours * 12 five-min intervals per hour)
  const expected_intervals = 288;
  const coverage_percent = (intervals.length / expected_intervals) * 100;

  return {
    interval_count: intervals.length,
    total_runtime,
    aux_heat_runtime: totals.aux_heat,
    cooling_runtime: totals.cooling,
    heating_runtime: totals.heating,
    fan_runtime: totals.fan,
    coverage_percent: Math.round(coverage_percent * 100) / 100,
    total_runtime_minutes: Math.round(total_runtime / 60 * 100) / 100,
    total_runtime_hours: Math.round(total_runtime / 3600 * 100) / 100
  };
}
