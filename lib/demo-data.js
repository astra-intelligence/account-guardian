/**
 * Demo / mock data module for Account Guardian public demo.
 * Exports realistic-looking mock merchant data, signal values, alerts,
 * and chart history. No database or credentials needed.
 */

const SIGNAL_TYPES = ['dispute_rate', 'auth_rate', 'revenue_trend', 'transaction_velocity', 'low_volume'];

const SIGNAL_LABELS = {
  dispute_rate: 'Dispute Rate',
  auth_rate: 'Auth Rate',
  revenue_trend: 'Revenue Trend',
  transaction_velocity: 'Tx Velocity',
  low_volume: 'Low Volume',
};

const DEMO_MERCHANT = {
  id: 'demo-mock-merchant-001',
  email: 'demo@accountguardian.app',
  name: 'Demo Merchant',
  stripe_account_id: 'acct_demo_mock',
  subscription_status: 'active',
  trial_ends_at: null,
  status: 'active',
};

// Current mock signal values (latest capture)
const LATEST_SIGNAL_VALUES = {
  dispute_rate: 3.7,        // Exceeded — threshold is 3.5
  auth_rate: 8.2,           // Near threshold (threshold is 10.0)
  revenue_trend: -2.1,      // Normal (threshold is -5.0)
  transaction_velocity: 14.5, // Normal (threshold is 25.0)
  low_volume: -18.3,        // Near threshold (threshold is -20.0)
};

const SIGNAL_THRESHOLDS = {
  dispute_rate: 3.5,
  auth_rate: 10.0,
  revenue_trend: -5.0,
  transaction_velocity: 25.0,
  low_volume: -20.0,
};

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// Generate 30 days of mock chart data for each signal type
function generateChartData(signalType) {
  const base = {
    dispute_rate: 1.2,
    auth_rate: 5.0,
    revenue_trend: 1.5,
    transaction_velocity: 8.0,
    low_volume: -5.0,
  }[signalType] || 0;

  const trend = {
    dispute_rate: 0.08,  // gradual rise
    auth_rate: 0.12,
    revenue_trend: -0.1, // gradual decline
    transaction_velocity: 0.15,
    low_volume: -0.4,    // steepening drop
  }[signalType] || 0;

  const records = [];
  for (let i = 29; i >= 0; i--) {
    const dayBase = base + trend * (29 - i);
    const noise = (Math.random() - 0.5) * (signalType === 'dispute_rate' ? 1.0 : 3.0);
    const val = Math.max(0, dayBase + noise);
    records.push({
      value: val.toFixed(4),
      captured_at: daysAgo(i).toISOString(),
    });
  }
  return records;
}

// Pre-generated chart data
const CHART_DATA = {};
for (const st of SIGNAL_TYPES) {
  CHART_DATA[st] = generateChartData(st);
}

// Mock alerts — at least one triggered alert with a remediation guide
const ALERTS = [
  {
    id: 'demo-alert-001',
    merchant_id: DEMO_MERCHANT.id,
    signal_type: 'dispute_rate',
    signal_value: 3.7,
    threshold_crossed: 3.5,
    fired_at: daysAgo(1).toISOString(),
    acknowledged: false,
    created_at: daysAgo(1).toISOString(),
  },
  {
    id: 'demo-alert-002',
    merchant_id: DEMO_MERCHANT.id,
    signal_type: 'auth_rate',
    signal_value: 9.1,
    threshold_crossed: 10.0,
    fired_at: daysAgo(5).toISOString(),
    acknowledged: true,
    created_at: daysAgo(5).toISOString(),
  },
  {
    id: 'demo-alert-003',
    merchant_id: DEMO_MERCHANT.id,
    signal_type: 'low_volume',
    signal_value: -21.5,
    threshold_crossed: -20.0,
    fired_at: daysAgo(8).toISOString(),
    acknowledged: true,
    created_at: daysAgo(8).toISOString(),
  },
];

function buildSignalCards() {
  return SIGNAL_TYPES.map(signalType => {
    const value = LATEST_SIGNAL_VALUES[signalType];
    const threshold = SIGNAL_THRESHOLDS[signalType];
    let status = 'normal';
    let pct = null;

    if (value != null && threshold != null) {
      const val = value;
      const thr = threshold;

      if (signalType === 'revenue_trend' || signalType === 'low_volume') {
        // Lower-bound signals: value is worse if more negative
        if (val <= thr) {
          status = 'exceeded';
          pct = Math.min(100, Math.round((Math.abs(val) / Math.abs(thr)) * 100));
        } else if (thr < 0 && val <= thr * 1.25) {
          status = 'near';
          pct = Math.round((Math.abs(val) / Math.abs(thr)) * 100);
        } else {
          status = 'normal';
          pct = thr !== 0 ? Math.round((Math.abs(val) / Math.abs(thr)) * 100) : 0;
        }
      } else {
        // Upper-bound signals: value is worse if higher
        if (val >= thr) {
          status = 'exceeded';
          pct = Math.min(100, Math.round((val / thr) * 100));
        } else if (thr > 0 && val >= thr * 0.8) {
          status = 'near';
          pct = Math.round((val / thr) * 100);
        } else {
          status = 'normal';
          pct = thr > 0 ? Math.round((val / thr) * 100) : 0;
        }
      }
    }

    return {
      signal_type: signalType,
      label: SIGNAL_LABELS[signalType],
      value: value != null ? value.toFixed(3) : null,
      threshold,
      captured_at: daysAgo(0).toISOString(),
      status,
      pct: pct !== null ? pct : 0,
    };
  });
}

function buildStatus() {
  // dispute_rate alert is active = red status
  return {
    color: 'red',
    label: 'Alert Fired',
    detail: 'Dispute Rate',
  };
}

function buildDemoContext() {
  const signalCards = buildSignalCards();
  const mostRecentAlert = ALERTS[0]; // dispute_rate, fired 1 day ago

  return {
    merchant: DEMO_MERCHANT,
    connected: true,
    tokenExpiring: false,
    stripeConnectUrl: null,
    flash: {
      connected: false,
      alreadyConnected: false,
      disconnected: false,
      error: null,
      billing_success: false,
      billing_canceled: false,
      billing_already_active: false,
      billing_cancel_scheduled: false,
      billing_no_subscription: false,
      billing_error: false,
      billing_error_message: null,
    },
    appUrl: 'https://foundryiq-3.polsia.app',
    status: buildStatus(),
    signalCards,
    allAlerts: ALERTS,
    alertCount: 1,
    alertFilter: 'all',
    mostRecentAlert,
    trialDaysLeft: null,
    renewsDate: null,
    // Demo mode flag for the template
    demoMode: true,
  };
}

module.exports = {
  SIGNAL_TYPES,
  SIGNAL_LABELS,
  DEMO_MERCHANT,
  LATEST_SIGNAL_VALUES,
  SIGNAL_THRESHOLDS,
  CHART_DATA,
  ALERTS,
  buildDemoContext,
  getSignalHistory: (signalType) => CHART_DATA[signalType] || [],
};
