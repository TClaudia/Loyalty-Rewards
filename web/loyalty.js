// loyalty.js - Core loyalty system logic
import express from 'express';
import shopify from './shopify.js';
import nodemailer from 'nodemailer';

const router = express.Router();

// Middleware to handle customer points
const getCustomerPoints = async (session, customerId) => {
  const client = new shopify.api.clients.Graphql({ session });
  
  try {
    const { data } = await client.request(`
      query {
        customer(id: "gid://shopify/Customer/${customerId}") {
          metafield(namespace: "loyalty", key: "points") {
            value
          }
        }
      }
    `);
    
    return parseInt(data?.customer?.metafield?.value || "0", 10);
  } catch (error) {
    console.error("Error fetching customer points:", error);
    return 0;
  }
};

const updateCustomerPoints = async (session, customerId, newPoints) => {
  const client = new shopify.api.clients.Graphql({ session });
  
  try {
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
    return true;
  } catch (error) {
    console.error("Error updating customer points:", error);
    return false;
  }
};

// Get customer points endpoint
router.get('/points/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const points = await getCustomerPoints(res.locals.shopify.session, customerId);
    
    res.status(200).json({ 
      points, 
      tiers: [
        { level: 1, points: 500, reward: "20% Discount", achieved: points >= 500 },
        { level: 2, points: 1000, reward: "40% Discount", achieved: points >= 1000 },
        { level: 3, points: 1500, reward: "Free Shipping", achieved: points >= 1500 },
        { level: 4, points: 2000, reward: "Free Product", achieved: points >= 2000 }
      ]
    });
  } catch (error) {
    console.error("Error fetching points:", error);
    res.status(500).json({ error: "Failed to fetch points" });
  }
});

// Award points for a completed order
router.post('/award-order-points', async (req, res) => {
  try {
    const { customerId, orderValue } = req.body;
    
    // Award 1 point per Euro spent (rounded to nearest integer)
    const pointsToAward = Math.round(orderValue);
    
    const currentPoints = await getCustomerPoints(res.locals.shopify.session, customerId);
    const newPoints = currentPoints + pointsToAward;
    
    const success = await updateCustomerPoints(res.locals.shopify.session, customerId, newPoints);
    
    if (success) {
      console.log(`✅ Awarded ${pointsToAward} points to Customer ${customerId} for order`);
      
      // Check if any reward threshold has been reached
      await checkAndSendRewards(res.locals.shopify.session, customerId, currentPoints, newPoints);
      
      res.status(200).json({ success: true, points: newPoints });
    } else {
      res.status(500).json({ error: "Failed to award points" });
    }
  } catch (error) {
    console.error("Error awarding points:", error);
    res.status(500).json({ error: "Failed to award points" });
  }
});

// Get customer's favorite products
router.get('/favorites/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const client = new shopify.api.clients.Graphql({ session: res.locals.shopify.session });
    
    const { data } = await client.request(`
      query {
        customer(id: "gid://shopify/Customer/${customerId}") {
          favorites: metafield(namespace: "loyalty", key: "favorites") {
            value
          }
        }
      }
    `);
    
    const favorites = JSON.parse(data?.customer?.favorites?.value || "[]");
    res.status(200).json({ favorites });
  } catch (error) {
    console.error("Error fetching favorites:", error);
    res.status(500).json({ error: "Failed to fetch favorites" });
  }
});

// Redeem free product
router.post('/redeem-free-product', async (req, res) => {
  try {
    const { customerId, productId } = req.body;
    const session = res.locals.shopify.session;
    const points = await getCustomerPoints(session, customerId);
    
    if (points < 2000) {
      return res.status(400).json({ error: "Not enough points" });
    }
    
    // Create a draft order with the free product
    const client = new shopify.api.clients.Rest({ session });
    await client.post({
      path: 'draft_orders',
      data: {
        draft_order: {
          line_items: [{ variant_id: productId, quantity: 1 }],
          customer: { id: customerId },
          applied_discount: {
            description: "Loyalty Reward - Free Product",
            value_type: "percentage",
            value: "100"
          }
        }
      }
    });
    
    // Deduct points
    const newPoints = points - 2000;
    await updateCustomerPoints(session, customerId, newPoints);
    
    res.status(200).json({ success: true, points: newPoints });
  } catch (error) {
    console.error("Error redeeming free product:", error);
    res.status(500).json({ error: "Failed to redeem free product" });
  }
});

