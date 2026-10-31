"use strict";
// v2.5.0: two-ended sliders for the scoring ranges, and recommended values for what you plan to do on the land.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScripts, plain } = require("./load");

const app = loadScripts(["config.js", "scoring.js"]);
const PAIRS = plain(app.get("RANGE_PAIRS"));
const USES = plain(app.get("LAND_USES"));
const DEFAULTS = plain(app.get("DEFAULT_SETTINGS"));

test("every slider names two real settings, and the defaults point the right way", () => {
  for (const pair of PAIRS) {
    assert.ok(pair.good in DEFAULTS && pair.bad in DEFAULTS, `${pair.key} settings exist`);
    const [good, bad] = [DEFAULTS[pair.good], DEFAULTS[pair.bad]];
    if (pair.better === "lower") assert.ok(good < bad, `${pair.key}: full marks is below zero`);
    else assert.ok(good > bad, `${pair.key}: full marks is above zero`);
    assert.ok(good >= pair.min && good <= pair.max && bad >= pair.min && bad <= pair.max, `${pair.key} defaults fit the slider`);
    assert.ok(plain(app.get("SETTING_TIPS"))[pair.good] && plain(app.get("SETTING_TIPS"))[pair.bad], `${pair.key} boxes have tips`);
  }
  // Every scoring range in the settings has a slider (the detour factor and speed are single numbers).
  const covered = PAIRS.flatMap((p) => [p.good, p.bad]);
  assert.equal(new Set(covered).size, covered.length);
  assert.equal(covered.length, 16);
});

test("every use's recommendations point the right way, fit their slider, and name real criteria", () => {
  const criteria = Object.keys(plain(app.get("FACTOR_LABELS")));
  assert.deepEqual(Object.keys(USES).sort(), Object.keys(DEFAULTS.uses).sort());
  for (const [key, use] of Object.entries(USES)) {
    assert.ok(use.label && use.tip, `${key} has a label and a tip`);
    for (const [pairKey, [good, bad]] of Object.entries(use.ranges)) {
      const pair = PAIRS.find((p) => p.key === pairKey);
      assert.ok(pair, `${key}: ${pairKey} is a slider`);
      assert.ok(pair.better === "lower" ? good < bad : good > bad, `${key}: ${pairKey} points the right way`);
      assert.ok(good >= pair.min && bad <= pair.max && bad >= pair.min && good <= pair.max, `${key}: ${pairKey} fits the slider`);
    }
    assert.equal("price" in use.ranges || "airport" in use.ranges, false, `${key}: price and airport depend on you, not the use`);
    for (const c of use.criteria) assert.ok(criteria.includes(c), `${key}: ${c} is a criterion`);
  }
});

test("recommendedRanges: one use gives its own values; two uses give the stricter of each", () => {
  const rec = (uses) => plain(app.get("recommendedRanges")(uses));
  assert.deepEqual(rec({}), {});
  assert.deepEqual(rec({ farm: true }).slope, [3, 12]);
  const both = rec({ homestead: true, farm: true });
  assert.deepEqual(both.slope, [3, 12]);             // lower is better: the smaller numbers
  assert.deepEqual(both.rain, [35, 18]);             // higher is better: the larger numbers
  assert.deepEqual(both.groundwater, [50, 300]);
  assert.deepEqual(both.hospital, [30, 60]);
  assert.equal("internet" in rec({ farm: true }), false);   // farm has no view on internet
  assert.deepEqual(rec({ residential: true, homestead: true }).internet, [100, 10]);
  assert.deepEqual(rec({ farm: false, garden: true }), rec({ garden: true }));   // unticked uses count for nothing
});

test("suggestedCriteria lists each criterion once, in the default order", () => {
  const s = plain(app.get("suggestedCriteria")({ garden: true, livestock: true }));
  assert.deepEqual(s, ["slope", "rain", "flood", "groundwater", "agValuation"]);
  assert.deepEqual(plain(app.get("suggestedCriteria")({})), []);
  assert.equal(app.get("usesText")({ homestead: true, farm: true, garden: true }), "homestead, farm (crops or hay) and small vegetable garden");
  assert.equal(app.get("usesText")({ residential: true }), "residential home");
});

test("saved uses are loaded, unknown keys and non-true/false values are ignored", () => {
  const storage = loadScripts(["config.js", "scoring.js", "storage.js"], {
    localStorage: { getItem: (k) => (k.includes("settings") ? JSON.stringify({ uses: { farm: true, garden: "yes", bogus: true } }) : null), setItem() {}, removeItem() {} },
    document: { getElementById: () => ({ hidden: true }) },
  });
  const uses = plain(storage.get("loadSettings")()).uses;
  assert.equal(uses.farm, true);
  assert.equal(uses.garden, false);
  assert.equal(uses.homestead, false);
});
