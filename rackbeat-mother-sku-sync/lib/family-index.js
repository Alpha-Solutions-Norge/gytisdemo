// Persisted mother-SKU -> children index, backed by Upstash Redis (REST API,
// plain fetch - no new npm dependency, consistent with the rest of this repo).
//
// Why this exists: findChildrenOf() used to do a full Rackbeat catalog scan
// (fetch every product, then call /products/{number}/fields on each one) on
// every order.created / stock-change event. That was fine at 15 products but
// started tripping Rackbeat's rate limiter once the catalog grew to 67 (see
// project_rackbeat memory - "Too Many Attempts" errors on webhook 204319).
// The index below is updated incrementally (O(1) per affected product) via
// Rackbeat's product.created/product.updated webhook (api/product-webhook.js)
// instead, so the hot path (sync.js, shopify-order-webhook.js,
// order-transform.js) never scans the catalog again.
//
// Data model (two keys per relationship, kept in sync together):
//   family:children:<motherSku>  -> Redis SET of child SKUs
//   family:mother:<childSku>     -> Redis STRING, the child's current mother SKU
// The reverse pointer (family:mother:*) is what lets setMotherForChild() find
// and clean up a *previous* mother when a child's Mother SKU field is
// reassigned or cleared, instead of leaving stale entries behind.

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

async function redisPipeline(commands) {
  const res = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  const results = await res.json();
  for (const r of results) {
    if (r.error) {
      throw new Error(`Upstash pipeline command failed: ${r.error}`);
    }
  }
  return results.map((r) => r.result);
}

function childrenKey(motherSku) {
  return `family:children:${motherSku}`;
}

function motherKey(childSku) {
  return `family:mother:${childSku}`;
}

// Plain O(1) index read - replaces the old full-catalog scan.
async function getChildrenFromIndex(motherSku) {
  const members = await redisCommand("SMEMBERS", childrenKey(motherSku));
  return members || [];
}

async function getMotherFromIndex(childSku) {
  const value = await redisCommand("GET", motherKey(childSku));
  return value || null;
}

// Call this whenever a product's own Mother SKU field is set, changed, or
// cleared (i.e. from the product.updated/product.created webhook). Handles
// all three cases in one call:
//   - brand-new family: newMotherSku set, no previous entry -> just adds
//   - child added to an existing mother: appends to that mother's set,
//     doesn't touch or overwrite any other child already in it
//   - reassigned/removed: removes childSku from its OLD mother's set first
//     (found via the reverse pointer), then adds to the new one if any
async function setMotherForChild(childSku, newMotherSku) {
  const oldMotherSku = await getMotherFromIndex(childSku);

  if (oldMotherSku === (newMotherSku || null)) {
    return; // already correct, nothing to do
  }

  const commands = [];
  if (oldMotherSku) {
    commands.push(["SREM", childrenKey(oldMotherSku), childSku]);
  }
  if (newMotherSku) {
    commands.push(["SADD", childrenKey(newMotherSku), childSku]);
    commands.push(["SET", motherKey(childSku), newMotherSku]);
  } else {
    commands.push(["DEL", motherKey(childSku)]);
  }

  await redisPipeline(commands);
}

module.exports = {
  getChildrenFromIndex,
  getMotherFromIndex,
  setMotherForChild,
};
