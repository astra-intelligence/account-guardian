/**
 * Dashboard routes — merchant dashboard and settings.
 * Owns: GET /dashboard, GET /settings
 */
const express = require('express');
const router = express.Router();

const { getMerchantByEmail, hasStripeToken } = require('../db/merchants');
const { getTokenByMerchantId } = require('../db/stripe-tokens');
const { isTokenExpiringSoon } = require('../services/stripe');
const { getLatestSignals, getAlerts, getUnacknowledgedAlertCount, getThresholds, getDefaultThresholds, getMostRecentAlert, SIGNAL_TYPES, SIGNAL_LABELS } = require('../db/signals');

const BASE_URL = process.env.APP_URL || 'https://foundryiq-3.polsia.app';

// Compute account status label + color from signals and alerts
function computeStatus(latestSignals, alertCount, thresholds) {
  if (alertCount > 0) {
    const latest = latestSignals[0];
    return { label: 'Alert Fired', color: 'red', detail: latest ? SIGNAL_LABELS[latest.signal_type] || latest.signal_type : null };
  }
  if (latestSignals.length === 0) {
    return { label: 'No data', color: 'muted', detail: null };
  }
  // Check if any signal is near or over threshold
  for (const signal of latestSignals) {
    const t = thresholds.find(t => t.signal_type === signal.signal_type);
    if (t && parseFloat(signal.value) >= parseFloat(t.threshold_value) * 0.8) {
      return { label: 'Watching', color: 'yellow', detail: SIGNAL_LABELS[signal.signal_type] || signal.signal_type };
    }
  }
  return { label: 'Healthy', color: 'green', detail: null };
}

