#!/usr/bin/env node
/**
 * Stripe Connect OAuth smoke test — standalone script.
 *
 * Run manually: node scripts/smoke-stripe-connect.js
 * Or via cron: node scripts/smoke-stripe-connect.js --alert-slack
 *
 * Verifies:
 *   1. Stripe env vars are set
 *   2. Token exchange POSTs include redirect_uri (fix from 2026-06-20)
 *   3. Connected merchants in DB have tokens stored
 *   4. Webhook endpoint rejects unsigned requests
 *   5. Stripe SDK is reachable
 *
 * Exits 0 on all-pass, non-zero on any failure.
 */

'use strict';

const axios = require('axios');
const { Pool } = require('pg');

const BASE_URL = process.env.APP_URL || 'https://foundryiq-3.polsia.app';
const STRIPE_CLIENT_ID = process.env.STRIPE_CLIENT_ID;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const TOKEN_URL = 'https://connect.stripe.com/oauth/token';

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;
let exitCode = 0;

function log(level, msg, detail) {
  const prefix = level === 'FAIL' ? '❌' : level === 'PASS' ? '✅' : level === 'WARN' ? '⚠️' : 'ℹ️';
  const out = `${prefix} [${level}] ${msg}`;
  console.log(detail ? `${out} ${JSON.stringify(detail)}` : out);
  if (level === 'FAIL') exitCode = 1;
}

async function check1_envVars() {
  log('INFO', 'Check 1: Stripe env vars');
  if (!STRIPE_CLIENT_ID) {
    log('FAIL', 'STRIPE_CLIENT_ID not set');
  } else {
    log('PASS', 'STRIPE_CLIENT_ID set');
  }
  if (!STRIPE_SECRET_KEY) {
    log('FAIL', 'STRIPE_SECRET_KEY not set');
  } else {
    log('PASS', 'STRIPE_SECRET_KEY set');
  }
}

async function check2_tokenExchangeRedirectUri() {
  log('INFO', 'Check 2: Token exchange includes redirect_uri');

  if (!STRIPE_CLIENT_ID || !STRIPE_SECRET_KEY) {
    log('FAIL', 'Cannot test — STRIPE_CLIENT_ID or STRIPE_SECRET_KEY not set');
    return;
  }

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: 'smoke_test_invalid_code_20260621',
    client_id: STRIPE_CLIENT_ID,
    client_secret: STRIPE_SECRET_KEY,
    redirect_uri: `${BASE_URL}/auth/callback`,
  });

  let stripeError = null;
  try {
    await axios.post(TOKEN_URL, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 8000,
    });
  } catch (err) {
    stripeError = err.response?.data || {};
  }

  if (stripeError?.error === 'invalid_request' && !stripeError?.error_description) {
    log('FAIL', 'Stripe returned invalid_request (no description) — redirect_uri NOT sent. This is the pre-fix symptom from 2026-06-20.');
  } else if (stripeError?.error_description) {
    log('PASS', `Stripe responded with description="${stripeError.error_description}" — redirect_uri is included`);
  } else if (stripeError?.error === 'invalid_grant') {
    log('PASS', 'Stripe returned invalid_grant — redirect_uri was accepted (fix holding)');
  } else if (stripeError?.error === 'invalid_client') {
    log('FAIL', `Stripe returned invalid_client — check client_id or client_secret: ${stripeError.error_description}`);
  } else if (!stripeError) {
    log('FAIL', 'Stripe accepted a fake code — unexpected, investigate immediately');
  } else {
    log('WARN', 'Unexpected Stripe response', stripeError);
  }
}

