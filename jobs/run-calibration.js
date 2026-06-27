/**
 * Calibration Runner — runs baseline calibration for a merchant.
 *
 * Usage:
 *   node jobs/run-calibration.js <merchantId>   — run for one merchant (post-OAuth trigger)
 *   node jobs/run-calibration.js --recalibrate   — run recalibration for all due merchants
 *
 * Triggered:
 *   - Immediately after OAuth connection (via auth.js calling this script)
 *   - Every 90 days via recalibration cron
 *
 * Guards with POLSIA_IN_PROCESS_CRONS_ENABLED so it doesn't run on Blaxel during migration.
 */
require('../db/index');

const { pool } = require('../db/index');
const { runCalibration, FALLBACK_THRESHOLDS } = require('../services/calibration');
const { upsertCalibratedThresholds, seedConservativeThresholds } = require('../db/thresholds');
const { refreshAccessToken, isTokenExpiringSoon } = require('../services/stripe');
const { sendBaselineReportEmail } = require('../services/email');
const { getMerchantWithToken } = require('../db/merchants');

async function run() {
  if (process.env.POLSIA_IN_PROCESS_CRONS_ENABLED !== 'true') {
    console.log('[calibration] Disabled (POLSIA_IN_PROCESS_CRONS_ENABLED != true)');
    return;
  }

  const args = process.argv.slice(2);
  if (args.includes('--recalibrate')) {
    await recalibrateAll();
  } else if (args.length === 1) {
    const merchantId = parseInt(args[0], 10);
    if (isNaN(merchantId)) {
      console.error('[calibration] Usage: node jobs/run-calibration.js <merchantId> OR node jobs/run-calibration.js --recalibrate');
      process.exit(1);
    }
    await calibrateMerchant(merchantId);
  } else {
    console.error('[calibration] Usage: node jobs/run-calibration.js <merchantId> OR node jobs/run-calibration.js --recalibrate');
    process.exit(1);
  }

  process.exit(0);
}

// ── Single merchant calibration ───────────────────────────────────────────────

