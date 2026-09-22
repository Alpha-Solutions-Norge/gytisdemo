const { getChildrenFromIndex } = require("./family-index");

const RACKBEAT_BASE = "https://app.rackbeat.com/api";
const MOTHER_SKU_FIELD_ID = 2; // "Mother SKU" custom field, available_for: "item"

function rackbeatHeaders() {
  return {
    Authorization: `Bearer ${process.env.RACKBEAT_API_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function getOwnFieldValues(itemNumber) {
  const res = await fetch(
    `${RACKBEAT_BASE}/products/${encodeURIComponent(itemNumber)}/fields`,
    { headers: rackbeatHeaders() }
  );
  const data = await res.json();
  return data.field_values || [];
}

// If `itemNumber` is itself a child (has a Mother SKU field pointing elsewhere),
// returns that mother's item number. Returns null for a mother or a standalone
// product (neither has this field pointing anywhere).
async function getOwnMotherSku(itemNumber) {
  const fieldValues = await getOwnFieldValues(itemNumber);
  const motherField = fieldValues.find(
    (f) => f.field && f.field.id === MOTHER_SKU_FIELD_ID
  );
  return motherField ? motherField.value : null;
}

// Reads the persisted mother->children index (lib/family-index.js) instead of
// scanning the catalog. The index is maintained incrementally by
// api/product-webhook.js on Rackbeat's product.created/product.updated
// events, so this stays O(1) regardless of catalog size - replaces an
// earlier full-catalog-scan approach that started tripping Rackbeat's rate
// limiter once the catalog grew past ~60 products.
async function findChildrenOf(motherSku) {
  return getChildrenFromIndex(motherSku);
}

module.exports = {
  RACKBEAT_BASE,
  MOTHER_SKU_FIELD_ID,
  rackbeatHeaders,
  getOwnFieldValues,
  getOwnMotherSku,
  findChildrenOf,
};
