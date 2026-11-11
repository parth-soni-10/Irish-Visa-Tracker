/**
 * Merge the latest weekly report into an office's cumulative archive.
 *
 * Abu Dhabi, Abuja and Ankara publish one weekly PDF at a time, while their
 * checked-in JSON files keep every report date. Application numbers are stable,
 * so the latest row wins when a number is published again.
 */
export function mergeDecisionHistory(existing, incoming) {
  const byNumber = new Map();

  for (const row of Array.isArray(existing) ? existing : []) {
    const number = String(row && row.number != null ? row.number : '').trim();
    if (number) byNumber.set(number, row);
  }
  for (const row of Array.isArray(incoming) ? incoming : []) {
    const number = String(row && row.number != null ? row.number : '').trim();
    if (number) byNumber.set(number, row);
  }

  return [...byNumber.values()];
}
