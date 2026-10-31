"use strict";

/* =====================================================================
   2. Scoring. Pure math: no web calls, no page code.
   ===================================================================== */

// 100 at `best`, 0 at `worst`, a straight line between (works whichever is larger).
function linearScore(value, best, worst) {
  const fraction = (value - worst) / (best - worst);
  return Math.max(0, Math.min(100, fraction * 100));
}

// Formatting helpers shared by the screens and the compare table.
const money = (n) => (n == null ? "?" : "$" + Math.round(n).toLocaleString("en-US"));
const scoreText = (v) => (v == null ? "n/a" : Math.round(v));

// The footer line, for example "Version 2.2.0, last updated October 31, 2026".
// The date is split by hand instead of using new Date("2026-10-31"), because that reads it as midnight UTC
// and in US time zones it would show the day before.
function versionText(version, isoDate) {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const [year, month, day] = isoDate.split("-").map(Number);
  return `Version ${version}, last updated ${months[month - 1]} ${day}, ${year}`;
}

function driveMinutes(straightLineMiles, s) {
  return straightLineMiles * s.detourFactor / s.avgMph * 60;
}

// Drive minutes to the airport: the routed time when we have one, else the estimate.
function airportMinutes(site, s) {
  if (site.airportDriveMin != null) return site.airportDriveMin;
  if (site.airportMiles != null) return driveMinutes(site.airportMiles, s);
  return null;
}

// The flood zone as a yes or no with the details: {inZone: true|false|null, text}.
// `sfha` is FEMA's own flag for a special flood hazard area (true, false or null). It settles zones with unusual labels.
function floodAnswer(zone, sfha) {
  if (!zone) return { inZone: null, text: "Unknown (not mapped or lookup failed)" };
  if (HIGH_RISK_FLOOD_ZONES.has(zone) || sfha === true) return { inZone: true, text: `Yes: zone ${zone}, high risk` };
  if (zone === "X (shaded)") return { inZone: false, text: "No: zone X (shaded), moderate risk" };
  if (zone === "X") return { inZone: false, text: "No: zone X, minimal risk" };
  return { inZone: null, text: `Unknown (zone ${zone})` };   // unusual labels are never treated as safe
}

// Flood risk as a criterion: zone X 100, shaded X 50, high risk 0; unmapped or unusual zones are skipped.
function scoreFlood(site) {
  const answer = floodAnswer(site.floodZone, site.floodSfha);
  if (answer.inZone === true) return 0;
  if (site.floodZone === "X") return 100;
  if (site.floodZone === "X (shaded)") return 50;
  return null;
}

// FEMA's five ratings, best first, as scores.
const HAZARD_SCORES = [100, 75, 50, 25, 0];
const scoreHazards = (hazards) => (hazards && hazards.overallLevel >= 0 ? HAZARD_SCORES[hazards.overallLevel] : null);

// Depth to water at the nearest monitoring well (the first in the list), or null.
const nearestWaterDepth = (gw) => (gw && gw.wells && gw.wells.length ? gw.wells[0].depthFt : null);

// Drive minutes to one kind of nearby place (routed when we have it), or null when none was found.
function placeDriveMinutes(site, kind, s) {
  const place = (site.places || {})[kind];
  if (!place) return null;
  return place.driveMin != null ? place.driveMin : driveMinutes(place.miles, s);
}

function scoreInternet(internet, s) {
  if (!internet) return null;                                   // lookup failed or not run
  if (internet.bestMbps == null) {
    return internet.technologies.includes("Satellite") ? 25 : 10; // nothing wired or fixed wireless listed
  }
  return linearScore(internet.bestMbps, s.internetFullMbps, s.internetZeroMbps);
}

// The reasons a parcel is ruled out, for the factors whose dealbreaker switch is on. Missing data never rules a parcel out.
// `parts` are the factor scores from scoreParcel.
function findDealbreakers(parcel, s, parts) {
  const found = [];
  const site = parcel.site || {};
  const on = s.dealbreakers || {};
  if (on.flood && floodAnswer(site.floodZone, site.floodSfha).inZone === true) found.push("High-risk flood zone");
  if (on.septic && site.septicRating === "Very limited") found.push("Soil is very limited for a septic system");
  if (on.slope && parts.slope === 0) found.push(`Slope is ${s.slopeMax}% or steeper`);
  if (on.rain && parts.rain === 0) found.push(`Rainfall is ${s.rainZero} inches a year or less`);
  const airportMin = airportMinutes(site, s);
  if (on.airport && airportMin != null && airportMin > s.airportMaxMin) {
    found.push(`Estimated drive to airport is over ${Math.round(s.airportMaxMin / 60 * 10) / 10} hours`);
  }
  if (on.price && parts.price === 0) found.push(`Price is ${money(s.priceMax)} or more`);
  if (on.internet && site.internet) {
    // bestMbps is empty when only satellite (or nothing) is listed; otherwise the speed itself decides.
    if (site.internet.bestMbps == null) found.push("No wired or fixed wireless internet");
    else if (parts.internet === 0) found.push(`Internet is ${s.internetZeroMbps} Mbps or slower`);
  }
  if (on.groundwater && parts.groundwater === 0) found.push(`Groundwater is ${s.groundwaterZeroFt} ft or deeper at the nearest well`);
  if (on.hazards && parts.hazards === 0) found.push("FEMA rates natural hazard risk Very High");
  if (on.hospital && parts.hospital === 0) found.push(`Hospital is ${s.hospitalMaxMin} minutes or more away`);
  if (on.grocery && parts.grocery === 0) found.push(`Grocery store is ${s.groceryMaxMin} minutes or more away`);
  if (on.agValuation && parts.agValuation === 0) found.push("No ag or wildlife valuation");
  return found;
}

/* ---- sorting and filtering the list ---- */

