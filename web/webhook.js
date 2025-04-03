// webhook.js - Webhook handlers for Judge.me integration
import express from 'express';
import crypto from 'crypto';
import shopify from './shopify.js';
import nodemailer from 'nodemailer';

const router = express.Router();
const JUDGEME_SECRET = process.env.JUDGEME_WEBHOOK_SECRET;

// Middleware to verify Judge.me webhook signature
const verifyJudgeMeWebhook = (req, res, next) => {
  const hmacHeader = req.get('X-Judgeme-Hmac-Sha256');
  if (!hmacHeader) {
    console.log('Missing Judge.me signature');
    return res.status(401).send('Missing signature');
  }
  
  const body = JSON.stringify(req.body);
  const calculatedHmac = crypto
    .createHmac('sha256', JUDGEME_SECRET)
    .update(body)
    .digest('hex');
  
  if (hmacHeader !== calculatedHmac) {
    console.log('Invalid Judge.me signature');
    return res.status(401).send('Invalid signature');
  }
  
  next();
};

// Debug middleware to log incoming webhooks
router.use((req, res, next) => {
  console.log(`💬 Received webhook: ${req.path}`);
  console.log('Headers:', JSON.stringify(req.headers, null, 2));
  next();
});

// Judge.me review webhook handler
router.post('/judgeme/review', verifyJudgeMeWebhook, async (req, res) => {
  try {
    console.log('📝 Judge.me review webhook received:', JSON.stringify(req.body));
    const review = req.body;
    
    // Extract customer ID and shop domain
    const customerId = review.reviewer?.id || review.reviewer_id;
    const shopDomain = review.shop_domain;
    
    if (!customerId || !shopDomain) {
      console.error('❌ Missing customer ID or shop domain in webhook');
      return res.status(200).send('Missing required data');
    }
    
    // Get review rating
    const rating = review.rating || 5;
    
    // Award points based on rating (only for 4-5 star reviews)
    let pointsToAward = 0;
    if (rating >= 4) {
      pointsToAward = 50;
    }
    
    if (pointsToAward === 0) {
      console.log(`⭐ Review rating ${rating} does not qualify for points`);
      return res.status(200).send('Review rating does not qualify for points');
    }
    
    // Load Shopify session for this shop
    const session = await shopify.config.sessionStorage.loadSession(shopDomain);
    if (!session) {
      console.error(`❌ No session found for shop: ${shopDomain}`);
      return res.status(200).send('No shop session found');
    }
    
    // Get current points
    const client = new shopify.api.clients.Graphql({ session });
    const { data } = await client.request(`
      query {
        customer(id: "gid://shopify/Customer/${customerId}") {
          metafield(namespace: "loyalty", key: "points") {
            value
          }
        }
      }
    `);
    
    const currentPoints = parseInt(data?.customer?.metafield?.value || "0", 10);
    const newPoints = currentPoints + pointsToAward;
    
    // Update customer points
    await client.request(`
      mutation {
        customerUpdate(input: {
          id: "gid://shopify/Customer/${customerId}",
          metafields: [{ namespace: "loyalty", key: "points", value: "${newPoints}", type: "integer" }]
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
    
    console.log(`✅ Awarded ${pointsToAward} points to Customer ${customerId} for review`);
    
    // Check if any reward thresholds have been crossed
    await checkRewardThresholds(session, customerId, currentPoints, newPoints);
    
    res.status(200).send('Points awarded successfully');
  } catch (error) {
    console.error('❌ Error processing review webhook:', error);
    res.status(500).send('Error processing webhook');
  }
});

// Shopify order webhook handler for awarding points on purchases
router.post('/shopify/orders/paid', async (req, res) => {
  try {
    const hmac = req.get('X-Shopify-Hmac-Sha256');
    const body = JSON.stringify(req.body);
    const shopDomain = req.get('X-Shopify-Shop-Domain');
    
    // Verify Shopify webhook
    const calculated = crypto
      .createHmac('sha256', process.env.SHOPIFY_API_SECRET)
      .update(body)
      .digest('base64');
    
    if (hmac !== calculated) {
      return res.status(401).send('Invalid signature');
    }
    
    // Load session
    const session = await shopify.config.sessionStorage.loadSession(shopDomain);
    if (!session) {
      return res.status(200).send('No shop session found');
    }
    
    const order = req.body;
    const customerId = order.customer?.id;
    if (!customerId) {
      return res.status(200).send('No customer ID found');
    }
    
    // Calculate points (1 point per Euro)
    const orderTotal = parseFloat(order.total_price);
    const pointsToAward = Math.round(orderTotal);
    
    // Get current points
    const client = new shopify.api.clients.Graphql({ session });
    const { data } = await client.request(`
      query {
        customer(id: "gid://shopify/Customer/${customerId}") {
          metafield(namespace: "loyalty", key: "points") {
            value
          }
        }
      }
    `);
    
    const currentPoints = parseInt(data?.customer?.metafield?.value || "0", 10);
    const newPoints = currentPoints + pointsToAward;
    
    // Update customer points
    await client.request(`
      mutation {
        customerUpdate(input: {
          id: "gid://shopify/Customer/${customerId}",
          metafields: [{ namespace: "loyalty", key: "points", value: "${newPoints}", type: "integer" }]
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
    
    console.log(`✅ Awarded ${pointsToAward} points to Customer ${customerId} for order ${order.id}`);
    
    // Check if any reward thresholds have been crossed
    await checkRewardThresholds(session, customerId, currentPoints, newPoints);
    
    res.status(200).send('Points awarded successfully');
  } catch (error) {
    console.error('❌ Error processing order webhook:', error);
    res.status(500).send('Error processing webhook');
  }
});

// Check if customer has crossed any reward thresholds
const checkRewardThresholds = async (session, customerId, oldPoints, newPoints) => {
  try {
    // Check discount thresholds
    if (oldPoints < 500 && newPoints >= 500) {
      await sendDiscountReward(session, customerId, "20% Discount", "LOYALTY20_");
    }
    
    if (oldPoints < 1000 && newPoints >= 1000) {
      await sendDiscountReward(session, customerId, "40% Discount", "LOYALTY40_");
    }
    
    if (oldPoints < 1500 && newPoints >= 1500) {
      await sendDiscountReward(session, customerId, "Free Shipping", "FREESHIP_");
    }
    
    if (oldPoints < 2000 && newPoints >= 2000) {
      await notifyFreeProduct(session, customerId);
    }
  } catch (error) {
    console.error('Error checking reward thresholds:', error);
  }
};

// Create and send discount reward
const sendDiscountReward = async (session, customerId, rewardType, codePrefix) => {
  try {
    // Get customer email
    const client = new shopify.api.clients.Graphql({ session });
    const { data } = await client.request(`
      query {
        customer(id: "gid://shopify/Customer/${customerId}") {
          email
          firstName
        }
      }
    `);
    
    const email = data?.customer?.email;
    const firstName = data?.customer?.firstName || "Valued Customer";
    
    // Generate unique discount code
    const uniqueCode = `${codePrefix}${customerId.slice(-6)}_${Date.now().toString(36).slice(-4)}`;
    
    // Set up discount parameters
    let discountValue, discountType;
    
    if (rewardType === "20% Discount") {
      discountValue = 20;
      discountType = "percentage";
    } else if (rewardType === "40% Discount") {
      discountValue = 40;
      discountType = "percentage";
    } else if (rewardType === "Free Shipping") {
      discountValue = 100;
      discountType = "shipping";
    }
    
    // Create discount code via REST API
    const restClient = new shopify.api.clients.Rest({ session });
    
    // First create price rule
    const priceRuleResponse = await restClient.post({
      path: 'price_rules',
      data: {
        price_rule: {
          title: `Loyalty ${rewardType} for Customer ${customerId}`,
          target_type: "line_items",
          target_selection: "all",
          allocation_method: "across",
          value_type: discountType,
          value: `-${discountValue}`,
          customer_selection: "prerequisite",
          prerequisite_customer_ids: [customerId],
          starts_at: new Date().toISOString(),
          ends_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString() // 90 days
        }
      }
    });
    
    const priceRuleId = priceRuleResponse.body.price_rule.id;
    
    // Create discount code
    await restClient.post({
      path: `price_rules/${priceRuleId}/discount_codes`,
      data: {
        discount_code: {
          code: uniqueCode
        }
      }
    });
    
    // Send email with discount code
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });
    
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: `You've Earned a ${rewardType}!`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Congratulations, ${firstName}!</h2>
          <p>You've reached a new loyalty milestone and earned a <strong>${rewardType}</strong>!</p>
          <p>Use this discount code at checkout:</p>
          <div style="background-color: #f5f5f5; padding: 15px; text-align: center; font-size: 24px; font-weight: bold; margin: 20px 0; letter-spacing: 2px;">
            ${uniqueCode}
          </div>
          <p>This code is valid for the next 90 days and can be used once.</p>
          <p>Thank you for your loyalty!</p>
        </div>
      `
    };
    
    await transporter.sendMail(mailOptions);
    console.log(`✅ Sent ${rewardType} code ${uniqueCode} to ${email}`);
  } catch (error) {
    console.error(`Error creating ${rewardType}:`, error);
  }
};

// Notify customer about free product eligibility
const notifyFreeProduct = async (session, customerId) => {
  try {
    // Get customer email
    const client = new shopify.api.clients.Graphql({ session });
    const { data } = await client.request(`
      query {
        customer(id: "gid://shopify/Customer/${customerId}") {
          email
          firstName
        }
      }
    `);
    
    const email = data?.customer?.email;
    const firstName = data?.customer?.firstName || "Valued Customer";
    
    // Send email notification
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });
    
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: "You've Earned a FREE Product!",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Congratulations, ${firstName}!</h2>
          <p>Amazing achievement! You've reached 2,000 loyalty points and earned a <strong>FREE PRODUCT</strong> of your choice!</p>
          <p>Visit our store and check your account page to select your free product from:</p>
          <ul>
            <li>Your favorite products list</li>
            <li>Our curated selection of premium products</li>
          </ul>
          <p>This reward is now available in your account and ready to be redeemed.</p>
          <p>Thank you for your continued loyalty!</p>
        </div>
      `
    };
    
    await transporter.sendMail(mailOptions);
    console.log(`✅ Sent free product notification to ${email}`);
  } catch (error) {
    console.error("Error sending free product notification:", error);
  }
};

export default router;