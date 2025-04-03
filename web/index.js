
import { join } from "path";
import { readFileSync } from "fs";

import express from "express";

import serveStatic from "serve-static";

import shopify from "./shopify.js";
import productCreator from "./product-creator.js";
import PrivacyWebhookHandlers from "./privacy.js";
import loyaltyRoutes from "./loyalty.js"; // Import loyalty system
import webhook from "./webhook.js"; // Import the webhooks file

import webhookRouter from './webhook';  // Import the webhooks router
import dotenv from 'dotenv';
dotenv.config(); // This will load the variables from .env into process.env





const PORT = parseInt(process.env.BACKEND_PORT || process.env.PORT || "3000", 10);
const STATIC_PATH =
  process.env.NODE_ENV === "production"
    ? `${process.cwd()}/frontend/dist`
    : `${process.cwd()}/frontend/`;

const app = express();

// Shopify Authentication & Webhook Setup
// @ts-ignore
app.get(shopify.config.auth.path, shopify.auth.begin());
// @ts-ignore
app.get(shopify.config.auth.callbackPath, shopify.auth.callback(), shopify.redirectToShopifyOrAppRoot());
// @ts-ignore
app.post(shopify.config.webhooks.path, shopify.processWebhooks({ webhookHandlers: PrivacyWebhookHandlers }));

// Middleware
// @ts-ignore
app.use("/api/*", shopify.validateAuthenticatedSession());
// @ts-ignore
app.use(express.json());
// @ts-ignore
app.use('/api/loyalty', loyaltyRoutes); // ✅ Enable Loyalty API

// Products Count API
// @ts-ignore
app.get("/api/products/count", async (_req, res) => {
  const client = new shopify.api.clients.Graphql({ session: res.locals.shopify.session });
  const countData = await client.request(`
    query { shop { productsCount } }
  `);
  res.status(200).send({ count: countData.data.shop.productsCount });
});

// Create Product API
// @ts-ignore
app.post("/api/products", shopify.validateAuthenticatedSession(), async (req, res) => {
  try {
    await productCreator(res.locals.shopify.session);
    res.status(200).send({ success: true });
  } catch (error) {
    console.error("Error creating product:", error);
    res.status(500).send({ success: false, error: error.message });
  }
});

// Serve Frontend
// @ts-ignore
app.use(shopify.cspHeaders());
// @ts-ignore
app.use(serveStatic(STATIC_PATH, { index: false }));
// @ts-ignore
app.use("/*", shopify.ensureInstalledOnShop(), async (_req, res) => {
  return res
    .status(200)
    .set("Content-Type", "text/html")
    .send(
      readFileSync(join(STATIC_PATH, "index.html"))
        .toString()
        .replace("%VITE_SHOPIFY_API_KEY%", process.env.SHOPIFY_API_KEY || "")
    );
});

app.post(
  shopify.config.webhooks.path,
  shopify.processWebhooks({
    webhookHandlers: {
      ...PrivacyWebhookHandlers,
      "product_reviews/create": async (topic, shop, body) => {
        console.log("📢 New Product Review:", body);
        const reviewData = JSON.parse(body);
        const customerId = reviewData.reviewer.id; // Extract customer ID from the review
        const shopifyClient = new shopify.api.clients.Graphql({ session: shop });

        try {
          // Add 50 points for the review
          await shopifyClient.request(`
            mutation {
              customerUpdate(input: {
                id: "gid://shopify/Customer/${customerId}",
                metafields: [{ namespace: "loyalty", key: "points", value: "50", type: "integer" }]
              }) {
                customer {
                  id
                  metafield(namespace: "loyalty", key: "points") {
                    value
                  }
                }
              }
            }
          `);
          console.log(`✅ 50 points awarded to Customer ${customerId}`);
        } catch (error) {
          console.error("❌ Error updating customer points:", error);
        }
      },
    },
  })
);


// Start Server
// @ts-ignore
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
