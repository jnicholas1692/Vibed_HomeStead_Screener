"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScripts, plain, fakeFetch } = require("./load");

const json = (obj) => ({ body: JSON.stringify(obj) });
const feat = (attributes) => ({ attributes });

function texasApp(overrides = {}) {
  const routes = {
    "feature.geographic.texas.gov": json({ results: [feat({ PROP_ID: "R123", LEGAL_AREA: "10.5", LGL_AREA_UNIT: "Null", GIS_AREA: "10.4", LAND_VALUE: "21000", IMP_VALUE: "0", MKT_VALUE: "21000", COUNTY: "Blanco", TAX_YEAR: "2025", STAT_LAND_USE: "Null", LOC_LAND_USE: "Ranch land", OWNER_NAME: "SECRET OWNER", MAIL_ADDR: "1 Private Rd" })] }),
    "GroundWaterConservationDistricts": json({ features: [feat({ DistrictName: "Blanco-Pedernales GCD" })] }),
    "TEA_TX_School_Districts": json({ features: [feat({ NAME: "Blanco ISD", NAME2: "Blanco" })] }),
    "TWDB_Groundwater_database": json({ features: [feat({ WellDepth: 300, AquiferCodeName: "218TRNT - Trinity" }), feat({ WellDepth: 100, AquiferCodeName: "218TRNT - Trinity" }), feat({ WellDepth: 500, AquiferCodeName: "Edwards" })] }),
    "MapServer/13/query": json({ features: [feat({ OPERATOR: "ACME PIPELINE", COMMODITY_DESCRIPTION: "Natural Gas" })] }),
    "MapServer/1/query": json({ count: 4 }),
    "ed_aq_recharge_zone": json({ features: [] }),
    ...overrides,
  };
  const fetch = fakeFetch(routes);
  return { app: loadScripts(["config.js", "scoring.js", "sources.js"], { fetch }), fetch };
}

test("isTexasParcel uses the state when known and a rough box otherwise", () => {
  const { app } = texasApp();
  const is = app.get("isTexasParcel");
  assert.equal(is({ state: "TX", lat: 0, lon: 0 }), true);
  assert.equal(is({ state: "OK", lat: 30.27, lon: -98.4 }), false);
  assert.equal(is({ lat: 30.27, lon: -98.4 }), true);       // state unknown: inside the box
  assert.equal(is({ lat: 45, lon: -120 }), false);
  assert.equal(is(null), false);
});

test("Texas lookup combines the pieces, keeps no owner details, and converts units", async () => {
  const { app } = texasApp();
  const tx = plain(await app.get("lookupTexas")(30.275, -98.4));
  assert.deepEqual(tx.failed, []);
  assert.equal(tx.parcel.appraisalAcres, 10.5);
  assert.equal(tx.parcel.landValuePerAcre, 2000);
  assert.equal(tx.parcel.landUse, "Ranch land");
  assert.equal(JSON.stringify(tx).includes("SECRET"), false);
  assert.equal(JSON.stringify(tx).includes("Private Rd"), false);
  assert.equal(tx.groundwaterDistrict.name, "Blanco-Pedernales GCD");
  assert.equal(tx.schoolDistrict.name, "Blanco ISD");
  assert.equal(tx.wells.count, 3);
  assert.equal(tx.wells.medianDepthFt, 300);
  assert.deepEqual(tx.wells.aquifers, ["Trinity", "Edwards"]);
  assert.equal(tx.pipelines.segments, 1);
  assert.deepEqual(tx.pipelines.operators, ["ACME PIPELINE"]);
  assert.equal(tx.oilGasWells.count, 4);
  assert.equal(tx.edwards.inRechargeZone, false);
});

test("acresFrom handles acres, square feet and unknown units", () => {
  const { app } = texasApp();
  const acres = app.get("acresFrom");
  assert.equal(acres(5, "Acres"), 5);
  assert.ok(Math.abs(acres(43560, "Square Feet") - 1) < 1e-9);
  assert.equal(acres(5, "mystery"), null);
  assert.equal(acres(0, "acres"), null);
});