// GET /dashboard — merchant-facing monitoring dashboard
router.get('/', async (req, res) => {
  const { email: qEmail, connected, already_connected, disconnected, error, billing } = req.query;
  // Prefer session email; fall back to query param (for legacy links and Stripe redirect)
  const email = req.session && req.session.userEmail ? req.session.userEmail : qEmail;

  if (!email) return res.redirect(`${BASE_URL}/auth/login?return=${encodeURIComponent('/dashboard')}`);

  const merchant = await getMerchantByEmail(email);
  if (!merchant) return res.redirect(`${BASE_URL}/?error=merchant_not_found`);

  const connected_ = await hasStripeToken(merchant.id);
  const tokenRecord = connected_ ? await getTokenByMerchantId(merchant.id) : null;
  const tokenExpiring = tokenRecord ? isTokenExpiringSoon(tokenRecord.expires_at) : false;

  // Fetch signals, alerts, thresholds in parallel
  const [latestSignals, allAlerts, alertCount, merchantThresholds, defaultThresholds, mostRecentAlert] = await Promise.all([
    connected_ ? getLatestSignals(merchant.id) : Promise.resolve([]),
    connected_ ? getAlerts(merchant.id, { filter: 'all', limit: 20 }) : Promise.resolve([]),
    connected_ ? getUnacknowledgedAlertCount(merchant.id) : Promise.resolve(0),
    connected_ ? getThresholds(merchant.id) : Promise.resolve([]),
    connected_ ? getDefaultThresholds() : Promise.resolve([]),
    connected_ ? getMostRecentAlert(merchant.id) : Promise.resolve(null),
  ]);

  // Merge thresholds — merchant-specific takes precedence
  const thresholdsMap = {};
  for (const t of merchantThresholds) thresholdsMap[t.signal_type] = t.threshold_value;
  for (const d of defaultThresholds) {
    if (!thresholdsMap[d.signal_type]) thresholdsMap[d.signal_type] = d.threshold_value;
  }

  // Build signal cards
  const signalCards = SIGNAL_TYPES.map(signalType => {
    const signal = latestSignals.find(s => s.signal_type === signalType);
    const threshold = thresholdsMap[signalType] != null ? thresholdsMap[signalType] : null;
    let status = 'normal';
    let pct = null;
    if (signal && threshold != null) {
      const val = parseFloat(signal.value);
      const thr = parseFloat(threshold);
      if (val >= thr) {
        status = 'exceeded';
        pct = Math.min(100, Math.round((val / thr) * 100));
      } else if (thr > 0 && val >= thr * 0.8) {
        status = 'near';
        pct = Math.round((val / thr) * 100);
      } else {
        status = 'normal';
        pct = thr > 0 ? Math.round((val / thr) * 100) : 0;
      }
    }
    return {
      signal_type: signalType,
      label: SIGNAL_LABELS[signalType],
      value: signal ? parseFloat(signal.value).toFixed(3) : null,
      threshold,
      captured_at: signal ? signal.captured_at : null,
      status,
      pct: pct !== null ? pct : 0,
    };
  });

  // Filter options for alert history
  const alertFilter = req.query.filter || 'all';

  // Trial countdown
  let trialDaysLeft = null;
  if (merchant.trial_ends_at) {
    const diff = (new Date(merchant.trial_ends_at) - Date.now()) / (1000 * 60 * 60 * 24);
    trialDaysLeft = Math.max(0, Math.ceil(diff));
  }

  // Subscription renews date
  let renewsDate = null;

  // Stripe error details passed from billing redirect
  const stripeType = req.query.stripe_type || '';
  const stripeCode = req.query.stripe_code || '';

  // Build specific billing error message from Stripe error type
  let billingErrorMessage = null;
  if (billing === 'error') {
    if (stripeType === 'card_error') {
      billingErrorMessage = stripeCode === 'expired_card' ? 'Your card has expired. Please update your payment method.' : 'Your card was declined. Please try a different card.';
    } else if (stripeType === 'invalid_request_error') {
      billingErrorMessage = 'Payment configuration error — please contact support.';
    } else if (stripeType === 'api_error' || stripeType === 'api_connection_error') {
      billingErrorMessage = 'Payment system temporarily unavailable. Please try again in a moment.';
    } else {
      billingErrorMessage = 'Checkout failed. Please try again or contact support.';
    }
  }

  const flash = {
    connected: connected === '1',
    alreadyConnected: already_connected === '1',
    disconnected: disconnected === '1',
    error: error || null,
    billing_success: billing === 'success',
    billing_canceled: billing === 'canceled',
    billing_already_active: billing === 'already_active',
    billing_cancel_scheduled: billing === 'cancel_scheduled',
    billing_no_subscription: billing === 'no_subscription',
    billing_error: billing === 'error',
    billing_error_message: billingErrorMessage,
  };

  const stripeConnectUrl = connected_ ? null : `${BASE_URL}/auth/stripe?email=${encodeURIComponent(email)}`;
  const status = computeStatus(latestSignals, alertCount, merchantThresholds);

  res.render('dashboard', {
    merchant,
    connected: connected_,
    tokenExpiring,
    stripeConnectUrl,
    flash,
    appUrl: BASE_URL,
    // New data
    status,
    signalCards,
    allAlerts,
    alertCount,
    alertFilter,
    mostRecentAlert,
    trialDaysLeft,
    renewsDate,
  });
});

// GET /settings — settings page (router mounted at /settings in server.js)
router.get('/', async (req, res) => {
  // Accept email from session (logged-in nav) OR query param (nav links with ?email=)
  const email = (req.session && req.session.userEmail) || req.query.email;
  if (!email) return res.redirect(`${BASE_URL}/auth/login?return=${encodeURIComponent('/settings')}`);

  const merchant = await getMerchantByEmail(email);
  if (!merchant) return res.redirect(`${BASE_URL}/?error=merchant_not_found`);

  const connected_ = await hasStripeToken(merchant.id);

  res.render('settings', {
    merchant,
    connected: connected_,
    appUrl: BASE_URL,
  });
});

// GET /dashboard/signals/:type — JSON endpoint for 30-day chart data
router.get('/signals/:type/json', async (req, res) => {
  const { email } = req.query;
  const signalType = req.params.type;
  if (!email || !SIGNAL_TYPES.includes(signalType)) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  const merchant = await getMerchantByEmail(email);
  if (!merchant) return res.status(404).json({ error: 'Merchant not found' });

  const { getSignalHistory } = require('../db/signals');
  const history = await getSignalHistory(merchant.id, signalType, 30);
  res.json({ signal_type: signalType, history });
});

module.exports = router;