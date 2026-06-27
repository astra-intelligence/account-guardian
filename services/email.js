/**
 * Email service — Postmark transactional email.
 * Handles Account Guardian outbound emails.
 */

const axios = require('axios');

const POSTMARK_API_URL = 'https://api.postmarkapp.com/email';
const FROM_EMAIL = process.env.APP_EMAIL || 'Account Guardian <hello@foundryiq.app>';

// Thresholds used for audit report comparison
const SIGNAL_THRESHOLDS = {
  dispute_rate: 0.005,     // 0.5% — Stripe review trigger
  refund_rate: 0.08,       // 8% — elevated
  chargeback_rate: 0.003,  // 0.3% — chargeback threshold
};

/**
 * Send audit confirmation email — immediate receipt after form submission.
 */
async function sendAuditConfirmation(toEmail, merchantId) {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: 'Helvetica Neue', Arial, sans-serif; background: #0A0A0F; color: #E8E8F0; margin: 0; padding: 0; }
    .wrapper { max-width: 560px; margin: 0 auto; padding: 48px 24px; }
    .header { border-bottom: 1px solid rgba(255,255,255,0.07); padding-bottom: 32px; margin-bottom: 32px; }
    .logo { font-family: 'Courier New', monospace; font-size: 14px; font-weight: bold; letter-spacing: 0.08em; }
    .logo span { color: #00E5FF; }
    h1 { font-size: 24px; font-weight: 700; margin: 0 0 16px; line-height: 1.3; }
    p { font-size: 15px; line-height: 1.7; color: #6B6B80; margin: 0 0 20px; }
    .highlight { color: #E8E8F0; font-weight: 600; }
    .checklist { list-style: none; padding: 0; margin: 0 0 32px; }
    .checklist li { padding: 12px 0; border-bottom: 1px solid rgba(255,255,255,0.07); font-size: 14px; color: #6B6B80; display: flex; align-items: center; gap: 12px; }
    .checklist li::before { content: '✓'; color: #00E5FF; font-weight: bold; }
    .cta { display: inline-block; background: #00E5FF; color: #0A0A0F; font-size: 14px; font-weight: 700; padding: 14px 28px; border-radius: 4px; text-decoration: none; }
    .footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid rgba(255,255,255,0.07); font-size: 11px; color: #6B6B80; font-family: 'Courier New', monospace; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="logo">ACCOUNT<span>GUARDIAN</span></div>
    </div>
    <h1>We're starting your Stripe Account Audit.</h1>
    <p>Your request is in queue. We'll analyze your account signals and send you a full report <span class="highlight">within a few minutes</span>.</p>
    <ul class="checklist">
      <li>Your dispute rate vs. Stripe's review threshold</li>
      <li>Your refund rate trend over the last 30 days</li>
      <li>Active risk flags on your account</li>
      <li>Specific recommended action if you're in the danger zone</li>
    </ul>
    <p>Once you have your audit results, you'll know exactly where you stand — and whether Account Guardian is worth it.</p>
    <a href="${process.env.APP_URL || 'https://foundryiq-3.polsia.app'}" class="cta">Visit Account Guardian →</a>
    <div class="footer">
      Account Guardian by Astramedia · Monitoring Stripe accounts so you don't get surprised<br>
      Questions? Reply to this email.
    </div>
  </div>
</body>
</html>
  `;

  await sendPostmark(toEmail, 'We received your audit request — your report is on its way', html);
}

/**
 * Send the full audit report email to a lead.
 * Called manually or via cron once signals are available.
 */
async function sendAuditReport(toEmail, signals) {
  const verdict = computeVerdict(signals);
  const thresholds = SIGNAL_THRESHOLDS;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: 'Helvetica Neue', Arial, sans-serif; background: #0A0A0F; color: #E8E8F0; margin: 0; padding: 0; }
    .wrapper { max-width: 560px; margin: 0 auto; padding: 48px 24px; }
    .header { border-bottom: 1px solid rgba(255,255,255,0.07); padding-bottom: 32px; margin-bottom: 32px; }
    .logo { font-family: 'Courier New', monospace; font-size: 14px; font-weight: bold; letter-spacing: 0.08em; }
    .logo span { color: #00E5FF; }
    h1 { font-size: 24px; font-weight: 700; margin: 0 0 8px; line-height: 1.3; }
    .verdict { font-family: 'Courier New', monospace; font-size: 11px; letter-spacing: 0.1em; padding: 8px 14px; border-radius: 2px; display: inline-block; margin-bottom: 24px; }
    .verdict-low { background: rgba(180,255,0,0.12); color: #B4FF00; }
    .verdict-moderate { background: rgba(255,200,0,0.12); color: #FFC800; }
    .verdict-high { background: rgba(255,59,92,0.12); color: #FF3B5C; }
    p { font-size: 15px; line-height: 1.7; color: #6B6B80; margin: 0 0 20px; }
    .highlight { color: #E8E8F0; font-weight: 600; }
    .signal-table { width: 100%; border-collapse: collapse; margin: 0 0 32px; font-size: 14px; }
    .signal-table th { font-family: 'Courier New', monospace; font-size: 10px; letter-spacing: 0.12em; color: #6B6B80; text-align: left; padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.07); }
    .signal-table td { padding: 14px 12px; border-bottom: 1px solid rgba(255,255,255,0.07); color: #E8E8F0; }
    .signal-table td:last-child { text-align: right; font-family: 'Courier New', monospace; }
    .threshold { color: #6B6B80; font-size: 12px; }
    .action-box { background: #111118; border: 1px solid rgba(0,229,255,0.3); border-radius: 8px; padding: 28px; margin: 0 0 32px; }
    .action-box h2 { font-size: 16px; font-weight: 700; margin: 0 0 12px; color: #00E5FF; }
    .action-box p { margin: 0; }
    .cta { display: inline-block; background: #00E5FF; color: #0A0A0F; font-size: 14px; font-weight: 700; padding: 14px 28px; border-radius: 4px; text-decoration: none; }
    .footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid rgba(255,255,255,0.07); font-size: 11px; color: #6B6B80; font-family: 'Courier New', monospace; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="logo">ACCOUNT<span>GUARDIAN</span></div>
    </div>
    <h1>Your Stripe Account Audit Results</h1>
    <div class="verdict ${verdict.cssClass}">${verdict.label}</div>
    <p>Here's what we found analyzing your account signals.</p>

    <table class="signal-table">
      <thead>
        <tr>
          <th>SIGNAL</th>
          <th>YOUR VALUE</th>
          <th>STRIPE THRESHOLD</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Dispute Rate</td>
          <td style="color:${signals.dispute_rate > thresholds.dispute_rate ? '#FF3B5C' : '#B4FF00'}">${formatPct(signals.dispute_rate)}</td>
          <td class="threshold">${formatPct(thresholds.dispute_rate)}</td>
        </tr>
        <tr>
          <td>Refund Rate</td>
          <td style="color:${signals.refund_rate > thresholds.refund_rate ? '#FF3B5C' : '#B4FF00'}">${formatPct(signals.refund_rate)}</td>
          <td class="threshold">${formatPct(thresholds.refund_rate)}</td>
        </tr>
        <tr>
          <td>Chargeback Rate</td>
          <td style="color:${signals.chargeback_rate > thresholds.chargeback_rate ? '#FF3B5C' : '#B4FF00'}">${formatPct(signals.chargeback_rate)}</td>
          <td class="threshold">${formatPct(thresholds.chargeback_rate)}</td>
        </tr>
      </tbody>
    </table>

    <div class="action-box">
      <h2>${verdict.actionTitle}</h2>
      <p>${verdict.actionBody}</p>
    </div>

    <p>Start your <span class="highlight">14-day free trial</span> and get daily monitoring — so Stripe's next move never catches you off guard.</p>
    <a href="${process.env.APP_URL || 'https://foundryiq-3.polsia.app'}/dashboard" class="cta">Start Free Trial →</a>
    <div class="footer">
      Account Guardian by Astramedia · Monitoring Stripe accounts so you don't get surprised<br>
      Questions? Reply to this email.
    </div>
  </div>
</body>
</html>
  `;

  const subject = `Your Stripe Account Audit Results${verdict.subjectSuffix}`;
  await sendPostmark(toEmail, subject, html);
}

// ── helpers ────────────────────────────────────────────────────────────────

function computeVerdict(signals) {
  const thresholds = SIGNAL_THRESHOLDS;
  const riskCount = [
    signals.dispute_rate > thresholds.dispute_rate,
    signals.refund_rate > thresholds.refund_rate,
    signals.chargeback_rate > thresholds.chargeback_rate,
  ].filter(Boolean).length;

  if (riskCount === 0) {
    return {
      label: 'LOW RISK',
      cssClass: 'verdict-low',
      subjectSuffix: ' — Looking Good',
      actionTitle: 'Recommended: Keep monitoring',
      actionBody: 'Your signals are within safe ranges. But rates can shift — keep watching your dispute and refund rates closely.',
    };
  } else if (riskCount === 1) {
    return {
      label: 'MODERATE RISK',
      cssClass: 'verdict-moderate',
      subjectSuffix: ' — Heads Up',
      actionTitle: 'Recommended: Review your account now',
      actionBody: `One of your signals is elevated. If it crosses Stripe's threshold, your account could be reviewed without warning.`,
    };
  } else {
    return {
      label: 'ACCOUNT SHOWING WARNING SIGNS',
      cssClass: 'verdict-high',
      subjectSuffix: ' — Action Required',
      actionTitle: 'Recommended: Act now',
      actionBody: `Multiple signals are elevated. Stripe may be watching your account right now. This is the time to get protected.`,
    };
  }
}

function formatPct(value) {
  if (value === null || value === undefined || value === 0) return '0%';
  return `${(value * 100).toFixed(2)}%`;
}

async function sendPostmark(toEmail, subject, htmlBody) {
  const apiKey = process.env.POSTMARK_SERVER_TOKEN;
  if (!apiKey) {
    console.warn('[email] POSTMARK_SERVER_TOKEN not set — skipping email to', toEmail);
    return;
  }

  try {
    await axios.post(
      POSTMARK_API_URL,
      {
        From: FROM_EMAIL,
        To: toEmail,
        Subject: subject,
        HtmlBody: htmlBody,
        MessageStream: 'outbound',
      },
      {
        headers: {
          'X-Postmark-Account-API-Token': apiKey,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('[email] Sent to', toEmail, '—', subject);
  } catch (err) {
    console.error('[email] Failed to send to', toEmail, err.message);
  }
}

// ── Email styles (shared across all emails) ─────────────────────────────────
const EMAIL_STYLE = `
  body { font-family: 'Helvetica Neue', Arial, sans-serif; background: #0A0A0F; color: #E8E8F0; margin: 0; padding: 0; }
  .wrapper { max-width: 560px; margin: 0 auto; padding: 48px 24px; }
  .header { border-bottom: 1px solid rgba(255,255,255,0.07); padding-bottom: 32px; margin-bottom: 32px; }
  .logo { font-family: 'Courier New', monospace; font-size: 14px; font-weight: bold; letter-spacing: 0.08em; }
  .logo span { color: #00E5FF; }
  h1 { font-size: 24px; font-weight: 700; margin: 0 0 16px; line-height: 1.3; }
  p { font-size: 15px; line-height: 1.7; color: #6B6B80; margin: 0 0 20px; }
  .highlight { color: #E8E8F0; font-weight: 600; }
  .checklist { list-style: none; padding: 0; margin: 0 0 32px; }
  .checklist li { padding: 12px 0; border-bottom: 1px solid rgba(255,255,255,0.07); font-size: 14px; color: #6B6B80; display: flex; align-items: center; gap: 12px; }
  .checklist li::before { content: '✓'; color: #00E5FF; font-weight: bold; }
  .cta { display: inline-block; background: #00E5FF; color: #0A0A0F; font-size: 14px; font-weight: 700; padding: 14px 28px; border-radius: 4px; text-decoration: none; }
  .footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid rgba(255,255,255,0.07); font-size: 11px; color: #6B6B80; font-family: 'Courier New', monospace; }
  .verdict { font-family: 'Courier New', monospace; font-size: 11px; letter-spacing: 0.1em; padding: 8px 14px; border-radius: 2px; display: inline-block; margin-bottom: 24px; }
  .verdict-low { background: rgba(180,255,0,0.12); color: #B4FF00; }
  .verdict-moderate { background: rgba(255,200,0,0.12); color: #FFC800; }
  .verdict-high { background: rgba(255,59,92,0.12); color: #FF3B5C; }
  .signal-table { width: 100%; border-collapse: collapse; margin: 0 0 32px; font-size: 14px; }
  .signal-table th { font-family: 'Courier New', monospace; font-size: 10px; letter-spacing: 0.12em; color: #6B6B80; text-align: left; padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.07); }
  .signal-table td { padding: 14px 12px; border-bottom: 1px solid rgba(255,255,255,0.07); color: #E8E8F0; }
  .signal-table td:last-child { text-align: right; font-family: 'Courier New', monospace; }
  .threshold { color: #6B6B80; font-size: 12px; }
  .action-box { background: #111118; border: 1px solid rgba(0,229,255,0.3); border-radius: 8px; padding: 28px; margin: 0 0 32px; }
  .action-box h2 { font-size: 16px; font-weight: 700; margin: 0 0 12px; color: #00E5FF; }
  .action-box p { margin: 0; }
  .trust-row { display: flex; gap: 16px; margin: 24px 0; }
  .trust-item { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 4px; padding: 16px; flex: 1; }
  .trust-item p { margin: 0; font-size: 13px; }
  .trial-badge { background: rgba(180,255,0,0.12); color: #B4FF00; font-family: 'Courier New', monospace; font-size: 11px; font-weight: bold; padding: 6px 12px; border-radius: 2px; display: inline-block; margin-bottom: 16px; }
`;

function emailHeader() {
  return `<div class="header"><div class="logo">ACCOUNT<span>GUARDIAN</span></div></div>`;
}

function emailFooter() {
  return `<div class="footer">Account Guardian by Astramedia · Monitoring Stripe accounts so you don't get surprised<br>Questions? Reply to this email.</div>`;
}

/**
 * Send welcome email — immediate after landing page signup.
 * CTA: connect Stripe to get the free audit.
 */
async function sendWelcomeEmail(toEmail, merchantId) {
  const connectUrl = `${process.env.APP_URL || 'https://foundryiq-3.polsia.app'}/auth/stripe?email=${encodeURIComponent(toEmail)}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>${EMAIL_STYLE}</style>
</head>
<body>
  <div class="wrapper">
    ${emailHeader()}
    <h1>Here's how to connect Stripe and get your free audit in 2 minutes.</h1>
    <p>You've claimed your free Stripe Account Audit. Here's what to do next:</p>
    <ul class="checklist">
      <li>Click the button below — you'll be taken to Stripe to authorize read-only access</li>
      <li>We read your account signals (dispute rate, refund rate, risk flags)</li>
      <li>We send you a plain-English audit report within minutes</li>
      <li>Your 14-day free trial starts automatically after the audit</li>
    </ul>
    <p style="color:#E8E8F0;font-size:15px;line-height:1.7;margin:0 0 20px;">
      <strong>No credit card required.</strong> We just read your data — we can't change anything on your account.
    </p>
    <a href="${connectUrl}" class="cta">Connect Stripe &amp; Get My Free Audit →</a>
    <div class="trust-row">
      <div class="trust-item">
        <p><strong>🔒 Read-only access</strong><br>We can only read your Stripe data. We can't modify anything.</p>
      </div>
      <div class="trust-item">
        <p><strong>⏱ 2 minutes to connect</strong><br>One click on Stripe. Then you're done — we handle the rest.</p>
      </div>
    </div>
    ${emailFooter()}
  </div>
</body>
</html>
  `;

  await sendPostmark(toEmail, 'Your free Stripe audit — here is how to get it in 2 minutes', html);
}

/**
 * Send 24h follow-up email to merchants who haven't connected Stripe yet.
 * Friction-reduction tips included.
 */
async function sendFollowupEmail(toEmail) {
  const connectUrl = `${process.env.APP_URL || 'https://foundryiq-3.polsia.app'}/auth/stripe?email=${encodeURIComponent(toEmail)}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>${EMAIL_STYLE}</style>
</head>
<body>
  <div class="wrapper">
    ${emailHeader()}
    <h1>We still have your free Stripe audit ready.</h1>
    <p>You signed up a couple of days ago for a free Stripe account audit. We haven't heard from your Stripe account yet — so the audit hasn't been generated.</p>
    <p style="color:#E8E8F0;font-weight:600;">No credit card required. We just read your data — we can't change anything.</p>
    <ul class="checklist">
      <li><strong>No credit card</strong> — We never ask for payment info during the free audit</li>
      <li><strong>Read-only</strong> — Stripe's OAuth only lets us read data. We can't touch anything</li>
      <li><strong>2 minutes</strong> — One click on Stripe to authorize. Then we do the analysis</li>
    </ul>
    <p>Here's the report format you'll get:</p>
    <ul class="checklist">
      <li>Your dispute rate vs. Stripe's review threshold</li>
      <li>Your refund rate trend over the last 30 days</li>
      <li>Whether your account is in the danger zone</li>
      <li>Specific recommended actions</li>
    </ul>
    <a href="${connectUrl}" class="cta">Connect Stripe &amp; Get My Free Audit →</a>
    <p style="font-size:13px;margin-top:20px;">If you've changed your mind, no hard feelings — just ignore this email. If you have any questions, just reply and we'll help.</p>
    ${emailFooter()}
  </div>
</body>
</html>
  `;

  await sendPostmark(toEmail, "Your free Stripe audit — still here when you're ready", html);
}

/**
 * Send trial confirmation email after audit report delivered.
 * Includes a summary of what was found.
 */
async function sendTrialConfirmation(toEmail, trialEndDate, signals) {
  const verdict = computeVerdict(signals);
  const dashboardUrl = `${process.env.APP_URL || 'https://foundryiq-3.polsia.app'}/dashboard`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>${EMAIL_STYLE}</style>
</head>
<body>
  <div class="wrapper">
    ${emailHeader()}
    <div class="trial-badge">✓ TRIAL ACTIVE</div>
    <h1>Your Account Guardian trial starts now.</h1>
    <p>We'll watch your Stripe account for <strong>14 days</strong>. Here's what we found on your account:</p>

    <div class="verdict ${verdict.cssClass}" style="margin-bottom:16px;">${verdict.label}</div>

    <table class="signal-table">
      <thead>
        <tr>
          <th>SIGNAL</th>
          <th>YOUR VALUE</th>
          <th>STRIPE THRESHOLD</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Dispute Rate</td>
          <td style="color:${signals.dispute_rate > 0.005 ? '#FF3B5C' : '#B4FF00'}">${formatPct(signals.dispute_rate)}</td>
          <td class="threshold">0.50%</td>
        </tr>
        <tr>
          <td>Refund Rate</td>
          <td style="color:${signals.refund_rate > 0.08 ? '#FF3B5C' : '#B4FF00'}">${formatPct(signals.refund_rate)}</td>
          <td class="threshold">8.00%</td>
        </tr>
        <tr>
          <td>Chargeback Rate</td>
          <td style="color:${signals.chargeback_rate > 0.003 ? '#FF3B5C' : '#B4FF00'}">${formatPct(signals.chargeback_rate)}</td>
          <td class="threshold">0.30%</td>
        </tr>
      </tbody>
    </table>

    <div class="action-box">
      <h2>${verdict.actionTitle}</h2>
      <p>${verdict.actionBody}</p>
    </div>

    <p>Your trial runs until <strong>${trialEndDate}</strong>. No charge until then.</p>
    <p>During your trial, we'll send you an alert the moment any of your signals cross a threshold — so you can act before Stripe does.</p>
    <a href="${dashboardUrl}" class="cta">Go to Your Dashboard →</a>
    <p style="font-size:12px;margin-top:24px;color:#6B6B80;">
      Questions? Reply to this email. To cancel before the trial ends, visit your dashboard settings. You'll never be charged without your explicit consent.
    </p>
    ${emailFooter()}
  </div>
</body>
</html>
  `;

  await sendPostmark(toEmail, `Your Account Guardian trial is active — here's what we found`, html);
}

/**
 * Send mid-trial check-in — Day 7 of the trial.
 * Shows signal summary if connected, else reminds to connect.
 * Reminds them trial continues at $79/month.
 */
async function sendMidTrialCheckIn(toEmail, daysLeft, isConnected, signalSnapshot, dashboardUrl) {
  const connectUrl = `${process.env.APP_URL || 'https://foundryiq-3.polsia.app'}/auth/stripe?email=${encodeURIComponent(toEmail)}`;
  const verdict = signalSnapshot ? computeVerdict(signalSnapshot) : null;

  let statusBlock = '';
  if (isConnected && signalSnapshot) {
    statusBlock = `
    <div class="verdict ${verdict.cssClass}" style="margin-bottom:16px;">${verdict.label}</div>
    <table class="signal-table">
      <thead>
        <tr>
          <th>SIGNAL</th>
          <th>YOUR VALUE</th>
          <th>STRIPE THRESHOLD</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Dispute Rate</td>
          <td style="color:${signalSnapshot.dispute_rate > 0.005 ? '#FF3B5C' : '#B4FF00'}">${formatPct(signalSnapshot.dispute_rate)}</td>
          <td class="threshold">0.50%</td>
        </tr>
        <tr>
          <td>Refund Rate</td>
          <td style="color:${signalSnapshot.refund_rate > 0.08 ? '#FF3B5C' : '#B4FF00'}">${formatPct(signalSnapshot.refund_rate)}</td>
          <td class="threshold">8.00%</td>
        </tr>
        <tr>
          <td>Chargeback Rate</td>
          <td style="color:${signalSnapshot.chargeback_rate > 0.003 ? '#FF3B5C' : '#B4FF00'}">${formatPct(signalSnapshot.chargeback_rate)}</td>
          <td class="threshold">0.30%</td>
        </tr>
      </tbody>
    </table>
    <p style="font-size:13px;color:#6B6B80;">We'll alert you the moment any of these cross their thresholds.</p>
    `;
  } else {
    statusBlock = `
    <div class="action-box" style="border-color:rgba(255,200,0,0.3);">
      <h2>No alerts yet</h2>
      <p>Connect your Stripe account and we'll analyze your signals and start monitoring.</p>
    </div>
    `;
  }

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>${EMAIL_STYLE}</style>
</head>
<body>
  <div class="wrapper">
    ${emailHeader()}
    <div class="trial-badge">${daysLeft} DAYS LEFT IN TRIAL</div>
    <h1>You're halfway through your Account Guardian trial.</h1>
    <p>Here's a quick snapshot of your Stripe account:</p>
    ${statusBlock}
    <p>When your trial ends, your account health monitoring continues at <strong>$79/month</strong> — no surprise charges.</p>
    ${isConnected
      ? `<a href="${dashboardUrl}" class="cta">View Your Dashboard →</a>`
      : `<a href="${connectUrl}" class="cta">Connect Stripe &amp; Get My Free Audit →</a>`
    }
    ${emailFooter()}
  </div>
</body>
</html>
  `;

  await sendPostmark(toEmail, `You're halfway through your trial — ${daysLeft} days left`, html);
}

/**
 * Send trial ending soon — Day 12 (48 hours remaining).
 * Reminds of features, provides cancel or continue CTA.
 */
async function sendTrialEndingSoon(toEmail, trialEndDate) {
  const dashboardUrl = `${process.env.APP_URL || 'https://foundryiq-3.polsia.app'}/dashboard`;
  const cancelUrl = `${process.env.APP_URL || 'https://foundryiq-3.polsia.app'}/billing/cancel`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>${EMAIL_STYLE}</style>
</head>
<body>
  <div class="wrapper">
    ${emailHeader()}
    <div class="trial-badge" style="background:rgba(255,59,92,0.12);color:#FF3B5C;">⚠ TRIAL ENDS IN 48 HOURS</div>
    <h1>Your Account Guardian trial ends in 48 hours.</h1>
    <p>After ${trialEndDate}, your account health monitoring continues at <strong>$79/month</strong>. Cancel now and you won't be charged.</p>
    <div class="action-box">
      <h2>What you get for $79/month:</h2>
      <ul style="list-style:none;padding:0;margin:0;">
        <li style="padding:8px 0;font-size:14px;color:#6B6B80;border-bottom:1px solid rgba(255,255,255,0.07);">✓ Daily Stripe account signal monitoring</li>
        <li style="padding:8px 0;font-size:14px;color:#6B6B80;border-bottom:1px solid rgba(255,255,255,0.07);">✓ Instant alerts when your metrics cross thresholds</li>
        <li style="padding:8px 0;font-size:14px;color:#6B6B80;border-bottom:1px solid rgba(255,255,255,0.07);">✓ Your own dashboard with full signal history</li>
        <li style="padding:8px 0;font-size:14px;color:#6B6B80;">✓ We alert you before Stripe acts — not after</li>
      </ul>
    </div>
    <p style="font-size:13px;color:#6B6B80;">No surprise charges. Cancel any time from your dashboard settings.</p>
    <a href="${dashboardUrl}" class="cta">Continue Monitoring →</a>
    <p style="margin-top:24px;"><a href="${cancelUrl}" style="font-size:12px;color:#6B6B80;text-decoration:underline;">Cancel before trial ends — no charge</a></p>
    ${emailFooter()}
  </div>
</body>
</html>
  `;

  await sendPostmark(toEmail, 'Your Account Guardian trial ends in 48 hours — here is what to do', html);
}

/**
 * Send trial expiration offboarding — Day 14, no paid subscription.
 * Clear explanation that access has ended, with option to reactivate.
 */
async function sendTrialExpiredOffboarding(toEmail, dashboardUrl) {
  const appUrl = process.env.APP_URL || 'https://foundryiq-3.polsia.app';

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>${EMAIL_STYLE}</style>
</head>
<body>
  <div class="wrapper">
    ${emailHeader()}
    <div class="trial-badge" style="background:rgba(255,59,92,0.12);color:#FF3B5C;">TRIAL ENDED</div>
    <h1>Your Account Guardian trial has ended.</h1>
    <p>Your 14-day free trial has completed and you haven't upgraded. As of today, your account health monitoring has <strong>paused</strong> — we will no longer send alerts or capture signals from your Stripe account.</p>
    <div class="action-box" style="border-color:rgba(255,200,0,0.3);">
      <h2>What this means for your Stripe account</h2>
      <p>Without Account Guardian, Stripe can place your account under review or restriction without warning — and you won't know until revenue drops. Stripe doesn't notify merchants of internal risk flags until it's too late to respond.</p>
    </div>
    <p>You can reactivate your monitoring at any time. A subscription costs <strong>$79/month</strong> — less than a single dispute response takes to manage.</p>
    <a href="${appUrl}/billing/checkout?email=${encodeURIComponent(toEmail)}" class="cta">Reactivate for $79/month →</a>
    <p style="margin-top:24px;font-size:13px;color:#6B6B80;">No charge unless you reactivate. Your Stripe data remains private — we'll simply start capturing signals again once you resubscribe.</p>
    <p style="margin-top:16px;"><a href="${dashboardUrl}" style="font-size:12px;color:#6B6B80;">Visit your dashboard</a></p>
    ${emailFooter()}
  </div>
</body>
</html>
  `;

  await sendPostmark(toEmail, 'Your Account Guardian trial has ended — monitoring paused', html);
}

/**
 * Send trial conversion request — Day 14 conversion push.
 * Includes Stripe Checkout payment link.
 */
async function sendTrialConversionRequest(toEmail, trialEndDate, alertCount, dashboardUrl) {
  const appUrl = process.env.APP_URL || 'https://foundryiq-3.polsia.app';

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>${EMAIL_STYLE}</style>
</head>
<body>
  <div class="wrapper">
    ${emailHeader()}
    <div class="trial-badge" style="background:rgba(255,59,92,0.12);color:#FF3B5C;">TRIAL ENDED</div>
    <h1>Your Account Guardian trial has ended.</h1>
    <p>Continue monitoring your Stripe account for <strong>$79/month</strong>. Cancel now if you don't want to continue.</p>
    <div class="action-box">
      <h2>What you missed during your trial:</h2>
      <ul style="list-style:none;padding:0;margin:0;">
        <li style="padding:8px 0;font-size:14px;color:#6B6B80;border-bottom:1px solid rgba(255,255,255,0.07);">${alertCount > 0 ? `<strong style="color:#FF3B5C;">${alertCount} alert${alertCount !== 1 ? 's' : ''} fired</strong>` : 'No alerts fired'} — we kept watching while you trialed</li>
        <li style="padding:8px 0;font-size:14px;color:#6B6B80;">Daily Stripe account signal captures</li>
        <li style="padding:8px 0;font-size:14px;color:#6B6B80;">Threshold monitoring on your key metrics</li>
      </ul>
    </div>
    <p>Continue your monitoring — Stripe doesn't give second chances.</p>
    <a href="${appUrl}/billing/checkout?email=${encodeURIComponent(toEmail)}" class="cta">Continue for $79/month →</a>
    <p style="margin-top:24px;"><a href="${dashboardUrl}" style="font-size:12px;color:#6B6B80;">Visit your dashboard</a> · <a href="${appUrl}/billing/cancel?email=${encodeURIComponent(toEmail)}" style="font-size:12px;color:#6B6B80;text-decoration:underline;">Cancel — no charge</a></p>
    ${emailFooter()}
  </div>
</body>
</html>
  `;

  await sendPostmark(toEmail, 'Your Account Guardian trial has ended — continue for $79/month', html);
}

/**
 * Send dunning email — payment failed on subscription.
 * Includes next retry date so merchant knows when to expect another charge.
 */
async function sendDunningEmail(toEmail, nextRetryDate) {
  const dashboardUrl = `${process.env.APP_URL || 'https://foundryiq-3.polsia.app'}/dashboard`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>${EMAIL_STYLE}</style>
</head>
<body>
  <div class="wrapper">
    ${emailHeader()}
    <div class="trial-badge" style="background:rgba(255,200,0,0.12);color:#FFC800;">⚠ PAYMENT FAILED</div>
    <h1>Your Account Guardian payment failed.</h1>
    <p>We tried to charge your payment method for your Account Guardian subscription, but the charge didn't go through.</p>
    <div class="action-box" style="border-color:rgba(255,200,0,0.3);">
      <h2>We'll retry on ${nextRetryDate}</h2>
      <p>If the charge succeeds on retry, nothing is interrupted. If it fails again, your subscription will be canceled.</p>
    </div>
    <p><strong>Please update your payment method</strong> to ensure uninterrupted monitoring of your Stripe account.</p>
    <p style="color:#E8E8F0;font-size:15px;line-height:1.7;margin:0 0 20px;">
      Without an active subscription, Account Guardian will stop sending alerts — and Stripe could act without warning.
    </p>
    <a href="${dashboardUrl}" class="cta">Update Payment Method →</a>
    <p style="font-size:12px;margin-top:24px;color:#6B6B80;">
      If you believe this is an error, reply to this email and we'll help sort it out.
    </p>
    ${emailFooter()}
  </div>
</body>
</html>
  `;

  await sendPostmark(toEmail, 'Action required: Your Account Guardian payment failed', html);
}

// ── Alert email ────────────────────────────────────────────────────────────────

// Thresholds used for daily monitoring alerts
// Five distinct signals — dispute_rate includes chargeback as one input
const ALERT_THRESHOLDS = {
  dispute_rate: 0.02,    // 2% — Stripe review trigger (includes chargeback)
  auth_rate: 0.05,       // 5% — failed auth/decline rate
  revenue_trend: -0.20,  // -20% WoW drop
  transaction_velocity: 3.0,  // 3x normal velocity
  low_volume: 0.50,      // 50% drop vs 30-day average
};

const ALERT_LABELS = {
  dispute_rate: 'Dispute Rate',
  auth_rate: 'Auth Rate',
  revenue_trend: 'Revenue Trend',
  transaction_velocity: 'Tx Velocity',
  low_volume: 'Low Volume',
};

const ALERT_REMEDIATION = {
  dispute_rate: {
    title: 'Dispute Rate Elevated — Respond to Disputes Immediately',
    body: 'Stripe reviews accounts when dispute rates hit elevated levels for consecutive periods. High dispute rates signal payment fraud or product mismatch issues. Your immediate action: log into the Stripe dashboard, pull the list of open disputes, and respond to each one within the deadline. Chargebacks are folded into this signal. For winning rate improvement, focus on pre-emptive communication with customers before they escalate — clear cancellation policies and proactive refund offers reduce escalations. If you believe many disputes are fraudulent, enable Stripe Radar rules to flag high-risk transactions before they capture.',
  },
  auth_rate: {
    title: 'Auth Rate Elevated — Failed Payment Attempts Climbing',
    body: `A rising auth/decline rate means more payment attempts are failing. This could be due to insufficient funds patterns, expired cards, or geographic blocks. Your immediate action: review the decline codes in your Stripe dashboard — if you see a spike in specific codes (e.g., "insufficient_funds" vs "do_not_honor"), you can address the root cause. High auth decline rates can also trigger Stripe risk reviews if they signal a fraud problem. Consider enabling Stripe's automatic card updating so expired cards refresh automatically.`,
  },
  revenue_trend: {
    title: 'Revenue Dropped More Than 20% Week-over-Week — Investigate Now',
    body: 'A sharp revenue drop can signal payment failures, account issues, or deliberate Stripe restrictions. Stripe sometimes reduces acceptance rates without notifying you until revenue tanks. Your immediate action: log into the Stripe dashboard, check the "Payment failures" report, and look for an "account under review" banner at the top. Check your email for Stripe notifications. If payments are failing silently, Stripe may be blocking transactions from certain regions or card types — respond to any open review before it escalates.',
  },
  transaction_velocity: {
    title: 'Transaction Velocity Spike — Unusual Activity Pattern Detected',
    body: 'Your transaction volume has spiked to 3x or more your normal daily rate. This could indicate a successful promotion driving a surge, or it could signal fraud (stolen card testing). Your immediate action: check your Stripe dashboard for a surge in new orders — if they look legitimate, it may be growth. If you see suspicious patterns (many orders from the same IP, rapid small-value charges), enable Stripe Radar rules to slow the spike and review flagged transactions.',
  },
  low_volume: {
    title: 'Transaction Volume Dropped Sharply — Stripe May Have Restricted Your Account',
    body: 'Your transaction volume has dropped significantly vs your 30-day average. Stripe often restricts accounts silently — reducing acceptance rates or blocking certain card types without a direct email notification. Your immediate action: log into the Stripe dashboard and look for any banner indicating your account is under review. Check the Payments report for a spike in failed transactions. If Stripe has quietly reduced your acceptance rate, responding to their review inquiry promptly is the fastest way to restore full access.',
  },
};

/**
 * Send a threshold-breach alert email to a merchant.
 * One email per firing event. Includes specific remediation steps.
 */
async function sendAlertEmail(toEmail, merchantName, alerts) {
  const dashboardUrl = `${process.env.APP_URL || 'https://foundryiq-3.polsia.app'}/dashboard`;
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  const alertRows = alerts.map(a => {
    const thresholdVal = ALERT_THRESHOLDS[a.signalType] ?? 0;
    const signalType = a.signalType;

    let thresholdDisplay, actualDisplay;
    if (signalType === 'revenue_trend') {
      thresholdDisplay = `${Math.abs(thresholdVal * 100).toFixed(0)}% drop`;
      actualDisplay = a.actualValue < 0
        ? `${Math.abs(a.actualValue * 100).toFixed(1)}% drop`
        : `${(a.actualValue * 100).toFixed(1)}%`;
    } else if (signalType === 'transaction_velocity') {
      thresholdDisplay = `>${thresholdVal}x normal`;
      actualDisplay = `${a.actualValue.toFixed(2)}x`;
    } else if (signalType === 'low_volume') {
      thresholdDisplay = `<${(thresholdVal * 100).toFixed(0)}% of avg`;
      actualDisplay = `${(a.actualValue * 100).toFixed(1)}% of avg`;
    } else {
      // dispute_rate, auth_rate — show as percentage
      thresholdDisplay = `>${(thresholdVal * 100).toFixed(1)}%`;
      actualDisplay = `${(a.actualValue * 100).toFixed(2)}%`;
    }

    const color = a.severity === 'critical' ? '#FF3B5C' : '#FFC800';

    return `
      <tr>
        <td style="padding:14px 12px;border-bottom:1px solid rgba(255,255,255,0.07);color:#E8E8F0;font-size:14px;">
          <span style="color:${color};font-weight:700;">${ALERT_LABELS[signalType] || signalType}</span>
        </td>
        <td style="padding:14px 12px;border-bottom:1px solid rgba(255,255,255,0.07);color:#FF3B5C;font-family:'Courier New',monospace;font-size:14px;text-align:center;">${actualDisplay}</td>
        <td style="padding:14px 12px;border-bottom:1px solid rgba(255,255,255,0.07);color:#6B6B80;font-family:'Courier New',monospace;font-size:12px;text-align:center;">${thresholdDisplay}</td>
        <td style="padding:14px 12px;border-bottom:1px solid rgba(255,255,255,0.07);font-size:12px;color:#FFC800;font-weight:600;">${a.severity.toUpperCase()}</td>
      </tr>
    `;
  }).join('');

  // Pull the first (most critical) alert for the remediation section
  const primary = alerts[0];
  const primaryRemediation = ALERT_REMEDIATION[primary.signalType] || {
    title: 'Signal Threshold Breached — Take Action',
    body: 'Check your Stripe dashboard for recent account notifications and review any open disputes or payment failures.',
  };

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: 'Helvetica Neue', Arial, sans-serif; background: #0A0A0F; color: #E8E8F0; margin: 0; padding: 0; }
    .wrapper { max-width: 560px; margin: 0 auto; padding: 48px 24px; }
    .header { border-bottom: 1px solid rgba(255,255,255,0.07); padding-bottom: 32px; margin-bottom: 32px; }
    .logo { font-family: 'Courier New', monospace; font-size: 14px; font-weight: bold; letter-spacing: 0.08em; }
    .logo span { color: #00E5FF; }
    h1 { font-size: 22px; font-weight: 700; margin: 0 0 8px; line-height: 1.3; }
    .subhead { font-size: 13px; color: #6B6B80; font-family: 'Courier New', monospace; letter-spacing: 0.04em; margin-bottom: 32px; }
    .alert-badge { background: rgba(255,59,92,0.12); color: #FF3B5C; font-family: 'Courier New', monospace; font-size: 11px; font-weight: bold; letter-spacing: 0.1em; padding: 6px 12px; border-radius: 2px; display: inline-block; margin-bottom: 24px; }
    .signal-table { width: 100%; border-collapse: collapse; margin: 0 0 32px; }
    .signal-table th { font-family: 'Courier New', monospace; font-size: 10px; letter-spacing: 0.12em; color: #6B6B80; text-align: left; padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.07); }
    .signal-table th:not(:first-child) { text-align: center; }
    .remediation-box { background: #111118; border: 1px solid rgba(255,59,92,0.3); border-radius: 8px; padding: 28px; margin: 0 0 32px; }
    .remediation-box h2 { font-size: 15px; font-weight: 700; margin: 0 0 12px; color: #FF3B5C; }
    .remediation-box p { font-size: 14px; line-height: 1.75; color: #6B6B80; margin: 0; }
    .cta { display: inline-block; background: #00E5FF; color: #0A0A0F; font-size: 14px; font-weight: 700; padding: 14px 28px; border-radius: 4px; text-decoration: none; }
    .footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid rgba(255,255,255,0.07); font-size: 11px; color: #6B6B80; font-family: 'Courier New', monospace; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="logo">ACCOUNT<span>GUARDIAN</span></div>
    </div>
    <div class="alert-badge">⚠ SIGNAL ALERT — ${alerts.length} BREACH${alerts.length !== 1 ? 'ES' : ''}</div>
    <h1>${merchantName}, your Stripe account has triggered ${alerts.length} threshold alert${alerts.length !== 1 ? 's' : ''}.</h1>
    <p class="subhead">${dateStr} at ${timeStr} · Account Guardian monitoring</p>

    <table class="signal-table">
      <thead>
        <tr>
          <th>SIGNAL</th>
          <th>YOUR VALUE</th>
          <th>THRESHOLD</th>
          <th>SEVERITY</th>
        </tr>
      </thead>
      <tbody>
        ${alertRows}
      </tbody>
    </table>

    <div class="remediation-box">
      <h2>${primaryRemediation.title}</h2>
      <p>${primaryRemediation.body}</p>
    </div>

    <a href="${dashboardUrl}" class="cta">View Full Dashboard →</a>

    <div class="footer">
      Account Guardian by Astramedia · Monitoring Stripe accounts so you don't get surprised<br>
      Questions? Reply to this email.
    </div>
  </div>
</body>
</html>
  `;

  const subject = alerts.length === 1
    ? `⚠ Account Alert: ${ALERT_LABELS[primary.signalType] || primary.signalType} threshold breached`
    : `⚠ Account Alert: ${alerts.length} signals breached thresholds on your Stripe account`;

  await sendPostmark(toEmail, subject, html);
}

/**
 * Send baseline calibration report email.
 * Fired immediately after calibration completes (post-OAuth or recalibration).
 * Shows: what we found, their baseline vs our threshold, what happens next.
 */
async function sendBaselineReportEmail(toEmail, merchantName, calibrationResult) {
  const dashboardUrl = `${process.env.APP_URL || 'https://foundryiq-3.polsia.app'}/dashboard`;
  const { calibrated, stats, thresholds, reason, sampleSize } = calibrationResult;

  let bodyRows = '';
  let infoBlock = '';

  if (calibrated) {
    // Show each signal's baseline and calibrated threshold
    const signals = [
      { label: 'Dispute Rate',    baseline: stats.dispute.mean,    threshold: thresholds.dispute_rate,    fmt: formatPct },
      { label: 'Refund Rate',     baseline: stats.refund.mean,   threshold: thresholds.refund_rate,     fmt: formatPct },
      { label: 'Chargeback Rate', baseline: stats.chargeback.mean, threshold: thresholds.chargeback_rate, fmt: formatPct },
    ];

    bodyRows = signals.map(s => `
      <tr>
        <td style="padding:14px 12px;border-bottom:1px solid rgba(255,255,255,0.07);color:#E8E8F0;font-size:14px;">${s.label}</td>
        <td style="padding:14px 12px;border-bottom:1px solid rgba(255,255,255,0.07);font-family:'Courier New',monospace;font-size:14px;text-align:center;color:#B4FF00;">${s.fmt(s.baseline)}</td>
        <td style="padding:14px 12px;border-bottom:1px solid rgba(255,255,255,0.07);font-family:'Courier New',monospace;font-size:14px;text-align:center;color:#00E5FF;">${s.fmt(s.threshold)}</td>
      </tr>
    `).join('');

    infoBlock = `
      <p style="font-size:13px;color:#6B6B80;margin:0 0 24px;">
        Based on your last ${stats.dispute.count * 7 || 90} days of Stripe data · ${sampleSize} charge records analyzed
      </p>
    `;
  } else {
    // Not enough history yet
    bodyRows = `
      <tr>
        <td style="padding:14px 12px;border-bottom:1px solid rgba(255,255,255,0.07);color:#E8E8F0;font-size:14px;">Dispute Rate</td>
        <td style="padding:14px 12px;border-bottom:1px solid rgba(255,255,255,0.07);font-family:'Courier New',monospace;font-size:14px;text-align:center;color:#6B6B80;">—</td>
        <td style="padding:14px 12px;border-bottom:1px solid rgba(255,255,255,0.07);font-family:'Courier New',monospace;font-size:14px;text-align:center;color:#FFC800;">1.5%</td>
      </tr>
      <tr>
        <td style="padding:14px 12px;border-bottom:1px solid rgba(255,255,255,0.07);color:#E8E8F0;font-size:14px;">Refund Rate</td>
        <td style="padding:14px 12px;border-bottom:1px solid rgba(255,255,255,0.07);font-family:'Courier New',monospace;font-size:14px;text-align:center;color:#6B6B80;">—</td>
        <td style="padding:14px 12px;border-bottom:1px solid rgba(255,255,255,0.07);font-family:'Courier New',monospace;font-size:14px;text-align:center;color:#FFC800;">8%</td>
      </tr>
      <tr>
        <td style="padding:14px 12px;border-bottom:1px solid rgba(255,255,255,0.07);color:#E8E8F0;font-size:14px;">Chargeback Rate</td>
        <td style="padding:14px 12px;border-bottom:1px solid rgba(255,255,255,0.07);font-family:'Courier New',monospace;font-size:14px;text-align:center;color:#6B6B80;">—</td>
        <td style="padding:14px 12px;border-bottom:1px solid rgba(255,255,255,0.07);font-family:'Courier New',monospace;font-size:14px;text-align:center;color:#FFC800;">0.5%</td>
      </tr>
    `;
    infoBlock = `
      <div style="background:rgba(255,200,0,0.12);border:1px solid rgba(255,200,0,0.3);border-radius:4px;padding:16px;margin:0 0 24px;">
        <p style="margin:0;font-size:13px;color:#FFC800;">
          <strong>Not enough history yet.</strong> We need at least 14 days of Stripe activity before we can compute your baseline. Conservative thresholds are active. After 30 days of data, we'll automatically recalibrate with your actual history.
        </p>
      </div>
    `;
  }

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: 'Helvetica Neue', Arial, sans-serif; background: #0A0A0F; color: #E8E8F0; margin: 0; padding: 0; }
    .wrapper { max-width: 560px; margin: 0 auto; padding: 48px 24px; }
    .header { border-bottom: 1px solid rgba(255,255,255,0.07); padding-bottom: 32px; margin-bottom: 32px; }
    .logo { font-family: 'Courier New', monospace; font-size: 14px; font-weight: bold; letter-spacing: 0.08em; }
    .logo span { color: #00E5FF; }
    h1 { font-size: 22px; font-weight: 700; margin: 0 0 8px; line-height: 1.3; }
    p { font-size: 15px; line-height: 1.7; color: #6B6B80; margin: 0 0 20px; }
    .highlight { color: #E8E8F0; font-weight: 600; }
    .signal-table { width: 100%; border-collapse: collapse; margin: 0 0 32px; }
    .signal-table th { font-family: 'Courier New', monospace; font-size: 10px; letter-spacing: 0.12em; color: #6B6B80; text-align: left; padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.07); }
    .signal-table th:not(:first-child) { text-align: center; }
    .baseline { color: #B4FF00; }
    .threshold { color: #00E5FF; }
    .explain-box { background: #111118; border: 1px solid rgba(255,255,255,0.07); border-radius: 8px; padding: 24px; margin: 0 0 32px; }
    .explain-box h2 { font-size: 14px; font-weight: 700; margin: 0 0 10px; color: #00E5FF; }
    .explain-box p { margin: 0 0 8px; font-size: 13px; }
    .cta { display: inline-block; background: #00E5FF; color: #0A0A0F; font-size: 14px; font-weight: 700; padding: 14px 28px; border-radius: 4px; text-decoration: none; }
    .footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid rgba(255,255,255,0.07); font-size: 11px; color: #6B6B80; font-family: 'Courier New', monospace; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <div class="logo">ACCOUNT<span>GUARDIAN</span></div>
    </div>
    <h1>Your baseline is set, ${merchantName}.</h1>
    <p>Here's what we found on your Stripe account and what happens next.</p>

    <div class="explain-box">
      <h2>HOW YOUR THRESHOLDS WORK</h2>
      <p>Most monitoring tools fire on <span class="highlight">industry averages</span> — which means they alert you for normal seasonal variance, not actual problems.</p>
      <p>Account Guardian uses <span class="highlight">your</span> baseline instead. We set thresholds at 2 standard deviations above your normal — so we only alert you when your numbers do something <em>unusual for your account</em>, not unusual for DTC merchants in general.</p>
    </div>

    <table class="signal-table">
      <thead>
        <tr>
          <th>SIGNAL</th>
          <th style="text-align:center;">YOUR BASELINE</th>
          <th style="text-align:center;">ALERT THRESHOLD</th>
        </tr>
      </thead>
      <tbody>
        ${bodyRows}
      </tbody>
    </table>

    ${infoBlock}

    <p>Your thresholds will <strong>automatically recalibrate every 90 days</strong> to capture growth and change in your account.</p>
    <a href="${dashboardUrl}" class="cta">View Your Dashboard →</a>

    <div class="footer">
      Account Guardian by Astramedia · Monitoring Stripe accounts so you don't get surprised<br>
      Questions? Reply to this email.
    </div>
  </div>
</body>
</html>
  `;

  const subject = calibrated
    ? `Your baseline is set — we alert you at ${(thresholds.dispute_rate * 100).toFixed(1)}% dispute rate`
    : 'Your baseline is set — we need a bit more history first';

  await sendPostmark(toEmail, subject, html);
}

module.exports = {
  sendAuditConfirmation,
  sendAuditReport,
  sendWelcomeEmail,
  sendFollowupEmail,
  sendTrialConfirmation,
  sendMidTrialCheckIn,
  sendTrialEndingSoon,
  sendTrialConversionRequest,
  sendTrialExpiredOffboarding,
  sendDunningEmail,
  sendAlertEmail,
  sendBaselineReportEmail,
  formatPct,
  computeVerdict,
  ALERT_THRESHOLDS,
  ALERT_LABELS,
  ALERT_REMEDIATION,
};