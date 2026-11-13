/**
 * Privacy-light product conversion events.
 *
 * Only a fixed vocabulary, a surface name and an optional public application
 * number are stored. No email, IP address, cookie or free text is accepted, so
 * this cannot become a shadow analytics profile.
 */

const EVENTS = new Set([
  'alert_cta_view',
  'alert_email_click',
  'alert_telegram_click',
  'alert_email_submitted',
  'alert_telegram_opened',
  'watchlist_added',
  'application_search',
  'activation_step_completed',
  'pwa_install_click'
]);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export async function handleEvents(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!env.DB) return json({ error: 'Database not configured' }, 503);

  let body;
  try {
    const length = Number(request.headers.get('Content-Length') || 0);
    if (length > 4096) return json({ error: 'Payload too large' }, 413);
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const event = String(body.event || '').trim();
  if (!EVENTS.has(event)) return json({ error: 'Unknown event' }, 400);
  const source = String(body.source || 'web').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'web';
  const applicationNumber = /^\d{8}$/.test(String(body.application_number || ''))
    ? String(body.application_number)
    : null;

  try {
    const { ensureSchema } = await import('./db-schema.js');
    await ensureSchema(env.DB);
    await env.DB.prepare(
      'INSERT INTO conversion_events (event, source, application_number) VALUES (?, ?, ?)'
    ).bind(event, source, applicationNumber).run();
    return json({ ok: true }, 202);
  } catch (error) {
    console.error('Conversion event store failed:', error.message);
    return json({ error: 'Event store unavailable' }, 503);
  }
}
