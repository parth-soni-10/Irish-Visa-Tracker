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
        ↑ runs 4x/day                     ↑ read/write API                    ↑ source of truth
                                           ↓
                                  index.html (dashboard, hosted on Netlify)
```

Google Sheets acts as the database — no separate backend, no hosting cost for
storage. Apps Script is the only thing that touches the Sheet directly,
exposed as a small Web App so both the scraper and the dashboard can talk to
it over plain HTTP.

## How it works

**The scraper** runs four times a day. Every run works through a priority
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
5. If the scrape fails for any reason — site blocked, format changed, nothing
   published yet — it falls back to a "hasn't uploaded yet" note, dated
   yesterday, since decisions data always lags a day behind.

All of the fallback messages (weekend / holiday / not-uploaded-yet) use the
same mechanism: an **upsert**, not a plain insert. A second failed run the
same day overwrites the first message instead of creating a duplicate row,
and the moment real data actually arrives, any leftover placeholder for that
date gets deleted automatically. The Sheet never accumulates junk rows no
matter how many times a given day's scrape has to retry.

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
- **Suggestions** — a simple form (name + note) that writes straight into a
  separate tab in the Sheet.

Day-on-day averages deliberately exclude 12 July 2026, an anomalous data day.
The dashboard fetches from the Sheet once per page load and holds it in
memory for the session — switching tabs doesn't re-fetch.

## Files

| File | Purpose |
|---|---|
| `scraper.py` | Scrapes the embassy site, runs the weekend/holiday/no-upload decision chain, pushes to the Sheet |
| `requirements.txt` | Python deps for the GitHub Actions runner |
| `.github/workflows/scrape.yml` | Schedule (4x daily, IST) + manual trigger |
| `Code.gs` | Apps Script backend — the only thing that reads/writes the Sheet |
| `index.html` | The dashboard |
| `netlify.toml` | Static hosting config |

## Why it's built this way

The embassy's site blocks requests from major cloud IP ranges (AWS, GCP),
which is why the scraper runs on GitHub Actions instead of directly inside
Apps Script — GitHub's runner IPs get through where Google's own servers
don't. Google Sheets doubles as both the database and a free way to eyeball
the raw data by hand whenever needed, without building a separate admin view.
