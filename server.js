/**
 * Account Guardian — Express entry point.
 * Middleware setup, route mounts, and health check.
 */
const express = require('express');
const path = require('path');
const session = require('express-session');
const { buildLandingContext } = require('./lib/landing-context');
const { requireLogin, ifLoggedIn } = require('./middleware/auth');
const emailService = require('./services/email');
require('./db/index'); // init pool (singleton)

const app = express();
const port = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

// Webhook route must be mounted BEFORE express.json() so raw body is preserved for signature verification
const webhooksRouter = require('./routes/webhooks');
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }), webhooksRouter);

// Email webhook — inbound merchant replies to alert emails (Polsia email proxy)
const emailWebhookRouter = require('./routes/email-webhook');
app.use('/api', emailWebhookRouter);

// Stripe Connect OAuth smoke test — public, no auth
const stripeConnectSmokeRouter = require('./routes/stripe-connect-smoke');
app.use('/api/_smoke', stripeConnectSmokeRouter);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// EJS view engine. Templates live in ./views/ (entry point: layout.ejs).
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Initialize email service with Express app reference for EJS template rendering.
emailService.init(app);

// Health check (no DB query — lets Neon auto-suspend)
app.get('/health', (_req, res) => res.json({ status: 'healthy' }));

// Stripe key verification — fires after env vars are live (webhook + postmark vars added 2026-06-11)
app.get('/health/stripe', async (_req, res) => {
  try {
    const { healthCheck } = require('./services/billing');
    const result = await healthCheck();
    res.json({ stripe: 'ok', mode: result.mode, account: result.accountId });
  } catch (err) {
    const code = err.response?.status || 500;
    res.status(code).json({ stripe: 'error', message: err.message });
  }
});

// Serve static files from public/ (auto-index disabled for /)
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Session middleware — cookie-based sessions for user auth
app.use(session({
  secret: process.env.SESSION_SECRET || 'REDACTED',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }, // 7 days
}));

// Inject user info into res.locals for all EJS templates
app.use(ifLoggedIn);

// Routes
app.use('/auth', require('./routes/auth'));
app.use('/audit', require('./routes/audit'));
app.use('/billing', require('./routes/billing'));
app.use('/dashboard', requireLogin, require('./routes/dashboard'));
app.use('/settings', requireLogin, require('./routes/dashboard'));
app.use('/api/audit', require('./routes/audit'));
app.use('/onboarding', require('./routes/onboarding'));
app.use('/pricing', require('./routes/pricing'));
app.use('/investor', require('./routes/investor-routes'));

// Demo route — public, no auth, mock data
app.use('/demo', require('./routes/demo'));

// /buy — start Stripe OAuth connection (directs to dashboard after auth).
// Works with or without a session — email taken from query param or session.
app.get('/buy', (req, res) => {
  const email = req.query.email || (req.session && req.session.userEmail);
  if (!email || !email.includes('@')) {
    // No email — go to landing to capture it
    return res.redirect('/auth/signup?return=' + encodeURIComponent('/buy'));
  }
  res.redirect(`/auth/stripe?email=${encodeURIComponent(email)}`);
});

app.get('/', (_req, res) => {
  res.render('layout', buildLandingContext());
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});