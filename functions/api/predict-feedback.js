/**
 * Anonymous calibration feedback for the visa timeline baseline.
 *
 * A visitor can contribute the dates of a finished application without an
 * application number, email, IP or free text. The API computes the baseline
 * error itself, so the published model card can report real-outcome backtesting
 * only after the minimum sample gate is met.
 */

import { ensureSchema } from '../db-schema.js';
import { estimateBaseline, MODEL_METADATA } from './predict.js';

const MINIMUM_SAMPLES = 200;
const MAX_DAYS = 730;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function isoDate(value) {
  const raw = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
  const date = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw ? raw : '';
}

function dayDifference(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.DB) return json({ error: 'Database not configured' }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const office = String(body.embassy || body.office || '').trim();
  const visaType = String(body.visa_type || '').trim();
  const applied = isoDate(body.application_date || body.applied);
  const decided = isoDate(body.decision_date || body.decided);
  if (!Object.prototype.hasOwnProperty.call(MODEL_METADATA.baseline.office_days, office)) {
    return json({ error: 'Invalid embassy' }, 400);
  }
  if (!Object.prototype.hasOwnProperty.call(MODEL_METADATA.baseline.visa_adjustments, visaType)) {
    return json({ error: 'Invalid visa_type' }, 400);
  }
  if (!applied || !decided) return json({ error: 'application_date and decision_date are required' }, 400);
  const today = new Date().toISOString().slice(0, 10);
  if (applied < '2020-01-01' || decided < applied || decided > today) {
    return json({ error: 'Use real dates: applied first, decision today or earlier' }, 400);
  }
  const actualDays = dayDifference(applied, decided);
  if (actualDays < 0 || actualDays > MAX_DAYS) {
    return json({ error: 'The date range is too long to use for calibration' }, 400);
  }

  const baseline = estimateBaseline({ embassy: office, visa_type: visaType, application_date: applied });
  const errorDays = Math.abs(baseline.days - actualDays);
  try {
    await ensureSchema(env.DB);
    await env.DB.prepare(`INSERT INTO prediction_feedback
      (model_version, office, visa_type, application_date, decision_date, actual_days, baseline_days, baseline_error, within_14_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        MODEL_METADATA.version,
        office,
        visaType,
        applied,
        decided,
        actualDays,
        baseline.days,
        errorDays,
        errorDays <= 14 ? 1 : 0
      ).run();
    return json({
      ok: true,
      actual_days: actualDays,
      baseline_days: baseline.days,
      baseline_error_days: errorDays,
      within_14_days: errorDays <= 14
    }, 201);
  } catch (error) {
    console.error('Prediction feedback store failed:', error.message);
    return json({ error: 'Could not store calibration feedback' }, 503);
  }
}

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.DB) return json({ error: 'Database not configured' }, 503);
  try {
    await ensureSchema(env.DB);
    const row = await env.DB.prepare(`SELECT
      COUNT(*) AS samples,
      AVG(baseline_error) AS baseline_mae,
      AVG(within_14_days) AS within_14_day_share,
      MIN(created_at) AS first_at,
      MAX(created_at) AS last_at
      FROM prediction_feedback`).first();
    const samples = Number(row && row.samples) || 0;
    const meetsGate = samples >= MINIMUM_SAMPLES;
    return json({
      ok: true,
      calibration: {
        samples,
        minimum_samples: MINIMUM_SAMPLES,
        meets_minimum_samples: meetsGate,
        model_version: MODEL_METADATA.version,
        baseline_mae: meetsGate && row && row.baseline_mae != null ? Number(Number(row.baseline_mae).toFixed(2)) : null,
        within_14_day_share: meetsGate && row && row.within_14_day_share != null
          ? Number((Number(row.within_14_day_share) * 100).toFixed(1))
          : null,
        first_at: row && row.first_at || null,
        last_at: row && row.last_at || null,
        note: meetsGate
          ? 'Real-outcome baseline calibration is available.'
          : `Metrics stay hidden until ${MINIMUM_SAMPLES} anonymous finished timelines are available.`
      }
    });
  } catch (error) {
    console.error('Prediction feedback aggregate failed:', error.message);
    return json({ error: 'Calibration feedback is unavailable' }, 503);
  }
}

export const onRequest = { POST: onRequestPost, GET: onRequestGet };