// Each sort has a label for the menu, a function that reads the value to sort on,
// and a direction: 1 means smallest first, -1 means largest first.
const SORTS = {
  score:    { label: "Score (best first)",           dir: -1, value: (it) => it.score.total },
  price:    { label: "Price (lowest first)",         dir: 1,  value: (it) => it.parcel.askingPrice },
  internet: { label: "Internet (fastest first)",     dir: -1, value: (it) => {
    const internet = (it.parcel.site || {}).internet;
    if (!internet) return null;                       // no data
    return internet.bestMbps == null ? 0 : internet.bestMbps;   // satellite-only counts as 0
  } },
  airport:  { label: "Airport drive (shortest first)", dir: 1, value: (it, s) => airportMinutes(it.parcel.site || {}, s) },
  acres:    { label: "Acres (largest first)",        dir: -1, value: (it) => it.parcel.acres },
  newest:   { label: "Newest first",                 dir: -1, value: (it) => (it.parcel.createdAt ? Date.parse(it.parcel.createdAt) : null) },
  name:     { label: "Name (A to Z)",                dir: 1,  value: (it) => it.parcel.name.toLowerCase() },
};

// `items` is a list of { parcel, score }. Returns a new, filtered and sorted list.
function applyView(items, view, s) {
  const kept = items.filter(({ parcel, score }) => {
    if (view.status !== "all" && parcel.status !== view.status) return false;
    if (view.hideDealbreakers && score.dealbreakers.length > 0) return false;
    return true;
  });
  const sort = SORTS[view.sort] || SORTS.score;
  return kept.sort((a, b) => {
    const va = sort.value(a, s), vb = sort.value(b, s);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;                         // parcels with no value always go last
    if (vb == null) return -1;
    if (typeof va === "string") return va.localeCompare(vb) * sort.dir;
    return (va - vb) * sort.dir;
  });
}

/* ---- rough cost estimate ---- */

// Monthly payment on a loan with equal payments. A rate of 0 just splits the loan evenly.
function loanPayment(principal, ratePct, years) {
  const months = Math.round(years * 12);
  if (!(principal > 0) || months <= 0) return 0;
  const r = ratePct / 100 / 12;
  return r === 0 ? principal / months : principal * r / (1 - Math.pow(1 + r, -months));
}

// Monthly numbers for a 30-year conventional loan and a 30-year FHA loan at this price. `taxAndInsurance` is the
// property tax plus homeowner insurance per month. Your down payment is used unless it is below the loan's
// minimum, in which case the minimum is used and `raisedToMinimum` is true. All rates come from your settings.
// Banks do not make FHA or conventional loans on bare land; these show what a home purchase at this price would cost.
function homeLoanOptions(price, c, taxAndInsurance) {
  const chosen = Math.max(0, Number(c.downPayment) || 0);
  const pick = (minPct) => {
    const minimum = price * minPct / 100;
    return { down: Math.min(price, Math.max(chosen, minimum)), raisedToMinimum: chosen < minimum, minimum };
  };

  const conv = pick(LOAN_RULES.conventionalMinDownPct);
  const convLoan = price - conv.down;
  const needsPmi = convLoan > 0 && conv.down < price * LOAN_RULES.conventionalNoPmiDownPct / 100;
  const convPi = loanPayment(convLoan, c.conventionalRatePct, LOAN_RULES.years);
  const convMi = needsPmi ? convLoan * c.pmiPct / 100 / 12 : 0;

  const fha = pick(LOAN_RULES.fhaMinDownPct);
  const fhaBase = price - fha.down;
  const upfront = fhaBase * c.fhaUpfrontPct / 100;       // added to the loan at closing
  const fhaBorrowed = fhaBase + upfront;
  const fhaPi = loanPayment(fhaBorrowed, c.fhaRatePct, LOAN_RULES.years);
  const fhaMi = fhaBase * c.fhaAnnualPct / 100 / 12;
  const fhaMipYears = fha.down >= price * LOAN_RULES.fhaLongMipDownPct / 100 ? 11 : LOAN_RULES.years;

  return {
    conventional: {
      downPayment: conv.down, raisedToMinimum: conv.raisedToMinimum, minimumDown: conv.minimum, borrowed: convLoan, ratePct: c.conventionalRatePct,
      pi: convPi, insurance: convMi, insuranceNote: needsPmi ? "private mortgage insurance, until you owe 80% or less of the home's value" : "none at 20% down or more",
      total: convPi + convMi + taxAndInsurance,
    },
    fha: {
      downPayment: fha.down, raisedToMinimum: fha.raisedToMinimum, minimumDown: fha.minimum, borrowed: fhaBorrowed, upfrontInsurance: upfront, ratePct: c.fhaRatePct,
      pi: fhaPi, insurance: fhaMi, insuranceNote: `FHA insurance, ${fhaMipYears >= LOAN_RULES.years ? "for the whole loan" : `for ${fhaMipYears} years`}`,
      overLimit: fhaBase > LOAN_RULES.fhaLoanLimitFloor,
      total: fhaPi + fhaMi + taxAndInsurance,
    },
  };
}

// Returns null when there is no price. Otherwise:
// { downPayment, monthly: { loan, tax, insurance, total }, oneTime: { septic, well, total }, notes: [...] }
// All the rates and prices come from your settings, so treat the output as a rough guide, not a quote.
function estimateCosts(parcel, s) {
  const price = parcel.askingPrice;
  if (price == null) return null;
  const c = s.costs;
  const downPayment = Math.min(price, Math.max(0, Number(c.downPayment) || 0));
  const loan = loanPayment(price - downPayment, c.ratePct, c.years);
  // Use the county's typical rate when we have it (and you have not turned that off); otherwise your own setting.
  const county = (parcel.site || {}).taxRate;
  const useCounty = c.useCountyTax !== false && county && county.ratePct > 0;
  const taxPct = useCounty ? county.ratePct : c.taxPct;
  const tax = price * taxPct / 100 / 12;
  const insurance = c.insuranceMonthly;
  const rating = (parcel.site || {}).septicRating;
  const engineered = rating === "Very limited";
  const septic = engineered ? c.septicEngineered : c.septicStandard;
  const notes = [];
  if (engineered) notes.push("Soil is very limited for septic, so the engineered-system price is used.");
  else if (!rating) notes.push("Septic suitability is unknown, so the standard-system price is used.");
  notes.push("The well is only needed if there is no public water.");
  if (useCounty) notes.push(`Property tax uses the county's typical ${taxPct}% rate from the Census. Land without a house, farm exemptions and special districts can make your real bill very different.`);
  return {
    taxPct, taxSource: useCounty ? "county" : "setting",
    downPayment,
    homeLoans: homeLoanOptions(price, c, tax + insurance),
    monthly: { loan, tax, insurance, total: loan + tax + insurance },
    oneTime: { septic, well: c.well, total: septic + c.well },
    notes,
  };
}

