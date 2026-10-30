"use strict";

/* =====================================================================
   3. Data sources. Each one takes coordinates and returns plain data.
   ===================================================================== */
const TIMEOUT_MS = 30000;

// fetch() with a time limit. Reads the reply as text first so a plain-text reply
// (some services send one instead of JSON) can be told apart from a network failure.
async function getJSON(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      const error = new Error("Reply was not JSON");
      error.notJson = true;
      throw error;
    }
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// The Census geocoder does not allow normal browser requests (no CORS), but it
// supports JSONP: we add a <script> tag and it calls a function we name.
function jsonp(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const callbackName = "census_cb_" + Math.random().toString(36).slice(2);
    const script = document.createElement("script");
    const timer = setTimeout(() => { cleanup(); reject(new Error("Timed out")); }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      delete window[callbackName];
      script.remove();
    }
    window[callbackName] = (data) => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new Error("Request failed")); };
    script.src = `${url}${url.includes("?") ? "&" : "?"}format=jsonp&callback=${callbackName}`;
    document.head.appendChild(script);
  });
}

const CENSUS = "https://geocoding.geo.census.gov/geocoder";

async function geocodeAddress(address) {
  const data = await jsonp(`${CENSUS}/locations/onelineaddress?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current`);
  const match = data.result.addressMatches[0];
  if (!match) return null;
  // This service calls longitude "x" and latitude "y".
  return { lat: match.coordinates.y, lon: match.coordinates.x, matched: match.matchedAddress };
}

// Address suggestions while typing. Photon (photon.komoot.io) is a free search over
// OpenStreetMap that allows requests from a web page. It is only used to suggest
// addresses; the Census geocoder is still what looks the final address up.
const PHOTON = "https://photon.komoot.io/api/";

// Turns one Photon result into a one-line US address, or null if it is not in the US.
function formatSuggestion(feature) {
  const p = (feature && feature.properties) || {};
  const coords = feature && feature.geometry && feature.geometry.coordinates;
  if (p.countrycode !== "US" || !coords) return null;
  const street = p.housenumber && p.street ? `${p.housenumber} ${p.street}` : (p.street || p.name || "");
  const place = p.city || p.town || p.village || p.county || "";
  const stateZip = [p.state, p.postcode].filter(Boolean).join(" ");
  const label = [street, place, stateZip].filter(Boolean).join(", ");
  if (!label || !stateZip) return null;
  return { label, lat: coords[1], lon: coords[0] };
}

// Up to six distinct US suggestions for what has been typed so far.
async function suggestAddresses(text, signal) {
  const url = `${PHOTON}?q=${encodeURIComponent(text)}&limit=8&lang=en&bbox=-179.2,18.8,-66.9,71.5`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  const seen = new Set();
  const out = [];
  for (const feature of data.features || []) {
    const item = formatSuggestion(feature);
    if (item && !seen.has(item.label)) { seen.add(item.label); out.push(item); }
  }
  return out.slice(0, 6);
}

// Pulls the county name and two-letter state out of a Census reply.
// Louisiana "parishes" and Alaska "boroughs" keep their full name.
function parseCounty(data) {
  const geographies = (data.result && data.result.geographies) || {};
  const counties = geographies.Counties || [];
  const states = geographies.States || [];
  return {
    county: counties.length ? counties[0].NAME.replace(/ County$/, "") : null,
    state: states.length && states[0].STUSAB ? states[0].STUSAB : null,
    // The Census numbers every state and county. Together they name a county exactly, and the tax-rate lookup needs them.
    stateFips: counties.length && counties[0].STATE ? counties[0].STATE : (states.length && states[0].STATE ? states[0].STATE : null),
    countyFips: counties.length && counties[0].COUNTY ? counties[0].COUNTY : null,
  };
}

async function lookupCounty(lat, lon) {
  const data = await jsonp(`${CENSUS}/geographies/coordinates?x=${lon}&y=${lat}&benchmark=Public_AR_Current&vintage=Current_Current`);
  return parseCounty(data);
}

// "Blanco County, TX", "Orleans Parish, LA", or just "Blanco County" if the state is unknown.
function countyLabel(parcel) {
  if (!parcel.county) return "County unknown";
  const name = /(Parish|Borough|Municipality|Census Area|city)$/i.test(parcel.county) ? parcel.county : parcel.county + " County";
  return parcel.state ? `${name}, ${parcel.state}` : name;
}

// A rough "is this inside the United States?" check, to catch a mistyped minus sign or a swapped
// latitude and longitude. The boxes are generous, so a spot just over the border can slip through.
const US_BOXES = [
  { name: "lower 48", south: 24.3, north: 49.6, west: -125.1, east: -66.8 },
  { name: "Alaska", south: 51.0, north: 71.6, west: -180, east: -129.0 },
  { name: "Aleutians", south: 51.0, north: 53.5, west: 172.0, east: 180 },
  { name: "Hawaii", south: 18.8, north: 22.4, west: -160.7, east: -154.7 },
  { name: "Puerto Rico and Virgin Islands", south: 17.6, north: 18.6, west: -67.5, east: -64.5 },
];
function inUnitedStates(lat, lon) {
  return US_BOXES.some((b) => lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east);
}

const FEMA_FLOOD_LAYER = 28; // "Flood Hazard Zones" in FEMA's National Flood Hazard Layer
async function lookupFlood(lat, lon) {
  const params = new URLSearchParams({
    geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326",
    spatialRel: "esriSpatialRelIntersects", outFields: "FLD_ZONE,ZONE_SUBTY",
    returnGeometry: "false", f: "json",
  });
  const data = await getJSON(`https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/${FEMA_FLOOD_LAYER}/query?${params}`);
  if (data.error) throw new Error("FEMA service error");
  if (!data.features || data.features.length === 0) return null; // not mapped
  const { FLD_ZONE: zone, ZONE_SUBTY: subtype } = data.features[0].attributes;
  if (zone === "X" && String(subtype || "").toUpperCase().includes("0.2 PCT")) return "X (shaded)";
  return zone;
}

async function elevationFt(lat, lon) {
  const params = new URLSearchParams({ x: lon, y: lat, wkid: "4326", units: "Feet", includeDate: "false" });
  let data;
  try {
    data = await getJSON(`https://epqs.nationalmap.gov/v1/json?${params}`, {}, 45000); // this service can be slow
  } catch (error) {
    if (error.notJson) return null; // outside coverage (open ocean, for example): plain-text reply
    throw error;
  }
  const value = Number(data.value);
  return Number.isFinite(value) && value > -10000 ? value : null;
}

// Moves a point some meters north and east.
function offsetPoint(lat, lon, northM, eastM) {
  const metersPerDegreeLat = 111320;
  const metersPerDegreeLon = 111320 * Math.cos(lat * Math.PI / 180); // shrinks away from the equator
  return [lat + northM / metersPerDegreeLat, lon + eastM / metersPerDegreeLon];
}

// Elevation at the center plus a rough slope: the steepest change to four points 60 m away.
// All five requests start at once, because this service is slow and they do not depend on each other.
async function lookupTerrain(lat, lon) {
  const d = 60;
  const centerRequest = elevationFt(lat, lon);
  const neighborRequests = [[d, 0], [-d, 0], [0, d], [0, -d]].map(([n, e]) => {
    const [la, lo] = offsetPoint(lat, lon, n, e);
    return elevationFt(la, lo).catch(() => null); // a missing neighbor is skipped, not fatal
  });
  const center = await centerRequest;              // a real failure here is reported as a failure
  if (center == null) throw new Error("No elevation data at this point");
  const others = await Promise.all(neighborRequests);
  let steepest = 0;
  for (const other of others) {
    if (other == null) continue;
    const riseM = Math.abs(other - center) * 0.3048;
    steepest = Math.max(steepest, riseM / d * 100); // slope percent = rise / run * 100
  }
  return { elevationFt: Math.round(center * 10) / 10, slopePct: Math.round(steepest * 10) / 10 };
}

