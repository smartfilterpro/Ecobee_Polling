// poller-adaptive.js
'use strict';

import { loadAllTokens } from './db.js';
import { processThermostat } from './poller.js'; // ← your existing function
import { nowUtc } from './util.js';

/* -------------------------------------------------------------------------- */
/*                          Adaptive Poll Scheduler                           */
/* -------------------------------------------------------------------------- */

export async function startPollerAdaptive() {
  const tokens = await loadAllTokens();
  if (!tokens.length) {
    console.log('⚠️ No thermostats found — exiting adaptive poller.');
    return;
  }

  console.log(`\n🚀 Starting Adaptive Ecobee Poller — ${tokens.length} device(s) @ ${nowUtc()}`);

  for (const token of tokens) {
    scheduleDevicePoll(token);
  }
}

/**
 * Per-device scheduler that re-schedules itself based on runtime feedback.
 */
async function scheduleDevicePoll(token) {
  const { hvac_id } = token;

  const run = async () => {
    const start = Date.now();
    try {
      const result = await processThermostat(token);

      // Use adaptive delay from runtime handler, defaulting to 180s
      const delaySec = Math.min(Math.max(result?.nextPollSeconds || 180, 60), 900);
      const elapsed = Math.round((Date.now() - start) / 1000);

      console.log(`[${hvac_id}] ✅ Poll completed in ${elapsed}s — next in ${delaySec}s`);
      setTimeout(run, delaySec * 1000);
    } catch (err) {
      console.error(`[${hvac_id}] ✗ Poll failed: ${err.message}`);
      const backoff = 300; // 5 min on error
      console.log(`[${hvac_id}] 💤 Retrying in ${backoff}s`);
      setTimeout(run, backoff * 1000);
    }
  };

  // Kick off immediately
  run();
}

/* -------------------------------------------------------------------------- */
/*                               Stop Function                                */
/* -------------------------------------------------------------------------- */
let stopRequested = false;
export function stopPollerAdaptive() {
  stopRequested = true;
  console.log('🛑 Adaptive poller stop requested (new timers will not be scheduled).');
}