/* ---- plain-text summary for sharing ---- */

// A short text version of one parcel, for pasting into a message or email.
function summaryText(parcel, s) {
  const score = scoreParcel(parcel, s);
  const site = parcel.site || {};
  const lines = [];
  lines.push(`${parcel.name} - ${countyLabel(parcel)}`);
  lines.push(`Score: ${score.total == null ? "n/a" : Math.round(score.total) + " out of 100"} (${score.factorsScored} of ${score.factorsTotal} of your criteria had data)`);
  const perAcre = parcel.askingPrice != null && parcel.acres > 0 ? `, ${money(parcel.askingPrice / parcel.acres)} per acre` : "";
  lines.push(`Asking price: ${money(parcel.askingPrice)} for ${parcel.acres ?? "?"} acres${perAcre}`);
  lines.push(`Dealbreakers: ${score.dealbreakers.length ? score.dealbreakers.join("; ") : "none"}`);
  lines.push(`In a flood zone? ${floodAnswer(site.floodZone).text}; septic: ${site.septicRating || "unknown"}; slope: ${site.slopePct == null ? "unknown" : site.slopePct + "%"}; rain: ${site.annualRainIn == null ? "unknown" : site.annualRainIn + " in/year"}`);
  const air = airportMinutes(site, s);
  lines.push(`Nearest airport: ${air == null ? "unknown" : `${site.nearestAirport}, about ${Math.round(air)} min`}`);
  if (site.internet) {
    lines.push(`Internet: ${site.internet.bestMbps != null ? site.internet.bestMbps + " Mbps best listed non-satellite" : "no wired or fixed-wireless service listed"} (FCC data from ${site.internet.vintage}, may overstate rural coverage)`);
  }
  if (site.places) {
    for (const group of PLACE_GROUPS) {
      const found = group.kinds.map((key) => {
        const kind = PLACE_KINDS.find((k) => k.key === key);
        const place = site.places[key];
        const text = place ? `${place.name}, ${Math.round(placeMinutes(place, s))} min` : (key in site.places ? "none found" : "not looked up");
        return `${kind.label.toLowerCase()}: ${text}`;
      });
      lines.push(`${group.label}: ${found.join("; ")}`);
    }
  }
  if (site.publicLand) lines.push(`Public and protected land (USGS PAD-US): ${publicLandText(site.publicLand)}`);
  if (site.usda) lines.push(`USDA loan area: ${usdaText(site.usda)}`);
  if (site.wetlands) lines.push(`Wetlands (US Fish and Wildlife Service map, not a delineation): ${wetlandText(site.wetlands)}`);
  if (site.groundwater !== undefined && site.groundwater !== null) lines.push(`Groundwater (USGS monitoring wells, not your lot): ${groundwaterText(site.groundwater)}`);
  if (site.roads) lines.push(`Road access (OpenStreetMap, not proof of legal access): nearest road ${roadText(site.roads.nearest)}; nearest paved public road ${site.roads.nearestPublicPaved ? roadText(site.roads.nearestPublicPaved) : `none within ${distanceText(Math.round(site.roads.searchedMeters * 3.28084))}`}`);
  if (site.climate || site.solar) lines.push(`Climate and solar (10-year model data): ${climateSummaryText(site.climate, site.solar)}`);
  if (site.soilDetails) lines.push(`Soil details: ${soilSummaryText(site.soilDetails)}`);
  if (site.hardiness) lines.push(`Plant hardiness zone: ${hardinessText(site.hardiness).replace("Zone ", "")} lowest winter temperature, by ZIP ${site.hardiness.zip} (USDA ${site.hardiness.vintage} map)`);
  if (site.hazards) {
    const high = highHazards(site.hazards);
    lines.push(`Natural hazards (FEMA, area-wide): overall ${site.hazards.overall.toLowerCase()}; high or very high: ${high.length ? high.join(", ") : "none"}`);
  }
  const cost = estimateCosts(parcel, s);
  if (cost) lines.push(`Rough cost (placeholder rates): about ${money(cost.monthly.total)} a month, plus ${money(cost.oneTime.total)} one-time for septic and a well, and ${money(cost.downPayment)} down`);
  if (cost) lines.push(`30-year home loan at this price (not for bare land): about ${money(cost.homeLoans.conventional.total)} a month conventional, ${money(cost.homeLoans.fha.total)} a month FHA, with your tax and insurance`);
  if (parcel.status && parcel.status !== "new") lines.push(`My status: ${parcel.status}`);
  if (parcel.notes) lines.push(`Notes: ${parcel.notes}`);
  lines.push(`Location: ${parcel.lat.toFixed(5)}, ${parcel.lon.toFixed(5)}  https://www.openstreetmap.org/?mlat=${parcel.lat.toFixed(5)}&mlon=${parcel.lon.toFixed(5)}#map=15/${parcel.lat.toFixed(5)}/${parcel.lon.toFixed(5)}`);
  if (sourceKeysUsed(parcel).length) lines.push(...sourcesText(parcel));
  lines.push("A screening aid, not a survey. Confirm flood, soil, septic, water, access and internet with the county, providers and licensed professionals.");
  return lines.join("\n");
}

/* ---- groundwater ---- */

