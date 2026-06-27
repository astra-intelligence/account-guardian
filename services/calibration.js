/**
 * Calibration service — computes personalized thresholds from 90-day Stripe history.
 *
 * Triggered once immediately after OAuth, then every 90 days via cron.
 * For merchants with insufficient history: seeds conservative defaults,
 * then re-calibrates automatically after 30 days of data collection.
 */
const axios = require('axios');

const STANDARD_WINDOW_DAYS = 90;
const MIN_HISTORY_DAYS = 14;      // need at least 14 days to calibrate
const MIN_SAMPLE_SIZE = 10;       // minimum number of charge records to compute reliable stats
const RECALIBRATION_DAYS = 90;

// Conservative defaults for new merchants (no history)
const FALLBACK_THRESHOLDS = {
  dispute_rate:    0.015,  // 1.5% — slightly below Stripe's implied review threshold
  refund_rate:     0.08,   // 8% — well above typical rates
  chargeback_rate: 0.005,  // 0.5% — conservative
  revenue_trend:   -0.20,  // -20% WoW (same as existing fixed)
};

/**
 * Run calibration for a single merchant.
 * Returns { calibrated: bool, thresholds: object, stats: object }
 */
async function runCalibration(merchant) {
  const { id: merchantId, stripe_account_id: stripeAccountId, accessToken } = merchant;

  // Pull 90-day history
  const history = await pullStripeHistory(accessToken, stripeAccountId);

  if (history.sampleSize < MIN_SAMPLE_SIZE) {
    // Not enough history yet — seed conservative defaults, flag for re-calibration
    console.log(`[calibration] Merchant ${merchantId}: only ${history.sampleSize} charges — seeding conservative thresholds`);
    return {
      calibrated: false,
      reason: 'insufficient_history',
      sampleSize: history.sampleSize,
      thresholds: FALLBACK_THRESHOLDS,
    };
  }

  // Compute per-signal statistics
  const stats = computeSignalStats(history);
  const thresholds = computeThresholdsFromStats(stats);

  console.log(`[calibration] Merchant ${merchantId}: calibrated. dispute baseline=${stats.dispute.mean.toFixed(4)}, threshold=${thresholds.dispute_rate.toFixed(4)}`);

  return {
    calibrated: true,
    stats,
    thresholds,
    sampleSize: history.sampleSize,
    windowDays: STANDARD_WINDOW_DAYS,
  };
}

/**
 * Compute stats for each signal from 90-day Stripe history.
 */
function computeSignalStats(history) {
  const { chargeDates, disputes, refunds } = history;

  // Dispute rate: weekly rolling windows (7-day periods)
  const disputeRates = computeRollingRates(chargeDates, disputes, 7, d => d.status !== 'lost');

  // Refund rate: weekly rolling windows
  const refundRates = computeRollingRates(chargeDates, refunds, 7, () => true);

  // Chargeback rate: weekly rolling windows (disputes with status == 'lost')
  const chargebackRates = computeRollingRates(chargeDates, disputes, 7, d => d.status === 'lost');

  // Revenue trend: week-over-week (we already have this computed in history)
  const revenueTrend = history.revenueTrend;

  return {
    dispute:    calcStats(disputeRates),
    refund:     calcStats(refundRates),
    chargeback: calcStats(chargebackRates),
    revenue_trend: revenueTrend,
  };
}

/**
 * Compute rolling weekly rates from charge dates + events (disputes/refunds).
 * Returns array of weekly rates (fraction, not percentage).
 */
function computeRollingRates(chargeDates, events, windowDays, eventFilter) {
  if (chargeDates.length === 0) return [];

  const sortedDates = [...chargeDates].sort((a, b) => a - b);
  const minTs = sortedDates[0];
  const maxTs = sortedDates[sortedDates.length - 1];

  // Build event map keyed by day (day index = days since minTs)
  const eventDays = {};
  for (const event of events) {
    if (!eventFilter(event)) continue;
    const dayIdx = Math.floor((event.created - minTs) / (windowDays * 24 * 60 * 60));
    eventDays[dayIdx] = (eventDays[dayIdx] || 0) + 1;
  }

  const totalDays = Math.ceil((maxTs - minTs) / (windowDays * 24 * 60 * 60)) + 1;
  const rates = [];

  for (let w = 0; w < totalDays; w++) {
    // Count charges in this window
    const windowStart = minTs + w * windowDays * 24 * 60 * 60;
    const windowEnd = windowStart + windowDays * 24 * 60 * 60;
    const chargesInWindow = sortedDates.filter(ts => ts >= windowStart && ts < windowEnd).length;
    const eventsInWindow = eventDays[w] || 0;

    if (chargesInWindow > 0) {
      rates.push(eventsInWindow / chargesInWindow);
    }
  }

  return rates;
}

/**
 * Compute mean + standard deviation from an array of values.
 */
