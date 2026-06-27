/**
 * Merchants — CRUD operations for merchant records.
 */
const { pool } = require('./index');

// Get or create merchant by email
async function getOrCreateMerchant(email) {
  const result = await pool.query(
    `INSERT INTO merchants (email, trial_started_at, trial_ends_at)
     VALUES ($1, NOW(), NOW() + INTERVAL '14 days')
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING *`,
    [email]
  );
  return result.rows[0];
}

async function getMerchantById(id) {
  const result = await pool.query('SELECT * FROM merchants WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function getMerchantByEmail(email) {
  const result = await pool.query('SELECT * FROM merchants WHERE LOWER(email) = LOWER($1)', [email]);
  return result.rows[0] || null;
}

async function updateMerchantStripeAccount(id, stripeAccountId) {
  const result = await pool.query(
    `UPDATE merchants SET stripe_account_id = $2, status = 'active'::merchant_status, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, stripeAccountId]
  );
  return result.rows[0] || null;
}

async function setMerchantStatus(id, status) {
  await pool.query(
    `UPDATE merchants SET status = $2, updated_at = NOW() WHERE id = $1`,
    [id, status]
  );
}

// Create audit lead (no Stripe connected yet)
async function createAuditLead(email, websiteUrl) {
  const result = await pool.query(
    `INSERT INTO merchants (email, website_url, status, trial_started_at, trial_ends_at)
     VALUES ($1, $2, 'audit_requested'::merchant_status, NOW(), NOW() + INTERVAL '14 days')
     ON CONFLICT (email) DO UPDATE SET
       website_url = COALESCE(EXCLUDED.website_url, merchants.website_url),
       status = 'audit_requested'::merchant_status,
       updated_at = NOW()
     RETURNING *`,
    [email.toLowerCase().trim(), websiteUrl]
  );
  return result.rows[0];
}

async function hasStripeToken(merchantId) {
  const result = await pool.query(
    'SELECT 1 FROM stripe_tokens WHERE merchant_id = $1 LIMIT 1',
    [merchantId]
  );
  return result.rowCount > 0;
}

// Create pending merchant from landing page signup (no Stripe yet)
async function createPendingMerchant(email) {
  const result = await pool.query(
    `INSERT INTO merchants (email, status, trial_started_at, trial_ends_at)
     VALUES ($1, 'pending', NOW(), NOW() + INTERVAL '14 days')
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING *`,
    [email.toLowerCase().trim()]
  );
  return result.rows[0];
}

// Get all pending merchants who haven't connected Stripe within window
async function getPendingMerchantsForFollowup(hoursSinceSignup = 24) {
  const result = await pool.query(
    `SELECT * FROM merchants
     WHERE status = 'pending'
       AND created_at < NOW() - INTERVAL '${hoursSinceSignup} hours'
       AND (followup_sent_at IS NULL OR followup_sent_at < created_at + INTERVAL '48 hours')
     ORDER BY created_at ASC
     LIMIT 50`,
    []
  );
  return result.rows;
}

// Get merchants who connected Stripe but haven't received their audit report
async function getConnectedMerchantsPendingAudit(limit = 20) {
  const result = await pool.query(
    `SELECT * FROM merchants
     WHERE status = 'connected'
       AND audit_report_sent_at IS NULL
     ORDER BY oauth_connected_at ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

// Mark welcome email sent
async function markWelcomeSent(merchantId) {
  await pool.query(
    `UPDATE merchants SET welcome_sent_at = NOW() WHERE id = $1`,
    [merchantId]
  );
}

// Mark follow-up email sent
async function markFollowupSent(merchantId) {
  await pool.query(
    `UPDATE merchants SET followup_sent_at = NOW() WHERE id = $1`,
    [merchantId]
  );
}

// Mark audit report sent and activate trial
async function activateTrial(merchantId, auditReportSent = true) {
  const now = new Date();
  const trialEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

  let statusVal = 'trial';
  if (auditReportSent) {
    statusVal = 'active';
  }

  const result = await pool.query(
    `UPDATE merchants
     SET status = $2,
         trial_started_at = $3,
         trial_ends_at = $4,
         audit_report_sent_at = CASE WHEN $5 THEN NOW() ELSE audit_report_sent_at END,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [merchantId, statusVal, now, trialEnd, auditReportSent]
  );
  return result.rows[0];
}

// Mark audit report sent (merchant already on trial)
async function markAuditReportSent(merchantId) {
  await pool.query(
    `UPDATE merchants
     SET audit_report_sent_at = NOW(), status = 'active'::merchant_status, updated_at = NOW()
     WHERE id = $1`,
    [merchantId]
  );
}

// Update oauth_connected_at timestamp
async function markOAuthConnected(merchantId) {
  await pool.query(
    `UPDATE merchants SET oauth_connected_at = NOW(), status = 'connected'::merchant_status WHERE id = $1`,
    [merchantId]
  );
}

// Get merchant by ID with token info
async function getMerchantWithToken(merchantId) {
  const result = await pool.query(
    `SELECT m.*, st.access_token, st.refresh_token, st.expires_at
     FROM merchants m
     LEFT JOIN stripe_tokens st ON st.merchant_id = m.id
     WHERE m.id = $1`,
    [merchantId]
  );
  return result.rows[0] || null;
}

// Billing — Stripe customer ID
async function setStripeCustomerId(merchantId, customerId) {
  await pool.query(
    `UPDATE merchants SET stripe_customer_id = $2, updated_at = NOW() WHERE id = $1`,
    [merchantId, customerId]
  );
}

// Billing — Stripe subscription ID
async function setStripeSubscriptionId(merchantId, subscriptionId) {
  await pool.query(
    `UPDATE merchants SET stripe_subscription_id = $2, updated_at = NOW() WHERE id = $1`,
    [merchantId, subscriptionId]
  );
}

// Billing — subscription status (none, trialing, active, past_due, canceled, unpaid)
async function setSubscriptionStatus(merchantId, status) {
  await pool.query(
    `UPDATE merchants SET subscription_status = $2, updated_at = NOW() WHERE id = $1`,
    [merchantId, status]
  );
}

// Lookup merchant by Stripe customer ID
async function getMerchantByStripeCustomerId(customerId) {
  const result = await pool.query(
    'SELECT * FROM merchants WHERE stripe_customer_id = $1',
    [customerId]
  );
  return result.rows[0] || null;
}

// Lookup merchant by Stripe subscription ID
async function getMerchantByStripeSubscriptionId(subscriptionId) {
  const result = await pool.query(
    'SELECT * FROM merchants WHERE stripe_subscription_id = $1',
    [subscriptionId]
  );
  return result.rows[0] || null;
}

// Get merchants due for Day 7 mid-trial check-in
// Run at day 7 (trial_started_at + 7 days), only if not already sent
async function getMerchantsForMidTrial(daysSinceStart = 7) {
  const result = await pool.query(
    `SELECT * FROM merchants
     WHERE status IN ('active', 'trial')
       AND trial_started_at IS NOT NULL
       AND mid_trial_sent_at IS NULL
       AND trial_started_at <= NOW() - INTERVAL '${daysSinceStart} days'
       AND (trial_ends_at IS NULL OR trial_ends_at > NOW())
       AND welcome_sent_at IS NOT NULL
     ORDER BY trial_started_at ASC
     LIMIT 50`
  );
  return result.rows;
}

// Get merchants due for Day 12 trial-ending-soon email
async function getMerchantsForTrialEndingSoon(daysBeforeEnd = 2) {
  const result = await pool.query(
    `SELECT * FROM merchants
     WHERE status IN ('active', 'trial')
       AND trial_ends_at IS NOT NULL
       AND trial_ending_sent_at IS NULL
       AND trial_ends_at <= NOW() + INTERVAL '${daysBeforeEnd} days'
       AND trial_ends_at > NOW()
     ORDER BY trial_ends_at ASC
     LIMIT 50`
  );
  return result.rows;
}

// Get merchants due for Day 14 trial conversion request
async function getMerchantsForConversionRequest() {
  const result = await pool.query(
    `SELECT * FROM merchants
     WHERE status IN ('active', 'trial')
       AND trial_ends_at IS NOT NULL
       AND trial_conversion_sent_at IS NULL
       AND trial_ends_at <= NOW()
       AND subscription_status IN ('none', 'trialing')
     ORDER BY trial_ends_at ASC
     LIMIT 50`
  );
  return result.rows;
}

// Mark mid-trial email sent
async function markMidTrialSent(merchantId) {
  await pool.query(
    `UPDATE merchants SET mid_trial_sent_at = NOW() WHERE id = $1`,
    [merchantId]
  );
}

// Mark trial ending email sent
async function markTrialEndingSent(merchantId) {
  await pool.query(
    `UPDATE merchants SET trial_ending_sent_at = NOW() WHERE id = $1`,
    [merchantId]
  );
}

// Mark trial conversion email sent
async function markConversionSent(merchantId) {
  await pool.query(
    `UPDATE merchants SET trial_conversion_sent_at = NOW() WHERE id = $1`,
    [merchantId]
  );
}

// Mark trial as expired — called on day 14 when trial ends with no paid subscription
async function markTrialExpired(merchantId) {
  const result = await pool.query(
    `UPDATE merchants
     SET status = 'expired'::merchant_status,
         trial_expired_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
       AND trial_ends_at <= NOW()
       AND subscription_status IN ('none', 'trialing')
     RETURNING id`,
    [merchantId]
  );
  return result.rowCount > 0; // true if this merchant was marked expired
}

// Update last signal snapshot and alert count for a merchant
async function updateSignalSnapshot(merchantId, signalSnapshot, alertCount) {
  await pool.query(
    `UPDATE merchants SET last_signal_snapshot = $2, alert_count = $3, updated_at = NOW() WHERE id = $1`,
    [merchantId, JSON.stringify(signalSnapshot), alertCount]
  );
}

// Get alert count for a merchant (unacknowledged alerts)
async function getAlertCount(merchantId) {
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM alerts WHERE merchant_id = $1 AND acknowledged = FALSE`,
    [merchantId]
  );
  return parseInt(result.rows[0].count, 10);
}

// ── Support escalation ────────────────────────────────────────────────────────

// Flag merchant for manual review (ban despite alert, urgent escalation)
async function flagForManualReview(merchantId, reason) {
  await pool.query(
    `UPDATE merchants
     SET manual_review_flag = TRUE,
         last_escalation_at = NOW(),
         support_ticket_id = COALESCE(support_ticket_id, $2),
         updated_at = NOW()
     WHERE id = $1`,
    [merchantId, `ESC-${Date.now()}`]
  );
  console.log(`[merchants] Flagged for manual review (${reason}): merchant ${merchantId}`);
}

// Log churn reason when merchant cancels
async function logChurnReason(merchantId, reason) {
  await pool.query(
    `UPDATE merchants
     SET churn_reason = $2,
         churned_at = NOW(),
         status = 'churned'::merchant_status,
         updated_at = NOW()
     WHERE id = $1`,
    [merchantId, reason]
  );
  console.log(`[merchants] Logged churn reason (${reason}): merchant ${merchantId}`);
}

// Mark thresholds as user-adjusted (after false positive report)
async function updateThresholdUserAdjusted(merchantId) {
  await pool.query(
    `UPDATE alerts
     SET user_adjusted_threshold = TRUE
     WHERE merchant_id = $1
       AND fired_at >= NOW() - INTERVAL '7 days'
       AND user_adjusted_threshold = FALSE
     ORDER BY fired_at DESC
     LIMIT 5`,
    [merchantId]
  );
}

// Get merchants flagged for manual review
async function getManualReviewMerchants() {
  const result = await pool.query(
    `SELECT m.*,
            sr.unresponded_count
     FROM merchants m
     LEFT JOIN (
       SELECT merchant_id, COUNT(*) as unresponded_count
       FROM support_replies
       WHERE response_sent_at IS NULL
       GROUP BY merchant_id
     ) sr ON sr.merchant_id = m.id
     WHERE m.manual_review_flag = TRUE
     ORDER BY m.last_escalation_at DESC NULLS LAST
     LIMIT 50`
  );
  return result.rows;
}

// Clear manual review flag and ticket
async function clearManualReviewFlag(merchantId) {
  await pool.query(
    `UPDATE merchants SET manual_review_flag = FALSE, support_ticket_id = NULL WHERE id = $1`,
    [merchantId]
  );
}

// Get all merchants with status = 'connected' (Stripe OAuth completed)
async function getConnectedMerchants() {
  const result = await pool.query(
    `SELECT m.id, m.email, m.stripe_account_id, m.status, m.oauth_connected_at,
            st.access_token, st.refresh_token, st.expires_at
     FROM merchants m
     LEFT JOIN stripe_tokens st ON st.merchant_id = m.id
     WHERE m.status = 'connected'::merchant_status
     ORDER BY m.oauth_connected_at DESC NULLS LAST`
  );
  return result.rows;
}

// Open a support ticket for a merchant
async function openSupportTicket(merchantId) {
  const ticketId = `TICKET-${Date.now()}`;
  await pool.query(
    `UPDATE merchants
     SET manual_review_flag = TRUE, support_ticket_id = $2,
         support_ticket_created_at = NOW(), last_escalation_at = NOW()
     WHERE id = $1`,
    [merchantId, ticketId]
  );
  return ticketId;
}

module.exports = {
  getOrCreateMerchant,
  getMerchantById,
  getMerchantByEmail,
  updateMerchantStripeAccount,
  setMerchantStatus,
  hasStripeToken,
  createAuditLead,
  createPendingMerchant,
  getPendingMerchantsForFollowup,
  getConnectedMerchantsPendingAudit,
  getConnectedMerchants,
  markWelcomeSent,
  markFollowupSent,
  activateTrial,
  markAuditReportSent,
  markOAuthConnected,
  getMerchantWithToken,
  // Billing
  setStripeCustomerId,
  setStripeSubscriptionId,
  setSubscriptionStatus,
  getMerchantByStripeCustomerId,
  getMerchantByStripeSubscriptionId,
  // Trial conversion
  getMerchantsForMidTrial,
  getMerchantsForTrialEndingSoon,
  getMerchantsForConversionRequest,
  markMidTrialSent,
  markTrialEndingSent,
  markConversionSent,
  markTrialExpired,
  updateSignalSnapshot,
  getAlertCount,
  // Support escalation
  flagForManualReview,
  logChurnReason,
  updateThresholdUserAdjusted,
  getManualReviewMerchants,
  clearManualReviewFlag,
  openSupportTicket,
};