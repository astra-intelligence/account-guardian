/**
 * Onboarding routes — landing page signup and audit trigger.
 *
 * POST /onboarding/signup   — Merchant submits email on landing page
 *                              → stored with status='pending', welcome email sent
 * GET  /onboarding/audit-trigger/:merchantId  — Internal trigger for audit generation
 *                              → Called by cron job or OAuth callback
 */
const express = require('express');
const router = express.Router();

const {
  createPendingMerchant,
  getMerchantByEmail,
  markWelcomeSent,
  getMerchantById,
} = require('../db/merchants');

const { getTokenByMerchantId } = require('../db/stripe-tokens');
const {
  sendWelcomeEmail,
  sendAuditReport,
  sendTrialConfirmation,
} = require('../services/email');
const { refreshAccessToken, isTokenExpiringSoon } = require('../services/stripe');

const BASE_URL = process.env.APP_URL || 'https://foundryiq-3.polsia.app';

// POST /onboarding/signup — Landing page email capture
router.post('/signup', async (req, res) => {
  const { email } = req.body;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid email is required' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Check if merchant already exists and is past pending
  const existing = await getMerchantByEmail(normalizedEmail);
  if (existing && ['connected', 'audited', 'trial', 'active'].includes(existing.status)) {
    return res.json({
      success: true,
      message: 'Your account is already set up — check your email for next steps.',
    });
  }

  // Create or re-activate as pending
  const merchant = await createPendingMerchant(normalizedEmail);

  // Send welcome email immediately
  await sendWelcomeEmail(normalizedEmail, merchant.id);
  await markWelcomeSent(merchant.id);

  return res.json({
    success: true,
    message: "You're in — check your email to connect Stripe and get your free audit.",
  });
});

// GET /onboarding/audit-trigger/:merchantId — Trigger audit + trial for a connected merchant
// Called by cron or OAuth callback. Idempotent.
router.get('/audit-trigger/:merchantId', async (req, res) => {
  const { merchantId } = req.params;

  const merchant = await getMerchantById(merchantId);
  if (!merchant) {
    return res.status(404).json({ error: 'Merchant not found' });
  }

  if (!merchant.stripe_account_id) {
    return res.status(400).json({ error: 'Merchant has not connected Stripe yet' });
  }

  // Get fresh access token (refresh if needed)
  const tokenRecord = await getTokenByMerchantId(merchantId);
  if (!tokenRecord) {
    return res.status(400).json({ error: 'No Stripe token found for merchant' });
  }

  let accessToken = tokenRecord.access_token;
  if (isTokenExpiringSoon(tokenRecord.expires_at)) {
    try {
      const refreshed = await refreshAccessToken(tokenRecord.refresh_token);
      accessToken = refreshed.accessToken;
    } catch (err) {
      console.error('[onboarding] Token refresh failed:', err.message);
      return res.status(500).json({ error: 'Failed to refresh Stripe token' });
    }
  }

  // Capture signals from Stripe
  const signals = await captureSignals(accessToken, merchant.stripe_account_id);

  // Send audit report email
  await sendAuditReport(merchant.email, signals);

  // Send trial confirmation email
  const trialEndDate = formatTrialEndDate(merchant.trial_ends_at);
  await sendTrialConfirmation(merchant.email, trialEndDate, signals);

  return res.json({
    success: true,
    merchantId,
    signals,
    message: 'Audit report and trial confirmation sent.',
  });
});

// ── Signal capture from Stripe Connect ──────────────────────────────────────

async function captureSignals(accessToken, stripeAccountId) {
  const axios = require('axios');
  const headers = { Authorization: `Bearer ${accessToken}` };

  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  // Fetch charges, disputes, and refunds in parallel
  const [chargesRes, disputesRes, refundsRes] = await Promise.all([
    fetchWithRetry(`${stripeBaseUrl}/charges?created[gte]=${Math.floor(sixtyDaysAgo.getTime() / 1000)}&limit=100`, headers),
    fetchWithRetry(`${stripeBaseUrl}/disputes?created[gte]=${Math.floor(sixtyDaysAgo.getTime() / 1000)}&limit=100`, headers),
    fetchWithRetry(`${stripeBaseUrl}/refunds?created[gte]=${Math.floor(thirtyDaysAgo.getTime() / 1000)}&limit=100`, headers),
  ]);

  const charges = chargesRes.data.data || [];
  const disputes = disputesRes.data.data || [];
  const refunds = refundsRes.data.data || [];

  const totalCharges = charges.length;
  const disputedCount = disputes.filter(d => d.status !== 'lost').length;
  const refundedCount = refunds.length;

  const disputeRate = totalCharges > 0 ? disputedCount / totalCharges : 0;
  const refundRate = totalCharges > 0 ? refundedCount / totalCharges : 0;
  const chargebackCount = disputes.filter(d => d.status === 'lost').length;
  const chargebackRate = totalCharges > 0 ? chargebackCount / totalCharges : 0;

  return {
    dispute_rate: disputeRate,
    refund_rate: refundRate,
    chargeback_rate: chargebackRate,
    total_charges: totalCharges,
    disputed_count: disputedCount,
    refunded_count: refundedCount,
    captured_at: now.toISOString(),
  };
}

const stripeBaseUrl = 'https://api.stripe.com/v1';

async function fetchWithRetry(url, headers, retries = 2) {
  let lastError;
  for (let i = 0; i <= retries; i++) {
    try {
      return await axios.get(url, {
        headers,
        auth: { username: process.env.STRIPE_SECRET_KEY, password: '' },
      });
    } catch (err) {
      lastError = err;
      if (i < retries && err.response?.status === 429) {
        await sleep(500 * (i + 1));
        continue;
      }
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatTrialEndDate(trialEndsAt) {
  if (!trialEndsAt) {
    const d = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  }
  const d = new Date(trialEndsAt);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

module.exports = router;