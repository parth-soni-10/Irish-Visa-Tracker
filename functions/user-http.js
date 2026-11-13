/** Shared response and session-cookie helpers for the user API. */

export function sanitizeInput(input) {
  return String(input).slice(0, 1000).replace(/[<>]/g, '');
}

export function getSessionIdFromCookie(request) {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(';').map(c => c.trim());
  const sessionCookie = cookies.find(c => c.startsWith('session_id='));
  if (!sessionCookie) return null;

  const value = sessionCookie.split('=')[1];
  // Format: userId:sessionId or just sessionId
  return value.includes(':') ? value.split(':')[1] : value;
}

export function tokenResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
