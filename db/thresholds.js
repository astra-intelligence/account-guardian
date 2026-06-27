/**
 * Thresholds — calibrated threshold storage and queries.
 * Does NOT compute thresholds — see services/calibration.js.
 */
const { pool } = require('./index');

// Upsert a calibrated threshold for a merchant
async function upsertThreshold(merchantId, signalType, thresholdValue, isCalibrated, calibrationData) {
  const result = await pool.query(
    `INSERT INTO thresholds (merchant_id, signal_type, threshold_value, is_calibrated, calibration_data, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (merchant_id, signal_type)
     DO UPDATE SET
       threshold_value = EXCLUDED.threshold_value,
       is_calibrated = EXCLUDED.is_calibrated,
       calibration_data = EXCLUDED.calibration_data,
       updated_at = NOW()
     RETURNING *`,
    [merchantId, signalType, thresholdValue, isCalibrated, JSON.stringify(calibrationData)]
  );
  return result.rows[0];
}

// Batch upsert for all signal types at once
async function upsertCalibratedThresholds(merchantId, thresholdsMap) {
  for (const [signalType, { threshold, baseline, stdDev, sampleSize, windowDays }] of Object.entries(thresholdsMap)) {
    await upsertThreshold(
      merchantId,
      signalType,
      threshold,
      true,
      { baseline, stdDev, sampleSize, windowDays }
    );
  }
}

// Get calibrated thresholds for a merchant
async function getThresholds(merchantId) {
  const result = await pool.query(
    'SELECT * FROM thresholds WHERE merchant_id = $1 ORDER BY signal_type',
    [merchantId]
  );
  return result.rows;
}

// Check if merchant has calibrated thresholds
async function hasCalibratedThresholds(merchantId) {
  const result = await pool.query(
    'SELECT COUNT(*) as count FROM thresholds WHERE merchant_id = $1 AND is_calibrated = TRUE',
    [merchantId]
  );
  return parseInt(result.rows[0].count, 10) > 0;
}

// Get the last calibration date for a merchant
async function getLastCalibrationDate(merchantId) {
  const result = await pool.query(
    'SELECT MAX(updated_at) as last_calibration FROM thresholds WHERE merchant_id = $1',
    [merchantId]
  );
  return result.rows[0]?.last_calibration || null;
}

// Get merchants due for recalibration (90+ days since last calibration)
async function getMerchantsForRecalibration(limit = 50) {
  const result = await pool.query(`
    SELECT m.id, m.email, m.stripe_account_id,
           st.access_token, st.refresh_token, st.expires_at,
           MAX(t.updated_at) as last_calibration
    FROM merchants m
    JOIN stripe_tokens st ON st.merchant_id = m.id
    JOIN thresholds t ON t.merchant_id = m.id
    WHERE m.stripe_account_id IS NOT NULL
      AND m.status IN ('active', 'trial', 'connected', 'audited')
      AND m.subscription_status IN ('active', 'trialing')
      AND t.is_calibrated = TRUE
    GROUP BY m.id, m.email, m.stripe_account_id, st.access_token, st.refresh_token, st.expires_at
    HAVING MAX(t.updated_at) < NOW() - INTERVAL '90 days'
    ORDER BY MAX(t.updated_at) ASC
    LIMIT $1
  `, [limit]);
  return result.rows;
}

// Seed default conservative thresholds for a merchant (used when no history)
async function seedConservativeThresholds(merchantId) {
  const conservativeDefaults = {
    dispute_rate:    { threshold: 0.015, baseline: null, stdDev: null, sampleSize: 0, windowDays: 90 },
    refund_rate:     { threshold: 0.08,  baseline: null, stdDev: null, sampleSize: 0, windowDays: 90 },
    chargeback_rate: { threshold: 0.005, baseline: null, stdDev: null, sampleSize: 0, windowDays: 90 },
    revenue_trend:   { threshold: -0.20, baseline: null, stdDev: null, sampleSize: 0, windowDays: 90 },
  };

  for (const [signalType, cfg] of Object.entries(conservativeDefaults)) {
    await upsertThreshold(merchantId, signalType, cfg.threshold, false, cfg);
  }
}

// Update calibrated flag on a merchant's threshold record
async function markCalibrated(merchantId, signalType, calibrationData) {
  await pool.query(
    `UPDATE thresholds
     SET is_calibrated = TRUE,
         calibration_data = $3,
         updated_at = NOW()
     WHERE merchant_id = $1 AND signal_type = $2`,
    [merchantId, signalType, JSON.stringify(calibrationData)]
  );
}

module.exports = {
  upsertThreshold,
  upsertCalibratedThresholds,
  getThresholds,
  hasCalibratedThresholds,
  getLastCalibrationDate,
  getMerchantsForRecalibration,
  seedConservativeThresholds,
  markCalibrated,
};