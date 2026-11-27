# Moving to a custom domain

The site currently publishes at `https://irishvisaupdatetracker.pages.dev`.
Every generated canonical, Open Graph URL, JSON-LD `@id`, sitemap entry and
static Markdown link can move with one build variable:

```bash
SITE_ORIGIN=https://visa.example.ie npm run build
```

`tools/site-config.mjs` validates the origin and `tools/deploy-pages.mjs`
rewrites the generated `.html`, `.xml`, `.txt`, `.js`, `.css` and `.md` files.
The runtime base for `/api` links is separately controlled by
`APP_BASE_URL`; set both to the same origin.

This repository cannot buy a domain, change DNS or verify a Search Console
property. Those steps need the maintainer's accounts.

## Cutover checklist

1. **Choose the domain and add it to Cloudflare Pages.**
   - Pages project → Custom domains → Set up a domain.
   - Add the apex and `www` (or only one) and create the DNS record Pages asks
     for. Wait for the certificate to become active.

2. **Build with the new origin.**
   ```bash
   SITE_ORIGIN=https://visa.example.ie npm run build
   node tools/smoke-deploy.mjs  # uses SMOKE_BASE_URL, default pages.dev
   ```
   In the Pages project, add `SITE_ORIGIN=https://visa.example.ie` as a build
   environment variable so the Git integration uses it on every deploy.
   In GitHub, set `APP_BASE_URL` and `SITE_ORIGIN` variables to the new origin
   for `deploy-pages.yml`, `digest.yml`, `uptime.yml` and the smoke tests.

3. **Verify the generated output.**
   ```bash
   grep -R "irishvisaupdatetracker.pages.dev" .pages-dist \
     --include='*.html' --include='*.xml' --include='*.txt' \
     --include='*.js' --include='*.css' --include='*.md'
   ```
   The command should find nothing in generated public files, including the
   `webcal://` calendar links. Check one office page, `/monthly-report`,
   `/data`, `sitemap.xml`, `llms.txt` and the JSON-LD block in the page source.

4. **Redirect the old address.**
   Cloudflare Pages does not let this repository add DNS or a zone redirect for
   a `pages.dev` hostname. The router therefore supports a runtime fallback:
   set the Pages variable `PAGES_DEV_REDIRECT_ORIGIN=https://visa.example.ie`.
   It returns a `301` for `GET`/`HEAD` requests on the exact old host, preserving
   the path and query string; other hosts and `POST` requests are unaffected.
   Remove the variable if you ever need the old host to serve again.

   If you also control the `pages.dev` hostname through a zone or redirect
   rule, use it as the primary redirect and keep this fallback during the
   transition. Test both a clean URL (`/new-delhi-visa-decisions`) and a report
   permalink (`/reports/new-delhi/2026-11-19`) with `curl -I`, including the
   query string. Keep the old property in Search Console during the transition.
   Search Console does not follow a redirected sitemap, so submit the new
   domain's `/sitemap.xml` rather than relying on the old one.

5. **Search Console change of address.**
   - Add and verify the new domain as a property (DNS or HTML verification).
   - Keep the old `pages.dev` property verified.
   - Settings → Change of address → select the old property and the new one.
   - Submit the new sitemap: `https://visa.example.ie/sitemap.xml`.
   - Do not use URL Inspection for every URL. Inspect a changed page only after
     a meaningful edit.

6. **Re-run the production checks.**
   ```bash
   SMOKE_BASE_URL=https://visa.example.ie node tools/smoke-deploy.mjs
   node tools/check-links.mjs --base https://visa.example.ie
   ```
   Open the new domain's `/data`, `/monthly-report`, a report permalink and the
   six office pages in a browser and confirm the sitemap, canonical and social
   image URLs use the new host.

## Notes

- Do not change `SITE_ORIGIN` without rebuilding: the checked-in source pages
  keep the default origin as a fallback.
- The Pages project's own `*.pages.dev` hostname remains reachable unless
  `PAGES_DEV_REDIRECT_ORIGIN` is set (or a zone redirect is added). A canonical
  tag is a hint, not a redirect.
- Social cards live at `/assets/social/`; the generated URLs follow the new
  origin automatically.
- `TELEGRAM_CHANNEL_URL` and the other service variables are independent of
  the domain, but every link the digest and alerts build uses `APP_BASE_URL`.
  Update it before the first post-cutover digest.
