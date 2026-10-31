# Homestead Land Screener — project brief for Claude Code

Owner: Jason Nicholas. Current version: **v2.7.0**. Read this first, then `README.md` (features, data sources, version history) and `SPEC.md` (numbered requirements R1–R50, scoring rules, architecture).

## What it is
A browser-only static site that scores rural land parcels from free public data. The first buyer (the owner) is looking for about 10 acres in central Texas within 2 hours of the San Antonio or Austin airports, but it works anywhere in the US. No backend, no accounts, no API keys, no build step. Data is saved in the browser (localStorage).

## Where things live
- Local folder (Windows): `C:\Dev\AI Vibe Coded\Vibed_HomeStead_Screener`
- Repo: https://github.com/jnicholas1692/Vibed_HomeStead_Screener
- Live site (GitHub Pages): https://jnicholas1692.github.io/Vibed_HomeStead_Screener/
- The main page links to the repo ("a personal test of AI-assisted development").

## Stack and layout
Plain HTML, CSS and vanilla JavaScript; Leaflet (loaded from unpkg) for the map. Classic scripts share one global scope and load in this order from `index.html`:
- `js/config.js` — constants, `DEFAULT_SETTINGS`, `DATA_SOURCES`, `REPORT_SECTIONS`, `REPORT_GROUPS`, hover-help tables (`GLOSSARY`, `FACTOR_TIPS`, `SETTING_TIPS`, `UI_TIPS`, `SECTION_TIPS`)
- `js/scoring.js` — scoring, dealbreakers, section grouping, `glossaryTip`, `sourceKeysUsed`
- `js/sources.js` — all data lookups and their parsers (federal services, Texas block, "more local conditions")
- `js/storage.js` — localStorage (settings, parcels, collapsed groups), import/export, migrations
- `js/ui.js` — rendering, dialogs, tooltips, report, compare table
- `css/styles.css`
- `tests/` — Node unit tests (`node --test`), with `tests/load.js` loading the browser scripts in a `vm` and providing `fakeFetch`
- `test_site.py` — Playwright browser suite (229 checks) with every outside service faked. Committed since v2.2.1 (the older ~297-check version was never committed and is lost). Run it before releases. It starts its own server on port 8765, so make sure no stale server is holding that port.

## Scoring (v2.3+)
Criteria you tick (`settings.criteria = { order, on }`, keys of `FACTOR_LABELS`): septic, airport, price, internet, slope, rain (ticked by default), plus flood risk, groundwater depth, natural hazard rating, hospital drive, grocery drive (unticked by default). The total is the plain average of ticked criteria with data; missing data is skipped, never zero. Your order drives the report summary table, the first 3 list columns (`LIST_CRITERIA_COLUMNS`) and the top of the compare table. Each criterion has a dealbreaker switch that works even when unticked. Septic: not limited 100, somewhat 60, very limited 15. The old 10-point skill tree (and older weights) is converted once in `storage.js` via `criteriaFromPoints`. Each scoring range is a two-ended slider (`RANGE_PAIRS` in config.js, linked to the number boxes by `syncRangePair` in ui.js). `settings.uses` holds the ticked land uses; `LAND_USES` holds their recommended ranges and criteria (rules of thumb), combined by `recommendedRanges` (stricter wins). Hunting was removed in v2.1.0.

## Rules that must not be broken
- Free public data only, no API keys in the code. User-supplied keys live in Settings and are sent only to their own service: the Census key (tax rate only now) and the api.data.gov key for FBI crime figures. People and community figures come from Census Reporter, which needs no key.
- Never store or show parcel owner name, mailing address or situs address from the Texas parcel service; a test checks that "SECRET OWNER" never reaches the page.
- Every lookup fails soft: one failing service must not break the report; failures are listed and the score says how many factors had data.
- Hover help for every new label, button and setting (add to the tip tables; `tests/tips.test.js` enforces coverage). Tips must also work by tapping on a phone: `test_phone_width` in test_site.py taps every kind of dotted label with touch emulation.
- Every new report section goes into exactly one group in `REPORT_GROUPS` and into `REPORT_SECTIONS`.
- Services must be checked from a real browser for CORS before being relied on. The sandbox cannot reach most of them. Known dead ends: NOAA Atlas 14 (no CORS), the old USDM county API (use the ArcGIS `USDM_current` layer), the Texas parcel `/query` endpoint (use `MapServer/identify`).
- Honest wording about data limits; show what's missing or uncertain.

