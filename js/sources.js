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
    // The census tract (a neighborhood of a few thousand people) the spot is in, for the people and community figures.
    tractGeoid: geographies["Census Tracts"] && geographies["Census Tracts"].length ? geographies["Census Tracts"][0].GEOID : null,
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

// One FEMA flood zone record -> { zone, sfha, bfeFt }.
// SFHA_TF is "T" when FEMA counts the spot as a special flood hazard area (the 1%-a-year flood), "F" when not.
// STATIC_BFE is the base flood elevation in feet (how high that flood reaches); FEMA uses -9999 for "none given".
function parseFloodZone(attributes) {
  const { FLD_ZONE: zone, ZONE_SUBTY: subtype, SFHA_TF: sfhaFlag, STATIC_BFE: bfe } = attributes;
  const shaded = zone === "X" && String(subtype || "").toUpperCase().includes("0.2 PCT");
  const bfeFt = Number(bfe);
  return {
    zone: shaded ? "X (shaded)" : zone,
    sfha: sfhaFlag === "T" ? true : sfhaFlag === "F" ? false : null,
    bfeFt: Number.isFinite(bfeFt) && bfeFt > -9000 ? Math.round(bfeFt * 10) / 10 : null,
  };
}

// The zone plus the two extra facts, or null when FEMA has not mapped the spot.
async function lookupFloodDetails(lat, lon) {
  const params = new URLSearchParams({
    geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326",
    spatialRel: "esriSpatialRelIntersects", outFields: "FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE",
    returnGeometry: "false", f: "json",
  });
  const data = await getJSON(`https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/${FEMA_FLOOD_LAYER}/query?${params}`);
  if (data.error) throw new Error("FEMA service error");
  if (!data.features || data.features.length === 0) return null; // not mapped
  return parseFloodZone(data.features[0].attributes);
}

