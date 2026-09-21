const crypto = require("crypto");
const {
  RACKBEAT_BASE,
  rackbeatHeaders,
  getOwnMotherSku,
  findChildrenOf,
} = require("../lib/rackbeat");

const SHOP_DOMAIN = "gytisdemo.myshopify.com";

async function getStockTruth(sku) {
  const res = await fetch(`${RACKBEAT_BASE}/products/${encodeURIComponent(sku)}`, {
    headers: rackbeatHeaders(),
  });
  const data = await res.json();
  if (!data.product || typeof data.product.stock_quantity !== "number") {
    throw new Error(`Failed to read stock_quantity for ${sku}: ${JSON.stringify(data)}`);
  }
  return data.product.stock_quantity;
}

async function createAndBookAdjustment(itemNumber, locationNumber, targetQuantity, reason) {
  const createRes = await fetch(`${RACKBEAT_BASE}/inventory-adjustments`, {
    method: "POST",
    headers: rackbeatHeaders(),
    body: JSON.stringify({
      item_id: itemNumber,
      adjustment_type: "quantity",
      quantity: targetQuantity,
      location: locationNumber,
      regulated_at: new Date().toISOString().slice(0, 10),
      reason,
    }),
  });
  const created = await createRes.json();
  if (!created.inventory_regulation) {
    throw new Error(`Failed to create adjustment for ${itemNumber}: ${JSON.stringify(created)}`);
  }
  const adjId = created.inventory_regulation.id;

  const bookRes = await fetch(`${RACKBEAT_BASE}/inventory-adjustments/${adjId}/book`, {
    method: "POST",
    headers: rackbeatHeaders(),
  });
  if (!bookRes.ok) {
    throw new Error(`Failed to book adjustment ${adjId} for ${itemNumber}`);
  }
}

// Sets a family member's Rackbeat total to newTotal by adjusting only its
// "home" location (whichever currently holds the most stock) - leaving any
// other location's stock untouched. This is deliberately gentler than fully
// consolidating onto one fixed location: the mother SKU can legitimately have
// real stock split across multiple physical locations, and forcing it onto
// one would destroy that. Works fine for children too, since they only ever
// have stock at one location in practice.
async function setTotalAtHomeLocation(itemNumber, newTotal) {
  const locRes = await fetch(
    `${RACKBEAT_BASE}/products/${encodeURIComponent(itemNumber)}/locations`,
    { headers: rackbeatHeaders() }
  );
  const locData = await locRes.json();
  const locations = locData.product_locations || [];
  if (locations.length === 0) return;

  const home = locations.reduce(
    (best, loc) => (loc.stock_quantity > best.stock_quantity ? loc : best),
    locations[0]
  );
  const otherLocationsTotal = locations
    .filter((loc) => loc.number !== home.number)
    .reduce((sum, loc) => sum + loc.stock_quantity, 0);
  const newHomeQuantity = newTotal - otherLocationsTotal;

  // Rackbeat rejects a zero-delta adjustment as an error ("Adjustment can't be
  // created, since no change is made.") rather than accepting it as a no-op.
  // Redundant follow-up events (e.g. a child's own mirrored-change event
  // re-checking a mother that's already correct) are common under the
  // symmetric re-pool design above, so skip the write when nothing would change.
  if (newHomeQuantity === home.stock_quantity) return;

  await createAndBookAdjustment(
    itemNumber,
    home.number,
    newHomeQuantity,
    "Re-pool shared mother-SKU stock"
  );
}

// --- Direct Shopify correction. This function is now the SOLE writer of
// inventory for this store - Rackbeat's own native Shopify inventory webhook
// (id 204320) has been disabled because it applied un-reconciled deltas with
// unbounded delivery delay (see project_rackbeat_shopify_sync_bug memory).
// With no second writer left to race, a single immediate correction per
// event is enough - no more settle delays or repeated passes needed.

let cachedShopifyToken = null; // { token, expiresAt }

