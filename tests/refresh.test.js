"use strict";
// v2.4.0: backup road services when the OpenStreetMap servers are busy, and Refresh data that only fills in what is missing.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScripts, plain, fakeFetch } = require("./load");

const json = (obj) => ({ body: JSON.stringify(obj) });
const defaults = () => plain(loadScripts(["config.js"]).get("DEFAULT_SETTINGS"));
// The scripts read the settings from a global called `settings` (normally made by storage.js).
const appWith = (routes) => {
  const fetch = fakeFetch(routes);
  return { app: loadScripts(["config.js", "scoring.js", "sources.js"], { fetch, settings: defaults() }), fetch };
};

/* ---- roads ---- */

test("TIGER roads: class codes give the type, surface and public use; walkways are skipped", () => {
  const { app } = appWith({});
  const line = (name, mtfcc, lat) => ({ attributes: { NAME: name, MTFCC: mtfcc }, geometry: { paths: [[[-98.41, lat], [-98.39, lat]]] } });
  const out = plain(app.get("summarizeTigerRoads")([
    line("Ranch Rd", "S1400", 30.2755), line(null, "S1740", 30.2752), line("US Hwy 281", "S1200", 30.28), line("Trail", "S1710", 30.2751),
  ], 30.275, -98.4));
  assert.equal(out.nearest.name, "(unnamed road)");          // the private road is closest (the walkway does not count)
  assert.equal(out.nearest.type, "private road");
  assert.equal(out.nearest.publicRoad, false);
  assert.equal(out.nearestPublicPaved.name, "US Hwy 281");   // a local road's surface is unknown, so the highway is the paved one
  assert.equal(out.nearestPublicPaved.surface, "paved");
});

test("roads trimmed at the edge of the search box (null points from Overpass) no longer break the lookup", () => {
  const { app } = appWith({});
  const distance = app.get("distanceToRoadFeet");
  // A road running east-west 0.001 degrees north of the spot, with a gap where Overpass trimmed it.
  const road = [null, null, { lat: 30.276, lon: -98.401 }, { lat: 30.276, lon: -98.399 }, null, { lat: 30.276, lon: -98.3 }];
  assert.equal(distance(30.275, -98.4, road), 365);          // 0.001 degrees of latitude is about 111 m, or 365 ft
  // The gap is not joined into a made-up road: without the two points before it, the answer is the lone far point.
  assert.ok(distance(30.275, -98.4, [{ lat: 30.276, lon: -98.5 }, null, { lat: 30.276, lon: -98.3 }]) > 30000);
  assert.equal(distance(30.275, -98.4, [null, null]), null);
  // This is the shape of the real reply that used to throw "Cannot read properties of null".
  const roads = plain(app.get("summarizeRoads")([
    { type: "way", tags: { highway: "residential", name: "Trimmed Rd" }, geometry: [null, { lat: 30.2752, lon: -98.401 }, { lat: 30.2752, lon: -98.399 }] },
    { type: "way", tags: { highway: "track" }, geometry: [null, null] },
  ], 30.275, -98.4));
  assert.equal(roads.nearest.name, "Trimmed Rd");
  assert.equal(roads.nearestPublicPaved.name, "Trimmed Rd");
});

test("OSRM nearest: the road's name and distance in feet", () => {
  const { app } = appWith({});
  const road = plain(app.get("summarizeOsrmNearest")({ code: "Ok", waypoints: [{ name: "Robinson Road", distance: 48 }] }));
  assert.equal(road.name, "Robinson Road");
  assert.equal(road.distanceFt, 157);
  assert.equal(app.get("summarizeOsrmNearest")({ code: "NoSegment" }), null);
});

test("roads: when every OpenStreetMap server is busy, the Census TIGER roads answer instead", async () => {
  const tiger = { features: [{ attributes: { NAME: "E Main St", MTFCC: "S1200" }, geometry: { paths: [[[-98.401, 30.2751], [-98.399, 30.2751]]] } }] };
  const { app, fetch } = appWith({ "overpass": { status: 502, body: "at capacity" }, "tigerweb.geo.census.gov": json(tiger) });
  const roads = plain(await app.get("lookupRoads")(30.275, -98.4));
  assert.equal(roads.source, "tiger");
  assert.equal(roads.nearestPublicPaved.name, "E Main St");
  assert.ok(fetch.calls.some((c) => c.url.includes("/MapServer/8/query")), "local roads were asked");
  assert.equal(plain(app.get("sourceKeysUsed")({ site: { roads } })).includes("roadsTiger"), true);
});

