/**
 * Demo routes — public, no auth required.
 * Serves the Account Guardian dashboard with mock data so prospects
 * can walk through the product without connecting a Stripe account.
 *
 * Routes:
 *   GET  /demo                 — Demo dashboard (renders demo.ejs)
 *   GET  /demo/signals/:type/json  — Mock 30-day chart data
 */
const express = require('express');
const router = express.Router();
const { buildDemoContext, getSignalHistory, SIGNAL_TYPES } = require('../lib/demo-data');

// GET /demo — public demo dashboard
router.get('/', (_req, res) => {
  const context = buildDemoContext();
  res.render('demo', context);
});

// GET /demo/signals/:type/json — mock 30-day chart data (supports chart rendering in demo)
router.get('/signals/:type/json', (req, res) => {
  const signalType = req.params.type;
  if (!SIGNAL_TYPES.includes(signalType) && signalType !== 'risk_flag') {
    return res.status(400).json({ error: 'Invalid signal type' });
  }
  const history = getSignalHistory(signalType);
  res.json({ signal_type: signalType, history });
});

module.exports = router;
