/**
 * Billing routes — Stripe Checkout and subscription management.
 *
 * GET  /billing/checkout?email=...     — Create Stripe Checkout session, redirect merchant
 * GET  /billing/cancel?email=...        — Cancel subscription at period end (merchant dashboard)
 * GET  /billing/cancel-now?email=...   — Immediately cancel (settings page)
 */

const express = require('express');
const router = express.Router();

const { getMerchantByEmail } = require('../db/merchants');
const { setStripeCustomerId } = require('../db/merchants');
const { findOrCreateCustomer, createCheckoutSession, cancelSubscriptionAtPeriodEnd, healthCheck } = require('../services/billing');

const BASE_URL = process.env.APP_URL || 'https://foundryiq-3.polsia.app';

// GET /billing/checkout — create Stripe Checkout session for $79/month
router.get('/checkout', async (req, res) => {
  const { email } = req.query;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid email is required' });
  }

  const merchant = await getMerchantByEmail(email);
  if (!merchant) {
    return res.redirect(`${BASE_URL}/?error=merchant_not_found`);
  }

  // Only allow checkout if not already active subscriber
  if (merchant.subscription_status === 'active') {
    return res.redirect(`${BASE_URL}/dashboard?email=${encodeURIComponent(email)}&billing=already_active`);
  }

  try {
    // Find or create Stripe customer
    const customer = await findOrCreateCustomer(email, merchant.id);

    // Store customer ID on merchant
    if (!merchant.stripe_customer_id || merchant.stripe_customer_id !== customer.id) {
      await setStripeCustomerId(merchant.id, customer.id);
    }

    // Create Checkout Session
    const session = await createCheckoutSession(customer.id, email, merchant.id);

    if (!session.url) {
      throw new Error('No checkout URL returned from Stripe');
    }

    res.redirect(session.url);
  } catch (err) {
    const stripeErr = err.response?.data;
    console.error('[billing] Checkout creation failed:', err.message);
    if (stripeErr) {
      console.error('[billing] Stripe error:', JSON.stringify(stripeErr));
    }
    // Pass the Stripe error type in the redirect so we can show more specific messages
    const stripeErrorType = stripeErr?.error?.type || '';
    const stripeErrorCode = stripeErr?.error?.code || '';
    res.redirect(`${BASE_URL}/dashboard?email=${encodeURIComponent(email)}&billing=error&stripe_type=${encodeURIComponent(stripeErrorType)}&stripe_code=${encodeURIComponent(stripeErrorCode)}`);
  }
});

// GET /billing/cancel — cancel at period end
router.get('/cancel', async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const merchant = await getMerchantByEmail(email);
  if (!merchant) {
    return res.redirect(`${BASE_URL}/?error=merchant_not_found`);
  }

  if (!merchant.stripe_subscription_id) {
    return res.redirect(`${BASE_URL}/dashboard?email=${encodeURIComponent(email)}&billing=no_subscription`);
  }

  try {
    await cancelSubscriptionAtPeriodEnd(merchant.stripe_subscription_id);
    res.redirect(`${BASE_URL}/dashboard?email=${encodeURIComponent(email)}&billing=cancel_scheduled`);
  } catch (err) {
    console.error('[billing] Cancel failed:', err.message);
    res.redirect(`${BASE_URL}/dashboard?email=${encodeURIComponent(email)}&billing=cancel_error`);
  }
});

// GET /billing/status — diagnostic: check Stripe key + connectivity
router.get('/status', async (req, res) => {
  try {
    const result = await healthCheck();
    res.json({ ok: true, stripe: result });
  } catch (err) {
    const errData = err.response?.data;
    res.status(500).json({
      ok: false,
      message: err.message,
      status: err.response?.status,
      type: errData?.error?.type,
      code: errData?.error?.code,
      param: errData?.error?.param,
      decline_code: errData?.error?.decline_code,
    });
  }
});

module.exports = router;