/**
 * Signals — signal_history, alerts, thresholds queries.
 * Does NOT own signal capture logic (services/stripe.js handles that).
 */
const { pool } = require('./index');

// All supported signal types
// dispute_rate includes chargeback rate as input — no separate chargeback_rate signal
// Five distinct signals: dispute risk, auth rate, revenue drop, transaction velocity, low volume
const SIGNAL_TYPES = ['dispute_rate', 'auth_rate', 'revenue_trend', 'transaction_velocity', 'low_volume'];

const SIGNAL_LABELS = {
  dispute_rate: 'Dispute Rate',        // High dispute rate (chargebacks folded in)
  auth_rate: 'Auth Rate',              // Failed payment attempts / decline rate
  revenue_trend: 'Revenue Trend',      // Week-over-week revenue change
  transaction_velocity: 'Tx Velocity', // Unusual transaction patterns
  low_volume: 'Low Volume',            // Sudden transaction volume drop
};

// Get latest signal value for a merchant (one row per signal type)
async function getLatestSignals(merchantId) {
  const result = await pool.query(`
    SELECT DISTINCT ON (signal_type) *
    FROM signal_history
    WHERE merchant_id = $1
    ORDER BY signal_type, captured_at DESC
  `, [merchantId]);
  return result.rows;
}

// Get 30-day signal history for a merchant and signal type (for chart)
async function getSignalHistory(merchantId, signalType, days = 30) {
  const result = await pool.query(`
    SELECT value, captured_at
    FROM signal_history
    WHERE merchant_id = $1
      AND signal_type = $2
      AND captured_at >= NOW() - INTERVAL '${days} days'
    ORDER BY captured_at ASC
  `, [merchantId, signalType]);
  return result.rows;
}

// Get all alerts for a merchant, newest first
async function getAlerts(merchantId, { filter = 'all', limit = 50 } = {}) {
  let whereClause = 'WHERE merchant_id = $1';
  if (filter === 'this_month') {
    whereClause += ` AND fired_at >= DATE_TRUNC('month', NOW())`;
  } else if (filter === 'acknowledged') {
    whereClause += ' AND acknowledged = TRUE';
  }

  const result = await pool.query(`
    SELECT *
    FROM alerts
    ${whereClause}
    ORDER BY fired_at DESC
    LIMIT $2
  `, [merchantId, limit]);
  return result.rows;
}

// Get unacknowledged alert count
async function getUnacknowledgedAlertCount(merchantId) {
  const result = await pool.query(
    'SELECT COUNT(*) as count FROM alerts WHERE merchant_id = $1 AND acknowledged = FALSE',
    [merchantId]
  );
  return parseInt(result.rows[0].count, 10);
}

// Get merchant's thresholds
async function getThresholds(merchantId) {
  const result = await pool.query(
    'SELECT * FROM thresholds WHERE merchant_id = $1',
    [merchantId]
  );
  return result.rows;
}

// Get default threshold preset values
async function getDefaultThresholds() {
  const result = await pool.query(`
    SELECT signal_type, threshold_value
    FROM threshold_presets
    WHERE name = 'standard'
    ORDER BY signal_type
  `);
  return result.rows; // [{ signal_type, threshold_value }, ...]
}

// Get most recent alert (for remediation guide focus)
async function getMostRecentAlert(merchantId) {
  const result = await pool.query(`
    SELECT * FROM alerts
    WHERE merchant_id = $1
    ORDER BY fired_at DESC
    LIMIT 1
  `, [merchantId]);
  return result.rows[0] || null;
}

// ── Writers ──────────────────────────────────────────────────────────────────

// Insert a signal capture into signal_history
async function insertSignal(merchantId, signalType, value) {
  await pool.query(
    `INSERT INTO signal_history (merchant_id, signal_type, value, captured_at)
     VALUES ($1, $2, $3, NOW())`,
    [merchantId, signalType, value]
  );
}

// Insert multiple signals in a batch (one captured_at timestamp)
async function insertSignalsBatch(merchantId, signals) {
  if (!signals || signals.length === 0) return;

  const values = [];
  const params = [merchantId];
  let paramIdx = 2;

  for (const s of signals) {
    values.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, NOW())`);
    params.push(s.signal_type, s.value);
    paramIdx += 3;
  }

  await pool.query(
    `INSERT INTO signal_history (merchant_id, signal_type, value, captured_at) VALUES ${values.join(', ')}`,
    params
  );
}

// Insert a fired alert into the alerts table
async function insertAlert(merchantId, signalType, thresholdValue, actualValue, severity) {
  const result = await pool.query(
    `INSERT INTO alerts (merchant_id, signal_type, threshold_value, actual_value, severity)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [merchantId, signalType, thresholdValue, actualValue, severity]
  );
  return result.rows[0];
}

// Get the most recent signal value for a specific signal type
async function getLatestSignalValue(merchantId, signalType) {
  const result = await pool.query(
    `SELECT value FROM signal_history
     WHERE merchant_id = $1 AND signal_type = $2
     ORDER BY captured_at DESC LIMIT 1`,
    [merchantId, signalType]
  );
  return result.rows[0] ? result.rows[0].value : null;
}

// Get revenue for a specific day range (for week-over-week comparison)
async function getRevenueRange(merchantId, daysAgoStart, daysAgoEnd) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(value), 0) as revenue
     FROM signal_history
     WHERE merchant_id = $1
       AND signal_type = 'revenue'
       AND captured_at >= NOW() - INTERVAL '${daysAgoEnd} days'
       AND captured_at < NOW() - INTERVAL '${daysAgoStart} days'`,
    [merchantId]
  );
  return parseFloat(result.rows[0].revenue);
}

// Check if an alert was already fired today for a given signal type
async function getTodayAlertCount(merchantId, signalType) {
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM alerts
     WHERE merchant_id = $1
       AND signal_type = $2
       AND fired_at >= DATE_TRUNC('day', NOW())`,
    [merchantId, signalType]
  );
  return parseInt(result.rows[0].count, 10);
}

// Acknowledge an alert
async function acknowledgeAlert(alertId) {
  await pool.query(
    `UPDATE alerts SET acknowledged = TRUE, acknowledged_at = NOW() WHERE id = $1`,
    [alertId]
  );
}

module.exports = {
  SIGNAL_TYPES,
  SIGNAL_LABELS,
  getLatestSignals,
  getSignalHistory,
  getAlerts,
  getUnacknowledgedAlertCount,
  getThresholds,
  getDefaultThresholds,
  getMostRecentAlert,
  // Writers
  insertSignal,
  insertSignalsBatch,
  insertAlert,
  getLatestSignalValue,
  getRevenueRange,
  getTodayAlertCount,
  acknowledgeAlert,
};