// "about 85 ft below ground (well 3.2 mi away, measured 2024-03-05)" for the nearest well, or why there is none.
// Old readings say how old they are, because many wells have not been measured in decades.
function groundwaterText(gw) {
  if (gw === undefined) return "not looked up";
  if (gw === null) return "no data";
  if (!gw.wells.length) return `no USGS monitoring well with a depth reading within about ${gw.searchedMiles} miles`;
  const w = gw.wells[0];
  const age = w.yearsAgo >= 2 ? `, ${w.yearsAgo} years ago` : "";
  return `about ${w.depthFt} ft below ground (well ${w.distanceMiles} mi away, measured ${w.measured}${age})`;
}

/* ---- grouping the report sections ---- */

// Puts the sections (already in your chosen order) into their categories. Inside a category the sections keep your order,
// and the categories themselves are ordered by whichever of their sections you placed first.
// Returns [{ key, label, sections: [section keys] }], leaving out categories that have none of the given sections.
function groupSections(order) {
  const groups = REPORT_GROUPS
    .map(([key, label, members]) => ({ key, label, sections: order.filter((section) => members.includes(section)) }))
    .filter((group) => group.sections.length > 0);
  const firstPlace = (group) => Math.min(...group.sections.map((section) => order.indexOf(section)));
  return groups.sort((a, b) => firstPlace(a) - firstPlace(b));
}

const groupLabelOf = (section) => (REPORT_GROUPS.find(([, , members]) => members.includes(section)) || [])[1] || "";

/* ---- hover help (the table is GLOSSARY in config.js) ---- */

// The text shown when you hover a label: what it means, then who supplies the data. "" when the label has no entry.
function glossaryTip(label) {
  // The scored factors describe your current ranges, so their text is built from the settings.
  if (FACTOR_TIPS[label]) return FACTOR_TIPS[label](typeof settings !== "undefined" ? settings : DEFAULT_SETTINGS);
  const entry = GLOSSARY[label];
  if (!entry) return "";
  const source = entry.source && DATA_SOURCES[entry.source] ? ` Source: ${DATA_SOURCES[entry.source].name}.` : "";
  return entry.text + source;
}

/* ---- data sources (the table is DATA_SOURCES in config.js) ---- */

// How old the data is. Some results carry their own date; otherwise the table's general wording is used.
// Which DATA_SOURCES entry the road section came from: OpenStreetMap (also for parcels saved before backups existed),
// the Census TIGER roads, or the OSRM nearest-road answer.
function roadSourceKey(roads) {
  return roads && roads.source === "tiger" ? "roadsTiger" : roads && roads.source === "osrm" ? "roadsOsrm" : "roads";
}

function sourceVintage(key, site) {
  site = site || {};
  const info = DATA_SOURCES[key];
  if (!info) return "";
  if (key === "internet" && site.internet && site.internet.vintage) return `FCC data from ${site.internet.vintage}`;
  if (key === "hardiness" && site.hardiness && site.hardiness.vintage) return `USDA ${site.hardiness.vintage} map`;
  if (key === "taxRate" && site.taxRate && site.taxRate.year) return `ACS ${site.taxRate.year} 5-year estimates`;
  if (key === "climate" && site.climate && site.climate.years) return `${site.climate.years} years of daily model data`;
  return info.vintage;
}

// One line such as "FEMA National Flood Hazard Layer (https://msc.fema.gov/portal/home), FEMA's current flood maps".
function sourceLine(key, site) {
  const info = DATA_SOURCES[key];
  if (!info) return "";
  return `${info.name}${info.url ? ` (${info.url})` : ""}, ${sourceVintage(key, site)}`;
}

// Which sources actually supplied data for this parcel, in a steady order. A lookup that failed or has not run adds nothing.
function sourceKeysUsed(parcel) {
  const site = (parcel && parcel.site) || {};
  const has = (v) => v !== undefined && v !== null;
  const used = [];
  if (parcel && parcel.state) used.push("county");
  if (has(site.floodZone)) used.push("flood");
  if (has(site.elevationFt) || has(site.slopePct)) used.push("elevation");
  if (has(site.soilName) || has(site.septicRating)) used.push("soil");
  if (has(site.soilDetails)) used.push("soilDetails");
  if (has(site.annualRainIn)) used.push("rain");
  if (has(site.climate) || has(site.solar)) used.push("climate");
  if (has(site.airportMiles)) used.push("airport");
  if (has(site.airportDriveMin) || Object.values(site.places || {}).some((pl) => pl && pl.roadMiles != null)) used.push("routes");
  if (has(site.internet)) used.push("internet");
  if (has(site.places)) used.push("places");
  if (has(site.hazards)) used.push("hazards");
  if (has(site.hardiness)) used.push("hardiness");
  if (site.taxRate && site.taxRate.ratePct != null) used.push("taxRate");
  if (has(site.groundwater)) used.push("groundwater");
  if (has(site.roads)) used.push(roadSourceKey(site.roads));
  if (has(site.wetlands)) used.push("wetlands");
  if (has(site.publicLand)) used.push("publicLand");
  if (site.usda) used.push("usda");
  const more = site.more;
  if (more) {
    const okm = (key) => !(more.failed || []).includes(key);
    if (okm("countyProfile") && more.countyProfile && !more.countyProfile.needsKey) used.push("censusProfile");
    if (okm("drought")) used.push("drought");
    if (okm("weather")) used.push("nws");
    if (okm("wind")) used.push("power");
    if (okm("facilities")) used.push("echo");
    if (okm("disasters") && more.disasters) used.push("femaDisasters");
  }
  const tx = site.texas;
  if (tx) {
    const ok = (key) => !(tx.failed || []).includes(key);
    if (ok("parcel")) used.push("txParcel");
    if (ok("groundwaterDistrict")) used.push("txGcd");
    if (ok("schoolDistrict")) used.push("txSchool");
    if (ok("wells")) used.push("txWells");
    if (ok("pipelines") || ok("oilGasWells")) used.push("txRrc");
    if (ok("edwards")) used.push("txEdwards");
  }
  return used;
}

// The block that ends the copied summary.
function sourcesText(parcel) {
  const lines = ["Data sources:"];
  for (const key of sourceKeysUsed(parcel)) lines.push(`- ${DATA_SOURCES[key].label}: ${sourceLine(key, parcel.site)}`);
  if (parcel.fetchedAt) lines.push(`Data fetched ${new Date(parcel.fetchedAt).toLocaleDateString()}.`);
  return lines;
}