// Just the zone, like "AE" or "X (shaded)".
async function lookupFlood(lat, lon) {
  const details = await lookupFloodDetails(lat, lon);
  return details ? details.zone : null;
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

// Which way the ground slopes down, from the elevation 60 m north, south, east and west (in feet) and that distance in meters.
// Returns "north", "southeast" and so on, "flat" when the change is under 1% either way, or null if a point is missing.
const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
function slopeFacing(north, south, east, west, spacingM) {
  if ([north, south, east, west].some((v) => v == null || !Number.isFinite(v))) return null;
  // Rise per meter going east and going north (feet turned into meters), measured across both neighbors.
  const riseEast = (east - west) * 0.3048 / (2 * spacingM);
  const riseNorth = (north - south) * 0.3048 / (2 * spacingM);
  if (Math.hypot(riseEast, riseNorth) * 100 < 1) return "flat";
  // Downhill is the opposite way to the rise. atan2(east, north) gives a compass bearing: 0 is north, 90 is east.
  const bearing = (Math.atan2(-riseEast, -riseNorth) * 180 / Math.PI + 360) % 360;
  return COMPASS[Math.round(bearing / 45) % 8];
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
  const others = await Promise.all(neighborRequests);   // north, south, east, west
  let steepest = 0;
  for (const other of others) {
    if (other == null) continue;
    const riseM = Math.abs(other - center) * 0.3048;
    steepest = Math.max(steepest, riseM / d * 100); // slope percent = rise / run * 100
  }
  return { elevationFt: Math.round(center * 10) / 10, slopePct: Math.round(steepest * 10) / 10, slopeFacing: slopeFacing(...others, d) };
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
    silt: num(r.silttotal_r), om: num(r.om_r), ph: num(r.ph1to1h2o_r), lep: num(r.lep_r), ksat: num(r.ksat_r),
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
  // Water moves through the soil only as fast as its slowest layer allows, so keep the slowest one in the top 5 feet.
  const ksats = layers.filter((l) => l.top < limitCm && Number.isFinite(l.ksat)).map((l) => l.ksat);
  const slowest = ksats.length ? Math.min(...ksats) : NaN;
  return {
    texture: textureClass(topsoil.sand, topsoil.silt, topsoil.clay),
    clayPct: round1(topsoil.clay), sandPct: round1(topsoil.sand), siltPct: round1(topsoil.silt),
    organicMatterPct: round1(topsoil.om), ph: round1(topsoil.ph),
    waterHoldingIn: hasWater ? round1(waterCm / 2.54) : null,
    shrinkSwell: shrinkSwellClass(worstLep),
    permeability: Number.isFinite(slowest) ? { umPerSec: slowest < 1 ? Math.round(slowest * 100) / 100 : Math.round(slowest * 10) / 10, rating: permeabilityClass(slowest) } : null,
  };
}

// NRCS classes for saturated hydraulic conductivity ("Ksat"), in micrometers per second: how fast water soaks through.
// Septic drain fields need water to soak in, but not so fast that it reaches groundwater untreated.
function permeabilityClass(umPerSec) {
  if (!Number.isFinite(umPerSec)) return null;
  if (umPerSec < 0.01) return "Very low";
  if (umPerSec < 0.1) return "Low";
  if (umPerSec < 1) return "Moderately low";
  if (umPerSec < 10) return "Moderately high";
  if (umPerSec < 100) return "High";
  return "Very high";
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
    horizons: `SELECT h.hzdept_r, h.hzdepb_r, h.awc_r, h.claytotal_r, h.sandtotal_r, h.silttotal_r, h.om_r, h.ph1to1h2o_r, h.lep_r, h.ksat_r
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

// A children's doctor, not a children's dentist. The specialty tag can list several, split by ";"
// (like "paediatrics;family_medicine"); one of them must be pediatrics without "dent" or "orthodont" in it.
function isPediatrician(tags) {
  if (tags.healthcare === "dentist" || tags.amenity === "dentist") return false;
  return (tags["healthcare:speciality"] || "").split(";")
    .some((one) => /p(a)?ediatric/i.test(one) && !/dent|orthodont/i.test(one));
}

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
  // The kinds below are looked up only when a family stage you ticked in Settings needs them (`family: true`).
  // Doctors are matched by their specialty tag only. Matching office names as well would find more, but on
  // 2026-11-01 even a narrow name pattern took 24 seconds or timed out on the free servers.
  { key: "obgyn", label: "OB-GYN", family: true,
    // Midwives and birth centers have their own tags and count here too.
    overpass: ['["healthcare:speciality"~"gynaecolog|obstetric"]', '["healthcare"~"^(midwife|birthing_centre|birthing_center)$"]'],
    test: (tags) => /gynaecolog|obstetric/i.test(tags["healthcare:speciality"] || "") || /^(midwife|birthing_cent(re|er))$/.test(tags.healthcare || "") },
  { key: "pediatrician", label: "Pediatrician", family: true,
    // "p(a)?ediatric" matches both the British spelling OpenStreetMap asks for and the American one people also use.
    // Children's dentists are tagged "paediatric_dentistry", so dentists are left out here and in `test` below.
    overpass: ['["healthcare:speciality"~"p(a)?ediatric"]["healthcare"!="dentist"]["amenity"!="dentist"]'],
    test: isPediatrician },
  { key: "pharmacy", label: "Pharmacy", family: true,
    overpass: ['["amenity"="pharmacy"]'],
    test: (tags) => tags.amenity === "pharmacy" },
  { key: "childcare", label: "Child care", family: true,
    overpass: ['["amenity"="childcare"]'],
    test: (tags) => tags.amenity === "childcare" },
  // In the United States, OpenStreetMap tags preschools and pre-K programs as "kindergarten".
  { key: "preschool", label: "Preschool or pre-K", family: true,
    overpass: ['["amenity"="kindergarten"]'],
    test: (tags) => tags.amenity === "kindergarten" },
  { key: "library", label: "Library", family: true,
    overpass: ['["amenity"="library"]'],
    test: (tags) => tags.amenity === "library" },
  { key: "playground", label: "Playground", family: true,
    overpass: ['["leisure"="playground"]'],
    test: (tags) => tags.leisure === "playground" },
];

// The kinds of places a parcel's lookup needs: the everyday ones always, and family ones for the stages you ticked.
function neededPlaceKinds(s) {
  const wanted = new Set();
  for (const [stage, info] of Object.entries(FAMILY_STAGES)) if (s && s.family && s.family[stage]) for (const key of info.places) wanted.add(key);
  return PLACE_KINDS.filter((kind) => !kind.family || wanted.has(kind.key));
}

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

// A server that says it is busy (or rate-limits us) rests for 5 minutes, and one that fails another way rests for 2,
// so the next request goes straight to a server that may work instead of waiting on one that just failed.
const OVERPASS_REST_MS = { busy: 5 * 60 * 1000, failed: 2 * 60 * 1000 };
const overpassRestingUntil = {};   // server address -> time (in ms since 1970) it may be tried again

// Which server worked last and which are resting are kept in the browser too, so reloading the page does not
// mean waiting on a server that just failed. Storage can be blocked (or missing in the tests), so every use is guarded.
try {
  const saved = JSON.parse(localStorage.getItem(OVERPASS_MEMORY_KEY) || "null");
  if (saved && Number.isInteger(saved.preferred) && saved.preferred >= 0 && saved.preferred < OVERPASS_ENDPOINTS.length) overpassPreferred = saved.preferred;
  for (const [endpoint, until] of Object.entries((saved && saved.restingUntil) || {})) {
    if (OVERPASS_ENDPOINTS.includes(endpoint) && until > Date.now()) overpassRestingUntil[endpoint] = until;
  }
} catch { /* nothing saved, or storage is blocked: start fresh */ }
function rememberOverpass() {
  try { localStorage.setItem(OVERPASS_MEMORY_KEY, JSON.stringify({ preferred: overpassPreferred, restingUntil: overpassRestingUntil })); } catch { /* storage is blocked */ }
}

// HTTP 429 means "too many requests"; 502, 503 and 504 are what these servers send when every worker is busy.
const isBusyReply = (error) => /^HTTP (429|502|503|504)$/.test(error.message);

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
function overpassQuery(query, timeoutMs = 30000) {
  const turn = overpassLine.then(() => overpassRequest(query, timeoutMs));
  overpassLine = turn.catch(() => {});   // a failed request must not block the ones waiting behind it
  return turn;
}

// One request, trying each server in turn, starting with the one that worked last time and skipping any that are
// resting after a recent failure. If all of them fail (or are resting), the message says why for each one.
async function overpassRequest(query, timeoutMs = 30000) {
  const failures = [];
  for (let i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
    const index = (overpassPreferred + i) % OVERPASS_ENDPOINTS.length;
    const endpoint = OVERPASS_ENDPOINTS[index];
    const host = endpoint.split("/")[2];
    if ((overpassRestingUntil[endpoint] || 0) > Date.now()) { failures.push(`${host}: resting after a recent failure`); continue; }
    try {
      const data = await getJSON(endpoint, { method: "POST", body: new URLSearchParams({ data: query }) }, timeoutMs);
      overpassPreferred = index;
      delete overpassRestingUntil[endpoint];
      rememberOverpass();
      return data.elements || [];
    } catch (error) {
      overpassRestingUntil[endpoint] = Date.now() + (isBusyReply(error) ? OVERPASS_REST_MS.busy : OVERPASS_REST_MS.failed);
      rememberOverpass();
      failures.push(`${host}: ${error.message}`);   // the host name, then why it failed
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

// Returns { grocery: {...} or null, hardware: ..., and so on for every kind asked (the everyday kinds unless `kinds` says).
async function lookupPlaces(lat, lon, kinds = PLACE_KINDS.filter((kind) => !kind.family)) {
  const found = {};
  let remaining = kinds;
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
// With `onlyMissing`, places and the airport that already have a routed time are not asked again.
async function addRoutes(parcel, airports, onlyMissing = false) {
  const jobs = [];   // each job is [where to store the result, destination lat, destination lon]
  const airport = airports.find((a) => a.name === parcel.site.nearestAirport);
  if (airport && !(onlyMissing && parcel.site.airportDriveMin != null)) jobs.push([(r) => { parcel.site.airportDriveMin = r.minutes; parcel.site.airportRoadMiles = r.miles; }, airport.lat, airport.lon]);
  // The same school can be the nearest elementary and middle school, so ask for each spot's route only once.
  const byLocation = new Map();   // "lat,lon" -> the places at that spot
  for (const place of Object.values(parcel.site.places || {})) {
    if (!place) continue;
    const key = `${place.lat},${place.lon}`;
    if (!byLocation.has(key)) byLocation.set(key, []);
    byLocation.get(key).push(place);
  }
  for (const group of byLocation.values()) {
    if (onlyMissing && group.every((place) => place.driveMin != null)) continue;
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
  const ratingOrNull = (v) => (HAZARD_LEVELS.includes(v) ? v : null);
  return {
    overall: a.RISK_RATNG || "No rating",
    overallLevel: HAZARD_LEVELS.indexOf(a.RISK_RATNG),   // -1 when there is no usable rating
    hazards,
    unrated,
    socialVulnerability: ratingOrNull(a.SOVI_RATNG),     // how hard a disaster hits the people living here
    resilience: ratingOrNull(a.RESL_RATNG),              // how well the community can recover
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
    // Without a key the Census can answer with an error the browser is not allowed to read, which looks like "Failed to fetch".
    if (error.notJson || /^HTTP 4/.test(error.message) || (!key && error.name === "TypeError")) return { needsKey: true, keyRejected: Boolean(key) };
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
// Overpass puts null where it trimmed a road at the edge of the search box, so a piece is only measured when both of
// its ends are real points (joining across a gap would invent a straight road that is not there).
// Returns null if the road has no real points at all.
function distanceToRoadFeet(lat, lon, geometry) {
  const metersPerDegree = 111320;
  const x = (point) => (point.lon - lon) * Math.cos(lat * Math.PI / 180) * metersPerDegree;
  const y = (point) => (point.lat - lat) * metersPerDegree;
  let best = Infinity;
  for (let i = 0; i < geometry.length; i++) {
    if (!geometry[i]) continue;
    const next = i + 1 < geometry.length && geometry[i + 1] ? geometry[i + 1] : geometry[i];   // a lone point is measured on its own
    const [ax, ay] = [x(geometry[i]), y(geometry[i])];
    const [bx, by] = [x(next), y(next)];
    const [dx, dy] = [bx - ax, by - ay];
    const lengthSquared = dx * dx + dy * dy;
    // How far along the piece the closest spot is, from 0 (start) to 1 (end). The origin is the parcel.
    const along = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
    best = Math.min(best, Math.hypot(ax + along * dx, ay + along * dy));
  }
  return best === Infinity ? null : Math.round(best * 3.28084);
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
    .filter((road) => road.distanceFt != null)   // a road trimmed away completely has no points left to measure
    .sort((a, b) => a.distanceFt - b.distanceFt);
  return {
    nearest: roads[0] || null,
    nearestPublicPaved: roads.find((r) => r.publicRoad && r.surface === "paved") || null,
  };
}

// OpenStreetMap through Overpass. Searches small circles first and widens only until a public paved road turns up.
// Each server gets 20 seconds: roads are one of many lookups, and there are backups below if it is slow.
async function lookupRoadsOsm(lat, lon) {
  let result = { nearest: null, nearestPublicPaved: null };
  let searched = 0;
  for (const radius of ROAD_SEARCH_RADII_M) {
    searched = radius;
    result = summarizeRoads(await overpassQuery(roadsQuery(lat, lon, radius), 20000), lat, lon);
    if (result.nearestPublicPaved) break;
  }
  return { ...result, searchedMeters: searched, source: "osm" };
}

/* Backup 1: the US Census Bureau's TIGER road lines (TIGERweb map service). It has every public road with a
   class code (MTFCC) but no surface, so only highways are counted as paved. */
const TIGER_ROADS_URL = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer/";
const TIGER_LAYERS = { primary: 2, secondary: 6, local: 8 };
// Census road class codes: [plain name, surface, can the public use it]. Codes not listed (walkways, stairs,
// bike and bridle paths) are not roads a vehicle can use, so they are skipped.
const TIGER_ROAD_CLASSES = {
  S1100: ["primary highway", "paved", true], S1200: ["secondary highway", "paved", true], S1630: ["ramp", "paved", true],
  S1400: ["local road", "unknown", true], S1500: ["4WD trail", "unpaved", true], S1640: ["service drive", "unknown", true],
  S1730: ["alley", "unknown", true], S1740: ["private road", "unknown", false], S1780: ["parking lot road", "unknown", false],
};

// ArcGIS road lines ({ attributes: { NAME, MTFCC }, geometry: { paths } }) -> { nearest, nearestPublicPaved }, like summarizeRoads.
function summarizeTigerRoads(features, lat, lon) {
  const roads = [];
  for (const f of features) {
    const kind = TIGER_ROAD_CLASSES[f.attributes && f.attributes.MTFCC];
    const paths = f.geometry && f.geometry.paths;
    if (!kind || !paths || !paths.length) continue;   // not a road a vehicle can use, or no shape
    // Each path is a list of [longitude, latitude] pairs; the road's distance is that of its closest path.
    // (Paths with no points give null, which Math.min would wrongly count as 0, so they are dropped first.)
    const distances = paths.map((path) => distanceToRoadFeet(lat, lon, path.map(([x, y]) => ({ lat: y, lon: x })))).filter((d) => d != null);
    if (!distances.length) continue;
    const distanceFt = Math.min(...distances);
    roads.push({ name: f.attributes.NAME || "(unnamed road)", type: kind[0], surface: kind[1], access: kind[2] ? null : "private",
      publicRoad: kind[2], distanceFt });
  }
  roads.sort((a, b) => a.distanceFt - b.distanceFt);
  return { nearest: roads[0] || null, nearestPublicPaved: roads.find((r) => r.publicRoad && r.surface === "paved") || null };
}

async function tigerRoads(layer, lat, lon, radiusM) {
  const q = new URLSearchParams({ geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326",
    spatialRel: "esriSpatialRelIntersects", distance: String(radiusM), units: "esriSRUnit_Meter",
    outFields: "NAME,MTFCC", returnGeometry: "true", outSR: "4326", geometryPrecision: "6", f: "json" });
  const data = await getJSON(`${TIGER_ROADS_URL}${layer}/query?${q}`, {}, 20000);
  if (data.error) throw new Error("Census roads service error");
  return data.features || [];
}

// Local roads only up to 3 km (there can be thousands further out); highways as far as 10 km.
async function lookupRoadsTiger(lat, lon) {
  let result = { nearest: null, nearestPublicPaved: null };
  let searched = 0;
  for (const radius of ROAD_SEARCH_RADII_M) {
    searched = radius;
    const layers = radius <= 3000 ? [TIGER_LAYERS.local, TIGER_LAYERS.secondary, TIGER_LAYERS.primary] : [TIGER_LAYERS.secondary, TIGER_LAYERS.primary];
    const features = (await Promise.all(layers.map((layer) => tigerRoads(layer, lat, lon, radius)))).flat();
    const found = summarizeTigerRoads(features, lat, lon);
    result = { nearest: result.nearest || found.nearest, nearestPublicPaved: found.nearestPublicPaved };
    if (result.nearestPublicPaved) break;
  }
  return { ...result, searchedMeters: searched, source: "tiger" };
}

/* Backup 2: the OSRM routing server's "nearest" answer: the closest road a car can be routed on, with its name and
   distance. It says nothing about surface or the nearest paved road. */
function summarizeOsrmNearest(data) {
  const w = data && data.code === "Ok" && data.waypoints && data.waypoints[0];
  if (!w) return null;
  return { name: w.name || "(unnamed road)", type: "road", surface: "unknown", access: null, publicRoad: true,
    distanceFt: Math.round(w.distance * 3.28084) };
}

async function lookupRoadsOsrm(lat, lon) {
  const data = await getJSON(`https://router.project-osrm.org/nearest/v1/driving/${lon},${lat}?number=1`, {}, 15000);
  return { nearest: summarizeOsrmNearest(data), nearestPublicPaved: null, searchedMeters: null, source: "osrm" };
}

// Tries each road service in turn and keeps the first answer. Only if all three fail is the lookup a failure.
const ROAD_SERVICES = [["OpenStreetMap", lookupRoadsOsm], ["Census TIGER roads", lookupRoadsTiger], ["OSRM nearest road", lookupRoadsOsrm]];
async function lookupRoads(lat, lon) {
  const failures = [];
  for (const [name, lookup] of ROAD_SERVICES) {
    try {
      return await lookup(lat, lon);
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    }
  }
  throw new Error(`No road service answered (${failures.join("; ")})`);
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
/* ---- more local conditions (county profile, drought, weather alerts, wind, design rainfall, nearby regulated facilities) ---- */

const NWS_URL = "https://api.weather.gov/";
const POWER_URL = "https://power.larc.nasa.gov/api/temporal/climatology/point";
const DROUGHT_URL = "https://services5.arcgis.com/0OTVzJS4K09zlixn/ArcGIS/rest/services/USDM_current/FeatureServer/0/query";
const ECHO_URL = "https://echodata.epa.gov/echo/echo_rest_services.get_facilities";
const ECHO_RADIUS_MILES = 2;

/* ---- people and community: the Census Bureau's survey figures for the tract and the county ---- */

// Census Reporter (censusreporter.org) republishes the Census Bureau's American Community Survey and, unlike the
// Census's own API, answers a web page without a key. Its "geo IDs" are the Census GEOID with a prefix for the level.
const CENSUS_REPORTER_URL = "https://api.censusreporter.org/1.0/data/show/latest";
const PEOPLE_TABLES = ["B01003", "B01002", "B09001", "B19013", "B17001", "B15003", "B08301", "B28002", "B25077"];

// One place's tables -> plain numbers. Each table's values are named like "B17001002" (table, then line number).
function summarizePlace(tables) {
  if (!tables) return null;
  const est = (table, line) => {
    const v = tables[table] && tables[table].estimate ? tables[table].estimate[`${table}${line}`] : null;
    return Number.isFinite(v) && v >= 0 ? v : null;   // missing, or a negative "not available" code
  };
  const pct = (part, whole) => (part != null && whole > 0 ? Math.round(part / whole * 1000) / 10 : null);
  const population = est("B01003", "001");
  const bachelorsOrMore = ["022", "023", "024", "025"].map((line) => est("B15003", line));   // bachelor's, master's, professional, doctorate
  return {
    population,
    medianAge: est("B01002", "001"),
    under18Pct: pct(est("B09001", "001"), population),
    medianIncome: est("B19013", "001"),
    povertyPct: pct(est("B17001", "002"), est("B17001", "001")),
    bachelorsPct: bachelorsOrMore.every((v) => v != null) ? pct(bachelorsOrMore.reduce((a, b) => a + b, 0), est("B15003", "001")) : null,
    workFromHomePct: pct(est("B08301", "021"), est("B08301", "001")),
    broadbandPct: pct(est("B28002", "004"), est("B28002", "001")),
    medianHomeValue: est("B25077", "001"),
  };
}

// The reply -> { release, tract: {...} | null, county: {...} | null }.
function summarizePeople(data, tractId, countyId) {
  if (!data || !data.data) return null;
  const release = data.release ? `${data.release.name}${data.release.years ? ` (${data.release.years})` : ""}` : null;
  return { release, tract: summarizePlace(data.data[tractId]), county: summarizePlace(data.data[countyId]) };
}

async function lookupPeople(tractGeoid, stateFips, countyFips) {
  if (!stateFips || !countyFips) return null;
  const countyId = `05000US${stateFips}${countyFips}`;
  const tractId = tractGeoid ? `14000US${tractGeoid}` : null;
  const geoIds = [tractId, countyId].filter(Boolean).join(",");
  const data = await getJSON(`${CENSUS_REPORTER_URL}?table_ids=${PEOPLE_TABLES.join(",")}&geo_ids=${geoIds}`, {}, 30000);
  if (data.error) throw new Error("Census Reporter error");
  return summarizePeople(data, tractId, countyId);
}

/* ---- crime: the FBI's Crime Data Explorer, for the county sheriff ---- */

// The FBI's API needs a free key from api.data.gov, which you paste in Settings; it is sent only to api.usa.gov.
// The sheriff's office covers the countryside outside city limits, which is where most rural land is.
const FBI_CDE_URL = "https://api.usa.gov/crime/fbi/cde/";
const fbiAgencyLists = {};   // state -> the list of its agencies, kept for this visit (Texas's list is about 400 KB)

// The state's agency list (grouped by county name in capitals) -> the county sheriff, or null.
function findSheriff(agenciesByCounty, county) {
  const name = String(county || "").toUpperCase().replace(/ COUNTY$/, "");
  const agencies = (agenciesByCounty && agenciesByCounty[name]) || [];
  return agencies.find((a) => a.agency_type_name === "County") || null;
}

// One offense reply ("V" violent or "P" property, monthly) -> { count, months, ratePer100k, texasRate, usRate } for the year.
// Monthly rates per 100,000 people add up to a yearly rate. The state's name is in the reply, so it is found by elimination.
function summarizeOffenses(data, agencyName, stateName) {
  const offenses = data && data.offenses;
  if (!offenses || !offenses.actuals) return null;
  const sum = (series) => Object.values(series || {}).reduce((total, v) => total + (Number(v) || 0), 0);
  const actual = offenses.actuals[`${agencyName} Offenses`];
  if (!actual) return null;
  const months = Object.keys(actual).length;
  const pop = Object.values((data.populations && data.populations.population && data.populations.population[agencyName]) || {}).map(Number).filter((v) => v > 0);
  const population = pop.length ? Math.max(...pop) : null;
  const count = sum(actual);
  const round = (v) => Math.round(v * 10) / 10;
  const rates = offenses.rates || {};
  return {
    count, months, population,
    ratePer100k: population ? round(count / population * 100000) : null,
    stateRate: rates[`${stateName} Offenses`] ? round(sum(rates[`${stateName} Offenses`])) : null,
    usRate: rates["United States Offenses"] ? round(sum(rates["United States Offenses"])) : null,
  };
}

async function lookupCrime(stateAbbr, county, key) {
  if (!key) return { needsKey: true };
  if (!stateAbbr || !county) return null;
  try {
    if (!fbiAgencyLists[stateAbbr]) fbiAgencyLists[stateAbbr] = await getJSON(`${FBI_CDE_URL}agency/byStateAbbr/${stateAbbr}?API_KEY=${encodeURIComponent(key)}`, {}, 40000);
  } catch (error) {
    if (/^HTTP (401|403)$/.test(error.message)) return { needsKey: true, keyRejected: true };
    throw error;
  }
  const sheriff = findSheriff(fbiAgencyLists[stateAbbr], county);
  if (!sheriff) return { agency: null };
  const ask = (code, year) => getJSON(`${FBI_CDE_URL}summarized/agency/${sheriff.ori}/${code}?from=01-${year}&to=12-${year}&API_KEY=${encodeURIComponent(key)}`, {}, 40000);
  // The last full calendar year first. On 2026-10-31 the FBI's service failed (HTTP 503) for all of 2025 but answered
  // for 2024, so when a year fails on the FBI's side, the year before is tried once. That covers a 5xx error and also
  // no answer at all (a time-out, or an error page without the header that lets a web page read it, which the browser
  // reports only as "Failed to fetch"). A 4xx error, like 429 "too many requests", is our side and is not retried.
  let year = new Date().getFullYear() - 1;
  let violent, property;
  try {
    [violent, property] = await Promise.all([ask("V", year), ask("P", year)]);
  } catch (error) {
    if (/^HTTP 4\d\d$/.test(error.message) || error.notJson) throw error;
    year -= 1;
    [violent, property] = await Promise.all([ask("V", year), ask("P", year)]);
  }
  const stateName = sheriff.state_name || "";
  return {
    agency: sheriff.agency_name, ori: sheriff.ori, year,
    violent: summarizeOffenses(violent, sheriff.agency_name, stateName),
    property: summarizeOffenses(property, sheriff.agency_name, stateName),
  };
}

// Why the FBI's crime figures failed, in plain words, from the error message (like "HTTP 503" or "Timed out").
// Returns "" when no reason was kept (parcels looked up before v2.11.0).
function crimeFailureText(reason) {
  if (!reason) return "";
  const status = (/^HTTP (\d+)$/.exec(reason) || [])[1];   // the number in "HTTP 503", if that is the message
  let why;
  if (status === "429") why = "your key's hourly limit of requests was used up, so wait an hour";
  else if (status && status.startsWith("5")) why = "the FBI's service had a problem on its side";
  else if (reason === "Timed out") why = "the FBI's service took too long to answer";
  else if (/failed to fetch|networkerror|load failed/i.test(reason)) why = "the FBI's service did not answer (it may be down, or this network blocks it)";
  else why = "the FBI's service sent an unexpected reply";
  return `${why} (${reason})`;
}

// US Drought Monitor: the drought category (D0 to D4) of the current weekly map at the spot, if any. Where there is no drought
// the map has no shape at all, so no feature means "none".
const DROUGHT_NAMES = ["abnormally dry", "moderate drought", "severe drought", "extreme drought", "exceptional drought"];
function summarizeDrought(features) {
  if (!Array.isArray(features)) return null;
  if (!features.length) return { level: null, name: "no drought", date: null };
  const a = features[0].attributes || {};
  const dm = Number(a.DM);
  if (!Number.isInteger(dm) || dm < 0 || dm > 4) return null;
  const when = Number(a.ValidStart || a.MapDate);
  return { level: `D${dm}`, name: DROUGHT_NAMES[dm], date: Number.isFinite(when) ? new Date(when).toISOString().slice(0, 10) : null };
}

async function lookupDrought(lat, lon) {
  const { features } = await arcgisFeatures(DROUGHT_URL, { geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", outFields: "DM,ValidStart,MapDate" }, "Drought map");
  return summarizeDrought(features);
}

// National Weather Service: the forecast office for the spot, and any weather alerts in effect right now.
function summarizeNws(points, alerts) {
  const p = (points && points.properties) || {};
  const town = p.relativeLocation && p.relativeLocation.properties;
  const events = ((alerts && alerts.features) || []).map((f) => (f.properties || {}).event).filter(Boolean);
  return {
    office: p.cwa || null,
    nearTown: town && town.city ? `${town.city}, ${town.state}` : null,
    alerts: [...new Set(events)].slice(0, 5),
  };
}

async function lookupNws(lat, lon) {
  const points = await getJSON(`${NWS_URL}points/${lat.toFixed(4)},${lon.toFixed(4)}`, {}, 30000);
  // The alerts are a bonus: if only they fail, the forecast office still shows.
  const alerts = await getJSON(`${NWS_URL}alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`, {}, 30000).catch(() => null);
  return summarizeNws(points, alerts);
}

// NASA POWER yearly averages. Wind is measured at 10 meters (about 33 feet) and given in meters per second.
function summarizePower(data) {
  const par = data && data.properties && data.properties.parameter;
  if (!par) return null;
  const ws = par.WS10M && Number(par.WS10M.ANN), rh = par.RH2M && Number(par.RH2M.ANN);
  if (!(ws >= 0) && !(rh >= 0)) return null;
  return {
    windMph: ws >= 0 ? Math.round(ws * 2.23694 * 10) / 10 : null,
    humidityPct: rh >= 0 ? Math.round(rh) : null,
  };
}

async function lookupPower(lat, lon) {
  const q = new URLSearchParams({ parameters: "WS10M,RH2M", community: "RE", longitude: String(lon), latitude: String(lat), format: "JSON" });
  return summarizePower(await getJSON(`${POWER_URL}?${q}`, {}, 40000));
}

// EPA ECHO: how many regulated facilities (factories, plants, landfills and the like) are within a couple of miles.
function summarizeEcho(data) {
  const results = data && data.Results;
  if (!results || results.Error) return null;
  const n = Number(results.QueryRows);
  return Number.isFinite(n) ? { facilities: n, withinMiles: ECHO_RADIUS_MILES } : null;
}

async function lookupEcho(lat, lon) {
  const q = new URLSearchParams({ output: "JSON", p_lat: String(lat), p_long: String(lon), p_radius: String(ECHO_RADIUS_MILES), p_act: "Y" });
  return summarizeEcho(await getJSON(`${ECHO_URL}?${q}`, {}, 40000));
}

// OpenFEMA: federal disaster and emergency declarations that named this county in the last DISASTER_YEARS years.
const OPENFEMA_URL = "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries";
const DISASTER_YEARS = 10;

// Rows -> { count, since, recent: [{ date, type, kind }], types: ["Flood", ...] }. FEMA lists a disaster once per
// county it covers, but repeats can happen, so each disaster number is counted once.
function summarizeDisasters(rows, since) {
  if (!Array.isArray(rows)) return null;
  const seen = new Set();
  const unique = [];
  for (const r of rows) {
    if (!r || seen.has(r.disasterNumber)) continue;
    seen.add(r.disasterNumber);
    unique.push(r);
  }
  unique.sort((a, b) => String(b.declarationDate).localeCompare(String(a.declarationDate)));
  // "DR" is a major disaster, "EM" an emergency and "FM" a fire management declaration.
  const kinds = { DR: "major disaster", EM: "emergency", FM: "fire management" };
  return {
    count: unique.length, since,
    recent: unique.slice(0, 3).map((r) => ({ date: String(r.declarationDate || "").slice(0, 10), type: r.incidentType || "?", kind: kinds[r.declarationType] || r.declarationType || "" })),
    types: topCounts(unique.map((r) => r.incidentType).filter(Boolean), 4),
  };
}

async function lookupDisasters(stateFips, countyFips) {
  if (!stateFips || !countyFips) return null;
  const since = new Date(Date.now() - DISASTER_YEARS * 365.25 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  // OpenFEMA uses OData: $filter picks rows and $select picks columns. Built by hand so spaces become %20 (not "+").
  const filter = `fipsStateCode eq '${stateFips}' and fipsCountyCode eq '${countyFips}' and declarationDate ge '${since}'`;
  const url = `${OPENFEMA_URL}?$filter=${encodeURIComponent(filter)}&$select=disasterNumber,declarationDate,incidentType,declarationType&$orderby=declarationDate%20desc&$top=1000`;
  const data = await getJSON(url, {}, 30000);
  return summarizeDisasters(data.DisasterDeclarationsSummaries, since);
}

// The pieces of "More local conditions", in the order they are looked up (the keys of `jobs` below).
const MORE_PIECES = ["people", "crime", "drought", "weather", "wind", "facilities", "disasters"];

// Each piece is looked up on its own, like the Texas details: `failed` lists the pieces that did not answer.
// `only` (a list of piece names) asks just those pieces; leave it out to ask them all.
async function lookupMore(parcel, crimeKey, only = null) {
  const { lat, lon, stateFips, countyFips, tractGeoid, state, county } = parcel;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("Bad coordinates");
  const jobs = {
    people: () => lookupPeople(tractGeoid, stateFips, countyFips),
    crime: () => lookupCrime(state, county, crimeKey),
    drought: () => lookupDrought(lat, lon),
    weather: () => lookupNws(lat, lon),
    wind: () => lookupPower(lat, lon),
    facilities: () => lookupEcho(lat, lon),
    disasters: () => lookupDisasters(stateFips, countyFips),
  };
  const names = Object.keys(jobs).filter((name) => !only || only.includes(name));
  const settled = await Promise.allSettled(names.map((n) => jobs[n]()));
  // `reasons` keeps why each piece failed (like "HTTP 503" or "Timed out"), so the report can say so.
  const out = { failed: [], reasons: {} };
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") out[names[i]] = r.value;
    else { out[names[i]] = null; out.failed.push(names[i]); out.reasons[names[i]] = String((r.reason && r.reason.message) || r.reason); }
  });
  return out;
}

/* ---- Texas-only details (looked up and shown only for parcels in Texas) ---- */

// This service refuses normal "query" requests but answers "identify", which asks what is at one point.
const TXGIO_PARCELS_URL = "https://feature.geographic.texas.gov/arcgis/rest/services/Parcels/stratmap_land_parcels_48_most_recent/MapServer/identify";
const TWDB_GCD_URL = "https://services.twdb.texas.gov/arcgis/rest/services/Base/GroundWaterConservationDistricts/MapServer/0/query";
const TLC_SCHOOL_URL = "https://services.arcgis.com/su8ic9KbA7PYVxPS/ArcGIS/rest/services/TEA_TX_School_Districts/FeatureServer/0/query";
const TWDB_WELLS_URL = "https://services.twdb.texas.gov/arcgis/rest/services/Public/TWDB_Groundwater_database/FeatureServer/0/query";
const RRC_MAP_URL = "https://gis.rrc.texas.gov/server/rest/services/rrc_public/RRC_Public_Viewer_Srvs/MapServer/";
const RRC_WELLS_LAYER = 1;       // "Well Locations"
const RRC_PIPELINES_LAYER = 13;  // "Pipelines"
const EDWARDS_RECHARGE_URL = "https://services.arcgis.com/0L95CJ0VTaxqcmED/ArcGIS/rest/services/GEOSCIENTIFICINFORMATION_ed_aq_recharge_zone/FeatureServer/0/query";
const TX_WELL_RADII_MILES = [3, 10];     // look for water wells this close, then farther out if none
const TX_OILGAS_MILES = 1;
const TX_PIPELINE_MILES = 0.5;

// A rough box around Texas. It is used only when the county lookup failed and the state is unknown.
const TEXAS_BOX = { south: 25.8, north: 36.6, west: -106.7, east: -93.5 };

// True for a parcel in Texas: by its state when known, otherwise by the rough box.
function isTexasParcel(parcel) {
  if (!parcel) return false;
  if (parcel.state) return String(parcel.state).toUpperCase() === "TX";
  return parcel.lat >= TEXAS_BOX.south && parcel.lat <= TEXAS_BOX.north && parcel.lon >= TEXAS_BOX.west && parcel.lon <= TEXAS_BOX.east;
}

// Appraisal districts store the area in different units. Returns acres, or null when the unit is not recognized.
function acresFrom(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = String(unit || "").toLowerCase();
  if (u === "" || u === "null" || /acre/.test(u)) return n;   // no unit given: these parcel files use acres
  if (/(sq|square).*(f|ft|feet|foot)/.test(u)) return n / 43560;
  if (/(sq|square).*(m|meter)/.test(u)) return n / 4046.856;
  return null;
}

const middleOf = (sorted) => (sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null);
const topCounts = (values, n) => {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n).map(([name]) => name);
};

// A field of a service reply, matched ignoring capitals (this service answers in capitals). The text "Null" and blanks mean missing.
function field(attributes, name) {
  const key = Object.keys(attributes).find((k) => k.toLowerCase() === name.toLowerCase());
  const value = key === undefined ? null : attributes[key];
  return value === null || value === undefined || /^\s*(null)?\s*$/i.test(String(value)) ? null : value;
}

// The parcel's boundary as [[lat, lon], ...] for the map, from an ArcGIS polygon in latitude/longitude (wkid 4326).
// Only the outer ring is kept, thinned to at most 400 corners and rounded to about 10 cm, so it stays small in storage.
function parcelOutline(geometry) {
  const sr = geometry && geometry.spatialReference;
  if (!geometry || !Array.isArray(geometry.rings) || !geometry.rings.length) return null;
  if (sr && sr.wkid !== 4326 && sr.latestWkid !== 4326) return null;   // some other map projection: better to show nothing
  const ring = geometry.rings[0];
  const step = Math.max(1, Math.ceil(ring.length / 400));
  const points = ring.filter((_, i) => i % step === 0).map(([lon, lat]) => [Math.round(lat * 1e6) / 1e6, Math.round(lon * 1e6) / 1e6]);
  return points.length >= 3 && points.every(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon)) ? points : null;
}

// The appraisal district's record for the parcel under the point. The owner's name and addresses are deliberately not kept.
function summarizeTxParcel(features) {
  if (!features.length) return null;
  const a = features[0].attributes;
  const num = (name) => { const v = Number(field(a, name)); return Number.isFinite(v) && v > 0 ? v : null; };
  // Areas come in acres; the unit fields are usually empty, so an empty unit is taken as acres.
  const acres = acresFrom(field(a, "legal_area"), field(a, "lgl_area_unit")) ?? acresFrom(field(a, "gis_area"), field(a, "gis_area_unit"));
  const landValue = num("land_value");
  return {
    propertyId: field(a, "prop_id"),
    appraisalAcres: acres == null ? null : Math.round(acres * 100) / 100,
    landValue, improvementValue: num("imp_value"), marketValue: num("mkt_value"),
    landValuePerAcre: landValue != null && acres ? Math.round(landValue / acres) : null,
    landUse: field(a, "loc_land_use") || field(a, "stat_land_use"),
    taxYear: field(a, "tax_year"),
    county: field(a, "county"),
    yearBuilt: (() => { const y = Number(field(a, "year_built")); return Number.isInteger(y) && y > 1700 && y <= new Date().getFullYear() + 1 ? y : null; })(),
    // The state's property category. D1 is "qualified open-space land": land taxed on its farm or wildlife use.
    stateCategory: field(a, "stat_land_use"),
    openSpaceLikely: /^D1\b/i.test(String(field(a, "stat_land_use") || "")),
    outline: parcelOutline(features[0].geometry),
  };
}

function summarizeTxWells(features, miles, more) {
  const depths = features.map((f) => Number(attr(f.attributes, "WellDepth"))).filter((d) => Number.isFinite(d) && d > 0).sort((a, b) => a - b);
  return {
    searchedMiles: miles, count: features.length, more: Boolean(more),
    medianDepthFt: depths.length ? Math.round(middleOf(depths)) : null,
    minDepthFt: depths.length ? Math.round(depths[0]) : null,
    maxDepthFt: depths.length ? Math.round(depths[depths.length - 1]) : null,
    aquifers: topCounts(features.map((f) => String(attr(f.attributes, "AquiferCodeName") || "").replace(/^\s*\w+\s+-\s+/, "").trim()).filter(Boolean), 2),   // "371SNSB - San Saba Limestone" -> "San Saba Limestone"
  };
}

function summarizeTxPipelines(features, more) {
  const clean = (v) => (v == null ? "" : String(v).trim());
  return {
    segments: features.length, more: Boolean(more),
    operators: topCounts(features.map((f) => clean(attr(f.attributes, "OPERATOR"))).filter(Boolean), 3),
    commodities: topCounts(features.map((f) => clean(attr(f.attributes, "COMMODITY_DESCRIPTION") || attr(f.attributes, "COMMODITY"))).filter(Boolean), 3),
  };
}

const atPoint = (lat, lon, outFields) => ({ geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", outFields, resultRecordCount: "1" });
const nearPoint = (lat, lon, miles, outFields, count) => ({ geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", distance: String(miles), units: "esriSRUnit_StatuteMile", outFields, resultRecordCount: String(count) });

// The Texas pieces, in the order they are looked up (the keys of `jobs` below).
const TEXAS_PIECES = ["parcel", "groundwaterDistrict", "schoolDistrict", "wells", "pipelines", "oilGasWells", "edwards"];
// Asked only when a ticked family stage needs them (see texasPiecesNeeded).
const TEXAS_FAMILY_PIECES = ["maternal", "neonatal"];
function texasPiecesNeeded(s) {
  const maternity = Object.entries(FAMILY_STAGES).some(([stage, info]) => info.maternity && s && s.family && s.family[stage]);
  return maternity ? [...TEXAS_PIECES, ...TEXAS_FAMILY_PIECES] : TEXAS_PIECES;
}

// The current addresses of the DSHS maternal and neonatal layers, found from the DSHS map (once per visit), or the last
// known ones if the map cannot be read. The map's layer titles start with "Maternal Designated Hospitals" and so on.
let dshsLayers = null;
function dshsLayerUrls() {
  if (!dshsLayers) {
    dshsLayers = getJSON(`https://www.arcgis.com/sharing/rest/content/items/${TX_DSHS_MAP_ITEM}/data?f=json`, {}, 20000)
      .then((map) => {
        const find = (start) => ((map.operationalLayers || []).find((l) => l.url && String(l.title || "").trim().startsWith(start)) || {}).url;
        return { maternal: find("Maternal Designated Hospitals") || TX_DSHS_FALLBACK_LAYERS.maternal, neonatal: find("Neonatal Designated Hospitals") || TX_DSHS_FALLBACK_LAYERS.neonatal };
      })
      .catch(() => ({ ...TX_DSHS_FALLBACK_LAYERS }));
  }
  return dshsLayers;
}

// Designated hospitals -> the three nearest: [{ name, level, city, miles, lat, lon }]. Only these fields are kept.
function nearestDesignated(features, lat, lon) {
  const title = (s) => String(s || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());   // "MARBLE FALLS" -> "Marble Falls"
  return (features || [])
    .filter((f) => f.geometry && Number.isFinite(f.geometry.x) && Number.isFinite(f.geometry.y) && f.attributes)
    .map((f) => ({
      name: title(f.attributes.USER_Primary_Name).replace(/\bOf\b/g, "of").replace(/\b(Ii|Iii|Iv)\b/g, (m) => m.toUpperCase()),
      level: f.attributes.USER_Designate_Level || null,
      city: title(f.attributes.USER_Main_City) || null,
      lat: f.geometry.y, lon: f.geometry.x,
      miles: Math.round(haversineMiles(lat, lon, f.geometry.y, f.geometry.x) * 10) / 10,
    }))
    .sort((a, b) => a.miles - b.miles)
    .slice(0, 3);
}

// Designated hospitals within 150 miles, nearest first, with a routed drive time to the nearest one when the router answers.
async function lookupDesignated(which, lat, lon) {
  const url = (await dshsLayerUrls())[which];
  const q = new URLSearchParams({ geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326", spatialRel: "esriSpatialRelIntersects",
    distance: "150", units: "esriSRUnit_StatuteMile", outFields: "USER_Primary_Name,USER_Designate_Level,USER_Main_City", returnGeometry: "true", outSR: "4326", f: "json" });
  const data = await getJSON(`${url}/query?${q}`, {}, 30000);
  if (data.error) throw new Error("DSHS designation map error");
  const hospitals = nearestDesignated(data.features, lat, lon);
  if (hospitals[0]) {
    const route = await routeInfo(lat, lon, hospitals[0].lat, hospitals[0].lon).catch(() => null);
    if (route) { hospitals[0].driveMin = route.minutes; hospitals[0].roadMiles = route.miles; }
  }
  return { hospitals };
}

// Each piece is looked up on its own: `failed` lists the pieces whose service did not answer, and everything else still shows.
// A value of null means the service answered and nothing was found there. `only` asks just the named pieces.
async function lookupTexas(lat, lon, only = null) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("Bad coordinates");
  const jobs = {
    parcel: async () => {
      const d = 0.0005;   // a box about 160 feet wide around the point, which identify needs to know the map scale
      const q = new URLSearchParams({ f: "json", geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", sr: "4326", layers: "all:0", tolerance: "2",
        mapExtent: `${lon - d},${lat - d},${lon + d},${lat + d}`, imageDisplay: "400,400,96", returnGeometry: "true" });
      const data = await getJSON(`${TXGIO_PARCELS_URL}?${q}`, {}, 40000);
      if (data.error) throw new Error("Texas parcels service error");
      return summarizeTxParcel((data.results || []).map((r) => ({ attributes: r.attributes, geometry: r.geometry })));
    },
    groundwaterDistrict: async () => {
      const { features } = await arcgisFeatures(TWDB_GCD_URL, atPoint(lat, lon, "DistrictName"), "Groundwater districts");
      return { name: features.length ? attr(features[0].attributes, "DistrictName") || null : null };
    },
    schoolDistrict: async () => {
      const { features } = await arcgisFeatures(TLC_SCHOOL_URL, atPoint(lat, lon, "NAME,NAME2"), "School districts");
      return features.length ? { name: attr(features[0].attributes, "NAME") || attr(features[0].attributes, "NAME2") || null } : null;
    },
    wells: async () => {
      for (const miles of TX_WELL_RADII_MILES) {
        const params = { ...nearPoint(lat, lon, miles, "WellDepth,AquiferCodeName,WellType", 1000), where: "WellDepth > 0" };
        const { features, more } = await arcgisFeatures(TWDB_WELLS_URL, params, "TWDB wells");
        if (features.length) return summarizeTxWells(features, miles, more);
      }
      return null;
    },
    pipelines: async () => {
      const { features, more } = await arcgisFeatures(`${RRC_MAP_URL}${RRC_PIPELINES_LAYER}/query`, nearPoint(lat, lon, TX_PIPELINE_MILES, "OPERATOR,COMMODITY_DESCRIPTION,COMMODITY,STATUS", 200), "RRC pipelines");
      return features.length ? summarizeTxPipelines(features, more) : { segments: 0, operators: [], commodities: [], more: false };
    },
    oilGasWells: async () => {
      const q = new URLSearchParams({ ...nearPoint(lat, lon, TX_OILGAS_MILES, "*", 1), inSR: "4326", spatialRel: "esriSpatialRelIntersects", returnCountOnly: "true", f: "json" });
      q.delete("resultRecordCount");
      const data = await getJSON(`${RRC_MAP_URL}${RRC_WELLS_LAYER}/query?${q}`, {}, 40000);
      if (data.error || !Number.isFinite(data.count)) throw new Error("RRC wells service error");
      return { count: data.count, withinMiles: TX_OILGAS_MILES };
    },
    edwards: async () => {
      const { features } = await arcgisFeatures(EDWARDS_RECHARGE_URL, atPoint(lat, lon, "RECHARGE_ZONE"), "Edwards zone");
      return { inRechargeZone: features.length > 0 };
    },
    maternal: () => lookupDesignated("maternal", lat, lon),
    neonatal: () => lookupDesignated("neonatal", lat, lon),
  };
  const names = Object.keys(jobs).filter((name) => (only || TEXAS_PIECES).includes(name));   // family pieces only when asked by name
  const settled = await Promise.allSettled(names.map((n) => jobs[n]()));
  const out = { failed: [] };
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") out[names[i]] = r.value;
    else { out[names[i]] = null; out.failed.push(names[i]); }
  });
  return out;
}

const SOURCE_STEPS = [
  ["County",   async (p) => { Object.assign(p, await lookupCounty(p.lat, p.lon)); }],
  ["Flood",    async (p) => {
    const flood = await lookupFloodDetails(p.lat, p.lon);
    p.site.floodZone = flood ? flood.zone : null;
    p.site.floodSfha = flood ? flood.sfha : null;
    p.site.floodBfeFt = flood ? flood.bfeFt : null;
  }],
  ["Terrain",  async (p) => { Object.assign(p.site, await lookupTerrain(p.lat, p.lon)); }],
  ["Soil",     async (p) => {
    const soil = await lookupSoil(p.lat, p.lon);   // null when there is no soil survey here
    p.site.soilName = soil ? soil.soilName : null;
    p.site.drainageClass = soil ? soil.drainageClass : null;
    p.site.septicRating = soil ? soil.septicRating : null;
  }],
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
  ["Nearby",   async (p) => {
    // Only the kinds not looked up yet (all of them the first time), so ticking a family stage later asks just for its places.
    const have = p.site.places || {};
    const ask = neededPlaceKinds(settings).filter((kind) => !(kind.key in have));
    p.site.places = { ...have, ...(await lookupPlaces(p.lat, p.lon, ask)) };
  }],
  ["Hazards",  async (p) => { p.site.hazards = await lookupHazards(p.lat, p.lon); }],
  ["Hardiness", async (p) => { p.site.hardiness = await lookupHardiness(p.lat, p.lon); }],
];

/* ---- deciding what to look up: everything, or only what is missing ---- */

// The steps that failed last time. Parcels saved before v2.4.0 only have the error messages, which start with the step's name.
function failedSteps(parcel) {
  if (Array.isArray(parcel.failedSteps)) return parcel.failedSteps;
  return (parcel.errors || []).map((message) => String(message).split(":")[0]);
}

// The value each step fills in. `undefined` means the step never ran, for example a lookup added after the parcel was saved.
// (null means the service answered and found nothing, like a spot FEMA has not mapped: asking again would not help.)
const STEP_VALUES = {
  "County": (p) => p.stateFips, "Flood": (p) => p.site.floodZone, "Terrain": (p) => p.site.elevationFt,
  "Soil": (p) => p.site.septicRating, "Soil details": (p) => p.site.soilDetails, "USDA": (p) => p.site.usda,
  "Public land": (p) => p.site.publicLand, "Groundwater": (p) => p.site.groundwater, "Wetlands": (p) => p.site.wetlands,
  "Roads": (p) => p.site.roads, "Climate": (p) => p.site.climate, "Rainfall": (p) => p.site.annualRainIn,
  "Internet": (p) => p.site.internet, "Hazards": (p) => p.site.hazards,
  // Nearby places count as missing when any kind the ticked family stages need was never looked up.
  "Nearby": (p, s) => (p.site.places && neededPlaceKinds(s).every((kind) => kind.key in p.site.places) ? p.site.places : undefined),
  "Hardiness": (p) => p.site.hardiness,
};

// Pieces of More conditions or Texas to ask again: those that failed, those never asked, and any `extra` says are missing.
// Returns null to ask every piece (the whole group is missing), or a list, which can be empty.
function missingPieces(group, names, extra = () => false) {
  if (!group) return null;
  return names.filter((name) => !(name in group) || (group.failed || []).includes(name) || extra(name, group));
}

// True when a nearby place, or the airport, has no routed drive time yet.
function routesMissing(site) {
  if (site.airportMiles != null && site.airportDriveMin == null) return true;
  return Object.values(site.places || {}).some((place) => place && place.driveMin == null);
}

// What a lookup run will do. `mode` is "all" (a new parcel, a moved pin, or Refresh all) or "missing" (Refresh data).
// Returns { steps: [labels], routes: true/false, tax: true/false, more, texas, total, nothingToDo }, where `more` and
// `texas` are false (skip), null (every piece) or a list of piece names. `total` counts the lookups for the progress note.
function planLookups(parcel, mode, s) {
  const site = parcel.site || {};
  const everything = mode === "all" || !parcel.fetchedAt;
  const failed = failedSteps(parcel);
  const isMissing = (label) => everything || failed.includes(label) || STEP_VALUES[label]({ ...parcel, site }, s) === undefined;
  // The airport is worked out from the built-in list, with no web request, so it is always redone.
  const steps = SOURCE_STEPS.map(([label]) => label).filter((label) => label === "Airport" || isMissing(label));
  const countyAgain = steps.includes("County");
  const routes = everything || failed.includes("Routes") || steps.includes("Nearby") || routesMissing(site);
  const tax = everything || countyAgain || failed.includes("Tax rate") || site.taxRate === undefined
    || Boolean(site.taxRate && site.taxRate.needsKey && s.censusKey);   // it was waiting for a key, and now there is one
  const keyNowSet = (name, group) => name === "crime" && Boolean(group.crime && group.crime.needsKey && s.crimeKey);
  let more = everything || countyAgain ? null : missingPieces(site.more, MORE_PIECES, keyNowSet);
  if (Array.isArray(more) && more.length === 0) more = false;
  // Texas is only looked up for Texas parcels; a parcel whose state just turned up may need it for the first time.
  let texas = false;
  if (isTexasParcel(parcel)) {
    const needed = texasPiecesNeeded(s);
    texas = everything || !site.texas ? needed : missingPieces(site.texas, needed);
    if (Array.isArray(texas) && texas.length === 0) texas = false;
  }
  const total = steps.length + (routes ? 1 : 0) + (tax ? 1 : 0) + (more !== false ? 1 : 0) + (texas !== false ? 1 : 0);
  const nothingToDo = steps.every((label) => label === "Airport") && !routes && !tax && more === false && texas === false;
  return { steps, routes, tax, more, texas, total, nothingToDo };
}

// New answers for some pieces, laid over the earlier ones. Only missing pieces were asked, so `failed` is the new list.
function mergePieces(earlier, fresh) {
  if (!earlier) return fresh;
  return { ...earlier, ...fresh, failed: fresh.failed };
}

// When you left the acres blank and the Texas appraisal record has them, use those, and remember where they came from.
function fillAcresFromAppraisal(parcel) {
  const record = parcel.site && parcel.site.texas && parcel.site.texas.parcel;
  if ((parcel.acres === null || parcel.acres === undefined) && record && record.appraisalAcres != null) {
    parcel.acres = record.appraisalAcres;
    parcel.acresSource = "appraisal";
  }
}

// Runs the planned lookups at once. One failure never stops the others; failures are listed on the parcel.
// "all" starts from nothing; "missing" keeps everything already found and only fills the gaps.
async function lookupAll(parcel, onProgress, mode = "all", plan = planLookups(parcel, mode, settings)) {
  if (mode === "all" || !parcel.site) parcel.site = {};
  const errors = [], failedNow = [];
  const fail = (label, message) => { errors.push(`${label}: ${message}`); failedNow.push(label); onProgress(label, "failed"); };
  await Promise.all(SOURCE_STEPS.filter(([label]) => plan.steps.includes(label)).map(async ([label, step]) => {
    onProgress(label, "running");
    try {
      await step(parcel);
      onProgress(label, "ok");
    } catch (error) {
      fail(label, error.message);
    }
  }));
  // Routing needs the airport and places found above, so it runs after them.
  if (plan.routes) {
    onProgress("Routes", "running");
    try {
      await addRoutes(parcel, activeAirports(settings), mode !== "all");
      onProgress("Routes", "ok");
    } catch (error) {
      fail("Routes", error.message);
    }
  }
  // The county tax rate needs the county found above, so it also runs afterward.
  if (plan.tax) {
    onProgress("Tax rate", "running");
    try {
      parcel.site.taxRate = await lookupTaxRate(parcel.stateFips, parcel.countyFips, settings.censusKey);
      onProgress("Tax rate", "ok");
    } catch (error) {
      fail("Tax rate", error.message);
    }
  }
  // More local conditions. They need the county codes found above, so they also run afterward.
  if (plan.more !== false) {
    onProgress("More conditions", "running");
    try {
      const fresh = await lookupMore(parcel, settings.crimeKey, plan.more);
      parcel.site.more = mergePieces(parcel.site.more, fresh);
      // Keep what came back (the report says which pieces could not load), but count a total failure as a failed lookup.
      const asked = Object.keys(fresh).filter((name) => name !== "failed" && name !== "reasons");
      const allFailed = fresh.failed.length > 0 && fresh.failed.length === asked.length;
      if (allFailed) fail("More conditions", "no service answered");
      else onProgress("More conditions", "ok");
    } catch (error) {
      fail("More conditions", error.message);
    }
  }
  // Texas-only lookups. They need the state found above, so they run last, and only for Texas parcels.
  if (plan.texas !== false) {
    onProgress("Texas", "running");
    try {
      const fresh = await lookupTexas(parcel.lat, parcel.lon, plan.texas);
      parcel.site.texas = mergePieces(parcel.site.texas, fresh);
      const allFailed = fresh.failed.length > 0 && fresh.failed.length === Object.keys(fresh).length - 1;
      if (allFailed) fail("Texas", "no Texas service answered");
      else onProgress("Texas", "ok");
    } catch (error) {
      fail("Texas", error.message);
    }
  }
  fillAcresFromAppraisal(parcel);
  parcel.errors = errors;
  parcel.failedSteps = failedNow;
  if (mode === "all") { parcel.fetchedAt = new Date().toISOString(); delete parcel.filledAt; }
  else parcel.filledAt = new Date().toISOString();
}