## Texas-only data (shown only when `isTexasParcel`)
TxGIO parcels (identify request; fields: PROP_ID, LEGAL_AREA, GIS_AREA, LAND/IMP/MKT_VALUE, TAX_YEAR, YEAR_BUILT, STAT/LOC_LAND_USE, plus owner and address fields that must never be kept; no exemption or taxable-value fields, and STAT_LAND_USE was Null in every county checked), TWDB groundwater conservation districts and wells, TEA school districts, Railroad Commission pipelines and oil/gas wells, Edwards Aquifer recharge zone. School district uses the `NAME` field; aquifer names have their code prefix stripped.

## GitHub setup
- Default branch: `main`. Releases are annotated tags `vX.Y.Z` (the first tag is v2.2.0; earlier releases were not tagged).
- Workflow `.github/workflows/test.yml` ("Tests"): runs on every push and pull request; ubuntu-latest, Node 22, `npm test`.
- `package.json`: `"test": "node --test"`, private, no dependencies.
- `.gitignore`: `node_modules/`, `.DS_Store`, `Thumbs.db`, `*.log`, `.vscode/`.
- GitHub Pages serves the site from the repo (static files at the root, no build). I did not see the Pages settings page; check Settings → Pages to confirm the source branch and folder.
- Branch protection and other repo settings: not known to me; check on GitHub.

## Git workflow used so far
1. Branch per feature (`feature/<name>`), commit, merge into `main` with `--no-ff`, tag `vX.Y.Z`.
2. Update `README.md` (version history), `SPEC.md` ("Last updated for", requirement rows, test counts), `APP_VERSION` and `APP_UPDATED` in `js/config.js`, and `version` in `package.json` in the same change (`tests/version.test.js` checks they agree).
3. Commit trailers used by Claude: `Co-Authored-By: Claude <noreply@anthropic.com>` (use the model's current name).
4. Release flow on the owner's PC: `npm test`, `git add -A`, `git commit`, `git pull --rebase`, `git push`; Pages updates a minute or two after the push.

## Testing before any release
- `npm test` → 183 unit tests, must all pass (also runs in GitHub Actions).
- `python test_site.py` (needs Playwright and Chromium, installed on the owner's PC) → 229/229 on v2.7.0.
- After shipping, spot-check the live site in a real browser; mocked tests cannot prove a real service still answers.

## Known gaps and ideas
- County/hardiness "Request failed" and public-land timeouts seen intermittently in the real browser.
- Overpass on 2026-10-31: overpass-api.de answered 502 "at capacity", kumi.systems and private.coffee hung past 30 s, openstreetmap.fr worked; overpass.osm.jp blocks browser requests and maps.mail.ru hung, so neither was added. Road failures were mostly a bug (null points in `out geom(box)` replies), fixed in v2.4.0. Nearby places still have no backup source when every Overpass server fails.
- Compare table is not grouped into categories (only the per-parcel report is).
- Tutorial document (Claude Docs project `385d0a6c-076f-42cc-9074-dbfb01b1895a`) stops at v1.5.0.
- Ideas from SPEC: small caching proxy, county parcel boundaries, newer FCC broadband data, import listings from a saved search.
- Added in v2.7.0 (checked live): Census Reporter `data/show/latest` (its `geo/search` is blocked in browsers; the tract GEOID comes from the Census geocoder's existing reply) and the FBI CDE `agency/byStateAbbr` and `summarized/agency/<ORI>/V|P` (key required; `DEMO_KEY` works for testing only, about 30 requests an hour; the 2025 request failed with 503 on 2026-10-31, so the code falls back a year).
- Added as road backups in v2.4.0 (checked live): Census TIGERweb Transportation layers 2, 6 and 8; OSRM `nearest`.
- Checked from the live site on 2026-10-31 and left out: CMS hospital data (blocks browser requests); Urban Institute schools (ignores the county filter, so the smallest query is all of a state: about 9,700 rows, 19 s). OpenFEMA declarations answered and were added.
- Tax exemptions come from the user (tick boxes on the parcel); appraisal districts each run their own systems with no shared API. Links go to the Comptroller's directory, `.../county-directory/<county letters>.php` (pattern checked for all 254 counties).
- Sources deliberately not added: those needing API keys (NREL, NASS, FBI, AirNow, HUD, BEA, EIA), bulk-download-only data (HRSA, BTS), and county appraisal tax rates (no API).

## Working style the owner prefers
Clear, readable code over clever code, with plain-language comments on confusing syntax (regex etc.). Be strictly honest about what was and wasn't verified.