// Helper function to check thresholds and send rewards
const checkAndSendRewards = async (session, customerId, oldPoints, newPoints) => {
  // Create thresholds for rewards
  const thresholds = [
    { points: 500, reward: "20% Discount", code: "LOYALTY20" },
    { points: 1000, reward: "40% Discount", code: "LOYALTY40" },
    { points: 1500, reward: "Free Shipping", code: "FREESHIP" }
  ];
  
  // Check each threshold
  for (const threshold of thresholds) {
    // Check if customer crossed this threshold with the new points
    if (oldPoints < threshold.points && newPoints >= threshold.points) {
      await createDiscountAndNotify(session, customerId, threshold);
    }
  }
  
  // Check for free product threshold separately
  if (oldPoints < 2000 && newPoints >= 2000) {
    await notifyFreeProductEligibility(session, customerId);
  }
};

// Create discount and notify customer
const createDiscountAndNotify = async (session, customerId, threshold) => {
  try {
    const client = new shopify.api.clients.Graphql({ session });
    
    // Get customer email
    const { data } = await client.request(`
      query {
        customer(id: "gid://shopify/Customer/${customerId}") {
          email
          firstName
        }
      }
    `);
    
    const email = data?.customer?.email;
    const firstName = data?.customer?.firstName || "Valued customer";
    
    if (!email) {
      console.error("Could not find email for customer:", customerId);
      return;
    }
    
    // Create discount code
    let discountValue = 20;
    let discountType = "percentage";
    
    if (threshold.points === 500) {
      discountValue = 20;
    } else if (threshold.points === 1000) {
      discountValue = 40;
    } else if (threshold.points === 1500) {
      discountType = "shipping";
      discountValue = 100;
    }
    
    // Generate a unique code for this customer
    const uniqueCode = `${threshold.code}_${customerId.substring(0, 6)}_${Date.now().toString(36)}`;
    
    // Create the price rule and discount code via Admin API
    const restClient = new shopify.api.clients.Rest({ session });
    
    await restClient.post({
      path: 'price_rules',
      data: {
        price_rule: {
          title: `Loyalty ${threshold.reward} for Customer ${customerId}`,
          target_type: "line_items",
          target_selection: "all",
          allocation_method: "across",
          value_type: discountType,
          value: `-${discountValue}`,
          customer_selection: "prerequisite",
          prerequisite_customer_ids: [customerId],
          starts_at: new Date().toISOString(),
          ends_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 days from now
        }
      }
    });
    
    // Now create the discount code
    await restClient.post({
      path: `price_rules/${priceRuleId}/discount_codes`,
      data: {
        discount_code: {
          code: uniqueCode
        }
      }
    });
    
    // Send email notification
    await sendRewardEmail(email, firstName, threshold.reward, uniqueCode);
    
    console.log(`✅ Created ${threshold.reward} discount code ${uniqueCode} for customer ${customerId}`);
  } catch (error) {
    console.error(`Failed to create discount for ${threshold.reward}:`, error);
  }
};

