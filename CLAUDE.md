# Account Guardian — Landing Page + Support Escalation

**What this app does:** Stripe account protection service for DTC merchants — monitors Stripe signals, fires threshold alerts before Stripe acts, and handles support escalations when merchants reply. $79/month, 14-day free trial. Includes AI-powered triage for all merchant support replies within 4 business hours.

**Stack:** Express.js + EJS + Neon PostgreSQL on Render.

**Directory map:**
- `server.js` — Express entry point, health check, route mounts
- `routes/` — Route modules: `auth.js` (Stripe OAuth + user signup/login/logout), `audit.js` (free audit lead magnet), `billing.js` (Stripe Checkout + cancel), `webhooks.js` (Stripe webhook handler), `dashboard.js` (dashboard + settings), `onboarding.js` (signup + audit trigger), `email-webhook.js` (inbound merchant reply handling + support escalations), `stripe-connect-smoke.js` (OAuth smoke test at /api/_smoke/stripe-connect), `pricing.js` (standalone pricing page at /pricing), `investor-routes.js` (investor portal: GET /investor (SSR dashboard), GET /investor/dashboard (JSON), GET /investor/portfolio/:id (JSON), POST /investor/login, POST /investor/logout)
- `db/` — Database access: `index.js` (pool), `merchants.js`, `stripe-tokens.js`, `users.js`, `signals.js`, `thresholds.js`, `support-replies.js`, `investors.js` (investor portal: investor, portfolio, portfolio_view, performance_metric, document, investor_session)
- `services/` — External integrations: `stripe.js` (OAuth), `billing.js` (Stripe Checkout, customer, subscription), `email.js` (Postmark transactional), `calibration.js` (baseline threshold computation from 90-day Stripe history), `support.js` (AI-powered scenario triage for merchant replies)
- `middleware/` — Express middleware: `session.js` (merchant identification), `auth.js` (requireLogin, ifLoggedIn)
- `views/` — EJS templates: layout.ejs + partials/ + dashboard.ejs + settings.ejs + audit.ejs + auth-login.ejs + auth-signup.ejs + investor-dashboard.ejs
- `public/css/theme.css` — All styles (Account Guardian design system)
- `public/css/investor.css` — Investor portal supplemental styles
- `lib/landing-context.js` — Render context builder
- `jobs/` — Background jobs: `onboarding-cron.js`, `trial-conversion-cron.js`, `daily-monitoring-cron.js`, `run-calibration.js`, `support-inbox-cron.js` (safety-net for missed email webhook deliveries)
- `migrate.js` — Database migration runner
- `docs/support-templates.md` — Response templates for all support scenarios (false positive, ban despite alert, how-to-fix, cancellation, general)

**Database:** Neon PostgreSQL.
- `merchants` — Stripe account owners: trial/active/churned/suspended/audit_requested/pending/connected/audited/expired. New: churn_reason, churned_at, manual_review_flag, support_ticket_id, support_ticket_created_at, last_escalation_at
- `stripe_tokens` — OAuth tokens per merchant (access/refresh + expiry)
- `signal_history` — Time-series Stripe signal captures (dispute_rate, auth_rate, revenue_trend, transaction_velocity, low_volume)
- `alerts` — Fired threshold breaches. New: user_adjusted_threshold, flagged_false_positive, false_positive_reported_at
- `thresholds` — Per-merchant signal thresholds (calibrated from baseline)
- `threshold_presets` — Seed data: conservative / standard / aggressive calibration presets
- `users` — User accounts for auth: email, password_hash, name
- `support_replies` — Log of inbound merchant emails (via Polsia email webhook or inbox poll), with scenario classification, response status, and template used
- `investors` — Investor portal user accounts: email, name, bcrypt password hash, invite/confirm timestamps, is_active
- `portfolios` — Groups of portfolio_views per investor (e.g. "Seed Fund I")
- `portfolio_views` — A merchant account linked to an investor portfolio (merchant_id is UUID, matches merchants.id; visible_to_investor flag)
- `performance_metrics` — Time-series per portfolio_view: revenue, growth, transaction counts, dispute/auth rates, alert counts (period_type: day/week/month/quarter)
- `documents` — Investor-facing documents per portfolio_view: cap table, financial reports, board decks, term sheets
- `investor_sessions` — Token-based auth sessions for investor portal (separate from merchant session cookies)

**External integrations:** Stripe Connect OAuth (read_only scope). Stripe Billing API (Checkout, Subscriptions, Webhooks). Polsia email proxy (inbound replies to foundryiq@polsia.app + outbound replies). Postmark for alert/transactional emails.

