# Account Guardian — Support Response Templates

All merchant replies to alert emails or dashboard messages should get a response
within 4 business hours. 90%+ of issues are resolvable with template responses.

---

## Template: False Positive Response

**Trigger:** Merchant reports an alert was wrong ("my dispute rate is normal")

**Response logic:**
- Acknowledge the feedback
- Explain how baseline calibration works (their thresholds are based on their own 90-day history, not industry averages — so normal variance doesn't fire alerts)
- Offer to adjust thresholds if they're seeing consistent issues
- Thank them — false positive reports improve calibration

**Template:**
```
Hi [Name],

Thanks for getting in touch — and sorry if our alert caused unnecessary concern.

Your thresholds were calibrated from your actual Stripe history (90 days of data),
not industry averages. This means normal seasonal variation for your account
typically won't trigger alerts — we'd only fire when your numbers do something
*unusual for your account specifically*.

If you're seeing consistent issues with a particular signal, reply and let us
know — we can review or adjust your thresholds. We take false positive reports
seriously; they're how we improve calibration over time.

Thanks for the feedback.
```

**Action:**
- Mark threshold as user-adjusted in `thresholds` table
- Log `flagged_false_positive = TRUE` on the alert
- Log `false_positive_reported_at = NOW()`

---

## Template: Threshold Adjustment Confirmation

**Trigger:** After adjusting a merchant's threshold (per their false positive report)

**Response logic:**
- Confirm what changed and why
- Reassure them their baseline remains intact
- Let them know recalibration happens every 90 days

**Template:**
```
Hi [Name],

Your threshold for [signal] has been adjusted to [X%] — above your recent
baseline of [Y%], so this should be stable.

Your baseline calibration is unchanged. We recalibrate every 90 days from
your Stripe history, so as your account changes, your thresholds will update
automatically.

If anything else fires an alert you think is off, reply here — we'll sort it out.
```

**Action:**
- Log threshold adjustment with `user_adjusted_threshold = TRUE`

---

## Template: Ban Despite Alert (Critical Escalation)

**Trigger:** Merchant says their Stripe account was banned/restricted despite receiving an alert

**Response logic:**
- Acknowledge immediately and with empathy
- Offer concierge Stripe appeal assistance
- Explain this is a priority case

**Template:**
```
Hi [Name],

I'm sorry to hear Stripe restricted your account — and I'm glad our alert
reached you before it happened.

We can help you through this. Our team has experience with Stripe appeals,
and we can walk you through the fastest path to getting your account restored.

Reply to this email with:
1. The date of our alert
2. Any response you got from Stripe
3. Whether you responded to the alert when you received it

We'll be in touch within a few hours with a specific action plan.
```

**Action:**
- Flag for manual review (`manual_review_flag = TRUE`)
- Open support ticket (`support_ticket_id`, `support_ticket_created_at = NOW()`)
- Document timeline in merchant record
- Set `last_escalation_at = NOW()`

---

## Template: How to Fix a Signal

**Trigger:** Merchant asks "how do I fix [signal]?"

**Response logic:**
- Link to relevant remediation guide
- Add specific context for their current values
- Make it actionable (step-by-step not just theory)

**Signal-specific remediation:**

**Dispute Rate:**
```
Your dispute rate is currently [X%]. To bring it down:
1. Log into Stripe → Disputes. Respond to every open dispute before the deadline.
2. For fraudulent disputes, enable Stripe Radar rules to flag high-risk transactions
   before they capture.
3. Review your product/copy mismatch cases — proactive refunds before escalation
   reduces chargebacks.
4. Add a clear billing descriptor so customers recognize the charge.
```

**Auth Rate:**
```
Your auth/decline rate is currently [X%]. To improve it:
1. Review your decline codes in Stripe → Payments. If you're seeing a spike
   in "insufficient_funds", that's a customer-side issue, not yours.
2. Enable Stripe's automatic card updating so expired cards refresh without
   requiring manual updates.
3. Consider adding alternative payment methods (ACH, PayPal) for customers
   whose cards keep declining.
```

**Revenue Drop:**
```
Your revenue dropped [X%] this week. Check:
1. Stripe dashboard for an "account under review" banner at the top
2. Email inbox for any Stripe notifications
3. Payment failure rate in Stripe → Payments — if silent failures are happening,
   Stripe may have reduced your acceptance rate
4. Respond to any open review inquiry immediately — this is the fastest path
   to restoring full access
```

**Action:**
- Log that remediation guide was sent
- Schedule follow-up in 48 hours (confirm helpful)

---

## Template: Cancellation

**Trigger:** Merchant says they want to cancel

**Response logic:**
- Don't argue — ask why first
- If the reason is fixable, offer to help
- If it's billing, offer one more week free
- If they're leaving for Stripe reasons (banned), still offer help

**Template:**
```
Hi [Name],

Before you go — can I ask what prompted this?

If there's something we can fix, we'd genuinely like the chance to. If it's a
billing concern, let me know — we have options.

(If you're leaving because Stripe banned or restricted your account, reply
with details — we can still help with the appeal even if you're canceling
the monitoring.)

Reply and let us know what's driving this.
```

**Action:**
- Log churn reason in `merchants.churn_reason`
- Set `churned_at = NOW()`
- Set `status = 'churned'`

---

## Template: General Help

**Trigger:** Merchant has a question not matching above categories

**Response logic:**
- Acknowledge receipt
- Set expectation for response time
- Show we've reviewed their account

**Template:**
```
Hi [Name],

Thanks for reaching out. I've reviewed your account and I'm looking into this.

You'll hear back from us within [4 business hours].

If this is urgent, reply with "URGENT" in the subject line.
```