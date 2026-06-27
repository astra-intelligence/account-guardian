/**
 * Trial Conversion Cron — runs daily to process the 6-email trial sequence.
 *
 * Jobs:
 *  1. Day 7 mid-trial check-in for active merchants
 *  2. Day 12 trial-ending-soon email (48h before trial ends)
 *  3. Day 14 trial conversion request (trial ended)
 *
 * Guards with POLSIA_IN_PROCESS_CRONS_ENABLED so it doesn't run on Blaxel during migration.
 * Declared in polsia.toml for the Blaxel-native schedule once migration completes.
 */
require('../db/index'); // init pool

const {
  getMerchantsForMidTrial,
  getMerchantsForTrialEndingSoon,
  getMerchantsForConversionRequest,
  markMidTrialSent,
  markTrialEndingSent,
  markConversionSent,
  markTrialExpired,
  updateSignalSnapshot,
  getAlertCount,
} = require('../db/merchants');

const { getTokenByMerchantId } = require('../db/stripe-tokens');

const {
  sendMidTrialCheckIn,
  sendTrialEndingSoon,
  sendTrialConversionRequest,
  sendTrialExpiredOffboarding,
  formatPct,
} = require('../services/email');

const { refreshAccessToken, isTokenExpiringSoon } = require('../services/stripe');
const axios = require('axios');

async function run() {
  if (process.env.POLSIA_IN_PROCESS_CRONS_ENABLED !== 'true') {
    console.log('[trial-conversion-cron] Disabled (POLSIA_IN_PROCESS_CRONS_ENABLED != true)');
    return;
  }

  console.log('[trial-conversion-cron] Starting trial conversion cron job');

  const midTrialResults = await runMidTrialJob();
  const endingSoonResults = await runTrialEndingJob();
  const conversionResults = await runConversionJob();

  console.log(`[trial-conversion-cron] Done. Mid-trial: ${midTrialResults.sent} sent. Ending-soon: ${endingSoonResults.sent} sent. Conversion: ${conversionResults.sent} sent.`);
  process.exit(0);
}

// ── Job 1: Day 7 mid-trial check-in ──────────────────────────────────────────

async function runMidTrialJob() {
  const merchants = await getMerchantsForMidTrial(7);

  if (merchants.length === 0) {
    return { sent: 0, skipped: 0 };
  }

  let sent = 0, skipped = 0;
  for (const merchant of merchants) {
    try {
      const signals = await captureCurrentSignals(merchant);
      const alertCount = await getAlertCount(merchant.id);

      const trialEnd = merchant.trial_ends_at
        ? new Date(merchant.trial_ends_at)
        : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const daysLeft = Math.max(0, Math.ceil((trialEnd - Date.now()) / (24 * 60 * 60 * 1000)));

      const dashboardUrl = `${process.env.APP_URL || 'https://foundryiq-3.polsia.app'}/dashboard`;
      const isConnected = !!merchant.stripe_account_id;

      await sendMidTrialCheckIn(merchant.email, daysLeft, isConnected, signals, dashboardUrl);
      await markMidTrialSent(merchant.id);

      if (signals) {
        await updateSignalSnapshot(merchant.id, signals, alertCount);
      }

      sent++;
      await sleep(300);
    } catch (err) {
      console.error(`[trial-conversion-cron] Mid-trial failed for ${merchant.email}:`, err.message);
      skipped++;
    }
  }

  return { sent, skipped };
}

// ── Job 2: Day 12 trial ending soon ──────────────────────────────────────────

