const { getOwnMotherSku } = require("../lib/rackbeat");
const { setMotherForChild } = require("../lib/family-index");

// Fires on Rackbeat's product.created and product.updated events. Keeps the
// persisted family-index (lib/family-index.js) in sync so findChildrenOf()
// in lib/rackbeat.js never has to scan the catalog - see that file's comment
// for the rate-limiting incident this replaced.
//
// Each delivery only tells us the product's own item number, not what
// changed - so this always re-reads that one product's current Mother SKU
// field value and reconciles the index against it. setMotherForChild()
// handles new families, children appended to an existing mother, and
// reassignment/removal (via its own old-mother lookup) all in one call.
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (req.query.secret !== process.env.PRODUCT_WEBHOOK_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Same delivery-body shape as the order.created webhook:
  // {"key_name":"number","key":"<item number>"}, no "event" field.
  const eventHeader = req.headers["rackbeat-webhook-event"];
  if (eventHeader && eventHeader !== "product.created" && eventHeader !== "product.updated") {
    res.status(200).json({ skipped: true });
    return;
  }

  const payload = req.body || {};
  const itemNumber = payload.key;

  if (!itemNumber) {
    res.status(400).json({ error: "Missing product item number in payload" });
    return;
  }

  try {
    const motherSku = await getOwnMotherSku(itemNumber);
    await setMotherForChild(itemNumber, motherSku);
    res.status(200).json({ ok: true, product: itemNumber, motherSku: motherSku || null });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
};
