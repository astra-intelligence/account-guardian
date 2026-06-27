/**
 * Investors — query layer for investor portal entities.
 * investor, portfolio, portfolio_view, performance_metric, document, investor_session
 */
const { pool } = require('./index');

// ─── Investors ────────────────────────────────────────────────────────────────

async function getInvestorById(id) {
  const r = await pool.query('SELECT id, email, name, invited_at, confirmed_at, is_active, created_at FROM investors WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function getInvestorByEmail(email) {
  const r = await pool.query('SELECT * FROM investors WHERE LOWER(email) = LOWER($1)', [email]);
  return r.rows[0] || null;
}

async function createInvestor({ email, name, passwordHash }) {
  const r = await pool.query(
    `INSERT INTO investors (email, name, password_hash, confirmed_at)
     VALUES ($1, $2, $3, NOW())
     RETURNING id, email, name, invited_at, confirmed_at, is_active`,
    [email.toLowerCase(), name, passwordHash]
  );
  return r.rows[0];
}

async function updateInvestorLastActive(id) {
  await pool.query('UPDATE investors SET updated_at = NOW() WHERE id = $1', [id]);
}

// ─── Investor Sessions ────────────────────────────────────────────────────────

async function createInvestorSession(investorId, token, expiresAt) {
  const r = await pool.query(
    'INSERT INTO investor_sessions (investor_id, token, expires_at) VALUES ($1, $2, $3) RETURNING *',
    [investorId, token, expiresAt]
  );
  return r.rows[0];
}

async function getInvestorBySessionToken(token) {
  const r = await pool.query(
    `SELECT i.id, i.email, i.name, i.is_active
     FROM investor_sessions s
     JOIN investors i ON i.id = s.investor_id
     WHERE s.token = $1 AND s.expires_at > NOW() AND i.is_active = TRUE`,
    [token]
  );
  return r.rows[0] || null;
}

async function deleteSession(token) {
  await pool.query('DELETE FROM investor_sessions WHERE token = $1', [token]);
}

async function deleteSessionsByInvestor(investorId) {
  await pool.query('DELETE FROM investor_sessions WHERE investor_id = $1', [investorId]);
}

// ─── Portfolios ───────────────────────────────────────────────────────────────

// investors: uses email as the investor-chosen display name (no business_name in merchants table)
async function getPortfoliosByInvestor(investorId) {
  const r = await pool.query(
    `SELECT p.*,
            COUNT(DISTINCT pv.id) AS view_count,
            COUNT(DISTINCT pm.id) AS metric_count
     FROM portfolios p
     LEFT JOIN portfolio_views pv ON pv.portfolio_id = p.id
     LEFT JOIN performance_metrics pm ON pm.portfolio_view_id = pv.id
     WHERE p.investor_id = $1
     GROUP BY p.id
     ORDER BY p.created_at DESC`,
    [investorId]
  );
  return r.rows;
}

async function getPortfolioById(portfolioId, investorId) {
  const r = await pool.query(
    'SELECT * FROM portfolios WHERE id = $1 AND investor_id = $2',
    [portfolioId, investorId]
  );
  return r.rows[0] || null;
}

// ─── Portfolio Views ─────────────────────────────────────────────────────────

async function getPortfolioViews(portfolioId) {
  const r = await pool.query(
    `SELECT pv.*, m.email AS merchant_email, m.stripe_account_id, m.status AS merchant_status
     FROM portfolio_views pv
     JOIN merchants m ON m.id = pv.merchant_id
     WHERE pv.portfolio_id = $1 AND pv.visible_to_investor = TRUE
     ORDER BY pv.nickname NULLS LAST`,
    [portfolioId]
  );
  return r.rows;
}

async function getPortfolioViewById(portfolioViewId, investorId) {
  const r = await pool.query(
    `SELECT pv.*, m.email AS merchant_email, m.stripe_account_id, m.status AS merchant_status,
            p.investor_id
     FROM portfolio_views pv
     JOIN portfolios p ON p.id = pv.portfolio_id
     JOIN merchants m ON m.id = pv.merchant_id
     WHERE pv.id = $1 AND p.investor_id = $2 AND pv.visible_to_investor = TRUE`,
    [portfolioViewId, investorId]
  );
  return r.rows[0] || null;
}

// ─── Performance Metrics ──────────────────────────────────────────────────────

async function getPerformanceMetrics(portfolioViewId, { periodType, limit = 30 } = {}) {
  let sql = `
    SELECT period_start, period_end, period_type,
           revenue, revenue_growth_pct, transaction_count, avg_transaction_value,
           dispute_rate, auth_rate, chargeback_rate,
           alert_count, threshold_breach_count, captured_at
    FROM performance_metrics
    WHERE portfolio_view_id = $1`;
  const params = [portfolioViewId];

  if (periodType) {
    sql += ` AND period_type = $2`;
    params.push(periodType);
  }
  sql += ` ORDER BY period_start DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  const r = await pool.query(sql, params);
  return r.rows;
}

async function getAggregateMetrics(portfolioViewId, days = 90) {
  const safeDays = Math.max(1, Math.min(parseInt(days) || 90, 3650));
  const r = await pool.query(
    `SELECT
       COUNT(*) AS data_points,
       AVG(revenue) AS avg_revenue,
       AVG(revenue_growth_pct) AS avg_revenue_growth_pct,
       AVG(transaction_count) AS avg_transaction_count,
       AVG(avg_transaction_value) AS avg_transaction_value,
       AVG(dispute_rate) AS avg_dispute_rate,
       AVG(auth_rate) AS avg_auth_rate,
       SUM(alert_count) AS total_alerts,
       SUM(threshold_breach_count) AS total_breaches
     FROM performance_metrics
     WHERE portfolio_view_id = $1 AND period_start >= NOW() - (INTERVAL '1 day' * $2)`,
    [portfolioViewId, safeDays]
  );
  return r.rows[0];
}

// ─── Documents ────────────────────────────────────────────────────────────────

async function getDocuments(portfolioViewId) {
  const r = await pool.query(
    `SELECT d.*, i.name AS uploaded_by_name
     FROM documents d
     LEFT JOIN investors i ON i.id = d.uploaded_by
     WHERE d.portfolio_view_id = $1
     ORDER BY d.created_at DESC`,
    [portfolioViewId]
  );
  return r.rows;
}

module.exports = {
  getInvestorById,
  getInvestorByEmail,
  createInvestor,
  updateInvestorLastActive,
  createInvestorSession,
  getInvestorBySessionToken,
  deleteSession,
  deleteSessionsByInvestor,
  getPortfoliosByInvestor,
  getPortfolioById,
  getPortfolioViews,
  getPortfolioViewById,
  getPerformanceMetrics,
  getAggregateMetrics,
  getDocuments,
};