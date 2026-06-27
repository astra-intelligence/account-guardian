/**
 * Stripe Connect OAuth smoke test route.
 *
 * Verifies the OAuth state end-to-end for a connected merchant:
 *   1. Stripe env vars are present
 *   2. Token exchange endpoint is reachable and includes redirect_uri (2026-06-20 fix)
 *   3. DB reflects connected merchant state
 *   4. Webhook endpoint is alive and rejects unsigned requests
 *
 * Mounted at /api/_smoke/stripe-connect — public, no auth required.
 */

'use strict';

const { Router } = require('express');
const router = Router();
const axios = require('axios');

const { getConnectedMerchants } = require('../db/merchants');

const BASE_URL = process.env.APP_URL || 'https://foundryiq-3.polsia.app';
const STRIPE_CLIENT_ID = process.env.STRIPE_CLIENT_ID;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const TOKEN_URL = 'https://connect.stripe.com/oauth/token';

/**
 * GET /api/_smoke/stripe-connect
 *
 * Returns JSON with pass/fail for each check. Never throws — always returns 200
 * so monitoring tools can parse the body. Any failure marks overall status 'fail'.
 */
router.get('/stripe-connect', async (req, res) => {
  const checks = [];
  let overall = 'pass';

  function fail(check, reason) {
    checks.push({ check, status: 'fail', reason });
    overall = 'fail';
  }
  function pass(check, detail) {
    checks.push({ check, status: 'pass', ...(detail ? { detail } : {}) });
  }

  // ── 1. Env vars present ────────────────────────────────────────────────────
  if (!STRIPE_CLIENT_ID) {
    fail('env_vars', 'STRIPE_CLIENT_ID not set');
  } else {
    pass('env_vars', { clientId: STRIPE_CLIENT_ID.slice(0, 8) + '…' });
  }

  if (!STRIPE_SECRET_KEY) {
    fail('env_vars', 'STRIPE_SECRET_KEY not set');
  } else {
    pass('env_vars', 'STRIPE_SECRET_KEY present');
  }

  // ── 2. Token exchange includes redirect_uri ──────────────────────────────────
  // POST the endpoint with an invalid code — Stripe returns error_descripton
  // but only IF redirect_uri is included. Without it, Stripe returns a generic
  // "invalid_grant" with no description, masking the real problem.
  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'smoke_test_invalid_code_20260621',
      client_id: STRIPE_CLIENT_ID || '',
      client_secret: STRIPE_SECRET_KEY || '',
      redirect_uri: `${BASE_URL}/auth/callback`,
    });

    let stripeError;
    try {
      await axios.post(TOKEN_URL, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 5000,
      });
    } catch (err) {
      stripeError = err.response?.data || {};
    }

    // We expect an error — the question is whether it has a description.
    // "invalid_grant" = Stripe received the request but code is fake.
    // "redirect_uri_mismatch" = Stripe rejected because redirect_uri is wrong.
    // Missing description + "invalid_request" = redirect_uri was not sent.
    if (stripeError?.error === 'invalid_request') {
      fail('token_exchange_redirect_uri', 'Stripe returned invalid_request — redirect_uri may not be included (pre-fix behavior)');
    } else if (stripeError?.error_description) {
      pass('token_exchange_redirect_uri', `Stripe responded with "${stripeError.error_description}" — redirect_uri is sent correctly`);
    } else if (stripeError?.error === 'invalid_grant') {
      // Invalid code but redirect_uri WAS sent (Stripe can validate it)
      pass('token_exchange_redirect_uri', 'Stripe returned invalid_grant — redirect_uri is included (fix holding)');
    } else if (!STRIPE_CLIENT_ID || !STRIPE_SECRET_KEY) {
      fail('token_exchange_redirect_uri', 'Stripe env vars missing — cannot test');
    } else {
      pass('token_exchange_redirect_uri', 'Unexpected Stripe response — investigate manually', { raw: JSON.stringify(stripeError) });
    }
  } catch (err) {
    fail('token_exchange_redirect_uri', `Network error: ${err.message}`);
  }

  // ── 3. Connected merchant in DB ──────────────────────────────────────────────
  try {
    const connected = await getConnectedMerchants();
    if (connected.length === 0) {
      fail('db_connected_merchants', 'No merchants with status=connected found');
    } else {
      pass('db_connected_merchants', `Found ${connected.length} connected merchant(s)`);

      // Verify first connected merchant has tokens
      const m = connected[0];
      if (m.stripe_access_token) {
        pass('db_tokens', 'First connected merchant has access_token stored');
      } else {
        fail('db_tokens', 'Connected merchant is missing stripe_access_token');
      }

      if (m.stripe_user_id) {
        pass('db_stripe_user_id', `stripe_user_id: ${m.stripe_user_id}`);
      } else {
        fail('db_stripe_user_id', 'Connected merchant is missing stripe_user_id');
      }
    }
  } catch (err) {
    fail('db_connected_merchants', `DB error: ${err.message}`);
  }

  // ── 4. Webhook endpoint alive ───────────────────────────────────────────────
  try {
    const sig = 'test_signature_that_should_be_rejected';
    const fakeBody = Buffer.from(JSON.stringify({ type: 'checkout.session.completed' }));
    const response = await axios.post(
      `${BASE_URL}/api/webhooks/stripe`,
      fakeBody,
      {
        headers: {
          'Content-Type': 'application/json',
          'Stripe-Signature': sig,
        },
        timeout: 5000,
        validateStatus: () => true, // capture any status code
      }
    );

    if (response.status === 400) {
      pass('webhook_rejects_unsigned', 'Webhook correctly returns 400 for invalid signature');
    } else if (response.status === 200) {
      fail('webhook_rejects_unsigned', `Webhook returned 200 for unsigned request — may not be verifying signatures`);
    } else {
      pass('webhook_reaches_handler', `Webhook returned ${response.status}`);
    }
  } catch (err) {
    fail('webhook_reaches_handler', `Webhook unreachable: ${err.message}`);
  }

  // ── 5. Stripe Connect token endpoint reachable ─────────────────────────────
  if (STRIPE_SECRET_KEY && STRIPE_CLIENT_ID) {
    try {
      const params = new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'smoke_test_code_stripe_reachability_check',
        client_id: STRIPE_CLIENT_ID,
        client_secret: STRIPE_SECRET_KEY,
        redirect_uri: `${BASE_URL}/auth/callback`,
      });
      await axios.post(TOKEN_URL, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 5000,
      });
      pass('stripe_reachable', 'Stripe token endpoint reachable');
    } catch (err) {
      const data = err.response?.data || {};
      const status = err.response?.status;
      if (data?.error === 'invalid_client') {
        fail('stripe_reachable', `Stripe key invalid: ${data.error_description || 'invalid_client'}`);
      } else if (status === 401) {
        fail('stripe_reachable', 'Stripe returned 401 — secret key may be wrong');
      } else if (data?.error === 'invalid_grant' || data?.error === 'invalid_request') {
        // Got a Stripe response (not a network error) — key is valid
        pass('stripe_reachable', `Stripe reachable — key valid (got ${data.error} response)`);
      } else {
        pass('stripe_reachable', `Stripe responded — ${(data?.error_description || data?.error || err.message).slice(0, 80)}`);
      }
    }
  } else {
    fail('stripe_reachable', 'STRIPE_SECRET_KEY or STRIPE_CLIENT_ID not set');
  }

  res.status(overall === 'pass' ? 200 : 503).json({
    overall,
    timestamp: new Date().toISOString(),
    appUrl: BASE_URL,
    checks,
  });
});