function calcStats(values) {
  if (values.length === 0) return { mean: 0, stdDev: 0, count: 0, min: 0, max: 0 };

  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);

  return {
    mean,
    stdDev,
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/**
 * Derive thresholds from signal stats.
 * Uses mean + (2 × std_dev) to only fire on statistically unusual deviation,
 * not normal seasonal variance. Caps at min values to avoid over-padding.
 */
function computeThresholdsFromStats(stats) {
  return {
    // dispute_rate: mean + 2σ. At 2 std deviations above mean, ~95% confidence it's unusual
    // Cap at 0.005 minimum (Stripe's implicit review trigger) to avoid false negatives
    dispute_rate:    Math.max(stats.dispute.mean + 2 * stats.dispute.stdDev, 0.005),

    // refund_rate: same approach
    refund_rate:     Math.max(stats.refund.mean + 2 * stats.refund.stdDev, 0.02),

    // chargeback_rate: mean + 2σ. Cap at 0.003 minimum (Stripe's chargeback threshold)
    chargeback_rate: Math.max(stats.chargeback.mean + 2 * stats.chargeback.stdDev, 0.003),

    // revenue_trend: fixed at -20% WoW (business logic decision — not statistically derived)
    revenue_trend:   -0.20,
  };
}

/**
 * Pull 90 days of Stripe signals from the merchant's Connect account.
 * Returns charge timestamps, dispute records, refund records, and revenue trend.
 */
async function pullStripeHistory(accessToken, stripeAccountId) {
  const now = new Date();
  const ninetyDaysAgo = Math.floor((now.getTime() - STANDARD_WINDOW_DAYS * 24 * 60 * 60 * 1000) / 1000);
  const fourteenDaysAgo = Math.floor((now.getTime() - 14 * 24 * 60 * 60 * 1000) / 1000);
  const sevenDaysAgo = Math.floor((now.getTime() - 7 * 24 * 60 * 60 * 1000) / 1000);

  const auth = { username: process.env.STRIPE_SECRET_KEY, password: '' };
  const headers = { Authorization: `Bearer ${accessToken}` };
  const acctHeader = `Bearer ${stripeAccountId}`; // Stripe Connect: pass as header for account-level requests

  let charges, disputes, refunds;
  try {
    [charges, disputes, refunds] = await Promise.all([
      axios.get(`https://api.stripe.com/v1/charges?created[gte]=${ninetyDaysAgo}&limit=100&stripe_account=${stripeAccountId}`, {
        auth,
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
      axios.get(`https://api.stripe.com/v1/disputes?created[gte]=${ninetyDaysAgo}&limit=100&stripe_account=${stripeAccountId}`, {
        auth,
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
      axios.get(`https://api.stripe.com/v1/refunds?created[gte]=${ninetyDaysAgo}&limit=100&stripe_account=${stripeAccountId}`, {
        auth,
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    ]);
  } catch (err) {
    throw new Error(`Stripe API error during calibration: ${err.message}`);
  }

  const chargesData = charges.data?.data || [];
  const disputesData = disputes.data?.data || [];
  const refundsData = refunds.data?.data || [];

  // Charge timestamps (for rolling windows)
  const chargeDates = chargesData.map(c => c.created);

  // Revenue trend: this week vs last week
  const revenueThisWeek = chargesData
    .filter(c => c.created >= sevenDaysAgo)
    .reduce((s, c) => s + (c.amount - (c.amount_refunded || 0)), 0);
  const revenueLastWeek = chargesData
    .filter(c => c.created >= fourteenDaysAgo && c.created < sevenDaysAgo)
    .reduce((s, c) => s + (c.amount - (c.amount_refunded || 0)), 0);
  const revenueTrend = revenueLastWeek > 0
    ? (revenueThisWeek - revenueLastWeek) / revenueLastWeek
    : 0;

  return {
    chargeDates,
    disputes: disputesData,
    refunds: refundsData,
    revenueTrend,
    sampleSize: chargesData.length,
  };
}

/**
 * Check if a merchant has enough history to recalibrate.
 * Used by the recalibration cron to decide which merchants to process.
 */
async function canRecalibrate(merchant) {
  const hasHistory = await merchantHasSignalHistory(merchant.id);
  return hasHistory;
}

// Helper: check signal_history for minimum days of data
async function merchantHasSignalHistory(merchantId) {
  const { pool } = require('../db/index');
  const result = await pool.query(
    `SELECT COUNT(DISTINCT DATE_TRUNC('day', captured_at)) as days
     FROM signal_history
     WHERE merchant_id = $1 AND captured_at >= NOW() - INTERVAL '30 days'`,
    [merchantId]
  );
  return parseInt(result.rows[0].days, 10) >= MIN_HISTORY_DAYS;
}

module.exports = {
  runCalibration,
  computeSignalStats,
  computeThresholdsFromStats,
  pullStripeHistory,
  FALLBACK_THRESHOLDS,
  STANDARD_WINDOW_DAYS,
  MIN_HISTORY_DAYS,
  MIN_SAMPLE_SIZE,
  RECALIBRATION_DAYS,
};