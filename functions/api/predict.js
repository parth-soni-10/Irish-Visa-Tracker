/**
 * ML Timeline Predictor Endpoint
 *
 * Predicts a visa decision timeline from application features. Inference runs
 * against the exported XGBoost tree ensemble in ./model-trees.js (generated
 * from models/model.ubj by export_trees.py). That keeps the Worker bundle
 * self-contained: no ONNX runtime and no WASM download at request time.
 *
 * Trained offline on synthetic historical data; MAE 4.32 days, RMSE 5.13,
 * MAPE 8.77%. The heuristic below is only a fallback if the tree walk fails.
 */

import { FEATURES, BASE_SCORE, TREES } from './model-trees.js';

const MODEL_METADATA = {
  version: '1.0.0',
  model_type: 'xgboost',
  metrics: {
    mae: 4.32,
    rmse: 5.13,
    mape: 0.0877
  },
  features: FEATURES,
  target: 'days_to_decision',
  top_features: [
    'visa_adjustment',
    'embassy_base_days',
    'is_peak_season',
    'month',
    'year',
    'embassy_30d_volume',
    'quarter',
    'is_holiday_period'
  ],
  trained_on: '2026-11-09',
  training_samples: 35839,
  inference: 'xgboost-tree-ensemble'
};

// Embassy base processing days (learned by the model).
const EMBASSY_BASE_DAYS = {
  'new-delhi': 45,
  'beijing': 35,
  'dublin': 20,
  'abu-dhabi': 25,
  'abuja': 40,
  'ankara': 30
};

// Visa type adjustments (the model's most important feature).
const VISA_ADJUSTMENTS = {
  study: 5,
  work: -2,
  visit: -10,
  family: 5,
  transit: -25,
  research: 3
};

const SEASONAL_ADJUST = {
  peak: 7,
  holiday: 5,
  normal: 0
};

// Feature engineering. The key order is irrelevant - FEATURES defines the
// order used by the exported trees.
function engineerFeatures(input) {
  const date = new Date(String(input.application_date) + 'T00:00:00');
  const appNumRaw = String(input.application_number || '').replace(/\D/g, '');
  const appNum = parseInt(appNumRaw.slice(-6), 10) || 0;

  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day_of_week: date.getDay(),
    day_of_month: date.getDate(),
    quarter: Math.ceil((date.getMonth() + 1) / 3),
    is_weekend: (date.getDay() === 0 || date.getDay() === 6) ? 1 : 0,
    app_num: appNum,
    app_num_mod_100: appNum % 100,
    app_num_mod_1000: appNum % 1000,
    app_num_bucket: Math.floor(appNum / 100000) * 100000,
    is_peak_season: [5, 6, 7, 8, 12].includes(date.getMonth() + 1) ? 1 : 0,
    is_holiday_period: [12, 1].includes(date.getMonth() + 1) ? 1 : 0,
    embassy_base_days: EMBASSY_BASE_DAYS[input.embassy] || 30,
    visa_adjustment: VISA_ADJUSTMENTS[input.visa_type] || 0,
    // Rolling approval/volume stats. These are stable priors in this build;
    // a production model would refresh them from D1 before inference.
    embassy_7d_approval_rate: 0.78,
    embassy_7d_volume: 100,
    embassy_14d_approval_rate: 0.77,
    embassy_14d_volume: 200,
    embassy_30d_approval_rate: 0.75,
    embassy_30d_volume: 500,
    global_7d_approval_rate: 0.78,
    global_7d_volume: 500,
    global_14d_approval_rate: 0.77,
    global_14d_volume: 1000,
    global_30d_approval_rate: 0.76,
    global_30d_volume: 2000
  };
}

// Walk every exported tree. A node is [featureIndex, threshold, yes, no];
// a leaf is a plain number. XGBoost takes the "yes" branch when value <
// threshold, and the final score is base_score + the sum of leaf values.
export function predictWithTrees(features) {
  if (!Array.isArray(TREES) || !TREES.length) {
    throw new Error('model trees unavailable');
  }

  let total = 0;
  for (let t = 0; t < TREES.length; t++) {
    let node = TREES[t];
    let guard = 0;
    while (Array.isArray(node) && guard++ < 256) {
      const featureIndex = node[0];
      const threshold = node[1];
      const value = Number(features[FEATURES[featureIndex]]) || 0;
      node = value < threshold ? node[2] : node[3];
    }
    if (typeof node === 'number') total += node;
  }

  return Math.max(5, Math.min(180, Math.round(BASE_SCORE + total)));
}

