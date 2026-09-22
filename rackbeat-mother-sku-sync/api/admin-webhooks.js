const { shopifyAdminGraphql } = require("../lib/shopify");

// One-off/occasional admin utility, not a webhook target itself. Lists (and
// can recreate) this app's (mother-sku-cart-transform) own Shopify webhook
// subscriptions, using the same client_credentials token api/sync.js and
// api/shopify-order-webhook.js already use - because webhookSubscriptions in
// the Admin API is scoped to whichever app asks, a query through any other
// app (e.g. the general Shopify Admin/MCP connector) would never show this
// app's own subscriptions, which is what made the missing ORDERS_CREATE
// subscription hard to see from outside.
//
// Usage: GET/POST ?secret=...&action=list        - list this app's webhooks
//        GET/POST ?secret=...&action=create-orders-create
//                                                 - (re)create the
//          ORDERS_CREATE subscription pointing at api/shopify-order-webhook,
//          if one doesn't already exist for that address
const CALLBACK_URL = "https://rackbeat-mother-sku-sync.vercel.app/api/shopify-order-webhook";

async function listWebhooks() {
  const result = await shopifyAdminGraphql(
    `query {
      webhookSubscriptions(first: 50) {
        edges {
          node {
            id
            topic
            createdAt
            endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } }
          }
        }
      }
    }`
  );
  return result;
}

async function createOrdersCreateWebhook() {
  const existing = await listWebhooks();
  const edges = (existing.data && existing.data.webhookSubscriptions.edges) || [];
  const alreadyThere = edges.find(
    (e) =>
      e.node.topic === "ORDERS_CREATE" &&
      e.node.endpoint.__typename === "WebhookHttpEndpoint" &&
      e.node.endpoint.callbackUrl === CALLBACK_URL
  );
  if (alreadyThere) {
    return { alreadyExists: true, webhook: alreadyThere.node };
  }

  const result = await shopifyAdminGraphql(
    `mutation($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
        webhookSubscription { id topic }
        userErrors { field message }
      }
    }`,
    {
      topic: "ORDERS_CREATE",
      webhookSubscription: { callbackUrl: CALLBACK_URL, format: "JSON" },
    }
  );
  return { created: true, result };
}

module.exports = async (req, res) => {
  if (req.query.secret !== process.env.ADMIN_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    if (req.query.action === "create-orders-create") {
      res.status(200).json(await createOrdersCreateWebhook());
      return;
    }
    res.status(200).json(await listWebhooks());
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
};
