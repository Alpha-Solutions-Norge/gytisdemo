const { RACKBEAT_BASE, rackbeatHeaders, getOwnMotherSku } = require("../lib/rackbeat");
const { getProductMetafieldForSku } = require("../lib/shopify");

// Fires on Rackbeat's `order.created` event, before the order is ever booked
// or shipped - the earliest safe point to intercept it. Two independent
// per-line annotations happen here, both purely on the Rackbeat side (never
// touching Shopify), since Rackbeat order lines have a fixed schema with no
// custom fields of their own - the line's free-text `name` is the only place
// to carry this:
//
// 1. Rewrites any line sold under a child SKU (e.g. GAFIA-ST017, one of 4
//    Shopify listings for the same physical seat cover) to reference the
//    mother item instead (GAHOV-ST0066), so a shipment always decrements the
//    pooled mother stock, never a child's own independent ledger. This is
//    what makes the reactive re-pooling in sync.js mostly a safety net rather
//    than the primary defense - see project_mother_sku_infrastructure memory.
// 2. Appends the product's `custom.cut_length` Shopify metafield (when set)
//    onto the line name, so the warehouse sees it on the Rackbeat order -
//    this is intentionally invisible on the Shopify side (cart, checkout,
//    emails) since it's only relevant to fulfillment.
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

async function updateLine(orderNumber, line, targetItemId, newName) {
  const res = await fetch(
    `${RACKBEAT_BASE}/orders/${encodeURIComponent(orderNumber)}/lines/${line.id}`,
    {
      method: "PUT",
      headers: rackbeatHeaders(),
      body: JSON.stringify({
        item_id: targetItemId,
        // Preserve exactly what the customer actually bought and paid for -
        // swapping the item alone would otherwise reset pricing to the
        // target item's own (internal, not customer-facing) sales price.
        name: newName,
        line_price: line.line_price,
        discount_percentage: line.discount_percentage,
        vat_percentage: line.vat_percentage,
      }),
    }
  );
  const result = await res.json();
  if (!res.ok) {
    throw new Error(`Failed to update line ${line.id} on order ${orderNumber}: ${JSON.stringify(result)}`);
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

    // Each line is handled independently, in its own try/catch: a failure on
    // one line (e.g. the order getting booked mid-request, locking that
    // specific line - a real race hit on 2026-09-22, see
    // project_mother_sku_infrastructure memory) must never abort processing
    // of the REMAINING lines. The original version threw out of the loop on
    // the first failure, silently skipping every line after it - including,
    // in that incident, the actual mother-SKU rewrite the whole function
    // exists for. Lines are also sorted so mother-SKU rewrites (the
    // stock-pooling-critical ones) are attempted before cut-length-only
    // annotations (cosmetic/fulfillment-note only), so if time genuinely
    // does run out before booking, the more important updates land first.
    const candidates = [];
    for (const line of order.lines || []) {
      if (line.child_type !== "product") continue; // only products carry custom fields/Mother SKU

      const motherSku = await getOwnMotherSku(line.child_id);
      const cutLength = await getProductMetafieldForSku(line.child_id, "custom", "cut_length");
      if (!motherSku && !cutLength) continue; // nothing to annotate on this line

      candidates.push({ line, motherSku, cutLength });
    }
    candidates.sort((a, b) => (b.motherSku ? 1 : 0) - (a.motherSku ? 1 : 0));

    for (const { line, motherSku, cutLength } of candidates) {
      let newName = line.name;
      const soldAsSuffix = ` — sold as ${line.child_id}`;
      if (motherSku && !newName.includes(soldAsSuffix)) {
        newName = `${newName}${soldAsSuffix}`;
      }
      if (cutLength && !newName.includes("Cut-length:")) {
        newName = `${newName} — Cut-length: ${cutLength}`;
      }

      const targetItemId = motherSku || line.child_id;
      if (targetItemId === line.child_id && newName === line.name) continue; // idempotent no-op on retry

      try {
        await updateLine(orderNumber, line, targetItemId, newName);
        rewrites.push({ lineId: line.id, from: line.child_id, to: targetItemId, name: newName, result: "ok" });
      } catch (lineError) {
        rewrites.push({ lineId: line.id, from: line.child_id, to: targetItemId, error: String(lineError) });
      }
    }

    res.status(200).json({ ok: true, order: orderNumber, rewrites });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
};
