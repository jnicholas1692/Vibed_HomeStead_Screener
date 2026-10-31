"use strict";

// The version shown in the page footer and the day it was released. Change both with every release,
// along with "version" in package.json and the README version history (tests/version.test.js checks they agree).
const APP_VERSION = "2.3.0";
const APP_UPDATED = "2026-10-31";   // year-month-day

// Where to sign up for the free Census API key used for the county tax rate and county profile.
const CENSUS_KEY_SIGNUP_URL = "https://api.census.gov/data/key_signup.html";

/* =====================================================================
   1. Criteria (what "good land" means to you). Saved in this browser.
   ===================================================================== */
const DEFAULT_SETTINGS = {
  // Your criteria: tick the ones that matter to you. Every ticked criterion counts the same toward the 0 to 100 score,
  // and `order` is the order they are shown in (the report summary, the list columns and the compare table).
  // Keys are those of FACTOR_LABELS. The last five are new in v2.3.0 and start unticked.
  criteria: {
    order: ["septic", "airport", "price", "internet", "slope", "rain", "flood", "groundwater", "hazards", "hospital", "grocery"],
    on: { septic: true, airport: true, price: true, internet: true, slope: true, rain: true,
      flood: false, groundwater: false, hazards: false, hospital: false, grocery: false },
  },
  // Which criteria rule a parcel out completely when they hit their worst end. A switch works whether or not the criterion is ticked.
  dealbreakers: { flood: true, septic: false, slope: false, rain: false, airport: true, price: false, internet: false,
    groundwater: false, hazards: false, hospital: false, grocery: false },
  priceTarget: 100000, priceMax: 150000,        // full marks at or below target, zero at or above max
  slopeIdeal: 5, slopeMax: 20,                   // slope in percent
  rainFull: 35, rainZero: 15,                    // average inches of rain per year
  detourFactor: 1.3, avgMph: 55,                 // turns straight-line miles into drive minutes
  airportFullMin: 75, airportMaxMin: 120,        // drive minutes; beyond the max is a dealbreaker
  internetFullMbps: 100, internetZeroMbps: 5,    // best non-satellite download speed
  groundwaterFullFt: 50, groundwaterZeroFt: 400, // depth to water at the nearest monitoring well; shallower is cheaper to reach
  hospitalFullMin: 20, hospitalMaxMin: 60,       // drive minutes to the nearest hospital with an emergency room
  groceryFullMin: 15, groceryMaxMin: 45,         // drive minutes to the nearest supermarket
  censusKey: "",                                 // optional free Census API key, needed for the county tax rate
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
  reportOrder: ["data", "soilDetails", "groundwater", "wetlands", "publicLand", "roads", "places", "internet", "climate", "hazards", "more", "texas", "cost"],
};

// The report sections you can reorder. The score and factor table always come first,
// and the data sources and your notes always come last.
const REPORT_SECTIONS = [
  ["data", "What the data says"], ["soilDetails", "Soil details"], ["groundwater", "Groundwater"],
  ["wetlands", "Wetlands"], ["publicLand", "Public and protected land"], ["roads", "Road access"],
  ["places", "Nearby"], ["internet", "Internet"], ["climate", "Climate and solar"],
  ["hazards", "Natural hazards"], ["more", "More local conditions"], ["texas", "Texas details"], ["cost", "Rough cost"],
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

// The report sections gathered into collapsible categories: [key, heading, the sections inside it].
// Every section in REPORT_SECTIONS must be in exactly one category (a test checks this).
const REPORT_GROUPS = [
  ["overview", "Overview", ["data"]],
  ["land", "Land, soil and water", ["soilDetails", "groundwater", "wetlands", "publicLand"]],
  ["access", "Access and services", ["roads", "places", "internet"]],
  ["climate", "Climate, hazards and area", ["climate", "hazards", "more"]],
  ["texas", "Texas", ["texas"]],
  ["money", "Cost and loans", ["cost"]],
];

// How the list is sorted and filtered when you first open the page.
const DEFAULT_VIEW = { sort: "score", status: "all", hideDealbreakers: false };

// Fixed rules for the 30-year home loan comparison (FHA minimums as of 2026).
const LOAN_RULES = {
  years: 30,
  conventionalMinDownPct: 3, conventionalNoPmiDownPct: 20,
  fhaMinDownPct: 3.5, fhaLongMipDownPct: 10,       // under 10% down, FHA insurance lasts the whole loan; 10% or more, 11 years
  fhaLoanLimitFloor: 541287,                        // the national floor for a one-unit home in 2026; higher in costly counties
};

// Before v2.3.0 the score used a 10-point "skill tree". These are only used to convert settings saved by those versions:
// a factor that had points becomes a ticked criterion, and more points put it higher in your order.
const POINT_BUDGET = 10;
const OLD_DEFAULT_POINTS = { septic: 2, slope: 1, rain: 1, airport: 2, price: 2, internet: 2 };

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
  const known = Object.keys(OLD_DEFAULT_POINTS);
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
  airport: "Airport distance", price: "Price", internet: "Internet",
  flood: "Flood risk", groundwater: "Groundwater depth", hazards: "Natural hazard rating",
  hospital: "Hospital drive", grocery: "Grocery drive",
};