// Sources behind a comparison: every source used by any of the parcels.
function comparisonSourceKeys(items) {
  const used = new Set();
  for (const it of items) for (const key of sourceKeysUsed(it.parcel)) used.add(key);
  return Object.keys(DATA_SOURCES).filter((key) => used.has(key));
}

/* ---- soil details ---- */

// "2 ft 8 in" style depth for the compare table and summary; null when the survey lists none.
function depthText(inches) {
  if (inches == null) return "none listed";
  return inches >= 24 ? `${Math.round(inches / 12 * 10) / 10} ft` : `${inches} in`;
}

// One short sentence about the soil, for the text summary.
function soilSummaryText(sd) {
  const parts = [];
  if (sd.texture) parts.push(`${sd.texture.toLowerCase()} topsoil`);
  if (sd.farmland) parts.push(sd.farmland.toLowerCase());
  parts.push(`bedrock: ${depthText(sd.bedrockDepthIn)}`);
  parts.push(`seasonal water table: ${depthText(sd.waterTableDepthIn)}`);
  if (sd.flooding) parts.push(`soil flooding: ${sd.flooding.toLowerCase()}`);
  if (sd.shrinkSwell) parts.push(`shrink-swell: ${sd.shrinkSwell.toLowerCase()}`);
  return parts.join("; ");
}

/* ---- climate and solar ---- */

// One sentence for the text summary.
function climateSummaryText(climate, solar) {
  const parts = [];
  if (climate) {
    parts.push(climate.lastSpringFreeze
      ? `last spring freeze about ${climate.lastSpringFreeze}, first fall freeze about ${climate.firstFallFreeze || "none"}, ${climate.frostFreeDays} frost-free days`
      : "no freezes most years");
    parts.push(`${climate.daysOver100F} days a year over 100 F`);
    parts.push(`${climate.snowInchesPerYear} in of snow a year`);
  }
  if (solar) parts.push(`${solar.sunHoursPerDay} full-sun hours a day on average (${solar.worstMonth.name} lowest at ${solar.worstMonth.value})`);
  return parts.join("; ");
}

/* ---- public and protected land ---- */

// "on protected land: Hill Country SNA", "public land within 3 miles: ...", or "none within 25 miles".
function publicLandText(pl) {
  if (pl.withinMiles == null) return "none within 25 miles";
  const names = pl.areas.map((a) => `${a.name} (${a.manager}, ${a.access.toLowerCase()} access)`).join("; ");
  return pl.withinMiles === 0 ? `on protected land: ${names}` : `protected or public land within ${pl.withinMiles} miles: ${names}`;
}

/* ---- USDA loan area ---- */

// "Yes", "No" or "?" for the list and the report.
function usdaText(usda) {
  if (usda === undefined) return "not looked up";
  if (usda === null) return "?";
  return usda.eligibleArea ? "Yes" : "No";
}

/* ---- wetlands ---- */

// "on a mapped wetland (Freshwater Pond)", "3 mapped wetlands within a quarter mile", or "none mapped nearby".
function wetlandText(w) {
  if (w.onWetland) return `on a mapped wetland${w.onTypes.length ? ` (${w.onTypes.join(", ")})` : ""}`;
  if (w.nearbyCount > 0) return `${w.nearbyMore ? "100+" : w.nearbyCount} mapped wetland${w.nearbyCount === 1 ? "" : "s"} within a quarter mile`;
  return "none mapped nearby";
}

/* ---- road access ---- */

// "180 ft" or "0.4 mi".
function distanceText(feet) {
  if (feet == null) return "none found";
  return feet < 1000 ? `${feet} ft` : `${Math.round(feet / 5280 * 10) / 10} mi`;
}

// "Smith Ranch Rd, 180 ft (unpaved)" for the summary and the compare table.
function roadText(road) {
  if (!road) return "none found";
  return `${road.name}, ${distanceText(road.distanceFt)}${road.surface === "unknown" ? "" : ` (${road.surface})`}`;
}

/* ---- natural hazards ---- */

// Names of the hazards FEMA rates "Relatively High" or "Very High" for this parcel's area.
function highHazards(hazards) {
  return hazards ? hazards.hazards.filter((h) => h.level >= 3).map((h) => h.name) : [];
}

// "Zone 8a (10 to 15 F)", "not looked up" for parcels saved earlier, or "unknown".
function hardinessText(hardiness) {
  if (hardiness === undefined) return "not looked up";
  if (!hardiness) return "unknown";
  return `Zone ${hardiness.zone}${hardiness.tempRange ? ` (${hardiness.tempRange} F)` : ""}`;
}

/* ---- side-by-side comparison ---- */

// Minutes to a nearby place: the routed time if we have one, otherwise an estimate.
function placeMinutes(place, s) {
  return place.driveMin != null ? place.driveMin : driveMinutes(place.miles, s);
}