**Env vars required:**
- `DATABASE_URL` — Neon PostgreSQL connection string
- `STRIPE_CLIENT_ID` — Stripe Connect OAuth client ID
- `STRIPE_SECRET_KEY` — Stripe secret key (also used for Billing API)
- `STRIPE_WEBHOOK_SECRET` — Stripe webhook signing secret
- `APP_URL` — Public app URL. Must match Stripe Dashboard registered redirect URI.
- `POSTMARK_API_KEY` — Postmark API key for transactional email (alerts, dunning)
- `POLSIA_API_KEY` — Polsia API key for email proxy (inbound/outbound support replies) and AI triage
- `POLSIA_API_URL` — Polsia API base URL (default: https://polsia.com/api/proxy/ai)
- `SESSION_SECRET` — Express session secret

**Recent changes:**
- 2026-06-27 — Added investor portal dashboard page: `views/investor-dashboard.ejs` (server-side rendered) + `public/css/investor.css`. GET /investor/ now serves the full portfolio dashboard (active commitments, portfolio views with metrics, funding round history, cap table position, distribution history — stubs for latter two until tables are added). Routes updated in `routes/investor-routes.js`.
- 2026-06-25 — Built investor portal data model: `migrations/1751437200_investor_portal.js` (investors, portfolios, portfolio_views, performance_metrics, documents, investor_sessions tables), `db/investors.js` (full query layer), `routes/investor-routes.js` (GET /investor/dashboard, GET /investor/portfolio/:id, POST /investor/login/logout — token-based auth via X-Investor-Token header). Added `investor-routes.js` and `investors.js` to `package.json` preflight.
- 2026-06-22 — Added `/pricing` route (`routes/pricing.js` + `views/pricing.ejs`) — standalone pricing page with proper CTAs for logged-in users (Upgrade) and logged-out users (Start Free Trial). Nav link updated from `/#pricing` anchor to `/pricing`. Also fixed `package.json` preflight to include all existing route/service/db/job files (previously missing `pricing.js`, `email-webhook.js`, `stripe-connect-smoke.js`, `support.js`, `support-replies.js`, `support-inbox-cron.js`).
- 2026-06-21 — Added Stripe Connect OAuth smoke test: `routes/stripe-connect-smoke.js` at `/api/_smoke/stripe-connect` (public, 5 checks: env vars, token exchange includes redirect_uri for 2026-06-20 fix, DB has connected merchants with tokens, webhook rejects unsigned, Stripe token endpoint reachable). Also `scripts/smoke-stripe-connect.js` standalone script for cron-based alerting. Uses axios only (no stripe SDK dependency). Added `getConnectedMerchants()` to `db/merchants.js`.
- 2026-06-20 — Fixed `token_exchange_failed` on Stripe OAuth callback: services/stripe.js exchangeCode now includes `redirect_uri` in POST params (Stripe OAuth requires this for `grant_type=authorization_code`). Previously removed in 2026-06-17 change but Stripe rejects the request without it.
- 2026-06-17 — OAuth onboarding flow fix: APP_URL updated to `https://foundryiq-3.polsia.app` (accountguardian.polsia.app returns 403 blocked-by-allowlist — OAuth callbacks silently fail). `/buy` route now routes directly to Stripe OAuth instead of login→billing (which required Stripe already connected). Email template links inherit correct domain from APP_URL env var.
- 2026-06-15 — Built support escalation system: Polsia email webhook (POST /api/webhook/email) receives merchant replies, classifies scenario via AI triage (false_positive/ban_despite_alert/how_to_fix/cancellation/general), drafts and sends response via Polsia email proxy within 4 business hours. False positives mark thresholds as user-adjusted. Ban scenarios flag for manual review and open support ticket. Cancellations log churn reason. Support inbox cron (jobs/support-inbox-cron.js) as safety net. docs/support-templates.md stores all 5 templates. New DB columns on merchants (churn_reason, manual_review_flag, etc.) and alerts (flagged_false_positive, user_adjusted_threshold), new support_replies table.
- 2026-06-14 — Fixed Stripe Connect OAuth `token_exchange_failed`: APP_URL env var mismatched the Stripe Dashboard registered redirect URI (`accountguardian.polsia.app`). APP_URL now set to `https://accountguardian.polsia.app`. Added detailed error logging to capture Stripe error descriptions in production.
- 2026-06-11 — Fixed audit speed (<1h, inline on OAuth callback), wired trial day 14 cutoff (mark expired in DB + send offboarding email), replaced 5 signals (dispute/chargeback redundancy removed → dispute rate, auth rate, revenue trend, transaction velocity, low volume).
- 2026-06-11 — Built Threshold Calibration System: post-OAuth runs calibration job that pulls 90-day Stripe history, computes mean + std_dev per signal, sets calibrated thresholds at mean + 2σ (statistically unusual deviation only, not seasonal variance). Baseline report email sent to merchant. Merchants with <10 charge records get conservative defaults and auto-recalibrate after 30 days. Recalibration cron every 90 days. Daily monitoring uses calibrated thresholds (falls back to fixed thresholds).
- 2026-06-11 — Built user auth system: bcryptjs password hashing, express-session cookies, /auth/signup + /auth/login + /auth/logout + /auth/me endpoints, auth middleware protecting /dashboard and /settings. Nav shows Sign In/Get Started when logged out, Dashboard + Sign Out when logged in.