export const PORT = Number(process.env.PORT || 3000);

export const BUBBLE_THERMOSTAT_UPDATES_URL = (process.env.BUBBLE_THERMOSTAT_UPDATES_URL || "").trim();
export const CORE_INGEST_URL = (process.env.CORE_INGEST_URL || "https://core-ingest-ingest.up.railway.app").trim();

export const ECOBEE_CLIENT_ID = (process.env.ECOBEE_CLIENT_ID || "").trim();
export const ECOBEE_TOKEN_URL = "https://api.ecobee.com/token";

export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60_000);
export const ERROR_BACKOFF_MS = Number(process.env.ERROR_BACKOFF_MS || 120_000);
export const MAX_ACCUMULATE_SECONDS = Number(process.env.MAX_ACCUMULATE_SECONDS || 600);

// Force post at least once every 12 hours, even if values haven't changed
export const MAX_TIME_BETWEEN_POSTS_MS = Number(process.env.MAX_TIME_BETWEEN_POSTS_MS || 43_200_000); // 12 hours

// Connectivity knobs
export const REACHABILITY_STALE_MS = Math.max(60_000, Number(process.env.REACHABILITY_STALE_MS || 900_000));
export const CONNECTIVITY_CHECK_EVERY_MS = Math.max(15_000, Number(process.env.CONNECTIVITY_CHECK_EVERY_MS || 60_000));
export const PUBLISH_CONNECTIVITY = process.env.PUBLISH_CONNECTIVITY === "0" ? false : true;

// Parallel processing
export const POLL_CONCURRENCY = Math.max(1, Number(process.env.POLL_CONCURRENCY || 5));

// Retry configuration
export const BUBBLE_POST_RETRIES = Number(process.env.BUBBLE_POST_RETRIES || 3);
export const BUBBLE_POST_RETRY_DELAY_MS = Number(process.env.BUBBLE_POST_RETRY_DELAY_MS || 1000);
export const CORE_POST_RETRIES = Number(process.env.CORE_POST_RETRIES || 3);
export const CORE_POST_RETRY_DELAY_MS = Number(process.env.CORE_POST_RETRY_DELAY_MS || 1000);

export const DATABASE_URL = process.env.DATABASE_URL;
export const PGSSLMODE = process.env.PGSSLMODE;
