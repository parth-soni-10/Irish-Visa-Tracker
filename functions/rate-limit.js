/**
 * Durable fixed-window rate limiting.
 *
 * The old limiter kept an array per IP in module memory, so each edge isolate
 * enforced its own budget and a caller could spread requests across isolates.
 * This version uses D1 as the shared counter. The in-memory path remains only
 * as a degraded fallback when the binding is unavailable or the table cannot
 * be created; it is never the primary store in production.
 */

const TABLE = `CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT NOT NULL,
  subject TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bucket, subject, window_start)
)`;

let schemaPromise = null;
const memory = new Map();

function memoryLimit(bucket, subject, windowStart, limit) {
  const key = bucket + ':' + subject + ':' + windowStart;
  const count = (memory.get(key) || 0) + 1;
  memory.set(key, count);
  if (memory.size > 5000) {
    for (const stored of memory.keys()) {
      const storedWindow = Number(stored.slice(stored.lastIndexOf(':') + 1));
      if (storedWindow < windowStart) memory.delete(stored);
    }
  }
  return { allowed: count <= limit, count, limit, durable: false };
}

async function ensureRateLimitTable(env) {
  if (!env.DB) return false;
  if (!schemaPromise) {
    schemaPromise = env.DB.prepare(TABLE).run()
      .then(() => true)
      .catch((error) => {
        console.warn('Durable rate-limit table unavailable:', error.message);
        return false;
      });
  }
  return schemaPromise;
}

export function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

/**
 * Count one request in a fixed window.
 *
 * @param {object} env Worker environment; env.DB makes the counter durable.
 * @param {object} options bucket, subject, limit, windowSeconds.
 * @returns {Promise<{allowed:boolean,count:number,limit:number,retryAfter:number,durable:boolean}>}
 */
export async function checkRateLimit(env, options = {}) {
  const bucket = String(options.bucket || 'api').slice(0, 40);
  const subject = String(options.subject || 'unknown').slice(0, 180);
  const limit = Math.max(1, Number(options.limit) || 300);
  const windowSeconds = Math.max(1, Number(options.windowSeconds) || 60);
  const windowMs = windowSeconds * 1000;
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;

  if (env && env.DB) {
    try {
      if (await ensureRateLimitTable(env)) {
        const row = await env.DB.prepare(`
          INSERT INTO rate_limits (bucket, subject, window_start, count)
          VALUES (?, ?, ?, 1)
          ON CONFLICT(bucket, subject, window_start)
          DO UPDATE SET count = count + 1, updated_at = datetime('now')
          RETURNING count
        `).bind(bucket, subject, windowStart).first();
        const count = Number(row && row.count) || 1;
        // Best-effort cleanup keeps the table bounded without putting a delete
        // on every request path. Two windows are enough for a retry decision.
        if (count === 1 && Math.random() < 0.02) {
          env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?')
            .bind(windowStart - windowMs * 2).run().catch(() => {});
        }
        return {
          allowed: count <= limit,
          count,
          limit,
          retryAfter: Math.max(1, Math.ceil((windowStart + windowMs - Date.now()) / 1000)),
          durable: true
        };
      }
    } catch (error) {
      console.warn('Durable rate limit failed, using local fallback:', error.message);
    }
  }

  const result = memoryLimit(bucket, subject, windowStart, limit);
  return {
    ...result,
    retryAfter: Math.max(1, Math.ceil((windowStart + windowMs - Date.now()) / 1000))
  };
}
