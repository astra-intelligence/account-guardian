/**
 * Session middleware — email-based merchant identification.
 * For a production app, replace with signed JWT cookies or a proper session store.
 * Currently: merchant identified by email param or query param.
 */
const { getMerchantByEmail } = require('../db/merchants');

/**
 * Middleware: resolve merchant from email param / query and attach to req.merchant.
 * Responds 400 if no email provided. 401 if merchant not found.
 */
async function requireMerchant(req, res, next) {
  const email = req.params.email || req.query.email || req.body.email;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }
  const merchant = await getMerchantByEmail(email);
  if (!merchant) {
    return res.status(401).json({ error: 'Merchant not found' });
  }
  req.merchant = merchant;
  next();
}

module.exports = { requireMerchant };