// Sends one query to USDA Soil Data Access and returns the rows as objects, like [{ soil_name: "...", ... }].
// An empty list means the question had no answer here (for example, no soil survey at this spot).
async function sdaRows(sql) {
  const body = new URLSearchParams({ query: sql, format: "JSON+COLUMNNAME" });
  const data = await getJSON("https://sdmdataaccess.sc.egov.usda.gov/Tabular/post.rest", { method: "POST", body }, 60000);
  const table = data.Table || [];
  if (table.length < 2) return [];
  const names = table[0];   // the first row holds the column names
  return table.slice(1).map((values) => Object.fromEntries(names.map((name, i) => [name, values[i]])));
}

// Text that picks the main soil component under a point: the one that covers the most of the map unit.
// lat and lon must already be checked numbers, so placing them in the query text is safe.
function mainComponentSql(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("Bad coordinates");
  return `(SELECT TOP 1 c2.cokey FROM component c2
      WHERE c2.mukey IN (SELECT * FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('POINT(${lon} ${lat})'))
      ORDER BY c2.comppct_r DESC)`;
}

async function lookupSoil(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("Bad coordinates");
  const sql = `
    SELECT TOP 1
      mu.muname AS soil_name,
      c.drainagecl AS drainage_class,
      (SELECT TOP 1 ci.interphrc FROM cointerp ci
        WHERE ci.cokey = c.cokey AND ci.mrulename = 'ENG - Septic Tank Absorption Fields') AS septic_rating
    FROM mapunit mu
    INNER JOIN component c ON c.mukey = mu.mukey
    WHERE mu.mukey IN (SELECT * FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('POINT(${lon} ${lat})'))
    ORDER BY c.comppct_r DESC`;
  const rows = await sdaRows(sql);
  if (rows.length === 0) return null; // no soil survey here
  return { soilName: rows[0].soil_name, drainageClass: rows[0].drainage_class, septicRating: rows[0].septic_rating };
}

/* ---- more soil facts: farmland, wetness, bedrock, texture, water holding, shrink-swell ---- */

// USDA soil texture classes, from percent sand, silt and clay (the "soil texture triangle").
// Each line describes one region of the triangle. They are checked in order.
function textureClass(sand, silt, clay) {
  if ([sand, silt, clay].some((v) => !Number.isFinite(v))) return null;
  if (silt + 1.5 * clay < 15) return "Sand";
  if (silt + 1.5 * clay >= 15 && silt + 2 * clay < 30) return "Loamy sand";
  if ((clay >= 7 && clay < 20 && sand > 52 && silt + 2 * clay >= 30) || (clay < 7 && silt < 50 && silt + 2 * clay >= 30)) return "Sandy loam";
  if (clay >= 7 && clay < 27 && silt >= 28 && silt < 50 && sand <= 52) return "Loam";
  if ((silt >= 50 && clay >= 12 && clay < 27) || (silt >= 50 && silt < 80 && clay < 12)) return "Silt loam";
  if (silt >= 80 && clay < 12) return "Silt";
  if (clay >= 20 && clay < 35 && silt < 28 && sand > 45) return "Sandy clay loam";
  if (clay >= 27 && clay < 40 && sand > 20 && sand <= 45) return "Clay loam";
  if (clay >= 27 && clay < 40 && sand <= 20) return "Silty clay loam";
  if (clay >= 35 && sand > 45) return "Sandy clay";
  if (clay >= 40 && silt >= 40) return "Silty clay";
  if (clay >= 40 && sand <= 45 && silt < 40) return "Clay";
  return null;   // a few gaps between the regions; better to say nothing than to guess
}

// "Shrink-swell" is how much a soil expands when wet. NRCS rates it from "linear extensibility" (LEP, in percent).
function shrinkSwellClass(lep) {
  if (!Number.isFinite(lep)) return null;
  return lep < 3 ? "Low" : lep < 6 ? "Moderate" : lep < 9 ? "High" : "Very high";
}

// SDA hands back numbers as text, and empty values as null. This gives a real number or NaN.
const num = (value) => (value === null || value === undefined || value === "" ? NaN : Number(value));

// Soil layers ("horizons") from top to bottom. Each row has depths in cm, percent sand/silt/clay, and so on.
// Returns the topsoil facts plus how much water the top 5 feet can hold and the worst shrink-swell in the top 40 inches.
function summarizeHorizons(rows) {
  const layers = rows.map((r) => ({
    top: num(r.hzdept_r), bottom: num(r.hzdepb_r), awc: num(r.awc_r), clay: num(r.claytotal_r), sand: num(r.sandtotal_r),
    silt: num(r.silttotal_r), om: num(r.om_r), ph: num(r.ph1to1h2o_r), lep: num(r.lep_r),
  })).filter((l) => Number.isFinite(l.top) && Number.isFinite(l.bottom)).sort((a, b) => a.top - b.top);
  if (layers.length === 0) return null;
  const topsoil = layers[0];
  const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
  // Available water: each layer's water capacity (cm of water per cm of soil) times its thickness, but only down to 152 cm (5 feet).
  const limitCm = 152.4;
  let waterCm = 0;
  let hasWater = false;
  for (const l of layers) {
    const thickness = Math.min(l.bottom, limitCm) - Math.min(l.top, limitCm);
    if (thickness > 0 && Number.isFinite(l.awc)) { waterCm += l.awc * thickness; hasWater = true; }
  }
  const leps = layers.filter((l) => l.top < 100 && Number.isFinite(l.lep)).map((l) => l.lep);
  const worstLep = leps.length ? Math.max(...leps) : NaN;
  return {
    texture: textureClass(topsoil.sand, topsoil.silt, topsoil.clay),
    clayPct: round1(topsoil.clay), sandPct: round1(topsoil.sand), siltPct: round1(topsoil.silt),
    organicMatterPct: round1(topsoil.om), ph: round1(topsoil.ph),
    waterHoldingIn: hasWater ? round1(waterCm / 2.54) : null,
    shrinkSwell: shrinkSwellClass(worstLep),
  };
}

// Flooding and ponding come as one value per month. We keep the most frequent one, using these orders.
const FLOOD_ORDER = ["None", "Very rare", "Rare", "Occasional", "Frequent", "Very frequent"];
const POND_ORDER = ["None", "Rare", "Occasional", "Frequent"];
function worstOf(values, order) {
  let worst = null;
  for (const v of values) {
    const rank = order.indexOf(v);
    if (rank !== -1 && (worst === null || rank > order.indexOf(worst))) worst = v;
  }
  return worst;
}

// Rules from the NRCS soil interpretations that matter when building on land. Each is rated Not limited / Somewhat limited / Very limited.
const SOIL_INTERPS = {
  "ENG - Dwellings Without Basements": "dwellings",
  "ENG - Shallow Excavations": "excavations",
  "ENG - Local Roads and Streets": "roads",
  "ENG - Pond Reservoir Areas": "ponds",
  "ENG - Sewage Lagoons": "lagoons",
};

// Puts the four answers together. Any of them can be missing (null) and the rest still show.
function summarizeSoilDetails({ main, flood, horizons, interps }) {
  const inchesFromCm = (cm) => (Number.isFinite(cm) ? Math.round(cm / 2.54) : null);
  const details = {};
  if (main) {
    details.farmland = main.farmland || null;
    details.hydric = main.hydric || null;
    details.hydrologicGroup = main.hyd_group || null;
    details.bedrockDepthIn = inchesFromCm(num(main.rock_depth_cm));
    details.bedrockKind = details.bedrockDepthIn == null ? null : main.rock_kind;
    details.waterTableDepthIn = inchesFromCm(num(main.water_table_cm));
  }
  if (flood) {
    details.flooding = worstOf(flood.map((r) => r.flood), FLOOD_ORDER);
    details.ponding = worstOf(flood.map((r) => r.pond), POND_ORDER);
  }
  if (horizons) Object.assign(details, horizons);
  if (interps) {
    details.interps = {};
    for (const r of interps) if (SOIL_INTERPS[r.rule]) details.interps[SOIL_INTERPS[r.rule]] = r.rating;
  }
  return Object.keys(details).length ? details : null;
}

