/**
 * Email webhook — handles inbound emails to foundryiq@polsia.app (via Polsia email proxy).
 *
 * POST /api/webhook/email  — called by Polsia when a merchant replies to an alert email
 * GET  /api/webhook/inbox  — poll for unread emails (fallback)
 * GET  /api/support/escalations — list merchants flagged for manual review
 * POST /api/support/:id/escalate — flag/unflag a merchant
 *
 * Flow:
 * 1. Parse inbound email → classify scenario
 * 2. Log to support_replies table
 * 3. Build merchant context (signals, alerts, thresholds)
 * 4. Draft response via Polsia AI
 * 5. Send reply via Polsia email proxy (bypasses rate limit via reply_to_email_id)
 * 6. Execute follow-up action (mark false positive, flag manual review, log churn reason)
 */

const express = require('express');
const router = express.Router();

const { getMerchantByEmail, flagForManualReview, logChurnReason, updateThresholdUserAdjusted, clearManualReviewFlag, openSupportTicket } = require('../db/merchants');
const { saveSupportReply, markRepliedByEmailId, markFalsePositive } = require('../db/support-replies');
const { classifyScenario, buildMerchantContext, triageAndDraft } = require('../services/support');

const POLSIA_API_URL = process.env.POLSIA_API_URL || 'https://polsia.com/api/proxy/ai';
const POLSIA_API_KEY = process.env.POLSIA_API_KEY;

// ── POST /api/webhook/email ──────────────────────────────────────────────────

router.post('/email', async (req, res) => {
  const { from, subject, text_body, html_body, email_id } = req.body;

  if (!email_id || !from) {
    return res.status(400).json({ error: 'Missing email_id or from' });
  }

  const fromEmail = (from || '').trim().toLowerCase();
  const merchantEmail = extractEmail(fromEmail);

  console.log(`[email-webhook] Inbound from ${merchantEmail} — subject: ${subject} — id: ${email_id}`);

  if (!merchantEmail) {
    console.warn('[email-webhook] Could not extract email from From:', from);
    return res.status(200).json({ processed: false, reason: 'no_email_extracted' });
  }

  const merchant = await getMerchantByEmail(merchantEmail);
  if (!merchant) {
    console.warn('[email-webhook] No merchant for:', merchantEmail);
    return res.status(200).json({ processed: false, reason: 'merchant_not_found' });
  }

  const scenario = classifyScenario(text_body, subject);

  // Log inbound reply
  await saveSupportReply(merchant.id, String(email_id), fromEmail, subject, text_body || html_body || '', scenario);

  // Build context + draft response
  const merchantContext = await buildMerchantContext(merchantEmail);
  let responseData = null;
  try {
    responseData = await triageAndDraft({ text_body, subject }, merchantContext);
  } catch (err) {
    console.error('[email-webhook] AI triage error:', err.message);
  }

  const responseSubject = responseData?.responseSubject || `Re: ${subject}`;
  const responseBody = responseData?.responseBody || 'Thank you for reaching out. We will review and respond shortly.';
  const actionNeeded = responseData?.actionNeeded || 'none';

  // Send response via Polsia email proxy
  const sent = await sendSupportReply(merchantEmail, responseSubject, responseBody, email_id);
  if (sent) {
    await markRepliedByEmailId(email_id, scenario);
  }

  // Execute follow-up action
  await executeAction(actionNeeded, scenario, merchant, text_body);

  res.json({ processed: true, scenario, action: actionNeeded, email_id });
});

// ── Actions ──────────────────────────────────────────────────────────────────

async function executeAction(actionNeeded, scenario, merchant, textBody) {
  switch (actionNeeded) {
    case 'mark_false_positive':
    case 'mark_false_positive_and_adjust':
      await markFalsePositive(merchant.id);
      if (actionNeeded === 'mark_false_positive_and_adjust') {
        await updateThresholdUserAdjusted(merchant.id);
      }
      break;
    case 'flag_manual_review':
      await flagForManualReview(merchant.id, `Escalated via reply — scenario: ${scenario}`);
      break;
    case 'log_churn_reason':
      await logChurnReason(merchant.id, extractChurnReason(textBody));
      break;
    case 'confirm_helpful_48h':
      // Handled by follow-up cron job (future)
      break;
  }

  // ban_despite_alert always gets manual review flagged
  if (scenario === 'ban_despite_alert') {
    await flagForManualReview(merchant.id, 'Ban despite alert — support escalation');
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractEmail(from) {
  const match = from.match(/<([^>]+)>/) || from.match(/([^\/\n]+@[^\n]+)/);
  if (match) return match[1].trim().toLowerCase();
  if (from.includes('@')) return from.trim().toLowerCase();
  return null;
}

function extractChurnReason(textBody) {
  const c = (textBody || '').toLowerCase();
  if (/\b(too expensive|price|cost|expensive|pricing|$\b|monthly fee)/.test(c)) return 'price';
  if (/\b(not using|not needed|don't need|no longer|didn't use|rarely|never)/.test(c)) return 'not_using';
  if (/\b(stripe|banned|restricted|suspended)/.test(c)) return 'stripe_issue';
  if (/\b(switch|another|moved|alternative|different provider)/.test(c)) return 'switched_providers';
  if (/\b(bug|broken|doesn't work|not working|error|issue)/.test(c)) return 'product_issue';
  return 'other';
}

async function sendSupportReply(toEmail, subject, body, replyToEmailId) {
  const url = `${POLSIA_API_URL}/email/send`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${POLSIA_API_KEY}`,
      },
      body: JSON.stringify({
        to: toEmail,
        subject,
        body,
        reply_to_email_id: replyToEmailId,
      }),
    });
    if (!res.ok) {
      console.error('[email-webhook] Send failed:', res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('[email-webhook] Send error:', err.message);
    return false;
  }
}

// ── GET /api/webhook/inbox — poll for unread emails ──────────────────────────

router.get('/inbox', async (_req, res) => {
  if (!POLSIA_API_KEY) {
    return res.status(500).json({ error: 'POLSIA_API_KEY not configured' });
  }
  try {
    const inboxRes = await fetch(`${POLSIA_API_URL}/email/inbox`, {
      headers: { Authorization: `Bearer ${POLSIA_API_KEY}` },
    });
    if (!inboxRes.ok) {
      return res.status(500).json({ error: 'Failed to fetch inbox' });
    }
    const { emails } = await inboxRes.json();
    res.json({ inbox: emails || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/support/escalations — list flagged merchants ─────────────────────

router.get('/escalations', async (_req, res) => {
  const { getManualReviewMerchants } = require('../db/merchants');
  const escalations = await getManualReviewMerchants();
  res.json({ escalations });
});

// ── POST /api/support/:id/escalate — flag/unflag merchant ────────────────────

router.post('/:merchantId/escalate', async (req, res) => {
  const { merchantId } = req.params;
  const { reason, action } = req.body;
  const id = parseInt(merchantId, 10);

  const { setMerchantStatus } = require('../db/merchants');

  switch (action) {
    case 'flag_review':
      await flagForManualReview(id, reason || 'Manual flag via support panel');
      break;
    case 'unflag':
      await clearManualReviewFlag(id);
      break;
    case 'open_ticket':
      await openSupportTicket(id);
      break;
    case 'ban_despite_alert':
      await flagForManualReview(id, 'Ban despite alert — critical escalation');
      break;
    default:
      return res.status(400).json({ error: 'Invalid action' });
  }

  res.json({ success: true, merchantId: id, action });
});

module.exports = router;