"use strict";
// v2.12.0: finding addresses copied from listings. The street in every answer is checked, and Nominatim is the backup.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScripts, plain, fakeFetch } = require("./load");

const json = (obj) => ({ body: JSON.stringify(obj) });
const app = loadScripts(["config.js", "scoring.js", "sources.js"]);
const parse = (text) => plain(app.get("parseListingAddress")(text));

test("listing text is tidied: odd spaces, line breaks, the site's name and USA", () => {
  const clean = app.get("cleanAddressText");
  assert.equal(clean("100 Main St, Blanco, TX 78606"), "100 Main St, Blanco, TX 78606");
  assert.equal(clean("100 Main St\nBlanco, TX 78606"), "100 Main St, Blanco, TX 78606");
  assert.equal(clean("100 Main St, Blanco, TX 78606 | Zillow"), "100 Main St, Blanco, TX 78606");
  assert.equal(clean("100 Main St, Blanco, TX 78606 - Redfin"), "100 Main St, Blanco, TX 78606");
  assert.equal(clean("100 Main St, Blanco, TX 78606, USA"), "100 Main St, Blanco, TX 78606");
});

test("an address is split into its parts, in the ways listings write them", () => {
  const full = parse("500 Ranch Road 165, Blanco, TX 78606");
  assert.deepEqual([full.number, full.street, full.town, full.state, full.zip], ["500", "Ranch Road 165", "Blanco", "TX", "78606"]);
  const spelled = parse("Ranch Road 165, Blanco, Texas 78606");
  assert.deepEqual([spelled.number, spelled.town, spelled.state, spelled.zip], [null, "Blanco", "Texas", "78606"]);
  const sameBit = parse("100 Main St, Blanco TX 78606-1234");
  assert.deepEqual([sameBit.town, sameBit.state, sameBit.zip], ["Blanco", "TX", "78606"]);
  assert.equal(parse("100 Main St, Blanco").town, "Blanco");
  assert.equal(parse("100 Main St #4, Fredericksburg, TX 78624").street, "Main St");
  assert.equal(parse("100 Main St Apt 4, Fredericksburg, TX 78624").street, "Main St");
  const noCommas = parse("100 Main St Blanco TX 78606");
  assert.deepEqual([noCommas.number, noCommas.street, noCommas.state, noCommas.zip, noCommas.loose], ["100", "Main St Blanco", "TX", "78606", true]);
});

test("words that stand in for a house number are not treated as one", () => {
  for (const text of ["TBD Hwy 281, Johnson City, TX 78636", "0 Hwy 281, Johnson City, TX 78636", "Lot 12 Hwy 281, Johnson City, TX 78636",
    "Tract 5 Hwy 281, Johnson City, TX 78636", "Lot 12 Block 3 Hwy 281, Johnson City, TX 78636", "Lot 12, Hwy 281, Johnson City, TX 78636".replace("Lot 12, ", "Lot 12 ")]) {
    const parts = parse(text);
    assert.equal(parts.number, null, text);
    assert.equal(parts.street, "Hwy 281", text);
  }
});

test("two spellings of a street count as the same street, and different streets do not", () => {
  const same = app.get("sameStreet");
  assert.ok(same("Farm to Market Rd 2325", "FM 2325"));
  assert.ok(same("County Road 340", "CO RD 340"));
  assert.ok(same("CR 340", "County Road 340"));
  assert.ok(same("Hwy 281", "US HWY 281"));
  assert.ok(same("N US Highway 281", "US HWY 281"));
  assert.ok(same("Main St", "W MAIN ST"));
  assert.ok(same("Ranch Road 165", "RM 165"));
  // These wrong answers really came back from the Census on 2026-11-02.
  assert.equal(same("Oak Hollow Trl", "OAK LN"), false);
  assert.equal(same("Cypress Creek Rd", "CYPRESS CIR"), false);
  assert.equal(same("RR 165", "BLANCO AVE"), false);
  assert.equal(same("County Road 216", "Hayden Lane"), false);
  assert.equal(same("Private Road 1520", "Private Road 1718"), false);
  // With no commas, what was asked holds the town as well.
  assert.ok(same("Main St Blanco", "W MAIN ST", true));
  assert.equal(same("Main St Blanco", "OAK LN", true), false);
});