async function calibrateMerchant(merchantId) {
  console.log(`[calibration] Starting calibration for merchant ${merchantId}`);
  const startTime = Date.now();

  const merchant = await getMerchantWithToken(merchantId);
  if (!merchant) {
    console.error(`[calibration] Merchant ${merchantId} not found`);
    return;
  }
  if (!merchant.stripe_account_id || !merchant.access_token) {
    console.error(`[calibration] Merchant ${merchantId} missing Stripe account or token`);
    return;
  }

  // Refresh token if needed
  let accessToken = merchant.access_token;
  if (isTokenExpiringSoon(merchant.expires_at)) {
    try {
      const refreshed = await refreshAccessToken(merchant.refresh_token);
      accessToken = refreshed.accessToken;
      await pool.query(
        `UPDATE stripe_tokens SET access_token = $2, refresh_token = $3, expires_at = $4, updated_at = NOW()
         WHERE merchant_id = $1`,
        [merchantId, refreshed.accessToken, refreshed.refreshToken, refreshed.expiresAt || null]
      );
    } catch (err) {
      console.error(`[calibration] Token refresh failed for ${merchantId}:`, err.message);
      return;
    }
  }

  // Run calibration
  const merchantWithToken = { ...merchant, accessToken };
  const result = await runCalibration(merchantWithToken);

  if (result.calibrated) {
    // Store calibrated thresholds in DB
    const thresholdsMap = {
      dispute_rate:    { threshold: result.thresholds.dispute_rate,    baseline: result.stats.dispute.mean,    stdDev: result.stats.dispute.stdDev,    sampleSize: result.sampleSize, windowDays: 90 },
      refund_rate:     { threshold: result.thresholds.refund_rate,     baseline: result.stats.refund.mean,   stdDev: result.stats.refund.stdDev,   sampleSize: result.sampleSize, windowDays: 90 },
      chargeback_rate: { threshold: result.thresholds.chargeback_rate, baseline: result.stats.chargeback.mean, stdDev: result.stats.chargeback.stdDev, sampleSize: result.sampleSize, windowDays: 90 },
      revenue_trend:   { threshold: result.thresholds.revenue_trend,    baseline: null, stdDev: null, sampleSize: result.sampleSize, windowDays: 90 },
    };
    await upsertCalibratedThresholds(merchantId, thresholdsMap);

    // Send baseline report email
    const merchantEmail = merchant.email;
    const merchantName = merchant.business_name || merchantEmail.split('@')[0];
    await sendBaselineReportEmail(merchantEmail, merchantName, result);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[calibration] Merchant ${merchantId} calibrated in ${elapsed}s. dispute: ${(result.stats.dispute.mean * 100).toFixed(2)}% → threshold ${(result.thresholds.dispute_rate * 100).toFixed(2)}%`);
  } else {
    // Insufficient history — seed conservative defaults
    console.log(`[calibration] Merchant ${merchantId}: ${result.reason} — seeding conservative defaults`);
    await seedConservativeThresholds(merchantId);

    // Still send baseline report with fallback info
    const merchantEmail = merchant.email;
    const merchantName = merchant.business_name || merchantEmail.split('@')[0];
    await sendBaselineReportEmail(merchantEmail, merchantName, {
      calibrated: false,
      reason: result.reason,
      thresholds: FALLBACK_THRESHOLDS,
    });
  }
}

// ── Recalibration batch ───────────────────────────────────────────────────────

async function recalibrateAll() {
  console.log('[calibration] Starting recalibration batch');
  const startTime = Date.now();

  const result = await pool.query(`
    SELECT m.id, m.email, m.business_name, m.stripe_account_id,
           st.access_token, st.refresh_token, st.expires_at,
           MAX(t.updated_at) as last_calibration
    FROM merchants m
    JOIN stripe_tokens st ON st.merchant_id = m.id
    JOIN thresholds t ON t.merchant_id = m.id
    WHERE m.stripe_account_id IS NOT NULL
      AND m.status IN ('active', 'trial', 'connected', 'audited')
      AND m.subscription_status IN ('active', 'trialing')
      AND t.is_calibrated = TRUE
    GROUP BY m.id, m.email, m.business_name, m.stripe_account_id, st.access_token, st.refresh_token, st.expires_at
    HAVING MAX(t.updated_at) < NOW() - INTERVAL '90 days'
    ORDER BY MAX(t.updated_at) ASC
    LIMIT 200
  `);

  const merchants = result.rows;
  console.log(`[calibration] ${merchants.length} merchants due for recalibration`);

  let processed = 0, calibrated = 0, errors = 0;
  for (const merchant of merchants) {
    try {
      let accessToken = merchant.access_token;
      if (isTokenExpiringSoon(merchant.expires_at)) {
        try {
          const refreshed = await refreshAccessToken(merchant.refresh_token);
          accessToken = refreshed.accessToken;
          await pool.query(
            `UPDATE stripe_tokens SET access_token = $2, refresh_token = $3, expires_at = $4, updated_at = NOW()
             WHERE merchant_id = $1`,
            [merchant.id, refreshed.accessToken, refreshed.refreshToken, refreshed.expiresAt || null]
          );
        } catch (err) {
          console.error(`[calibration] Token refresh failed for ${merchant.id}:`, err.message);
          errors++;
          continue;
        }
      }

      const result2 = await runCalibration({ ...merchant, accessToken });
      if (result2.calibrated) {
        const thresholdsMap = {
          dispute_rate:    { threshold: result2.thresholds.dispute_rate,    baseline: result2.stats.dispute.mean,    stdDev: result2.stats.dispute.stdDev,    sampleSize: result2.sampleSize, windowDays: 90 },
          refund_rate:     { threshold: result2.thresholds.refund_rate,     baseline: result2.stats.refund.mean,   stdDev: result2.stats.refund.stdDev,   sampleSize: result2.sampleSize, windowDays: 90 },
          chargeback_rate: { threshold: result2.thresholds.chargeback_rate, baseline: result2.stats.chargeback.mean, stdDev: result2.stats.chargeback.stdDev, sampleSize: result2.sampleSize, windowDays: 90 },
          revenue_trend:   { threshold: result2.thresholds.revenue_trend,   baseline: null, stdDev: null, sampleSize: result2.sampleSize, windowDays: 90 },
        };
        await upsertCalibratedThresholds(merchant.id, thresholdsMap);
        calibrated++;
      }
      processed++;
      await sleep(300);
    } catch (err) {
      console.error(`[calibration] Error for ${merchant.id}:`, err.message);
      errors++;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[calibration] Recalibration done in ${elapsed}s. Processed: ${processed}, Calibrated: ${calibrated}, Errors: ${errors}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

run().catch(err => {
  console.error('[calibration] Fatal error:', err.message);
  process.exit(1);
});