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
- The results are kept in a **Google Sheet** (no separate database, no hosting cost).
- A simple dashboard reads from that sheet, so everything stays up to date by itself.

## Checking your own application

Open the **Home** tab and type your application number into the search box. If it's in the published lists, it'll appear with its date and outcome.

## Run it locally

No build tools needed. Open `index.html` in a browser, or serve the folder with a tiny local server:

```
python -m http.server
```

The live sections read from the Google Sheet, so they need an internet connection.

## Built with

Plain **HTML / CSS / JavaScript** for the dashboard, a little **Python** for the automation, and **Google Apps Script** to read and write the sheet. Hosted on **Netlify**.

## Set up secure writing (required)

The dashboard reads are public, but all **writes** to the tracker require a shared secret so that only the scraper can add data. If this isn't set up, the scraper will report errors and no new rows will be added.

1. In **Apps Script** (the `Code.gs` project): *Project Settings → Script properties →* add `VISA_WRITE_SECRET` with a long random string.
2. In **GitHub Actions** secrets (repo → Settings → Secrets and variables): add `VISAS_WRITE_SECRET` with the **same** value.

Make a strong random value, e.g. `openssl rand -hex 32`, and use it in both places.

---

*A personal project made to make life a little easier for people tracking their applications.*