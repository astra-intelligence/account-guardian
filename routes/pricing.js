/**
 * Pricing routes — standalone pricing page.
 * Owns: GET /pricing
 */

const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  // userEmail is injected by ifLoggedIn middleware
  const userEmail = res.locals.userEmail || null;
  res.render('pricing', { userEmail });
});

module.exports = router;