// Notify customer about free product eligibility
const notifyFreeProductEligibility = async (session, customerId) => {
  try {
    const client = new shopify.api.clients.Graphql({ session });
    
    // Get customer email
    const { data } = await client.request(`
      query {
        customer(id: "gid://shopify/Customer/${customerId}") {
          email
          firstName
        }
      }
    `);
    
    const email = data?.customer?.email;
    const firstName = data?.customer?.firstName || "Valued customer";
    
    if (!email) {
      console.error("Could not find email for customer:", customerId);
      return;
    }
    
    // Send email notification for free product
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
    
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: "You've earned a FREE product!",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Congratulations, ${firstName}!</h2>
          <p>You've reached 2,000 loyalty points and earned a <strong>FREE PRODUCT</strong> of your choice!</p>
          <p>Visit our store and go to your account page to redeem your reward.</p>
          <p>Choose any product from your favorites list or from our special selection.</p>
          <p>Thank you for your loyalty!</p>
          <p><em>This reward will remain available in your account until redeemed.</em></p>
        </div>
      `
    };
    
    await transporter.sendMail(mailOptions);
    console.log(`✅ Sent free product notification to ${email}`);
  } catch (error) {
    console.error("Failed to notify about free product:", error);
  }
};

// Send reward emails
const sendRewardEmail = async (email, firstName, rewardType, discountCode) => {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
  
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: email,
    subject: `You've earned a ${rewardType}!`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>Congratulations, ${firstName}!</h2>
        <p>You've earned a <strong>${rewardType}</strong> as a reward for your loyalty!</p>
        <p>Use this discount code at checkout:</p>
        <div style="background-color: #f5f5f5; padding: 15px; text-align: center; font-size: 24px; font-weight: bold; margin: 20px 0; letter-spacing: 2px;">
          ${discountCode}
        </div>
        <p>This code is valid for 90 days and can be used only once.</p>
        <p>Keep shopping to unlock even more rewards!</p>
      </div>
    `
  };
  
  try {
    await transporter.sendMail(mailOptions);
    console.log(`✅ Reward email sent to ${email}`);
    return true;
  } catch (error) {
    console.error('Error sending reward email:', error);
    return false;
  }
};


// Judge.me webhook to award points for product reviews
router.post('/webhook/judgeme-review', async (req, res) => {
  try {
    const { review } = req.body;

    if (!review || !review.reviewer.email || !review.product.external_id) {
      return res.status(400).json({ error: "Invalid webhook payload" });
    }

    // Fetch customer ID using the email
    const client = new shopify.api.clients.Graphql({ session: res.locals.shopify.session });
    const { data } = await client.request(`
      query {
        customers(first: 1, query: "email:${review.reviewer.email}") {
          edges {
            node {
              id
            }
          }
        }
      }
    `);

    const customerId = data?.customers?.edges?.[0]?.node?.id;
    if (!customerId) {
      console.error(`No Shopify customer found for email: ${review.reviewer.email}`);
      return res.status(404).json({ error: "Customer not found" });
    }

    // Award 50 points for the review
    const currentPoints = await getCustomerPoints(res.locals.shopify.session, customerId);
    const newPoints = currentPoints + 50;

    const success = await updateCustomerPoints(res.locals.shopify.session, customerId, newPoints);

    if (success) {
      console.log(`✅ Awarded 50 points to Customer ${customerId} for leaving a review`);
      await checkAndSendRewards(res.locals.shopify.session, customerId, currentPoints, newPoints);
      return res.status(200).json({ success: true, points: newPoints });
    } else {
      return res.status(500).json({ error: "Failed to award points" });
    }
  } catch (error) {
    console.error("Error processing Judge.me review webhook:", error);
    res.status(500).json({ error: "Failed to process review" });
  }
});
import axios from 'axios';

const JUDGEME_API_TOKEN = process.env.JUDGEME_API_TOKEN; // Store in .env

const registerJudgeMeWebhook = async () => {
  try {
    const response = await axios.post(
      'https://api.judge.me/v1/webhooks',
      {
        webhook: {
          url: 'https://eclipse-arome.myshopify.com//webhook/judgeme-review', // Your webhook endpoint
          event: 'review/created' // Event to listen for
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${JUDGEME_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('✅ Judge.me webhook registered:', response.data);
  } catch (error) {
    console.error('❌ Error registering Judge.me webhook:', error.response ? error.response.data : error.message);
  }
};

// Call the function when your app starts
registerJudgeMeWebhook();
const listJudgeMeWebhooks = async () => {
  try {
    const response = await axios.get('https://api.judge.me/v1/webhooks', {
      headers: {
        'Authorization': `Bearer ${JUDGEME_API_TOKEN}`
      }
    });
    

    console.log('✅ Judge.me webhooks:', response.data);
  } catch (error) {
    console.error('❌ Error fetching Judge.me webhooks:', error.response ? error.response.data : error.message);
  }
};

// Call this function to check webhooks
listJudgeMeWebhooks();

export default router;