async function getShopifyAdminToken() {
  if (cachedShopifyToken && cachedShopifyToken.expiresAt > Date.now() + 60000) {
    return cachedShopifyToken.token;
  }

  const res = await fetch(`https://${SHOP_DOMAIN}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to mint Shopify admin token: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  cachedShopifyToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedShopifyToken.token;
}

async function shopifyAdminGraphql(query, variables) {
  const token = await getShopifyAdminToken();
  const res = await fetch(`https://${SHOP_DOMAIN}/admin/api/2026-07/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

async function correctShopifyStock(sku, targetQuantity) {
  const lookup = await shopifyAdminGraphql(
    `query($q: String!) {
      productVariants(first: 1, query: $q) {
        edges {
          node {
            inventoryItem {
              id
              tracked
              inventoryLevels(first: 20) {
                edges { node { location { id } quantities(names: ["available"]) { quantity } } }
              }
            }
          }
        }
      }
    }`,
    { q: `sku:${sku}` }
  );

  const variant = lookup.data && lookup.data.productVariants.edges[0];
  if (!variant) return { sku, skipped: "not found in Shopify" };
  if (!variant.node.inventoryItem.tracked) return { sku, skipped: "inventory not tracked" };

  const inventoryItemId = variant.node.inventoryItem.id;
  const levels = variant.node.inventoryItem.inventoryLevels.edges.map((e) => ({
    locationId: e.node.location.id,
    quantity: e.node.quantities[0] ? e.node.quantities[0].quantity : 0,
  }));

  if (levels.length === 0) return { sku, skipped: "no inventory levels in Shopify" };

  const currentTotal = levels.reduce((sum, l) => sum + l.quantity, 0);
  if (currentTotal === targetQuantity) {
    return { sku, skipped: "already correct" };
  }

  // Don't assume a single fixed location - different products in this
  // catalog live at different Shopify locations. Adjust whichever location
  // already holds the item's stock, leaving any other (typically zero)
  // location untouched, rather than guessing where the "right" place is.
  const home = levels.reduce((best, l) => (l.quantity > best.quantity ? l : best), levels[0]);
  const otherLocationsTotal = currentTotal - home.quantity;
  const newHomeQuantity = targetQuantity - otherLocationsTotal;

  const result = await shopifyAdminGraphql(
    `mutation($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
      inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
        userErrors { field message }
      }
    }`,
    {
      input: {
        name: "available",
        reason: "correction",
        referenceDocumentUri: `gid://rackbeat-mother-sku-sync/Correction/${sku}-${Date.now()}`,
        quantities: [
          {
            inventoryItemId,
            locationId: home.locationId,
            quantity: newHomeQuantity,
            changeFromQuantity: home.quantity,
          },
        ],
      },
      idempotencyKey: crypto.randomUUID(),
    }
  );

  const errors =
    (result.data &&
      result.data.inventorySetQuantities &&
      result.data.inventorySetQuantities.userErrors) ||
    result.errors;

  if (errors && errors.length > 0) {
    return { sku, error: errors };
  }
  return { sku, corrected: `${currentTotal} -> ${targetQuantity}` };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (req.query.secret !== process.env.WEBHOOK_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const payload = req.body || {};
  const { item, item_type, type } = payload;

  if (item_type !== "product" || type !== "stock") {
    res.status(200).json({ skipped: true });
    return;
  }

  try {
    // Symmetric handling: it doesn't matter whether the event came from the
    // mother's own stock changing or from one specific child's own stock
    // changing (e.g. that child's own order got shipped in Rackbeat,
    // decrementing only its own ledger) - either way, resolve up to the
    // family's mother, and re-pool every member (including the mother
    // itself) to whichever value just actually changed. The previous version
    // only re-pooled when the mother's own event fired, so a child selling
    // on its own silently broke the pool - this fixes that.
    const ownMotherSku = await getOwnMotherSku(item);
    const familyRoot = ownMotherSku || item;
    const children = await findChildrenOf(familyRoot);
    const truth = await getStockTruth(item); // whichever item actually just changed is the freshest truth

    if (children.length === 0 && !ownMotherSku) {
      // Genuinely standalone - no mother-SKU relationship either direction.
      const result = await correctShopifyStock(item, truth);
      res.status(200).json({ ok: true, item, truth, result });
      return;
    }

    const allMembers = Array.from(new Set([familyRoot, ...children]));

    for (const member of allMembers) {
      if (member === item) continue; // already correct in Rackbeat - it's the one that just changed
      await setTotalAtHomeLocation(member, truth);
    }

    const results = [];
    for (const member of allMembers) {
      results.push(await correctShopifyStock(member, truth));
    }

    res.status(200).json({
      ok: true,
      triggeredBy: item,
      familyRoot,
      members: allMembers,
      truth,
      results,
    });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
};