async function runTrialEndingJob() {
  const merchants = await getMerchantsForTrialEndingSoon(2);

  if (merchants.length === 0) {
    return { sent: 0, skipped: 0 };
  }

  let sent = 0, skipped = 0;
  for (const merchant of merchants) {
    try {
      const trialEndFormatted = merchant.trial_ends_at
        ? new Date(merchant.trial_ends_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
        : 'shortly';

      await sendTrialEndingSoon(merchant.email, trialEndFormatted);
      await markTrialEndingSent(merchant.id);

      sent++;
      await sleep(300);
    } catch (err) {
      console.error(`[trial-conversion-cron] Trial ending failed for ${merchant.email}:`, err.message);
      skipped++;
    }
  }

  return { sent, skipped };
}

// ── Job 3: Day 14 conversion request + trial expiration ──────────────────────

async function runConversionJob() {
  const merchants = await getMerchantsForConversionRequest();

  if (merchants.length === 0) {
    return { sent: 0, skipped: 0 };
  }

  let sent = 0, skipped = 0;
  for (const merchant of merchants) {
    try {
      const alertCount = merchant.last_signal_snapshot
        ? merchant.alert_count || 0
        : 0;

      const dashboardUrl = `${process.env.APP_URL || 'https://foundryiq-3.polsia.app'}/dashboard`;

      await sendTrialConversionRequest(merchant.email, alertCount, dashboardUrl);
      await markConversionSent(merchant.id);

      // Mark trial as expired in DB — merchant hits a wall on day 14
      const didExpire = await markTrialExpired(merchant.id);
      if (didExpire) {
        await sendTrialExpiredOffboarding(merchant.email, dashboardUrl);
        console.log(`[trial-conversion-cron] Trial expired for ${merchant.email} — offboarding sent`);
      }

      sent++;
      await sleep(300);
    } catch (err) {
      console.error(`[trial-conversion-cron] Conversion failed for ${merchant.email}:`, err.message);
      skipped++;
    }
  }

  return { sent, skipped };
}

// ── Signal capture ─────────────────────────────────────────────────────────────

async function captureCurrentSignals(merchant) {
  if (!merchant.stripe_account_id) return null;

  const tokenRecord = await getTokenByMerchantId(merchant.id);
  if (!tokenRecord) return null;

  let accessToken = tokenRecord.access_token;
  if (isTokenExpiringSoon(tokenRecord.expires_at)) {
    const refreshed = await refreshAccessToken(tokenRecord.refresh_token);
    accessToken = refreshed.accessToken;
  }

  const now = new Date();
  const thirtyDaysAgo = Math.floor((now.getTime() - 30 * 24 * 60 * 60 * 1000) / 1000);
  const sixtyDaysAgo = Math.floor((now.getTime() - 60 * 24 * 60 * 60 * 1000) / 1000);

  const auth = { username: process.env.STRIPE_SECRET_KEY, password: '' };
  const headers = { Authorization: `Bearer ${accessToken}` };

  const [chargesRes, disputesRes, refundsRes] = await Promise.all([
    axios.get(`https://api.stripe.com/v1/charges?created[gte]=${sixtyDaysAgo}&limit=100&stripe_account=${merchant.stripe_account_id}`, { headers, auth }),
    axios.get(`https://api.stripe.com/v1/disputes?created[gte]=${sixtyDaysAgo}&limit=100&stripe_account=${merchant.stripe_account_id}`, { headers, auth }),
    axios.get(`https://api.stripe.com/v1/refunds?created[gte]=${thirtyDaysAgo}&limit=100&stripe_account=${merchant.stripe_account_id}`, { headers, auth }),
  ]);

  const charges = chargesRes.data.data || [];
  const disputes = disputesRes.data.data || [];
  const refunds = refundsRes.data.data || [];

  const totalCharges = charges.length;
  return {
    dispute_rate: totalCharges > 0 ? disputes.filter(d => d.status !== 'lost').length / totalCharges : 0,
    refund_rate: totalCharges > 0 ? refunds.length / totalCharges : 0,
    chargeback_rate: totalCharges > 0 ? disputes.filter(d => d.status === 'lost').length / totalCharges : 0,
    total_charges: totalCharges,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

run().catch(err => {
  console.error('[trial-conversion-cron] Fatal error:', err.message);
  process.exit(1);
});