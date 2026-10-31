"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadScripts } = require("./load");

const read = (...parts) => fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8");
const app = loadScripts(["config.js", "scoring.js"]);

test("the footer version matches package.json, the README and the SPEC", () => {
  const version = app.get("APP_VERSION");
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(JSON.parse(read("package.json")).version, version);
  assert.ok(read("README.md").includes(`- **v${version}**`), "README version history has an entry for this version");
  assert.ok(read("SPEC.md").includes(`Last updated for v${version}.`), "SPEC says it is up to date for this version");
  // The update date is a real year-month-day.
  assert.match(app.get("APP_UPDATED"), /^\d{4}-\d{2}-\d{2}$/);
});

test("every local script and stylesheet link carries the app version, so an update loads all its files together", () => {
  const html = read("index.html");
  const version = app.get("APP_VERSION");
  // Every <script src="js/..."> and <link href="css/..."> in the page, with what follows "?v=" (or nothing).
  const links = [...html.matchAll(/(?:src|href)="((?:js|css)\/[^"?]+)(?:\?v=([^"]*))?"/g)].map((m) => [m[1], m[2] || null]);
  assert.ok(links.length >= 6, "found the scripts and the stylesheet");
  assert.deepEqual(links.filter(([, v]) => v !== version), [], `every link should end in ?v=${version}`);
  // And every script file in js/ is loaded by the page.
  const scripts = fs.readdirSync(path.join(__dirname, "..", "js")).filter((f) => f.endsWith(".js")).map((f) => `js/${f}`);
  assert.deepEqual(scripts.filter((f) => !links.some(([p]) => p === f)), []);
});

test("the footer line spells out the date without slipping a day", () => {
  const versionText = app.get("versionText");
  assert.equal(versionText("2.2.0", "2026-10-31"), "Version 2.2.0, last updated October 31, 2026");
  assert.equal(versionText("1.0.0", "2027-01-01"), "Version 1.0.0, last updated January 1, 2027");
  assert.ok(read("index.html").includes('id="app-version"'), "the footer has a place for the version");
});

test("Settings links straight to the Census key sign-up page", () => {
  assert.equal(app.get("CENSUS_KEY_SIGNUP_URL"), "https://api.census.gov/data/key_signup.html");
  const ui = read("js", "ui.js");
  // The link sits right after the key box and opens in a new tab.
  const box = ui.indexOf('id="c-census-key"');
  const link = ui.indexOf('id="c-census-key-link"');
  assert.ok(box > 0 && link > box, "the link comes after the key box");
  assert.match(ui.slice(link, link + 200), /href="\$\{CENSUS_KEY_SIGNUP_URL\}" target="_blank" rel="noopener noreferrer"/);
  // The old hint pointed at the "Criteria" window, which is now called Settings.
  assert.equal(ui.includes("paste it into Criteria"), false);
});
