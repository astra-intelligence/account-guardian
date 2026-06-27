/**
 * Support service — triages inbound merchant replies to alert emails.
 * Uses Polsia AI API to classify scenario and select response.
 * Owns: scenario detection, AI triage, response selection.
 * Does NOT own: email sending (routes/email-webhook.js handles that via Polsia proxy).
 */

const { getMerchantByEmail } = require('../db/merchants');
const { getLatestSignals, getThresholds, getAlerts } = require('../db/signals');

const POLSIA_API_URL = process.env.POLSIA_API_URL || 'https://polsia.com/api/proxy/ai';
const POLSIA_API_KEY = process.env.POLSIA_API_KEY;

// Classify the scenario from email content
function classifyScenario(textBody, subject) {
  const content = (textBody || '').toLowerCase();

  // False positive: merchant says alert was wrong
  if (
    /false positive|not true|is normal|looks fine|looks good|looks ok|misleading|inaccurate/.test(content) ||
    /alert was wrong|wrong alert|alert is incorrect|seems fine/.test(content) ||
    /my dispute rate|my chargeback rate|my refund rate/.test(content)
  ) {
    return 'false_positive';
  }

  // Ban despite alert: merchant account banned despite receiving alert
  if (
    /banned|restricted|suspended|account banned|account restricted|account suspended|stripe banned|stripe restricted|stripe suspended/.test(content) ||
    /stripe (shut down|disabled|closed|terminated)/.test(content)
  ) {
    return 'ban_despite_alert';
  }

  // How do I fix: questions about improving signal values
  if (
    /how do i|how can i|how to fix|what can i do|help me fix|fix this/.test(content) ||
    /lower my|reduce my|improve my|address my/.test(content) ||
    /fix (dispute|chargeback|refund|auth)/.test(content)
  ) {
    return 'how_to_fix';
  }

  // Cancellation intent
  if (
    /cancel|unsubscribe|stop monitoring|stop service|no longer need|no longer want|remove account|delete account|don't want|leaving|deactivate/.test(content)
  ) {
    return 'cancellation';
  }

  return 'general';
}

// Build context for AI to write a response
async function buildMerchantContext(merchantEmail) {
  const merchant = await getMerchantByEmail(merchantEmail);
  if (!merchant) return null;

  const connected = merchant.stripe_account_id != null;
  let signals = [];
  let thresholds = [];
  let recentAlerts = [];

  if (connected) {
    [signals, recentAlerts, thresholds] = await Promise.all([
      getLatestSignals(merchant.id),
      getAlerts(merchant.id, { filter: 'this_month', limit: 5 }),
      getThresholds(merchant.id),
    ]);
  }

  // Build signal summary
  const signalSummary = signals.length > 0
    ? signals.map(s => `${s.signal_type}: ${parseFloat(s.value).toFixed(4)} (threshold: ?)`).join('\n')
    : 'No signals captured yet.';

  const alertSummary = recentAlerts.length > 0
    ? recentAlerts.map(a => `${a.signal_type} fired on ${a.fired_at} — acknowledged: ${a.acknowledged}`).join('\n')
    : 'No recent alerts.';

  return {
    merchantName: merchant.name || merchant.email.split('@')[0],
    merchantEmail: merchant.email,
    merchantId: merchant.id,
    status: merchant.status,
    connected,
    signalSummary,
    alertSummary,
    thresholdCalibrated: thresholds.length > 0,
  };
}

