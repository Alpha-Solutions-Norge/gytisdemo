const { RACKBEAT_BASE, rackbeatHeaders, getOwnMotherSku } = require("../lib/rackbeat");

// Fires on Rackbeat's `order.created` event, before the order is ever booked
// or shipped - the earliest safe point to intercept it. Rewrites any line
// that was sold under a child SKU (e.g. GAFIA-ST017, one of 4 Shopify listings
// for the same physical seat cover) to reference the mother item instead
// (GAHOV-ST0066), so a shipment always decrements the pooled mother stock,
// never a child's own independent ledger. This is what makes the reactive
// re-pooling in sync.js mostly a safety net rather than the primary defense -
// see project_mother_sku_infrastructure memory for the reactive half.
async function getOrder(orderNumber) {
  const res = await fetch(
    `${RACKBEAT_BASE}/orders/${encodeURIComponent(orderNumber)}`,
    { headers: rackbeatHeaders() }
  );
  const data = await res.json();
  if (!data.order) {
    throw new Error(`Failed to fetch order ${orderNumber}: ${JSON.stringify(data)}`);
  }
  return data.order;
}

async function rewriteLineToMother(orderNumber, line, motherSku) {
  const res = await fetch(
    `${RACKBEAT_BASE}/orders/${encodeURIComponent(orderNumber)}/lines/${line.id}`,
    {
      method: "PUT",
      headers: rackbeatHeaders(),
      body: JSON.stringify({
        item_id: motherSku,
        // Preserve exactly what the customer actually bought and paid for -
        // swapping the item alone would otherwise reset pricing to the
        // mother's own (internal, not customer-facing) sales price.
        name: `${line.name} — sold as ${line.child_id}`,
        line_price: line.line_price,
        discount_percentage: line.discount_percentage,
        vat_percentage: line.vat_percentage,
      }),
    }
  );
  const result = await res.json();
  if (!res.ok) {
    throw new Error(`Failed to rewrite line ${line.id} on order ${orderNumber}: ${JSON.stringify(result)}`);
  }
  return result;
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

  // Real delivery bodies for this event are just {"key_name":"number","key":"1021"} -
  // no "event" field despite what Rackbeat's own webhook-events docs example shows.
  // This URL is registered for order.created only, so no event check is needed;
  // the header is checked anyway as a defensive no-op guard against misconfiguration.
  const eventHeader = req.headers["rackbeat-webhook-event"];
  if (eventHeader && eventHeader !== "order.created") {
    res.status(200).json({ skipped: true });
    return;
  }

  const payload = req.body || {};
  const orderNumber = payload.key;

  try {
    const order = await getOrder(orderNumber);
    const rewrites = [];

    for (const line of order.lines || []) {
      if (line.child_type !== "product") continue; // only products carry a Mother SKU field
      const motherSku = await getOwnMotherSku(line.child_id);
      if (!motherSku) continue; // already the mother, or a standalone product

      const result = await rewriteLineToMother(orderNumber, line, motherSku);
      rewrites.push({ lineId: line.id, from: line.child_id, to: motherSku, result: "ok" });
    }

    res.status(200).json({ ok: true, order: orderNumber, rewrites });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
};
