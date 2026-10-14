/**
 * Irish Visa Tracker — the routing half of this site's Pages Function.
 *
 * Pages compiles this directory (see `functions/[[path]].js`, the catch-all
 * route) and it imports this file, so the site's whole server side is here. The
 * `_` prefix keeps it out of the routing table: the only route is the catch-all
 * beside it, which is also why nothing here has to think about a path pattern.
 *
 * This replaces Netlify Forms. The page's three forms (`suggestions`,
 * `timelines-visa`, `timelines-1g`) already POST urlencoded bodies to their own
 * path with a `form-name` field — Netlify used to intercept those posts and
 * record them. Nothing in the page changes: the same bodies arrive here.
 *
 * Behaviour, at parity with what the page's script expects:
 *   * The page's own AJAX submit only checks `res.ok`, then shows its success
 *     card — it gets a 200 JSON ack.
 *   * A no-JavaScript submit gets a 303 back to the tracker instead.
 *   * A filled `bot-field` honeypot is answered exactly like a stored
 *     submission but records nothing.
 *   * Submissions land in D1 (binding `DB`). Read them with:
 *       npx wrangler d1 execute irish-visa-tracker-submissions --remote \
 *         --command "SELECT id, form, created_at, fields FROM submissions ORDER BY id DESC LIMIT 20"
 *     or, for the timeline forms only, over HTTP:
 *       GET /api/community-submissions
 *
 * Every non-POST request is served straight from the static assets — with two
 * exceptions: the JSON in `data/` (below) is proxied from the repository, so the
 * dashboard keeps tracking the GitHub Actions pipeline without a redeploy, and
 * the timeline submissions are served at `/api/community-submissions` so the
 * nightly sync needs no Cloudflare credential (below).
 */

