# Homestead Land Screener

Screen land parcels anywhere in the United States using free public data. Enter a street address or pick a spot on the map, and the app looks up flood risk, soil and septic suitability, slope, rainfall, internet service, natural hazard ratings, soil details, frost dates and solar hours, road access, wetlands, public land, groundwater, county tax rate, plant hardiness zone, the nearest airport, shops, schools and emergency services, then scores each parcel against criteria you set.

It is a plain website: HTML, CSS and JavaScript with no build step and no server. Your parcels and criteria are saved in your own browser (localStorage). Nothing is uploaded to an account.

**Live site:** https://jnicholas1692.github.io/Vibed_HomeStead_Screener/

## About this project

This is a personal test of AI-assisted development. I am using it to see how far a working tool can get when an AI assistant (Claude) writes the code and I direct it, review it and test it. It is a learning project, not a finished product or professional advice.

- The data comes from free public sources and can be wrong, out of date or missing. Treat every result as a starting point and check it with the county, the surveyor, the lender and the agencies named in each report section before you rely on it.
- Some of those free services are slow, busy or change without notice, so a lookup that fails today may work tomorrow.
- Everything stays in your own browser. There is no account and no server of mine. The address box sends what you type to photon.komoot.io for suggestions, and each lookup talks to the public service named in its report section.

## Features

- Add a parcel by address or by clicking the map; data is looked up automatically
- Edit a parcel's name, address, location, acres or price later; the score and cost update, and moving the pin looks the data up again
- Choose the order of the report sections in Settings
- Monthly cost with a dollar down payment, compared across your land loan and 30-year conventional and FHA home loans
- USDA loan area (Yes or No) from USDA Rural Development's eligibility map
- Score from 0 to 100 using a 10-point skill tree: spend your points on the factors that matter most, and switch on a dealbreaker for any of them
- Flood zone shown as a plain Yes or No with the zone, not as a score
- Nearest airport from about 100 major US airports, or your own list
- Nearest grocery store, hardware store, Costco, feed store and vet, with real road drive times
- Nearest elementary, middle and high school
- Nearest fire station, police or sheriff, and emergency hospital
- FEMA natural hazard ratings for all 18 hazards FEMA rates (tornado, wildfire, hail, flooding, earthquake and more)
- USDA plant hardiness zone
- Soil details (texture, depth to bedrock and water, shrink-swell, building ratings)
- Frost dates, frost-free days, days over 100 F, snow, and solar hours
- Nearest road and nearest paved public road
- Mapped wetlands, and nearby public and protected land
- Groundwater depth at the nearest USGS monitoring wells
- County property tax rate (needs a free Census key; Settings links straight to the Census sign-up page) used in the cost estimate
- Every section of the report names its data source, link and date
- Hover over (or tap, or tab to) a dotted label to see in plain words what the data means and who supplies it
- Sort, filter by status, and hide dealbreakers
- Compare up to three parcels side by side
- Rough monthly and start-up cost estimate from rates you set
- Print a parcel summary, or copy it as text to send to someone
- The page footer shows the app's version and the date it was last updated

## Data sources (all free, no API keys)

| What | Source |
| --- | --- |
| Address to coordinates, county and state | US Census Geocoder |
| Flood zone | FEMA National Flood Hazard Layer |
| Elevation and slope | USGS Elevation Point Query Service |
| Soil and septic rating | USDA Soil Data Access |
| Rainfall | Open-Meteo historical archive |
| Internet providers and speeds | FCC Area API and FCC open data (June 2021) |
| Nearby places, schools, fire, police, hospitals | OpenStreetMap through the Overpass API |
| Natural hazard ratings | FEMA National Risk Index (census tract layer) |
| Plant hardiness zone | USDA 2023 map data through phzmapi.org (by ZIP code) |
| Drive times | OpenStreetMap through the OSRM public demo server |
| Soil details | USDA Soil Data Access |
| Frost, climate, solar | Open-Meteo historical archive (10 years) |
| Road access | OpenStreetMap through the Overpass API |
| Wetlands | US Fish and Wildlife Service National Wetlands Inventory |
| Public and protected land | USGS Protected Areas Database (PAD-US) |
| Groundwater | USGS National Water Information System |
| County property tax rate | Census American Community Survey (free API key) |

## Privacy

There is no account and no backend. To look up a parcel, the app sends that parcel's address or coordinates directly from your browser to the services above (Census, FEMA, USGS, USDA, US Fish and Wildlife Service, Open-Meteo, FCC, Overpass, OSRM and phzmapi.org). If you add a free Census API key in Settings, it is stored in your browser and sent only to the Census. Nothing is sent anywhere else, and your notes and criteria never leave your browser. Use Export in the app to back up your parcels, because clearing your browser data erases them.

## Limits to know about

