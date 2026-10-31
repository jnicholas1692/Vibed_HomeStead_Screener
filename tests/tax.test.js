"use strict";
// v2.6.0: Texas acres filled in from the appraisal record, tax exemptions you enter, and the ag or wildlife valuation criterion.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScripts, plain } = require("./load");

const app = loadScripts(["config.js", "scoring.js", "sources.js"]);
const defaults = () => plain(app.get("DEFAULT_SETTINGS"));
const record = (attributes) => plain(app.get("summarizeTxParcel")([{ attributes }]));

test("the Texas record now keeps the year built and the state land category (still never the owner)", () => {
  const r = record({ PROP_ID: "83787", LEGAL_AREA: "362.51", MKT_VALUE: "2981650", IMP_VALUE: "0", YEAR_BUILT: "2005", STAT_LAND_USE: "D1",
    OWNER_NAME: "SECRET OWNER", SITUS_ADDR: "99 SECRET LANE" });
  assert.equal(r.yearBuilt, 2005);
  assert.equal(r.stateCategory, "D1");
  assert.equal(r.openSpaceLikely, true);
  assert.equal(/SECRET/.test(JSON.stringify(r)), false);
  // Real replies have "Null" in these fields for most counties.
  const blank = record({ PROP_ID: "1", YEAR_BUILT: "Null", STAT_LAND_USE: "Null" });
  assert.equal(blank.yearBuilt, null);
  assert.equal(blank.openSpaceLikely, false);
  assert.equal(record({ STAT_LAND_USE: "D2" }).openSpaceLikely, false);   // D2 is farm buildings, not the land's valuation
  assert.equal(record({ YEAR_BUILT: "0" }).yearBuilt, null);
});

test("acres left blank are filled in from the appraisal record; acres you entered are kept", () => {
  const fill = app.get("fillAcresFromAppraisal");
  const blank = { acres: null, site: { texas: { parcel: { appraisalAcres: 362.51 } } } };
  fill(blank);
  assert.equal(blank.acres, 362.51);
  assert.equal(blank.acresSource, "appraisal");
  const yours = { acres: 300, site: { texas: { parcel: { appraisalAcres: 362.51 } } } };
  fill(yours);
  assert.equal(yours.acres, 300);
  assert.equal(yours.acresSource, undefined);
  const none = { acres: null, site: {} };
  fill(none);
  assert.equal(none.acres, null);
});

test("exemptionsText says what you ticked, None when you checked, and null when you have not said", () => {
  const text = app.get("exemptionsText");
  assert.equal(text({ ag: true, homestead: true }), "Ag (open-space) valuation, homestead exemption");
  assert.equal(text({ wildlife: true }), "Wildlife management valuation");
  assert.equal(text({ none: true }), "None");
  assert.equal(text({ ag: false, wildlife: false, homestead: false, none: false }), null);
  assert.equal(text(null), null);
});

test("the ag or wildlife criterion: your answer wins, then a Texas D1 record, otherwise no data", () => {
  const s = defaults();
  const score = (parcel) => plain(app.get("scoreParcel")(parcel, s)).parts.agValuation;
  assert.equal(score({ exemptions: { ag: true }, site: {} }), 100);
  assert.equal(score({ exemptions: { wildlife: true }, site: {} }), 100);
  assert.equal(score({ exemptions: { none: true }, site: {} }), 0);
  assert.equal(score({ exemptions: { homestead: true }, site: {} }), null);   // a homestead exemption says nothing about ag use
  assert.equal(score({ site: { texas: { parcel: { openSpaceLikely: true } } } }), 100);
  assert.equal(score({ exemptions: { none: true }, site: { texas: { parcel: { openSpaceLikely: true } } } }), 0);   // what you checked wins
  assert.equal(score({ site: {} }), null);
  const text = app.get("criterionValueText");
  assert.equal(text("agValuation", { site: { texas: { parcel: { openSpaceLikely: true } } } }, s), "Likely (Texas land category D1)");
  assert.equal(text("agValuation", { exemptions: { ag: true }, site: {} }, s, true), "Yes");
  // Its dealbreaker only fires on a confirmed no.
  s.dealbreakers.agValuation = true;
  assert.ok(plain(app.get("scoreParcel")({ exemptions: { none: true }, site: {} }, s).dealbreakers).includes("No ag or wildlife valuation"));
  assert.equal(app.get("scoreParcel")({ site: {} }, s).dealbreakers.length, 0);
});

test("appraisalDistrictUrl matches the Comptroller's page names (checked for all 254 counties)", () => {
  const url = app.get("appraisalDistrictUrl");
  assert.equal(url("Blanco"), "https://comptroller.texas.gov/taxes/property-tax/county-directory/blanco.php");
  assert.equal(url("Fort Bend"), "https://comptroller.texas.gov/taxes/property-tax/county-directory/fortbend.php");
  assert.equal(url("BLANCO"), "https://comptroller.texas.gov/taxes/property-tax/county-directory/blanco.php");
  assert.equal(url(null), "https://comptroller.texas.gov/taxes/property-tax/county-directory/");
});

test("the yearly tax estimate uses the county's typical rate when known, otherwise your own", () => {
  const s = defaults();
  const est = (site) => plain(app.get("estimatedTaxBeforeExemptions")({ site }, s));
  assert.deepEqual(est({ texas: { parcel: { marketValue: 300000 } }, taxRate: { ratePct: 1.5 } }), { amount: 4500, ratePct: 1.5, source: "county" });
  assert.deepEqual(est({ texas: { parcel: { marketValue: 300000 } } }), { amount: 3000, ratePct: 1, source: "setting" });
  s.costs.useCountyTax = false;
  assert.equal(est({ texas: { parcel: { marketValue: 300000 } }, taxRate: { ratePct: 1.5 } }).source, "setting");
  assert.equal(app.get("estimatedTaxBeforeExemptions")({ site: {} }, s), null);
});

test("the compare table shows exemptions, unless the criterion is ticked and already shows them", () => {
  const s = defaults();
  const items = [{ exemptions: { ag: true }, site: {} }, { site: {} }].map((parcel) => ({ parcel: { name: "P", ...parcel }, score: app.get("scoreParcel")(parcel, s) }));
  const rows = plain(app.get("buildComparison")(items, s));
  assert.deepEqual(rows.find((r) => r.label === "Tax exemptions").cells.map((c) => c.text), ["Ag (open-space) valuation", "unknown"]);
  s.criteria.on.agValuation = true;
  const ticked = plain(app.get("buildComparison")(items, s));
  assert.equal(ticked.find((r) => r.label === "Tax exemptions"), undefined);
  assert.match(ticked.find((r) => r.label === "Ag or wildlife valuation").cells[0].text, /^Yes \(you entered\) \(score 100\)$/);
});