// Use Polsia AI to classify and draft response
async function triageAndDraft(inboundEmail, merchantContext) {
  const { text_body, subject } = inboundEmail;
  const scenario = classifyScenario(text_body, subject);

  const prompt = `
You are Account Guardian's support triage system. A merchant replied to an alert email. Your job is to:
1. Classify the scenario (one of: false_positive, ban_despite_alert, how_to_fix, cancellation, general)
2. Draft a helpful, professional email response

CLASSIFICATION: ${scenario}

MERCHANT CONTEXT:
- Name: ${merchantContext.merchantName}
- Email: ${merchantContext.merchantEmail}
- Account status: ${merchantContext.status}
- Connected to Stripe: ${merchantContext.connected}
- Recent signals:
${merchantContext.signalSummary}
- Recent alerts:
${merchantContext.alertSummary}
- Thresholds calibrated from baseline: ${merchantContext.thresholdCalibrated}

INBOUND EMAIL:
Subject: ${subject}
Body: ${text_body || '(no body)'}

Your task:
- Classify: confirm the scenario as one of: false_positive, ban_despite_alert, how_to_fix, cancellation, general
- Draft a response using the correct template from /docs/support-templates.md (use the scenario-specific template)
- Make the response specific to this merchant — reference their actual signal values where relevant
- Keep it under 300 words, friendly but not sycophantic
- End with "Reply to this email if you need more help." or similar

Return your response as JSON:
{
  "scenario": "...",
  "response_subject": "...",
  "response_body": "...",
  "action_needed": "none | mark_false_positive | flag_manual_review | log_churn_reason | confirm_helpful_48h"
}
`;

  try {
    const res = await fetch(`${POLSIA_API_URL}/agent/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${POLSIA_API_KEY}`,
      },
      body: JSON.stringify({ prompt }),
    });

    if (!res.ok) {
      console.error('[support] AI triage failed:', res.status);
      return null;
    }

    const { output } = await res.json();
    // Parse JSON from AI output
    try {
      const parsed = JSON.parse(output);
      return {
        scenario,
        responseSubject: parsed.response_subject || getDefaultSubject(scenario),
        responseBody: parsed.response_body || getFallbackResponse(scenario, merchantContext),
        actionNeeded: parsed.action_needed || 'none',
      };
    } catch {
      // Fallback: parse from raw output
      return {
        scenario,
        responseSubject: getDefaultSubject(scenario),
        responseBody: getFallbackResponse(scenario, merchantContext),
        actionNeeded: 'none',
      };
    }
  } catch (err) {
    console.error('[support] AI triage error:', err.message);
    return null;
  }
}

function getDefaultSubject(scenario) {
  const subjects = {
    false_positive: 'Re: Your Account Guardian alert — thank you for the feedback',
    ban_despite_alert: 'Re: Account Guardian — we can help',
    how_to_fix: 'Re: How to improve your Stripe account health',
    cancellation: 'Re: Leaving Account Guardian',
    general: 'Re: Account Guardian',
  };
  return subjects[scenario] || subjects.general;
}

function getFallbackResponse(scenario, ctx) {
  const templates = {
    false_positive: `Hi ${ctx.merchantName},\n\nThanks for getting in touch. We take false positives seriously — they're how we improve.\n\nYour thresholds were calibrated from your actual Stripe history, so they reflect your normal baseline rather than industry averages. If you'd like us to review or adjust them, just reply and let us know what you're seeing on your account.\n\nWe're also logging this as feedback to improve our calibration.\n\nReply if you need more help.\n`,
    ban_despite_alert: `Hi ${ctx.merchantName},\n\nI'm sorry to hear Stripe restricted your account — and I'm glad we reached you in time to help.\n\nWe can help you build a stronger appeal to Stripe. Reply to this email and our team will walk you through the fastest path to getting your account restored.\n\nReply here and we'll be in touch within a few hours.\n`,
    how_to_fix: `Hi ${ctx.merchantName},\n\nHere's the fastest path to improving your account health:\n\n**Dispute Rate**: Respond to every dispute within the deadline. For fraud disputes, Stripe Radar rules can help pre-screen high-risk transactions.\n\n**Auth Rate**: Review your decline codes in the Stripe dashboard. Enable automatic card updating to refresh expired cards.\n\n**Revenue Drop**: Check for an "account under review" banner. Respond to any open review inquiry promptly.\n\nReply if you need more specific guidance.\n`,
    cancellation: `Hi ${ctx.merchantName},\n\nBefore you go — can I ask what prompted this? If there's something we can fix, we'd genuinely like the chance to.\n\n(And if it's a billing concern, we can talk about that too.)\n\nReply and let us know what's driving this.\n`,
    general: `Hi ${ctx.merchantName},\n\nThanks for reaching out. I've reviewed your account and I'm responding as quickly as possible.\n\nIf you need immediate help, reply with the details and we'll get back to you within a few hours.\n\nReply if you need more help.\n`,
  };
  return templates[scenario] || templates.general;
}

module.exports = {
  classifyScenario,
  buildMerchantContext,
  triageAndDraft,
  getDefaultSubject,
  getFallbackResponse,
};