test("one Texas service failing does not hide the others", async () => {
  const { app } = texasApp({ "TEA_TX_School_Districts": { status: 503, body: "down" } });
  const tx = plain(await app.get("lookupTexas")(30.275, -98.4));
  assert.deepEqual(tx.failed, ["schoolDistrict"]);
  assert.equal(tx.schoolDistrict, null);
  assert.equal(tx.groundwaterDistrict.name, "Blanco-Pedernales GCD");
});

test("outside every district and parcel, the answers are empty, not errors", async () => {
  const { app } = texasApp({
    "feature.geographic.texas.gov": json({ features: [] }), "GroundWaterConservationDistricts": json({ features: [] }),
    "TEA_TX_School_Districts": json({ features: [] }), "TWDB_Groundwater_database": json({ features: [] }),
    "MapServer/13/query": json({ features: [] }), "MapServer/1/query": json({ count: 0 }), "ed_aq_recharge_zone": json({ features: [{ attributes: { RECHARGE_ZONE: "Recharge" } }] }),
  });
  const tx = plain(await app.get("lookupTexas")(30.275, -98.4));
  assert.deepEqual(tx.failed, []);
  assert.equal(tx.parcel, null);
  assert.equal(tx.groundwaterDistrict.name, null);
  assert.equal(tx.wells, null);
  assert.equal(tx.pipelines.segments, 0);
  assert.equal(tx.edwards.inRechargeZone, true);
});

test("the well search widens from 3 to 10 miles when the first circle is empty", async () => {
  let calls = 0;
  const { app, fetch } = texasApp({ "TWDB_Groundwater_database": { get body() { calls += 1; return JSON.stringify({ features: calls === 1 ? [] : [feat({ WellDepth: 200, AquiferCodeName: "Trinity" })] }); } } });
  const tx = plain(await app.get("lookupTexas")(30.275, -98.4));
  assert.equal(tx.wells.searchedMiles, 10);
  const urls = fetch.calls.map((c) => c.url).filter((u) => u.includes("TWDB_Groundwater_database"));
  assert.equal(urls.length, 2);
  assert.match(urls[0], /distance=3/); assert.match(urls[1], /distance=10/);
});

test("source keys list the Texas sources that answered", () => {
  const { app } = texasApp();
  const keys = plain(app.get("sourceKeysUsed")({ state: "TX", site: { texas: { failed: ["wells"], parcel: null } } }));
  assert.ok(keys.includes("txParcel")); assert.ok(!keys.includes("txWells"));
});

// ---- more local conditions ----
test("people: Census Reporter tables become plain figures; negative or missing values count as unknown", () => {
  const { app } = texasApp();
  const table = (id, values) => ({ [id]: { estimate: Object.fromEntries(Object.entries(values).map(([line, v]) => [`${id}${line}`, v])) } });
  // Figures from the real reply for Blanco County (ACS 2024 5-year), as checked from the live site.
  const county = { ...table("B01003", { "001": 12446 }), ...table("B01002", { "001": 51.5 }), ...table("B09001", { "001": 2182 }),
    ...table("B19013", { "001": 92425 }), ...table("B17001", { "001": 12301, "002": 1038 }),
    ...table("B15003", { "001": 9702, "022": 2499, "023": 699, "024": 155, "025": 82 }), ...table("B08301", { "001": 5557, "021": 874 }),
    ...table("B28002", { "001": 5166, "004": 4607 }), ...table("B25077", { "001": 483500 }) };
  const out = plain(app.get("summarizePeople")({ release: { name: "ACS 2024 5-year", years: "2020-2024" }, data: { "05000US48031": county } }, null, "05000US48031"));
  assert.equal(out.release, "ACS 2024 5-year (2020-2024)");
  assert.equal(out.tract, null);
  assert.deepEqual(out.county, { population: 12446, medianAge: 51.5, under18Pct: 17.5, medianIncome: 92425, povertyPct: 8.4,
    bachelorsPct: 35.4, workFromHomePct: 15.7, broadbandPct: 89.2, medianHomeValue: 483500 });
  const odd = plain(app.get("summarizePlace")({ ...table("B19013", { "001": -666666666 }), ...table("B01003", { "001": 100 }) }));
  assert.equal(odd.medianIncome, null);
  assert.equal(odd.povertyPct, null);
  assert.equal(app.get("summarizePeople")(null), null);
});

