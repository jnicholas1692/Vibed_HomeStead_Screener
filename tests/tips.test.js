"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadScripts, plain } = require("./load");

const ui = fs.readFileSync(path.join(__dirname, "..", "js", "ui.js"), "utf8");
const app = loadScripts(["config.js", "scoring.js"]);

test("every number box in Settings has a hover explanation", () => {
  const tips = plain(app.get("SETTING_TIPS"));
  const block = (name) => ui.slice(ui.indexOf(`const ${name} = [`), ui.indexOf("];", ui.indexOf(`const ${name} = [`)));
  const paths = [...(block("SCORING_FIELDS") + block("COST_FIELDS")).matchAll(/\["[^"]+", "([^"]+)"\]/g)].map((m) => m[1]);
  assert.ok(paths.length >= 20, "found the settings boxes");
  assert.deepEqual(paths.filter((p) => !tips[p]), []);
});

test("every report section and fixed button named in the page has a hover explanation", () => {
  const sections = plain(app.get("REPORT_SECTIONS")).map((s) => s[0]);
  const tips = plain(app.get("SECTION_TIPS"));
  assert.deepEqual(sections.filter((k) => !tips[k]), []);
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const uiTips = plain(app.get("UI_TIPS"));
  for (const id of Object.keys(uiTips)) {
    // Some of these elements are made later by ui.js (the Settings window), so look in both files.
    assert.ok(html.includes(`id="${id}"`) || ui.includes(`id="${id}"`), `${id} exists`);
  }
  for (const id of ["btn-add", "btn-criteria", "btn-export", "btn-import", "btn-clear", "btn-compare", "f-name", "f-address", "f-lat", "f-lon", "f-acres", "f-price"]) {
    assert.ok(uiTips[id], `${id} has a tip`);
  }
});

test("the septic tip explains the scores, and factor tips use the current ranges", () => {
  const tip = app.get("glossaryTip")("Septic suitability");
  assert.match(tip, /100/); assert.match(tip, /60/); assert.match(tip, /15/);
  assert.match(app.get("glossaryTip")("Price"), /\$100,000/);   // the default full-marks price
  assert.match(app.get("glossaryTip")("Airport distance"), /75 minutes/);
});

test("hunting is gone from the settings, the factors and the tips", () => {
  assert.equal("hunting" in plain(app.get("DEFAULT_SETTINGS.criteria.on")), false);
  assert.equal("hunting" in plain(app.get("FACTOR_LABELS")), false);
  assert.equal(/hunt/i.test(ui.replace(/removed/g, "")), false);
  assert.equal(/hunt/i.test(fs.readFileSync(path.join(__dirname, "..", "js", "config.js"), "utf8")), false);
});

test("every report section is in exactly one category, and grouping follows your order", () => {
  const sections = plain(app.get("REPORT_SECTIONS")).map((s) => s[0]);
  const groups = plain(app.get("REPORT_GROUPS"));
  const all = groups.flatMap((g) => g[2]);
  assert.deepEqual([...all].sort(), [...sections].sort());
  assert.equal(new Set(all).size, all.length);
  for (const [key] of groups) assert.ok(plain(app.get("GROUP_TIPS"))[key], `${key} has a tip`);
  const grouped = plain(app.get("groupSections")(plain(app.get("DEFAULT_SETTINGS.reportOrder"))));
  assert.deepEqual(grouped.flatMap((g) => g.sections).sort(), [...sections].sort());
  // Moving a section to the front brings its category to the front, and the others keep their order.
  const reordered = ["cost", ...sections.filter((k) => k !== "cost")];
  const g2 = plain(app.get("groupSections")(reordered));
  assert.equal(g2[0].key, "money");
  assert.equal(g2[1].key, "overview");
  assert.deepEqual(plain(app.get("groupSections")(["roads", "soilDetails", "internet"])).map((g) => [g.key, g.sections]), [["access", ["roads", "internet"]], ["land", ["soilDetails"]]]);
  assert.equal(app.get("groupLabelOf")("texas"), "Texas");
});