// Cleans up saved criteria: unknown or repeated keys are dropped, any criterion the saved order is missing
// (for example one added in a newer version) goes at the end, and only true/false ticks are kept.
function normalizeCriteria(saved) {
  const known = Object.keys(FACTOR_LABELS);
  const savedOrder = saved && Array.isArray(saved.order) ? saved.order : [];
  const order = [];
  for (const key of savedOrder) if (known.includes(key) && !order.includes(key)) order.push(key);
  for (const key of DEFAULT_SETTINGS.criteria.order) if (!order.includes(key)) order.push(key);
  const on = {};
  for (const key of known) {
    const v = saved && saved.on ? saved.on[key] : undefined;
    on[key] = typeof v === "boolean" ? v : DEFAULT_SETTINGS.criteria.on[key];
  }
  return { order, on };
}

// Turns old skill-tree points into criteria: factors with points are ticked, and the order follows the points
// (most first, ties keep the default order). Factors added later stay unticked, after the old ones.
function criteriaFromPoints(points) {
  const old = Object.keys(OLD_DEFAULT_POINTS);
  const defaultOrder = DEFAULT_SETTINGS.criteria.order;
  const byPoints = [...old].sort((a, b) => (points[b] || 0) - (points[a] || 0) || defaultOrder.indexOf(a) - defaultOrder.indexOf(b));
  const on = {};
  for (const key of Object.keys(FACTOR_LABELS)) on[key] = old.includes(key) ? (points[key] || 0) > 0 : false;
  return normalizeCriteria({ order: byPoints, on });
}

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
  censusProfile:{ label: "County profile",         name: "US Census Bureau American Community Survey, 5-year estimates", url: "https://www.census.gov/programs-surveys/acs", vintage: "ACS 5-year estimates for the county" },
  drought:      { label: "Drought status",           name: "US Drought Monitor (current weekly map, National Drought Mitigation Center)", url: "https://droughtmonitor.unl.edu/", vintage: "the latest weekly map" },
  nws:          { label: "Weather office and alerts", name: "National Weather Service API", url: "https://www.weather.gov/documentation/services-web-api", vintage: "live; alerts are those in effect right now" },
  power:        { label: "Wind and humidity",        name: "NASA POWER climatology", url: "https://power.larc.nasa.gov/", vintage: "long-term averages from NASA satellite and weather model data" },
  echo:         { label: "Regulated facilities",     name: "EPA Enforcement and Compliance History Online (ECHO)", url: "https://echo.epa.gov/", vintage: "current ECHO facility records" },
  txParcel:     { label: "Texas appraisal parcel",  name: "Texas Geographic Information Office (TxGIO) StratMap land parcels, from the county appraisal districts", url: "https://tnris.org/stratmap/land-parcels/", vintage: "most recent statewide parcel release; values are for the tax year shown" },
  txGcd:        { label: "Groundwater district",     name: "Texas Water Development Board, Groundwater Conservation Districts", url: "https://www.twdb.texas.gov/mapping/gisdata.asp", vintage: "current TWDB boundaries" },
  txSchool:     { label: "School district",          name: "Texas Legislative Council statewide school district boundaries", url: "https://tlc.texas.gov/", vintage: "2019-2020 boundaries, so a recent change may be missing" },
  txWells:      { label: "Nearby water wells",       name: "Texas Water Development Board Groundwater Database", url: "https://www.twdb.texas.gov/groundwater/data/index.asp", vintage: "current database; wells are reported by drillers and districts over many decades" },
  txRrc:        { label: "Oil, gas and pipelines",   name: "Railroad Commission of Texas public GIS", url: "https://www.rrc.texas.gov/resource-center/research/gis-viewer/", vintage: "current RRC maps" },
  txEdwards:    { label: "Edwards Aquifer zone",     name: "Edwards Aquifer Recharge Zone boundary (TCEQ, 2005) as published by the City of Austin", url: "https://www.tceq.texas.gov/gis/metadata/edwards_met.html", vintage: "TCEQ boundary adopted 2005" },
  femaDisasters:{ label: "Disaster declarations",    name: "OpenFEMA Disaster Declarations Summaries", url: "https://www.fema.gov/openfema-data-page/disaster-declarations-summaries-v2", vintage: "declarations in the last 10 years" },
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
  "Septic rating": { source: "soil", text: "The USDA's rating of how well the soil works for a septic drain field: not limited, somewhat limited or very limited. It is a screening rating. A county site evaluation and percolation test decide what is allowed. In the score, Not limited counts 100, Somewhat limited 60 and Very limited 15." },
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
  "Score": { text: "The parcel's overall score from 0 to 100, a points-weighted average of the factors that had data. The points are set in Settings." },
  "Dealbreakers": { text: "Problems you told the app to treat as disqualifying with the Dealbreaker switches in Settings, such as a high-risk flood zone." },
  "USDA loan area": { source: "usda", text: "Whether the spot is in an area where USDA Rural Development guaranteed home loans are available. \"Yes\" means it is not inside one of USDA's mapped ineligible (more built-up) areas. It says nothing about income limits (the buyer's household income must be under a limit), about the buyer's credit, or about the property: USDA loans buy a home, not bare land. Check the exact address on USDA's own map." },
  "Asking price": { text: "The price you entered for the parcel." },
  "Price per acre": { text: "Asking price divided by acres." },
  "Rough monthly cost": { source: "costs", text: "Estimated monthly cost of owning the land (loan, property tax, insurance, and so on) from the rates in Settings. It is not a quote." },
  "Rough start-up cost (septic + well)": { source: "costs", text: "One-time estimate for a septic system and a well from the placeholder prices in Settings. Local contractors can quote real prices." },
  "Acres": { text: "Size of the parcel, as you entered it. The app does not know parcel boundaries." },
  // (Septic suitability and the other scored factors are explained in FACTOR_TIPS below, with your current settings filled in.)
  "Slope": { source: "elevation", text: "How steeply the ground drops, as a percent. Steep ground raises driveway, foundation and septic costs." },
  "Rain per year": { source: "rain", text: "Average rain in inches a year, from several recent years of weather model data." },
  "Drive to airport": { source: "airport", text: "Drive time to the nearest airport on the app's list, from a road route when one was found, otherwise estimated from the straight-line distance." },
  "Internet (best non-satellite)": { source: "internet", text: "Fastest download speed (Mbps) that home-internet providers reported for your census block, leaving satellite out. Reported maximums are often higher than what you would really get, and the FCC data is older than today's coverage." },
  "Public or protected land": { source: "publicLand", text: "Nearest parks, forests, refuges and other protected areas, up to 25 miles. Neighboring public land can bring quiet views, or crowds and fire risk." },
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
  // ---- more local conditions ----
  "County population": { source: "censusProfile", text: "People living in the whole county, from the Census Bureau's 5-year survey estimates. A small number usually means few services, long response times and a small job market nearby." },
  "County median household income": { source: "censusProfile", text: "The middle household income in the county (half earn more, half less). It hints at local wages and what neighbors can afford, which affects services, schools and resale." },
  "County median age": { source: "censusProfile", text: "The middle age of county residents. A high median age often means a retirement area, with fewer school-age children." },
  "County median home value": { source: "censusProfile", text: "The middle value owners give their homes in the county. It is a rough gauge of what land plus a house sells for nearby." },
  "Households with broadband (county)": { source: "censusProfile", text: "Share of county households with a broadband internet subscription of any kind, including cellular and satellite. It is a survey result for the whole county, not the availability at your spot." },
  "Drought now": { source: "drought", text: "The category of the latest US Drought Monitor weekly map at this spot: D0 abnormally dry, D1 moderate, D2 severe, D3 extreme or D4 exceptional drought. No drought means the spot is outside every drought area on the map. Drought matters for wells, ponds, grass and fire risk." },
  "Weather service office": { source: "nws", text: "The National Weather Service forecast office that covers this spot, and a nearby town. Its website has forecasts, past storms and local warnings." },
  "Weather alerts now": { source: "nws", text: "Weather watches, warnings and advisories in effect at this spot right now, according to the National Weather Service. They change hour by hour, so this is only a snapshot from when the data was fetched." },
  "Average wind speed": { source: "power", text: "Yearly average wind speed at 10 meters (about 33 feet) above ground. Small wind turbines usually need an average of about 10 mph or more to make sense. Treetops, hills and buildings change the wind at your site." },
  "Average humidity": { source: "power", text: "Yearly average relative humidity at 2 meters above ground. High humidity means mold, rust and wood rot are bigger worries, and it makes heat feel worse." },
  "Regulated facilities within 2 miles": { source: "echo", text: "Factories, plants, landfills, fuel terminals and other sites that hold an environmental permit with the EPA, counted within two miles. A high count points to industrial neighbors; open the EPA's ECHO site for each one's violation record." },
  // ---- Texas details (shown only for parcels in Texas) ----
  "Appraisal district acres": { source: "txParcel", text: "Acres on record at the county appraisal district for the parcel under your point. If it differs a lot from the acres you entered, you may have picked a neighboring parcel or one tract of a larger deed." },
  "Appraised land value": { source: "txParcel", text: "What the appraisal district values the land alone at for property tax. Texas values qualifying farm and ranch land by what it can earn from farming or grazing, so this is often far below what the land would sell for. It is not a price." },
  "Appraised total value": { source: "txParcel", text: "The appraisal district's market value for land plus buildings and other improvements, for the tax year shown. Use it as a clue about size and development, not as a price." },
  "Land use (appraisal district)": { source: "txParcel", text: "How the appraisal district classifies the parcel, such as vacant land, farm or ranch, or residential. The wording differs from county to county." },
  "Groundwater district": { source: "txGcd", text: "A groundwater conservation district is a local government that manages well drilling and water use in its area. Inside one you usually must register or get a permit for a well, and there may be spacing or pumping limits. Outside one, Texas rules for private wells are lighter. Ask the district before you buy." },
  "School district": { source: "txSchool", text: "The public school district for the spot, which also sets a large part of your property tax bill. The district lines are from 2019-2020, so confirm with the appraisal district or the school before relying on them." },
  "Water wells nearby": { source: "txWells", text: "Wells in the Texas Water Development Board database near your spot: how many there are, and the middle (median) and range of their drilled depth. Depth is how far down the well was drilled, not how deep the water sits, and many wells are old." },
  "Aquifer (nearby wells)": { source: "txWells", text: "The aquifer most often recorded for the nearby wells. An aquifer is the underground rock or sand that holds the water wells pump. Aquifers differ a lot in how much water they give and how fast it is used up." },
  "Oil and gas wells within 1 mile": { source: "txRrc", text: "Wells in the Railroad Commission of Texas records, including oil, gas and injection or disposal wells, within one mile. They can bring noise, traffic, flaring, odors and spill risk. Also check who owns the minerals under the land, which this app cannot see." },
  "Pipelines within half a mile": { source: "txRrc", text: "Pipeline segments in Railroad Commission records within half a mile, with the operators and what they carry. A pipeline easement can limit where you can build or dig." },
  "Edwards Aquifer recharge zone": { source: "txEdwards", text: "The area where rain soaks quickly into the Edwards Aquifer, a major water supply for the San Antonio and Austin region. Building, septic systems and other work there fall under extra state water-protection rules (30 TAC Chapter 213) and need approval from the Texas Commission on Environmental Quality (TCEQ). Land just outside it may still drain toward it." },
  // ---- added in v2.3.0 from services the app already asks ----
  "Soil permeability (slowest layer)": { source: "soilDetails", text: "How fast water soaks through the slowest soil layer in the top 5 feet (the USDA's saturated hydraulic conductivity, Ksat). Very low or Low can mean a septic drain field drains poorly; Very high can let wastewater reach groundwater before it is cleaned. A percolation test on site decides." },
  "Social vulnerability": { source: "hazards", text: "FEMA's rating of how hard a disaster tends to hit the people in this census tract (income, age, housing and similar factors), compared with the rest of the US. Higher means a harder recovery." },
  "Community resilience": { source: "hazards", text: "FEMA's rating of how well the community can prepare for, absorb and recover from a disaster, compared with the rest of the US. Higher is better." },
  "FEMA disaster declarations (10 years)": { source: "femaDisasters", text: "Federal disaster and emergency declarations that named this county in the last 10 years, with the kinds of events and the latest one. It describes the whole county, not your lot, and a declaration depends on damage to people and property, not just the weather." },
  "Parcel outline": { source: "txParcel", text: "The parcel's boundary from the appraisal district's map, drawn on the map as a thin line. Appraisal maps are for tax, not a survey, so lines can be off by many feet." },
  // ---- rough cost (every number comes from the placeholder rates in Settings > Costs and loans) ----
  "Loan payment": { text: "Monthly principal and interest on a loan for the land itself, using your down payment, rate and years from Settings. 0 years means the land is treated as paid in cash." },
  "Property tax": { text: "Yearly property tax divided by 12. It uses the county's typical rate from the Census when known and turned on, otherwise your own percent from Settings. Vacant land and farm exemptions can make a real bill very different." },
  "Insurance": { text: "Your placeholder monthly cost to insure the land, from Settings. Replace it with a real quote." },
  "About per month": { text: "Loan payment, property tax and insurance added together. It leaves out the house, utilities and loan fees." },
  "Cash down payment": { text: "The cash you put down at purchase, from Settings. It never counts for more than the price." },
  "Septic system": { text: "Placeholder cost of a septic system from Settings: the engineered price when the soil is very limited for septic, otherwise the conventional price." },
  "Water well": { text: "Placeholder cost of drilling a water well, from Settings. Depth and rock make this swing widely, so get a local driller's quote." },
  "One-time start-up": { text: "Cash down payment, septic system and water well added together. It leaves out the house, the driveway, electricity and closing costs." },
  // ---- the factor table (the scored factors are explained in FACTOR_TIPS below, with your settings filled in) ----
  "What we found": { text: "The value behind each criterion's score for this parcel, with its unit. \"no data\" means the lookup found nothing, so the criterion is skipped, not scored as zero." },
  "Criterion": { text: "One of the criteria you ticked in Settings, in your order. Each gets a score from 0 to 100, and the total is the plain average of those that have data. Change which ones count, and their order, in Settings > Scoring." },
};

