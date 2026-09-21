const SHOP_DOMAIN = "gytisdemo.myshopify.com";

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

// Finds the SKU's inventory item and whichever location currently holds its
// stock (its "home") - same convention as rackbeat-mother-sku-sync's own
// correctShopifyStock, since different products in this catalog live at
// different Shopify locations.
async function getInventoryItemForSku(sku) {
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
  if (!variant) return null;
  if (!variant.node.inventoryItem.tracked) return null;

  const levels = variant.node.inventoryItem.inventoryLevels.edges.map((e) => ({
    locationId: e.node.location.id,
    quantity: e.node.quantities[0] ? e.node.quantities[0].quantity : 0,
  }));
  if (levels.length === 0) return null;

  const home = levels.reduce((best, l) => (l.quantity > best.quantity ? l : best), levels[0]);

  return {
    inventoryItemId: variant.node.inventoryItem.id,
    locationId: home.locationId,
    quantity: home.quantity,
  };
}

// Applies a relative delta (negative to reserve/decrement) to a SKU's
// "available" quantity at its home location. Unlike sync.js's absolute-set
// correction, this is a pure delta - used for provisional order-time
// reservations that get superseded by the next real shipment-triggered
// correction, not a source of truth in itself.
async function adjustAvailableDelta(inventoryItemId, locationId, delta, changeFromQuantity, idempotencyKey, reason) {
  const result = await shopifyAdminGraphql(
    `mutation($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
      inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
        userErrors { field message }
      }
    }`,
    {
      input: {
        name: "available",
        reason: reason || "correction",
        changes: [{ inventoryItemId, locationId, delta, changeFromQuantity }],
      },
      idempotencyKey,
    }
  );

  const errors =
    (result.data &&
      result.data.inventoryAdjustQuantities &&
      result.data.inventoryAdjustQuantities.userErrors) ||
    result.errors;

  if (errors && errors.length > 0) {
    throw new Error(`inventoryAdjustQuantities failed: ${JSON.stringify(errors)}`);
  }
}

module.exports = {
  SHOP_DOMAIN,
  getShopifyAdminToken,
  shopifyAdminGraphql,
  getInventoryItemForSku,
  adjustAvailableDelta,
};
