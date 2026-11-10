export const EMBASSIES = new Set(['new-delhi', 'beijing', 'dublin', 'abu-dhabi', 'abuja', 'ankara']);

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export function ack(request) {
  const wantsHtml = (request.headers.get('Accept') || '').includes('text/html');
  if (wantsHtml) return Response.redirect(new URL('/', request.url).href, 303);
  return json({ ok: true });
}

export function generateToken() {
  return crypto.randomUUID();
}

export function invalidSubscription(formName, fields) {
  if (formName === 'subscribe') {
    const email = String(fields.email || '').trim().toLowerCase();
    const appNum = String(fields.application_number || '').trim();
    const embassy = String(fields.embassy || '').trim();
    if (!email.includes('@') || email.length > 254) return 'email';
    if (!/^\d{8}$/.test(appNum)) return 'application_number';
    const EMBASSIES = new Set(['new-delhi', 'beijing', 'dublin', 'abu-dhabi', 'abuja', 'ankara']);
    if (!EMBASSIES.has(embassy)) return 'embassy';
    return null;
  }
  return null;
}