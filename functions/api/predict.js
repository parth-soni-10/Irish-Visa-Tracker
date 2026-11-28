/**
 * Visa timeline estimate endpoint.
 *
 * The synthetic-tree model is deliberately paused. It has no real-outcome
 * backtest and its training metrics cannot establish that it beats a simple
 * baseline, so the public API returns the transparent baseline instead of a
 * false ML precision claim. The model card and the anonymous calibration
 * endpoint are the path back to a validated estimate.
 */

import { MINIMUM_SAMPLES, emptyCalibration, readCalibration } from '../calibration.js';

const MODEL_VERSION = '1.1.0-baseline';

const OFFICE_DAYS = {
  'new-delhi': 45,
  beijing: 35,
  dublin: 20,
  'abu-dhabi': 25,
  abuja: 40,
  ankara: 30
};

const VISA_ADJUSTMENTS = {
  study: 5,
  work: -2,
  visit: -10,
  family: 5,
  transit: -25,
  research: 3
};

const SEASONAL_ADJUSTMENTS = {
  peak: 7,
  holiday: 5,
  normal: 0
};

export const MODEL_METADATA = {
  version: MODEL_VERSION,
  model_type: 'transparent-baseline',
  target: 'days_to_decision',
  trained_on: '2026-11-09',
  training_samples: 35839,
  training_data: 'synthetic-illustrative',
  training_metrics: {
    mae: 4.32,
    rmse: 5.13,
    mape: 0.0877,
    note: 'Synthetic holdout only. These are not real-outcome validation results and are not used for the public estimate.'
  },
  metrics: null,
  validation: {
    status: 'not_validated',
    eligible_for_individual_estimates: false,
    minimum_samples: MINIMUM_SAMPLES,
    real_outcome_samples: 0,
    model_beats_baseline: null,
    backtesting: 'No real outcomes are connected yet, so the ML model cannot be shown to beat the baseline.',
    calibration: 'No calibrated confidence interval is published. The API returns a baseline estimate with its components instead.'
  },
  baseline: {
    name: 'Office wait + seasonal baseline',
    description: 'A transparent sum of the office base wait, visa-type adjustment and seasonal/weekend adjustments. It is a planning baseline, not a personal prediction.',
    office_days: OFFICE_DAYS,
    visa_adjustments: VISA_ADJUSTMENTS,
    seasonal_adjustments: SEASONAL_ADJUSTMENTS
  },
  top_features: [
    'visa_type',
    'embassy',
    'application_date'
  ],
  disclaimer: 'Illustrative planning baseline only. It is not a prediction of an individual application, has no calibrated confidence interval, and has not been validated on real outcomes.',
  inference: 'transparent-baseline'
};

/** Build the public model document from the same calibration view the feedback
 *  endpoint returns. The static metadata keeps the baseline definition; only
 *  the live calibration fields are replaced. */
export function modelMetadataFor(calibration) {
  const cal = calibration || emptyCalibration(MODEL_VERSION);
  return {
    ...MODEL_METADATA,
    validation: {
      ...MODEL_METADATA.validation,
      real_outcome_samples: cal.samples,
      meets_minimum_samples: cal.meets_minimum_samples,
      baseline_mae: cal.baseline_mae,
      last_calibrated_at: cal.last_calibrated_at
    },
    calibration: cal
  };
}

async function safeCalibration(env) {
  if (!env || !env.DB) return emptyCalibration(MODEL_VERSION);
  try {
    return await readCalibration(env, MODEL_VERSION);
  } catch (error) {
    console.warn('Calibration read failed:', error.message);
    return emptyCalibration(MODEL_VERSION);
  }
}

/**
 * The published baseline. Kept in one place so feedback calibration measures
 * exactly the number the API shows.
 */
