# Homestead Land Screener: Specification

> DRAFT SKELETON. Rewrite every section in your own words before publishing.
> Items marked **[YOUR CALL]** are decisions only you can state.
> Last updated for v2.6.0.

## 1. Problem

[YOUR CALL: say it in two or three sentences, in your voice.]
Buying rural land means checking the same things for every listing: flood risk, soil and septic suitability, slope, rainfall, internet, distance to an airport and to basic services. The data is public but scattered across seven agencies, so people skip checks or do them inconsistently.

## 2. Users

- **Primary:** one buyer (the author) comparing 10 to 30 candidate parcels while searching for about 10 acres within 2 hours of a major airport.
- **Secondary:** anyone searching anywhere in the US who is willing to set their own criteria.
- **Not a user:** surveyors, lenders and county staff. This tool does not replace them.

## 3. Goals and non-goals

**Goals**
- G1. Turn an address or map click into a scored, explained parcel summary in one step.
- G2. Use only free public data and no API keys.
- G3. Run with no backend, no account and no build step.
- G4. Show which data is missing or uncertain, never hide it.
- G5. Work for any location in the US (added in v1.1).
- G6. Show everyday needs, schools, emergency access, hazard risk and growing zone for each parcel (added in v1.2).

**Non-goals**
- N1. Parcel boundaries, ownership or listing data.
- N2. Legal, survey or financial advice. Costs are rough placeholders.
- N3. Multi-user sync, accounts or cloud storage.
- N4. Mobile app. The site should work on a phone but is not designed around one.

## 4. Requirements and acceptance criteria

