"use strict";
// v2.7.0: crime reported by the county sheriff, from the FBI's Crime Data Explorer (needs a free api.data.gov key).
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScripts, plain, fakeFetch } = require("./load");

const json = (obj) => ({ body: JSON.stringify(obj) });
const app = loadScripts(["config.js", "scoring.js", "sources.js"]);

// The shape of the real reply (checked from the live site for Blanco County, 2024), with made-up round numbers.
function offenseReply(agency, perMonth, year = 2025) {
  const months = Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(2, "0")}-${year}`);
  const each = (v) => Object.fromEntries(months.map((m) => [m, v]));
  return {
    offenses: {
      actuals: { [`${agency} Offenses`]: each(perMonth), [`${agency} Clearances`]: each(0) },
      rates: { "Texas Offenses": each(30), "United States Offenses": each(28), [`${agency} Offenses`]: each(10.5) },
    },
    populations: { population: { [agency]: each(9520), Texas: each(31290831) } },
  };
}

test("findSheriff picks the county sheriff, not a city police department", () => {
  const list = { BLANCO: [
    { ori: "TX0160100", agency_name: "Blanco Police Department", agency_type_name: "City" },
    { ori: "TX0160000", agency_name: "Blanco County Sheriff's Office", agency_type_name: "County" }] };
  const find = app.get("findSheriff");
  assert.equal(find(list, "Blanco").ori, "TX0160000");
  assert.equal(find(list, "Blanco County").ori, "TX0160000");
  assert.equal(find(list, "Kendall"), null);
  assert.equal(find(null, "Blanco"), null);
});

test("summarizeOffenses adds up a year and works out the rate per 100,000", () => {
  const out = plain(app.get("summarizeOffenses")(offenseReply("Blanco County Sheriff's Office", 2), "Blanco County Sheriff's Office", "Texas"));
  assert.deepEqual(out, { count: 24, months: 12, population: 9520, ratePer100k: 252.1, stateRate: 360, usRate: 336 });
  assert.equal(app.get("summarizeOffenses")({}, "X", "Texas"), null);
  // An agency that reported only some months is counted honestly, and the page says so.
  const partial = offenseReply("X", 1);
  for (const m of ["10-2025", "11-2025", "12-2025"]) delete partial.offenses.actuals["X Offenses"][m];
  assert.equal(app.get("summarizeOffenses")(partial, "X", "Texas").months, 9);
});

test("lookupCrime: no key means no request; a key finds the sheriff and asks for violent and property crime", async () => {
  const noKey = fakeFetch({});
  const quiet = loadScripts(["config.js", "scoring.js", "sources.js"], { fetch: noKey });
  assert.deepEqual(plain(await quiet.get("lookupCrime")("TX", "Blanco", "")), { needsKey: true });
  assert.equal(noKey.calls.length, 0);

  const agency = "Blanco County Sheriff's Office";
  const fetch = fakeFetch({
    "/agency/byStateAbbr/TX": json({ BLANCO: [{ ori: "TX0160000", agency_name: agency, agency_type_name: "County", state_name: "Texas" }] }),
    "/summarized/agency/TX0160000/V": json(offenseReply(agency, 1)),
    "/summarized/agency/TX0160000/P": json(offenseReply(agency, 3)),
  });
  const withKey = loadScripts(["config.js", "scoring.js", "sources.js"], { fetch });
  const crime = plain(await withKey.get("lookupCrime")("TX", "Blanco", "KEY 1"));
  assert.equal(crime.agency, agency);
  assert.equal(crime.year, new Date().getFullYear() - 1);
  assert.equal(crime.violent.count, 12);
  assert.equal(crime.property.count, 36);
  assert.ok(fetch.calls.every((c) => c.url.startsWith("https://api.usa.gov/crime/fbi/cde/")), "only the FBI's service is asked");
  assert.ok(fetch.calls.every((c) => c.url.includes("API_KEY=KEY%201")), "the key is sent, safely encoded");
  // The state's agency list is big, so it is fetched once per visit.
  await withKey.get("lookupCrime")("TX", "Blanco", "KEY 1");
  assert.equal(fetch.calls.filter((c) => c.url.includes("byStateAbbr")).length, 1);
});

test("lookupCrime: when the FBI's service fails for the last year, the year before is used", async () => {
  const agency = "Blanco County Sheriff's Office";
  const last = new Date().getFullYear() - 1;
  const fetch = fakeFetch({
    "/agency/byStateAbbr/TX": json({ BLANCO: [{ ori: "TX0160000", agency_name: agency, agency_type_name: "County", state_name: "Texas" }] }),
    [`from=01-${last}`]: { status: 503, body: "upstream connect error" },
    [`/V?from=01-${last - 1}`]: json(offenseReply(agency, 1, last - 1)),
    [`/P?from=01-${last - 1}`]: json(offenseReply(agency, 2, last - 1)),
  });
  const crime = plain(await loadScripts(["config.js", "scoring.js", "sources.js"], { fetch }).get("lookupCrime")("TX", "Blanco", "KEY"));
  assert.equal(crime.year, last - 1);
  assert.equal(crime.violent.count, 12);
  // Other errors (like the 429 "too many requests") are not hidden by trying another year.
  const busy = fakeFetch({
    "/agency/byStateAbbr/TX": json({ BLANCO: [{ ori: "TX0160000", agency_name: agency, agency_type_name: "County", state_name: "Texas" }] }),
    "/summarized/": { status: 429, body: "slow down" },
  });
  await assert.rejects(loadScripts(["config.js", "scoring.js", "sources.js"], { fetch: busy }).get("lookupCrime")("TX", "Blanco", "KEY"), /HTTP 429/);
});

test("lookupCrime: when the FBI's service does not answer at all for the last year, the year before is used", async () => {
  const agency = "Blanco County Sheriff's Office";
  const last = new Date().getFullYear() - 1;
  const answers = fakeFetch({
    "/agency/byStateAbbr/TX": json({ BLANCO: [{ ori: "TX0160000", agency_name: agency, agency_type_name: "County", state_name: "Texas" }] }),
    [`/V?from=01-${last - 1}`]: json(offenseReply(agency, 1, last - 1)),
    [`/P?from=01-${last - 1}`]: json(offenseReply(agency, 2, last - 1)),
  });
  // An error page without CORS headers reaches a web page only as "Failed to fetch".
  const fetch = async (url, options) => {
    if (String(url).includes(`from=01-${last}`)) throw new TypeError("Failed to fetch");
    return answers(url, options);
  };
  const crime = plain(await loadScripts(["config.js", "scoring.js", "sources.js"], { fetch }).get("lookupCrime")("TX", "Blanco", "KEY"));
  assert.equal(crime.year, last - 1);
});

test("a crime failure is explained in plain words, and More conditions keeps the reason", async () => {
  const text = app.get("crimeFailureText");
  assert.equal(text(undefined), "");
  assert.match(text("HTTP 429"), /hourly limit/);
  assert.match(text("HTTP 503"), /FBI's service had a problem.*\(HTTP 503\)/);
  assert.match(text("Timed out"), /too long/);
  assert.match(text("Failed to fetch"), /did not answer/);
  const fetch = fakeFetch({ "byStateAbbr": { status: 429, body: "slow down" } });
  const more = plain(await loadScripts(["config.js", "scoring.js", "sources.js"], { fetch })
    .get("lookupMore")({ lat: 30, lon: -98, state: "TX", county: "Blanco" }, "KEY", ["crime"]));
  assert.deepEqual(more.failed, ["crime"]);
  assert.equal(more.reasons.crime, "HTTP 429");
});

test("lookupCrime: a refused key asks for a new one; a county with no sheriff in the list says so", async () => {
  const refused = loadScripts(["config.js", "scoring.js", "sources.js"], { fetch: fakeFetch({ "byStateAbbr": { status: 403, body: "{}" } }) });
  assert.deepEqual(plain(await refused.get("lookupCrime")("TX", "Blanco", "BAD")), { needsKey: true, keyRejected: true });
  const empty = loadScripts(["config.js", "scoring.js", "sources.js"], { fetch: fakeFetch({ "byStateAbbr": json({ KENDALL: [] }) }) });
  assert.deepEqual(plain(await empty.get("lookupCrime")("TX", "Blanco", "KEY")), { agency: null });
  assert.equal(await empty.get("lookupCrime")("TX", null, "KEY"), null);
});

test("the people and crime sources are listed only when they answered", () => {
  const used = (more) => plain(app.get("sourceKeysUsed")({ site: { more } }));
  assert.ok(used({ failed: [], people: { county: {} } }).includes("censusReporter"));
  assert.equal(used({ failed: ["people"], people: null }).includes("censusReporter"), false);
  assert.ok(used({ failed: [], crime: { agency: "X" } }).includes("fbiCrime"));
  assert.equal(used({ failed: [], crime: { needsKey: true } }).includes("fbiCrime"), false);
});