const findWith = (routes, census) => {
  const fetch = fakeFetch(routes);
  const scripts = loadScripts(["config.js", "scoring.js", "sources.js"], { fetch });
  return (text) => scripts.get("findAddress")(text, { census, gapMs: 0 }).then(plain);
};
const noCensus = async () => null;
const center = { "postalcode=78606": json([{ lat: "30.1", lon: "-98.4" }]) };
const road = (name, lat = "30.15", lon = "-98.45", extra = {}) => ({ lat, lon, name, address: { road: name, ...extra }, display_name: `${name}, Texas` });

test("findAddress: a right Census answer is used as it is, with no other service asked", async () => {
  const census = async () => ({ lat: 30, lon: -98, matched: "1234 CO RD 340, BURNET, TX, 78611" });
  const found = await findWith({}, census)("1234 County Road 340, Burnet, TX 78611");
  assert.equal(found.precision, "exact");
  assert.equal(found.lat, 30);
});

test("findAddress: a Census answer on another street is not used", async () => {
  const census = async () => ({ lat: 1, lon: 1, matched: "120 OAK LN, DRIPPING SPRINGS, TX, 78620" });
  const found = await findWith({ "postalcode=78620": json([{ lat: "30.2", lon: "-98.1" }]), "search?": json([]) }, census)("120 Oak Hollow Trl, Dripping Springs, TX 78620");
  assert.deepEqual(found, { near: { lat: 30.2, lon: -98.1 }, area: "78620" });
});

test("findAddress: a street with no house number lands on the street and says so", async () => {
  const found = await findWith({ ...center, "q=Ranch": json([road("Ranch Road 165")]) }, noCensus)("TBD Ranch Road 165, Blanco, TX 78606");
  assert.equal(found.precision, "street");
  assert.equal(found.lat, 30.15);
});

test("findAddress: OpenStreetMap's own house number counts as exact", async () => {
  const found = await findWith({ ...center, "q=500": json([road("Ranch Road 165", "30.15", "-98.45", { house_number: "500" })]) }, noCensus)("500 Ranch Road 165, Blanco, TX 78606");
  assert.equal(found.precision, "exact");
});

test("findAddress: a same-named street far from the ZIP, or another street nearby, is not used", async () => {
  const far = await findWith({ ...center, "q=Cypress": json([road("Cypress Creek Road", "33.08", "-97.12")]) }, noCensus)("Lot 12 Cypress Creek Rd, Blanco, TX 78606");
  assert.deepEqual(far, { near: { lat: 30.1, lon: -98.4 }, area: "78606" });
  const other = await findWith({ ...center, "q=County": json([road("Hayden Lane")]) }, noCensus)("TBD County Road 216, Blanco, TX 78606");
  assert.ok(other.near);
});

test("findAddress: of several right streets, the one nearest the ZIP is used", async () => {
  const found = await findWith({ ...center, "q=Oak": json([road("Oak Rd", "30.3", "-98.4"), road("Oak Rd", "30.11", "-98.4")]) }, noCensus)("TBD Oak Rd, Blanco, TX 78606");
  assert.equal(found.lat, 30.11);
});

test("findAddress: fails soft: nothing known gives null, and only every service failing is an error", async () => {
  assert.equal(await findWith({}, noCensus)("1 Nowhere Road, Nowhere"), null);
  const census = async () => { throw new Error("Request failed"); };
  await assert.rejects(findWith({ "search?": { status: 503, body: "" } }, census)("100 Main St, Blanco, TX 78606"));
  // The Census being down does not stop the backup.
  const found = await findWith({ ...center, "q=100": json([road("Main St", "30.11", "-98.4", { house_number: "100" })]) }, census)("100 Main St, Blanco, TX 78606");
  assert.equal(found.precision, "exact");
});
