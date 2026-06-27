/**
 * Daily Monitoring Cron — runs daily to pull Stripe signals, evaluate
 * against calibrated (or fixed fallback) thresholds, fire alerts, and log to DB.
 *
 * Uses merchant-specific calibrated thresholds when available (from services/calibration.js).
 * Falls back to fixed industry benchmarks for merchants with conservative defaults.
 *
 * Guards with POLSIA_IN_PROCESS_CRONS_ENABLED so it doesn't run on Blaxel during migration.
 * Declared in polsia.toml for the Blaxel-native schedule once migration completes.
 */
require('../db/index'); // init pool

const { pool } = require('../db/index');
const {
  insertSignalsBatch,
  insertAlert,
  getTodayAlertCount,
} = require('../db/signals');
const { getThresholds } = require('../db/signals');
const { refreshAccessToken, isTokenExpiringSoon } = require('../services/stripe');
const { sendAlertEmail } = require('../services/email');
const axios = require('axios');

// Fixed fallback thresholds (for merchants without calibrated thresholds)
const FIXED_THRESHOLDS = {
  dispute_rate:           0.02,   // 2% — Stripe review trigger (includes chargeback as input)
  auth_rate:              0.05,   // 5% — failed auth/decline rate threshold
  revenue_trend:         -0.20,   // -20% WoW revenue drop
  transaction_velocity:   3.0,    // 3x normal — velocity spike
  low_volume:             0.50,   // 50% drop vs 30-day average
};