test("roads: when OpenStreetMap and TIGER both fail, OSRM's nearest road is used, and only if all fail is it an error", async () => {
  const { app } = appWith({ "overpass": { status: 429, body: "slow down" }, "tigerweb": { status: 500, body: "x" },
    "router.project-osrm.org/nearest": json({ code: "Ok", waypoints: [{ name: "Robinson Road", distance: 30 }] }) });
  const roads = plain(await app.get("lookupRoads")(30.275, -98.4));
  assert.equal(roads.source, "osrm");
  assert.equal(roads.nearest.name, "Robinson Road");
  assert.equal(roads.nearestPublicPaved, null);
  const none = appWith({ "": { status: 503, body: "down" } }).app;
  await assert.rejects(none.get("lookupRoads")(30.275, -98.4), /No road service answered.*OpenStreetMap.*Census TIGER roads.*OSRM/);
});

test("after a reload, a map server still resting is skipped and the one that worked last is tried first", async () => {
  const saved = { "homestead-screener.overpass.v1": JSON.stringify({ preferred: 0, restingUntil: {
    "https://overpass-api.de/api/interpreter": Date.now() + 60000,          // still resting
    "https://overpass.kumi.systems/api/interpreter": Date.now() - 1000,      // its rest is over
  } }) };
  const localStorage = { getItem: (k) => saved[k] ?? null, setItem: (k, v) => { saved[k] = v; }, removeItem: (k) => { delete saved[k]; } };
  const urls = [];
  const fetch = async (url) => { urls.push(String(url)); return { ok: true, status: 200, text: async () => JSON.stringify({ elements: [] }) }; };
  const app = loadScripts(["config.js", "scoring.js", "sources.js"], { fetch, localStorage, settings: defaults() });
  await app.get("overpassQuery")("q");
  assert.equal(urls.length, 1);
  assert.match(urls[0], /overpass\.openstreetmap\.fr/);                    // overpass-api.de was skipped without being asked
  const remembered = JSON.parse(saved["homestead-screener.overpass.v1"]);
  assert.equal(remembered.preferred, 1);                                    // the server that answered is remembered
  assert.equal("https://overpass.kumi.systems/api/interpreter" in remembered.restingUntil, false);   // finished rests are dropped
});

/* ---- what Refresh data asks again ---- */

// A parcel whose lookups all worked, except the ones a test breaks on purpose.
function goodParcel() {
  return {
    id: "p1", lat: 30.275, lon: -98.4, state: "TX", county: "Blanco", stateFips: "48", countyFips: "031",
    fetchedAt: "2026-10-01T00:00:00.000Z", errors: [], failedSteps: [],
    site: {
      floodZone: null, elevationFt: 1200, slopePct: 3, septicRating: "Not limited", soilDetails: {}, usda: { eligibleArea: true },
      publicLand: null, groundwater: { wells: [] }, wetlands: null, roads: { nearest: null, nearestPublicPaved: null, source: "osm" },
      climate: {}, annualRainIn: 30, internet: { bestMbps: 50, technologies: [] }, places: {}, hazards: null, hardiness: null,
      nearestAirport: "Austin (AUS)", airportMiles: 50, airportDriveMin: 60, taxRate: { ratePct: 1.5 },
      more: { failed: [], countyProfile: null, drought: null, weather: null, wind: null, facilities: null, disasters: null },
      texas: { failed: [], parcel: null, groundwaterDistrict: null, schoolDistrict: null, wells: null, pipelines: null, oilGasWells: null, edwards: null },
    },
  };
}

test("planLookups: nothing missing means nothing to ask (the airport is worked out locally)", () => {
  const { app } = appWith({});
  const plan = plain(app.get("planLookups")(goodParcel(), "missing", defaults()));
  assert.deepEqual(plan.steps, ["Airport"]);
  assert.equal(plan.nothingToDo, true);
  // "all" asks everything, Texas included.
  const all = plain(app.get("planLookups")(goodParcel(), "all", defaults()));
  assert.equal(all.steps.length, app.get("SOURCE_STEPS").length);
  assert.equal(all.more, null);
  assert.equal(all.texas, null);
  assert.equal(all.total, all.steps.length + 4);
});

test("planLookups: failed steps, never-looked-up values and failed pieces are asked again; answered nulls are not", () => {
  const { app } = appWith({});
  const p = goodParcel();
  p.failedSteps = ["Roads"];
  delete p.site.hardiness;                         // a lookup added after this parcel was saved
  p.site.more.failed = ["drought"];
  delete p.site.more.disasters;                    // a piece added later
  p.site.texas.failed = ["pipelines"];
  p.site.places = { grocery: { name: "Market", miles: 5 } };   // no routed time yet
  const plan = plain(app.get("planLookups")(p, "missing", defaults()));
  assert.deepEqual(plan.steps.sort(), ["Airport", "Hardiness", "Roads"]);
  assert.deepEqual(plan.more, ["drought", "disasters"]);
  assert.deepEqual(plan.texas, ["pipelines"]);
  assert.equal(plan.routes, true);
  assert.equal(plan.tax, false);
  assert.equal(plan.steps.includes("Flood"), false);   // floodZone null: FEMA answered "not mapped"
});

