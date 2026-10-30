"use strict";

/* =====================================================================
   1. Criteria (what "good land" means to you). Saved in this browser.
   ===================================================================== */
const DEFAULT_SETTINGS = {
  // The skill tree: POINT_BUDGET points to spend across the factors that matter most. A factor with 0 points is not scored.
  points: { septic: 2, slope: 1, rain: 1, airport: 2, price: 2, hunting: 1, internet: 1 },
  // Which factors rule a parcel out completely when they hit their worst end. Flood is not scored; it is a yes or no.
  dealbreakers: { flood: true, septic: false, slope: false, rain: false, airport: true, price: false, hunting: false, internet: false },
  priceTarget: 100000, priceMax: 150000,        // full marks at or below target, zero at or above max
  slopeIdeal: 5, slopeMax: 20,                   // slope in percent
  rainFull: 35, rainZero: 15,                    // average inches of rain per year
  detourFactor: 1.3, avgMph: 55,                 // turns straight-line miles into drive minutes
  airportFullMin: 75, airportMaxMin: 120,        // drive minutes; beyond the max is a dealbreaker
  internetFullMbps: 100, internetZeroMbps: 5,    // best non-satellite download speed
  censusKey: "",                                 // optional free Census API key, needed for the county tax rate
  huntingCounties: [],                           // counties where you confirmed you can hunt
  // Placeholders for the rough cost estimate. Replace them with real quotes for the area you are searching.
  costs: {
    downPayment: 20000,                            // cash down payment in dollars (used for every loan below, never more than the price)
    ratePct: 7.5, years: 20,                       // land loan terms; 0 years means you pay cash
    // 30-year home loan placeholders. Rates change daily; Freddie Mac's weekly average for a conventional 30-year loan
    // was 7.32% on October 22, 2026. The FHA rate is a guess (often a little lower), so replace both with a lender's quote.
    conventionalRatePct: 7.3, fhaRatePct: 7.0,
    pmiPct: 0.6,                                   // conventional private mortgage insurance, % of the loan per year, when under 20% down
    fhaUpfrontPct: 1.75, fhaAnnualPct: 0.55,       // FHA mortgage insurance: paid at closing (added to the loan) and per year
    taxPct: 1.0,                                   // yearly property tax as a percent of price (varies a lot by state)
    useCountyTax: true,                            // use the county's typical rate from the Census when it is known
    insuranceMonthly: 40,
    septicStandard: 8000, septicEngineered: 25000, well: 12000,   // one-time costs
  },
  // "auto" uses the nearest airport in AIRPORT_PRESETS (all of the US). "custom" uses only your own list below.
  airportMode: "auto",
  airports: [],
  // The order of the sections in a parcel's report (keys from REPORT_SECTIONS).
  reportOrder: ["data", "internet", "places", "publicLand", "groundwater", "wetlands", "roads", "climate", "soilDetails", "hazards", "cost"],
};

// The report sections you can reorder. The score and factor table always come first,
// and the data sources and your notes always come last.
const REPORT_SECTIONS = [
  ["data", "What the data says"], ["internet", "Internet"], ["places", "Nearby"],
  ["publicLand", "Public and protected land"], ["groundwater", "Groundwater"], ["wetlands", "Wetlands"],
  ["roads", "Road access"], ["climate", "Climate and solar"], ["soilDetails", "Soil details"],
  ["hazards", "Natural hazards"], ["cost", "Rough cost"],
];

// Cleans up a saved section order: unknown or repeated names are dropped, and any section
// the saved list is missing (for example one added in a newer version) goes at the end.
function normalizeReportOrder(saved) {
  const known = REPORT_SECTIONS.map(([key]) => key);
  const order = [];
  for (const key of Array.isArray(saved) ? saved : []) {
    if (known.includes(key) && !order.includes(key)) order.push(key);
  }
  for (const key of known) if (!order.includes(key)) order.push(key);
  return order;
}

// How the list is sorted and filtered when you first open the page.
const DEFAULT_VIEW = { sort: "score", status: "all", hideDealbreakers: false };

