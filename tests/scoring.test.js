const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScripts, plain } = require("./load");

const app = loadScripts(["config.js", "scoring.js"]);
const linearScore = app.get("linearScore");
const scoreParcel = app.get("scoreParcel");
const scoreFlood = app.get("scoreFlood");
const scoreInternet = app.get("scoreInternet");
const driveMinutes = app.get("driveMinutes");
const defaults = () => plain(app.get("DEFAULT_SETTINGS")); // a fresh copy each time

const near = (actual, expected, tolerance = 0.05) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not close to ${expected}`);

test("linearScore: ends, middle and limits", () => {
  assert.equal(linearScore(5, 5, 20), 100);
  assert.equal(linearScore(20, 5, 20), 0);
  near(linearScore(12.5, 5, 20), 50);
  assert.equal(linearScore(1, 5, 20), 100);   // better than "best" is capped at 100
  assert.equal(linearScore(40, 5, 20), 0);    // worse than "worst" is capped at 0
});

test("high-risk flood zone scores 0 and is a dealbreaker", () => {
  assert.equal(scoreFlood("AE"), 0);
  const result = scoreParcel({ site: { floodZone: "AE" } }, defaults());
  assert.ok(plain(result.dealbreakers).includes("High-risk flood zone"));
});

test("an unknown flood zone is not treated as safe", () => {
  assert.equal(scoreFlood(null), null);
  assert.equal(scoreFlood("AREA NOT INCLUDED"), null);
});

test("missing data is skipped, not counted as zero", () => {
  const result = scoreParcel({ site: { floodZone: "X" } }, defaults());
  assert.equal(result.total, 100);
  assert.equal(result.factorsScored, 1);
  assert.equal(result.factorsTotal, 8);
});

test("a parcel with no data has no total", () => {
  assert.equal(scoreParcel({ site: {} }, defaults()).total, null);
});

test("drive time uses the detour factor and speed", () => {
  near(driveMinutes(50, defaults()), 70.9);
});

test("internet: 100 Mbps and up is full marks, 5 Mbps and below is zero", () => {
  const s = defaults();
  assert.equal(scoreInternet({ bestMbps: 100, technologies: ["Cable"] }, s), 100);
  assert.equal(scoreInternet({ bestMbps: 5, technologies: ["DSL"] }, s), 0);
  near(scoreInternet({ bestMbps: 50, technologies: ["Fixed wireless"] }, s), 47.4);
});

test("internet: satellite-only scores 25, nothing listed scores 10, no data is skipped", () => {
  const s = defaults();
  assert.equal(scoreInternet({ bestMbps: null, technologies: ["Satellite"] }, s), 25);
  assert.equal(scoreInternet({ bestMbps: null, technologies: [] }, s), 10);
  assert.equal(scoreInternet(null, s), null);
  assert.equal(scoreInternet(undefined, s), null);
});

test("hunting counties match ignoring capitals; an empty list skips the factor", () => {
  const s = defaults();
  assert.equal(scoreParcel({ county: "Blanco", site: {} }, s).parts.hunting, null);
  s.huntingCounties = ["blanco"];
  assert.equal(scoreParcel({ county: "Blanco", site: {} }, s).parts.hunting, 100);
  assert.equal(scoreParcel({ county: "Kerr", site: {} }, s).parts.hunting, 0);
});

test("changing a weight changes the total", () => {
  const parcel = { askingPrice: 90000, site: { floodZone: "X", septicRating: "Very limited" } };
  const base = scoreParcel(parcel, defaults()).total;
  const heavySeptic = defaults();
  heavySeptic.weights.septic = 100;
  assert.ok(scoreParcel(parcel, heavySeptic).total < base);
});

test("airport over the limit is a dealbreaker", () => {
  const result = scoreParcel({ site: { airportMiles: 95 } }, defaults());
  assert.equal(result.dealbreakers.length, 1);
});

test("a routed airport time is used instead of the straight-line estimate", () => {
  const s = defaults();
  const site = { airportMiles: 50, airportDriveMin: 130 };          // estimate would be 71 min
  const result = scoreParcel({ site }, s);
  assert.equal(result.parts.airport, 0);                              // 130 min is past the 120 min limit
  assert.equal(result.dealbreakers.length, 1);
  const withoutRoute = scoreParcel({ site: { airportMiles: 50 } }, s);
  assert.ok(withoutRoute.parts.airport > 90);
  assert.equal(withoutRoute.dealbreakers.length, 0);
});

// ---- sorting and filtering ----
const applyView = app.get("applyView");
const item = (name, extra = {}) => {
  const parcel = { name, status: "new", site: {}, ...extra };
  return { parcel, score: scoreParcel(parcel, defaults()) };
};
const names = (items) => items.map((it) => it.parcel.name);
const viewWith = (changes) => ({ sort: "score", status: "all", hideDealbreakers: false, ...changes });

test("sort by price: lowest first, parcels with no price last", () => {
  const items = [item("B", { askingPrice: 90000 }), item("none"), item("A", { askingPrice: 50000 })];
  assert.deepEqual(names(applyView(items, viewWith({ sort: "price" }), defaults())), ["A", "B", "none"]);
});

test("sort by score: best first, no score last; name sort ignores capitals", () => {
  const items = [item("low", { site: { floodZone: "AE" } }), item("empty"), item("high", { site: { floodZone: "X" } })];
  assert.deepEqual(names(applyView(items, viewWith({ sort: "score" }), defaults())), ["high", "low", "empty"]);
  const two = [item("beta"), item("Alpha")];
  assert.deepEqual(names(applyView(two, viewWith({ sort: "name" }), defaults())), ["Alpha", "beta"]);
});

test("sort by internet: fastest first, satellite-only after wired, no data last", () => {
  const net = (best, techs) => ({ site: { internet: { bestMbps: best, technologies: techs, providers: [] } } });
  const items = [item("sat", net(null, ["Satellite"])), item("none"), item("fast", net(300, ["Cable"])), item("slow", net(10, ["DSL"]))];
  assert.deepEqual(names(applyView(items, viewWith({ sort: "internet" }), defaults())), ["fast", "slow", "sat", "none"]);
});

test("sort by airport drive uses a routed time when there is one", () => {
  const items = [item("estimate", { site: { airportMiles: 20 } }), item("routed", { site: { airportMiles: 10, airportDriveMin: 90 } })];
  // estimate: 20 mi * 1.3 / 55 * 60 = about 28 min; routed: 90 min
  assert.deepEqual(names(applyView(items, viewWith({ sort: "airport" }), defaults())), ["estimate", "routed"]);
});

test("filters: status, and hiding dealbreakers; the original list is not changed", () => {
  const items = [item("keep", { status: "interested", site: { floodZone: "X" } }),
                 item("flooded", { status: "interested", site: { floodZone: "AE" } }),
                 item("other", { status: "rejected" })];
  assert.deepEqual(names(applyView(items, viewWith({ status: "interested" }), defaults())).sort(), ["flooded", "keep"]);
  assert.deepEqual(names(applyView(items, viewWith({ hideDealbreakers: true }), defaults())).sort(), ["keep", "other"]);
  assert.equal(items.length, 3);
});

// ---- hunting counties with states ----
test("hunting: a state in the list tells same-named counties apart", () => {
  const s = defaults();
  s.huntingCounties = ["Washington TX", "Blanco"];
  const hunt = (county, state) => scoreParcel({ county, state, site: {} }, s).parts.hunting;
  assert.equal(hunt("Washington", "TX"), 100);
  assert.equal(hunt("Washington", "WI"), 0);          // same name, different state
  assert.equal(hunt("Blanco", "TX"), 100);            // no state in the list: any state
  assert.equal(hunt("Blanco", "OR"), 100);
  assert.equal(hunt("Washington", null), 100);        // state of the parcel unknown: match by name
  s.huntingCounties = ["Blanco County TX"];
  assert.equal(hunt("Blanco", "TX"), 100);
  s.huntingCounties = ["Orleans Parish LA"];
  assert.equal(hunt("Orleans Parish", "LA"), 100);
});

// ---- rough cost estimate ----
test("loanPayment: matches the standard formula; zero rate and zero years are handled", () => {
  const loanPayment = app.get("loanPayment");
  // $80,000 at 7.5% for 20 years is about $644.46 a month.
  assert.ok(Math.abs(loanPayment(80000, 7.5, 20) - 644.46) < 0.5);
  assert.equal(loanPayment(120000, 0, 10), 1000);          // 120 equal payments
  assert.equal(loanPayment(80000, 7.5, 0), 0);             // cash purchase
  assert.equal(loanPayment(0, 7.5, 20), 0);
});

test("estimateCosts: monthly pieces add up, septic price follows the soil rating", () => {
  const estimateCosts = app.get("estimateCosts");
  const s = defaults();
  const est = plain(estimateCosts({ askingPrice: 100000, site: { septicRating: "Not limited" } }, s));
  assert.equal(est.downPayment, 20000);
  assert.ok(Math.abs(est.monthly.tax - 83.33) < 0.01);                      // 1% of $100,000 a year
  assert.equal(est.monthly.insurance, 40);
  assert.ok(Math.abs(est.monthly.total - (est.monthly.loan + est.monthly.tax + 40)) < 0.001);
  assert.equal(est.oneTime.septic, 8000);
  assert.equal(est.oneTime.total, 8000 + 12000);
  const hard = plain(estimateCosts({ askingPrice: 100000, site: { septicRating: "Very limited" } }, s));
  assert.equal(hard.oneTime.septic, 25000);
  assert.ok(hard.notes[0].includes("engineered"));
  const unknown = plain(estimateCosts({ askingPrice: 100000, site: {} }, s));
  assert.equal(unknown.oneTime.septic, 8000);
  assert.ok(unknown.notes[0].includes("unknown"));
  assert.equal(estimateCosts({ askingPrice: null, site: {} }, s), null);     // no price, no estimate
  s.costs.years = 0;
  assert.equal(plain(estimateCosts({ askingPrice: 100000, site: {} }, s)).monthly.loan, 0);
});

// ---- data sources shown on the report ----
test("every DATA_SOURCES entry names an agency, a label and a vintage, and has an https link or none", () => {
  const app = loadScripts(["config.js", "scoring.js"]);
  const table = plain(app.get("DATA_SOURCES"));
  assert.ok(Object.keys(table).length >= 17);
  for (const [key, info] of Object.entries(table)) {
    assert.ok(info.label && info.name && info.vintage, key);
    assert.ok(info.url === null || /^https:\/\//.test(info.url), key);
  }
});

test("sourceVintage uses the date carried by the data when there is one", () => {
  const app = loadScripts(["config.js", "scoring.js"]);
  const v = app.get("sourceVintage");
  assert.equal(v("internet", { internet: { vintage: "June 2021" } }), "FCC data from June 2021");
  assert.equal(v("hardiness", { hardiness: { vintage: "2023" } }), "USDA 2023 map");
  assert.equal(v("taxRate", { taxRate: { year: 2023, ratePct: 1 } }), "ACS 2023 5-year estimates");
  assert.equal(v("climate", { climate: { years: 10 } }), "10 years of daily model data");
  assert.ok(v("flood", {}).length > 0);
  assert.equal(v("nope", {}), "");
});

test("sourceKeysUsed lists only sources that supplied data, and the summary ends with them", () => {
  const app = loadScripts(["config.js", "scoring.js", "sources.js"]);
  const parcel = { name: "A", state: "TX", county: "Blanco", lat: 30, lon: -98, fetchedAt: "2026-10-29T12:00:00Z", site: { floodZone: "X", wetlands: null, publicLand: undefined, hazards: { overall: "Low", hazards: [] }, taxRate: { needsKey: true } } };
  assert.deepEqual(plain(app.get("sourceKeysUsed")(parcel)), ["county", "flood", "hazards"]);
  const text = app.get("summaryText")(parcel, plain(app.get("DEFAULT_SETTINGS")));
  assert.ok(text.includes("Data sources:"));
  assert.ok(text.includes("- Flood zone: FEMA National Flood Hazard Layer (https://msc.fema.gov/portal/home)"));
  assert.ok(!text.includes("- Wetlands:"));
  assert.ok(!text.includes("American Community Survey"));       // key needed: no tax data, so no tax source
  const other = { state: "TX", site: { roads: { nearest: null } } };
  assert.deepEqual(plain(app.get("comparisonSourceKeys")([{ parcel }, { parcel: other }])), ["county", "flood", "hazards", "roads"].sort(
    (a, b) => Object.keys(plain(app.get("DATA_SOURCES"))).indexOf(a) - Object.keys(plain(app.get("DATA_SOURCES"))).indexOf(b)));
});

test("groundwaterText and the comparison row handle every state", () => {
  const app = loadScripts(["config.js", "scoring.js", "sources.js"]);
  const text = app.get("groundwaterText");
  assert.equal(text(undefined), "not looked up");
  assert.equal(text(null), "no data");
  assert.ok(text({ wells: [], searchedMiles: 17 }).includes("within about 17 miles"));
  assert.equal(text({ wells: [{ depthFt: 85.2, distanceMiles: 3.2, measured: "2024-03-05" }], searchedMiles: 17 }), "about 85.2 ft below ground (well 3.2 mi away, measured 2024-03-05)");
  const mk = (gw) => ({ parcel: { name: "P", site: gw === "skip" ? {} : { groundwater: gw } }, score: { total: 50, dealbreakers: [] } });
  const rows = plain(app.get("buildComparison")([mk({ wells: [{ depthFt: 40, distanceMiles: 1, measured: "2024-01-01" }], searchedMiles: 17 }), mk({ wells: [{ depthFt: 200, distanceMiles: 1, measured: "2024-01-01" }], searchedMiles: 17 })], plain(app.get("DEFAULT_SETTINGS"))));
  const row = rows.find((r) => r.label.startsWith("Groundwater"));
  assert.ok(row.cells[0].best && !row.cells[1].best);
  assert.deepEqual(plain(app.get("sourceKeysUsed")({ state: "TX", site: { groundwater: { wells: [] } } })), ["county", "groundwater"]);
});

// ---- hover help ----
test("glossaryTip: meaning first, then the source; unknown labels give nothing", () => {
  const withApp = loadScripts(["config.js", "scoring.js"]);
  const tip = withApp.get("glossaryTip");
  assert.ok(tip("FEMA flood zone").startsWith("FEMA's flood map label."));
  assert.ok(tip("FEMA flood zone").endsWith("Source: FEMA National Flood Hazard Layer."));
  assert.equal(tip("Coordinates").includes("Source:"), false);       // no source key, so no source sentence
  assert.equal(tip("Not a real label"), "");
});

test("every GLOSSARY entry has text and a source that exists in DATA_SOURCES", () => {
  const withApp = loadScripts(["config.js", "scoring.js"]);
  const glossary = plain(withApp.get("GLOSSARY")), sources = plain(withApp.get("DATA_SOURCES"));
  assert.ok(Object.keys(glossary).length >= 60);
  for (const [label, entry] of Object.entries(glossary)) {
    assert.ok(entry.text && entry.text.length > 20, label);
    assert.ok(entry.source === undefined || sources[entry.source], `${label}: unknown source ${entry.source}`);
  }
});

test("every label the report shows has a hover explanation", () => {
  const fs = require("node:fs"), path = require("node:path");
  const read = (name) => fs.readFileSync(path.join(__dirname, "..", "js", name), "utf8");
  const glossary = plain(loadScripts(["config.js"]).get("GLOSSARY"));
  const labels = new Set([
    ...[...read("ui.js").matchAll(/\bkv\("([^"]+)"/g)].map((m) => m[1]),          // the report sections
    ...[...read("scoring.js").matchAll(/\brow\("([^"]+)"/g)].map((m) => m[1]),     // the compare table
    ...Object.values(plain(loadScripts(["config.js"]).get("FACTOR_LABELS"))),      // the factor table
  ]);
  const missing = [...labels].filter((label) => !glossary[label]);
  assert.deepEqual(missing, []);
});