// Four small questions, asked at the same time. If one fails the others still count;
// if all four fail we report the problem. `null` from a question means "no answer here".
async function lookupSoilDetails(lat, lon) {
  const comp = mainComponentSql(lat, lon);
  const questions = {
    main: `SELECT mu.farmlndcl AS farmland, c.hydricrating AS hydric, c.hydgrp AS hyd_group,
        (SELECT MIN(r.resdept_r) FROM corestrictions r WHERE r.cokey = c.cokey AND r.reskind LIKE '%bedrock%') AS rock_depth_cm,
        (SELECT TOP 1 r.reskind FROM corestrictions r WHERE r.cokey = c.cokey AND r.reskind LIKE '%bedrock%' ORDER BY r.resdept_r) AS rock_kind,
        (SELECT MIN(sm.soimoistdept_r) FROM comonth m INNER JOIN cosoilmoist sm ON sm.comonthkey = m.comonthkey
          WHERE m.cokey = c.cokey AND sm.soimoiststat = 'Wet') AS water_table_cm
      FROM component c INNER JOIN mapunit mu ON mu.mukey = c.mukey
      WHERE c.cokey = ${comp}`,
    flood: `SELECT DISTINCT m.flodfreqcl AS flood, m.pondfreqcl AS pond FROM comonth m WHERE m.cokey = ${comp}`,
    horizons: `SELECT h.hzdept_r, h.hzdepb_r, h.awc_r, h.claytotal_r, h.sandtotal_r, h.silttotal_r, h.om_r, h.ph1to1h2o_r, h.lep_r
      FROM chorizon h WHERE h.cokey = ${comp} ORDER BY h.hzdept_r`,
    interps: `SELECT ci.mrulename AS rule, ci.interphrc AS rating FROM cointerp ci
      WHERE ci.cokey = ${comp} AND ci.mrulename IN (${Object.keys(SOIL_INTERPS).map((r) => `'${r}'`).join(", ")})`,
  };
  const names = Object.keys(questions);
  const results = await Promise.allSettled(names.map((name) => sdaRows(questions[name])));
  if (results.every((r) => r.status === "rejected")) throw results[0].reason;
  const answers = Object.fromEntries(names.map((name, i) => [name, results[i].status === "fulfilled" ? results[i].value : []]));
  return summarizeSoilDetails({
    main: answers.main[0] || null,
    flood: answers.flood.length ? answers.flood : null,
    horizons: summarizeHorizons(answers.horizons),
    interps: answers.interps.length ? answers.interps : null,
  });
}

async function lookupRain(lat, lon) {
  const lastYear = new Date().getFullYear() - 1; // the last complete year
  const firstYear = lastYear - 9;
  const params = new URLSearchParams({
    latitude: lat, longitude: lon, start_date: `${firstYear}-01-01`, end_date: `${lastYear}-12-31`,
    daily: "precipitation_sum", precipitation_unit: "inch", timezone: "America/Chicago",
  });
  const data = await getJSON(`https://archive-api.open-meteo.com/v1/archive?${params}`, {}, 60000);
  const days = data.daily.precipitation_sum.filter((v) => v != null);
  return Math.round(days.reduce((a, b) => a + b, 0) / 10 * 10) / 10;
}

/* ---- climate and solar, from ten years of daily weather ---- */

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Day of the year (1 to 365) for a date like "2021-03-14".
function dayOfYear(dateText) {
  const [y, m, d] = dateText.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 86400000);
}

// The reverse: 73 becomes "Mar 14". Uses a year with no leap day, so it can be off by a day in leap years.
function dayOfYearText(doy) {
  const date = new Date(Date.UTC(2021, 0, Math.round(doy)));
  return `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

const average = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const celsiusToF = (c) => c * 9 / 5 + 32;

// `daily` is Open-Meteo's reply: lists with one value per day, in these units:
// temperatures in degrees C, snowfall in cm, sunlight energy in MJ per square meter.
// Returns { climate, solar }, or throws if there is not enough data.
function summarizeClimate(daily) {
  const days = daily.time.map((date, i) => ({
    year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)) - 1, doy: dayOfYear(date),
    min: daily.temperature_2m_min[i], max: daily.temperature_2m_max[i],
    snow: daily.snowfall_sum[i], sun: daily.shortwave_radiation_sum[i],
  }));
  const years = [...new Set(days.map((d) => d.year))];
  if (days.filter((d) => d.min != null && d.max != null).length < 300) throw new Error("Not enough weather data");

  // Freezing means a low of 0 C (32 F) or below. In each year: the last freeze before July and the first freeze from July on.
  const lastSpring = [], firstFall = [], seasonLengths = [];
  let freezeYears = 0;
  for (const year of years) {
    const freezes = days.filter((d) => d.year === year && d.min != null && d.min <= 0);
    const spring = freezes.filter((d) => d.month < 6).map((d) => d.doy);
    const fall = freezes.filter((d) => d.month >= 6).map((d) => d.doy);
    if (freezes.length) freezeYears += 1;
    if (spring.length) lastSpring.push(Math.max(...spring));
    if (fall.length) firstFall.push(Math.min(...fall));
    // Growing season: from the last spring freeze to the first fall freeze. With no freeze at all, the whole year.
    seasonLengths.push((fall.length ? Math.min(...fall) : 365) - (spring.length ? Math.max(...spring) : 0));
  }
  const perYear = (test) => round1(days.filter(test).length / years.length);
  const monthAverage = (month, key) => average(days.filter((d) => d.month === month && d[key] != null).map((d) => d[key]));

  const climate = {
    years: years.length,
    freezeYears,
    lastSpringFreeze: lastSpring.length ? dayOfYearText(average(lastSpring)) : null,
    firstFallFreeze: firstFall.length ? dayOfYearText(average(firstFall)) : null,
    frostFreeDays: Math.round(average(seasonLengths)),
    freezingDaysPerYear: perYear((d) => d.min != null && d.min <= 0),
    daysOver90F: perYear((d) => d.max != null && celsiusToF(d.max) >= 90),
    daysOver100F: perYear((d) => d.max != null && celsiusToF(d.max) >= 100),
    snowInchesPerYear: round1(days.reduce((sum, d) => sum + (d.snow || 0), 0) / years.length / 2.54),
    januaryLowF: round1(celsiusToF(monthAverage(0, "min"))),
    julyHighF: round1(celsiusToF(monthAverage(6, "max"))),
  };

  // Sunlight: 1 kWh = 3.6 MJ. kWh per square meter per day is also the number of "full sun hours" in a day.
  const monthSun = MONTH_NAMES.map((name, month) => ({ name, value: monthAverage(month, "sun") })).filter((m) => m.value != null)
    .map((m) => ({ name: m.name, value: m.value / 3.6 }));
  if (monthSun.length === 0) return { climate, solar: null };
  const annual = average(days.filter((d) => d.sun != null).map((d) => d.sun / 3.6));
  const best = monthSun.reduce((a, b) => (b.value > a.value ? b : a));
  const worst = monthSun.reduce((a, b) => (b.value < a.value ? b : a));
  const solar = {
    sunHoursPerDay: round1(annual),
    bestMonth: { name: best.name, value: round1(best.value) },
    worstMonth: { name: worst.name, value: round1(worst.value) },
    // A rough rule: each kW of panels yields about 80% of (sun hours x 365) after losses.
    kwhPerKwYear: Math.round(annual * 365 * 0.8),
  };
  return { climate, solar };
}

async function lookupClimate(lat, lon) {
  const lastYear = new Date().getFullYear() - 1;
  const firstYear = lastYear - 9;
  const params = new URLSearchParams({
    latitude: lat, longitude: lon, start_date: `${firstYear}-01-01`, end_date: `${lastYear}-12-31`,
    daily: "temperature_2m_min,temperature_2m_max,snowfall_sum,shortwave_radiation_sum", timezone: "auto",
  });
  const data = await getJSON(`https://archive-api.open-meteo.com/v1/archive?${params}`, {}, 60000);
  if (!data.daily) throw new Error("Weather service returned no data");
  return summarizeClimate(data.daily);
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const rad = (deg) => deg * Math.PI / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(a));
}

