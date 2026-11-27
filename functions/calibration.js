/**
 * Verified calibration data shared by the prediction API and its model card.
 *
 * Only rows linked to a community timeline count. Keeping the query here means
 * /api/predict and /api/predict/feedback cannot report different sample counts,
 * gate states, errors or last-calibrated timestamps.
 */

import { ensureSchema } from './db-schema.js';

export const MINIMUM_SAMPLES = 200;

function round(value, digits) {
  return value == null ? null : Number(Number(value).toFixed(digits));
}

export function emptyCalibration(modelVersion = '') {
  return {
    available: false,
    samples: 0,
    minimum_samples: MINIMUM_SAMPLES,
    meets_minimum_samples: false,
    model_version: modelVersion,
    baseline_mae: null,
    within_14_day_share: null,
    first_at: null,
    last_at: null,
    last_calibrated_at: null,
    note: 'Calibration data is unavailable right now.'
  };
}

function formatCalibration(row, modelVersion = '') {
  const samples = Math.max(0, Number(row && row.samples) || 0);
  const meetsGate = samples >= MINIMUM_SAMPLES;
  const lastAt = row && row.last_at ? String(row.last_at) : null;
  return {
    available: true,
    samples,
    minimum_samples: MINIMUM_SAMPLES,
    meets_minimum_samples: meetsGate,
    model_version: modelVersion,
    baseline_mae: meetsGate && row && row.baseline_mae != null ? round(row.baseline_mae, 2) : null,
    within_14_day_share: meetsGate && row && row.within_14_day_share != null
      ? round(Number(row.within_14_day_share) * 100, 1)
      : null,
    first_at: row && row.first_at ? String(row.first_at) : null,
    last_at: lastAt,
    last_calibrated_at: lastAt,
    note: meetsGate
      ? 'Real-outcome baseline calibration is available.'
      : `Metrics stay hidden until ${MINIMUM_SAMPLES} verified community timelines are available.`
  };
}

export async function readCalibration(env, modelVersion = '') {
  if (!env || !env.DB) throw new Error('Database not configured');
  await ensureSchema(env.DB);
  const row = await env.DB.prepare(`SELECT
    COUNT(*) AS samples,
    AVG(baseline_error) AS baseline_mae,
    AVG(within_14_days) AS within_14_day_share,
    MIN(created_at) AS first_at,
    MAX(created_at) AS last_at
    FROM prediction_feedback
    WHERE source_submission_id IS NOT NULL`).first();
  return formatCalibration(row || {}, modelVersion);
}