// Fixed rules for the 30-year home loan comparison (FHA minimums as of 2026).
const LOAN_RULES = {
  years: 30,
  conventionalMinDownPct: 3, conventionalNoPmiDownPct: 20,
  fhaMinDownPct: 3.5, fhaLongMipDownPct: 10,       // under 10% down, FHA insurance lasts the whole loan; 10% or more, 11 years
  fhaLoanLimitFloor: 541287,                        // the national floor for a one-unit home in 2026; higher in costly counties
};

const POINT_BUDGET = 10;

// Splits `budget` points across factors in proportion to old-style weights, using whole points
// (the largest leftover fractions get the extra ones). Used once to convert settings saved by older versions.
function pointsFromWeights(weights, budget) {
  const keys = Object.keys(weights).filter((k) => Number(weights[k]) > 0);
  const total = keys.reduce((sum, k) => sum + Number(weights[k]), 0);
  const result = Object.fromEntries(Object.keys(weights).map((k) => [k, 0]));
  if (total <= 0) return result;
  const shares = keys.map((k) => ({ k, exact: Number(weights[k]) / total * budget }));
  for (const s of shares) result[s.k] = Math.floor(s.exact);
  let left = budget - shares.reduce((sum, s) => sum + Math.floor(s.exact), 0);
  for (const s of [...shares].sort((a, b) => (b.exact % 1) - (a.exact % 1))) {
    if (left <= 0) break;
    result[s.k] += 1; left -= 1;
  }
  return result;
}

// Cleans up saved points: only known factors, whole numbers, never more than the budget in total.
function normalizePoints(saved) {
  const known = Object.keys(DEFAULT_SETTINGS.points);
  const out = Object.fromEntries(known.map((k) => [k, 0]));
  let spent = 0;
  for (const k of known) {
    const v = Math.max(0, Math.floor(Number(saved && saved[k]) || 0));
    const take = Math.min(v, POINT_BUDGET - spent);
    out[k] = take; spent += take;
  }
  return out;
}

const FACTOR_LABELS = {
  septic: "Septic suitability", slope: "Slope", rain: "Rainfall",
  airport: "Airport distance", price: "Price", hunting: "Hunting county", internet: "Internet",
};

const HIGH_RISK_FLOOD_ZONES = new Set(["A", "AE", "AH", "AO", "AR", "A99", "V", "VE"]);
const SEPTIC_SCORES = { "Not limited": 100, "Somewhat limited": 60, "Very limited": 15 };