// `items` is a list of { parcel, score } (two or three of them). Returns rows for a table:
// [{ label, cells: [{ text, best }] }]. `best` is true for the winner of a row when the
// numbers differ ("smaller" or "larger" says which end wins).
function buildComparison(items, s) {
  const rows = [];
  const row = (label, values, texts, better) => {
    const nums = values.filter((v) => v != null);
    let target = null;
    if (better && nums.length >= 2 && Math.min(...nums) !== Math.max(...nums)) {
      target = better === "smaller" ? Math.min(...nums) : Math.max(...nums);
    }
    rows.push({ label, cells: texts.map((text, i) => ({ text, best: target != null && values[i] === target })) });
  };
  const site = (it) => it.parcel.site || {};

  row("Score", items.map((it) => it.score.total), items.map((it) => scoreText(it.score.total)), "larger");
  row("Dealbreakers", items.map(() => null), items.map((it) => it.score.dealbreakers.length ? it.score.dealbreakers.join("; ") : "None"));
  // Your ticked criteria, in your order. The star goes to the best score, and each cell shows what was found and its score.
  const chosen = chosenCriteria(s);
  for (const key of chosen) {
    const scores = items.map((it) => criterionScores(it.parcel, s)[key]);
    row(FACTOR_LABELS[key], scores, items.map((it, i) => (scores[i] == null ? criterionValueText(key, it.parcel, s)
      : `${criterionValueText(key, it.parcel, s)} (score ${Math.round(scores[i])})`)), "larger");
  }
  // These usual rows say the same thing as a ticked criterion, so they are left out when it is ticked.
  const sameAs = {
    price: "Asking price", flood: "In a flood zone?", septic: "Septic suitability", slope: "Slope", rain: "Rain per year",
    airport: "Drive to airport", internet: "Internet (best non-satellite)", groundwater: "Groundwater depth (nearest well)",
    hazards: "Natural hazard risk (FEMA)", hospital: "Hospital (emergency)", grocery: "Grocery store", agValuation: "Tax exemptions",
  };
  const covered = new Set(chosen.map((key) => sameAs[key]));
  const rowUnlessCovered = (label, ...rest) => { if (!covered.has(label)) row(label, ...rest); };
  rowUnlessCovered("Asking price", items.map((it) => it.parcel.askingPrice), items.map((it) => money(it.parcel.askingPrice)), "smaller");
  const perAcre = items.map((it) => (it.parcel.askingPrice != null && it.parcel.acres > 0 ? it.parcel.askingPrice / it.parcel.acres : null));
  row("Price per acre", perAcre, perAcre.map(money), "smaller");
  const costs = items.map((it) => estimateCosts(it.parcel, s));
  row("Rough monthly cost", costs.map((c) => (c ? c.monthly.total : null)), costs.map((c) => (c ? money(c.monthly.total) : "unknown")), "smaller");
  row("Rough start-up cost (septic + well)", costs.map((c) => (c ? c.oneTime.total : null)), costs.map((c) => (c ? money(c.oneTime.total) : "unknown")), "smaller");
  const usda = items.map((it) => site(it).usda);
  row("USDA loan area", usda.map((u) => (u ? (u.eligibleArea ? 1 : 0) : null)), usda.map((u) => (u === undefined ? "not looked up" : u === null ? "no data" : (u.eligibleArea ? "Yes" : "No"))), "larger");
  row("Acres", items.map((it) => it.parcel.acres), items.map((it) => it.parcel.acres ?? "?"));
  rowUnlessCovered("In a flood zone?", items.map(() => null), items.map((it) => floodAnswer(site(it).floodZone, site(it).floodSfha).text));
  rowUnlessCovered("Tax exemptions", items.map(() => null), items.map((it) => exemptionsText(it.parcel.exemptions)
    || (openSpaceValuation(it.parcel).value ? "Ag or wildlife valuation likely" : "unknown")));
  rowUnlessCovered("Septic suitability", items.map(() => null), items.map((it) => site(it).septicRating || "unknown"));
  rowUnlessCovered("Slope", items.map((it) => site(it).slopePct ?? null), items.map((it) => (site(it).slopePct == null ? "unknown" : site(it).slopePct + "%")), "smaller");
  rowUnlessCovered("Rain per year", items.map(() => null), items.map((it) => (site(it).annualRainIn == null ? "unknown" : site(it).annualRainIn + " in")));
  const airport = items.map((it) => airportMinutes(site(it), s));
  rowUnlessCovered("Drive to airport", airport, items.map((it, i) => (airport[i] == null ? "unknown" : `${Math.round(airport[i])} min (${site(it).nearestAirport})`)), "smaller");
  const mbps = items.map((it) => (site(it).internet ? (site(it).internet.bestMbps == null ? 0 : site(it).internet.bestMbps) : null));
  rowUnlessCovered("Internet (best non-satellite)", mbps, items.map((it, i) => (mbps[i] == null ? "unknown" : (mbps[i] === 0 ? "Satellite or none listed" : mbps[i] + " Mbps"))), "larger");
  for (const kind of PLACE_KINDS) {
    const minutes = items.map((it) => { const place = (site(it).places || {})[kind.key]; return place ? placeMinutes(place, s) : null; });
    rowUnlessCovered(kind.label, minutes, items.map((it, i) => {
      const places = site(it).places;
      if (!places) return "unknown";
      const place = places[kind.key];
      if (!(kind.key in places)) return "not looked up";   // saved before this kind existed; Refresh data fills it in
      return place ? `${place.name}, ${Math.round(minutes[i])} min` : "None found";
    }), "smaller");
  }
  const lands = items.map((it) => site(it).publicLand);
  row("Public or protected land", lands.map((l) => (l ? (l.withinMiles == null ? 100 : l.withinMiles) : null)),
    lands.map((l) => (l === undefined ? "not looked up" : l === null ? "no data" : l.withinMiles == null ? "none within 25 miles" : l.withinMiles === 0 ? "on protected land" : `within ${l.withinMiles} miles`)));   // no "best": near public land helps some buyers and bothers others
  const wetlands = items.map((it) => site(it).wetlands);
  row("Mapped wetlands", wetlands.map((w) => (w ? (w.onWetland ? 1000 : w.nearbyCount) : null)),
    wetlands.map((w) => (w === undefined ? "not looked up" : w === null ? "no data" : wetlandText(w))), "smaller");
  const gws = items.map((it) => site(it).groundwater);
  rowUnlessCovered("Groundwater depth (nearest well)", gws.map((g) => (g && g.wells.length ? g.wells[0].depthFt : null)), gws.map(groundwaterText), "smaller");   // shallower is cheaper to drill, but see the report's notes
  const roads = items.map((it) => site(it).roads);
  const roadCells = (pick) => roads.map((r) => (r === undefined ? "not looked up" : r === null ? "no data" : roadText(pick(r))));
  row("Nearest road", roads.map((r) => (r && r.nearest ? r.nearest.distanceFt : null)), roadCells((r) => r.nearest), "smaller");
  row("Nearest paved public road", roads.map((r) => (r && r.nearestPublicPaved ? r.nearestPublicPaved.distanceFt : null)), roadCells((r) => r.nearestPublicPaved), "smaller");
  const climates = items.map((it) => site(it).climate);
  const climateText = (fn) => climates.map((c) => (c === undefined ? "not looked up" : c === null ? "no data" : fn(c)));
  row("Last spring freeze (average)", climates.map(() => null), climateText((c) => c.lastSpringFreeze || "none"));
  row("First fall freeze (average)", climates.map(() => null), climateText((c) => c.firstFallFreeze || "none"));
  row("Frost-free days", climates.map((c) => (c ? c.frostFreeDays : null)), climateText((c) => String(c.frostFreeDays)), "larger");
  row("Days over 100 F per year", climates.map((c) => (c ? c.daysOver100F : null)), climateText((c) => String(c.daysOver100F)), "smaller");
  row("Snow per year", climates.map(() => null), climateText((c) => `${c.snowInchesPerYear} in`));
  const solars = items.map((it) => site(it).solar);
  row("Solar: full-sun hours per day", solars.map((v) => (v ? v.sunHoursPerDay : null)),
    solars.map((v) => (v === undefined ? "not looked up" : v === null ? "no data" : `${v.sunHoursPerDay}`)), "larger");
  const soils = items.map((it) => site(it).soilDetails);
  const soilText = (fn) => soils.map((sd) => (sd === undefined ? "not looked up" : sd === null ? "no data" : fn(sd)));
  row("Topsoil texture", soils.map(() => null), soilText((sd) => sd.texture || "unknown"));
  row("Farmland class", soils.map(() => null), soilText((sd) => sd.farmland || "unknown"));
  row("Depth to bedrock", soils.map((sd) => (sd ? sd.bedrockDepthIn : null)), soilText((sd) => depthText(sd.bedrockDepthIn)), "larger");
  row("Seasonal water table depth", soils.map((sd) => (sd ? sd.waterTableDepthIn : null)), soilText((sd) => depthText(sd.waterTableDepthIn)), "larger");
  row("Soil flooding (soil survey)", soils.map((sd) => (sd && sd.flooding ? FLOOD_ORDER.indexOf(sd.flooding) : null)), soilText((sd) => sd.flooding || "unknown"), "smaller");
  row("Shrink-swell", soils.map((sd) => (sd && sd.shrinkSwell ? ["Low", "Moderate", "High", "Very high"].indexOf(sd.shrinkSwell) : null)), soilText((sd) => sd.shrinkSwell || "unknown"), "smaller");
  row("Hardiness zone (by ZIP)", items.map(() => null), items.map((it) => hardinessText(site(it).hardiness)));
  const hazards = items.map((it) => site(it).hazards);
  rowUnlessCovered("Natural hazard risk (FEMA)", hazards.map((h) => (h && h.overallLevel >= 0 ? h.overallLevel : null)),
    hazards.map((h, i) => (h === undefined ? "not looked up" : h === null ? "no data" : h.overall)), "smaller");
  row("Hazards rated high or very high", hazards.map((h) => (h ? highHazards(h).length : null)),
    hazards.map((h) => (!h ? "unknown" : highHazards(h).join(", ") || "None")), "smaller");
  row("Status", items.map(() => null), items.map((it) => it.parcel.status));
  return rows;
}