// The airports to measure against: the national list, or only your own if you chose that.
function activeAirports(s) {
  return s.airportMode === "custom" && s.airports.length ? s.airports : AIRPORT_PRESETS;
}

// `airports` is a list like [{ name, lat, lon }]. Returns the closest one.
function nearestAirport(lat, lon, airports) {
  let best = null;
  for (const airport of airports) {
    const miles = haversineMiles(lat, lon, airport.lat, airport.lon);
    if (!best || miles < best.airportMiles) best = { nearestAirport: airport.name, airportMiles: Math.round(miles * 10) / 10 };
  }
  return best;
}

// Turns the text box ("Name, latitude, longitude" on each line) into a list of airports.
// Returns { airports } or { error } so the dialog can show a message.
function parseAirports(text) {
  const airports = [];
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const parts = line.split(",").map((part) => part.trim());
    if (parts.length < 3) return { error: `"${line}" needs a name, a latitude and a longitude, separated by commas.` };
    const lon = Number(parts.pop());   // the last two pieces are the numbers
    const lat = Number(parts.pop());
    const name = parts.join(", ");     // anything left over is the name (names may contain commas)
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return { error: `"${line}" does not have a valid name and coordinates.` };
    }
    airports.push({ name, lat, lon });
  }
  if (airports.length === 0) return { error: "Enter at least one airport." };
  return { airports };
}

function formatAirports(airports) {
  return airports.map((a) => `${a.name}, ${a.lat}, ${a.lon}`).join("\n");
}

// FCC Form 477 technology codes, grouped into names people recognize.
function techName(code) {
  const n = Number(code);
  if (n >= 10 && n <= 13) return "DSL";
  if (n === 20) return "Copper";
  if (n >= 40 && n <= 43) return "Cable";
  if (n === 50) return "Fiber";
  if (n === 60) return "Satellite";
  if (n === 70 || n === 71) return "Fixed wireless";
  return "Other";
}

// Turns the FCC's rows (one per provider and technology) into a short summary.
function summarizeInternet(rows, blockCode) {
  const providers = [];
  for (const row of rows) {
    if (String(row.consumer) !== "1") continue;   // skip business-only service
    const down = Number(row.maxaddown), up = Number(row.maxadup);
    providers.push({ name: row.providername, tech: techName(row.techcode), down, up });
  }
  providers.sort((a, b) => b.down - a.down);
  const wired = providers.filter((p) => p.tech !== "Satellite");
  const technologies = [...new Set(providers.map((p) => p.tech))];
  return {
    bestMbps: wired.length ? Math.max(...wired.map((p) => p.down)) : null, // best non-satellite download
    technologies,
    providers,
    blockCode,
    vintage: "June 2021",
  };
}

// Step 1: which census block is the point in? (FCC Area API; the 2021 data uses 2010 block codes.)
// Step 2: which providers reported service in that block? (FCC open data, no key needed.)
async function lookupInternet(lat, lon) {
  const block = await getJSON(`https://geo.fcc.gov/api/census/block/find?latitude=${lat}&longitude=${lon}&censusYear=2010&format=json`);
  const blockCode = block.Block && block.Block.FIPS;
  if (!blockCode) throw new Error("No census block found");
  const rows = await getJSON(`https://opendata.fcc.gov/resource/jdr4-3q4p.json?blockcode=${blockCode}&$limit=200`);
  return summarizeInternet(rows, blockCode);
}

// Nearby places, from OpenStreetMap through the free Overpass API (no key needed).
// Each kind has `overpass` (tag filters sent to the service) and `test` (the same rule
// in JavaScript, so we can tell which kind each returned place belongs to).
// A shop whose name contains "feed" only counts as a feed store if it is a farm-type shop.
// Without this rule, "Feed Me Bakery" would match.
const FARM_SHOP_TYPES = ["agrarian", "farm", "garden_centre", "hardware", "doityourself", "general", "country_store", "trade", "pet"];

// Schools in OpenStreetMap are all tagged amenity=school. To tell elementary, middle and high schools
// apart we use, in order: the grades (like "K-5"), the ISCED level tag, then words in the name.
// A school with none of these is not guessed at, so it matches no level.
// Grades turn into numbers: pre-K and kindergarten are 0.
function gradeNumber(text) {
  const t = text.trim().toUpperCase();
  return t === "PK" || t === "K" ? 0 : Number(t);
}

function schoolLevels(tags) {
  const levels = new Set();
  // Matches "K-5", "6-8", "9-12", "PK-8" (optionally with an en dash). The two groups are the first and last grade.
  const range = String(tags.grades || "").match(/^\s*(PK|K|\d{1,2})\s*[-\u2013]\s*(PK|K|\d{1,2})\s*$/i);
  if (range) {
    const from = gradeNumber(range[1]);
    const to = gradeNumber(range[2]);
    if (from <= 5) levels.add("elementary");                 // grades K-5 overlap the school's range
    if (from <= 8 && to >= 6) levels.add("middle");
    if (from <= 12 && to >= 9) levels.add("high");
    return levels;
  }
  const isced = String(tags["isced:level"] || "").split(/[;,]/).map((x) => x.trim());   // "1;2" means two levels
  if (isced.includes("1")) levels.add("elementary");
  if (isced.includes("2")) levels.add("middle");
  if (isced.includes("3")) levels.add("high");
  if (levels.size) return levels;
  const name = String(tags.name || "");
  if (/elementary|primary/i.test(name)) levels.add("elementary");
  if (/middle|junior high|jr\.? high|intermediate/i.test(name)) levels.add("middle");   // checked before "high": "Junior High School" is not a high school
  else if (/\bhigh school\b|\bsenior high\b|\bhigh$/i.test(name)) levels.add("high");
  return levels;
}

const isSchool = (tags, level) => tags.amenity === "school" && schoolLevels(tags).has(level);

