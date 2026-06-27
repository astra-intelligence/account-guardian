/**
 * Stripe service — OAuth token exchange and token revocation.
 * Does NOT handle daily monitoring or signal capture — that comes next.
 */

const axios = require('axios');

const STRIPE_OAUTH_BASE = 'https://connect.stripe.com';
const TOKEN_URL = `${STRIPE_OAUTH_BASE}/oauth/token`;
const REVOKE_URL = `${STRIPE_OAUTH_BASE}/oauth/revoke`;

/**
 * Exchange an authorization code for access + refresh tokens.
 */
async function exchangeCode(code, redirectUri) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: process.env.STRIPE_CLIENT_ID,
    client_secret: process.env.STRIPE_SECRET_KEY,
    redirect_uri: redirectUri,
  });

  let response;
  try {
    response = await axios.post(TOKEN_URL, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  } catch (err) {
    const detail = err.response?.data;
    console.error('[stripe] OAuth token exchange error:', JSON.stringify(detail));
    const stripeErr = new Error(detail?.error_description || detail?.error || err.message);
    stripeErr.stripeResponse = detail;
    stripeErr.httpStatus = err.response?.status;
    throw stripeErr;
  }

  return {
    accessToken: response.data.access_token,
    refreshToken: response.data.refresh_token,
    expiresAt: response.data.expires_at
      ? new Date(response.data.expires_at * 1000)
      : null,
    stripeUserId: response.data.stripe_user_id,
  };
}

/**
 * Refresh an access token using a stored refresh token.
 */
async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: process.env.STRIPE_CLIENT_ID,
    client_secret: process.env.STRIPE_SECRET_KEY,
  });

  const response = await axios.post(TOKEN_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  return {
    accessToken: response.data.access_token,
    refreshToken: response.data.refresh_token || refreshToken,
    expiresAt: response.data.expires_at
      ? new Date(response.data.expires_at * 1000)
      : null,
  };
}

/**
 * Revoke an access token (disconnect flow).
 */
async function revokeToken(accessToken) {
  const params = new URLSearchParams({
    client_id: process.env.STRIPE_CLIENT_ID,
    client_secret: process.env.STRIPE_SECRET_KEY,
    token: accessToken,
  });

  await axios.post(REVOKE_URL, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

/**
 * Check if an access token is expired or about to expire (within 5 minutes).
 */
function isTokenExpiringSoon(expiresAt) {
  if (!expiresAt) return false;
  return Date.now() >= expiresAt.getTime() - 5 * 60 * 1000;
}

module.exports = {
  exchangeCode,
  refreshAccessToken,
  revokeToken,
  isTokenExpiringSoon,
};