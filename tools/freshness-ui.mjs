/**
 * Shared freshness surfaces.
 *
 * Every date-heavy page gets the same compact provenance footer and glossary
 * instead of another hand-written mix of report, observation and check dates.
 */

import { longDate, timeHTML } from './freshness.mjs';

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (value) => String(value == null ? '' : value).replace(/[&<>"]/g, (character) => HTML_ESCAPES[character]);

function officesOf(freshness) {
  if (!freshness) return [];
  if (Array.isArray(freshness.offices)) return freshness.offices;
  return freshness.bySlug ? Object.values(freshness.bySlug) : [];
}

function dateRange(values) {
  const dates = values.filter(Boolean).sort();
  if (!dates.length) return 'Not recorded';
  const first = longDate(dates[0]);
  const last = longDate(dates[dates.length - 1]);
  return first === last ? first : `${first} to ${last}`;
}

function expectedCopy(office) {
  if (!office.due_at) return 'No fixed date';
  const target = office.next_due_at || office.due_at;
  if (office.overdue) {
    return `Due since ${longDate(office.due_at)}` +
      (target && target !== office.due_at ? `; next ${longDate(target)}` : '');
  }
  return `Expected ${longDate(target)}`;
}

/**
 * Provenance footer. The timestamps carry data-iv-time so the site-wide
 * UTC/Local control updates them; the text fallback is always UTC.
 */
export function freshnessFooterHTML(freshness) {
  const offices = officesOf(freshness);
  if (!offices.length) return '';
  const reports = offices.map((office) => office.report_date);
  const successes = offices.map((office) => office.last_success_at);
  const attempts = offices.map((office) => office.last_attempt_at);
  const latestSuccess = successes.filter(Boolean).sort().at(-1) || '';
  const latestAttempt = attempts.filter(Boolean).sort().at(-1) || '';
  const rows = offices.map((office) => {
    const through = office.official_data_through
      ? `<time datetime="${esc(office.official_data_through)}">${esc(longDate(office.official_data_through))}</time>`
      : '—';
    const observation = office.observed_data_through &&
      office.observed_data_through > office.official_data_through
      ? `<br><span class="small-note" data-observation="tracker">Tracker observed through ${esc(longDate(office.observed_data_through))}</span>`
      : '';
    return `<tr>
          <th scope="row"><a href="/${esc(office.slug)}-visa-decisions">${esc(office.name)}</a></th>
          <td data-label="Latest official report">${office.report_date ? `<time datetime="${esc(office.report_date)}">${esc(longDate(office.report_date))}</time>` : '—'}</td>
          <td data-label="Official data through">${through}${observation}</td>
          <td data-label="Last successful check">${timeHTML(office.last_success_at)}</td>
          <td data-label="Last attempt">${timeHTML(office.last_attempt_at)}</td>
          <td data-label="Next expected">${esc(expectedCopy(office))}</td>
        </tr>`;
  }).join('\n        ');

  return `<section class="freshness-footer" data-freshness-footer aria-labelledby="freshness-footer-title">
      <h2 id="freshness-footer-title">Dates and provenance</h2>
      <p class="small-note"><strong>Latest office publications:</strong> ${esc(dateRange(reports))} &middot;
        <strong>Last successful check:</strong> ${timeHTML(latestSuccess)} &middot;
        <strong>Last attempt:</strong> ${timeHTML(latestAttempt)}.</p>
      <div class="table-wrap" role="region" aria-label="Official publication and check provenance" tabindex="0">
        <table class="office-table stack-table">
          <caption>Each office keeps its report date, official data-through date and tracker observations separate</caption>
          <thead><tr><th scope="col">Office</th><th scope="col">Latest official report</th><th scope="col">Official data through</th><th scope="col">Last successful check</th><th scope="col">Last attempt</th><th scope="col">Next expected</th></tr></thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
      <details class="freshness-glossary">
        <summary>What these dates mean</summary>
        <dl>
          <dt>Report date</dt><dd>The date printed on the office file, or the end of its reporting period. It is not necessarily the date an individual decision was made.</dd>
          <dt>Official data through</dt><dd>The newest decision date inside the latest official file. The decision count belongs to this file only.</dd>
          <dt>Tracker observation</dt><dd>A decision row seen by the tracker outside the latest official file. It is shown separately and is not part of the official count.</dd>
          <dt>Last successful check</dt><dd>The most recent check that successfully read the office file. A later failed attempt does not replace this timestamp.</dd>
          <dt>Last attempt</dt><dd>The most recent scheduled run for the office, whether it succeeded or failed.</dd>
          <dt>Expected next file</dt><dd>Calculated from the latest report date and the office's usual publication rhythm. It is an expectation, not a guarantee.</dd>
        </dl>
      </details>
      <p class="small-note"><a href="/status#office-coverage">Office coverage and checks</a> &middot; <a href="/data/freshness.json">freshness.json</a> &middot; <a href="/when-are-visa-decisions-published">Publication schedule</a></p>
    </section>`;
}

/** Per-office observation lag and recent first observations. */
export function freshnessHistoryHTML(freshness) {
  const offices = officesOf(freshness).filter((office) => office.observation_lag);
  if (!offices.length) return '';
  const rows = offices.map((office) => {
    const lag = office.observation_lag;
    const sample = lag.sample_size
      ? `Median ${lag.median_days} day${lag.median_days === 1 ? '' : 's'} (range ${lag.min_days}–${lag.max_days}; ${lag.sample_size} report${lag.sample_size === 1 ? '' : 's'})`
      : 'Not enough observations yet';
    const recent = (lag.history || []).slice(0, 3).map((entry) =>
      `${longDate(entry.report_date)} → ${timeHTML(entry.observed_at)}${entry.lag_days == null ? '' : ` (${entry.lag_days} day${entry.lag_days === 1 ? '' : 's'})`}${entry.backfilled ? ' <span class="small-note">backfilled</span>' : ''}`,
    ).join('<br>');
    return `<tr>
          <th scope="row"><a href="/${esc(office.slug)}-visa-decisions">${esc(office.name)}</a></th>
          <td data-label="Observation lag">${esc(sample)}</td>
          <td data-label="Recent report → first observation">${recent || '—'}</td>
        </tr>`;
  }).join('\n        ');
  return `<p class="small-note"><strong>How quickly does the tracker see a file?</strong> Lag is the time between a report date and the tracker's first archived observation of it. Backfilled history is excluded from the median.</p>
      <div class="table-wrap" role="region" aria-label="Observation lag by office" tabindex="0">
        <table class="office-table stack-table">
          <caption>Report date to first tracker observation</caption>
          <thead><tr><th scope="col">Office</th><th scope="col">Observation lag</th><th scope="col">Recent report → first observation</th></tr></thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>`;
}