const PLACE_KINDS = [
  { key: "grocery", label: "Grocery store",
    overpass: ['["shop"="supermarket"]'],
    test: (tags) => tags.shop === "supermarket" },
  { key: "hardware", label: "Hardware store",
    overpass: ['["shop"~"^(hardware|doityourself)$"]'],
    test: (tags) => tags.shop === "hardware" || tags.shop === "doityourself" },
  { key: "costco", label: "Costco",
    overpass: ['["brand"="Costco"]', '["name"="Costco"]', '["name"="Costco Wholesale"]'],   // exact names are fast; a name pattern is not
    test: (tags) => tags.brand === "Costco" || /^costco/i.test(tags.name || "") },
  { key: "feed", label: "Feed store",
    // Exact tags only: asking the server to search every shop name for "feed" takes too long and fails the whole lookup.
    // Hardware stores are fetched anyway (see above), and the test below still spots a feed store among them by name.
    overpass: ['["shop"="agrarian"]', '["shop"~"^(farm|country_store)$"]', '["name"="Tractor Supply Co."]', '["name"="Tractor Supply"]', '["brand"="Tractor Supply Company"]'],
    test: (tags) => tags.shop === "agrarian"
      || (FARM_SHOP_TYPES.includes(tags.shop) && /feed|tractor supply/i.test(tags.name || "")) },
  { key: "vet", label: "Veterinarian",
    overpass: ['["amenity"="veterinary"]'],
    test: (tags) => tags.amenity === "veterinary" },
  { key: "elementary", label: "Elementary school",
    overpass: ['["amenity"="school"]'],
    test: (tags) => isSchool(tags, "elementary") },
  { key: "middle", label: "Middle school",
    overpass: ['["amenity"="school"]'],
    test: (tags) => isSchool(tags, "middle") },
  { key: "high", label: "High school",
    overpass: ['["amenity"="school"]'],
    test: (tags) => isSchool(tags, "high") },
  { key: "fire", label: "Fire station",
    overpass: ['["amenity"="fire_station"]'],
    test: (tags) => tags.amenity === "fire_station" },
  { key: "police", label: "Police or sheriff",
    overpass: ['["amenity"="police"]'],
    test: (tags) => tags.amenity === "police" },
  // OpenStreetMap marks a hospital's emergency department with emergency=yes, but many hospitals
  // leave it out. So we keep every hospital except those marked emergency=no.
  { key: "hospital", label: "Hospital (emergency)",
    overpass: ['["amenity"="hospital"]["emergency"!="no"]'],
    test: (tags) => tags.amenity === "hospital" && tags.emergency !== "no" },
];

// The detail window shows the kinds in these groups. `kinds` lists keys from PLACE_KINDS.
const PLACE_GROUPS = [
  { key: "everyday", label: "Shops and services", kinds: ["grocery", "hardware", "costco", "feed", "vet"] },
  { key: "schools", label: "Schools", kinds: ["elementary", "middle", "high"] },
  { key: "emergency", label: "Emergency services", kinds: ["fire", "police", "hospital"] },
];

// Search close to the parcel first. Only kinds that were not found are searched again wider.
const PLACE_SEARCH_RADII_M = [12000, 25000, 80000, 120000];   // small first, so towns and cities do not return huge lists
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.openstreetmap.fr/api/interpreter",   // backup servers, used in order if the one before fails
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
let overpassPreferred = 0;   // the server that answered last time; the next request tries it first

function buildPlacesQuery(lat, lon, radiusM, kinds) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("Bad coordinates");
  // "nwr" means nodes, ways and relations. "out center" gives ways a single point.
  // `new Set` drops repeats: the three school kinds share one filter, which only needs to be asked once.
  const statements = [...new Set(kinds.flatMap((kind) =>
    kind.overpass.map((filter) => `nwr(around:${radiusM},${lat},${lon})${filter};`)))];
  return `[out:json][timeout:25];(${statements.join("")});out center tags;`;
}

// The free Overpass servers allow only a couple of requests at a time and answer extra ones with "busy" or with nothing
// at all. Roads and nearby places both use Overpass, so their requests wait in this line and go one at a time.
let overpassLine = Promise.resolve();
function overpassQuery(query) {
  const turn = overpassLine.then(() => overpassRequest(query));
  overpassLine = turn.catch(() => {});   // a failed request must not block the ones waiting behind it
  return turn;
}

// One request, trying each server in turn, starting with the one that worked last time. If all of them fail,
// the message says why each one did.
async function overpassRequest(query) {
  const failures = [];
  for (let i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
    const index = (overpassPreferred + i) % OVERPASS_ENDPOINTS.length;
    const endpoint = OVERPASS_ENDPOINTS[index];
    try {
      const data = await getJSON(endpoint, { method: "POST", body: new URLSearchParams({ data: query }) }, 30000);
      overpassPreferred = index;
      return data.elements || [];
    } catch (error) {
      failures.push(`${endpoint.split("/")[2]}: ${error.message}`);   // the host name, then why it failed
    }
  }
  throw new Error(`The free map servers are busy or slow (${failures.join("; ")})`);
}

// The closest returned place of one kind, or null.
function nearestMatch(elements, kind, lat, lon) {
  let best = null;
  for (const element of elements) {
    const point = element.type === "node" ? element : element.center;   // ways have a center
    if (!point || !element.tags || !kind.test(element.tags)) continue;
    const miles = haversineMiles(lat, lon, point.lat, point.lon);
    if (!best || miles < best.miles) {
      best = { name: element.tags.name || `${kind.label} (unnamed)`, miles: Math.round(miles * 10) / 10, lat: point.lat, lon: point.lon };
    }
  }
  return best;
}

// Returns { grocery: {...} or null, hardware: ..., and so on for every kind in PLACE_KINDS }.
async function lookupPlaces(lat, lon) {
  const found = {};
  let remaining = PLACE_KINDS;
  for (const radius of PLACE_SEARCH_RADII_M) {
    if (remaining.length === 0) break;
    const elements = await overpassQuery(buildPlacesQuery(lat, lon, radius, remaining));
    for (const kind of remaining) {
      const best = nearestMatch(elements, kind, lat, lon);
      if (best) found[kind.key] = best;
    }
    remaining = remaining.filter((kind) => !found[kind.key]);
  }
  for (const kind of remaining) found[kind.key] = null;   // nothing within the widest search
  return found;
}

// Real driving distance and time between two points, from the free public OSRM demo server.
// It is meant for light use (a handful of requests per parcel), which is all we do.
async function routeInfo(fromLat, fromLon, toLat, toLon) {
  const url = `https://router.project-osrm.org/route/v1/driving/${fromLon},${fromLat};${toLon},${toLat}?overview=false`;
  const data = await getJSON(url, {}, 20000);
  if (data.code !== "Ok" || !data.routes || data.routes.length === 0) return null;   // no road route found
  const route = data.routes[0];
  return { miles: Math.round(route.distance / 1609.344 * 10) / 10, minutes: Math.round(route.duration / 60) };
}

// Adds routed drive times to the nearest airport and to each nearby place that was found.
// A route that fails is skipped, so that item keeps its straight-line estimate.
// Only if every route fails do we report a problem.
async function addRoutes(parcel, airports) {
  const jobs = [];   // each job is [where to store the result, destination lat, destination lon]
  const airport = airports.find((a) => a.name === parcel.site.nearestAirport);
  if (airport) jobs.push([(r) => { parcel.site.airportDriveMin = r.minutes; parcel.site.airportRoadMiles = r.miles; }, airport.lat, airport.lon]);
  // The same school can be the nearest elementary and middle school, so ask for each spot's route only once.
  const byLocation = new Map();   // "lat,lon" -> the places at that spot
  for (const place of Object.values(parcel.site.places || {})) {
    if (!place) continue;
    const key = `${place.lat},${place.lon}`;
    if (!byLocation.has(key)) byLocation.set(key, []);
    byLocation.get(key).push(place);
  }
  for (const group of byLocation.values()) {
    jobs.push([(r) => { for (const place of group) { place.driveMin = r.minutes; place.roadMiles = r.miles; } }, group[0].lat, group[0].lon]);
  }
  if (jobs.length === 0) return;
  const results = await Promise.all(jobs.map(([, lat, lon]) =>
    routeInfo(parcel.lat, parcel.lon, lat, lon).catch(() => null)));
  let worked = 0;
  results.forEach((result, i) => { if (result) { jobs[i][0](result); worked += 1; } });
  if (worked === 0) throw new Error("routing service did not answer, so drive times are estimates");
}

