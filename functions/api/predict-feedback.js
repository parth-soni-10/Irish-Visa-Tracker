/**
 * Anonymous calibration feedback for the visa timeline baseline.
 *
 * A visitor can contribute the dates of a finished application without an
 * application number, email, IP or free text. The dates must match a visa
 * timeline the visitor already shared in the community data; that prevents a
 * client from manufacturing unlimited calibration samples. The API computes the
 * baseline error itself, so the published model card can report real-outcome
 * backtesting only after the minimum sample gate is met.
 */

import { readCalibration } from '../calibration.js';
import { ensureSchema } from '../db-schema.js';
import { checkRateLimit, getClientIp } from '../rate-limit.js';
import { estimateBaseline, MODEL_METADATA } from './predict.js';

const MAX_DAYS = 730;
const DAILY_LIMIT = 5;
const DAY_SECONDS = 86400;

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
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

function isUniqueViolation(error) {
  return /UNIQUE constraint failed|constraint failed: UNIQUE/i.test(String(error && error.message));
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
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Body must be a JSON object' }, 400);
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
  const dailyLimit = Math.max(1, Number(env.PREDICT_FEEDBACK_DAILY_LIMIT) || DAILY_LIMIT);

  try {
    await ensureSchema(env.DB);

    // A dedicated bucket keeps calibration abuse from spending the general API
    // budget and limits one client to a handful of finished timelines per day.
    const decision = await checkRateLimit(env, {
      bucket: 'predict-feedback',
      subject: getClientIp(request),
      limit: dailyLimit,
      windowSeconds: DAY_SECONDS
    });
    if (!decision.allowed) {
      return json({
        error: 'Too many calibration submissions from this client. Try again tomorrow.'
      }, 429, { 'Retry-After': String(decision.retryAfter || DAY_SECONDS) });
    }

    // Calibration samples must correspond to a visa timeline the visitor has
    // already shared. Legacy combined rows are accepted only when their office
    // and visa type, if present, agree with the values being calibrated.
    const submission = await env.DB.prepare(`SELECT id FROM submissions
      WHERE form IN ('timelines-visa', 'timelines')
      AND json_extract(fields, '$.tracker') = 'visa'
      AND json_extract(fields, '$.applied') = ?
      AND json_extract(fields, '$.decided') = ?
      AND (
        json_extract(fields, '$.embassy') IS NULL
        OR json_extract(fields, '$.embassy') = ''
        OR json_extract(fields, '$.embassy') = ?
      )
      AND (
        json_extract(fields, '$.visa_type') IS NULL
        OR json_extract(fields, '$.visa_type') = ''
        OR json_extract(fields, '$.visa_type') = ?
      )
      ORDER BY id DESC LIMIT 1`)
      .bind(applied, decided, office, visaType)
      .first();
    const sourceSubmissionId = Number(submission && submission.id);
    if (!Number.isInteger(sourceSubmissionId) || sourceSubmissionId <= 0) {
      return json({
        error: 'Only dates already shared in the community visa timeline can be used for calibration.'
      }, 422);
    }

    const existing = await env.DB.prepare(
      'SELECT id FROM prediction_feedback WHERE source_submission_id = ? LIMIT 1'
    ).bind(sourceSubmissionId).first();
    if (existing) {
      return json({ error: 'This community timeline has already been used for calibration.' }, 409);
    }

    await env.DB.prepare(`INSERT INTO prediction_feedback
      (model_version, source_submission_id, office, visa_type, application_date, decision_date, actual_days, baseline_days, baseline_error, within_14_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        MODEL_METADATA.version,
        sourceSubmissionId,
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
      verified: true,
      actual_days: actualDays,
      baseline_days: baseline.days,
      baseline_error_days: errorDays,
      within_14_days: errorDays <= 14
    }, 201);
  } catch (error) {
    if (isUniqueViolation(error)) {
      return json({ error: 'This community timeline has already been used for calibration.' }, 409);
    }
    console.error('Prediction feedback store failed:', error.message);
    return json({ error: 'Could not store calibration feedback' }, 503);
  }
}

export async function onRequestGet(context) {
  const { env } = context;
  if (!env.DB) return json({ error: 'Database not configured' }, 503);
  try {
    const calibration = await readCalibration(env, MODEL_METADATA.version);
    return json({ ok: true, calibration });
  } catch (error) {
    console.error('Prediction feedback aggregate failed:', error.message);
    return json({ error: 'Calibration feedback is unavailable' }, 503);
  }
}

export const onRequest = { POST: onRequestPost, GET: onRequestGet };
