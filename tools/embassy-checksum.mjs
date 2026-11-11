import crypto from 'crypto';

/**
 * Canonical checksum for an office's decision rows.
 *
 * The digest is order-independent and covers only application number and
 * decision. This matches the checksum written by tools/scrape-embassies.mjs
 * and lets the backfill + verifier reuse the same definition.
 */
export function decisionChecksum(decisions) {
  const byNumber = new Map();
  for (const row of Array.isArray(decisions) ? decisions : []) {
    const number = String(row && row.number != null ? row.number : '').trim();
    const rawDecision = String(row && row.decision != null ? row.decision : '').trim().toLowerCase();
    let decision = null;
    if (rawDecision === 'approved' || rawDecision === 'granted') decision = 'Approved';
    else if (rawDecision === 'refused' || rawDecision === 'rejected') decision = 'Refused';
    if (number && decision) byNumber.set(number, decision);
  }

  return crypto
    .createHash('sha256')
    .update(JSON.stringify([...byNumber.entries()].sort()))
    .digest('hex')
    .slice(0, 16);
}