// Natural hazards, from FEMA's National Risk Index (NRI). The NRI rates every census tract in the
// country for 18 hazards. Each hazard has a field named like WFIR_RISKR ("Wildfire - Hazard Type
// Risk Index Rating"). The first four letters are FEMA's code for the hazard.
const NRI_URL = "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/National_Risk_Index_Census_Tracts/FeatureServer/0/query";
const HAZARDS = [
  ["AVLN", "Avalanche"], ["CFLD", "Coastal flooding"], ["CWAV", "Cold wave"], ["DRGT", "Drought"],
  ["ERQK", "Earthquake"], ["HAIL", "Hail"], ["HWAV", "Heat wave"], ["HRCN", "Hurricane"],
  ["ISTM", "Ice storm"], ["IFLD", "Inland flooding"], ["LNDS", "Landslide"], ["LTNG", "Lightning"],
  ["SWND", "Strong wind"], ["TRND", "Tornado"], ["TSUN", "Tsunami"], ["VLCN", "Volcanic activity"],
  ["WFIR", "Wildfire"], ["WNTW", "Winter weather"],
];
// FEMA's five ratings from lowest to highest. Anything else ("Not Applicable", "Insufficient Data") means no rating.
const HAZARD_LEVELS = ["Very Low", "Relatively Low", "Relatively Moderate", "Relatively High", "Very High"];

// Turns the FEMA reply into { overall, overallLevel, hazards: [{ name, rating, level }], unrated }.
// `hazards` lists only rated hazards, highest risk first. `unrated` counts hazards that do not apply here.
// Returns null when the point is not inside any rated tract.
function parseHazards(data) {
  if (!data.features || data.features.length === 0) return null;
  const a = data.features[0].attributes;
  const hazards = [];
  let unrated = 0;
  for (const [code, name] of HAZARDS) {
    const level = HAZARD_LEVELS.indexOf(a[`${code}_RISKR`]);
    if (level === -1) { unrated += 1; continue; }
    hazards.push({ name, rating: HAZARD_LEVELS[level], level });
  }
  hazards.sort((x, y) => y.level - x.level || x.name.localeCompare(y.name));
  return {
    overall: a.RISK_RATNG || "No rating",
    overallLevel: HAZARD_LEVELS.indexOf(a.RISK_RATNG),   // -1 when there is no usable rating
    hazards,
    unrated,
  };
}

async function lookupHazards(lat, lon) {
  const params = new URLSearchParams({
    geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",          // every field, so one misspelled field name cannot make the whole request fail
    returnGeometry: "false", f: "json",
  });
  const data = await getJSON(`${NRI_URL}?${params}`, {}, 30000);
  if (data.error) throw new Error("FEMA risk service error");
  return parseHazards(data);
}

// USDA plant hardiness zone (2023 map), looked up by ZIP code.
// Step 1: which ZIP code area is the point in? (The Census geocoder, asked for all of its layers.)
// Step 2: the zone for that ZIP, from phzmapi.org, a free service that publishes the 2023 USDA map's
// zones as one small file per ZIP. It is run by a volunteer, not by the USDA.
function parseZip(data) {
  const geographies = (data.result && data.result.geographies) || {};
  const layerName = Object.keys(geographies).find((name) => /ZIP Code Tabulation/i.test(name));
  const areas = layerName ? geographies[layerName] : [];
  if (!areas.length) return null;
  // The five-digit code can sit in a few different fields; take the first one that has five digits in a row.
  for (const field of [areas[0].ZCTA5, areas[0].GEOID, areas[0].BASENAME, areas[0].NAME]) {
    const match = String(field || "").match(/\d{5}/);
    if (match) return match[0];
  }
  return null;
}

// Turns { zone: "8a", temperature_range: "10 to 15" } into { zone, tempRange, zip, vintage }.
function parseHardiness(data, zip) {
  const zone = String(data.zone || "").toLowerCase();
  if (!/^\d{1,2}[ab]$/.test(zone)) throw new Error("Unexpected hardiness zone reply");   // like 8a or 10b
  return { zone, tempRange: data.temperature_range || null, zip, vintage: "2023" };
}

async function fetchHardiness(zip) {
  return parseHardiness(await getJSON(`https://phzmapi.org/${zip}.json`), zip);
}

async function lookupHardiness(lat, lon) {
  const data = await jsonp(`${CENSUS}/geographies/coordinates?x=${lon}&y=${lat}&benchmark=Public_AR_Current&vintage=Current_Current&layers=all`);
  const zip = parseZip(data);
  if (!zip) throw new Error("No ZIP code found for this spot");
  return fetchHardiness(zip);
}

/* ---- county property tax rate, from the Census Bureau's American Community Survey ---- */

// The newest 5-year survey release we know is published. Raise it when a newer one comes out.
const ACS_YEAR = 2023;

// Turns the Census reply (a list of rows; the first row holds the column names) into a tax rate.
// "Median real estate taxes paid" divided by "median home value" is the typical share of a home's value paid in tax each year.
function parseTaxRate(data, year) {
  if (!Array.isArray(data) || data.length < 2) return null;
  const row = Object.fromEntries(data[0].map((name, i) => [name, data[1][i]]));
  const tax = Number(row.B25103_001E);
  const value = Number(row.B25077_001E);
  if (!(tax > 0) || !(value > 0)) return null;     // the Census uses large negative numbers to mean "not available"
  return { ratePct: Math.round(tax / value * 10000) / 100, medianTax: tax, medianValue: value, year, name: row.NAME };
}

// Without a key the Census may refuse the request; that is reported as { needsKey: true } and is not an error.
async function lookupTaxRate(stateFips, countyFips, key) {
  if (!stateFips || !countyFips) return null;
  const params = new URLSearchParams({ get: "NAME,B25103_001E,B25077_001E", for: `county:${countyFips}`, in: `state:${stateFips}` });
  if (key) params.set("key", key);
  let data;
  try {
    data = await getJSON(`https://api.census.gov/data/${ACS_YEAR}/acs/acs5?${params}`, {}, 30000);
  } catch (error) {
    if (error.notJson || /^HTTP 4/.test(error.message)) return { needsKey: true, keyRejected: Boolean(key) };
    throw error;
  }
  return parseTaxRate(data, ACS_YEAR);
}

/* ---- ArcGIS map services (used for wetlands and public land) ---- */

// Many government maps are served by ArcGIS, which answers a question like "what is at this point or within this distance?".
// Returns the list of matching features, each with an `attributes` object. An ArcGIS error comes back as a normal reply with an `error` field.
async function arcgisFeatures(url, params, label) {
  const query = new URLSearchParams({ spatialRel: "esriSpatialRelIntersects", inSR: "4326", returnGeometry: "false", f: "json", ...params });
  const data = await getJSON(`${url}?${query}`, {}, 40000);
  if (data.error) throw new Error(`${label} service error`);
  return { features: data.features || [], more: Boolean(data.exceededTransferLimit) };
}

// This service joins two tables, so fields can arrive as "Wetlands.WETLAND_TYPE" instead of "WETLAND_TYPE".
// Looking for the name's ending makes the code work either way.
function attr(attributes, name) {
  const key = Object.keys(attributes).find((k) => k === name || k.endsWith("." + name));
  return key === undefined ? null : attributes[key];
}

/* ---- wetlands, from the US Fish and Wildlife Service National Wetlands Inventory ---- */

const NWI_URL = "https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0/query";
const WETLAND_NEAR_METERS = 400;   // about a quarter mile

// `atPoint` and `nearby` are lists of features. Returns what is under the point and what is within about a quarter mile.
function summarizeWetlands(atPoint, nearby, nearbyMore) {
  const typesOf = (features) => [...new Set(features.map((f) => attr(f.attributes, "WETLAND_TYPE")).filter(Boolean))];
  return {
    onWetland: atPoint.length > 0,
    onTypes: typesOf(atPoint),
    nearbyCount: nearby.length,
    nearbyMore: Boolean(nearbyMore),    // true when there were more than we asked for
    nearbyTypes: typesOf(nearby),
    nearbyMeters: WETLAND_NEAR_METERS,
  };
}

