const crypto = require("crypto");
const { getOwnMotherSku, findChildrenOf } = require("../lib/rackbeat");
const { getInventoryItemForSku, adjustAvailableDelta } = require("../lib/shopify");

// Fires on Shopify's own `orders/create` webhook - the moment a customer buys
// any mother-SKU family member, well before that order even reaches Rackbeat.
// Shopify already decrements the SPECIFIC SKU sold on its own (native
// per-variant inventory), but has no idea the other family members share the
// same physical pool - so without this, siblings keep showing stale/inflated
// "available" until Rackbeat eventually ships the order (see
// project_mother_sku_infrastructure memory for that reactive half). This
// closes the oversell window in between by proactively reserving the same
// quantity against every OTHER family member immediately.
//
// This is provisional, not authoritative: sync.js's shipment-triggered
// correction always SETS an absolute value from Rackbeat's real truth, so it
// naturally supersedes whatever this function guessed - no double-counting
// risk between the two.

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verifyShopifyHmac(rawBody, hmacHeader) {
  if (!hmacHeader) return false;
  const digest = crypto
    .createHmac("sha256", process.env.SHOPIFY_CLIENT_SECRET)
    .update(rawBody)
    .digest("base64");

  const digestBuf = Buffer.from(digest, "utf8");
  const headerBuf = Buffer.from(hmacHeader, "utf8");
  if (digestBuf.length !== headerBuf.length) return false;
  return crypto.timingSafeEqual(digestBuf, headerBuf);
}

// Deterministic, not random - the same (order, sku) pair must always produce
// the same idempotency key, so a genuine Shopify webhook retry re-sends the
// exact same key and Shopify dedupes the adjustment instead of applying it
// twice.
function idempotencyKeyFor(orderId, sku) {
  return crypto.createHash("sha256").update(`shopify-order-reserve:${orderId}:${sku}`).digest("hex");
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const rawBody = await readRawBody(req);

  if (!verifyShopifyHmac(rawBody, req.headers["x-shopify-hmac-sha256"])) {
    res.status(401).json({ error: "Invalid HMAC" });
    return;
  }

  const order = JSON.parse(rawBody.toString("utf8"));
  const orderId = order.id;
  const lineItems = (order.line_items || []).filter((li) => li.sku);

  try {
    // Resolve each sold SKU to its family root (if any), and accumulate how
    // much was actually sold under each SKU within that family, in case this
    // one order has lines for more than one family member at once.
    const soldQtyBySku = {};
    const familyRootBySku = {};

    for (const li of lineItems) {
      const sku = li.sku;
      soldQtyBySku[sku] = (soldQtyBySku[sku] || 0) + li.quantity;

      if (familyRootBySku[sku] !== undefined) continue;
      const ownMother = await getOwnMotherSku(sku);
      if (ownMother) {
        familyRootBySku[sku] = ownMother;
        continue;
      }
      const children = await findChildrenOf(sku);
      familyRootBySku[sku] = children.length > 0 ? sku : null; // null = standalone, not part of any family
    }

    const familyRoots = new Set(Object.values(familyRootBySku).filter(Boolean));
    const reservations = [];

    for (const root of familyRoots) {
      const members = Array.from(new Set([root, ...(await findChildrenOf(root))]));
      const totalQty = members.reduce((sum, m) => sum + (soldQtyBySku[m] || 0), 0);

      for (const member of members) {
        const soldQty = soldQtyBySku[member] || 0;
        const extra = totalQty - soldQty; // portion drawn by OTHER lines in this same order
        if (extra <= 0) continue;

        const inv = await getInventoryItemForSku(member);
        if (!inv) {
          reservations.push({ sku: member, skipped: "not found/tracked in Shopify" });
          continue;
        }

        try {
          await adjustAvailableDelta(
            inv.inventoryItemId,
            inv.locationId,
            -extra,
            inv.quantity,
            idempotencyKeyFor(orderId, member),
            "reservation_created"
          );
          reservations.push({ sku: member, delta: -extra });
        } catch (adjErr) {
          // Don't let one sibling's failure abort the rest - each is an
          // independent inventory write.
          console.error(`shopify-order-webhook: reservation failed for ${member}:`, adjErr.message);
          reservations.push({ sku: member, error: adjErr.message });
        }
      }
    }

    res.status(200).json({ ok: true, order: orderId, reservations });
  } catch (error) {
    // Non-2xx makes Shopify retry with the same payload/HMAC - safe here
    // since idempotencyKeyFor is deterministic per (order, sku), so a retry
    // dedupes rather than double-reserving.
    res.status(500).json({ error: String(error) });
  }
};

module.exports.config = { api: { bodyParser: false } };
