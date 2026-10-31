"use strict";
// v2.8.0: list columns you choose, sorting by any criterion (low to high or high to low), and a value filter.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScripts, plain } = require("./load");

const app = loadScripts(["config.js", "scoring.js"]);
const defaults = () => plain(app.get("DEFAULT_SETTINGS"));
const view = (changes) => ({ ...plain(app.get("DEFAULT_VIEW")), ...changes });
const item = (name, site, askingPrice = 100000) => {
  const parcel = { name, askingPrice, site };
  return { parcel, score: app.get("scoreParcel")(parcel, defaults()) };
};
const names = (items) => plain(items).map((it) => it.parcel.name);

const flat = item("Flat", { slopePct: 1, septicRating: "Very limited", annualRainIn: 30 }, 150000);
const steep = item("Steep", { slopePct: 14, septicRating: "Not limited" }, 90000);
const middle = item("Middle", { slopePct: 4.5, septicRating: "Somewhat limited" }, 120000);
const unknown = item("Unknown", {}, null);

test("criterionNumber gives each criterion's value in its unit, or its score for ratings", () => {
  const n = app.get("criterionNumber");
  const s = defaults();
  assert.equal(n("slope", flat.parcel, s), 1);
  assert.equal(n("price", steep.parcel, s), 90000);
  assert.equal(n("septic", flat.parcel, s), 15);              // a rating: its score
  assert.equal(n("internet", { site: { internet: { bestMbps: null, technologies: ["Satellite"] } } }, s), 0);
  assert.equal(n("slope", unknown.parcel, s), null);
  assert.equal(app.get("criterionUnit")("rain"), "in/year");
  assert.equal(app.get("criterionUnit")("septic"), "score");
});

test("sorting by a criterion goes low to high or high to low, and parcels with no data go last either way", () => {
  const apply = app.get("applyView");
  const s = defaults();
  const all = [steep, unknown, flat, middle];
  assert.deepEqual(names(apply(all, view({ sort: "crit:slope:asc" }), s)), ["Flat", "Middle", "Steep", "Unknown"]);
  assert.deepEqual(names(apply(all, view({ sort: "crit:slope:desc" }), s)), ["Steep", "Middle", "Flat", "Unknown"]);
  assert.deepEqual(names(apply(all, view({ sort: "crit:septic:desc" }), s)), ["Steep", "Middle", "Flat", "Unknown"]);   // by score
  assert.deepEqual(names(apply(all, view({ sort: "crit:price:asc" }), s)), ["Steep", "Middle", "Flat", "Unknown"]);   // $90k, $120k, $150k, none
  assert.equal(app.get("isKnownSort")("crit:slope:asc"), true);
  assert.equal(app.get("isKnownSort")("crit:bogus:asc"), false);
  assert.equal(app.get("isKnownSort")("price"), true);
});

test("the value filter keeps parcels at most or at least a value, and always keeps parcels with no data", () => {
  const apply = app.get("applyView");
  const s = defaults();
  const all = [steep, unknown, flat, middle];
  assert.deepEqual(names(apply(all, view({ sort: "crit:slope:asc", filter: { key: "slope", op: "max", value: 5 } }), s)), ["Flat", "Middle", "Unknown"]);
  assert.deepEqual(names(apply(all, view({ sort: "crit:slope:asc", filter: { key: "slope", op: "min", value: 5 } }), s)), ["Steep", "Unknown"]);
  assert.deepEqual(names(apply(all, view({ sort: "crit:price:asc", filter: { key: "price", op: "max", value: 120000 } }), s)), ["Steep", "Middle", "Unknown"]);
  // A rating filters on its score: septic at least 60 keeps Not limited (100) and Somewhat limited (60).
  assert.deepEqual(names(apply(all, view({ sort: "crit:slope:asc", filter: { key: "septic", op: "min", value: 60 } }), s)), ["Middle", "Steep", "Unknown"]);
  // No number yet, or an unknown criterion, filters nothing.
  assert.equal(apply(all, view({ filter: { key: "slope", op: "max", value: null } }), s).length, 4);
  assert.equal(apply(all, view({ filter: { key: "bogus", op: "max", value: 1 } }), s).length, 4);
});

test("a saved list view is cleaned up: unknown sorts, columns and filters are dropped", () => {
  const storage = loadScripts(["config.js", "scoring.js", "storage.js"], {
    localStorage: { getItem: (k) => (k.includes("view") ? JSON.stringify({ sort: "crit:bogus:asc", columns: ["slope", "bogus", "rain"],
      filter: { key: "slope", op: "between", value: 3 } }) : null), setItem() {}, removeItem() {} },
    document: { getElementById: () => ({ hidden: true }) },
  });
  const v = plain(storage.get("loadView")());
  assert.equal(v.sort, "score");
  assert.deepEqual(v.columns, ["slope", "rain"]);
  assert.equal(v.filter, null);
  const ok = loadScripts(["config.js", "scoring.js", "storage.js"], {
    localStorage: { getItem: (k) => (k.includes("view") ? JSON.stringify({ sort: "crit:slope:desc", filter: { key: "slope", op: "min", value: "x" } }) : null), setItem() {}, removeItem() {} },
    document: { getElementById: () => ({ hidden: true }) },
  });
  const v2 = plain(ok.get("loadView")());
  assert.equal(v2.sort, "crit:slope:desc");
  assert.deepEqual(v2.filter, { key: "slope", op: "min", value: null });
  assert.equal(v2.columns, null);
});