// Major US airports with scheduled passenger flights (coordinates are approximate).
// Unless you pick your own list in Criteria, the nearest one to each parcel is used.
const AIRPORT_PRESETS = [
  { name: "Albany (ALB)", lat: 42.7483, lon: -73.8017 },
  { name: "Albuquerque (ABQ)", lat: 35.0402, lon: -106.609 },
  { name: "Amarillo (AMA)", lat: 35.2194, lon: -101.7059 },
  { name: "Anchorage (ANC)", lat: 61.1744, lon: -149.9964 },
  { name: "Asheville (AVL)", lat: 35.4362, lon: -82.5418 },
  { name: "Atlanta (ATL)", lat: 33.6407, lon: -84.4277 },
  { name: "Austin (AUS)", lat: 30.1945, lon: -97.6699 },
  { name: "Baltimore/Washington (BWI)", lat: 39.1754, lon: -76.6683 },
  { name: "Baton Rouge (BTR)", lat: 30.5332, lon: -91.1496 },
  { name: "Billings (BIL)", lat: 45.8077, lon: -108.543 },
  { name: "Birmingham (BHM)", lat: 33.5629, lon: -86.7535 },
  { name: "Boise (BOI)", lat: 43.5644, lon: -116.2228 },
  { name: "Boston (BOS)", lat: 42.3656, lon: -71.0096 },
  { name: "Bozeman (BZN)", lat: 45.7775, lon: -111.1531 },
  { name: "Buffalo (BUF)", lat: 42.9405, lon: -78.7322 },
  { name: "Burlington VT (BTV)", lat: 44.472, lon: -73.1533 },
  { name: "Charleston SC (CHS)", lat: 32.8986, lon: -80.0405 },
  { name: "Charlotte (CLT)", lat: 35.214, lon: -80.9431 },
  { name: "Chicago Midway (MDW)", lat: 41.7868, lon: -87.7522 },
  { name: "Chicago O'Hare (ORD)", lat: 41.9742, lon: -87.9073 },
  { name: "Cincinnati (CVG)", lat: 39.0488, lon: -84.6678 },
  { name: "Cleveland (CLE)", lat: 41.4117, lon: -81.8498 },
  { name: "Colorado Springs (COS)", lat: 38.8058, lon: -104.7007 },
  { name: "Columbus OH (CMH)", lat: 39.998, lon: -82.8919 },
  { name: "Corpus Christi (CRP)", lat: 27.7704, lon: -97.5012 },
  { name: "Dallas Love Field (DAL)", lat: 32.8471, lon: -96.8518 },
  { name: "Dallas/Fort Worth (DFW)", lat: 32.8998, lon: -97.0403 },
  { name: "Denver (DEN)", lat: 39.8561, lon: -104.6737 },
  { name: "Des Moines (DSM)", lat: 41.534, lon: -93.6631 },
  { name: "Detroit (DTW)", lat: 42.2162, lon: -83.3554 },
  { name: "El Paso (ELP)", lat: 31.8072, lon: -106.3778 },
  { name: "Fairbanks (FAI)", lat: 64.8151, lon: -147.8561 },
  { name: "Fargo (FAR)", lat: 46.9207, lon: -96.8158 },
  { name: "Fort Lauderdale (FLL)", lat: 26.0726, lon: -80.1527 },
  { name: "Fort Myers (RSW)", lat: 26.5362, lon: -81.7552 },
  { name: "Fresno (FAT)", lat: 36.7762, lon: -119.7181 },
  { name: "Grand Rapids (GRR)", lat: 42.8808, lon: -85.5228 },
  { name: "Greenville SC (GSP)", lat: 34.8957, lon: -82.2189 },
  { name: "Harlingen (HRL)", lat: 26.2285, lon: -98.2386 },
  { name: "Hartford (BDL)", lat: 41.9389, lon: -72.6832 },
  { name: "Honolulu (HNL)", lat: 21.3187, lon: -157.9224 },
  { name: "Houston Bush (IAH)", lat: 29.9902, lon: -95.3368 },
  { name: "Houston Hobby (HOU)", lat: 29.6454, lon: -95.2789 },
  { name: "Indianapolis (IND)", lat: 39.7173, lon: -86.2944 },
  { name: "Jackson Hole (JAC)", lat: 43.6073, lon: -110.7377 },
  { name: "Jackson MS (JAN)", lat: 32.3112, lon: -90.0759 },
  { name: "Jacksonville (JAX)", lat: 30.4941, lon: -81.6879 },
  { name: "Juneau (JNU)", lat: 58.355, lon: -134.5763 },
  { name: "Kahului (Maui) (OGG)", lat: 20.8986, lon: -156.4305 },
  { name: "Kansas City (MCI)", lat: 39.2976, lon: -94.7139 },
  { name: "Knoxville (TYS)", lat: 35.811, lon: -83.994 },
  { name: "Las Vegas (LAS)", lat: 36.084, lon: -115.1537 },
  { name: "Lincoln (LNK)", lat: 40.851, lon: -96.7592 },
  { name: "Little Rock (LIT)", lat: 34.7294, lon: -92.2243 },
  { name: "Los Angeles (LAX)", lat: 33.9416, lon: -118.4085 },
  { name: "Louisville (SDF)", lat: 38.1744, lon: -85.736 },
  { name: "Lubbock (LBB)", lat: 33.6636, lon: -101.8228 },
  { name: "Madison (MSN)", lat: 43.1399, lon: -89.3375 },
  { name: "Memphis (MEM)", lat: 35.0424, lon: -89.9767 },
  { name: "Miami (MIA)", lat: 25.7959, lon: -80.287 },
  { name: "Midland/Odessa (MAF)", lat: 31.9425, lon: -102.2019 },
  { name: "Milwaukee (MKE)", lat: 42.9472, lon: -87.8966 },
  { name: "Minneapolis/St. Paul (MSP)", lat: 44.8848, lon: -93.2223 },
  { name: "Missoula (MSO)", lat: 46.9163, lon: -114.0906 },
  { name: "Mobile (MOB)", lat: 30.6914, lon: -88.2428 },
  { name: "Nashville (BNA)", lat: 36.1263, lon: -86.6774 },
  { name: "New Orleans (MSY)", lat: 29.9934, lon: -90.258 },
  { name: "New York JFK (JFK)", lat: 40.6413, lon: -73.7781 },
  { name: "New York LaGuardia (LGA)", lat: 40.7769, lon: -73.874 },
  { name: "Newark (EWR)", lat: 40.6895, lon: -74.1745 },
  { name: "Norfolk (ORF)", lat: 36.8976, lon: -76.0132 },
  { name: "Northwest Arkansas (XNA)", lat: 36.2819, lon: -94.3068 },
  { name: "Oklahoma City (OKC)", lat: 35.3931, lon: -97.6007 },
  { name: "Omaha (OMA)", lat: 41.3032, lon: -95.8941 },
  { name: "Orlando (MCO)", lat: 28.4312, lon: -81.3081 },
  { name: "Palm Beach (PBI)", lat: 26.6832, lon: -80.0956 },
  { name: "Pensacola (PNS)", lat: 30.4734, lon: -87.1866 },
  { name: "Philadelphia (PHL)", lat: 39.8744, lon: -75.2424 },
  { name: "Phoenix (PHX)", lat: 33.4342, lon: -112.0116 },
  { name: "Pittsburgh (PIT)", lat: 40.4915, lon: -80.2329 },
  { name: "Portland ME (PWM)", lat: 43.6462, lon: -70.3093 },
  { name: "Portland OR (PDX)", lat: 45.5887, lon: -122.5975 },
  { name: "Providence (PVD)", lat: 41.726, lon: -71.4282 },
  { name: "Puerto Rico (San Juan) (SJU)", lat: 18.4394, lon: -66.0018 },
  { name: "Raleigh/Durham (RDU)", lat: 35.8776, lon: -78.7875 },
  { name: "Rapid City (RAP)", lat: 44.0453, lon: -103.0574 },
  { name: "Reno (RNO)", lat: 39.4991, lon: -119.7681 },
  { name: "Richmond (RIC)", lat: 37.5052, lon: -77.3197 },
  { name: "Sacramento (SMF)", lat: 38.6954, lon: -121.5908 },
  { name: "Salt Lake City (SLC)", lat: 40.7899, lon: -111.9791 },
  { name: "San Antonio (SAT)", lat: 29.5337, lon: -98.4698 },
  { name: "San Diego (SAN)", lat: 32.7338, lon: -117.1933 },
  { name: "San Francisco (SFO)", lat: 37.6213, lon: -122.379 },
  { name: "San Jose (SJC)", lat: 37.3639, lon: -121.9289 },
  { name: "Savannah (SAV)", lat: 32.1276, lon: -81.2021 },
  { name: "Seattle (SEA)", lat: 47.4502, lon: -122.3088 },
  { name: "Sioux Falls (FSD)", lat: 43.582, lon: -96.7419 },
  { name: "Spokane (GEG)", lat: 47.6199, lon: -117.5339 },
  { name: "Springfield MO (SGF)", lat: 37.2457, lon: -93.3886 },
  { name: "St. Louis (STL)", lat: 38.7487, lon: -90.37 },
  { name: "Tampa (TPA)", lat: 27.9755, lon: -82.5332 },
  { name: "Tucson (TUS)", lat: 32.1161, lon: -110.941 },
  { name: "Tulsa (TUL)", lat: 36.1984, lon: -95.8881 },
  { name: "Washington Dulles (IAD)", lat: 38.9531, lon: -77.4565 },
  { name: "Washington National (DCA)", lat: 38.8512, lon: -77.0402 },
  { name: "Wichita (ICT)", lat: 37.6499, lon: -97.4331 },
];