// Explanations of the scored factors. Each is a function so it can show the ranges from your current Settings.
// (The scoring itself is in scoring.js; this text must agree with it.)
const FACTOR_TIPS = {
  "Septic suitability": (s) => `How well the soil suits a septic drain field, from the USDA soil survey. Not limited scores 100, Somewhat limited 60 and Very limited 15. This is a screening rating: a county site evaluation and percolation test decide what is allowed. ${s.dealbreakers.septic ? "Dealbreaker is on: a Very limited rating rules the parcel out." : "Turn on its Dealbreaker switch to rule out Very limited soil."}`,
  "Slope": (s) => `How steep the ground is. Scores 100 at ${s.slopeIdeal}% or flatter and 0 at ${s.slopeMax}% or steeper, evenly in between. Steep ground costs more for driveways, foundations and septic systems.`,
  "Rainfall": (s) => `Average yearly rain. Scores 100 at ${s.rainFull} inches a year and 0 at ${s.rainZero} inches a year, evenly in between. Rain matters for gardens, ponds and rainwater catchment, and what counts as enough depends on the region.`,
  "Airport distance": (s) => `Drive time to the nearest airport. Scores 100 at ${s.airportFullMin} minutes or less and falls to 0 at ${s.airportMaxMin} minutes. Beyond ${s.airportMaxMin} minutes it is a dealbreaker if that switch is on. A road route is used when one is found, otherwise an estimate from straight-line distance.`,
  "Price": (s) => `Asking price. Scores 100 at ${money(s.priceTarget)} or less and 0 at ${money(s.priceMax)} or more, evenly in between.`,
  "Internet": (s) => `Fastest download speed offered by wired or fixed wireless providers at the census block (satellite left out). Scores 100 at ${s.internetFullMbps} Mbps or more and 0 at ${s.internetZeroMbps} Mbps or less. If only satellite is listed it scores 25, and if no service is listed at all it scores 10.`,
  "Flood risk": () => "FEMA's flood zone for the spot. Zone X (minimal risk) scores 100, shaded zone X (moderate risk) 50, and a high-risk zone (A or V) 0. An unmapped spot is skipped, not scored. Its Dealbreaker switch rules out a high-risk zone.",
  "Groundwater depth": (s) => `Depth to water at the nearest USGS monitoring well. Scores 100 at ${s.groundwaterFullFt} ft or shallower and 0 at ${s.groundwaterZeroFt} ft or deeper, evenly in between. A monitoring well is not your lot, so treat this as a hint about drilling depth.`,
  "Natural hazard rating": () => "FEMA's overall National Risk Index rating for the census tract. Very Low scores 100, Relatively Low 75, Relatively Moderate 50, Relatively High 25 and Very High 0.",
  "Hospital drive": (s) => `Drive time to the nearest hospital that is not marked as having no emergency room, from OpenStreetMap. Scores 100 at ${s.hospitalFullMin} minutes or less and 0 at ${s.hospitalMaxMin} minutes or more.`,
  "Grocery drive": (s) => `Drive time to the nearest supermarket, from OpenStreetMap. Scores 100 at ${s.groceryFullMin} minutes or less and 0 at ${s.groceryMaxMin} minutes or more. Rural stores are often missing from the map, so check.`,
};