| ID | Requirement | Acceptance criteria | Built in |
| --- | --- | --- | --- |
| R1 | Add a parcel by street address or map click | Address resolves through the Census geocoder; a bad address gives a clear message; the map click stores coordinates | v1.0.0 |
| R2 | Look up flood, soil, slope, rain, county, internet | Each source fills in independently; one failure does not block the others; failed sources are labelled | v1.0.0 |
| R3 | Score 0 to 100 from weighted factors | Missing factors are skipped, not scored as zero; the score says how many factors had data; since v2.3.0 the score is the plain average of the criteria you tick (see R55) | v1.0.0 |
| R4 | Dealbreakers | A parcel is flagged, and can be hidden from the list, when a factor with its dealbreaker switch on reaches its worst end; since v2.0.0 each criterion has its own switch (see R41) | v1.0.0 |
| R5 | Choose airports | Default is the nearest major US airport from a built-in list of about 100; the user can instead supply their own list | `feature/airport-picker` (0cb02b4), then `feature/nationwide` (a4b677a) |
| R6 | Nearest grocery, hardware, Costco, feed store, vet | Five results per parcel or "none found"; search radius widens in steps; busy server is retried on a mirror | `feature/nearby-places` (e2975a5) |
| R7 | Road drive times | Routed minutes when OSRM answers; clearly marked estimates when it does not | `feature/road-drive-times` (9327fb8) |
| R8 | Sort and filter | Sort by score, price, internet speed or airport time; filter by status; hide dealbreakers; choice survives reload | `feature/sort-and-filter` (22efcf8) |
| R9 | Work anywhere in the US | County plus state shown; non-US coordinates rejected with a hint; map opens on the whole country | `feature/nationwide` (a4b677a) |
| R10 | Compare up to three parcels | Best value per row starred only when values differ; fourth pick refused with a message | `feature/compare` (c7da63e) |
| R11 | Rough cost estimate | All rates editable; every screen says they are placeholders; very limited soil uses the engineered septic price | `feature/monthly-cost` (5e01219) |
| R12 | Print and copy a summary | Print shows only the open parcel; copy falls back to a text box if the clipboard is refused | `feature/print-summary` (e17d465) |
| R13 | Nearest elementary, middle and high school | Each level shows the nearest school, its straight-line miles and drive time, or "none found"; a school serving several levels (K-8) counts for each; schools with no level information are not guessed | `feature/schools` |
| R14 | Nearest fire station, police station and emergency hospital | Same display as R13; hospitals marked as having no emergency department are skipped; the page says to call before relying on a listing | `feature/emergency-services` |
| R15 | Natural hazard risk from the FEMA National Risk Index | All 18 hazards FEMA rates are listed with their ratings for the parcel's census tract; hazards marked not applicable are hidden; overall rating shown; display only, not scored | `feature/hazards` |
| R16 | USDA plant hardiness zone | Zone and minimum-temperature range from the 2023 USDA map data, looked up by ZIP code; labelled as ZIP-level; display only, not scored | `feature/hardiness-zone` |
| R17 | Soil details | Texture, depth to bedrock and water table, flooding and ponding, shrink-swell, and building and road ratings for the main soil at the point; "not looked up" for parcels saved before the feature; display only | `feature/soil-details` |
| R18 | Frost, climate and solar | Average last spring and first fall freeze, frost-free days, days over 100 F, snow, and full-sun hours with a rough solar output, from ten years of daily weather; labelled as a model, not a station; display only | `feature/climate-solar` |
| R19 | Road access | Nearest road and nearest paved public road, with distance and surface; says it is not proof of legal access; since v2.4.0 with backup sources (see R60) | `feature/road-access` |
| R20 | Wetlands | Whether the point is on a mapped wetland and how many are within about a quarter mile; says it is not a legal delineation | `feature/wetlands` |
| R21 | Public and protected land | Nearest protected areas up to 25 miles, with manager and public-access level; areas with unknown access are left out | `feature/public-land` |
| R22 | County property tax rate | Median real estate tax divided by median home value for the county (Census ACS 5-year); needs a free Census key, kept in the browser; a missing key is a message and not a failure; used in the cost estimate unless turned off | `feature/county-tax` |
| R23 | Groundwater | Up to three nearest USGS monitoring wells within about 17 miles that have a depth-to-water reading in the past 10 years; says a monitoring well is not your lot | `feature/groundwater` |
| R24 | Show the source of every piece of data | Each section of the detail window shows its source with a link and the data date; the report ends with a list of sources with web addresses so it reads on paper; the copied summary ends with a Data sources block; the compare table lists its sources; one table (`DATA_SOURCES`) feeds all four, and a source that returned nothing is not listed | `feature/data-sources` |
| R25 | Hover help on labels | Labels in the report, the compare table and the factor table show a dotted underline; hovering, tapping or tabbing to one shows what the data means and which agency supplies it; Escape closes the tip without closing the report; a test fails if a label is added without an explanation | `feature/hover-help` |
| R26 | Live report and pinned buttons | The report opens as soon as a parcel is added or refreshed, shows each lookup's data as it finishes with a count of lookups done, keeps the scroll position and any typed notes, and the Refresh, Print, Copy summary, Save notes, Delete and Close buttons stay at the top while the report scrolls | `feature/live-report` |
| R27 | Gentle with the free map servers | Roads and nearby places ask the Overpass servers one request at a time; when every server fails, the error names each server and why | `feature/live-report` |
| R28 | Delete from the list | Every row in the parcel list has a Delete button; the first click asks "Click again to delete" for 4 seconds, the second removes the parcel | `feature/list-delete` |
| R29 | Lighter nearby-places query | The places query uses exact tags and names only (no name patterns, which time out); servers are tried starting with the last one that worked; each request waits up to 30 seconds | `fix/lighter-places-and-clear-data` |
| R30 | Clear data | A Clear data button erases the parcels, criteria and map view this app saved in the browser, after a second click to confirm | `fix/lighter-places-and-clear-data` |
| R31 | Address suggestions | Typing 4 or more characters in the Address box shows up to six US suggestions (street, city, state, ZIP) from OpenStreetMap through photon.komoot.io, after a short pause in typing; arrow keys, Enter, Escape or a click pick one; picking fills the latitude and longitude unless the person typed their own; editing the address afterwards clears coordinates a suggestion filled; if the service is down the box says so and typing still works | `feature/address-suggest` |
| R32 | Name defaults to the address | The Name box follows the address until the person types their own name; leaving the name blank saves the address as the name | `feature/address-suggest` |
| R33 | Edit a parcel | An Edit button in the report opens the Add window filled in with the parcel's name, address, coordinates, acres and price; saving updates the list, score and cost; changing the coordinates clears the looked-up data and fetches it again; closing without saving returns to the report unchanged | `feature/edit-and-order` |
| R34 | Report section order | Settings has Up and Down buttons for the 11 middle sections of the report (the score and factors stay first, the data sources and notes stay last); the order is saved in the browser, applies to the report and printout, and sections missing from a saved order are added at the end | `feature/edit-and-order` |
| R35 | Down payment in dollars | Settings has a cash down payment in dollars (default $20,000) in place of the old percent; it is never more than the price; saved percents from older versions are converted once using the price target | `feature/loans-usda` |
| R36 | Asking price in the list | The parcel list shows the asking price right after the parcel name | `feature/loans-usda` |
| R37 | 30-year FHA and conventional loans | The cost section compares your land loan with a conventional and an FHA 30-year loan at the same price: down payment (raised to the loan's minimum of 3% or 3.5% and flagged), amount borrowed, rate, principal and interest, mortgage insurance (PMI under 20% down; FHA 1.75% upfront added to the loan plus a yearly premium for 11 years at 10% down or more, otherwise for the whole loan), tax and insurance, and monthly total; it says bare land cannot be financed this way and flags an FHA loan above the national limit floor | `feature/loans-usda` |
| R38 | USDA loan area | A Yes or No in the list, the report and the compare table: Yes when the point is outside every ineligible area on USDA Rural Development's single family housing eligibility map; the report says income limits and a home purchase still apply | `feature/loans-usda` |
| R39 | Drag to reorder report sections | In Settings each section row has a drag handle; dragging a row moves it live, scrolls the window near its edges, and the Up and Down buttons still work for the keyboard | `feature/drag-order` |
| R40 | Skill tree scoring (replaced by R55 in v2.3.0) | Settings > Scoring has 10 points to spend on septic, slope, rain, airport, price and internet with plus and minus buttons and a points-left counter; a factor with 0 points is not scored; saving needs at least one point; weights saved by older versions are converted once into whole points (flood dropped) | `feature/skill-tree-scoring` |
| R41 | Dealbreaker switch per criterion | Each factor and the flood zone has a Dealbreaker switch: flood in a high-risk zone, septic very limited, slope / rain / price at the zero end of the range, airport drive over the limit, not in a hunting county, no wired or fixed wireless internet or speed at the zero end; missing data never triggers one; older settings keep flood and airport on | `feature/skill-tree-scoring` |
| R42 | Flood zone as Yes or No | The list, the report and the compare table say Yes (with the zone and "high risk") or No (with the zone) or Unknown; it is not in the factor table | `feature/skill-tree-scoring` |
| R43 | Settings tabs | Settings has Scoring, Costs and loans, and Report layout tabs; an error on another tab opens that tab | `feature/skill-tree-scoring` |
| R44 | Pinned action buttons | Settings (with its tabs), the Add and Edit window and the Compare window keep their buttons at the top while the window scrolls | `feature/skill-tree-scoring` |
| R45 | Groundwater via USGS Water Data API | Three calls (well list in a box, latest depth reading, names); nearest 3 wells shown with measured date and age; notice when all are over 10 years old | `fix/groundwater-new-usgs-api2` |
| R46 | Hover explanations everywhere | Every data label, table header, button and Settings option has a hover or keyboard-focus explanation; the septic tip spells out the 100 / 60 / 15 scores and factor tips follow the current ranges | `feature/tooltips-texas-no-hunting` |
| R47 | Hunting removed | No hunting county list, factor, dealbreaker or text; old saved hunting weights are dropped on load | `feature/tooltips-texas-no-hunting` |
| R48 | Texas details | For Texas parcels only: appraisal-district parcel record (acres, land and market value; owner details are never read), groundwater conservation district, school district, nearby TWDB wells, pipelines and oil and gas wells (Railroad Commission), Edwards Aquifer recharge zone | `feature/tooltips-texas-no-hunting` |
| R49 | More local conditions | County population, income and broadband (Census), current drought category, weather office and alerts, wind and humidity (NASA POWER), nearby regulated facilities (EPA ECHO); each fails on its own | `feature/tooltips-texas-no-hunting` |
| R50 | Collapsible categories | The report is grouped into six collapsible categories (Overview; Land, soil and water; Access and services; Climate, hazards and area; Texas; Cost and loans) with Expand all / Collapse all; open state is remembered and all open when printing | `feature/tooltips-texas-no-hunting` |
| R51 | Census key sign-up link | Settings > Costs and loans shows a "Get a free Census API key" link right under the key box that opens api.census.gov/data/key_signup.html in a new tab, with a hover explanation; the tax-rate hint in the report names Settings > Costs and loans | `feature/census-link-and-version-footer` |
| R52 | Version in the footer | The page footer shows "Version X.Y.Z, last updated Month D, YYYY" from `APP_VERSION` and `APP_UPDATED` in config.js, with a hover explanation; the date never shifts a day by time zone; a test fails if the version differs from package.json or is missing from the README version history or this SPEC | `feature/census-link-and-version-footer` |
| R53 | Browser test suite | `test_site.py` opens the site in Chromium with every outside service faked (core lookups and Texas answer, the rest fail on purpose) and checks page load, footer, hover help, Settings and reload, add-window errors, address suggestions, the full report, owner details never on the page, in storage or in an export, the Census key sent only to the Census, no request to an unknown host, categories and printing, demo, sort, filter, compare, delete, clear data, an all-services-down run and phone width; it exits with an error if any check fails | `feature/browser-test-suite` |
| R54 | Cost labels explained | Every label in the rough cost table has a hover explanation; the Reset to defaults tip matches what it does (saves at once, closes Settings, keeps the Census key) | `feature/browser-test-suite` |
| R55 | Criteria you tick | Settings > Scoring lists eleven criteria (septic, airport, price, internet, slope, rain, flood risk, groundwater depth, natural hazard rating, hospital drive, grocery drive), each with a tick box, a Dealbreaker switch and Up and Down buttons, and rows can be dragged by their handle; a counter says how many are ticked and what share each has; saving needs at least one tick; the total is the plain average of the ticked criteria that have data; skill-tree points (or older weights) saved by earlier versions are converted once: a factor with points is ticked and more points come first; the five new criteria start unticked | `feature/criteria-scoring-and-new-data` |
| R56 | Your criteria order everywhere | Each report opens with a table of the ticked criteria in your order (criterion, what was found, score and a bar); the parcel list shows the first three ticked criteria other than price and flood as columns after price, USDA and flood; the compare table lists the ticked criteria right after the score and dealbreakers, marks the best score, and leaves out the usual row that says the same thing | `feature/criteria-scoring-and-new-data` |
| R57 | More from services already used | The flood request also reads FEMA's special flood hazard flag (it settles unusual zone labels) and base flood elevation, with how far the spot sits above or below it; the four elevation points give the direction the ground faces (or about flat under 1%); the soil layer request adds Ksat, shown as the slowest layer's permeability class in the top 5 feet; the risk index reply adds social vulnerability and community resilience ratings; the Texas parcel request returns the parcel outline (outer ring, at most 400 points), drawn on the map, while owner fields are still dropped | `feature/criteria-scoring-and-new-data` |
| R58 | County disaster declarations | OpenFEMA declarations naming the county in the last 10 years: the count with each disaster counted once, the main kinds and the latest one, in More local conditions; fails on its own like the other pieces there | `feature/criteria-scoring-and-new-data` |
| R59 | Roads survive trimmed geometry | Overpass marks road points cut off at the edge of the search box with null; the distance is measured only between real neighboring points, a road with none is skipped, and the lookup never fails on them | `feature/road-fallbacks-and-smart-refresh` |
| R60 | Map server failover and road backups | An Overpass server that answers 429, 502, 503 or 504 rests for 5 minutes and one that fails another way for 2; resting servers are skipped, the server that worked last is tried first, and both are remembered in the browser across reloads (Clear data erases it); road access tries OpenStreetMap (20 seconds a server), then the Census TIGER roads (local roads to 3 km, highways to 10 km; only highways count as paved), then the OSRM nearest road (name and distance only); the report says which one answered and why; it fails only if all three do | `feature/road-fallbacks-and-smart-refresh` |
| R61 | Refresh only what is missing | Refresh data keeps what is there and asks again only for lookups that failed last time, values never looked up (newer features), failed pieces of More local conditions and Texas details, drive times without a route, and a tax rate or county profile that waited for a Census key that is now set; a service that answered "nothing here" is not asked again; if nothing is missing no service is asked and the page says so; Refresh all looks everything up again; the report shows when missing data was filled in | `feature/road-fallbacks-and-smart-refresh` |
| R62 | Two-ended sliders | Each of the eight scoring ranges (price, slope, rain, airport drive, internet, groundwater depth, hospital drive, grocery drive) is one slider with two thumbs above its two number boxes; moving a thumb changes its box and typing in a box moves its thumb; the thumbs cannot cross (the one being moved pushes the other one step along); a typed number past the slider's end stretches the slider; the track is green where a value scores 100 and red where it scores 0; each thumb has a screen-reader label and works with the arrow keys; Settings has no sideways scrolling, also at phone width | `feature/range-sliders-and-land-uses` |
| R63 | Recommended values by land use | Settings > Scoring asks what the land is for (homestead, farm, small vegetable garden, backyard livestock, residential home) with tick boxes saved in the browser; ticked uses show a recommended range with its unit under each slider they have a view on ("No recommendation" for the rest, including price and airport drive), and the criteria worth ticking; Use recommended values moves the sliders and Tick suggested criteria ticks those criteria, and nothing is saved until Save settings; with several uses the stricter value of each range wins | `feature/range-sliders-and-land-uses` |
| R64 | Texas acres and tax values | When a Texas parcel's acres are blank, the appraisal record's acres fill them, marked "(appraisal)" in the list and "used as the parcel's acres" in the report; typing your own acres replaces them; the report adds the appraised improvement value (when above zero), the year built, and an estimated yearly tax before exemptions (total value times the county's typical rate, or your own rate); the owner fields are still never kept | `feature/texas-tax-and-exemptions` |
| R65 | Tax exemptions | The Add and Edit window has tick boxes for ag (open-space) valuation, wildlife management valuation, homestead exemption, and "None of these (I checked)"; none ticked means unknown; None and the others clear each other; the report lists them with "(you entered)", or "Ag or wildlife valuation likely" when a Texas record's state land category is D1; Texas parcels link to the county's page in the Comptroller's appraisal district directory with the property ID; the compare table shows them | `feature/texas-tax-and-exemptions` |
| R66 | Ag or wildlife valuation criterion | A twelfth criterion, unticked by default: 100 for a ticked ag or wildlife valuation (or a D1 record), 0 for "None of these", no data otherwise; its dealbreaker fires only on a confirmed no; suggested for homestead, farm and backyard livestock | `feature/texas-tax-and-exemptions` |

## 5. Scoring rules

You tick the criteria that matter to you in Settings, and every ticked criterion counts the same. Schools, hardiness zone, wetlands and the rest of the report are shown but not scored, because whether they are good depends on the buyer.

Default: septic, airport, price, internet, slope and rain are ticked (the six factors the old skill tree scored); flood risk, groundwater depth, natural hazard rating, hospital drive and grocery drive are available but unticked. The flood dealbreaker stays on by default.

- Each criterion maps to 0 to 100 between a "full marks" value and a "zero" value (for example price: full marks at or below $100,000, zero at or above $150,000). Fixed scales: septic Not limited 100, Somewhat limited 60, Very limited 15; flood zone X 100, shaded X 50, high risk 0; FEMA overall rating Very Low 100 down to Very High 0 in steps of 25.
- The total is the plain average of the ticked criteria that have data.
- Missing data removes the criterion from the average; it never counts as zero.
- Recommended ranges per land use (in `LAND_USES`, config.js) are screening rules of thumb, not standards: for example cropland is best under about 3% slope and poor above 12%, a home site is fine to about 8% and hard above 25%, and a residential home with remote work wants the FCC's 100 Mbps broadband benchmark. They change nothing until applied.
- **[YOUR CALL: why skip instead of scoring zero?]** Suggested reasoning: a failed lookup says nothing about the land, so penalising it would rank parcels by server luck.
- The defaults reflect a Texas search. Rain, price and slope thresholds vary by region and the app tells the user to reset them.

## 6. Data sources and known limits

| Data | Source | Known limit |
| --- | --- | --- |
| Address, county, state | Census Geocoder | State comes from the States layer, not yet confirmed live |
| Flood zone | FEMA NFHL | Unmapped areas return nothing, which is not the same as "safe" |
| Elevation, slope | USGS EPQS | Slope is the steepest of four spot checks 60 m away, so small features are missed |
| Soil, septic | USDA Soil Data Access | Ratings are survey-scale, not a percolation test |
| Rainfall | Open-Meteo archive | Averaged history, not a forecast |
| Internet | FCC Area API and open data | June 2021 data; overstates rural coverage; no Starlink |
| Nearby places | OpenStreetMap via Overpass | Volunteer data; rural shops often missing |
| Drive times | OSRM public demo | Light-use server; may refuse or rate-limit |
| Schools, fire, police, hospitals | OpenStreetMap via Overpass | Volunteer data; school levels are inferred from grades, level tags or the name; hospital emergency departments are often untagged |
| Natural hazards | FEMA National Risk Index (census tract layer) | Tract-level, modelled risk, not a forecast; ratings are relative to the rest of the US |
| Hardiness zone | USDA 2023 map data via phzmapi.org | Looked up by ZIP code, so it can differ from the exact parcel; run by a volunteer, not an official USDA site |
| Soil details | USDA Soil Data Access (four queries) | Main soil only; survey scale; ratings say how limited, not whether it can be done |
| Climate, frost, solar | Open-Meteo archive (ERA5 model, 10 years) | Grid about 10 km wide, so low ground and hilltops can differ by weeks; solar output is a flat-panel rule of thumb |
| Road access | OpenStreetMap via Overpass; backups: Census TIGERweb roads, then OSRM nearest (both checked from the live site and a local copy on 2026-10-31) | Shows a road nearby, not legal access; private roads are often unmarked; TIGER has no surfaces and OSRM only the nearest road |
| Wetlands | US Fish and Wildlife Service National Wetlands Inventory | Screening map, not a delineation; small or seasonal wetlands missed |
| Public and protected land | USGS PAD-US (Public_Access layer) | Unknown-access areas left out; "open" does not mean any particular use is allowed |
| County property tax rate | Census American Community Survey 5-year, tables B25103 and B25077 | Median for homes, so vacant land and farm exemptions can differ; needs a free key |
| Groundwater | USGS Water Data API (field measurements) | A monitoring well is not your lot; may tap a different aquifer than a household well |
| Texas parcel record | Texas Geographic Information Office land parcels (identify request) | Appraisal-district data, not a survey; owner fields are discarded; no exemption or taxable-value fields, and the state land category was empty in every county checked on 2026-10-31 (Blanco, Kendall, Bell, Milam) |
| Texas wells and districts | TWDB groundwater database, groundwater conservation districts, TEA school districts | Reported wells near the point, not your lot |
| Texas oil, gas and pipelines | Railroad Commission of Texas GIS | Pipelines within half a mile, wells within a mile; mineral rights are not shown |
| Edwards Aquifer | Texas Commission on Environmental Quality recharge zone layer | Screening only |
| Drought | US Drought Monitor current weekly map (ArcGIS service) | Weekly snapshot; no shape at the spot means no drought |
| Weather office, alerts | National Weather Service api.weather.gov | Snapshot of when fetched |
| Wind and humidity | NASA POWER annual climatology | Grid cells about 50 km wide |
| Regulated facilities | EPA ECHO | Counts facilities within 2 miles; not a pollution reading |
| Disaster declarations | OpenFEMA Disaster Declarations Summaries (checked from the live site: answers browser requests) | County level; a declaration depends on damage, not just weather |
| County profile | Census ACS 5-year, county | The Census blocks browser requests without a free key, so this and the tax rate may ask for one |

## 7. Architecture

Static site: HTML, CSS and vanilla JavaScript, Leaflet for the map, localStorage for data. Scripts load in order: `config.js`, `scoring.js`, `sources.js`, `storage.js`, `ui.js`. Scoring and comparison are pure functions with no browser access, so they are unit tested in Node. Lookups run independently so one slow source never blocks the rest.

## 8. Decisions and tradeoffs

[YOUR CALL: each needs your reasoning in your words. Starting points:]
- **No backend.** Free hosting, no keys to protect, no data held. Cost: no shared rate-limit handling and no server-side caching.
- **Vanilla JS, no framework.** Chosen to learn the fundamentals and avoid a build step. Cost: more manual DOM code.
- **Placeholders over false precision.** Cost estimates are editable guesses and labelled so, because a made-up number looks authoritative.
- **Browser-only storage.** Private by default. Cost: clearing site data erases parcels, so export exists.
- **Features as branches.** Each feature shipped as a branch, tests and pull request so history reads as a changelog.

## 9. Risks and open items

- Overpass, OSRM, the Census States and ZIP layers, the USDA soil detail queries, the wetlands, protected-land and groundwater services, and the Census tax request have not been checked against the live servers. Run the console checks in the tutorial.
- Some FEMA hazard field names (winter weather, volcano, strong wind, tsunami) were assumed from the naming pattern.
- The OSRM demo server is not meant for heavy use. A self-hosted router would be the fix.
- FCC data will drift further from reality. The newer broadband map is the likely replacement.
- No parcel boundaries, so acreage and location are user-entered.

## 10. Testing

- 177 unit tests under Node (`npm test`) cover scoring, parsing, routing fallbacks, comparison, cost, summary and the source table.
- 189 browser checks (`python test_site.py`, needs Playwright and Chromium) run the real page with every outside service faked; see R53. They are not run in GitHub Actions.
- Live checks against real services are manual (see the tutorial).

## 11. What I would do next

[YOUR CALL: pick two or three.]
- Small proxy for caching and rate limits.
- County parcel boundary layers where available.
- Replace FCC 2021 data with the current broadband map.
- Import listings from a saved search.
