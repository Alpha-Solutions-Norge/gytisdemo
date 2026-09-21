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

// This store's whole catalog is small (15 products as of 2026-09) - a full
// scan on every event is cheap. Revisit if the catalog grows a lot.
async function findChildrenOf(motherSku) {
  const res = await fetch(`${RACKBEAT_BASE}/products?limit=200`, {
    headers: rackbeatHeaders(),
  });
  const data = await res.json();
  const children = [];

  for (const product of data.products || []) {
    const ownMother = await getOwnMotherSku(product.number);
    if (ownMother === motherSku) {
      children.push(product.number);
    }
  }

  return children;
}

module.exports = {
  RACKBEAT_BASE,
  MOTHER_SKU_FIELD_ID,
  rackbeatHeaders,
  getOwnFieldValues,
  getOwnMotherSku,
  findChildrenOf,
};
