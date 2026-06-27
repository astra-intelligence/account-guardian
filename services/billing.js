/**
 * Billing service — Stripe Checkout, customer management, and subscription operations.
 * Uses the Stripe REST API directly via axios (no stripe npm package).
 */

const axios = require('axios');

const STRIPE_API = 'https://api.stripe.com/v1';
const AUTH = { username: process.env.STRIPE_SECRET_KEY, password: '' };

// Product/price config — $79/month
const PRODUCT_NAME = 'Account Guardian';
const PRICE_AMOUNT_CENTS = 7900; // $79.00
const PRICE_CURRENCY = 'usd';

/**
 * Find or create a Stripe customer by email.
 * Returns the customer object { id, email, ... }.
 */
async function findOrCreateCustomer(email, merchantId) {
  // Try to find existing customer by email
  try {
    const searchRes = await axios.get(
      `${STRIPE_API}/customers/search`,
      {
        auth: AUTH,
        params: { query: `email:'${email}'`, limit: 1 },
      }
    );
    if (searchRes.data.data && searchRes.data.data.length > 0) {
      return searchRes.data.data[0];
    }
  } catch (err) {
    // If customer search fails (e.g., insufficient permissions), fall through to create
    console.warn('[billing] Customer search failed, creating new:', err.message);
  }

  // Create new customer
  const params = new URLSearchParams({ email });
  const createRes = await axios.post(
    `${STRIPE_API}/customers`,
    params.toString(),
    { auth: AUTH, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  return createRes.data;
}

/**
 * Create a Checkout Session for the $79/month subscription.
 * Returns { url } — redirect the merchant to this URL.
 */
async function createCheckoutSession(customerId, merchantEmail, merchantId) {
  const appUrl = process.env.APP_URL || 'https://foundryiq-3.polsia.app';

  const params = new URLSearchParams({
    'customer': customerId,
    'mode': 'subscription',
    'success_url': `${appUrl}/dashboard?email=${encodeURIComponent(merchantEmail)}&billing=success`,
    'cancel_url': `${appUrl}/dashboard?email=${encodeURIComponent(merchantEmail)}&billing=canceled`,
  });

  // Inline price — no pre-created product/price ID required
  params.append('line_items[0][price_data][currency]', PRICE_CURRENCY);
  params.append('line_items[0][price_data][product_data][name]', PRODUCT_NAME);
  params.append('line_items[0][price_data][product_data][description]', 'Daily Stripe account monitoring and alert system');
  params.append('line_items[0][price_data][unit_amount]', String(PRICE_AMOUNT_CENTS));
  params.append('line_items[0][price_data][recurring][interval]', 'month');
  params.append('line_items[0][quantity]', '1');

  const res = await axios.post(`${STRIPE_API}/checkout/sessions`, params.toString(), {
    auth: AUTH,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  return res.data;
}

/**
 * Get a Checkout Session by ID.
 */
async function getCheckoutSession(sessionId) {
  const res = await axios.get(`${STRIPE_API}/checkout/sessions/${sessionId}`, { auth: AUTH });
  return res.data;
}

/**
 * Cancel a subscription at period end (Stripe cancel_at_period_end).
 * Returns the updated subscription object.
 */
async function cancelSubscriptionAtPeriodEnd(subscriptionId) {
  const res = await axios.post(
    `${STRIPE_API}/subscriptions/${subscriptionId}`,
    new URLSearchParams({ cancel_at_period_end: 'true' }),
    { auth: AUTH, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return res.data;
}

/**
 * Immediately cancel a subscription (no refund, immediate effect).
 */
async function cancelSubscriptionNow(subscriptionId) {
  const res = await axios.post(
    `${STRIPE_API}/subscriptions/${subscriptionId}`,
    new URLSearchParams({ cancel_at: '0' }),
    { auth: AUTH, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return res.data;
}

/**
 * Get a subscription by ID.
 */
async function getSubscription(subscriptionId) {
  const res = await axios.get(`${STRIPE_API}/subscriptions/${subscriptionId}`, { auth: AUTH });
  return res.data;
}

/**
 * Health check — verify the Stripe secret key is valid.
 * Returns { ok, mode, accountId } or throws on failure.
 */
async function healthCheck() {
  const res = await axios.get(`${STRIPE_API}/balance`, { auth: AUTH });
  const mode = process.env.STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'live' : 'test';
  return { ok: true, mode, accountId: res.data.object };
}

/**
 * Verify a Stripe webhook signature using HMAC-SHA256.
 * Returns true if valid, false otherwise.
 */
function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return false;

  try {
    const parts = signatureHeader.split(',');
    const sigParts = {};
    for (const part of parts) {
      const [k, v] = part.split('=');
      if (k && v) sigParts[k.trim()] = v.trim();
    }

    const timestamp = sigParts['t'];
    const expectedSig = sigParts['v1'];

    if (!timestamp || !expectedSig) return false;

    // Reject events older than 5 minutes
    const age = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
    if (age > 300) return false;

    const payload = `${timestamp}.${rawBody}`;
    const crypto = require('crypto');
    const computed = crypto.createHmac('sha256', secret).update(payload).digest('hex');

    // Constant-time comparison
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(expectedSig));
  } catch {
    return false;
  }
}

module.exports = {
  findOrCreateCustomer,
  createCheckoutSession,
  getCheckoutSession,
  cancelSubscriptionAtPeriodEnd,
  cancelSubscriptionNow,
  getSubscription,
  verifyWebhookSignature,
  healthCheck,
};