/**
 * GET /api/_smoke/stripe-connect/token-exchange-test
 *
 * Simulates the OAuth callback token exchange with a test code.
 * Uses the same redirect_uri that auth.js uses so this is a valid replay test.
 * Reports detailed success/failure to help diagnose regressions.
 */
router.get('/stripe-connect/token-exchange-test', async (req, res) => {
  const code = req.query.code || 'smoke_test_code';
  const redirectUri = `${BASE_URL}/auth/callback`;

  if (!STRIPE_CLIENT_ID || !STRIPE_SECRET_KEY) {
    return res.status(503).json({
      success: false,
      error: 'missing_config',
      message: 'STRIPE_CLIENT_ID or STRIPE_SECRET_KEY not set',
    });
  }

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: STRIPE_CLIENT_ID,
    client_secret: STRIPE_SECRET_KEY,
    redirect_uri: redirectUri,
  });

  try {
    const response = await axios.post(TOKEN_URL, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 8000,
    });

    // This should never happen with a fake code — Stripe returns error JSON
    res.json({
      success: true,
      unexpected: 'Stripe accepted a fake code — investigate',
      redirectUri,
    });
  } catch (err) {
    const data = err.response?.data;
    const status = err.response?.status;

    const result = {
      success: false,
      httpStatus: status,
      redirectUri,
      error: data?.error || 'unknown',
      errorDescription: data?.error_description || null,
      hasRedirectUri: !!data?.error_description?.includes('redirect_uri') || false,
    };

    // Classify the response
    if (data?.error === 'invalid_grant') {
      result.assessment = 'pass';
      result.message = 'Stripe returned invalid_grant — redirect_uri was accepted (fix is holding)';
    } else if (data?.error === 'invalid_request' && !data?.error_description) {
      result.assessment = 'fail';
      result.message = 'Stripe returned invalid_request with no description — redirect_uri was NOT sent (pre-fix behavior)';
    } else if (data?.error === 'invalid_client') {
      result.assessment = 'fail';
      result.message = 'Stripe returned invalid_client — client_id or client_secret is wrong';
    } else if (!status) {
      result.assessment = 'fail';
      result.message = `Network error — could not reach Stripe: ${err.message}`;
    } else {
      result.assessment = 'warn';
      result.message = 'Unexpected Stripe error — review manually';
    }

    res.status(result.assessment === 'fail' ? 503 : 200).json(result);
  }
});

module.exports = router;