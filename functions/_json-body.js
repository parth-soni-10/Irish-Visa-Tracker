/**
 * Bounded JSON body reader for the Pages Functions.
 *
 * `request.json()` buffers whatever the caller sent, so an oversized or endless
 * body costs memory and CPU before the handler can reject it. The router caps
 * urlencoded form posts at 16 KB; this is the same ceiling for JSON, enforced
 * first on the declared length and again while the stream is read (a chunked
 * request has no Content-Length).
 */

export const MAX_JSON_BODY_BYTES = 16 * 1024;

function join(chunks, size) {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Resolve to `{ body }` on success, `{ tooLarge: true }` past the limit, or
 * `{ invalid: true }` for a missing, unreadable or non-JSON body.
 */
export async function readJsonBody(request) {
  const declared = Number(request.headers.get('Content-Length') || '');
  if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) return { tooLarge: true };
  if (!request.body) return { invalid: true };

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    return { invalid: true };
  }

  let text;
  try {
    text = new TextDecoder().decode(join(chunks, size));
  } catch {
    return { invalid: true };
  }
  if (!text.trim()) return { invalid: true };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { invalid: true };
  }
}