test("planLookups: parcels saved before failedSteps existed use their error messages", () => {
  const { app } = appWith({});
  const p = goodParcel();
  delete p.failedSteps;
  p.errors = ["Internet: HTTP 500", "More conditions: no service answered"];
  const plan = plain(app.get("planLookups")(p, "missing", defaults()));
  assert.ok(plan.steps.includes("Internet"));
});

test("planLookups: a tax rate that waited for a Census key is asked again once a key is set", () => {
  const { app } = appWith({});
  const p = goodParcel();
  p.site.taxRate = { needsKey: true };
  p.site.more.countyProfile = { needsKey: true };
  const s = defaults();
  assert.equal(app.get("planLookups")(p, "missing", s).tax, false);
  s.censusKey = "KEY";
  const plan = plain(app.get("planLookups")(p, "missing", s));
  assert.equal(plan.tax, true);
  assert.deepEqual(plan.more, ["countyProfile"]);
});

test("lookupAll in missing mode keeps what is there and only asks the missing services", async () => {
  const { app, fetch } = appWith({
    "router.project-osrm.org/nearest": json({ code: "Ok", waypoints: [{ name: "Robinson Road", distance: 30 }] }),
    "overpass": { status: 502, body: "busy" }, "tigerweb": { status: 500, body: "x" },
    "drought": json({ features: [] }), "USDM_current": json({ features: [] }),
  });
  const p = goodParcel();
  p.failedSteps = ["Roads"];
  p.site.more.failed = ["drought"];
  const before = JSON.stringify(p.site.internet);
  const plan = app.get("planLookups")(p, "missing", defaults());
  const progress = [];
  await app.get("lookupAll")(p, (label, state) => progress.push(`${label}:${state}`), "missing", plan);
  assert.equal(p.site.roads.source, "osrm");                 // filled in by the last backup
  assert.equal(JSON.stringify(p.site.internet), before);     // untouched
  assert.equal(p.site.elevationFt, 1200);
  assert.deepEqual(plain(p.site.more.failed), []);           // drought answered this time
  assert.equal(p.site.more.drought.name, "no drought");
  assert.equal(p.fetchedAt, "2026-10-01T00:00:00.000Z");     // the full fetch date stays; the fill-in date is separate
  assert.ok(p.filledAt);
  assert.deepEqual(plain(p.failedSteps), []);
  // No soil, flood, internet or other service was asked.
  assert.equal(fetch.calls.some((c) => /sdmdataaccess|hazards\.fema|geo\.fcc|epqs/.test(c.url)), false);
  assert.ok(progress.includes("Roads:ok") && progress.includes("More conditions:ok"));
});

test("addRoutes with onlyMissing asks only for drive times that are still missing", async () => {
  const { app, fetch } = appWith({ "router.project-osrm.org/route": json({ code: "Ok", routes: [{ distance: 16093, duration: 900 }] }) });
  const parcel = { lat: 30.275, lon: -98.4, site: {
    nearestAirport: "Austin (AUS)", airportMiles: 50, airportDriveMin: 60,
    places: { grocery: { name: "Market", miles: 5, lat: 30.3, lon: -98.4, driveMin: 9 }, vet: { name: "Vet", miles: 7, lat: 30.32, lon: -98.41 } } } };
  await app.get("addRoutes")(parcel, plain(app.get("AIRPORT_PRESETS")), true);
  assert.equal(fetch.calls.length, 1);                       // only the vet
  assert.equal(parcel.site.places.vet.driveMin, 15);
  assert.equal(parcel.site.places.grocery.driveMin, 9);
});

test("a spot with no soil survey is stored as an answer (null), so it is not asked again", async () => {
  const { app } = appWith({ "sdmdataaccess": json({ Table: [] }) });
  const soilStep = app.get("SOURCE_STEPS").find(([label]) => label === "Soil")[1];
  const p = { lat: 30, lon: -98, site: {} };
  await soilStep(p);
  assert.equal(p.site.septicRating, null);
  assert.equal(p.site.soilName, null);
});

test("the piece lists match what lookupMore and lookupTexas ask", async () => {
  const { app } = appWith({ "": { status: 500, body: "x" } });
  const more = plain(await app.get("lookupMore")({ lat: 30, lon: -98, stateFips: "48", countyFips: "031" }, "KEY"));
  assert.deepEqual(more.failed.sort(), plain(app.get("MORE_PIECES")).sort());
  const tx = plain(await app.get("lookupTexas")(30, -98));
  assert.deepEqual(tx.failed.sort(), plain(app.get("TEXAS_PIECES")).sort());
  const some = plain(await app.get("lookupTexas")(30, -98, ["edwards"]));
  assert.deepEqual(Object.keys(some).sort(), ["edwards", "failed"]);
});