// Explanations for the boxes in Settings, keyed by the setting's name.
const SETTING_TIPS = {
  priceTarget: "Asking price at or below this scores 100 for the Price factor.",
  priceMax: "Asking price at or above this scores 0 for Price. Prices in between score evenly from 100 down to 0. It is also the dealbreaker line if that switch is on.",
  slopeIdeal: "Slope (percent grade) at or below this scores 100. 10% means 10 feet of drop in 100 feet.",
  slopeMax: "Slope at or above this scores 0. Slopes in between score evenly. It is also the dealbreaker line if that switch is on.",
  rainFull: "Average yearly rain (inches) that scores 100. What is enough varies a lot by region, so set it for the area you are searching.",
  rainZero: "Average yearly rain (inches) that scores 0. Amounts in between score evenly. It is also the dealbreaker line if that switch is on.",
  airportFullMin: "Drive time to the airport (minutes) at or below which the Airport factor scores 100.",
  airportMaxMin: "Drive time to the airport (minutes) at which the factor scores 0. A parcel farther than this is a dealbreaker if that switch is on.",
  detourFactor: "When no road route is found, the app estimates road miles by multiplying straight-line miles by this number. 1.3 means roads are about 30% longer than a straight line.",
  avgMph: "Average driving speed used to turn estimated road miles into minutes when no road route is found. Rural highways and back roads are slower than the speed limit.",
  internetFullMbps: "Best non-satellite download speed (Mbps) that scores 100 for Internet.",
  internetZeroMbps: "Best non-satellite download speed (Mbps) that scores 0. Speeds in between score evenly. It is also the dealbreaker line if that switch is on.",
  groundwaterFullFt: "Depth to water (feet) at the nearest monitoring well at or above which Groundwater depth scores 100.",
  groundwaterZeroFt: "Depth to water (feet) at or below which Groundwater depth scores 0. Depths in between score evenly. It is also the dealbreaker line if that switch is on.",
  hospitalFullMin: "Drive time (minutes) to the nearest emergency hospital at or below which Hospital drive scores 100.",
  hospitalMaxMin: "Drive time (minutes) to the nearest emergency hospital at which Hospital drive scores 0. It is also the dealbreaker line if that switch is on.",
  groceryFullMin: "Drive time (minutes) to the nearest supermarket at or below which Grocery drive scores 100.",
  groceryMaxMin: "Drive time (minutes) to the nearest supermarket at which Grocery drive scores 0. It is also the dealbreaker line if that switch is on.",
  "costs.downPayment": "Cash you plan to put down, in dollars. It is used for the land loan and both home loans, and never counts for more than the price.",
  "costs.ratePct": "Yearly interest rate for a loan on the land itself. Land loans usually cost more than home loans, so ask local lenders and replace this guess.",
  "costs.years": "How many years you would take to repay the land loan. Enter 0 to treat the land as paid in cash.",
  "costs.taxPct": "Yearly property tax as a percent of the price, used when the county's own typical rate is not known or turned off below. Rates vary widely by state.",
  "costs.insuranceMonthly": "Placeholder monthly cost to insure the land, in dollars. Replace it with a real quote.",
  "costs.septicStandard": "Placeholder cost of a conventional septic system, used when the soil is not very limited for septic.",
  "costs.septicEngineered": "Placeholder cost of an engineered septic system, used when the soil is very limited for septic. These cost more to design and install.",
  "costs.well": "Placeholder cost of drilling a water well. Depth and rock make this swing widely, so get a local driller's quote.",
  "costs.conventionalRatePct": "Yearly interest rate for a conventional 30-year home loan. Rates change daily; replace this with a lender's quote.",
  "costs.fhaRatePct": "Yearly interest rate for an FHA 30-year home loan. This default is only a guess, so replace it with a lender's quote.",
  "costs.pmiPct": "Private mortgage insurance on a conventional loan, as a percent of the loan per year. It applies when you put down less than 20%.",
  "costs.fhaUpfrontPct": "FHA's upfront mortgage insurance, a percent of the loan paid at closing. Here it is added to the loan.",
  "costs.fhaAnnualPct": "FHA's yearly mortgage insurance, as a percent of the loan. It lasts 11 years if you put down 10% or more, and otherwise for the whole loan.",
};

