# gytisdemo — Mother-SKU sync & storefront work

Summary of the work covered in this thread. Store: `gytisdemo.myshopify.com`. ERP: Rackbeat. Sync code lives in `rackbeat-mother-sku-sync` (Vercel) and the `mother-sku-cart-transform` Shopify app.

## Background

One physical seat cover is sold as five separate Shopify listings — one "mother" SKU (`GAHOV-ST0066`) plus four vehicle-specific "child" SKUs (`GAPEU-ST011`, `GAOPE-ST017`, `GAFIA-ST017`, `GACIT-ST017`), all drawing from one shared physical stock pool. Rackbeat has no native support for pooling independent sales SKUs, so the pooling is entirely custom-built.

## 1. Inventory sync hardening (`rackbeat-mother-sku-sync/api/sync.js`)

- Fixed a real gap: shipping an order for a **child** SKU only ever decremented that child's own independent stock in Rackbeat — the family silently diverged unless the **mother's** own stock happened to change. Made handling symmetric: any family member's stock event now re-pools the whole family.
- Fixed a Rackbeat API quirk: a zero-delta `POST /inventory-adjustments` is rejected as an error rather than treated as a no-op; now skipped gracefully when nothing would actually change.
- Verified end-to-end across multiple real ship/order cycles — all 5 SKUs converge correctly in both Rackbeat and Shopify.

## 2. Order-line rewrite at the source (`rackbeat-mother-sku-sync/api/order-transform.js`, new)

- New Rackbeat webhook (`order.created`) rewrites any order line sold under a child SKU to reference the **mother SKU** instead, before the order is ever booked (Rackbeat locks lines on booked orders) — preserving price, discount %, and VAT %, and appending `— sold as GAFIA-ST017` to the line name so the specific vehicle isn't lost.
- Real bug found and fixed: the actual webhook delivery body has no `event` field at all (contrary to Rackbeat's own docs) — fixed by checking the `Rackbeat-Webhook-Event` HTTP header instead.
- Result: a shipment can now only ever decrement the pooled mother stock — the sync in step 1 becomes a safety net rather than the primary defense.

## 3. Proactive oversell prevention (`rackbeat-mother-sku-sync/api/shopify-order-webhook.js`, new)

- New Shopify `ORDERS_CREATE` webhook reserves stock across sibling SKUs the instant an order is placed — closing the window between order and shipment where the other listings would otherwise still show stale, unreserved stock.
- Required: HMAC verification of the raw webhook body, a `write_themes`/`read_orders` app scope grant, and navigating Shopify's "protected customer data" approval (only findable in the classic Partner Dashboard, not the newer Dev Dashboard).
- Two real Shopify API bugs found and fixed: `inventoryAdjustQuantities` requires `changeFromQuantity` at runtime despite the schema marking it optional, and `reason` is a closed enum rather than freeform text.
- Verified end-to-end on multiple real test orders; the orders affected by the bugs above were corrected retroactively.

## 4. Collection filters silently missing in Norwegian/Swedish

- Root cause: a locale bug in Horizon's own filter component (`/collections/all`), unrelated to any store configuration, product data, or customization — confirmed by testing English vs. Norwegian.
- Fixed by updating the live theme to **Horizon 4.2.0**. The update created a fresh unpublished copy that dropped our custom mother-SKU snippets (Shopify's update flow only merges editor settings, never hand-written code) — both snippets were reapplied before publishing.

## 5. Thank You / Order Status pages — resolved

- The long-standing "stale content" symptom was never a CDN caching issue. Root cause: uninstalling/reinstalling the `mother-sku-cart-transform` app (done twice, for scope grants) silently cleared the Parent SKU block placements in the Checkout and Customer Accounts editors, with no error or indication. Re-adding both blocks fixed it immediately, confirmed on a real order.

## 6. Order confirmation email — still open

- The Parent SKU snippet is correctly saved in the live email template (confirmed by reading it directly via the API) and renders correctly via "Send test," but does not render on real, order-triggered emails — not even a trivial unconditional `{{ line.sku }}` debug line.
- Ruled out: wrong template, a conflicting email app, and metafield-access restrictions.
- Confirmed via research that this is a known, unresolved issue reported independently by other Shopify merchants, with no confirmed merchant-side fix. Next step queued: revert the template to default and re-paste the customization, then Shopify Support as the fallback.

## 7. New product import

- Scraped and imported 7 "AirFresh" air-freshener products (51 scent variants total) from the real supplier site (gytisautek.no) into gytisdemo — one Shopify product per style with scent as a variant option, each variant keeping its real SKU, price, and image, tagged `car_make: Universal` to match the store's existing convention.

## 8. Architecture diagram

- Built an end-to-end flowchart (cart → checkout → order → Rackbeat → shipment → sync back) plus the mother/child SKU structure, published as a shareable diagram for internal use/presentation.
