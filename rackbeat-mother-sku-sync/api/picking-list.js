const { RACKBEAT_BASE, rackbeatHeaders } = require("../lib/rackbeat");

// Generates one printable, consolidated picking list spanning several
// orders at once - Rackbeat itself has no such feature. Its own picking
// lists are strictly per-shipment ("Each shipment will have its own picking
// list and packing slip" - Rackbeat help desk ht-00025); the one "bulk"
// export just bundles separate per-order PDFs together, it doesn't merge
// items across orders. There's also no dedicated /picking-lists API
// endpoint - this works entirely off the regular /orders list, which
// conveniently already embeds each line's item + location.
//
// Usage: GET /api/picking-list?secret=...&count=10
//   count - how many orders to pull into the list (default 10)
//
// Order selection: the oldest `count` orders that are booked, not yet
// shipped, and not cancelled - i.e. the real "ready to pick" queue,
// FIFO. Rackbeat's /orders endpoint only supports filtering by
// number/created_at/updated_at server-side (confirmed via a live 422:
// "Property 'is_booked' is not filterable"), so eligibility is checked
// client-side while paging through oldest-first.
//
// Output grouping: items are grouped by location and sorted with a natural
// sort (so "A1-2" sorts before "A1-10", not after) - Rackbeat has no
// explicit pick-route/sequence field on locations, so the walking order is
// whatever your location *names* sort to. Within each location, an item's
// quantities are summed across all selected orders, with a per-order
// breakdown so whoever packs afterward can still tell which units belong to
// which order.

async function fetchOrdersPage(page) {
  const url = new URL(`${RACKBEAT_BASE}/orders`);
  url.searchParams.set("sort", "created_at");
  url.searchParams.set("limit", "50");
  url.searchParams.set("page", String(page));
  const res = await fetch(url, { headers: rackbeatHeaders() });
  const data = await res.json();
  if (!data.orders) {
    throw new Error(`Failed to fetch orders page ${page}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function findOrdersToPick(count) {
  const selected = [];
  let page = 1;
  // Bounded scan: stop once we have enough orders, or run out of pages.
  // Fine for an on-demand, human-triggered page - not a hot path.
  while (selected.length < count) {
    const data = await fetchOrdersPage(page);
    for (const order of data.orders) {
      if (order.is_booked && !order.is_shipped && !order.is_cancelled) {
        selected.push(order);
        if (selected.length >= count) break;
      }
    }
    if (page >= (data.pages || 1)) break;
    page++;
  }
  return selected;
}

function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g;
  const aParts = a.match(re) || [];
  const bParts = b.match(re) || [];
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ap = aParts[i] || "";
    const bp = bParts[i] || "";
    const aNum = /^\d+$/.test(ap);
    const bNum = /^\d+$/.test(bp);
    if (aNum && bNum) {
      const diff = parseInt(ap, 10) - parseInt(bp, 10);
      if (diff !== 0) return diff;
    } else {
      const diff = ap.localeCompare(bp);
      if (diff !== 0) return diff;
    }
  }
  return 0;
}

function buildPickingGroups(orders) {
  // locationName -> itemNumber -> { itemName, qty, byOrder: { orderNumber: qty } }
  const byLocation = new Map();

  for (const order of orders) {
    for (const line of order.lines || []) {
      const locationName = line.location ? line.location.name : "(no location)";
      const itemNumber = line.child_id;
      const itemName = (line.item && line.item.name) || line.name || itemNumber;

      if (!byLocation.has(locationName)) byLocation.set(locationName, new Map());
      const items = byLocation.get(locationName);

      if (!items.has(itemNumber)) {
        items.set(itemNumber, { itemName, qty: 0, byOrder: {} });
      }
      const entry = items.get(itemNumber);
      entry.qty += line.quantity;
      entry.byOrder[order.number] = (entry.byOrder[order.number] || 0) + line.quantity;
    }
  }

  const locationNames = Array.from(byLocation.keys()).sort(naturalCompare);
  return locationNames.map((locationName) => {
    const items = Array.from(byLocation.get(locationName).entries())
      .map(([itemNumber, entry]) => ({ itemNumber, ...entry }))
      .sort((a, b) => naturalCompare(a.itemNumber, b.itemNumber));
    return { locationName, items };
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function renderHtml(orders, groups) {
  const orderNumbers = orders.map((o) => o.number).join(", #");
  const groupsHtml = groups
    .map((group) => {
      const rows = group.items
        .map((item) => {
          const breakdown = Object.entries(item.byOrder)
            .map(([orderNumber, qty]) => `#${orderNumber} &times;${qty}`)
            .join(", ");
          return `<tr>
            <td class="sku">${escapeHtml(item.itemNumber)}</td>
            <td>${escapeHtml(item.itemName)}</td>
            <td class="qty">${item.qty}</td>
            <td class="breakdown">${breakdown}</td>
          </tr>`;
        })
        .join("\n");
      return `<section class="location-group">
        <h2>${escapeHtml(group.locationName)}</h2>
        <table>
          <thead><tr><th>SKU</th><th>Item</th><th>Qty</th><th>Orders</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
    })
    .join("\n");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Picking list</title>
<style>
  body { font-family: -apple-system, Arial, sans-serif; color: #111; margin: 24px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .meta { color: #555; font-size: 13px; margin-bottom: 24px; }
  .location-group { margin-bottom: 28px; page-break-inside: avoid; }
  h2 { font-size: 16px; background: #f0f0f0; padding: 6px 10px; margin: 0 0 8px; border-radius: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #ddd; }
  th { font-size: 12px; text-transform: uppercase; color: #666; }
  td.sku { font-family: ui-monospace, monospace; white-space: nowrap; }
  td.qty { font-weight: 600; text-align: right; width: 50px; }
  td.breakdown { color: #555; font-size: 12.5px; }
  @media print {
    body { margin: 0.5cm; }
    .no-print { display: none; }
  }
  .print-btn {
    margin-bottom: 20px; padding: 8px 16px; font-size: 14px; cursor: pointer;
  }
</style>
</head>
<body>
  <button class="print-btn no-print" onclick="window.print()">Print</button>
  <h1>Picking list</h1>
  <div class="meta">${orders.length} order${orders.length === 1 ? "" : "s"}: #${escapeHtml(orderNumbers)}</div>
  ${groupsHtml || "<p>No eligible orders found.</p>"}
</body>
</html>`;
}

module.exports = async (req, res) => {
  if (req.query.secret !== process.env.ADMIN_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const count = Math.max(1, Math.min(200, parseInt(req.query.count, 10) || 10));

  try {
    const orders = await findOrdersToPick(count);
    const groups = buildPickingGroups(orders);
    const html = renderHtml(orders, groups);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
};
