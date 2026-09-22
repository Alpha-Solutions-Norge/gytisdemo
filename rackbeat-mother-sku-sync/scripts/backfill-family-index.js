// One-time script: populates lib/family-index.js from the current Rackbeat
// catalog. Run this once when the index goes live, so findChildrenOf() has
// data before the first product.updated webhook ever fires for a given
// family. Safe to re-run - setMotherForChild() is idempotent per product.
//
// Usage: node scripts/backfill-family-index.js
// Requires RACKBEAT_API_KEY, KV_REST_API_URL, KV_REST_API_TOKEN in the
// environment (e.g. `vercel env pull .env.local` then load it, or export
// them directly - this script does not read .env.local itself).

const { RACKBEAT_BASE, rackbeatHeaders, getOwnMotherSku } = require("../lib/rackbeat");
const { setMotherForChild } = require("../lib/family-index");

async function main() {
  const res = await fetch(`${RACKBEAT_BASE}/products?limit=200`, {
    headers: rackbeatHeaders(),
  });
  const data = await res.json();
  const products = data.products || [];
  console.log(`Backfilling family index from ${products.length} products...`);

  let familyMembers = 0;
  for (const product of products) {
    const motherSku = await getOwnMotherSku(product.number);
    if (motherSku) {
      await setMotherForChild(product.number, motherSku);
      familyMembers++;
      console.log(`  ${product.number} -> mother ${motherSku}`);
    }
  }

  console.log(`Done. ${familyMembers} child products indexed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
