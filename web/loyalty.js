import { shopifyApi, LATEST_API_VERSION } from '@shopify/shopify-api';
import express from 'express';
import dotenv from 'dotenv';

dotenv.config();
const router = express.Router();

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  scopes: ['read_orders', 'write_customers', 'write_discounts'],
  hostName: process.env.SHOPIFY_APP_URL.replace(/^https:\/\//, ''),
  apiVersion: LATEST_API_VERSION
});

// Webhook to track order points
router.post('/webhooks/orders/create', async (req, res) => {
  try {
    const order = req.body;
    const customerId = order.customer.id;
    const amountSpent = order.total_price;

    // 1€ = 1 point
    const pointsEarned = Math.floor(amountSpent); 

    // Get current points
    const existingPoints = await getCustomerPoints(customerId);
    const updatedPoints = existingPoints + pointsEarned;

    // Update customer metafield
    await updateCustomerPoints(customerId, updatedPoints);

    console.log(`✅ Added ${pointsEarned} points to customer ${customerId}`);
    res.status(200).send('Success');
  } catch (error) {
    console.error('❌ Error processing order webhook:', error);
    res.status(500).send('Error');
  }
});

// Function to retrieve points from metafields
async function getCustomerPoints(customerId) {
  const response = await shopify.rest.Customer.get({ id: customerId });
  const metafield = response.body.metafields.find(mf => mf.key === 'loyalty_points');
  return metafield ? parseInt(metafield.value) : 0;
}

// Function to update customer points in metafields
async function updateCustomerPoints(customerId, points) {
  await shopify.rest.Metafield.create({
    owner_id: customerId,
    owner_resource: 'customer',
    namespace: 'loyalty',
    key: 'points',
    type: 'integer',
    value: points.toString()
  });
}

export default router;
