/**
 * Support inbox cron — safety net for the email webhook.
 * Runs every 4 hours. Polls Polsia email inbox for any merchant replies that
 * weren't processed by the webhook (e.g., if webhook delivery failed).
 *
 * Polsia's email webhook fires reliably on inbound email, but this job exists
 * as a backup to ensure the 4-business-hour SLA is always met regardless.
 *
 * Declared in polsia.toml [[crons]].
 * Only runs when POLSIA_IN_PROCESS_CRONS_ENABLED === 'true' (Render-compatible).
 */

if (process.env.POLSIA_IN_PROCESS_CRONS_ENABLED !== 'true') {
  console.log('[support-inbox-cron] Skipping — POLSIA_IN_PROCESS_CRONS_ENABLED !== true');
  process.exit(0);
}

const POLSIA_API_URL = process.env.POLSIA_API_URL || 'https://polsia.com/api/proxy/ai';
const POLSIA_API_KEY = process.env.POLSIA_API_KEY;

if (!POLSIA_API_KEY) {
  console.error('[support-inbox-cron] POLSIA_API_KEY not set — exiting');
  process.exit(1);
}

require('../db/index'); // init pool singleton

const { getMerchantByEmail } = require('../db/merchants');
const { saveSupportReply, getUnrespondedReplies } = require('../db/support-replies');
const { classifyScenario, buildMerchantContext, triageAndDraft } = require('../services/support');
const { flagForManualReview } = require('../db/merchants');

async function main() {
  console.log('[support-inbox-cron] Running support inbox scan...');

  const inboxRes = await fetch(`${POLSIA_API_URL}/email/inbox`, {
    headers: { Authorization: `Bearer ${POLSIA_API_KEY}` },
  });

  if (!inboxRes.ok) {
    console.error('[support-inbox-cron] Failed to fetch inbox:', inboxRes.status);
    return;
  }

  const { emails } = await inboxRes.json();
  console.log(`[support-inbox-cron] Inbox has ${emails?.length || 0} messages`);

  if (!emails || emails.length === 0) return;

  let processed = 0;
  let skipped = 0;

  for (const email of emails) {
    const emailId = String(email.id || email.email_id || '').trim();
    const from = (email.from || '').trim().toLowerCase();
    const subject = email.subject || '';
    const textBody = email.text_body || email.body || '';
    const merchantEmail = extractEmail(from);

    if (!merchantEmail || !emailId) {
      skipped++;
      continue;
    }

    // Check if already processed via webhook
    const existing = await pool.query(
      `SELECT 1 FROM support_replies WHERE email_id = $1 LIMIT 1`,
      [emailId]
    ).catch(() => ({ rows: [] }));

    if (existing.rows.length > 0) {
      // Already processed — skip
      skipped++;
      continue;
    }

    const merchant = await getMerchantByEmail(merchantEmail);
    if (!merchant) {
      console.log(`[support-inbox-cron] No merchant for ${merchantEmail} — skipping`);
      skipped++;
      continue;
    }

    const scenario = classifyScenario(textBody, subject);
    console.log(`[support-inbox-cron] Processing: ${merchantEmail} (${scenario})`);

    // Log it
    await saveSupportReply(merchant.id, emailId, from, subject, textBody, scenario);

    // Build context + draft
    const ctx = await buildMerchantContext(merchantEmail);
    let responseData = null;
    try {
      responseData = await triageAndDraft({ text_body: textBody, subject }, ctx);
    } catch (err) {
      console.error('[support-inbox-cron] AI triage error:', err.message);
    }

    const responseSubject = responseData?.responseSubject || `Re: ${subject}`;
    const responseBody = responseData?.responseBody || 'Thank you for reaching out. We will review and respond shortly.';

    // Send reply via Polsia email proxy
    const sent = await sendReply(merchantEmail, responseSubject, responseBody, emailId);
    if (sent) {
      const { markRepliedByEmailId } = require('../db/support-replies');
      await markRepliedByEmailId(emailId, scenario);
    }

    // Flag ban scenarios for manual review
    if (scenario === 'ban_despite_alert') {
      await flagForManualReview(merchant.id, 'Ban despite alert — inbox scan recovery');
    }

    processed++;
  }

  console.log(`[support-inbox-cron] Done — processed: ${processed}, skipped: ${skipped}`);
}

function extractEmail(from) {
  const match = from.match(/<([^>]+)>/) || from.match(/([^\/\n]+@[^\n]+)/);
  if (match) return match[1].trim().toLowerCase();
  if (from.includes('@')) return from.trim().toLowerCase();
  return null;
}

async function sendReply(toEmail, subject, body, replyToEmailId) {
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
      console.error('[support-inbox-cron] Send failed:', res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[support-inbox-cron] Send error:', err.message);
    return false;
  }
}

main().catch(err => {
  console.error('[support-inbox-cron] Fatal error:', err.message);
  process.exit(1);
});