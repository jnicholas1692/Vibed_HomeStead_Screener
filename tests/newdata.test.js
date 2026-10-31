"use strict";
// Data added in v2.3.0: flood details, slope direction, soil permeability, FEMA vulnerability and resilience,
// county disaster declarations and the Texas parcel outline.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScripts, plain, fakeFetch } = require("./load");

const app = loadScripts(["config.js", "scoring.js", "sources.js"]);
const json = (obj) => ({ body: JSON.stringify(obj) });

test("parseFloodZone reads FEMA's special flood hazard flag and base flood elevation", () => {
  const parse = app.get("parseFloodZone");
  assert.deepEqual(plain(parse({ FLD_ZONE: "AE", ZONE_SUBTY: null, SFHA_TF: "T", STATIC_BFE: 1012.4 })), { zone: "AE", sfha: true, bfeFt: 1012.4 });
  // These are the values seen from the live service for a zone X spot on the Blanco River.
  assert.deepEqual(plain(parse({ FLD_ZONE: "X", ZONE_SUBTY: "AREA OF MINIMAL FLOOD HAZARD", SFHA_TF: "F", STATIC_BFE: -9999 })), { zone: "X", sfha: false, bfeFt: null });
  assert.equal(parse({ FLD_ZONE: "X", ZONE_SUBTY: "0.2 PCT ANNUAL CHANCE FLOOD HAZARD" }).zone, "X (shaded)");
  assert.equal(parse({ FLD_ZONE: "A" }).sfha, null);
});

test("lookupFloodDetails asks for the two extra fields, and lookupFlood still gives just the zone", async () => {
  const fetch = fakeFetch({ "NFHL/MapServer/28": json({ features: [{ attributes: { FLD_ZONE: "AE", SFHA_TF: "T", STATIC_BFE: 900 } }] }) });
  const withFetch = loadScripts(["config.js", "scoring.js", "sources.js"], { fetch });
  assert.deepEqual(plain(await withFetch.get("lookupFloodDetails")(30, -98)), { zone: "AE", sfha: true, bfeFt: 900 });
  assert.equal(await withFetch.get("lookupFlood")(30, -98), "AE");
  assert.match(decodeURIComponent(fetch.calls[0].url), /outFields=FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE/);
});

test("slopeFacing names the downhill direction, says flat under 1%, and gives up when a point is missing", () => {
  const facing = app.get("slopeFacing");
  // Elevations in feet 60 m north, south, east and west. Lower to the south means the ground faces south.
  assert.equal(facing(1210, 1190, 1200, 1200, 60), "south");
  assert.equal(facing(1200, 1200, 1190, 1210, 60), "east");
  assert.equal(facing(1190, 1210, 1210, 1190, 60), "northwest");
  assert.equal(facing(1200, 1200.5, 1200, 1200, 60), "flat");     // 0.5 ft over 120 m is far under 1%
  assert.equal(facing(1200, null, 1200, 1200, 60), null);
});

test("soil permeability keeps the slowest layer in the top 5 feet and rates it", () => {
  const horizons = app.get("summarizeHorizons");
  const layer = (top, bottom, ksat) => ({ hzdept_r: top, hzdepb_r: bottom, ksat_r: ksat, claytotal_r: 30, sandtotal_r: 30, silttotal_r: 40 });
  const out = plain(horizons([layer(0, 20, 9), layer(20, 80, 0.42), layer(160, 200, 0.001)]));   // the deepest layer is below 5 ft
  assert.deepEqual(out.permeability, { umPerSec: 0.42, rating: "Moderately low" });
  assert.equal(plain(horizons([layer(0, 20, null)])).permeability, null);
  const rate = app.get("permeabilityClass");
  assert.deepEqual([0.005, 0.05, 0.5, 5, 50, 500].map(rate), ["Very low", "Low", "Moderately low", "Moderately high", "High", "Very high"]);
});