// Explanations for fixed parts of the page, keyed by element id. An input or select gets its tip on its label text; a button on itself.
const UI_TIPS = {
  "btn-add": "Add a parcel by address, a click on the map or coordinates. The app then looks up free public data for that spot.",
  "btn-criteria": "Open Settings: the 10-point scoring, dealbreakers, cost and loan numbers, and the order of report sections.",
  "btn-export": "Save all your parcels, notes and settings to a file you can keep or move to another browser.",
  "btn-import": "Load parcels and settings from a file made by Export.",
  "btn-clear": "Erase every parcel, note and setting stored in this browser. Export first if you want a copy.",
  "sort-by": "Choose how the list is ordered.",
  "filter-status": "Show only parcels with this status. You set a parcel's status inside its report.",
  "hide-dealbreakers": "Hide parcels that hit a dealbreaker you switched on in Settings.",
  "btn-compare": "Open a side-by-side table of the two or three parcels you ticked in the Pick column.",
  "btn-demo": "Add three made-up parcels so you can see how the app works. Delete them when you are done.",
  "btn-save": "Save the parcel and look up its data from the public sources.",
  "f-name": "A label for the parcel. It follows the address unless you type your own.",
  "f-address": "Optional. Pick a suggestion to fill in the coordinates. The text you type is sent to the photon.komoot.io address service.",
  "f-lat": "Latitude of the spot, in decimal degrees (north is positive). All lookups use this exact point.",
  "f-lon": "Longitude of the spot, in decimal degrees. In the US it is negative (west).",
  "f-acres": "Size of the parcel in acres. The app cannot see parcel lines, so this is only what you enter.",
  "f-price": "Asking price in US dollars. It feeds the Price score and the cost estimates.",
  "btn-pick": "Close this window and click the map to set the location.",
  "btn-reset-criteria": "Put every setting back to its starting value right away and close Settings. Your Census API key is kept.",
  "tab-scoring": "Spend your 10 points and set dealbreakers and the ranges that decide each score.",
  "tab-costs": "Placeholder numbers for the rough cost estimate and the home loan comparison.",
  "tab-layout": "Choose the order of the sections in each parcel's report.",
  "c-airport-mode": "Choose whether the airport factor uses the nearest major US airport or only airports you list.",
  "c-airports": "One airport per line as: name, latitude, longitude. The nearest one counts.",
  "c-airport-preset": "Pick an airport from the built-in list to add it to your list.",
  "c-census-key": "A free key from the US Census Bureau. With it the app can look up your county's typical property tax rate.",
  "c-census-key-link": "Opens the Census Bureau's sign-up page in a new tab. It asks for an organization name (your own name is fine) and an email address, and the Census emails you a key. It stays in this browser and is sent only to the Census.",
  "c-use-county-tax": "When on, the cost estimate uses the county's typical property tax rate if it is known, instead of the percent above.",
  "c-order-reset": "Put the report sections back in their starting order. Nothing changes until you press Save settings.",
  "d-status": "Where the parcel stands in your search. It sets the Status filter in the list.",
  "d-notes": "Your own notes. They are saved in this browser with the parcel, and printed with the report.",
  "app-version": "The version of the app you are using and the day it was last updated. What changed in each version is listed in the README on GitHub.",
};

