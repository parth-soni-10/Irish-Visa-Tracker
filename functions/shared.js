export const EMBASSIES = new Set(['new-delhi', 'beijing', 'dublin', 'abu-dhabi', 'abuja', 'ankara']);

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