async function run() {
  if (process.env.POLSIA_IN_PROCESS_CRONS_ENABLED !== 'true') {
    console.log('[daily-monitoring] Disabled (POLSIA_IN_PROCESS_CRONS_ENABLED != true)');
    return;
  }

  console.log('[daily-monitoring] Starting daily monitoring run');
  const startTime = Date.now();

  // Get all active/connected merchants with Stripe tokens
  const merchants = await getMonitoredMerchants();

  if (merchants.length === 0) {
    console.log('[daily-monitoring] No merchants to monitor — exiting');
    process.exit(0);
  }

  console.log(`[daily-monitoring] Monitoring ${merchants.length} merchant(s)`);

  let processed = 0, alertsFired = 0;
  for (const merchant of merchants) {
    try {
      const result = await processMerchant(merchant);
      if (result.alertCount > 0) alertsFired += result.alertCount;
      processed++;
      await sleep(200);
    } catch (err) {
      console.error(`[daily-monitoring] Error for ${merchant.email}:`, err.message);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[daily-monitoring] Done in ${elapsed}s. Processed: ${processed}, Alerts fired: ${alertsFired}`);
  process.exit(0);
}

// ── Main processing ──────────────────────────────────────────────────────────

async function processMerchant(merchant) {
  const signals = await captureSignals(merchant);
  if (!signals) {
    console.log(`[daily-monitoring] No signal data for ${merchant.email}`);
    return { alertCount: 0 };
  }

  // Store signals in DB (5 distinct signals — dispute_rate includes chargeback as input)
  const signalArray = [
    { signal_type: 'dispute_rate', value: signals.dispute_rate },
    { signal_type: 'auth_rate', value: signals.auth_rate },
    { signal_type: 'revenue_trend', value: signals.revenue_trend },
    { signal_type: 'transaction_velocity', value: signals.transaction_velocity },
    { signal_type: 'low_volume', value: signals.low_volume },
  ];
  await insertSignalsBatch(merchant.id, signalArray);

  // Evaluate against calibrated thresholds (or fixed fallback)
  const violations = await evaluateThresholds(merchant, signals);

  // Fire alert email if any violations and no alert already sent today
  if (violations.length > 0) {
    await fireAlertIfNeeded(merchant, violations);
    return { alertCount: violations.length };
  }

  return { alertCount: 0 };
}

// ── Signal capture ─────────────────────────────────────────────────────────────

async function captureSignals(merchant) {
  if (!merchant.stripe_account_id || !merchant.access_token) return null;

  let accessToken = merchant.access_token;
  if (isTokenExpiringSoon(merchant.expires_at)) {
    try {
      const refreshed = await refreshAccessToken(merchant.refresh_token);
      accessToken = refreshed.accessToken;
      // Persist refreshed tokens
      await pool.query(
        `UPDATE stripe_tokens SET access_token = $2, refresh_token = $3, expires_at = $4, updated_at = NOW()
         WHERE merchant_id = $1`,
        [merchant.id, refreshed.accessToken, refreshed.refreshToken, refreshed.expiresAt || null]
      );
    } catch (err) {
      console.error(`[daily-monitoring] Token refresh failed for ${merchant.email}:`, err.message);
      return null;
    }
  }

  const now = new Date();
  const thirtyDaysAgo = Math.floor((now.getTime() - 30 * 24 * 60 * 60 * 1000) / 1000);
  const sixtyDaysAgo = Math.floor((now.getTime() - 60 * 24 * 60 * 60 * 1000) / 1000);
  const sevenDaysAgo = Math.floor((now.getTime() - 7 * 24 * 60 * 60 * 1000) / 1000);
  const fourteenDaysAgo = Math.floor((now.getTime() - 14 * 24 * 60 * 60 * 1000) / 1000);

  const auth = { username: process.env.STRIPE_SECRET_KEY, password: '' };
  const headers = { Authorization: `Bearer ${accessToken}` };
  const acct = merchant.stripe_account_id;

  let charges, disputes, refunds;
  try {
    [charges, disputes, refunds] = await Promise.all([
      axios.get(`https://api.stripe.com/v1/charges?created[gte]=${sixtyDaysAgo}&limit=100&stripe_account=${acct}`, { headers, auth }),
      axios.get(`https://api.stripe.com/v1/disputes?created[gte]=${sixtyDaysAgo}&limit=100&stripe_account=${acct}`, { headers, auth }),
      axios.get(`https://api.stripe.com/v1/refunds?created[gte]=${thirtyDaysAgo}&limit=100&stripe_account=${acct}`, { headers, auth }),
    ]);
  } catch (err) {
    console.error(`[daily-monitoring] Stripe API error for ${merchant.email}:`, err.message);
    return null;
  }

  const chargesData = charges.data.data || [];
  const disputesData = disputes.data.data || [];
  const refundsData = refunds.data.data || [];

  const totalCharges = chargesData.length;

  // Compute week-over-week revenue for the last 7 days vs prior 7 days
  const revenueThisWeek = chargesData
    .filter(c => c.created >= sevenDaysAgo)
    .reduce((sum, c) => sum + (c.amount - (c.amount_refunded || 0)), 0);
  const revenueLastWeek = chargesData
    .filter(c => c.created >= fourteenDaysAgo && c.created < sevenDaysAgo)
    .reduce((sum, c) => sum + (c.amount - (c.amount_refunded || 0)), 0);

  const revenueTrend = revenueLastWeek > 0
    ? (revenueThisWeek - revenueLastWeek) / revenueLastWeek
    : 0;

  // Auth rate: failed charges / total charges (Stripe doesn't expose separate auth attempts)
  // "failed" here = charges with failure_code present (declined/insufficient funds etc)
  const failedCharges = chargesData.filter(c => c.dispute == null && c.status === 'failed').length;
  const authRate = totalCharges > 0 ? failedCharges / totalCharges : 0;

  // Transaction velocity: current 7-day count vs 30-day daily average
  const countLast7Days = chargesData.filter(c => c.created >= sevenDaysAgo).length;
  const countLast30Days = chargesData.length;
  const avgDailyCount = countLast30Days / 30;
  const transactionVelocity = avgDailyCount > 0 ? countLast7Days / (avgDailyCount * 7) : 0;

  // Low volume: current 7-day revenue vs 30-day average daily revenue
  const total30DayRevenue = chargesData.reduce((sum, c) => sum + (c.amount - (c.amount_refunded || 0)), 0);
  const avgDailyRevenue = total30DayRevenue / 30;
  const lowVolume = avgDailyRevenue > 0 ? revenueThisWeek / (avgDailyRevenue * 7) : 0;

  // Dispute rate includes chargebacks as one input — no separate chargeback signal
  const disputeCount = disputesData.filter(d => d.status !== 'lost').length;
  const disputeRate = totalCharges > 0 ? disputeCount / totalCharges : 0;

  return {
    dispute_rate: disputeRate,
    auth_rate: authRate,
    revenue_trend: revenueTrend,
    transaction_velocity: transactionVelocity,
    low_volume: lowVolume,
    total_charges: totalCharges,
  };
}

// ── Threshold evaluation ───────────────────────────────────────────────────────
// Five distinct signals — dispute_rate includes chargeback as one input

