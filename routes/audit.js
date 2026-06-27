/**
 * Audit routes — free Stripe account audit lead magnet.
 *
 * GET  /audit       — audit page with form
 * POST /api/audit   — form submission: save lead, send confirmation email
 */

const express = require('express');
const router = express.Router();

const { createAuditLead, getMerchantByEmail } = require('../db/merchants');
const { sendAuditConfirmation, sendAuditReport } = require('../services/email');

const BASE_URL = process.env.APP_URL || 'https://foundryiq-3.polsia.app';

// GET /audit — render the audit page
router.get('/', (_req, res) => {
  res.render('audit');
});

// POST /api/audit — handle form submission
router.post('/', async (req, res) => {
  try {
    const { email, website } = req.body;

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid email is required' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Check for duplicate lead
    const existing = await getMerchantByEmail(normalizedEmail);
    if (existing && existing.status === 'audit_requested') {
      return res.json({ success: true, message: 'Your audit is already queued — check your inbox.' });
    }

    // Create or update merchant as audit lead
    const merchant = await createAuditLead(normalizedEmail, website || null);

    // Send confirmation email — fire-and-forget so email errors don't crash the response
    sendAuditConfirmation(normalizedEmail, merchant.id).catch(err => {
      console.error('[audit] Confirmation email failed:', err.message);
    });

    return res.json({
      success: true,
      message: "Your audit is queued — we'll send your report shortly.",
    });
  } catch (err) {
    console.error('[audit] POST /api/audit error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;