// Short-lived per-key mutual-exclusion lock, backed by the same Upstash
// Redis store as lib/family-index.js (plain REST fetch, no new dependency).
//
// Why this exists: sync.js's family re-pool logic had no protection against
// multiple concurrent invocations processing the SAME family at once. A
// burst of several real shipments within a few minutes (2026-09-22 incident,
// see project_mother_sku_infrastructure memory) produced overlapping
// sync.js invocations that each read "truth" and wrote it to every member
// with no coordination - even after fixing the location-selection
// amplification bug separately, concurrent reads-then-writes could still
// interleave and stomp on each other, drifting values into the hundreds.
// This lock serializes repool passes per family so that never happens: a
// contended invocation backs off briefly, and if it still can't get the
// lock, fails loudly (500) so Rackbeat's own webhook retry redelivers it
// later - by then the lock is free and the retry reads genuinely fresh
// truth, converging correctly. Nothing is silently dropped.

const UPSTASH_URL = process.env.KV_REST_API_URL;
const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN;

async function redisCommand(...args) {
  const res = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(`Upstash command ${JSON.stringify(args)} failed: ${data.error}`);
  }
  return data.result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Tries to acquire `key` for up to `ttlMs`. Retries with a short backoff up
// to `maxWaitMs` total before giving up. Returns true if acquired.
async function acquireLock(key, { ttlMs = 15000, maxWaitMs = 8000, retryDelayMs = 400 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  do {
    const result = await redisCommand("SET", key, "1", "NX", "PX", String(ttlMs));
    if (result === "OK") return true;
    await sleep(retryDelayMs);
  } while (Date.now() < deadline);
  return false;
}

async function releaseLock(key) {
  try {
    await redisCommand("DEL", key);
  } catch {
    // Best-effort - the TTL will clear it anyway if this fails.
  }
}

module.exports = { acquireLock, releaseLock };
