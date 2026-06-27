/**
 * Stripe Tokens — CRUD for OAuth tokens stored per merchant.
 */
const { pool } = require('./index');

async function upsertToken(merchantId, { accessToken, refreshToken, expiresAt }) {
  const result = await pool.query(
    `INSERT INTO stripe_tokens (merchant_id, access_token, refresh_token, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (merchant_id) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       expires_at = EXCLUDED.expires_at,
       created_at = NOW()
     RETURNING *`,
    [merchantId, accessToken, refreshToken, expiresAt || null]
  );
  return result.rows[0];
}

async function getTokenByMerchantId(merchantId) {
  const result = await pool.query(
    'SELECT * FROM stripe_tokens WHERE merchant_id = $1',
    [merchantId]
  );
  return result.rows[0] || null;
}

async function deleteTokenByMerchantId(merchantId) {
  await pool.query('DELETE FROM stripe_tokens WHERE merchant_id = $1', [merchantId]);
}

module.exports = {
  upsertToken,
  getTokenByMerchantId,
  deleteTokenByMerchantId,
};