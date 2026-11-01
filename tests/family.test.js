"use strict";
// v2.9.0: who is moving with you (family ages), the places each age needs, and Texas-designated delivery hospitals.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScripts, plain, fakeFetch } = require("./load");

const json = (obj) => ({ body: JSON.stringify(obj) });
const defaults = () => plain(loadScripts(["config.js"]).get("DEFAULT_SETTINGS"));
const app = loadScripts(["config.js", "scoring.js", "sources.js"], { settings: defaults() });

test("every family age names real kinds of places and real criteria, and has advice", () => {
  const kinds = plain(app.get("PLACE_KINDS")).map((k) => k.key);
  const criteria = Object.keys(plain(app.get("FACTOR_LABELS")));
  const stages = plain(app.get("FAMILY_STAGES"));
  assert.deepEqual(Object.keys(stages), Object.keys(defaults().family));
  for (const [key, stage] of Object.entries(stages)) {
    assert.ok(stage.label && stage.tip && stage.advice.length, `${key} has a label, tip and advice`);
    for (const place of stage.places) assert.ok(kinds.includes(place), `${key}: ${place} is a kind of place`);
    for (const c of stage.criteria) assert.ok(criteria.includes(c), `${key}: ${c} is a criterion`);
  }
});

test("family kinds of places are looked up only for the ages you tick", () => {
  const needed = (family) => plain(app.get("neededPlaceKinds")({ family })).map((k) => k.key);
  const everyday = needed({});
  assert.equal(everyday.includes("pediatrician"), false);
  assert.ok(everyday.includes("grocery") && everyday.includes("hospital"));
  const expecting = needed({ expecting: true });
  assert.ok(["obgyn", "pediatrician", "pharmacy"].every((k) => expecting.includes(k)));
  assert.equal(expecting.includes("playground"), false);
  assert.ok(needed({ toddler: true }).includes("playground"));
  assert.ok(needed({ prek: true }).includes("preschool"));
});

test("the Texas delivery and newborn hospitals are asked only when Expecting is ticked", () => {
  const pieces = app.get("texasPiecesNeeded");
  assert.deepEqual(plain(pieces({ family: {} })), plain(app.get("TEXAS_PIECES")));
  assert.deepEqual(plain(pieces({ family: { expecting: true } })).slice(-2), ["maternal", "neonatal"]);
  assert.deepEqual(plain(pieces({ family: { toddler: true } })), plain(app.get("TEXAS_PIECES")));
});

test("nearestDesignated keeps the three nearest hospitals, tidies names, and keeps only what the report needs", () => {
  const f = (name, city, x, y) => ({ attributes: { USER_Primary_Name: name, USER_Main_City: city, USER_Designate_Level: "II - Specialty Care",
    USER_Main_Address_1: "810 W HIGHWAY 71", Phone: "" }, geometry: { x, y } });
  const out = plain(app.get("nearestDesignated")([
    f("METHODIST HOSPITAL HILL COUNTRY", "FREDERICKSBURG", -98.881, 30.2619),
    f("BAYLOR SCOTT & WHITE MEDICAL CENTER - MARBLE FALLS", "MARBLE FALLS", -98.305, 30.5115),
    f("FAR AWAY HOSPITAL", "AMARILLO", -101.8, 35.2), f("ANOTHER ONE", "AUSTIN", -97.74, 30.27),
    { attributes: { USER_Primary_Name: "NO SHAPE" } },
  ], 30.275, -98.4));
  assert.equal(out.length, 3);
  assert.equal(out[0].name, "Baylor Scott & White Medical Center - Marble Falls");
  assert.equal(out[0].city, "Marble Falls");
  assert.equal(out[0].level, "II - Specialty Care");
  assert.ok(out[0].miles < out[1].miles && out[1].miles < out[2].miles);
  assert.deepEqual(Object.keys(out[0]).sort(), ["city", "lat", "level", "lon", "miles", "name"]);
});

test("the current DSHS layers are found from the DSHS map, with the last known ones as a fallback", async () => {
  const fetch = fakeFetch({
    "www.arcgis.com/sharing": json({ operationalLayers: [
      { title: "Trauma Designated Hospitals _ June 2026", url: "https://x/Trauma/FeatureServer/3" },
      { title: "Maternal Designated Hospitals _ June 2026", url: "https://x/Maternal_June/FeatureServer/0" },
      { title: "Neonatal Designated Hospitals _ June 2026", url: "https://x/Neonatal_June/FeatureServer/1" }] }),
    "Maternal_June/FeatureServer/0/query": json({ features: [{ attributes: { USER_Primary_Name: "A", USER_Designate_Level: "I - Basic Care", USER_Main_City: "B" }, geometry: { x: -98.3, y: 30.3 } }] }),
    "router.project-osrm.org": json({ code: "Ok", routes: [{ distance: 16093, duration: 1200 }] }),
  });
  const live = loadScripts(["config.js", "scoring.js", "sources.js"], { fetch, settings: defaults() });
  const out = plain(await live.get("lookupDesignated")("maternal", 30.275, -98.4));
  assert.equal(out.hospitals[0].name, "A");
  assert.equal(out.hospitals[0].driveMin, 20);
  assert.ok(fetch.calls.some((c) => c.url.includes("Maternal_June")), "the newer layer was used");

  const broken = loadScripts(["config.js", "scoring.js", "sources.js"], { fetch: fakeFetch({ "www.arcgis.com": { status: 500, body: "x" } }), settings: defaults() });
  assert.deepEqual(plain(await broken.get("dshsLayerUrls")()), plain(broken.get("TX_DSHS_FALLBACK_LAYERS")));
});

test("the three family criteria score from their drive times", () => {
  const s = defaults();
  const site = {
    texas: { maternal: { hospitals: [{ name: "H", miles: 17.5, driveMin: 60 }] } },
    places: { pediatrician: { name: "P", miles: 10, driveMin: 40 }, childcare: { name: "C", miles: 20, driveMin: 30 }, preschool: { name: "K", miles: 5, driveMin: 9 } },
  };
  const parts = plain(app.get("scoreParcel")({ site }, s).parts);
  assert.equal(parts.delivery, 50);            // 60 min, halfway between 30 and 90
  assert.equal(parts.pediatrician, 50);        // 40 min, halfway between 20 and 60
  assert.equal(parts.childcare, 100);          // the nearer of child care (30) and a preschool (9 min)
  const text = app.get("criterionValueText");
  assert.equal(text("childcare", { site }, s), "9 min to K");
  assert.equal(text("delivery", { site }, s), "60 min to H");
  assert.equal(text("delivery", { site: { texas: { maternal: { hospitals: [] } } } }, s), "none within 150 miles");
  assert.equal(text("delivery", { site: {} }, s), "no data");
  assert.equal(plain(app.get("scoreParcel")({ site: {} }, s).parts).delivery, null);
});

test("suggested criteria include the family ages'", () => {
  const suggest = app.get("suggestedCriteria");
  assert.deepEqual(plain(suggest({}, { expecting: true })), ["hospital", "delivery", "pediatrician"]);
  assert.deepEqual(plain(suggest({ garden: true }, { prek: true })), ["slope", "rain", "flood", "pediatrician", "childcare"]);
});
