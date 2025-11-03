'use strict';

import { validateYesterdayRuntime } from './runtimeValidator.js';
import { loadAllTokens, updateTokensAfterRefresh } from './db.js';
import { refreshEcobeeTokens } from './ecobeeApi.js';
import { isExpiringSoon } from './util.js';

/**
 * Run runtime validation for all registered thermostats
 * Typically runs once daily at 00:05 UTC to validate previous day's data
 */
export async function runDailyRuntimeValidation() {
  console.log('\n🔍 [RuntimeValidation] Starting daily runtime validation job...');
  const startTime = Date.now();

  try {
    const tokens = await loadAllTokens();

    if (tokens.length === 0) {
      console.log('[RuntimeValidation] No thermostats registered, skipping validation');
      return;
    }

    console.log(`[RuntimeValidation] Validating runtime for ${tokens.length} thermostat(s)`);

    const results = [];

    for (const row of tokens) {
      const { user_id, hvac_id } = row;
      let { access_token, refresh_token, expires_at } = row;

      try {
        // Ensure token is valid
        if (isExpiringSoon(expires_at)) {
          console.log(`[RuntimeValidation] Refreshing token for ${hvac_id}`);
          const refreshed = await refreshEcobeeTokens(refresh_token);
          access_token = refreshed.access_token;
          refresh_token = refreshed.refresh_token;
          await updateTokensAfterRefresh({
            user_id,
            hvac_id,
            access_token,
            refresh_token,
            expires_in: refreshed.expires_in
          });
        }

        // Run validation for yesterday
        const result = await validateYesterdayRuntime(access_token, user_id, hvac_id);
        results.push({ hvac_id, success: true, result });

      } catch (err) {
        console.error(`[RuntimeValidation] Failed to validate ${hvac_id}:`, err.message);
        results.push({ hvac_id, success: false, error: err.message });
      }
    }

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    const duration = Math.round((Date.now() - startTime) / 1000);

    console.log(`\n[RuntimeValidation] ✅ Daily validation complete: ${successful} succeeded, ${failed} failed (${duration}s)`);

    // Log significant discrepancies
    const significant = results
      .filter(r => r.success && r.result?.is_significant)
      .map(r => ({
        hvac_id: r.hvac_id,
        discrepancy_minutes: r.result.total_discrepancy_minutes
      }));

    if (significant.length > 0) {
      console.warn(`[RuntimeValidation] ⚠️ Found ${significant.length} thermostat(s) with significant discrepancies:`);
      significant.forEach(s => {
        console.warn(`  - ${s.hvac_id}: ${s.discrepancy_minutes} minutes`);
      });
    }

    return results;

  } catch (err) {
    console.error('[RuntimeValidation] Error during daily validation:', err.message);
    throw err;
  }
}

/**
 * Calculate milliseconds until next scheduled run (00:05 UTC)
 * @returns {number} Milliseconds until next run
 */
function getMillisUntilNextRun() {
  const now = new Date();
  const next = new Date();

  // Set to 00:05 UTC
  next.setUTCHours(0, 5, 0, 0);

  // If we've already passed 00:05 today, schedule for tomorrow
  if (now >= next) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  const msUntilNext = next.getTime() - now.getTime();
  const hoursUntilNext = Math.round(msUntilNext / 1000 / 60 / 60 * 10) / 10;

  console.log(`[RuntimeValidation] Next validation scheduled for ${next.toISOString()} (in ${hoursUntilNext} hours)`);

  return msUntilNext;
}

/**
 * Schedule the daily runtime validation job
 * Runs at 00:05 UTC every day
 */
export function scheduleDailyRuntimeValidation() {
  let timeoutId;

  const scheduleNext = () => {
    const msUntilNext = getMillisUntilNextRun();

    timeoutId = setTimeout(async () => {
      try {
        await runDailyRuntimeValidation();
      } catch (err) {
        console.error('[RuntimeValidation] Scheduled validation failed:', err.message);
      }

      // Schedule next run
      scheduleNext();
    }, msUntilNext);
  };

  // Start scheduling
  scheduleNext();

  console.log('[RuntimeValidation] 📅 Daily validation scheduler started');

  // Return cleanup function
  return () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      console.log('[RuntimeValidation] Daily validation scheduler stopped');
    }
  };
}

/**
 * Run validation immediately for testing purposes
 * @param {string} hvac_id - Optional specific thermostat to validate
 */
export async function runValidationNow(hvac_id = null) {
  console.log('\n[RuntimeValidation] Running immediate validation (testing mode)...');

  const tokens = await loadAllTokens();
  const filteredTokens = hvac_id
    ? tokens.filter(t => t.hvac_id === hvac_id)
    : tokens;

  if (filteredTokens.length === 0) {
    console.log('[RuntimeValidation] No matching thermostats found');
    return;
  }

  for (const row of filteredTokens) {
    const { user_id, hvac_id: id } = row;
    let { access_token, refresh_token, expires_at } = row;

    try {
      if (isExpiringSoon(expires_at)) {
        const refreshed = await refreshEcobeeTokens(refresh_token);
        access_token = refreshed.access_token;
        refresh_token = refreshed.refresh_token;
        await updateTokensAfterRefresh({
          user_id,
          hvac_id: id,
          access_token,
          refresh_token,
          expires_in: refreshed.expires_in
        });
      }

      await validateYesterdayRuntime(access_token, user_id, id);
    } catch (err) {
      console.error(`[RuntimeValidation] Error validating ${id}:`, err.message);
    }
  }
}
