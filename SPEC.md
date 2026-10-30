# Homestead Land Screener: Specification

> DRAFT SKELETON. Rewrite every section in your own words before publishing.
> Items marked **[YOUR CALL]** are decisions only you can state.
> Last updated for v1.8.0.

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
| R3 | Score 0 to 100 from eight weighted factors | Weights are editable; missing factors are skipped, not scored as zero; the score says how many factors had data | v1.0.0 |
| R4 | Dealbreakers | A high-risk flood zone, or airport drive time above the limit, is flagged and can be hidden from the list | v1.0.0 |
| R5 | Choose airports | Default is the nearest major US airport from a built-in list of about 100; the user can instead supply their own list | `feature/airport-picker` (0cb02b4), then `feature/nationwide` (a4b677a) |
| R6 | Nearest grocery, hardware, Costco, feed store, vet | Five results per parcel or "none found"; search radius widens in steps; busy server is retried on a mirror | `feature/nearby-places` (e2975a5) |
| R7 | Road drive times | Routed minutes when OSRM answers; clearly marked estimates when it does not | `feature/road-drive-times` (9327fb8) |
| R8 | Sort and filter | Sort by score, price, internet speed or airport time; filter by status; hide dealbreakers; choice survives reload | `feature/sort-and-filter` (22efcf8) |
| R9 | Work anywhere in the US | County plus state shown; hunting list accepts state; non-US coordinates rejected with a hint; map opens on the whole country | `feature/nationwide` (a4b677a) |
| R10 | Compare up to three parcels | Best value per row starred only when values differ; fourth pick refused with a message | `feature/compare` (c7da63e) |
| R11 | Rough cost estimate | All rates editable; every screen says they are placeholders; very limited soil uses the engineered septic price | `feature/monthly-cost` (5e01219) |
| R12 | Print and copy a summary | Print shows only the open parcel; copy falls back to a text box if the clipboard is refused | `feature/print-summary` (e17d465) |
| R13 | Nearest elementary, middle and high school | Each level shows the nearest school, its straight-line miles and drive time, or "none found"; a school serving several levels (K-8) counts for each; schools with no level information are not guessed | `feature/schools` |
| R14 | Nearest fire station, police station and emergency hospital | Same display as R13; hospitals marked as having no emergency department are skipped; the page says to call before relying on a listing | `feature/emergency-services` |
| R15 | Natural hazard risk from the FEMA National Risk Index | All 18 hazards FEMA rates are listed with their ratings for the parcel's census tract; hazards marked not applicable are hidden; overall rating shown; display only, not scored | `feature/hazards` |
| R16 | USDA plant hardiness zone | Zone and minimum-temperature range from the 2023 USDA map data, looked up by ZIP code; labelled as ZIP-level; display only, not scored | `feature/hardiness-zone` |
| R17 | Soil details | Texture, depth to bedrock and water table, flooding and ponding, shrink-swell, and building and road ratings for the main soil at the point; "not looked up" for parcels saved before the feature; display only | `feature/soil-details` |
| R18 | Frost, climate and solar | Average last spring and first fall freeze, frost-free days, days over 100 F, snow, and full-sun hours with a rough solar output, from ten years of daily weather; labelled as a model, not a station; display only | `feature/climate-solar` |
| R19 | Road access | Nearest road and nearest paved public road, with distance and surface; says it is not proof of legal access | `feature/road-access` |
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

## 5. Scoring rules

Schools, emergency services, hazards and hardiness zones are shown but not scored. Whether a parcel is "good" on these depends on the buyer (children, gardening plans, risk tolerance), so the app presents them and leaves the weighing to you.

Default weights (editable): flood 25, price 20, septic 15, airport 15, slope 10, rain 10, internet 10, hunting 5.

- Each factor maps to 0 to 100 between a "full marks" value and a "zero" value (for example price: full marks at or below $100,000, zero at or above $150,000).
- Missing data removes the factor from both numerator and denominator.
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
| Road access | OpenStreetMap via Overpass | Shows a road nearby, not legal access; private roads are often unmarked |
| Wetlands | US Fish and Wildlife Service National Wetlands Inventory | Screening map, not a delineation; small or seasonal wetlands missed |
| Public and protected land | USGS PAD-US (Public_Access layer) | Unknown-access areas left out; "open" does not mean hunting is allowed |
| County property tax rate | Census American Community Survey 5-year, tables B25103 and B25077 | Median for homes, so vacant land and farm exemptions can differ; needs a free key |
| Groundwater | USGS National Water Information System (gwlevels) | A monitoring well is not your lot; may tap a different aquifer than a household well |

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

- 102 unit tests under Node (`npm test`) cover scoring, parsing, routing fallbacks, comparison, cost, summary and the source table.
- A browser test script with mocked services was used during development and is not part of the repository.
- Live checks against real services are manual (see the tutorial).

## 11. What I would do next

[YOUR CALL: pick two or three.]
- Small proxy for caching and rate limits.
- County parcel boundary layers where available.
- Replace FCC 2021 data with the current broadband map.
- Import listings from a saved search.
