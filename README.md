# Homestead Land Screener

Screen land parcels anywhere in the United States using free public data. Enter a street address or pick a spot on the map, and the app looks up flood risk, soil and septic suitability, slope, rainfall, internet service, natural hazard ratings, soil details, frost dates and solar hours, road access, wetlands, public land, groundwater, county tax rate, plant hardiness zone, the nearest airport, shops, schools and emergency services, then scores each parcel against criteria you set.

It is a plain website: HTML, CSS and JavaScript with no build step and no server. Your parcels and criteria are saved in your own browser (localStorage). Nothing is uploaded to an account.

**Live demo:** https://YOUR-USERNAME.github.io/homestead-screener/

## Features

- Add a parcel by address or by clicking the map; data is looked up automatically
- Score from 0 to 100 from eight factors you can weight, with dealbreakers (high-risk flood zone, too far from an airport)
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
- County property tax rate (needs a free Census key) used in the cost estimate
- Every section of the report names its data source, link and date
- Hover over (or tap, or tab to) a dotted label to see in plain words what the data means and who supplies it
- Sort, filter by status, and hide dealbreakers
- Compare up to three parcels side by side
- Rough monthly and start-up cost estimate from rates you set
- Print a parcel summary, or copy it as text to send to someone

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

There is no account and no backend. To look up a parcel, the app sends that parcel's address or coordinates directly from your browser to the services above (Census, FEMA, USGS, USDA, US Fish and Wildlife Service, Open-Meteo, FCC, Overpass, OSRM and phzmapi.org). If you add a free Census API key in Criteria, it is stored in your browser and sent only to the Census. Nothing is sent anywhere else, and your notes and criteria never leave your browser. Use Export in the app to back up your parcels, because clearing your browser data erases them.

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

Requires Node 20 or newer.

```
npm test
```

## Version history

- **v1.4.0** Hover help: plain-language explanations for the labels in the report, the compare table and the score table
- **v1.3.0** Soil details, frost and climate, solar, road access, wetlands, public land, groundwater, county tax rate; the source of every piece of data shown on the report
- **v1.2.0** Schools, fire, police and hospitals, FEMA hazard ratings, USDA hardiness zone
- **v1.1.0** Works anywhere in the US; airport picker; nearby places; road drive times; sort and filter; compare; cost estimate; print and copy summary
- **v1.0.0** First release: address and map input, flood, soil, slope, rain, airport, internet, scoring
