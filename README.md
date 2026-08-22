# Irish Visa Decision Tracker

A personal project that tracks visa decisions published daily by the Embassy
of Ireland, New Delhi, and turns them into a searchable, browsable dashboard.

The embassy publishes a spreadsheet of decisions each business day — a flat
file with no history, no search, no trends. This project scrapes that file
automatically, builds a running history of every application number and its
outcome, and presents it as a small dashboard with daily stats, acceptance/
rejection rates, and a way to look up an individual application.

## Architecture

```
GitHub Actions (scraper.py)  →  Google Apps Script (Code.gs, Web App)  →  Google Sheet
        ↑ runs ~9x/day (every 30 min, 08:00–12:00 IST)                     ↑ read/write API                    ↑ source of truth
                                           ↓
                                  index.html (dashboard, hosted on Netlify)
```

Google Sheets acts as the database — no separate backend, no hosting cost for
storage. Apps Script is the only thing that touches the Sheet directly,
exposed as a small Web App so both the scraper and the dashboard can talk to
it over plain HTTP.

The scraper treats the Apps Script `/exec` URL as the stable source URL. Google
Content Service redirects JSON responses to a short-lived
`script.googleusercontent.com` URL, so every read retry starts from `/exec`
again instead of reusing an expired redirect. Transient 404s, throttling,
timeouts, and gateway errors are retried with backoff. If the endpoint still
cannot be read, the run fails **before scraping or writing** so it can never
append duplicate history against an unknown Sheet baseline. A persistent 404
means the deployment was removed or `WEB_APP_URL` is stale: redeploy the Apps
Script as a Web App and update the GitHub secret with its current `/exec` URL.

## How it works

**The scraper** runs nine times a day (every 30 min from 08:00 IST to 12:00 IST). Every run works through a priority
chain before deciding what to do:

1. If today's date is already recorded, it does nothing — no wasted requests.
2. If today's a **weekend**, it records that the office is closed and stops;
   no point trying to scrape a file that was never going to exist.
3. Otherwise it checks the embassy's closure-dates page — if today's a listed
   public holiday, it records the holiday name and stops.
4. Otherwise it's a normal business day, so it goes and gets the actual `.ods`
   file: finds the download link on the visa-decisions page, downloads it,
   locates the real header row (the file has several title rows above it),
   and pulls out every application number and decision not already on record.
5. If no file dated today is found — the scrape failed, the site still hosts an
   older cumulative file (its filename carries the last covered day, published
   the following morning), or nothing new appeared — it falls back to a
   "hasn't uploaded yet" note dated today. It also backfills a placeholder for
   every empty day since the latest file's date, so a missed run (or a run
   that keeps finding yesterday's file) can never leave a silent hole in the
   daily summary.

New decisions are dated with the day they were **scraped** (today), not the
date in the file's filename — so the daily summary shows each day's count
against that day, regardless of which cumulative file it came from.

All of the fallback messages (weekend / holiday / not-uploaded-yet) use the
same mechanism: an **upsert**, not a plain insert. A second failed run the
same day overwrites the first message instead of creating a duplicate row,
and the moment real data actually arrives, any leftover placeholder for that
date gets deleted automatically. The Sheet never accumulates junk rows no
matter how many times a given day's scrape has to retry.

There's also a **gap alert**: if no genuinely new file has appeared for 3+
consecutive business days (Mon–Fri, excluding dates listed on the embassy's
closure page), the run fails loudly instead of quietly writing "no file" rows
forever. That turns a silent site change or publication outage into a red
GitHub Actions run you'll actually notice. Set `GAP_ALERT_BUSINESS_DAYS=0` to
disable it, or a higher number to raise the threshold.

**Sheet rotation (Code.gs):** Google Sheets caps a spreadsheet at 10 million
cells, and the Raw tab is 3 columns wide — so once the active Raw tab
approaches ~95% of that budget (~3.17M rows), the Apps Script automatically
creates the next tab (`Raw2`, `Raw3`, ...) and starts appending there. Every
Raw* tab is treated as one logical dataset: dedupe, placeholder cleanup, and
the dashboard's JSON all read across all of them in tab order, so history is
never split or lost. Tune it via `MAX_CELLS_PER_SPREADSHEET` /
`CAPACITY_WARN_PCT` at the top of `Code.gs`.

**The dashboard** has four tabs:

- **Home** — a live snapshot: total outcomes, day-on-day change, acceptance/
  rejection rates, and every result from the most recently published file.
  Includes a search box that looks up an application number across the
  entire history, not just the latest file.
- **Daily Summary** — one row per day: volume processed, day-on-day change,
  and that day's acceptance/rejection split.
- **Past Results** — the full history, with a date-picker filter (native
  calendar widget) that narrows the table and recalculates the acceptance/
  rejection cards to just that day.
- **Suggestions** — a form (name + note) submitted through **Netlify Forms**.
  Submissions land in the Netlify dashboard (Site settings → Forms →
  Submissions); nothing touches the Sheet for suggestions anymore.

Netlify needs the form in the served HTML to register it, but the dashboard
renders its tabs in JS — so `index.html` carries a hidden static twin of the
Suggestions form (same `name="suggestions"` and fields) that Netlify's form
detector picks up at deploy time. The visible form AJAX-posts
`form-name=suggestions` back to the site itself, which Netlify intercepts.

Day-on-day averages deliberately exclude 12 July 2026, an anomalous data day.
The dashboard fetches from the Sheet once per page load and holds it in
memory for the session — switching tabs doesn't re-fetch.

## Files

| File | Purpose |
|---|---|
| `scraper.py` | Scrapes the embassy site, runs the weekend/holiday/no-upload decision chain, pushes to the Sheet |
| `requirements.txt` | Python deps for the GitHub Actions runner |
| `.github/workflows/scrape.yml` | Schedule (every 30 min, 08:00–12:00 IST) + manual trigger |
| `Code.gs` | Apps Script backend — the only thing that reads/writes the Sheet (scraper data + placeholders only; suggestions are Netlify Forms) |
| `index.html` | The dashboard |
| `netlify.toml` | Static hosting config + security headers |

## Why it's built this way

The embassy's site blocks requests from major cloud IP ranges (AWS, GCP),
which is why the scraper runs on GitHub Actions instead of directly inside
Apps Script — GitHub's runner IPs get through where Google's own servers
don't. Google Sheets doubles as both the database and a free way to eyeball
the raw data by hand whenever needed, without building a separate admin view.