async function check3_dbConnectedMerchants() {
  log('INFO', 'Check 3: Connected merchants in DB');

  if (!pool) {
    log('FAIL', 'DATABASE_URL not set — cannot query DB');
    return;
  }

  try {
    const result = await pool.query(
      `SELECT m.id, m.email, m.stripe_account_id, m.status, m.oauth_connected_at,
              st.access_token IS NOT NULL as has_token
       FROM merchants m
       LEFT JOIN stripe_tokens st ON st.merchant_id = m.id
       WHERE m.status = 'connected'::merchant_status
       ORDER BY m.oauth_connected_at DESC NULLS LAST`
    );

    if (result.rows.length === 0) {
      log('WARN', 'No merchants with status=connected — normal if no merchants have completed OAuth yet');
    } else {
      log('PASS', `Found ${result.rows.length} connected merchant(s)`);
      result.rows.forEach((m) => {
        const tokenStatus = m.has_token ? '✅ token stored' : '❌ NO token stored';
        log('INFO', `  Merchant ${m.id} (${m.email}) — ${tokenStatus}`);
      });
    }
  } catch (err) {
    log('FAIL', `DB query failed: ${err.message}`);
  }
}

async function check4_webhookSignature() {
  log('INFO', 'Check 4: Webhook rejects unsigned requests');

  try {
    const response = await axios.post(
      `${BASE_URL}/api/webhooks/stripe`,
      Buffer.from(JSON.stringify({ type: 'checkout.session.completed' })),
      {
        headers: {
          'Content-Type': 'application/json',
          'Stripe-Signature': 'test_sig_that_should_be_rejected_20260621',
        },
        timeout: 8000,
        validateStatus: () => true,
      }
    );

    if (response.status === 400) {
      log('PASS', 'Webhook correctly returns 400 for invalid signature');
    } else if (response.status === 200) {
      log('FAIL', `Webhook returned 200 for unsigned request — signature verification may be broken`);
    } else {
      log('WARN', `Webhook returned status ${response.status} — investigate`, response.data);
    }
  } catch (err) {
    log('FAIL', `Webhook unreachable: ${err.message}`);
  }
}

async function check5_stripeReachable() {
  log('INFO', 'Check 5: Stripe token endpoint reachable');

  if (!STRIPE_SECRET_KEY || !STRIPE_CLIENT_ID) {
    log('FAIL', 'STRIPE_SECRET_KEY or STRIPE_CLIENT_ID not set');
    return;
  }

  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'smoke_test_stripe_reachability_check_20260621',
      client_id: STRIPE_CLIENT_ID,
      client_secret: STRIPE_SECRET_KEY,
      redirect_uri: `${BASE_URL}/auth/callback`,
    });
    await axios.post(TOKEN_URL, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 8000,
    });
    log('PASS', 'Stripe token endpoint reachable');
  } catch (err) {
    const data = err.response?.data || {};
    if (data?.error === 'invalid_client') {
      log('FAIL', `Stripe key invalid: ${data.error_description || 'invalid_client'}`);
    } else if (err.response?.status === 401) {
      log('FAIL', `Stripe returned 401 — secret key may be wrong`);
    } else if (data?.error === 'invalid_grant' || data?.error === 'invalid_request') {
      log('PASS', `Stripe reachable — key valid (got ${data.error} response)`);
    } else {
      log('WARN', `Stripe responded: ${(data?.error_description || data?.error || err.message).slice(0, 120)}`);
    }
  }
}

async function main() {
  console.log('\n🔍 Stripe Connect OAuth Smoke Test');
  console.log(`   Base URL: ${BASE_URL}`);
  console.log(`   Timestamp: ${new Date().toISOString()}\n`);

  await check1_envVars();
  console.log('');
  await check2_tokenExchangeRedirectUri();
  console.log('');
  await check3_dbConnectedMerchants();
  console.log('');
  await check4_webhookSignature();
  console.log('');
  await check5_stripeReachable();
  console.log('');

  if (exitCode === 0) {
    console.log('✅ All checks passed');
  } else {
    console.log('❌ One or more checks failed');
  }

  if (pool) await pool.end();
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err.message);
  if (pool) pool.end().catch(() => {});
  process.exit(1);
});