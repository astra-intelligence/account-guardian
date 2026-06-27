/**
 * Investor Portal routes — investor-facing reporting (FoundryIQ).
 * Owns: GET /investor (dashboard), GET /investor/dashboard (json),
 *       GET /investor/portfolio/:id (json), POST /investor/login, POST /investor/logout
 * Does NOT own: merchant auth, Stripe OAuth, billing.
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const {
  getInvestorBySessionToken,
  getPortfoliosByInvestor,
  getPortfolioViews,
  getPortfolioViewById,
  getPerformanceMetrics,
  getAggregateMetrics,
  getDocuments,
  updateInvestorLastActive,
} = require('../db/investors');

// ─── Auth middleware (token-based for investor portal) ───────────────────────

function requireInvestorAuth(req, res, next) {
  const token = req.headers['x-investor-token'] || req.cookies?.investor_token;
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  getInvestorBySessionToken(token).then(investor => {
    if (!investor) return res.status(401).json({ error: 'Invalid or expired session' });
    req.investor = investor;
    updateInvestorLastActive(investor.id).catch(() => {}); // non-critical
    next();
  }).catch(err => {
    console.error('[investor-routes] session check failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  });
}

// ─── Helper: enrich portfolio views with latest metrics ─────────────────────

async function enrichPortfolioViews(portfolioViews) {
  return Promise.all(portfolioViews.map(async pv => {
    const [recentMetrics, aggregates, documents] = await Promise.all([
      getPerformanceMetrics(pv.id, { periodType: 'day', limit: 7 }),
      getAggregateMetrics(pv.id, 90),
      getDocuments(pv.id),
    ]);
    return {
      id: pv.id,
      merchant_id: pv.merchant_id,
      nickname: pv.nickname,
      merchant_email: pv.merchant_email,
      merchant_status: pv.merchant_status,
      recent_metrics: recentMetrics,
      aggregates: aggregates,
      document_count: documents.length,
    };
  }));
}

// ─── GET /investor/ — server-side rendered dashboard page ─────────────────

router.get('/', requireInvestorAuth, async (req, res) => {
  try {
    const investor = req.investor;

    const portfolios = await getPortfoliosByInvestor(investor.id);

    const enrichedPortfolios = await Promise.all(portfolios.map(async p => {
      const views = await getPortfolioViews(p.id);
      const enrichedViews = await Promise.all(views.map(async pv => {
        const [recentMetrics, aggregates, documents] = await Promise.all([
          getPerformanceMetrics(pv.id, { periodType: 'day', limit: 7 }),
          getAggregateMetrics(pv.id, 90),
          getDocuments(pv.id),
        ]);
        return {
          id: pv.id,
          merchant_id: pv.merchant_id,
          nickname: pv.nickname,
          merchant_email: pv.merchant_email,
          merchant_status: pv.merchant_status,
          recent_metrics: recentMetrics,
          aggregates: aggregates,
          document_count: documents.length,
        };
      }));
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        created_at: p.created_at,
        view_count: enrichedViews.length,
        views: enrichedViews,
      };
    }));

    // Summary stats across all portfolios
    let totalMerchants = 0;
    let totalAlerts = 0;
    let totalRevenue = 0;
    for (const portfolio of enrichedPortfolios) {
      totalMerchants += portfolio.views.length;
      for (const v of portfolio.views) {
        if (v.aggregates) {
          totalAlerts += parseInt(v.aggregates.total_alerts || 0);
          totalRevenue += parseFloat(v.aggregates.avg_revenue || 0) * parseInt(v.aggregates.data_points || 0);
        }
      }
    }

    const summary = {
      portfolio_count: enrichedPortfolios.length,
      total_merchants: totalMerchants,
      total_recent_revenue: totalRevenue,
      total_alerts_90d: totalAlerts,
    };

    res.render('investor-dashboard', {
      investor,
      summary,
      portfolios: enrichedPortfolios,
      // Sections for other data — populated as tables are added
      fundingRounds: [],
      capTable: [],
      distributions: [],
    });
  } catch (err) {
    console.error('[investor-routes] dashboard page error:', err);
    res.status(500).send('Failed to load dashboard');
  }
});

// ─── GET /investor/dashboard ──────────────────────────────────────────────────

router.get('/dashboard', requireInvestorAuth, async (req, res) => {
  try {
    const investor = req.investor;

    const portfolios = await getPortfoliosByInvestor(investor.id);

    const enrichedPortfolios = await Promise.all(portfolios.map(async p => {
      const views = await getPortfolioViews(p.id);
      const enrichedViews = await enrichPortfolioViews(views);
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        created_at: p.created_at,
        view_count: p.view_count,
        views: enrichedViews,
      };
    }));

    // Summary stats across all portfolios
    let totalMerchants = 0;
    let totalAlerts = 0;
    let totalRevenue = 0;
    for (const portfolio of enrichedPortfolios) {
      totalMerchants += portfolio.views.length;
      for (const v of portfolio.views) {
        if (v.aggregates) {
          totalAlerts += parseInt(v.aggregates.total_alerts || 0);
          totalRevenue += parseFloat(v.aggregates.avg_revenue || 0) * parseInt(v.aggregates.data_points || 0);
        }
      }
    }

    res.json({
      investor: {
        id: investor.id,
        email: investor.email,
        name: investor.name,
      },
      summary: {
        portfolio_count: enrichedPortfolios.length,
        total_merchants: totalMerchants,
        total_recent_revenue: totalRevenue,
        total_alerts_90d: totalAlerts,
      },
      portfolios: enrichedPortfolios,
    });
  } catch (err) {
    console.error('[investor-routes] dashboard error:', err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ─── GET /investor/portfolio/:id ─────────────────────────────────────────────

router.get('/portfolio/:id', requireInvestorAuth, async (req, res) => {
  try {
    const investor = req.investor;
    const portfolioId = parseInt(req.params.id, 10);
    if (isNaN(portfolioId)) {
      return res.status(400).json({ error: 'Invalid portfolio ID' });
    }

    const portfolio = await (async () => {
      const r = await require('../db/investors').getPortfolioById(portfolioId, investor.id);
      return r;
    })();

    if (!portfolio) {
      return res.status(404).json({ error: 'Portfolio not found or access denied' });
    }

    const views = await getPortfolioViews(portfolio.id);
    const enrichedViews = await enrichPortfolioViews(views);

    // Period filter (default: last 90 days)
    const periodType = ['day', 'week', 'month', 'quarter'].includes(req.query.period)
      ? req.query.period
      : 'day';
    const limit = Math.min(parseInt(req.query.limit) || 90, 365);

    // Aggregate across all views in this portfolio
    const allMetrics = await Promise.all(
      enrichedViews.map(v => getPerformanceMetrics(v.id, { periodType, limit }))
    );

    res.json({
      portfolio: {
        id: portfolio.id,
        name: portfolio.name,
        description: portfolio.description,
        created_at: portfolio.created_at,
      },
      views: enrichedViews,
      metrics_by_view: enrichedViews.map((v, i) => ({
        view_id: v.id,
        nickname: v.nickname,
        merchant_email: v.merchant_email,
        metrics: allMetrics[i],
      })),
      period: periodType,
      limit,
    });
  } catch (err) {
    console.error('[investor-routes] portfolio error:', err);
    res.status(500).json({ error: 'Failed to load portfolio' });
  }
});

// ─── POST /investor/login (email + password) ──────────────────────────────────

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const bcrypt = require('bcryptjs');
    const investor = await (async () => {
      const r = await require('../db/investors').getInvestorByEmail(email);
      return r;
    })();

    if (!investor || !investor.password_hash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, investor.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!investor.is_active) {
      return res.status(403).json({ error: 'Account is not active' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await require('../db/investors').createInvestorSession(investor.id, token, expiresAt);
    await require('../db/investors').updateInvestorLastActive(investor.id);

    res.json({
      token,
      expires_at: expiresAt.toISOString(),
      investor: { id: investor.id, email: investor.email, name: investor.name },
    });
  } catch (err) {
    console.error('[investor-routes] login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ─── POST /investor/logout ────────────────────────────────────────────────────

router.post('/logout', requireInvestorAuth, async (req, res) => {
  const token = req.headers['x-investor-token'] || req.cookies?.investor_token;
  if (token) {
    await require('../db/investors').deleteSession(token);
  }
  res.json({ ok: true });
});

module.exports = router;