test("drought: reads the category at the spot, and no shape means no drought", () => {
  const { app } = texasApp();
  const out = plain(app.get("summarizeDrought")([{ attributes: { DM: 2, ValidStart: Date.UTC(2026, 9, 20) } }]));
  assert.deepEqual(out, { level: "D2", name: "severe drought", date: "2026-10-20" });
  assert.deepEqual(plain(app.get("summarizeDrought")([])), { level: null, name: "no drought", date: null });
  assert.equal(app.get("summarizeDrought")(null), null);
});

test("weather office, wind and humidity, and ECHO parsing", () => {
  const { app } = texasApp();
  assert.deepEqual(plain(app.get("summarizeNws")({ properties: { cwa: "EWX", relativeLocation: { properties: { city: "Blanco", state: "TX" } } } }, { features: [{ properties: { event: "Red Flag Warning" } }, { properties: { event: "Red Flag Warning" } }] })), { office: "EWX", nearTown: "Blanco, TX", alerts: ["Red Flag Warning"] });
  assert.deepEqual(plain(app.get("summarizePower")({ properties: { parameter: { WS10M: { ANN: 4.5 }, RH2M: { ANN: 61.4 } } } })), { windMph: 10.1, humidityPct: 61 });
  assert.equal(app.get("summarizePower")({}), null);
  assert.deepEqual(plain(app.get("summarizeEcho")({ Results: { QueryRows: "7" } })), { facilities: 7, withinMiles: 2 });
  assert.equal(app.get("summarizeEcho")({ Results: { Error: { ErrorMessage: "x" } } }), null);
});

test("lookupMore keeps going when one service fails", async () => {
  const fetch = fakeFetch({
    "api.censusreporter.org": json({ release: { name: "ACS 2024 5-year" }, data: { "05000US48031": { B01003: { estimate: { B01003001: 100 } } } } }),
    "USDM_current": { status: 500, body: "x" },
    "api.weather.gov/points": json({ properties: { cwa: "EWX" } }), "api.weather.gov/alerts": json({ features: [] }),
    "power.larc.nasa.gov": json({ properties: { parameter: { WS10M: { ANN: 3 }, RH2M: { ANN: 50 } } } }),
    "echodata.epa.gov": json({ Results: { QueryRows: "0" } }),
    "www.fema.gov/api/open": json({ DisasterDeclarationsSummaries: [
      { disasterNumber: 3649, declarationDate: "2026-07-18T00:00:00.000Z", incidentType: "Flood", declarationType: "EM" },
      { disasterNumber: 4705, declarationDate: "2023-04-21T00:00:00.000Z", incidentType: "Winter Storm", declarationType: "DR" },
      { disasterNumber: 3649, declarationDate: "2026-07-18T00:00:00.000Z", incidentType: "Flood", declarationType: "EM" }] }),
  });
  const app = loadScripts(["config.js", "scoring.js", "sources.js"], { fetch });
  const more = plain(await app.get("lookupMore")({ lat: 30.2, lon: -98.4, stateFips: "48", countyFips: "031", state: "TX", county: "Blanco" }, ""));
  assert.deepEqual(more.failed, ["drought"]);
  assert.equal(more.people.county.population, 100);
  assert.deepEqual(more.crime, { needsKey: true });                // no crime key: no request to the FBI at all
  assert.equal(fetch.calls.some((c) => c.url.includes("api.usa.gov")), false);
  assert.equal(more.weather.office, "EWX");
  assert.equal(more.facilities.facilities, 0);
  assert.equal(more.disasters.count, 2);                         // the repeated disaster counts once
  assert.deepEqual(more.disasters.recent[0], { date: "2026-07-18", type: "Flood", kind: "emergency" });
  // The OData filter names the county and is spelled with %20, not "+", for the spaces.
  const call = fetch.calls.find((c) => c.url.includes("www.fema.gov")).url;
  assert.match(call, /\$filter=fipsStateCode%20eq%20'48'%20and%20fipsCountyCode%20eq%20'031'%20and%20declarationDate%20ge%20'\d{4}-\d{2}-\d{2}'/);
});