/* ---- recommended ranges for what you plan to do on the land ---- */

// The recommended [full marks, zero] for every range that a ticked use has an opinion on, as { pairKey: [good, bad] }.
// When two uses disagree the stricter one wins, because the land has to suit both: for a "lower is better" range
// (slope, drive times, well depth) the smaller numbers, for a "higher is better" one (rain, internet) the larger.
function recommendedRanges(uses) {
  const out = {};
  for (const [use, on] of Object.entries(uses || {})) {
    if (!on || !LAND_USES[use]) continue;
    for (const [key, [good, bad]] of Object.entries(LAND_USES[use].ranges)) {
      const pair = RANGE_PAIRS.find((p) => p.key === key);
      if (!pair) continue;
      const stricter = pair.better === "lower" ? Math.min : Math.max;
      out[key] = out[key] ? [stricter(out[key][0], good), stricter(out[key][1], bad)] : [good, bad];
    }
  }
  return out;
}

// The criteria worth ticking for the ticked uses, in the default criteria order, with no repeats.
function suggestedCriteria(uses) {
  const wanted = new Set();
  for (const [use, on] of Object.entries(uses || {})) if (on && LAND_USES[use]) for (const key of LAND_USES[use].criteria) wanted.add(key);
  return DEFAULT_SETTINGS.criteria.order.filter((key) => wanted.has(key));
}