export function estimateBaseline(input) {
  const applicationDate = String(input && input.application_date || '');
  const date = new Date(`${applicationDate}T00:00:00Z`);
  const month = Number.isNaN(date.getTime()) ? new Date().getUTCMonth() + 1 : date.getUTCMonth() + 1;
  const weekday = Number.isNaN(date.getTime()) ? 1 : date.getUTCDay();
  const office = String(input && input.embassy || 'new-delhi');
  const visaType = String(input && input.visa_type || 'visit');
  const officeBase = OFFICE_DAYS[office] || 30;
  const visaAdjustment = VISA_ADJUSTMENTS[visaType] || 0;
  const peakSeason = [5, 6, 7, 8, 12].includes(month);
  const holidayPeriod = [12, 1].includes(month);
  const weekend = weekday === 0 || weekday === 6;
  const seasonal = peakSeason
    ? SEASONAL_ADJUSTMENTS.peak
    : holidayPeriod ? SEASONAL_ADJUSTMENTS.holiday : SEASONAL_ADJUSTMENTS.normal;
  const weekendAdjustment = weekend ? 2 : 0;
  const days = Math.max(5, Math.min(180, Math.round(
    officeBase + visaAdjustment + seasonal + weekendAdjustment
  )));

  return {
    days,
    components: {
      office_base_days: officeBase,
      visa_adjustment: visaAdjustment,
      seasonal_adjustment: seasonal,
      weekend_adjustment: weekendAdjustment
    },
    inputs: {
      office,
      visa_type: visaType,
      application_date: applicationDate,
      month,
      weekday
    }
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context || {};

  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json({ error: 'Body must be a JSON object' }, 400);
    }

    const applicationDate = String(body.application_date || '');
    const visaType = String(body.visa_type || 'visit');
    const embassySlug = String(body.embassy || 'new-delhi');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(applicationDate)) {
      return json({ error: 'application_date is required (YYYY-MM-DD)' }, 400);
    }
    const appDate = new Date(`${applicationDate}T00:00:00Z`);
    if (Number.isNaN(appDate.getTime()) || appDate.toISOString().slice(0, 10) !== applicationDate) {
      return json({ error: 'Invalid date format. Use YYYY-MM-DD' }, 400);
    }
    const validVisaTypes = Object.keys(VISA_ADJUSTMENTS);
    if (!validVisaTypes.includes(visaType)) {
      return json({ error: 'Invalid visa_type. Must be one of: ' + validVisaTypes.join(', ') }, 400);
    }
    const validEmbassies = Object.keys(OFFICE_DAYS);
    if (!validEmbassies.includes(embassySlug)) {
      return json({ error: 'Invalid embassy. Must be one of: ' + validEmbassies.join(', ') }, 400);
    }

    const baseline = estimateBaseline({
      visa_type: visaType,
      embassy: embassySlug,
      application_date: applicationDate
    });
    const estimatedDate = new Date(appDate);
    estimatedDate.setUTCDate(estimatedDate.getUTCDate() + baseline.days);
    const calibration = await safeCalibration(env);

    return json({
      success: true,
      calibration,
      prediction: {
        predicted_days: baseline.days,
        estimated_decision_date: estimatedDate.toISOString().slice(0, 10),
        confidence_interval: null,
        interval_note: 'No calibrated confidence interval is published for this baseline.',
        model_version: MODEL_VERSION,
        model_type: MODEL_METADATA.model_type,
        inference: MODEL_METADATA.inference,
        estimate_kind: 'baseline',
        model_metrics: null,
        baseline_components: baseline.components,
        gate: {
          eligible_for_individual_estimates: false,
          reason: 'The ML model has not beaten the transparent baseline on real outcomes.',
          minimum_samples: calibration.minimum_samples,
          real_outcome_samples: calibration.samples,
          meets_minimum_samples: calibration.meets_minimum_samples,
          baseline_mae: calibration.baseline_mae,
          last_calibrated_at: calibration.last_calibrated_at
        },
        disclaimer: MODEL_METADATA.disclaimer,
        feedback_endpoint: 'POST /api/predict/feedback'
      }
    });
  } catch (error) {
    console.error('Prediction error:', error);
    return json({ error: 'Prediction failed' }, 500);
  }
}

export async function onRequestGet(context = {}) {
  const calibration = await safeCalibration(context.env);
  return json({
    model: modelMetadataFor(calibration),
    calibration,
    baseline: {
      name: MODEL_METADATA.baseline.name,
      description: MODEL_METADATA.baseline.description,
      formula: 'office_base_days + visa_adjustment + seasonal_adjustment + weekend_adjustment',
      clamped_days: [5, 180]
    },
    endpoints: {
      predict: 'POST /api/predict',
      info: 'GET /api/predict',
      feedback: 'POST /api/predict/feedback',
      calibration: 'GET /api/predict/feedback',
      model_card: '/status#prediction-model'
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