test("the soil layer question now asks for Ksat", async () => {
  const fetch = fakeFetch({ "sdmdataaccess": json({ Table: [] }) });
  const withFetch = loadScripts(["config.js", "scoring.js", "sources.js"], { fetch });
  await withFetch.get("lookupSoilDetails")(30, -98).catch(() => {});
  assert.ok(fetch.calls.some((c) => String(c.options.body).includes("ksat_r")));
});

test("parseHazards adds FEMA's social vulnerability and community resilience ratings", () => {
  const out = plain(app.get("parseHazards")({ features: [{ attributes: { RISK_RATNG: "Relatively Moderate", SOVI_RATNG: "Relatively High", RESL_RATNG: "Relatively Moderate" } }] }));
  assert.equal(out.socialVulnerability, "Relatively High");
  assert.equal(out.resilience, "Relatively Moderate");
  const blank = plain(app.get("parseHazards")({ features: [{ attributes: { RISK_RATNG: "Very Low", SOVI_RATNG: "Insufficient Data" } }] }));
  assert.equal(blank.socialVulnerability, null);
  assert.equal(blank.resilience, null);
});

test("summarizeDisasters counts each disaster once and lists the latest first", () => {
  const out = plain(app.get("summarizeDisasters")([
    { disasterNumber: 1, declarationDate: "2021-02-19T00:00:00.000Z", incidentType: "Severe Ice Storm", declarationType: "DR" },
    { disasterNumber: 2, declarationDate: "2024-05-17T00:00:00.000Z", incidentType: "Flood", declarationType: "DR" },
    { disasterNumber: 2, declarationDate: "2024-05-17T00:00:00.000Z", incidentType: "Flood", declarationType: "DR" },
  ], "2016-10-31"));
  assert.equal(out.count, 2);
  assert.equal(out.recent[0].type, "Flood");
  assert.equal(out.recent[0].kind, "major disaster");
  assert.deepEqual(plain(app.get("summarizeDisasters")([], "2016-10-31")), { count: 0, since: "2016-10-31", recent: [], types: [] });
  assert.equal(app.get("summarizeDisasters")(undefined, "x"), null);
});

test("the Texas parcel outline is kept as lat/lon points, and the owner is still never kept", () => {
  const ring = [[-98.4, 30.27], [-98.39, 30.27], [-98.39, 30.28], [-98.4, 30.28], [-98.4, 30.27]];
  const parcel = plain(app.get("summarizeTxParcel")([{
    attributes: { PROP_ID: "R1", LEGAL_AREA: "10", OWNER_NAME: "SECRET OWNER", MAIL_ADDR: "1 PRIVATE RD", SITUS_ADDR: "99 SECRET LANE" },
    geometry: { rings: [ring], spatialReference: { wkid: 4326 } },
  }]));
  assert.deepEqual(parcel.outline[0], [30.27, -98.4]);          // Leaflet wants latitude first
  assert.equal(parcel.outline.length, 5);
  assert.equal(/SECRET|PRIVATE/.test(JSON.stringify(parcel)), false);
  const outline = app.get("parcelOutline");
  assert.equal(outline({ rings: [ring], spatialReference: { wkid: 3857 } }), null);   // another projection: show nothing
  assert.equal(outline(undefined), null);
  const big = Array.from({ length: 2000 }, (_, i) => [-98.4 + i * 1e-6, 30.27]);
  assert.ok(plain(outline({ rings: [big] })).length <= 400);
});

test("the Texas parcel request now asks for the outline", async () => {
  const fetch = fakeFetch({ "feature.geographic.texas.gov": json({ results: [] }), "": { status: 500, body: "x" } });
  const withFetch = loadScripts(["config.js", "scoring.js", "sources.js"], { fetch });
  await withFetch.get("lookupTexas")(30.27, -98.4);
  assert.match(fetch.calls.find((c) => c.url.includes("geographic.texas.gov")).url, /returnGeometry=true/);
});