async function lookupWetlands(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("Bad coordinates");
  const base = { geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", outFields: "*" };
  const [here, near] = await Promise.all([
    arcgisFeatures(NWI_URL, { ...base, resultRecordCount: "10" }, "Wetlands"),
    arcgisFeatures(NWI_URL, { ...base, distance: String(WETLAND_NEAR_METERS), units: "esriSRUnit_Meter", resultRecordCount: "100" }, "Wetlands"),
  ]);
  return summarizeWetlands(here.features, near.features, near.more);
}

/* ---- USDA loan area, from USDA Rural Development's eligibility map ---- */

// This layer holds the INELIGIBLE areas (towns and cities too built-up for USDA home loans), so a point
// inside none of them is in an eligible area.
const USDA_URL = "https://rdgdwe.sc.egov.usda.gov/arcgis/rest/services/Eligibility/Eligibility/MapServer/4/query";

function summarizeUsda(features) {
  return { eligibleArea: features.length === 0 };
}

async function lookupUsda(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("Bad coordinates");
  const found = await arcgisFeatures(USDA_URL, { geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", outFields: "OBJECTID", resultRecordCount: "1" }, "USDA map");
  return summarizeUsda(found.features);
}

/* ---- public and protected land, from the USGS Protected Areas Database (PAD-US) ---- */

const PADUS_URL = "https://services.arcgis.com/v01gqwM5QqNysAAi/ArcGIS/rest/services/Public_Access/FeatureServer/0/query";
// Search the spot itself first, then circles of these sizes (in miles), stopping at the first one that finds land.
const PUBLIC_LAND_RADII_MILES = [0, 3, 10, 25];
// Short manager codes used by PAD-US, spelled out. A code not listed here is shown as it comes.
const MANAGER_NAMES = {
  NPS: "National Park Service", USFS: "US Forest Service", BLM: "Bureau of Land Management", FWS: "US Fish and Wildlife Service",
  USACE: "Army Corps of Engineers", BOR: "Bureau of Reclamation", DOD: "Department of Defense", TVA: "Tennessee Valley Authority",
  NRCS: "Natural Resources Conservation Service", SPR: "State parks and recreation", SDNR: "State natural resources",
  SFW: "State fish and wildlife", SLB: "State land board", SDOL: "State department of lands", LOC: "Local government",
  NGO: "Non-profit organization", PVT: "Private", TRIB: "Tribal", JNT: "Joint management",
};
const ACCESS_NAMES = { OA: "Open", RA: "Restricted", XA: "Closed", UK: "Unknown" };

// Turns a list of PAD-US features into up to five distinct areas: { name, manager, type, access, acres }.
function summarizePublicLand(features) {
  const seen = new Set();
  const areas = [];
  for (const f of features) {
    const manager = attr(f.attributes, "Mang_Name");
    const area = {
      name: attr(f.attributes, "Unit_Nm") || "(unnamed area)",
      manager: MANAGER_NAMES[manager] || manager || "unknown manager",
      type: attr(f.attributes, "Des_Tp") || null,
      access: ACCESS_NAMES[attr(f.attributes, "Pub_Access")] || attr(f.attributes, "Pub_Access") || "unknown",
      acres: Math.round(Number(attr(f.attributes, "DOCACRES")) || 0) || null,
    };
    const key = `${area.name}|${area.manager}`;
    if (seen.has(key)) continue;       // one big area can show up in pieces
    seen.add(key);
    areas.push(area);
  }
  return areas.slice(0, 5);
}

// Returns { withinMiles, areas }: withinMiles is 0 when the point itself is on protected land, or null if none was found within 25 miles.
async function lookupPublicLand(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("Bad coordinates");
  for (const miles of PUBLIC_LAND_RADII_MILES) {
    const params = { geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", outFields: "Unit_Nm,Mang_Name,Des_Tp,Pub_Access,GAP_Sts,DOCACRES", resultRecordCount: "40" };
    if (miles > 0) Object.assign(params, { distance: String(miles), units: "esriSRUnit_StatuteMile" });
    const { features } = await arcgisFeatures(PADUS_URL, params, "Protected lands");
    if (features.length) return { withinMiles: miles, areas: summarizePublicLand(features) };
  }
  return { withinMiles: null, areas: [] };
}

/* ---- road access, from OpenStreetMap ---- */

// Road types a vehicle can use. Footpaths, bike paths and steps are left out.
const DRIVABLE_ROADS = ["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "service", "track",
  "living_street", "road", "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"];
const PAVED_SURFACES = ["asphalt", "paved", "concrete", "concrete:plates", "concrete:lanes", "paving_stones", "sett", "chipseal"];
// Road types that are almost always paved when nobody has recorded the surface.
const USUALLY_PAVED = ["motorway", "trunk", "primary", "secondary", "tertiary", "residential", "living_street",
  "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link"];
const ROAD_SEARCH_RADII_M = [600, 3000, 10000];

// "paved", "unpaved" or "unknown", from the road's surface tag and type.
function roadSurface(tags) {
  if (tags.surface) return PAVED_SURFACES.includes(tags.surface) ? "paved" : "unpaved";
  return USUALLY_PAVED.includes(tags.highway) ? "paved" : "unknown";
}

// Roads marked private (or closed to the public) are not access you can count on.
// "service" roads are mostly driveways and parking aisles, so they count only when marked public.
function isPublicRoad(tags) {
  if (["private", "no", "customers", "permit", "delivery"].includes(tags.access)) return false;
  if (tags.highway === "service") return ["yes", "permissive", "public"].includes(tags.access);
  return true;
}

// Shortest distance, in feet, from a point to a road drawn as a list of points ({ lat, lon }).
// We flatten the map around the point (meters east and north) and measure to each straight piece.
function distanceToRoadFeet(lat, lon, geometry) {
  const metersPerDegree = 111320;
  const x = (point) => (point.lon - lon) * Math.cos(lat * Math.PI / 180) * metersPerDegree;
  const y = (point) => (point.lat - lat) * metersPerDegree;
  let best = Infinity;
  for (let i = 0; i < geometry.length; i++) {
    const [ax, ay] = [x(geometry[i]), y(geometry[i])];
    const [bx, by] = i + 1 < geometry.length ? [x(geometry[i + 1]), y(geometry[i + 1])] : [ax, ay];
    const [dx, dy] = [bx - ax, by - ay];
    const lengthSquared = dx * dx + dy * dy;
    // How far along the piece the closest spot is, from 0 (start) to 1 (end). The origin is the parcel.
    const along = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
    best = Math.min(best, Math.hypot(ax + along * dx, ay + along * dy));
  }
  return Math.round(best * 3.28084);
}

function roadsQuery(lat, lon, radiusM) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("Bad coordinates");
  // "out geom(box)" gives each road's points, trimmed to a box a little bigger than the search circle.
  const dLat = radiusM / 111320 * 1.2;
  const dLon = dLat / Math.cos(lat * Math.PI / 180);
  const box = [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map((v) => v.toFixed(5)).join(",");
  return `[out:json][timeout:25];way(around:${radiusM},${lat},${lon})["highway"~"^(${DRIVABLE_ROADS.join("|")})$"];out tags geom(${box});`;
}

// Reads the Overpass reply into { nearest, nearestPublicPaved } (each a road or null).
function summarizeRoads(elements, lat, lon) {
  const roads = elements.filter((e) => e.type === "way" && e.tags && e.geometry && e.geometry.length)
    .map((e) => ({
      name: e.tags.name || e.tags.ref || "(unnamed road)", type: e.tags.highway, surface: roadSurface(e.tags),
      access: e.tags.access || null, publicRoad: isPublicRoad(e.tags), distanceFt: distanceToRoadFeet(lat, lon, e.geometry),
    }))
    .sort((a, b) => a.distanceFt - b.distanceFt);
  return {
    nearest: roads[0] || null,
    nearestPublicPaved: roads.find((r) => r.publicRoad && r.surface === "paved") || null,
  };
}

// Searches small circles first and widens only until a public paved road turns up.
async function lookupRoads(lat, lon) {
  let result = { nearest: null, nearestPublicPaved: null };
  let searched = 0;
  for (const radius of ROAD_SEARCH_RADII_M) {
    searched = radius;
    result = summarizeRoads(await overpassQuery(roadsQuery(lat, lon, radius)), lat, lon);
    if (result.nearestPublicPaved) break;
  }
  return { ...result, searchedMeters: searched };
}

/* ---- groundwater levels, from USGS monitoring wells ---- */

// The old USGS "waterservices" groundwater service was retired. This is its replacement, the USGS Water Data API.
// Three quick steps: (1) which wells in a box around the point have a depth-to-water reading at all,
// (2) the latest reading for the nearest few, (3) their names.
const USGS_API = "https://api.waterdata.usgs.gov/ogcapi/v0/collections/";
const GROUNDWATER_BOX_DEGREES = 0.25;      // about 17 miles each way
const GROUNDWATER_CANDIDATES = 8;          // how many nearby wells to fetch readings for
const DEPTH_TO_WATER = "72019";            // USGS parameter: depth to water level, feet below land surface

// From the list of wells that have depth readings (with the date of the last one), the nearest few:
// [{ id, distanceMiles }] closest first, each well once.
function nearestWellSites(meta, lat, lon) {
  const seen = new Set();
  const sites = [];
  for (const f of (meta && meta.features) || []) {
    const id = (f.properties || {}).monitoring_location_id;
    const c = (f.geometry || {}).coordinates;
    if (!id || seen.has(id) || !Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    seen.add(id);
    sites.push({ id, distanceMiles: haversineMiles(lat, lon, c[1], c[0]) });
  }
  sites.sort((a, b) => a.distanceMiles - b.distanceMiles);
  return sites.slice(0, GROUNDWATER_CANDIDATES);
}

// Joins the sites with their latest readings and names into the wells shown on the report, nearest first, at most three:
// [{ name, siteNo, distanceMiles, depthFt, measured, yearsAgo }]. A well with no usable reading is left out.
function buildGroundwater(sites, latest, names, nowMs) {
  const readingOf = new Map();
  for (const f of (latest && latest.features) || []) {
    const p = f.properties || {};
    if (p.value === "" || p.value == null || !Number.isFinite(Number(p.value)) || !p.time) continue;
    const old = readingOf.get(p.monitoring_location_id);
    if (!old || String(p.time) > String(old.time)) readingOf.set(p.monitoring_location_id, p);   // keep the newest
  }
  const nameOf = new Map(((names && names.features) || []).map((f) => [(f.properties || {}).id, (f.properties || {}).monitoring_location_name]));
  const wells = [];
  for (const site of sites) {
    const reading = readingOf.get(site.id);
    if (!reading) continue;
    const when = Date.parse(reading.time);
    wells.push({
      name: nameOf.get(site.id) || "(unnamed well)",
      siteNo: site.id.replace(/^USGS-/, ""),
      distanceMiles: Math.round(site.distanceMiles * 10) / 10,
      depthFt: Math.round(Number(reading.value) * 10) / 10,
      measured: String(reading.time).slice(0, 10),
      yearsAgo: Number.isFinite(when) ? Math.max(0, Math.round((nowMs - when) / 3.156e10)) : null,
    });
  }
  return { wells: wells.slice(0, 3), searchedMiles: Math.round(GROUNDWATER_BOX_DEGREES * 69) };
}

async function lookupGroundwater(lat, lon) {
  const d = GROUNDWATER_BOX_DEGREES;
  const bbox = [lon - d, lat - d, lon + d, lat + d].map((v) => v.toFixed(5)).join(",");
  const meta = await getJSON(`${USGS_API}field-measurements-metadata/items?f=json&bbox=${bbox}&parameter_code=${DEPTH_TO_WATER}&limit=1000`, {}, 40000);
  const sites = nearestWellSites(meta, lat, lon);
  if (!sites.length) return buildGroundwater([], null, null, Date.now());
  const ids = encodeURIComponent(sites.map((x) => x.id).join(","));
  const [latest, names] = await Promise.all([
    getJSON(`${USGS_API}latest-field-measurements/items?f=json&parameter_code=${DEPTH_TO_WATER}&monitoring_location_id=${ids}&limit=50`, {}, 40000),
    getJSON(`${USGS_API}monitoring-locations/items?f=json&id=${ids}&limit=50`, {}, 40000).catch(() => null),   // names are a nicety; the readings matter
  ]);
  return buildGroundwater(sites, latest, names, Date.now());
}

/* =====================================================================
   4. Looking up everything for one parcel
   ===================================================================== */
const SOURCE_STEPS = [
  ["County",   async (p) => { Object.assign(p, await lookupCounty(p.lat, p.lon)); }],
  ["Flood",    async (p) => { p.site.floodZone = await lookupFlood(p.lat, p.lon); }],
  ["Terrain",  async (p) => { Object.assign(p.site, await lookupTerrain(p.lat, p.lon)); }],
  ["Soil",     async (p) => { Object.assign(p.site, (await lookupSoil(p.lat, p.lon)) || {}); }],
  ["Soil details", async (p) => { p.site.soilDetails = await lookupSoilDetails(p.lat, p.lon); }],
  ["USDA", async (p) => { p.site.usda = await lookupUsda(p.lat, p.lon); }],
  ["Public land", async (p) => { p.site.publicLand = await lookupPublicLand(p.lat, p.lon); }],
  ["Groundwater", async (p) => { p.site.groundwater = await lookupGroundwater(p.lat, p.lon); }],
  ["Wetlands", async (p) => { p.site.wetlands = await lookupWetlands(p.lat, p.lon); }],
  ["Roads",    async (p) => { p.site.roads = await lookupRoads(p.lat, p.lon); }],
  ["Climate",  async (p) => { const r = await lookupClimate(p.lat, p.lon); p.site.climate = r.climate; p.site.solar = r.solar; }],
  ["Rainfall", async (p) => { p.site.annualRainIn = await lookupRain(p.lat, p.lon); }],
  ["Airport",  async (p) => { Object.assign(p.site, nearestAirport(p.lat, p.lon, activeAirports(settings))); }],
  ["Internet", async (p) => { p.site.internet = await lookupInternet(p.lat, p.lon); }],
  ["Nearby",   async (p) => { p.site.places = await lookupPlaces(p.lat, p.lon); }],
  ["Hazards",  async (p) => { p.site.hazards = await lookupHazards(p.lat, p.lon); }],
  ["Hardiness", async (p) => { p.site.hardiness = await lookupHardiness(p.lat, p.lon); }],
];

// Runs every lookup at once. One failure never stops the others; failures are listed on the parcel.
async function lookupAll(parcel, onProgress) {
  parcel.site = {};
  const errors = [];
  await Promise.all(SOURCE_STEPS.map(async ([label, step]) => {
    onProgress(label, "running");
    try {
      await step(parcel);
      onProgress(label, "ok");
    } catch (error) {
      errors.push(`${label}: ${error.message}`);
      onProgress(label, "failed");
    }
  }));
  // Routing needs the airport and places found above, so it runs after them.
  onProgress("Routes", "running");
  try {
    await addRoutes(parcel, activeAirports(settings));
    onProgress("Routes", "ok");
  } catch (error) {
    errors.push(`Routes: ${error.message}`);
    onProgress("Routes", "failed");
  }
  // The county tax rate needs the county found above, so it also runs afterward.
  onProgress("Tax rate", "running");
  try {
    parcel.site.taxRate = await lookupTaxRate(parcel.stateFips, parcel.countyFips, settings.censusKey);
    onProgress("Tax rate", "ok");
  } catch (error) {
    errors.push(`Tax rate: ${error.message}`);
    onProgress("Tax rate", "failed");
  }
  parcel.errors = errors;
  parcel.fetchedAt = new Date().toISOString();
}
