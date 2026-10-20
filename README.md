# Irish Visa Decision Tracker

A personal tool that watches the daily visa-decision list published by the **Embassy of Ireland in New Delhi** and turns it into a clean, searchable dashboard.

**Live:** https://irishvisaupdatetracker.pages.dev

## Why it exists

Every business day the embassy posts a spreadsheet of visa decisions — a single flat file with no history, no search and no trends. Checking your own application meant opening that day's file and hunting through it. This project keeps a running record automatically, so you can:

- **Look up any application number** and see its outcome and date
- **See the latest decisions** on the day they are published
- **Browse daily summaries** of accepted versus rejected
- **Watch trends over time** — rates, busiest days, and the shape of a month
- **Follow community waits** for embassy visas and Stamp 1G renewals, from submissions other visitors share

## How it works

A small scheduled **scraper** checks the embassy's site every morning, notes weekends and public holidays when the office is closed, and commits anything new into JSON files in `data/`. The dashboard reads those files, so a pipeline run appears on the live site with no redeploy. Community timeline submissions and suggestions go through the deployment's own function into D1.

## Notes

- Unofficial, and no visa outcome is guaranteed; it only reflects what the embassy has published.
- A run that sees no new file for a few business days fails loudly, and can also post to a webhook if one is configured.

## Built with

Plain **HTML / CSS / JavaScript** for the dashboard and **Python** for the scraping, hosted on **Cloudflare Pages** with a function and a D1 store for the forms.