// Heuristic fallback if the ensemble ever fails to load.
function predictTimeline(features) {
  let days = features.embassy_base_days;
  days += features.visa_adjustment;
  if (features.is_peak_season) days += SEASONAL_ADJUST.peak;
  if (features.is_holiday_period) days += SEASONAL_ADJUST.holiday;
  if (features.is_weekend) days += 2;
  if (features.month === 1 || features.month === 12) days += 3;
  if (features.month >= 5 && features.month <= 8) days += 5;
  if (features.app_num > 900000) days -= 2;
  else if (features.app_num > 800000) days -= 1;
  if (features.embassy_30d_approval_rate > 0.8) days -= 1;
  else if (features.embassy_30d_approval_rate < 0.7) days += 2;
  if (features.embassy_30d_volume > 1000) days += 3;
  else if (features.embassy_30d_volume > 500) days += 1;
  return Math.max(5, Math.min(180, Math.round(days)));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequestPost(context) {
  const { request } = context;

  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const applicationNumber = body.application_number || 'IRL00000000';
    const applicationDate = body.application_date;
    const visaType = body.visa_type || 'visit';
    const embassySlug = body.embassy || 'new-delhi';

    if (!applicationDate) {
      return json({ error: 'application_date is required (YYYY-MM-DD)' }, 400);
    }

    const appDate = new Date(String(applicationDate) + 'T00:00:00');
    if (isNaN(appDate.getTime())) {
      return json({ error: 'Invalid date format. Use YYYY-MM-DD' }, 400);
    }

    const validVisaTypes = Object.keys(VISA_ADJUSTMENTS);
    if (!validVisaTypes.includes(visaType)) {
      return json({ error: 'Invalid visa_type. Must be one of: ' + validVisaTypes.join(', ') }, 400);
    }

    const validEmbassies = Object.keys(EMBASSY_BASE_DAYS);
    if (!validEmbassies.includes(embassySlug)) {
      return json({ error: 'Invalid embassy. Must be one of: ' + validEmbassies.join(', ') }, 400);
    }

    const features = engineerFeatures({
      visa_type: visaType,
      embassy: embassySlug,
      application_date: applicationDate,
      application_number: applicationNumber
    });

    let predictedDays;
    let inference = MODEL_METADATA.inference;
    try {
      predictedDays = predictWithTrees(features);
    } catch (error) {
      console.warn('Tree inference failed, using heuristic:', error.message);
      predictedDays = predictTimeline(features);
      inference = 'heuristic-fallback';
    }

    const estimatedDate = new Date(appDate);
    estimatedDate.setDate(estimatedDate.getDate() + predictedDays);

    const mae = MODEL_METADATA.metrics.mae;
    const ciLower = Math.max(1, Math.round(predictedDays - 1.96 * mae));
    const ciUpper = Math.min(365, Math.round(predictedDays + 1.96 * mae));

    return json({
      success: true,
      prediction: {
        predicted_days: predictedDays,
        estimated_decision_date: estimatedDate.toISOString().slice(0, 10),
        confidence_interval: {
          lower: ciLower,
          upper: ciUpper,
          confidence_level: 0.95
        },
        model_version: MODEL_METADATA.version,
        model_type: MODEL_METADATA.model_type,
        inference,
        model_metrics: MODEL_METADATA.metrics,
        features_used: FEATURES
      }
    });
  } catch (error) {
    console.error('Prediction error:', error);
    return json({ error: 'Prediction failed', message: error.message }, 500);
  }
}

export async function onRequestGet() {
  return json({
    model: MODEL_METADATA,
    endpoints: {
      predict: 'POST /api/predict',
      info: 'GET /api/predict'
    },
    example_request: {
      application_number: 'IRL2026123456',
      application_date: '2026-01-15',
      visa_type: 'study',
      embassy: 'new-delhi'
    }
  });
}

export const onRequest = { POST: onRequestPost, GET: onRequestGet };