- This is a screening aid, not a survey. Confirm flood, soil, septic, water, access and internet with the county, the providers and licensed professionals before buying.
- FCC internet data is from June 2021, reported per census block. It likely overstates rural coverage and has no Starlink.
- OpenStreetMap is edited by volunteers. Rural shops are often missing, so "none found" does not prove there is none.
- The OSRM demo server is for light use. If it does not answer, drive times fall back to estimates and the app says so.
- Rainfall, price and slope settings that count as good depend on the region. Set the criteria for where you are searching.
- Cost estimates use placeholder rates you can edit. They are not quotes.
- School levels are worked out from OpenStreetMap grades, level tags or names, and the app cannot tell which school serves your address. Ask the district.
- Volunteer fire departments are often missing from OpenStreetMap, and a listed hospital may not have a full emergency room. Call to confirm.
- FEMA hazard ratings describe a census tract compared with the rest of the US. They are not forecasts and do not replace the parcel's flood zone.
- The hardiness zone is looked up by ZIP code, from a volunteer-run copy of the 2023 USDA data, so it can differ a little from your exact lot.
- Schools, hazards, hardiness zone and everything added in v1.3 are shown but not scored.
- Soil, climate, wetlands, protected land and groundwater describe a point, a model grid or a nearby well, not your whole lot. Road data shows a road nearby, not legal access.
- The county tax rate is a median for homes. Vacant land, farm exemptions and special districts can make a real bill very different.

## Run it

Open `index.html` in a browser, or serve the folder:

```
python3 -m http.server 8000
```

then visit http://localhost:8000.

## Test it

Unit tests need Node 20 or newer:

```
npm test
```

Browser tests need Python 3.9 or newer and Playwright. They open the site in Chromium with every outside data service replaced by a fake answer, so they never touch the real services (the map library still loads from unpkg). They serve the site on port 8765, so that port must be free.

```
python -m pip install playwright
python -m playwright install chromium
python test_site.py
```

Add `--headed` to watch the browser. Passing tests cannot prove a real service still answers, so spot-check the live site after a release.

## Version history

- **v2.0.0** Scoring is a 10-point skill tree with a dealbreaker switch on every criterion; flood zone is a Yes or No instead of a score; Settings has Scoring, Costs and loans, and Report layout tabs; the Save, Reset and Close buttons (and the Add and Compare buttons) stay pinned at the top
- **v2.0.1** Groundwater now uses the new USGS Water Data API (the old service was retired); it shows the nearest wells with their last measurement date and age, and warns when all readings are over 10 years old
- **v2.0.2** The main page links to the GitHub repository
- **v2.1.0** Hover explanations on every data point and Settings option; hunting removed; a Texas details section (parcel record, groundwater district, school district, wells, pipelines, oil and gas, Edwards zone) shown only for Texas parcels; a More local conditions section (county profile, drought, weather alerts, wind, facilities); report grouped into collapsible categories. 133 unit tests.
- **v2.2.0** A Get a free Census API key link right under the key box in Settings; the page footer shows the version and the date of the last update. 136 unit tests.
- **v2.2.1** A browser test suite (`test_site.py`, 105 checks with every data service faked) is now part of the repository; the rough cost labels have hover explanations; the Reset to defaults tip now says it saves at once and keeps your Census key. 136 unit tests.
- **v1.9.1** Drag the report sections into order in Settings (Up and Down still work)
- **v1.9.0** Down payment in dollars; asking price next to the name in the list; 30-year conventional and FHA payments beside your land loan; a USDA loan area Yes or No from USDA's eligibility map
- **v1.8.0** Edit a parcel's name, address, location, acres and price after adding it; choose the order of the report sections in Settings (the Criteria button is now Settings)
- **v1.7.0** Address suggestions as you type (US, from OpenStreetMap via photon.komoot.io); the parcel name defaults to the address
- **v1.6.0** A Delete button on every row of the parcel list; a lighter nearby-places query that the free map servers answer; a Clear data button that erases what the app saved in the browser
- **v1.5.0** The report opens at once and fills in as each lookup finishes; the Refresh, Print, Copy, Save, Delete and Close buttons stay pinned at the top; the free map servers are asked one request at a time
- **v1.4.0** Hover help: plain-language explanations for the labels in the report, the compare table and the score table
- **v1.3.0** Soil details, frost and climate, solar, road access, wetlands, public land, groundwater, county tax rate; the source of every piece of data shown on the report
- **v1.2.0** Schools, fire, police and hospitals, FEMA hazard ratings, USDA hardiness zone
- **v1.1.0** Works anywhere in the US; airport picker; nearby places; road drive times; sort and filter; compare; cost estimate; print and copy summary
- **v1.0.0** First release: address and map input, flood, soil, slope, rain, airport, internet, scoring
