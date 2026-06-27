/**
 * Support replies — logs inbound merchant emails and tracks response status.
 * Owns: support_replies table CRUD.
 */
const { pool } = require('./index');

// Insert a new support reply (inbound merchant email)
async function insertReply(merchantId, emailId, fromEmail, subject, textBody, scenario) {
  const result = await pool.query(
    `INSERT INTO support_replies (merchant_id, email_id, from_email, subject, text_body, scenario)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (email_id) DO NOTHING
     RETURNING *`,
    [merchantId, emailId, fromEmail, subject, textBody, scenario]
  );
  return result.rows[0] || null;
}

// Mark reply as responded
async function markReplied(replyId, responseTemplate) {
  await pool.query(
    `UPDATE support_replies
     SET response_sent_at = NOW(), response_template = $2
     WHERE id = $1`,
    [replyId, responseTemplate]
  );
}

// Get all replies for a merchant
async function getRepliesForMerchant(merchantId, limit = 50) {
  const result = await pool.query(
    `SELECT * FROM support_replies
     WHERE merchant_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [merchantId, limit]
  );
  return result.rows;
}

// Get recent unresponded replies
async function getUnrespondedReplies(limit = 20) {
  const result = await pool.query(
    `SELECT sr.*, m.email as merchant_email, m.name as merchant_name
     FROM support_replies sr
     JOIN merchants m ON m.id = sr.merchant_id
     WHERE sr.response_sent_at IS NULL
       AND sr.created_at < NOW() - INTERVAL '30 minutes'
     ORDER BY sr.created_at ASC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

// Mark reply as responded by email_id (called from email webhook handler)
async function markRepliedByEmailId(emailId, template) {
  await pool.query(
    `UPDATE support_replies
     SET response_sent_at = NOW(), response_template = $2
     WHERE email_id = $1 AND response_sent_at IS NULL`,
    [String(emailId), template]
  );
}

// Mark recent alerts as false positive for a merchant
async function markFalsePositive(merchantId) {
  await pool.query(
    `UPDATE alerts
     SET flagged_false_positive = TRUE, false_positive_reported_at = NOW(), user_adjusted_threshold = TRUE
     WHERE merchant_id = $1
       AND fired_at >= NOW() - INTERVAL '7 days'
       AND flagged_false_positive = FALSE
     ORDER BY fired_at DESC
     LIMIT 3`,
    [merchantId]
  );
}

// Upsert support reply (used by email webhook and inbox cron)
async function saveSupportReply(merchantId, emailId, fromEmail, subject, textBody, scenario) {
  const result = await pool.query(
    `INSERT INTO support_replies (merchant_id, email_id, from_email, subject, text_body, scenario)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (email_id) DO UPDATE SET
       subject = EXCLUDED.subject,
       text_body = EXCLUDED.text_body,
       scenario = EXCLUDED.scenario
     RETURNING *`,
    [merchantId, emailId, fromEmail, subject, textBody, scenario]
  );
  return result.rows[0];
}

module.exports = {
  insertReply,
  markReplied,
  getRepliesForMerchant,
  getUnrespondedReplies,
  saveSupportReply,
  markRepliedByEmailId,
  markFalsePositive,
};