// Two-letter codes, used to tell counties with the same name apart (there are 31 Washington Counties).
const US_STATE_CODES = new Set(("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND "
  + "OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU AS MP").split(" "));

// Where every piece of data in a report comes from. The detail window, the printout, the copied summary and the compare table
// all read this one table, so the wording and links stay the same everywhere. `vintage` says how old the data is; where the
// data itself carries a date (internet, hardiness, tax rate) scoring.js fills that in instead (see sourceVintage).
const DATA_SOURCES = {
  county:       { label: "County and state",         name: "US Census Bureau Geocoder",                              url: "https://geocoding.geo.census.gov/",                        vintage: "current county boundaries" },
  flood:        { label: "Flood zone",               name: "FEMA National Flood Hazard Layer",                       url: "https://msc.fema.gov/portal/home",                         vintage: "FEMA's current flood maps; some areas are not mapped" },
  elevation:    { label: "Elevation and slope",      name: "USGS 3D Elevation Program (National Map point query)",  url: "https://apps.nationalmap.gov/epqs/",                       vintage: "best available USGS elevation data" },
  soil:         { label: "Soil and septic rating",   name: "USDA NRCS Soil Data Access (Web Soil Survey)",           url: "https://sdmdataaccess.nrcs.usda.gov/",                     vintage: "current USDA soil survey" },
  soilDetails:  { label: "Soil details",             name: "USDA NRCS Soil Data Access (Web Soil Survey)",           url: "https://websoilsurvey.nrcs.usda.gov/",                     vintage: "current USDA soil survey" },
  rain:         { label: "Average yearly rain",      name: "Open-Meteo Historical Weather (ERA5 reanalysis)",        url: "https://open-meteo.com/en/docs/historical-weather-api",    vintage: "recent years of daily model data" },
  climate:      { label: "Climate and solar",        name: "Open-Meteo Historical Weather (ERA5 reanalysis)",        url: "https://open-meteo.com/en/docs/historical-weather-api",    vintage: "recent years of daily model data" },
  airport:      { label: "Nearest airport",          name: "Built-in airport list (Criteria) with straight-line distance", url: null,                                                 vintage: "list kept in this app" },
  routes:       { label: "Drive times by road",      name: "OSRM public routing demo server on OpenStreetMap roads", url: "https://project-osrm.org/",                                vintage: "current OpenStreetMap roads" },
  internet:     { label: "Internet",                 name: "FCC Form 477 fixed broadband deployment data",           url: "https://broadbandmap.fcc.gov/",                            vintage: "FCC data" },
  places:       { label: "Nearby places, schools and emergency services", name: "OpenStreetMap through the Overpass API", url: "https://www.openstreetmap.org/copyright",                 vintage: "current OpenStreetMap data" },
  hazards:      { label: "Natural hazards",          name: "FEMA National Risk Index (census tracts)",               url: "https://hazards.fema.gov/nri/",                            vintage: "current National Risk Index release" },
  hardiness:    { label: "Plant hardiness zone",     name: "USDA Plant Hardiness Zone Map (through phzmapi.org)",    url: "https://planthardiness.ars.usda.gov/",                     vintage: "USDA map" },
  taxRate:      { label: "County property tax rate", name: "US Census Bureau American Community Survey, 5-year estimates", url: "https://www.census.gov/programs-surveys/acs",        vintage: "ACS 5-year release" },
  roads:        { label: "Road access",              name: "OpenStreetMap through the Overpass API",                 url: "https://www.openstreetmap.org/copyright",                  vintage: "current OpenStreetMap data" },
  wetlands:     { label: "Wetlands",                 name: "US Fish and Wildlife Service National Wetlands Inventory", url: "https://www.fws.gov/program/national-wetlands-inventory", vintage: "current NWI map (mapping dates vary by area)" },
  publicLand:   { label: "Public and protected land", name: "USGS Protected Areas Database of the US (PAD-US)",      url: "https://www.usgs.gov/programs/gap-analysis-project/science/pad-us-data-overview", vintage: "current PAD-US release" },
  groundwater:  { label: "Groundwater",            name: "USGS Water Data API (field measurements of groundwater level)", url: "https://waterdata.usgs.gov/",                  vintage: "latest measurement at each well; many are decades old" },
  usda:         { label: "USDA loan area",           name: "USDA Rural Development Single Family Housing eligibility map (ineligible areas)", url: "https://eligibility.sc.egov.usda.gov/eligibility/", vintage: "current USDA map" },
  costs:        { label: "Rough cost",               name: "Placeholder rates and prices from your Criteria",        url: null,                                                       vintage: "your settings; the county tax rate comes from the Census ACS when known" },
};

