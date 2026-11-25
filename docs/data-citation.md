# Dataset citation, DOI and catalog registration

The tracker can describe itself as a dataset, but it cannot mint a DOI. That
requires a deposit with a repository under the maintainer's account. This
runbook keeps the claim honest: the Dataset markup ships now, the identifier
appears only after a deposit returns one, and the catalog registrations are
listed with their real state.

## What already exists

- `/data-study` — the study page a citation should point at.
- `/press` — citation text, reusable charts and the deposit note.
- `/data/snapshots/<date>/metadata.json`, `CITATION.cff`, `zenodo.json` — the
  versioned deposit files the build writes for each data date.
- Office pages — `Dataset` JSON-LD with name, description, landing page,
  licence, publisher, `isBasedOn` the official source, `variableMeasured`,
  `spatialCoverage` and three `DataDownload` entries (office JSON, manifest,
  office summary CSV). This is the shape Google Dataset Search reads.
- `data/dataset-identity.json` — the single place the DOI is recorded.

## Deposit with Zenodo (mints the DOI)

1. Sign in to Zenodo with the maintainer account; do not use a shared token.
2. Upload the snapshot directory for one data date, not the whole repository:
   `metadata.json`, `CITATION.cff`, `zenodo.json`, the office JSON files and the
   study CSVs.
3. Use `.zenodo.json` as the deposit metadata. It already declares
   `upload_type: dataset`, open access, the creator, the study URL and the
   snapshot as a related identifier.
4. Publish. Zenodo then returns a **concept DOI** (all versions) and a
   **version DOI** (this snapshot).
5. Put the concept DOI and its resolver URL into `data/dataset-identity.json`:

   ```json
   {
     "doi": "10.5281/zenodo.XXXXXXX",
     "doiUrl": "https://doi.org/10.5281/zenodo.XXXXXXX",
     "catalogStatus": { "zenodo": "deposited" }
   }
   ```

6. Regenerate the office pages (`node tools/office-pages.mjs --write`) and
   rebuild. The Dataset markup gains:

   ```json
   "identifier": { "@type": "PropertyValue", "propertyID": "DOI", "value": "10.5281/zenodo.XXXXXXX" }
   ```

   Until then the markup omits `identifier` rather than inventing one.

Do not edit `tools/office-pages.mjs` to hard-code a DOI. The identity file is
read at generation time so there is one source of truth.

## Catalog registration

Register the DOI record only after step 6 has shipped.

| Catalog | What it needs | State |
| --- | --- | --- |
| Zenodo | the deposit itself | not deposited |
| DataCite | a repository that registers DOIs (Zenodo does this on publish) | not registered |
| OpenAIRE | the DOI, harvested from DataCite or Zenodo | not registered |
| re3data | a repository record, not a single dataset; applies to the archive, so it is optional | not registered |
| Google Dataset Search | crawlable `Dataset` markup plus a `license` and `distribution` URL | markup shipped; discovery depends on Google's crawl |

Registration state lives in `data/dataset-identity.json` under `catalogStatus`.
Update it when a record actually exists; never mark a catalog as registered
because the metadata is ready.

## Verify the markup

- Rich Results Test: `https://search.google.com/test/rich-results` on one office
  page. Expect `Dataset`, `FAQPage` and `BreadcrumbList` to parse without errors.
- Schema.org validator: `https://validator.schema.org/` for the `@graph`.
- After a custom domain move, re-run both: the `@id` and `contentUrl` values are
  built from `SITE_ORIGIN`.

## What not to claim

- A DOI does not exist until a repository returns one.
- Dataset Search eligibility is not an index guarantee.
- A catalog record is not a citation. Citations come from people using the data.