const FORM_NAMES = new Set(["suggestions", "timelines-visa", "timelines-1g"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY = 16 * 1024;

// The dashboard's data files are written by the GitHub Actions jobs
// (scraper.py, track_1g.py, track_permits.py, sync_timelines.py) and committed
// to the repo. The copies bundled into this Worker are a snapshot taken at
// deploy time, so serving them directly froze the site on the last deploy: the
// pipeline kept committing while the dashboard stayed days behind.
//
// Serve them from the repository instead, with a short cache (GitHub's copy is
// what the last pipeline run committed). A failed fetch falls back to the
// bundled asset, so the site still renders if GitHub is unreachable.
const REPO_RAW =
  "https://raw.githubusercontent.com/parth-soni-10/Irish-Visa-Tracker/main";
const DATA_RE = /^\/data\/(visa_decisions|visa_meta|stamp_1g|work_permits|community_timelines)\.json$/;
const DATA_CACHE_SECONDS = 300;

// The community-timeline sync (sync_timelines.py, run nightly by
// .github/workflows/timelines.yml) needs the rows the timeline forms wrote into
// `submissions`. It used to read them over Cloudflare's D1 query API, which
// means a D1 API token kept as a repo secret — and a secret nobody has created
// does not fail that job, it makes it print SKIP and exit 0, so the "Community
// waits" panels sat empty with nothing anywhere saying why.
//
// So the Worker serves them itself and the job needs no credential at all:
//
//     GET /api/community-submissions
//     → { "submissions": [ { form, fields, created_at }, … ] }
//
// Read-only, and deliberately narrow: the three timeline form names are the
// only ones ever returned. `suggestions` holds a visitor's name and their free
// text and is NOT served here — the sync has never read it either — while a
// timeline row carries applied/decided/outcome/tracker, which is the same data
// the job commits to data/community_timelines.json in a public repo, so serving
// it adds no exposure the pipeline does not already publish.
const SUBMISSIONS_PATH = "/api/community-submissions";
const TIMELINE_FORMS = ["timelines-visa", "timelines-1g", "timelines"];
const MAX_TIMELINE_ROWS = 5000;

// GitHub's raw host caches every URL for minutes and, on 2026-10-13, kept
// serving the copy it took before the pipeline's last commit — a plain fetch
// returned 2026-10-12 rows from a file that already held 2026-10-13, long
// after the push. Each cache window gets its own URL instead, so the first
// request in a window reaches GitHub and the rest share what it returns.
function repoUrl(pathname) {
  const window = Math.floor(Date.now() / (DATA_CACHE_SECONDS * 1000));
  return `${REPO_RAW}${pathname}?cb=${window}`;
}

async function serveData(request, env, url) {
  try {
    const upstream = await fetch(repoUrl(url.pathname), {
      headers: { Accept: "application/json" },
    });
    if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${DATA_CACHE_SECONDS}`,
      },
    });
  } catch (error) {
    // The bundled copy, kept in sync by the deploy itself.
    console.warn(`data proxy failed for ${url.pathname}:`, error);
    return env.ASSETS.fetch(request);
  }
}

// The table the Worker writes to. Created lazily on the first write so a new
// environment needs no migration step; schema.sql keeps the same statement as
// the reference copy.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  form TEXT NOT NULL,
  fields TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.prepare(SCHEMA).run();
  schemaReady = true;
}

/** The timeline submissions, for the nightly sync — never the `suggestions` form. */
async function serveTimelineSubmissions(env) {
  const placeholders = TIMELINE_FORMS.map(() => "?").join(", ");
  try {
    await ensureSchema(env.DB);
    const { results } = await env.DB
      .prepare(`SELECT form, fields, created_at FROM submissions `
               + `WHERE form IN (${placeholders}) ORDER BY id LIMIT ?`)
      .bind(...TIMELINE_FORMS, MAX_TIMELINE_ROWS)
      .all();
    return json({ submissions: results || [] });
  } catch (error) {
    console.error("timeline submissions read failed:", error);
    return json({ error: "Could not read submissions" }, 500);
  }
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

/** Success response shaped for either caller: the page's fetch, or a plain form submit. */
function ack(request) {
  const wantsHtml = (request.headers.get("Accept") || "").includes("text/html");
  if (wantsHtml) return Response.redirect(new URL("/", request.url).href, 303);
  return json({ ok: true });
}

/** Returns the name of the first invalid field, or null when the payload is acceptable. */
function invalidField(formName, fields) {
  if (formName === "suggestions") {
    if (!fields.name || fields.name.length > 200) return "name";
    if (!fields.suggestion || fields.suggestion.length > 2000) return "suggestion";
    return null;
  }
  // timelines-visa / timelines-1g — mirrors the page's own date checks.
  if (!DATE_RE.test(fields.applied || "")) return "applied";
  if (!DATE_RE.test(fields.decided || "")) return "decided";
  const today = new Date().toISOString().slice(0, 10);
  if (fields.applied < "2020-01-01" || fields.applied > fields.decided || fields.decided > today) {
    return "dates";
  }
  if (fields.outcome !== "granted" && fields.outcome !== "refused") return "outcome";
  return null;
}

export default {
  async fetch(request, env) {
    if (request.method === "POST") {
      const contentType = request.headers.get("Content-Type") || "";
      if (!contentType.includes("application/x-www-form-urlencoded")) {
        return json({ error: "Unsupported content type" }, 415);
      }
      if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY) {
        return json({ error: "Payload too large" }, 413);
      }

      let form;
      try {
        form = await request.formData();
      } catch {
        return json({ error: "Malformed body" }, 400);
      }

      const formName = String(form.get("form-name") || "");
      if (!FORM_NAMES.has(formName)) {
        // Netlify answered 404 for posts that matched no registered form.
        return new Response("Not found", { status: 404 });
      }

      // Spam: same answer as a stored submission, nothing recorded.
      if (String(form.get("bot-field") || "").trim() !== "") return ack(request);

      const fields = {};
      for (const [key, value] of form.entries()) {
        if (key === "bot-field") continue;
        fields[key] = String(value).slice(0, 4000);
      }

      const invalid = invalidField(formName, fields);
      if (invalid) return json({ error: `Invalid ${invalid}` }, 400);

      try {
        await ensureSchema(env.DB);
        await env.DB.prepare("INSERT INTO submissions (form, fields) VALUES (?, ?)")
          .bind(formName, JSON.stringify(fields))
          .run();
      } catch (error) {
        console.error("submission store failed:", error);
        return json({ error: "Could not store submission" }, 500);
      }
      return ack(request);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }
    const { pathname } = new URL(request.url);
    if (pathname === SUBMISSIONS_PATH) {
      const response = await serveTimelineSubmissions(env);
      // HEAD answers with the same status and headers, no body — like /data/*.
      return request.method === "HEAD"
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
    }
    if (DATA_RE.test(pathname)) {
      return serveData(request, env, new URL(request.url));
    }
    return env.ASSETS.fetch(request);
  },
};