// Plain-language meaning of each label in the report. Hovering (or tabbing to) a dotted label shows `text`, then the name of the
// agency that supplies the data (`source` is a key of DATA_SOURCES). A label with no entry here is shown as plain text.
const GLOSSARY = {
  // ---- the main table ----
  "Coordinates": { text: "Latitude and longitude of the point you picked or the address match. All lookups are for this one point." },
  "In a flood zone?": { source: "flood", text: "Yes means FEMA maps the spot in a high-risk flood zone (FEMA zones starting with A or V). No means it is mapped as lower risk. FEMA's flood map label. Zones starting with A or V are high risk: at least a 1% chance of flooding in any year, about 26% over a 30-year loan, and lenders require flood insurance there. Zone X is lower risk (shaded X is a 0.2% yearly chance). \"Unknown\" often means the area has not been mapped." },
  "Elevation": { source: "elevation", text: "Height of the ground above sea level, in feet." },
  "Slope (steepest of 4 directions)": { source: "elevation", text: "How steeply the ground drops, as a percent: 10% means 10 feet of drop in 100 feet. The app compares the point with the ground a short way north, south, east and west and keeps the steepest. Steep ground raises driveway, foundation and septic costs." },
  "Soil": { source: "soil", text: "Name of the main soil at the point. Each name covers a mapped area that can include small patches of other soils." },
  "Drainage class": { source: "soil", text: "How fast water leaves the soil after rain, from very poorly drained (wet much of the year) to excessively drained (water drains very fast). Well drained is usually best for homes and septic systems." },
  "Septic rating": { source: "soil", text: "The USDA's rating of how well the soil works for a septic drain field: not limited, somewhat limited or very limited. It is a screening rating. A county site evaluation and percolation test decide what is allowed." },
  "Average yearly rain": { source: "rain", text: "Average rain in inches a year, worked out from several recent years of daily weather model data. The model grid is about 10 km wide, so a single lot can differ." },
  "Nearest airport": { source: "airport", text: "Closest airport on the app's list. Shows the road distance and drive time when a route could be found, otherwise a straight-line distance and an estimated drive time." },
  "Plant hardiness zone": { source: "hardiness", text: "USDA zone based on the average coldest winter night. Each zone is 10 F wide and split into halves (a and b) of 5 F. A higher number means milder winters. Looked up by ZIP code, so it can differ a little at your lot." },
  "Data fetched": { text: "When the app last looked up this parcel's data. Public data changes, so use Refresh data before a decision." },
  // ---- climate and solar ----
  "Last spring freeze (average)": { source: "climate", text: "Average date of the last day in spring with a low of 32 F (0 C) or colder, across the years shown. Frost can come later in some years, so ask your county extension office for planting dates." },
  "First fall freeze (average)": { source: "climate", text: "Average date of the first day in fall with a low of 32 F (0 C) or colder, across the years shown." },
  "Frost-free days": { source: "climate", text: "Average number of days between the last spring freeze and the first fall freeze. This is the length of the growing season for tender plants." },
  "Freezes": { source: "climate", text: "How many of the years looked at had at least one day with a low of 32 F or colder. Where freezes are rare there are no frost dates to show." },
  "Freezing days a year": { source: "climate", text: "Average number of days a year when the low reached 32 F (0 C) or colder." },
  "Days over 90 F / 100 F": { source: "climate", text: "Average number of days a year with a high of at least 90 F, and at least 100 F. More hot days mean higher cooling bills and more heat stress on animals and crops." },
  "Typical January low / July high": { source: "climate", text: "Average daily low in January and average daily high in July, the usual coldest and hottest months in the lower 48." },
  "Snow": { source: "climate", text: "Average inches of snow a year. Computed by the weather model from snowfall water, so treat it as a rough figure." },
  "Sunlight": { source: "climate", text: "Average \"full-sun hours\" a day: the sunlight energy reaching flat ground, divided by the energy of one hour of full sun (1 kWh per square meter). The best and the lowest month are shown." },
  "Rough solar output": { source: "climate", text: "Rule of thumb for yearly electricity from each kilowatt of panels: full-sun hours x 365 days x 0.8 for losses. Real output depends on tilt, shade and equipment." },
  // ---- soil details ----
  "Topsoil": { source: "soilDetails", text: "Texture of the top layer, from the mix of sand, silt and clay. Loam holds water and nutrients well, sand drains fast, and clay holds water and drains slowly." },
  "Organic matter / pH": { source: "soilDetails", text: "Organic matter is the share of decayed plant and animal material in the topsoil. More means richer soil. pH measures acidity: 7 is neutral, lower is acid and higher is alkaline (above 7.5 is common over limestone)." },
  "Water the top 5 ft can hold": { source: "soilDetails", text: "Available water capacity: inches of water the top five feet of soil can store for plant roots. More helps crops and gardens get through dry spells." },
  "Farmland class": { source: "soilDetails", text: "USDA farmland rating: prime farmland has the best mix of soil, moisture and growing season for crops. Other classes are farmland of statewide importance, or not prime." },
  "Wetland-type (hydric) soil": { source: "soilDetails", text: "Hydric soil stays wet long enough to lose its oxygen. \"Yes\" means the whole soil unit is hydric, \"Partially\" means some of it is, and \"No\" means none. It is a clue to wetlands, not proof." },
  "Seasonal water table": { source: "soilDetails", text: "Depth below the surface to the top of the water that rises into the soil in the wettest season. A shallow water table can mean wet basements and failing septic drain fields." },
  "Depth to bedrock": { source: "soilDetails", text: "Depth to solid rock. Shallow rock makes digging for foundations, septic systems, utility lines and wells harder and costlier." },
  "Flooding / ponding (soil survey)": { source: "soilDetails", text: "How often the soil floods from streams, and how often rain ponds in low spots, according to the soil survey. This is separate from FEMA's flood zone." },
  "Shrink-swell": { source: "soilDetails", text: "How much the soil swells when wet and shrinks when dry: low, moderate or high. High shrink-swell (common in clay) can crack foundations, slabs and driveways." },
  "Water runoff group": { source: "soilDetails", text: "USDA hydrologic soil group. A soaks up water quickly with little runoff, D soaks it up slowly so most rain runs off. Two letters such as B/D mean the soil acts differently when drained and undrained." },
  "Home without basement": { source: "soilDetails", text: "USDA rating of how well the soil suits building a home without a basement: not limited, somewhat limited or very limited. It weighs wetness, slope, shrink-swell and depth to rock." },
  "Shallow excavations": { source: "soilDetails", text: "USDA rating for digging trenches up to about 5 feet deep, such as for utility lines and footings. Rock, wetness and caving walls make it more limited." },
  "Local roads": { source: "soilDetails", text: "USDA rating for building local roads and driveways on the soil. Poor drainage, soft soil and frost make it more limited." },
  "Pond reservoir": { source: "soilDetails", text: "USDA rating for building a pond: how well the soil holds water instead of letting it seep away." },
  "Sewage lagoon": { source: "soilDetails", text: "USDA rating for a sewage lagoon, a shallow pond some rural wastewater systems use. Seepage and slope make it more limited." },
  // ---- road access ----
  "Nearest road": { source: "roads", text: "Closest drivable road in OpenStreetMap to your point. It shows a road nearby, not that your parcel touches it or that you may use it." },
  "Nearest paved public road": { source: "roads", text: "Closest road that looks paved and open to the public. Roads marked private, and most service roads and driveways, are skipped. Surface and access tags are volunteer-entered and sometimes missing." },
  // ---- compare table ----
  "Score": { text: "The parcel's overall score from 0 to 100, a weighted average of the factors that had data. Weights are set in Criteria." },
  "Dealbreakers": { text: "Problems you told the app to treat as disqualifying in Criteria, such as a high-risk flood zone." },
  "USDA loan area": { source: "usda", text: "Whether the spot is in an area where USDA Rural Development guaranteed home loans are available. \"Yes\" means it is not inside one of USDA's mapped ineligible (more built-up) areas. It says nothing about income limits (the buyer's household income must be under a limit), about the buyer's credit, or about the property: USDA loans buy a home, not bare land. Check the exact address on USDA's own map." },
  "Asking price": { text: "The price you entered for the parcel." },
  "Price per acre": { text: "Asking price divided by acres." },
  "Rough monthly cost": { source: "costs", text: "Estimated monthly cost of owning the land (loan, property tax, insurance, and so on) from the rates in Criteria. It is not a quote." },
  "Rough start-up cost (septic + well)": { source: "costs", text: "One-time estimate for a septic system and a well from the placeholder prices in Criteria. Local contractors can quote real prices." },
  "Acres": { text: "Size of the parcel, as you entered it. The app does not know parcel boundaries." },
  "Septic suitability": { source: "soil", text: "The USDA's rating of how well the soil works for a septic drain field. A county site evaluation decides what is allowed." },
  "Slope": { source: "elevation", text: "How steeply the ground drops, as a percent. Steep ground raises driveway, foundation and septic costs." },
  "Rain per year": { source: "rain", text: "Average rain in inches a year, from several recent years of weather model data." },
  "Drive to airport": { source: "airport", text: "Drive time to the nearest airport on the app's list, from a road route when one was found, otherwise estimated from the straight-line distance." },
  "Internet (best non-satellite)": { source: "internet", text: "Fastest download speed (Mbps) that home-internet providers reported for your census block, leaving satellite out. Reported maximums are often higher than what you would really get, and the FCC data is older than today's coverage." },
  "Public or protected land": { source: "publicLand", text: "Nearest parks, forests, refuges and other protected areas, up to 25 miles. Neighboring public land can bring quiet views, or crowds, hunting and fire risk." },
  "Mapped wetlands": { source: "wetlands", text: "Whether the point is on a mapped wetland, and how many are within a quarter mile. Ponds and lakes count. This is a screening map, not a legal wetland boundary." },
  "Groundwater depth (nearest well)": { source: "groundwater", text: "Depth to water in the nearest USGS monitoring well. A monitoring well is not your lot, and water depth can differ a lot over a mile." },
  "Days over 100 F per year": { source: "climate", text: "Average number of days a year with a high of at least 100 F." },
  "Snow per year": { source: "climate", text: "Average inches of snow a year, from weather model data." },
  "Solar: full-sun hours per day": { source: "climate", text: "Average hours a day of full-strength sun reaching flat ground. More hours means more solar power per panel." },
  "Topsoil texture": { source: "soilDetails", text: "Texture of the top layer, from the mix of sand, silt and clay. Loam is the most useful all-round mix." },
  "Seasonal water table depth": { source: "soilDetails", text: "Depth to the water that rises into the soil in the wettest season. Shallow means wet basements and septic trouble." },
  "Soil flooding (soil survey)": { source: "soilDetails", text: "How often the soil floods, per the soil survey. This is separate from FEMA's flood zone." },
  "Hardiness zone (by ZIP)": { source: "hardiness", text: "USDA zone based on the average coldest winter night, looked up by ZIP code. A higher number means milder winters." },
  "Natural hazard risk (FEMA)": { source: "hazards", text: "FEMA's overall risk rating for the census tract, compared with the rest of the US. It is modeled risk, not a forecast." },
  "Hazards rated high or very high": { source: "hazards", text: "How many of the 18 hazards FEMA rates (tornado, wildfire, hail, flooding and so on) are rated high or very high for the census tract." },
  "Status": { text: "Where the parcel stands in your search, as you set it." },
  // ---- factor table ----
  "Rainfall": { source: "rain", text: "Yearly rain compared with the range set in Criteria." },
  "Airport distance": { source: "airport", text: "Drive time to the nearest airport compared with the range set in Criteria." },
  "Price": { text: "Asking price compared with your budget range in Criteria." },
  "Hunting county": { text: "Whether the county is on your hunting-county list in Criteria." },
  "Internet": { source: "internet", text: "Best non-satellite download speed compared with the range set in Criteria." },
};
