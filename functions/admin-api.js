/**
 * Admin API Routes
 * Handles admin dashboard, scraper health, data quality, metrics
 */

// Admin authentication middleware
async function requireAdmin(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { authorized: false, response: new Response(JSON.stringify({ error: 'Admin token required' }), { status: 401, headers: { 'Content-Type': 'application/json' } }) };
  }
  
  const token = authHeader.substring(7);
  const isValid = await validateAdminToken(env, token);
  
  if (!isValid) {
    return { authorized: false, response: new Response(JSON.stringify({ error: 'Invalid admin token' }), { status: 401, headers: { 'Content-Type': 'application/json' } }) };
  }
  
  return { authorized: true };
}

async function validateAdminToken(env, token) {
  const tokenHash = await hashPassword(token);
  const record = await env.DB.prepare(`
    SELECT 1 FROM admin_tokens WHERE token_hash = ? AND expires_at > datetime('now') AND revoked = 0
  `).bind(tokenHash).first();
  
  return !!record;
}

// Get scraper health status
export async function handleScraperHealth(request, env) {
  const auth = await requireAdmin(request, env);
  if (!auth.authorized) return auth.response;

  try {
    const now = new Date();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Get last run times for each embassy
    const embassies = ['new-delhi', 'beijing', 'dublin', 'abu-dhabi', 'abuja', 'ankara'];
    const health = {};

    for (const slug of embassies) {
      // Get latest data timestamp
      const latest = await env.DB.prepare(`
        SELECT MAX(last_run_at) as last_run FROM scraper_logs WHERE embassy_slug = ?
      `).bind(slug).first();

      // Get recent runs
      const recent = await env.DB.prepare(`
        SELECT * FROM scraper_logs WHERE embassy_slug = ? AND started_at > ? ORDER BY started_at DESC LIMIT 10
      `).bind(slug, oneWeekAgo).all();

      const successCount = recent.results?.filter(r => r.status === 'success').length || 0;
      const totalCount = recent.results?.length || 0;
      const successRate = totalCount > 0 ? (successCount / totalCount * 100).toFixed(1) : 0;

      // Get data freshness
      const latestData = await env.DB.prepare(`
        SELECT MAX(lastUpdated) as latest FROM embassy_data WHERE embassy_slug = ?
      `).bind(slug).first();

      const hoursSinceRun = latest?.last_run 
        ? ((Date.now() - new Date(latest.last_run).getTime()) / (1000 * 60 * 60)).toFixed(1)
        : null;
      
      const hoursSinceData = latestData?.latest 
        ? ((Date.now() - new Date(latestData.latest).getTime()) / (1000 * 60 * 60)).toFixed(1)
        : null;

      health[slug] = {
        status: successRate >= 80 ? 'healthy' : successRate > 0 ? 'degraded' : 'down',
        lastRun: latest?.last_run || null,
        hoursSinceRun: hoursSinceRun ? parseFloat(hoursSinceRun) : null,
        hoursSinceData: hoursSinceData ? parseFloat(hoursSinceData) : null,
        recentRuns: totalCount,
        successRate: parseFloat(successRate),
        recentErrors: recent.results?.filter(r => r.status !== 'success').map(r => ({
          time: r.started_at,
          error: r.error_message
        })).slice(0, 5) || []
      };
    }

    // Overall health
    const allHealthy = Object.values(health).every(h => h.status === 'healthy');
    const anyDown = Object.values(health).some(h => h.status === 'down');

    return new Response(JSON.stringify({
      overall: allHealthy ? 'healthy' : anyDown ? 'degraded' : 'degraded',
      timestamp: new Date().toISOString(),
      embassies: health
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Scraper health error:', error);
    return new Response(JSON.stringify({ error: 'Failed to fetch health' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Get data quality metrics
export async function handleDataQuality(request, env) {
  const auth = await requireAdmin(request, env);
  if (!auth.authorized) return auth.response;

  try {
    const embassies = ['new-delhi', 'beijing', 'dublin', 'abu-dhabi', 'abuja', 'ankara'];
    const quality = {};

    for (const slug of embassies) {
      // Total decisions
      const total = await env.DB.prepare(
        'SELECT COUNT(*) as count FROM embassy_decisions WHERE embassy = ?'
      ).bind(slug).first();

      // Decisions with all fields
      const complete = await env.DB.prepare(
        'SELECT COUNT(*) as count FROM embassy_decisions WHERE embassy = ? AND number IS NOT NULL AND decision IS NOT NULL AND date IS NOT NULL'
      ).bind(slug).first();

      // Duplicate check
      const duplicates = await env.DB.prepare(`
        SELECT number, COUNT(*) as cnt FROM embassy_decisions 
        WHERE embassy = ? GROUP BY number HAVING COUNT(*) > 1
      `).bind(slug).all();

      // Date range
      const range = await env.DB.prepare(`
        SELECT MIN(date) as min_date, MAX(date) as max_date 
        FROM embassy_decisions WHERE embassy = ?
      `).bind(slug).first();

      // Decisions per month (last 12 months)
      const monthly = await env.DB.prepare(`
        SELECT strftime('%Y-%m', date) as month, COUNT(*) as count
        FROM embassy_decisions 
        WHERE embassy = ? AND date >= date('now', '-12 months')
        GROUP BY month ORDER BY month
      `).bind(slug).all();

      quality[slug] = {
        totalDecisions: total?.count || 0,
        completeness: total?.count ? ((complete?.count || 0) / total.count * 100).toFixed(1) : 0,
        duplicateCount: duplicates?.results?.length || 0,
        dateRange: range ? { min: range.min_date, max: range.max_date } : null,
        monthlyTrend: monthly?.results || [],
        avgPerMonth: monthly?.results?.length 
          ? (monthly.results.reduce((sum, r) => sum + r.count, 0) / monthly.results.length).toFixed(1) 
          : 0
      };
    }

    return new Response(JSON.stringify({
      timestamp: new Date().toISOString(),
      embassies: quality
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Data quality error:', error);
    return new Response(JSON.stringify({ error: 'Failed to fetch quality metrics' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Get system metrics
export async function handleSystemMetrics(request, env) {
  const auth = await requireAdmin(request, env);
  if (!auth.authorized) return auth.response;

  try {
    // User metrics
    const users = await env.DB.prepare(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN created_at > datetime('now', '-7 days') THEN 1 END) as last_week,
        COUNT(CASE WHEN created_at > datetime('now', '-30 days') THEN 1 END) as last_month
      FROM users
    `).first();

    // Session metrics
    const sessions = await env.DB.prepare(`
      SELECT COUNT(*) as active_sessions FROM user_sessions WHERE expires_at > datetime('now')
    `).first();

    // Alert subscriptions
    const alerts = await env.DB.prepare(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN verified = 1 AND unsubscribed = 0 THEN 1 END) as active
      FROM email_subscriptions
    `).first();

    // Push subscriptions
    const push = await env.DB.prepare(`
      SELECT COUNT(*) as total FROM push_subscriptions
    `).first();

    // Data volume
    const dataVolume = await env.DB.prepare(`
      SELECT 
        (SELECT COUNT(*) FROM embassy_decisions) as visa_decisions,
        (SELECT COUNT(*) FROM stamp_1g_data) as stamp_1g,
        (SELECT COUNT(*) FROM work_permits) as work_permits,
        (SELECT COUNT(*) FROM community_timelines) as community_timelines
    `).first();

    // API usage (last 24h)
    const apiUsage = await env.DB.prepare(`
      SELECT 
        endpoint,
        COUNT(*) as requests,
        AVG(duration_ms) as avg_duration,
        MAX(duration_ms) as max_duration
      FROM api_logs 
      WHERE timestamp > datetime('now', '-24 hours')
      GROUP BY endpoint
      ORDER BY requests DESC
      LIMIT 20
    `).all();

    // Error rates
    const errors = await env.DB.prepare(`
      SELECT 
        endpoint,
        COUNT(*) as errors,
        AVG(duration_ms) as avg_duration
      FROM api_logs 
      WHERE timestamp > datetime('now', '-24 hours') AND status >= 400
      GROUP BY endpoint
      ORDER BY errors DESC
      LIMIT 20
    `).all();

    return new Response(JSON.stringify({
      timestamp: new Date().toISOString(),
      users: {
        total: users?.total || 0,
        lastWeek: users?.last_week || 0,
        lastMonth: users?.last_month || 0,
        activeSessions: sessions?.active_sessions || 0
      },
      subscriptions: {
        email: { total: alerts?.total || 0, active: alerts?.active || 0 },
        push: { total: push?.total || 0 }
      },
      dataVolume: dataVolume || {},
      api: {
        requests: apiUsage?.results || [],
        errors: errors?.results || []
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Metrics error:', error);
    return new Response(JSON.stringify({ error: 'Failed to fetch metrics' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Get error logs
export async function handleErrorLogs(request, env) {
  const auth = await requireAdmin(request, env);
  if (!auth.authorized) return auth.response;

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 1000);
  const hours = Math.min(parseInt(url.searchParams.get('hours') || '24'), 168);
  const level = url.searchParams.get('level') || 'error';

  try {
    let query = `
      SELECT * FROM error_logs 
      WHERE timestamp > datetime('now', ?) 
      AND level = ?
      ORDER BY timestamp DESC LIMIT ?
    `;
    const params = [`-${hours} hours`, level, limit];
    
    const logs = await env.DB.prepare(query).bind(...params).all();
    
    return new Response(JSON.stringify({
      logs: logs?.results || [],
      count: logs?.results?.length || 0
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error logs error:', error);
    return new Response(JSON.stringify({ error: 'Failed to fetch error logs' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Manual scraper trigger
export async function handleTriggerScraper(request, env) {
  const auth = await requireAdmin(request, env);
  if (!auth.authorized) return auth.response;

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { 
      status: 405, headers: { 'Content-Type': 'application/json' } 
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { 
      status: 400, headers: { 'Content-Type': 'application/json' } 
    });
  }

  const { embassy } = body;
  if (!embassy) {
    return new Response(JSON.stringify({ error: 'Embassy required' }), { 
      status: 400, headers: { 'Content-Type': 'application/json' } 
    });
  }

  // This would trigger the scraper - in production you'd use a queue
  return new Response(JSON.stringify({ 
    success: true, 
    message: `Scraper triggered for ${embassy}`,
    note: 'In production, this would trigger a background job'
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

// Manage admin tokens
export async function handleAdminTokens(request, env) {
  const auth = await requireAdmin(request, env);
  if (!auth.authorized) return auth.response;

  if (request.method === 'GET') {
    const tokens = await env.DB.prepare(`
      SELECT id, name, created_at, expires_at, last_used, revoked 
      FROM admin_tokens ORDER BY created_at DESC
    `).all();
    return new Response(JSON.stringify({ tokens: tokens?.results || [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
    
    const { name, expiresDays } = body;
    if (!name) return new Response(JSON.stringify({ error: 'Name required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    const token = 'admin_' + crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    const tokenHash = await hashPassword(token);
    const expiresAt = new Date(Date.now() + (expiresDays || 90) * 24 * 60 * 60 * 1000).toISOString();

    await env.DB.prepare(`
      INSERT INTO admin_tokens (token_hash, name, expires_at, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `).bind(tokenHash, name, expiresAt).run();

    return new Response(JSON.stringify({ 
      success: true, 
      token, // Only shown once
      name,
      expiresAt
    }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  }

  if (request.method === 'DELETE') {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (!id) return new Response(JSON.stringify({ error: 'ID required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    
    await env.DB.prepare('UPDATE admin_tokens SET revoked = 1 WHERE id = ?').bind(id).run();
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
}

// All handlers are already exported individually above
// This file uses named exports - no need for a collective export