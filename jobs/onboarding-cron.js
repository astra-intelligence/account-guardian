/**
 * Onboarding cron — runs on a schedule to process pending merchants.
 *
 * Two jobs in one:
 *  1. Follow-up emails for pending merchants who haven't connected after 24h
 *  2. Audit generation for connected merchants who haven't received their report
 *
 * Guards with POLSIA_IN_PROCESS_CRONS_ENABLED so it doesn't run on Blaxel during migration.
 * Declared in polsia.toml for the Blaxel-native schedule once migration completes.
 */
require('../db/index'); // init pool

const {
  getPendingMerchantsForFollowup,
  getConnectedMerchantsPendingAudit,
  markFollowupSent,
  getTokenByMerchantId,
  markAuditReportSent,
} = require('../db/merchants');

const { sendFollowupEmail, sendAuditReport, sendTrialConfirmation, formatPct } = require('../services/email');
const { refreshAccessToken, isTokenExpiringSoon } = require('../services/stripe');
const axios = require('axios');

const BASE_URL = process.env.APP_URL || 'https://foundryiq-3.polsia.app';

async function run() {
  if (process.env.POLSIA_IN_PROCESS_CRONS_ENABLED !== 'true') {
    console.log('[onboarding-cron] Disabled (POLSIA_IN_PROCESS_CRONS_ENABLED != true)');
    return;
  }

  console.log('[onboarding-cron] Starting onboarding cron job');

  const followupResults = await runFollowupJob();
  const auditResults = await runAuditJob();

  console.log(`[onboarding-cron] Done. Followup: ${followupResults.sent} sent, ${followupResults.skipped} skipped. Audit: ${auditResults.sent} sent, ${auditResults.skipped} skipped.`);
  process.exit(0);
}

// ── Job 1: 24h follow-up for unconnected merchants ───────────────────────────

async function runFollowupJob() {
  const merchants = await getPendingMerchantsForFollowup(24);

  if (merchants.length === 0) {
    return { sent: 0, skipped: 0 };
  }

  let sent = 0, skipped = 0;
  for (const merchant of merchants) {
    try {
      await sendFollowupEmail(merchant.email);
      await markFollowupSent(merchant.id);
      sent++;
      await sleep(200); // Rate limit guard
    } catch (err) {
      console.error(`[onboarding-cron] Followup failed for ${merchant.email}:`, err.message);
      skipped++;
    }
  }

  return { sent, skipped };
}

// ── Job 2: Audit reports for connected-but-not-audited merchants ─────────────

async function runAuditJob() {
  const merchants = await getConnectedMerchantsPendingAudit(20);

  if (merchants.length === 0) {
    return { sent: 0, skipped: 0 };
  }

  let sent = 0, skipped = 0;
  for (const merchant of merchants) {
    try {
      await processMerchantAudit(merchant);
      sent++;
      await sleep(500); // Be gentle with Stripe API
    } catch (err) {
      console.error(`[onboarding-cron] Audit failed for ${merchant.email}:`, err.message);
      skipped++;
    }
  }

  return { sent, skipped };
}

async function processMerchantAudit(merchant) {
  const tokenRecord = await getTokenByMerchantId(merchant.id);
  if (!tokenRecord) {
    console.warn(`[onboarding-cron] No token for merchant ${merchant.id} — skipping audit`);
    return;
  }

  let accessToken = tokenRecord.access_token;
  if (isTokenExpiringSoon(tokenRecord.expires_at)) {
    const refreshed = await refreshAccessToken(tokenRecord.refresh_token);
    accessToken = refreshed.accessToken;
  }

  const signals = await captureSignals(accessToken, merchant.stripe_account_id);

  await sendAuditReport(merchant.email, signals);

  const trialEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const trialEndFormatted = trialEnd.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  await sendTrialConfirmation(merchant.email, trialEndFormatted, signals);

  await markAuditReportSent(merchant.id);
}

async function captureSignals(accessToken, stripeAccountId) {
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
  console.error('[onboarding-cron] Fatal error:', err.message);
  process.exit(1);
});