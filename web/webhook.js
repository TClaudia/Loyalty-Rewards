import express from 'express';
import crypto from 'crypto';
import shopify from './shopify.js';
import nodemailer from 'nodemailer';

const router = express.Router();
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;

// Middleware to verify webhook signature
const verifyWebhook = (req, res, next) => {
  const hmac = req.get('X-Judgeme-Signature');
  const body = JSON.stringify(req.body);
  const computedHmac = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(body).digest('base64'); // ✅ Use base64

  if (hmac !== computedHmac) {
    return res.status(400).send('Invalid webhook signature');
  }
  next();
};

// Webhook handler for Judge.me review_created event
router.post('/webhooks', verifyWebhook, async (req, res) => {
  const review = req.body;
  const customerId = review.reviewer_id;
  const reviewRating = review.rating;

  let pointsAwarded = 0;
  if (reviewRating >= 4) {
    pointsAwarded = 50;
  }

  const session = await shopify.config.sessionStorage.loadSession(req.headers['x-shopify-shop-domain']); // ✅ Load session correctly
  const client = new shopify.api.clients.Graphql({ session });

  try {
    const customerData = await client.request(`
      query {
        customer(id: "gid://shopify/Customer/${customerId}") {
          metafield(namespace: "loyalty", key: "points") {
            value
          }
        }
      }
    `);

    const currentPoints = parseInt(customerData.customer.metafield?.value || "0", 10);
    const newPoints = currentPoints + pointsAwarded;

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

    console.log(`✅ Awarded ${pointsAwarded} points to Customer ${customerId}`);

    // Send reward email if thresholds are reached
    if (newPoints >= 500 && newPoints < 1000) {
      sendRewardEmail(session, customerId, "20% Discount", "Congrats! You've earned 20% off your next order!");
    } else if (newPoints >= 1000 && newPoints < 1500) {
      sendRewardEmail(session, customerId, "40% Discount", "Congrats! You've earned 40% off your next order!");
    } else if (newPoints >= 1500 && newPoints < 2000) {
      sendRewardEmail(session, customerId, "Free Shipping", "Congrats! You've earned free shipping on your next order!");
    } else if (newPoints >= 2000) {
      sendRewardEmail(session, customerId, "Free Product", "Congrats! You've earned a free product from your favorite list!");
    }

    res.status(200).send('Webhook processed successfully');
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).send('Failed to process webhook');
  }
});

// Send reward emails
const sendRewardEmail = async (session, customerId, rewardType, message) => {
  const client = new shopify.api.clients.Graphql({ session });
  const customerData = await client.request(`
    query {
      customer(id: "gid://shopify/Customer/${customerId}") {
        email
      }
    }
  `);

  const customerEmail = customerData.customer.email;
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER, // ✅ Use environment variables
      pass: process.env.EMAIL_PASS,
    },
  });

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: customerEmail,
    subject: `You've earned a ${rewardType}!`,
    text: `${message}\n\nKeep shopping to unlock even more rewards!`,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`✅ Reward email sent to ${customerEmail}`);
  } catch (error) {
    console.error('Error sending reward email:', error);
  }
};

export default router;