// What each report category holds, shown when you hover its heading.
const GROUP_TIPS = {
  overview: "The main table: flood zone, elevation, slope, soil, rain, nearest airport, USDA loan area and hardiness zone. Click the heading to collapse or expand this category.",
  land: "Soil details, groundwater, wetlands and nearby protected land. Click the heading to collapse or expand this category.",
  access: "Roads, nearby places and services, and internet. Click the heading to collapse or expand this category.",
  climate: "Climate and solar, natural hazards, and county, drought, wind and facility details. Click the heading to collapse or expand this category.",
  texas: "Details from Texas state sources. This category only appears for parcels in Texas. Click the heading to collapse or expand it.",
  money: "Rough monthly and start-up costs, with land, conventional and FHA loan numbers. Click the heading to collapse or expand this category.",
};

// What each report section shows, for the Report layout tab.
const SECTION_TIPS = {
  data: "The main table: coordinates, flood zone, elevation, slope, soil, rain, nearest airport, USDA loan area and hardiness zone.",
  internet: "Providers and the top speeds they report at this spot, from FCC data.",
  places: "Nearest towns, shops, schools, hospitals and emergency services, with drive times.",
  publicLand: "Nearby parks, forests, refuges and other protected land.",
  groundwater: "Depth to water in the closest monitoring wells, and when each was measured.",
  wetlands: "Whether the spot is on or near a mapped wetland.",
  roads: "The nearest road and the nearest paved public road.",
  climate: "Freeze dates, hot days, snow and sunlight, with a rough solar estimate.",
  soilDetails: "Soil texture, wetness, depth to rock, shrink-swell and how suitable the soil is for building.",
  hazards: "FEMA's natural hazard risk ratings for the census tract.",
  more: "County population, income and broadband, drought, weather alerts, wind and humidity, and nearby regulated facilities.",
  texas: "Texas-only details: appraisal parcel, groundwater district, school district, nearby wells, oil and gas, and the Edwards Aquifer zone. Hidden for parcels outside Texas.",
  cost: "Rough monthly cost and start-up cost, with land, conventional and FHA loan numbers.",
};
