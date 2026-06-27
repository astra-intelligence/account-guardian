/**
 * Auth routes — Stripe Connect OAuth + user auth (signup/login/logout).
 *
 * Stripe OAuth:
 *   GET /auth/stripe?email=...      → redirect to Stripe OAuth
 *   GET /auth/stripe/callback?code=… → exchange code, store tokens, trigger audit, redirect to dashboard
 *   GET /auth/stripe/disconnect?email=… → revoke tokens, clear DB, show confirmation
 *
 * User auth:
 *   GET  /auth/signup  — signup page
 *   POST /auth/signup  — create account
 *   GET  /auth/login   — login page
 *   POST /auth/login   — authenticate
 *   POST /auth/logout  — destroy session
 *   GET  /auth/me     — session check (JSON)
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');

const { getOrCreateMerchant, updateMerchantStripeAccount, hasStripeToken, setMerchantStatus, markOAuthConnected, activateTrial } = require('../db/merchants');
const { upsertToken, deleteTokenByMerchantId, getTokenByMerchantId } = require('../db/stripe-tokens');
const { exchangeCode, revokeToken, refreshAccessToken, isTokenExpiringSoon } = require('../services/stripe');
const { sendAuditReport, sendTrialConfirmation, formatPct, computeVerdict } = require('../services/email');

const BASE_URL = process.env.APP_URL || 'https://foundryiq-3.polsia.app';

// GET /auth/stripe — initiate OAuth
router.get('/stripe', async (req, res) => {
  const { email } = req.query;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid email is required to connect Stripe' });
  }

  const merchant = await getOrCreateMerchant(email);
  if (await hasStripeToken(merchant.id)) {
    return res.redirect(`${BASE_URL}/dashboard?email=${encodeURIComponent(email)}&already_connected=1`);
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.STRIPE_CLIENT_ID,
    scope: 'read_only',
    redirect_uri: `${BASE_URL}/auth/stripe/callback`,
    state: Buffer.from(JSON.stringify({ merchant_id: merchant.id, email })).toString('base64'),
  });

  const authUrl = `https://connect.stripe.com/oauth/authorize?${params.toString()}`;
  res.redirect(authUrl);
});

// GET /auth/stripe/callback — Stripe redirects here after authorization
router.get('/stripe/callback', async (req, res) => {
  const { code, error, state } = req.query;

  if (error || !code) {
    const errDesc = req.query.error_description || error || 'unknown';
    return res.redirect(`${BASE_URL}/dashboard?error=oauth_denied&reason=${encodeURIComponent(errDesc)}`);
  }

  let merchantId, email;
  try {
    const decoded = JSON.parse(Buffer.from(state, 'base64').toString('utf8'));
    merchantId = decoded.merchant_id;
    email = decoded.email;
  } catch {
    return res.redirect(`${BASE_URL}/dashboard?error=invalid_state`);
  }

  try {
    const tokens = await exchangeCode(code, `${BASE_URL}/auth/stripe/callback`);

    await upsertToken(merchantId, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    });

    await updateMerchantStripeAccount(merchantId, tokens.stripeUserId);
    await markOAuthConnected(merchantId);

    // Fire audit, calibration, and trial activation asynchronously (non-blocking)
    Promise.all([
      fireAuditAndActivateTrial(merchantId, email, tokens.accessToken, tokens.stripeUserId),
      runCalibrationJob(merchantId),
    ]).catch(err => {
      console.error('[auth] Post-OAuth async tasks failed (merchant still connected):', err.message);
    });

    return res.redirect(`${BASE_URL}/dashboard?email=${encodeURIComponent(email)}&connected=1`);
  } catch (err) {
    const stripeError = err.response?.data;
    const stripeErrorDesc = stripeError?.error_description || stripeError?.error || err.message;
    console.error('[auth] Token exchange failed:', stripeErrorDesc, '| Detail:', JSON.stringify(stripeError));
    return res.redirect(`${BASE_URL}/dashboard?error=token_exchange_failed`);
  }
});

// GET /auth/stripe/disconnect — revoke tokens and clear DB record
router.get('/stripe/disconnect', async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const merchant = await getOrCreateMerchant(email);
  const tokenRecord = await getTokenByMerchantId(merchant.id);

  if (tokenRecord && tokenRecord.access_token) {
    try {
      await revokeToken(tokenRecord.access_token);
    } catch (err) {
      console.error('[auth] Token revocation failed (continuing with DB cleanup):', err.message);
    }
  }

  await deleteTokenByMerchantId(merchant.id);
  await setMerchantStatus(merchant.id, 'disconnected');

  return res.redirect(`${BASE_URL}/dashboard?email=${encodeURIComponent(email)}&disconnected=1`);
});

// ── User auth ────────────────────────────────────────────────────────────────

const bcrypt = require('bcryptjs');
const { createUser, getUserByEmail } = require('../db/users');
const { createPendingMerchant } = require('../db/merchants');

const SALT_ROUNDS = 12;

router.get('/signup', (req, res) => {
  if (req.session && req.session.userId) {
    return res.redirect('/dashboard');
  }
  res.render('auth-signup', { error: null });
});

router.post('/signup', async (req, res) => {
  const { email, password, name } = req.body;

  if (!email || !email.includes('@') || !password || password.length < 8) {
    return res.status(400).json({ error: 'Valid email and password (8+ chars) required' });
  }

  const normalized = email.trim().toLowerCase();
  const existing = await getUserByEmail(normalized);
  if (existing) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await createUser(normalized, passwordHash, name || null);
  await createPendingMerchant(normalized);

  req.session.userId = user.id;
  req.session.userEmail = user.email;

  return res.json({ success: true, redirect: '/dashboard' });
});

router.get('/login', (req, res) => {
  if (req.session && req.session.userId) {
    return res.redirect('/dashboard');
  }
  res.render('auth-login', { error: null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !email.includes('@') || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const normalized = email.trim().toLowerCase();
  const user = await getUserByEmail(normalized);
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  req.session.userId = user.id;
  req.session.userEmail = user.email;

  return res.json({ success: true, redirect: '/dashboard' });
});

router.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    res.clearCookie('connect.sid');
    return res.json({ success: true });
  });
});

router.get('/me', (req, res) => {
  if (req.session && req.session.userId) {
    return res.json({ userId: req.session.userId, email: req.session.userEmail });
  }
  return res.json({ userId: null });
});

// ── Audit trigger (fires after OAuth connect) ────────────────────────────────

async function fireAuditAndActivateTrial(merchantId, email, accessToken, stripeAccountId) {
  const signals = await captureStripeSignals(accessToken, stripeAccountId);

  // Send audit report
  await sendAuditReport(email, signals);

  // Send trial confirmation
  const trialEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const trialEndFormatted = trialEnd.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  await sendTrialConfirmation(email, trialEndFormatted, signals);

  // Activate trial in DB
  await activateTrial(merchantId, true);

  console.log(`[onboarding] Audit triggered for merchant ${merchantId}. Signals: dispute=${formatPct(signals.dispute_rate)}, refund=${formatPct(signals.refund_rate)}`);
}

// Spawn calibration as a child process — runs independently, sends baseline email
async function runCalibrationJob(merchantId) {
  const { exec } = require('child_process');
  const nodePath = process.env.NODE || 'node';
  return new Promise((resolve, reject) => {
    const child = exec(
      `${nodePath} jobs/run-calibration.js ${merchantId}`,
      { cwd: process.cwd(), env: { ...process.env } },
      (err, stdout, stderr) => {
        if (err) {
          console.error(`[auth] Calibration job failed for merchant ${merchantId}:`, stderr || err.message);
          reject(err);
        } else {
          console.log(`[auth] Calibration completed for merchant ${merchantId}`);
          resolve(stdout);
        }
      }
    );
    child.stdout.on('data', d => process.stdout.write(`[calibration] ${d}`));
    child.stderr.on('data', d => process.stderr.write(`[calibration:err] ${d}`));
  });
}

async function captureStripeSignals(accessToken, stripeAccountId) {
  const now = new Date();
  const thirtyDaysAgo = Math.floor((now.getTime() - 30 * 24 * 60 * 60 * 1000) / 1000);
  const sixtyDaysAgo = Math.floor((now.getTime() - 60 * 24 * 60 * 60 * 1000) / 1000);

  const auth = { username: process.env.STRIPE_SECRET_KEY, password: '' };
  const headers = { Authorization: `Bearer ${accessToken}` };

  const [chargesRes, disputesRes, refundsRes] = await Promise.all([
    axios.get(`https://api.stripe.com/v1/charges?created[gte]=${sixtyDaysAgo}&limit=100&stripe_account=${stripeAccountId}`, { headers, auth }),
    axios.get(`https://api.stripe.com/v1/disputes?created[gte]=${sixtyDaysAgo}&limit=100&stripe_account=${stripeAccountId}`, { headers, auth }),
    axios.get(`https://api.stripe.com/v1/refunds?created[gte]=${thirtyDaysAgo}&limit=100&stripe_account=${stripeAccountId}`, { headers, auth }),
  ]);

  const charges = chargesRes.data.data || [];
  const disputes = disputesRes.data.data || [];
  const refunds = refundsRes.data.data || [];

  const totalCharges = charges.length;
  const disputedCount = disputes.filter(d => d.status !== 'lost').length;
  const refundedCount = refunds.length;
  const chargebackCount = disputes.filter(d => d.status === 'lost').length;

  return {
    dispute_rate: totalCharges > 0 ? disputedCount / totalCharges : 0,
    refund_rate: totalCharges > 0 ? refundedCount / totalCharges : 0,
    chargeback_rate: totalCharges > 0 ? chargebackCount / totalCharges : 0,
    total_charges: totalCharges,
  };
}

// GET /api/auth/diagnose-stripe — test OAuth config by attempting exchange with fake code
// Returns Stripe's actual error (redirect_uri_mismatch, invalid_client, etc.)
router.get('/diagnose-stripe', async (req, res) => {
  const redirectUri = `${BASE_URL}/auth/stripe/callback`;
  try {
    await exchangeCode('tok_test_diagnostic_intentionally_invalid', redirectUri);
    res.json({ ok: false, error: 'No error — token exchange succeeded unexpectedly' });
  } catch (err) {
    res.json({
      ok: false,
      error: err.message,
      stripe_error: err.stripeResponse?.error,
      stripe_description: err.stripeResponse?.error_description,
      http_status: err.httpStatus,
      app_url: BASE_URL,
      redirect_uri_sent: redirectUri,
    });
  }
});

module.exports = router;