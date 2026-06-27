/**
 * Webhooks routes — Stripe webhook endpoint.
 *
 * POST /api/webhooks/stripe
 * Handles: checkout.session.completed, customer.subscription.*, invoice.payment_failed
 *
 * Signature verification: Stripe-Webhook-Secret from env var.
 * Raw body must be read before express.json() parses it — this module
 * registers BEFORE app.use(express.json()) via server.js mount order.
 */

const express = require('express');
const router = express.Router();

const { getMerchantByStripeCustomerId, getMerchantByStripeSubscriptionId, setSubscriptionStatus, setStripeSubscriptionId } = require('../db/merchants');
const { sendDunningEmail } = require('../services/email');

const BASE_URL = process.env.APP_URL || 'https://foundryiq-3.polsia.app';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Raw body stored by middleware — verify first, parse second
router.post('/stripe', async (req, res) => {
  // express.raw() puts the Buffer in req.body
  const rawBody = req.body;
  const signature = req.headers['stripe-signature'];

  if (!WEBHOOK_SECRET) {
    console.error('[webhooks] STRIPE_WEBHOOK_SECRET not set — rejecting all events');
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }

  if (!rawBody) {
    console.error('[webhooks] No rawBody — webhook endpoint mounted after express.json()?');
    return res.status(400).json({ error: 'Missing request body' });
  }

  const { verifyWebhookSignature } = require('../services/billing');
  if (!verifyWebhookSignature(rawBody, signature, WEBHOOK_SECRET)) {
    console.warn('[webhooks] Invalid signature — rejecting event');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  console.log(`[webhooks] Received: ${event.type} (id=${event.id})`);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;
      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;
      default:
        console.log(`[webhooks] Unhandled event type: ${event.type}`);
    }
  } catch (err) {
    console.error(`[webhooks] Handler error for ${event.type}:`, err.message);
    // Return 200 to prevent Stripe retries — log the error for investigation
  }

  res.json({ received: true });
});

// ── Event handlers ───────────────────────────────────────────────────────────

async function handleCheckoutCompleted(session) {
  // session is a Checkout Session — get the subscription ID from it
  if (!session.subscription) {
    console.log('[webhooks] checkout.session.completed with no subscription — skipping');
    return;
  }

  const customerId = session.customer;
  const subscriptionId = session.subscription;
  const merchantEmail = session.metadata?.merchant_email || session.customer_details?.email;

  if (!merchantEmail) {
    console.warn('[webhooks] checkout.session.completed: no merchant_email in metadata');
    return;
  }

  const merchant = await getMerchantByStripeCustomerId(customerId);
  if (!merchant) {
    console.warn('[webhooks] checkout.session.completed: no merchant found for customer', customerId);
    return;
  }

  await setStripeSubscriptionId(merchant.id, subscriptionId);
  await setSubscriptionStatus(merchant.id, 'active');

  console.log(`[webhooks] Checkout complete — merchant ${merchant.id} (${merchantEmail}) now active`);
}

async function handleSubscriptionCreated(sub) {
  const customerId = sub.customer;
  const subscriptionId = sub.id;

  const merchant = await getMerchantByStripeCustomerId(customerId);
  if (!merchant) {
    console.warn('[webhooks] subscription.created: no merchant for customer', customerId);
    return;
  }

  await setStripeSubscriptionId(merchant.id, subscriptionId);

  const status = sub.status === 'active' ? 'active'
    : sub.status === 'trialing' ? 'trialing'
    : sub.status === 'past_due' ? 'past_due'
    : sub.status === 'canceled' ? 'canceled'
    : 'none';

  await setSubscriptionStatus(merchant.id, status);
  console.log(`[webhooks] Subscription ${subscriptionId} created for merchant ${merchant.id} — status: ${status}`);
}

async function handleSubscriptionUpdated(sub) {
  const subscriptionId = sub.id;

  const merchant = await getMerchantByStripeSubscriptionId(subscriptionId);
  if (!merchant) {
    // Might be a new subscription not yet linked — try by customer ID
    const m2 = await getMerchantByStripeCustomerId(sub.customer);
    if (m2) {
      await setStripeSubscriptionId(m2.id, subscriptionId);
    }
    return;
  }

  const status = sub.status === 'active' ? 'active'
    : sub.status === 'trialing' ? 'trialing'
    : sub.status === 'past_due' ? 'past_due'
    : sub.status === 'canceled' ? 'canceled'
    : sub.status === 'unpaid' ? 'unpaid'
    : 'none';

  await setSubscriptionStatus(merchant.id, status);

  const cancelAt = sub.cancel_at_period_end ? ` (canceling at ${new Date(sub.cancel_at * 1000).toLocaleDateString()})` : '';
  console.log(`[webhooks] Subscription ${subscriptionId} updated for merchant ${merchant.id} — status: ${status}${cancelAt}`);
}

async function handleSubscriptionDeleted(sub) {
  const subscriptionId = sub.id;

  const merchant = await getMerchantByStripeSubscriptionId(subscriptionId);
  if (!merchant) return;

  await setSubscriptionStatus(merchant.id, 'canceled');
  console.log(`[webhooks] Subscription ${subscriptionId} deleted for merchant ${merchant.id}`);
}

async function handlePaymentFailed(invoice) {
  // invoice.payment_failed — sent dunning email to merchant
  const customerId = invoice.customer;
  const subscriptionId = invoice.subscription;

  let merchant = await getMerchantByStripeSubscriptionId(subscriptionId);
  if (!merchant) {
    merchant = await getMerchantByStripeCustomerId(customerId);
  }
  if (!merchant) {
    console.warn('[webhooks] invoice.payment_failed: no merchant found');
    return;
  }

  // Update status to past_due
  await setSubscriptionStatus(merchant.id, 'past_due');

  // Send dunning email
  const nextRetryDate = invoice.next_payment_attempt
    ? new Date(invoice.next_payment_attempt * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
    : 'a few days';

  await sendDunningEmail(merchant.email, nextRetryDate);

  console.log(`[webhooks] Payment failed for merchant ${merchant.id} (${merchant.email}) — dunning email sent`);
}

module.exports = router;