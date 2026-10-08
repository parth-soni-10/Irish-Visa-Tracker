# Irish Visa Decision Tracker

A personal tool that keeps an eye on the daily visa-decision list published by the **Embassy of Ireland in New Delhi**, and turns it into a clean, searchable dashboard.

## Why it exists

Every business day the embassy posts a spreadsheet of visa decisions. It's a single flat file — **no history, no search, no trends**. If you were applying, checking your decision meant opening that day's file and hunting.

This project saves a running record automatically, so you can:

- See the **latest decisions** on the day they're published
- **Look up any application number** and see its outcome
- Browse **daily summaries** of how many were accepted vs rejected
- Watch **trends over time** — acceptance and rejection rates, busiest days

## How it works (in plain English)

- A small automated **scraper** checks the embassy's site several times each morning and saves anything new.
- It's smart about **weekends and public holidays** — if the office is closed, it simply notes that and moves on.
- The results are kept in **JSON files in this repo** (`data/visa_decisions.json`) — no separate database, no hosting cost, no backend to deploy.
- A simple dashboard reads those files, so everything stays up to date by itself.
- The embassy's published file is sorted by **application number**, not decision date — so a day's count in the dashboard can't be verified by counting rows from the end of the file.

## Checking your own application

Open the **Home** tab and type your application number into the search box. If it's in the published lists, it'll appear with its date and outcome.

## Run it locally

No build tools needed. Open `index.html` in a browser, or serve the folder with a tiny local server:

```
python -m http.server
```

The dashboard reads the static JSON in `data/`, so serve the folder over HTTP as shown above — browsers block `fetch()` of local files when a page is opened via `file://`.

### Run the scraper tests

```
python -m pip install -r requirements.txt
python -m pytest
```

## Built with

Plain **HTML / CSS / JavaScript** for the dashboard and a little **Python** for the automation. Hosted on **Netlify**.

## No setup, no secrets

Older versions of this project stored data in a Google Sheet behind an Apps Script web app (see git history for `Code.gs`). That whole layer is gone: the scraper commits its results straight into `data/` and the dashboard reads them as static files. Fork the repo, enable Actions, deploy on Netlify — nothing to paste anywhere.

## Optional: community timelines

Visitors can share applied → decided dates via two separate forms: embassy visas on the Suggestions tab (`timelines-visa`) and Stamp 1G renewals on the 1G page (`timelines-1g`). A nightly job (`timelines.yml`) pulls both Netlify forms' submissions into `data/community_timelines.json`, which powers the "Community waits" panels. Needs `NETLIFY_TOKEN` (Netlify User settings → Applications → New access token) + `NETLIFY_SITE_ID` (Site settings → General → API ID) as repo secrets. Without them the job skips and the panels invite the first report.

## Optional: outage alerts

If the scraper goes 3+ business days without seeing a new visa-decisions file, it fails the run loudly (a red X in Actions). To also get that pushed somewhere you actually watch, add an **`ALERT_WEBHOOK_URL`** repo secret — a Slack incoming webhook, a Discord webhook, or any generic endpoint that accepts a JSON POST. `scrape.yml` passes it to the scraper, which sends the alert there as well. Leave it unset and nothing changes: the red X still happens.

---

*A personal project made to make life a little easier for people tracking their applications.*