// "homestead and farm", "homestead, farm and garden": the ticked uses in words.
function usesText(uses) {
  const names = Object.keys(LAND_USES).filter((key) => uses && uses[key]).map((key) => LAND_USES[key].label.toLowerCase());
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/* ---- tax exemptions and special valuations ---- */

// The exemptions you ticked on a parcel, in words, or null when you have not said.
function exemptionsText(ex) {
  if (!ex) return null;
  const names = [];
  if (ex.ag) names.push("ag (open-space) valuation");
  if (ex.wildlife) names.push("wildlife management valuation");
  if (ex.homestead) names.push("homestead exemption");
  if (names.length) return names.join(", ").replace(/^./, (c) => c.toUpperCase());   // capitalize the first letter
  return ex.none ? "None" : null;
}

// Does the land have ag or wildlife (open-space) valuation? { value: true | false | null, from: "you" | "appraisal" | null }.
// What you ticked wins. Otherwise a Texas appraisal record in state land category D1 ("qualified open-space land")
// counts as a likely yes. Most counties leave that category blank in the statewide data, so it is often unknown.
function openSpaceValuation(parcel) {
  const ex = parcel.exemptions;
  if (ex && (ex.ag || ex.wildlife)) return { value: true, from: "you" };
  if (ex && ex.none) return { value: false, from: "you" };
  const record = parcel.site && parcel.site.texas && parcel.site.texas.parcel;
  if (record && record.openSpaceLikely) return { value: true, from: "appraisal" };
  return { value: null, from: null };
}

// The Comptroller's page for a Texas county's appraisal district: "Fort Bend" -> .../county-directory/fortbend.php.
function appraisalDistrictUrl(county) {
  const slug = String(county || "").toLowerCase().replace(/ county$/, "").replace(/[^a-z]/g, "");   // keep letters only
  return slug ? `${TX_CAD_DIRECTORY_URL}${slug}.php` : TX_CAD_DIRECTORY_URL;
}

// A rough yearly tax on the appraised total value, before exemptions and caps: { amount, ratePct, source } or null.
function estimatedTaxBeforeExemptions(parcel, s) {
  const record = parcel.site && parcel.site.texas && parcel.site.texas.parcel;
  if (!record || !(record.marketValue > 0)) return null;
  const county = parcel.site.taxRate;
  const useCounty = s.costs.useCountyTax !== false && county && county.ratePct > 0;
  const ratePct = useCounty ? county.ratePct : s.costs.taxPct;
  return { amount: Math.round(record.marketValue * ratePct / 100), ratePct, source: useCounty ? "county" : "setting" };
}

// The criteria you ticked, in your order.
function chosenCriteria(s) {
  const c = normalizeCriteria(s.criteria);
  return c.order.filter((key) => c.on[key]);
}

// Every criterion's score from 0 to 100, or null when there is no data. Worked out for all of them,
// ticked or not, because the dealbreaker switches and the compare table use them too.
function criterionScores(parcel, s) {
  const site = parcel.site || {};
  const range = (value, best, worst) => (value == null ? null : linearScore(value, best, worst));
  return {
    septic: site.septicRating in SEPTIC_SCORES ? SEPTIC_SCORES[site.septicRating] : null,
    slope: range(site.slopePct, s.slopeIdeal, s.slopeMax),
    rain: range(site.annualRainIn, s.rainFull, s.rainZero),
    airport: range(airportMinutes(site, s), s.airportFullMin, s.airportMaxMin),
    price: range(parcel.askingPrice, s.priceTarget, s.priceMax),
    internet: scoreInternet(site.internet, s),
    flood: scoreFlood(site),
    groundwater: range(nearestWaterDepth(site.groundwater), s.groundwaterFullFt, s.groundwaterZeroFt),
    hazards: scoreHazards(site.hazards),
    hospital: range(placeDriveMinutes(site, "hospital", s), s.hospitalFullMin, s.hospitalMaxMin),
    grocery: range(placeDriveMinutes(site, "grocery", s), s.groceryFullMin, s.groceryMaxMin),
    agValuation: (() => { const v = openSpaceValuation(parcel).value; return v === null ? null : v ? 100 : 0; })(),
  };
}

// Returns { total, parts, chosen, factorsScored, factorsTotal, dealbreakers }.
// The total is the plain average of the ticked criteria that have data: each counts the same,
// and a criterion with no data is skipped, not counted as zero.
function scoreParcel(parcel, s) {
  const parts = criterionScores(parcel, s);
  const chosen = chosenCriteria(s);
  const withData = chosen.filter((key) => parts[key] != null);
  const sum = withData.reduce((total, key) => total + parts[key], 0);
  return {
    total: withData.length === 0 ? null : Math.round(sum / withData.length * 10) / 10,
    parts,
    chosen,
    factorsScored: withData.length,
    factorsTotal: chosen.length,
    dealbreakers: findDealbreakers(parcel, s, parts),
  };
}

// What a criterion found for a parcel, in words: "Somewhat limited", "3.2%", "41 min to Austin (AUS)".
// `short` gives a compact version for the list columns.
function criterionValueText(key, parcel, s, short = false) {
  const site = parcel.site || {};
  const mins = (m) => `${Math.round(m)} min`;
  switch (key) {
    case "septic": return site.septicRating || "no data";
    case "slope": return site.slopePct == null ? "no data" : `${site.slopePct}%${!short && site.slopeFacing && site.slopeFacing !== "flat" ? `, faces ${site.slopeFacing}` : ""}`;
    case "rain": return site.annualRainIn == null ? "no data" : `${site.annualRainIn} in/year`;
    case "airport": {
      const m = airportMinutes(site, s);
      return m == null ? "no data" : short ? mins(m) : `${mins(m)} to ${site.nearestAirport}${site.airportDriveMin == null ? " (estimated)" : ""}`;
    }
    case "price": return parcel.askingPrice == null ? "no data" : money(parcel.askingPrice);
    case "internet": {
      const net = site.internet;
      if (!net) return "no data";
      if (net.bestMbps != null) return `${net.bestMbps} Mbps`;
      return net.technologies.includes("Satellite") ? "Satellite only" : "None listed";
    }
    case "flood": {
      const answer = floodAnswer(site.floodZone, site.floodSfha);
      if (!site.floodZone) return "no data";
      return short ? `Zone ${site.floodZone}` : answer.text;
    }
    case "groundwater": {
      const depth = nearestWaterDepth(site.groundwater);
      return depth == null ? "no data" : short ? `${depth} ft` : `${depth} ft at ${site.groundwater.wells[0].distanceMiles} mi`;
    }
    case "hazards": return site.hazards && site.hazards.overallLevel >= 0 ? site.hazards.overall : "no data";
    case "agValuation": {
      const v = openSpaceValuation(parcel);
      if (v.value === null) return short ? "unknown" : "unknown: tick it on the parcel";
      if (short) return v.value ? "Yes" : "No";
      return v.value ? (v.from === "appraisal" ? "Likely (Texas land category D1)" : "Yes (you entered)") : "No (you entered)";
    }
    case "hospital":
    case "grocery": {
      const m = placeDriveMinutes(site, key, s);
      if (m == null) return site.places ? "none found" : "no data";
      const place = site.places[key];
      return short ? mins(m) : `${mins(m)} to ${place.name}${place.driveMin == null ? " (estimated)" : ""}`;
    }
    default: return "?";
  }
}