async function evaluateThresholds(merchant, signals) {
  // Load calibrated thresholds for this merchant
  let thresholds = {};
  try {
    const rows = await pool.query(
      'SELECT signal_type, threshold_value FROM thresholds WHERE merchant_id = $1',
      [merchant.id]
    );
    if (rows.rows.length > 0) {
      for (const row of rows.rows) {
        thresholds[row.signal_type] = parseFloat(row.threshold_value);
      }
    }
  } catch (err) {
    console.error(`[daily-monitoring] Failed to load thresholds for ${merchant.id}:`, err.message);
  }

  const violations = [];

  // 1. Dispute rate (includes chargebacks as one input — no separate chargeback signal)
  const disputeThreshold = thresholds.dispute_rate ?? FIXED_THRESHOLDS.dispute_rate;
  if (signals.dispute_rate > disputeThreshold) {
    violations.push({ signalType: 'dispute_rate', actualValue: signals.dispute_rate, thresholdValue: disputeThreshold, severity: signals.dispute_rate > disputeThreshold * 1.5 ? 'critical' : 'warning' });
  }

  // 2. Auth rate (failed/declined payment attempts)
  const authThreshold = thresholds.auth_rate ?? FIXED_THRESHOLDS.auth_rate;
  if (signals.auth_rate > authThreshold) {
    violations.push({ signalType: 'auth_rate', actualValue: signals.auth_rate, thresholdValue: authThreshold, severity: 'warning' });
  }

  // 3. Revenue trend (week-over-week drop)
  const revenueThreshold = thresholds.revenue_trend ?? FIXED_THRESHOLDS.revenue_trend;
  if (signals.revenue_trend < revenueThreshold) {
    violations.push({ signalType: 'revenue_trend', actualValue: signals.revenue_trend, thresholdValue: revenueThreshold, severity: 'warning' });
  }

  // 4. Transaction velocity (unusual patterns — velocity spike above 3x normal)
  const velocityThreshold = thresholds.transaction_velocity ?? FIXED_THRESHOLDS.transaction_velocity;
  if (signals.transaction_velocity > velocityThreshold) {
    violations.push({ signalType: 'transaction_velocity', actualValue: signals.transaction_velocity, thresholdValue: velocityThreshold, severity: 'warning' });
  }

  // 5. Low volume (sudden drop vs 30-day average)
  const volumeThreshold = thresholds.low_volume ?? FIXED_THRESHOLDS.low_volume;
  if (signals.low_volume < volumeThreshold) {
    violations.push({ signalType: 'low_volume', actualValue: signals.low_volume, thresholdValue: volumeThreshold, severity: 'warning' });
  }

  return violations;
}

// ── Alert firing ──────────────────────────────────────────────────────────────

async function fireAlertIfNeeded(merchant, violations) {
  // Deduplication: fire at most one email per signal type per day
  const eligibleViolations = [];
  for (const v of violations) {
    const todayCount = await getTodayAlertCount(merchant.id, v.signalType);
    if (todayCount === 0) {
      eligibleViolations.push(v);
    }
  }

  if (eligibleViolations.length === 0) {
    console.log(`[daily-monitoring] Skipping alert for ${merchant.email} — already fired today`);
    return;
  }

  // Log each violation to DB
  for (const v of eligibleViolations) {
    const thresholdVal = v.thresholdValue ?? 0;
    await insertAlert(merchant.id, v.signalType, thresholdVal, v.actualValue, v.severity);
  }

  // Send one consolidated email
  const merchantName = merchant.business_name || merchant.email.split('@')[0];
  await sendAlertEmail(merchant.email, merchantName, eligibleViolations);

  console.log(`[daily-monitoring] Alert fired for ${merchant.email}: ${eligibleViolations.map(v => v.signalType).join(', ')}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Get merchants who have connected Stripe (have tokens) and are active/trial
async function getMonitoredMerchants() {
  const result = await pool.query(`
    SELECT m.id, m.email, m.business_name, m.stripe_account_id,
           st.access_token, st.refresh_token, st.expires_at
    FROM merchants m
    JOIN stripe_tokens st ON st.merchant_id = m.id
    WHERE m.stripe_account_id IS NOT NULL
      AND m.status IN ('active', 'trial', 'connected', 'audited')
      AND m.subscription_status IN ('active', 'trialing')
    ORDER BY m.id
    LIMIT 200
  `);
  return result.rows;
}

run().catch(err => {
  console.error('[daily-monitoring] Fatal error:', err.message);
  process.exit(1);
});