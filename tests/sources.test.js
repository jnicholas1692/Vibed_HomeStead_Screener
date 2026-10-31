const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScripts, plain, fakeFetch } = require("./load");

const near = (actual, expected, tolerance) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not close to ${expected}`);

// ---- pure helpers ----
const pure = loadScripts(["config.js", "sources.js"]);

test("technology codes map to names people recognize", () => {
  const techName = pure.get("techName");
  assert.equal(techName("10"), "DSL");
  assert.equal(techName("11"), "DSL");
  assert.equal(techName("42"), "Cable");
  assert.equal(techName("50"), "Fiber");
  assert.equal(techName("60"), "Satellite");
  assert.equal(techName("70"), "Fixed wireless");
  assert.equal(techName("999"), "Other");
});

test("internet summary skips business-only rows and ignores satellite for the best speed", () => {
  const rows = [
    { providername: "Skybeam", techcode: "70", consumer: "1", maxaddown: "50", maxadup: "5" },
    { providername: "Business Only", techcode: "50", consumer: "0", maxaddown: "1000", maxadup: "1000" },
    { providername: "ViaSat", techcode: "60", consumer: "1", maxaddown: "100", maxadup: "3" },
    { providername: "Frontier", techcode: "10", consumer: "1", maxaddown: "6", maxadup: "1" },
  ];
  const summary = plain(pure.get("summarizeInternet")(rows, "480319501003088"));
  assert.equal(summary.bestMbps, 50);
  assert.equal(summary.providers.length, 3);
  assert.equal(summary.providers[0].name, "ViaSat");           // sorted fastest first
  assert.deepEqual(summary.technologies.sort(), ["DSL", "Fixed wireless", "Satellite"]);
});

test("internet summary with only satellite has no best wired speed", () => {
  const rows = [{ providername: "ViaSat", techcode: "60", consumer: "1", maxaddown: "100", maxadup: "3" }];
  assert.equal(pure.get("summarizeInternet")(rows, "x").bestMbps, null);
});

test("distance between the two airports is about 66 miles", () => {
  const haversine = pure.get("haversineMiles");
  near(haversine(30.1945, -97.6699, 29.5337, -98.4698), 66, 3);
  assert.equal(haversine(30, -98, 30, -98), 0);
});

test("nearest airport picks the closer one from the list it is given", () => {
  const nearestAirport = pure.get("nearestAirport");
  const airports = plain(pure.get("AIRPORT_PRESETS"));
  assert.equal(nearestAirport(30.2672, -97.7431, airports).nearestAirport, "Austin (AUS)");
  assert.equal(nearestAirport(29.4241, -98.4936, airports).nearestAirport, "San Antonio (SAT)");
  // A custom list changes the answer: only Dallas is allowed here.
  const dallas = [{ name: "Dallas (DFW)", lat: 32.8998, lon: -97.0403 }];
  assert.equal(nearestAirport(30.2672, -97.7431, dallas).nearestAirport, "Dallas (DFW)");
});

test("airport text box: parses lines, allows commas in names, rejects bad lines", () => {
  const parseAirports = pure.get("parseAirports");
  const ok = plain(parseAirports("Austin (AUS), 30.1945, -97.6699\nHouston, Bush (IAH), 29.99, -95.33\n"));
  assert.equal(ok.airports.length, 2);
  assert.equal(ok.airports[1].name, "Houston, Bush (IAH)");
  assert.ok(parseAirports("Nowhere, abc, 10").error);
  assert.ok(parseAirports("Pole, 95, 10").error);          // latitude out of range
  assert.ok(parseAirports("just a name").error);
  assert.ok(parseAirports("   ").error);                   // at least one airport is required
});

test("60 meters north changes latitude by about 0.00054 degrees", () => {
  const [lat, lon] = pure.get("offsetPoint")(30, -98, 60, 0);
  near(lat - 30, 0.00054, 0.00002);
  assert.equal(lon, -98);
});

// ---- lookups, with fake web replies shaped like the real ones ----
test("elevation: plain-text reply (open ocean) means no data", async () => {
  const app = loadScripts(["config.js", "sources.js"], {
    fetch: fakeFetch({ "epqs.nationalmap.gov": { body: "Invalid or missing input parameters." } }),
  });
  assert.equal(await app.get("elevationFt")(26.0, -95.0), null);
});

test("elevation: reads the value", async () => {
  const app = loadScripts(["config.js", "sources.js"], {
    fetch: fakeFetch({ "epqs.nationalmap.gov": { body: '{"value": 487.1}' } }),
  });
  near(await app.get("elevationFt")(30.27, -97.74), 487.1, 0.001);
});

test("elevation: a server error is a failure, not 'no data'", async () => {
  const app = loadScripts(["config.js", "sources.js"], {
    fetch: fakeFetch({ "epqs.nationalmap.gov": { status: 500, body: "oops" } }),
  });
  await assert.rejects(() => app.get("elevationFt")(30.27, -97.74), /HTTP 500/);
});

test("soil: sends the format name USDA accepts and reads the table", async () => {
  const fetchFn = fakeFetch({
    "sdmdataaccess": { body: JSON.stringify({ Table: [
      ["soil_name", "drainage_class", "septic_rating"],
      ["Anhalt clay, 1 to 3 percent slopes", "Well drained", "Very limited"]] }) },
  });
  const app = loadScripts(["config.js", "sources.js"], { fetch: fetchFn });
  const soil = plain(await app.get("lookupSoil")(30.275, -98.4));
  assert.equal(soil.septicRating, "Very limited");
  assert.equal(fetchFn.calls[0].options.body.get("format"), "JSON+COLUMNNAME");
  assert.ok(fetchFn.calls[0].options.body.get("query").includes("POINT(-98.4 30.275)")); // longitude first
});

test("flood: 0.2 percent subtype becomes 'X (shaded)'", async () => {
  const reply = (zone, subtype) => ({ body: JSON.stringify({ features: [{ attributes: { FLD_ZONE: zone, ZONE_SUBTY: subtype } }] }) });
  const make = (r) => loadScripts(["config.js", "sources.js"], { fetch: fakeFetch({ hazards: r }) });
  assert.equal(await make(reply("X", "0.2 PCT ANNUAL CHANCE FLOOD HAZARD")).get("lookupFlood")(30, -98), "X (shaded)");
  assert.equal(await make(reply("X", "AREA OF MINIMAL FLOOD HAZARD")).get("lookupFlood")(30, -98), "X");
  assert.equal(await make({ body: '{"features": []}' }).get("lookupFlood")(30, -98), null);
});

test("internet: finds the 2010 census block, then asks for its providers", async () => {
  const fetchFn = fakeFetch({
    "geo.fcc.gov": { body: '{"Block": {"FIPS": "480319501003088"}}' },
    "opendata.fcc.gov": { body: JSON.stringify([{ providername: "Skybeam", techcode: "70", consumer: "1", maxaddown: "50", maxadup: "5" }]) },
  });
  const app = loadScripts(["config.js", "sources.js"], { fetch: fetchFn });
  const result = plain(await app.get("lookupInternet")(30.275, -98.4));
  assert.equal(result.bestMbps, 50);
  assert.ok(fetchFn.calls[0].url.includes("censusYear=2010"));
  assert.ok(fetchFn.calls[1].url.includes("blockcode=480319501003088"));
});

// ---- nearby places ----
const overpassReply = (elements) => ({ body: JSON.stringify({ elements }) });

test("places: picks the nearest of each kind, reads way centers, classifies by tags", async () => {
  const elements = [
    { type: "node", lat: 30.30, lon: -98.40, tags: { shop: "supermarket", name: "Far Market" } },
    { type: "node", lat: 30.28, lon: -98.40, tags: { shop: "supermarket", name: "Near Market" } },
    { type: "way", center: { lat: 30.29, lon: -98.41 }, tags: { shop: "agrarian", name: "Hill Country Feed" } },
    { type: "node", lat: 30.27, lon: -98.45, tags: { amenity: "veterinary" } },                   // unnamed
    { type: "node", lat: 30.40, lon: -98.50, tags: { shop: "wholesale", brand: "Costco", name: "Costco Wholesale" } },
    { type: "node", lat: 30.31, lon: -98.39, tags: { shop: "doityourself", name: "Big Hardware" } },
    { type: "node", lat: 30.2751, lon: -98.4, tags: { shop: "bakery", name: "Feed Me Bakery" } },  // has "feed" but is a bakery
    { type: "node", lat: 30.50, lon: -98.40, tags: { shop: "doityourself", name: "Tractor Supply Co." } },
    { type: "node", lat: 30.2755, lon: -98.4, tags: { amenity: "school", name: "Mystery School" } },        // no level clues: matches nothing
    { type: "node", lat: 30.30, lon: -98.4, tags: { amenity: "school", name: "Oak Elementary", grades: "K-5" } },
    { type: "node", lat: 30.276, lon: -98.4, tags: { amenity: "school", name: "Valley School", grades: "K-8" } },   // counts as elementary and middle
    { type: "node", lat: 30.35, lon: -98.4, tags: { amenity: "school", name: "Blanco High School" } },
    { type: "node", lat: 30.40, lon: -98.4, tags: { amenity: "fire_station", name: "Far Fire Dept" } },
    { type: "node", lat: 30.28, lon: -98.4, tags: { amenity: "fire_station", name: "Blanco Volunteer Fire" } },
    { type: "node", lat: 30.30, lon: -98.4, tags: { amenity: "police", name: "Blanco County Sheriff" } },
    { type: "node", lat: 30.2756, lon: -98.4, tags: { amenity: "hospital", name: "Urgent Care Annex", emergency: "no" } },   // no emergency room: skipped
    { type: "way", center: { lat: 30.32, lon: -98.4 }, tags: { amenity: "hospital", name: "Regional Medical", emergency: "yes" } },
  ];
  const fetchFn = fakeFetch({ "overpass-api.de": overpassReply(elements) });
  const app = loadScripts(["config.js", "sources.js"], { fetch: fetchFn });
  const places = plain(await app.get("lookupPlaces")(30.275, -98.4));
  assert.equal(places.grocery.name, "Near Market");
  assert.equal(places.feed.name, "Hill Country Feed");
  assert.equal(places.hardware.name, "Big Hardware");
  assert.equal(places.costco.name, "Costco Wholesale");
  assert.equal(places.vet.name, "Veterinarian (unnamed)");
  assert.equal(places.elementary.name, "Valley School");        // K-8 is nearer than Oak Elementary
  assert.equal(places.middle.name, "Valley School");            // the same school serves two levels
  assert.equal(places.high.name, "Blanco High School");
  assert.equal(places.fire.name, "Blanco Volunteer Fire");
  assert.equal(places.police.name, "Blanco County Sheriff");
  assert.equal(places.hospital.name, "Regional Medical");        // the nearer hospital is marked emergency=no
  assert.equal(fetchFn.calls.length, 1);                      // everything found at the first radius
});

test("schoolLevels: grades first, then the level tag, then the name; unknown is not guessed", () => {
  const levels = (tags) => [...pure.get("schoolLevels")(tags)].sort();
  assert.deepEqual(levels({ grades: "K-5" }), ["elementary"]);
  assert.deepEqual(levels({ grades: "PK-8" }), ["elementary", "middle"]);
  assert.deepEqual(levels({ grades: "6-8" }), ["middle"]);
  assert.deepEqual(levels({ grades: "9-12" }), ["high"]);
  assert.deepEqual(levels({ grades: "K-12" }), ["elementary", "high", "middle"]);
  assert.deepEqual(levels({ grades: "7-12" }), ["high", "middle"]);
  assert.deepEqual(levels({ "isced:level": "1" }), ["elementary"]);
  assert.deepEqual(levels({ "isced:level": "2;3" }), ["high", "middle"]);
  assert.deepEqual(levels({ "isced:level": "0" }), []);                       // preschool only
  assert.deepEqual(levels({ grades: "K-5", name: "Central High School" }), ["elementary"]);   // grades win over the name
  assert.deepEqual(levels({ name: "Hill Country Elementary School" }), ["elementary"]);
  assert.deepEqual(levels({ name: "Lincoln Junior High School" }), ["middle"]);   // not also a high school
  assert.deepEqual(levels({ name: "Blanco Middle School" }), ["middle"]);
  assert.deepEqual(levels({ name: "Johnson City High" }), ["high"]);
  assert.deepEqual(levels({ name: "High Plains Elementary" }), ["elementary"]);   // "High" alone in the name is not a high school
  assert.deepEqual(levels({ name: "Highland Park School" }), []);
  assert.deepEqual(levels({}), []);
});

test("places: the hospital query skips hospitals marked as having no emergency department", () => {
  const app = loadScripts(["config.js", "sources.js"]);
  const hospital = app.get("PLACE_KINDS").find((k) => k.key === "hospital");
  const query = app.get("buildPlacesQuery")(30, -98, 12000, [hospital]);
  assert.ok(query.includes('["amenity"="hospital"]["emergency"!="no"]'));
  assert.equal(hospital.test({ amenity: "hospital" }), true);                  // untagged: kept
  assert.equal(hospital.test({ amenity: "hospital", emergency: "yes" }), true);
  assert.equal(hospital.test({ amenity: "hospital", emergency: "no" }), false);
  assert.equal(hospital.test({ amenity: "clinic" }), false);
});

test("places: the three school kinds share one Overpass filter, asked once", () => {
  const app = loadScripts(["config.js", "sources.js"]);
  const kinds = plain(app.get("PLACE_KINDS")).filter((k) => ["elementary", "middle", "high"].includes(k.key));
  const real = app.get("PLACE_KINDS").filter((k) => ["elementary", "middle", "high"].includes(k.key));
  const query = app.get("buildPlacesQuery")(30, -98, 12000, real);
  assert.equal(kinds.length, 3);
  assert.equal(query.split('["amenity"="school"]').length - 1, 1);
});

test("places: searches wider only for kinds not found yet; null when nothing is found", async () => {
  const queries = [];
  const fetchFn = async (url, options) => {
    const query = options.body.get("data");
    queries.push(query);
    const wide = query.includes("around:80000") || query.includes("around:120000");
    const elements = wide ? [{ type: "node", lat: 30.9, lon: -98.4, tags: { brand: "Costco", name: "Costco" } }] : [
      { type: "node", lat: 30.28, lon: -98.4, tags: { shop: "supermarket", name: "Market" } }];
    return { ok: true, status: 200, text: async () => JSON.stringify({ elements }) };
  };
  const app = loadScripts(["config.js", "sources.js"], { fetch: fetchFn });
  const places = plain(await app.get("lookupPlaces")(30.275, -98.4));
  assert.equal(places.grocery.name, "Market");
  assert.equal(places.costco.name, "Costco");
  assert.equal(places.vet, null);                              // never found, even at 120 km
  assert.ok(queries.length >= 2);
  assert.ok(!queries[1].includes("supermarket"));              // grocery was already found
  assert.ok(queries[0].includes("around:12000") && queries[1].includes("around:25000"));   // small circles first
});

test("places: falls back to another server when the first fails", async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(String(url));
    if (String(url).includes("overpass-api.de")) return { ok: false, status: 429, text: async () => "busy" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ elements: [] }) };
  };
  const app = loadScripts(["config.js", "sources.js"], { fetch: fetchFn });
  const places = plain(await app.get("lookupPlaces")(30.275, -98.4));
  assert.ok(urls.some((u) => u.includes("overpass.openstreetmap.fr")));
  assert.equal(places.grocery, null);
});

test("places: every server failing is reported as a failure", async () => {
  const fetchFn = async () => ({ ok: false, status: 504, text: async () => "timeout" });
  const app = loadScripts(["config.js", "sources.js"], { fetch: fetchFn });
  await assert.rejects(() => app.get("lookupPlaces")(30.275, -98.4), /HTTP 504/);
});

test("places: refuses bad coordinates before any web call", () => {
  const app = loadScripts(["config.js", "sources.js"]);
  assert.throws(() => app.get("buildPlacesQuery")(NaN, -98, 25000, app.get("PLACE_KINDS")), /Bad coordinates/);
});

// ---- road routes ----
test("route: converts meters and seconds to miles and minutes", async () => {
  const fetchFn = fakeFetch({ "router.project-osrm.org": { body: JSON.stringify({ code: "Ok", routes: [{ distance: 80467, duration: 3000 }] }) } });
  const app = loadScripts(["config.js", "sources.js"], { fetch: fetchFn });
  const route = plain(await app.get("routeInfo")(30.275, -98.4, 30.19, -97.67));
  assert.deepEqual(route, { miles: 50, minutes: 50 });
  assert.ok(fetchFn.calls[0].url.includes("/driving/-98.4,30.275;-97.67,30.19"));   // longitude first
});

test("route: no road route means null", async () => {
  const app = loadScripts(["config.js", "sources.js"], { fetch: fakeFetch({ "osrm": { body: '{"code":"NoRoute"}' } }) });
  assert.equal(await app.get("routeInfo")(30, -98, 31, -99), null);
});

test("addRoutes: stores routed times; a failed route keeps its estimate; all failing is reported", async () => {
  const airports = [{ name: "Austin (AUS)", lat: 30.19, lon: -97.67 }];
  const makeParcel = () => ({ lat: 30.275, lon: -98.4, site: { nearestAirport: "Austin (AUS)", airportMiles: 50,
    places: { grocery: { name: "M", miles: 5, lat: 30.3, lon: -98.4 }, vet: { name: "V", miles: 9, lat: 30.4, lon: -98.5 }, costco: null } } });
  const ok = (minutes) => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: "Ok", routes: [{ distance: 16093, duration: minutes * 60 }] }) });

  // Every request except the one to the vet works.
  const partial = loadScripts(["config.js", "sources.js"], { fetch: async (url) => String(url).includes("-98.5,30.4") ? { ok: false, status: 500, text: async () => "x" } : ok(12) });
  const parcel = makeParcel();
  await partial.get("addRoutes")(parcel, airports);
  assert.equal(parcel.site.airportDriveMin, 12);
  assert.equal(parcel.site.places.grocery.driveMin, 12);
  assert.equal(parcel.site.places.vet.driveMin, undefined);          // kept its estimate

  // Two kinds at the same spot (one school serving two levels) share a single route request.
  let routeCalls = 0;
  const shared = loadScripts(["config.js", "sources.js"], { fetch: async () => { routeCalls += 1; return ok(7); } });
  const school = { name: "K-8", miles: 4, lat: 30.3, lon: -98.4 };
  const twoLevels = { lat: 30.275, lon: -98.4, site: { places: { elementary: { ...school }, middle: { ...school } } } };
  await shared.get("addRoutes")(twoLevels, airports);
  assert.equal(routeCalls, 1);
  assert.equal(twoLevels.site.places.elementary.driveMin, 7);
  assert.equal(twoLevels.site.places.middle.driveMin, 7);

  const down = loadScripts(["config.js", "sources.js"], { fetch: async () => ({ ok: false, status: 500, text: async () => "x" }) });
  await assert.rejects(() => down.get("addRoutes")(makeParcel(), airports), /routing service did not answer/);

  const nothing = loadScripts(["config.js", "sources.js"], { fetch: async () => { throw new Error("should not be called"); } });
  await nothing.get("addRoutes")({ lat: 1, lon: 1, site: {} }, airports);   // no airport, no places: nothing to do
});

// ---- the whole United States ----
test("national airport list: nearest airport works in every region", () => {
  const nearestAirport = pure.get("nearestAirport");
  const airports = plain(pure.get("AIRPORT_PRESETS"));
  const nearest = (lat, lon) => nearestAirport(lat, lon, airports).nearestAirport;
  assert.equal(nearest(47.61, -122.33), "Seattle (SEA)");
  assert.equal(nearest(39.74, -104.99), "Denver (DEN)");
  assert.equal(nearest(21.31, -157.86), "Honolulu (HNL)");
  assert.equal(nearest(61.22, -149.9), "Anchorage (ANC)");
  assert.equal(nearest(44.05, -72.6), "Burlington VT (BTV)");
  assert.equal(nearest(18.2, -66.5), "Puerto Rico (San Juan) (SJU)");
  assert.equal(new Set(airports.map((a) => a.name)).size, airports.length);   // no duplicate names
  for (const a of airports) assert.ok(inUS(a.lat, a.lon), a.name + " should be inside the US boxes");
});
const inUS = (lat, lon) => pure.get("inUnitedStates")(lat, lon);

test("activeAirports: national list unless you chose your own non-empty list", () => {
  const activeAirports = pure.get("activeAirports");
  const mine = [{ name: "Home field", lat: 40, lon: -100 }];
  assert.equal(activeAirports({ airportMode: "auto", airports: mine }).length, plain(pure.get("AIRPORT_PRESETS")).length);
  assert.equal(activeAirports({ airportMode: "custom", airports: mine }).length, 1);
  assert.ok(activeAirports({ airportMode: "custom", airports: [] }).length > 50);   // empty custom list falls back
});

test("inUnitedStates: accepts US places, catches typos and other countries", () => {
  assert.ok(inUS(30.27, -97.74));      // Texas
  assert.ok(inUS(64.8, -147.7));       // Alaska
  assert.ok(inUS(20.8, -156.3));       // Hawaii
  assert.ok(inUS(18.4, -66.1));        // Puerto Rico
  assert.ok(!inUS(30.27, 97.74));      // forgot the minus sign: India
  assert.ok(!inUS(-97.74, 30.27));     // latitude and longitude swapped
  assert.ok(!inUS(51.5, -0.12));       // London
  assert.ok(!inUS(19.4, -99.1));       // Mexico City
});

test("county: reads name and state from the Census reply, handles parishes and missing state", () => {
  const parseCounty = pure.get("parseCounty");
  assert.deepEqual(plain(parseCounty({ result: { geographies: { Counties: [{ NAME: "Blanco County", STATE: "48", COUNTY: "031" }], States: [{ STUSAB: "TX", STATE: "48" }] } } })), { county: "Blanco", state: "TX", stateFips: "48", countyFips: "031" });
  assert.deepEqual(plain(parseCounty({ result: { geographies: { Counties: [{ NAME: "Orleans Parish" }], States: [{ STUSAB: "LA" }] } } })), { county: "Orleans Parish", state: "LA", stateFips: null, countyFips: null });
  assert.deepEqual(plain(parseCounty({ result: { geographies: { Counties: [{ NAME: "Blanco County" }] } } })), { county: "Blanco", state: null, stateFips: null, countyFips: null });
  assert.deepEqual(plain(parseCounty({ result: { geographies: {} } })), { county: null, state: null, stateFips: null, countyFips: null });
});

test("countyLabel: adds County, or keeps Parish and Borough, and the state", () => {
  const countyLabel = pure.get("countyLabel");
  assert.equal(countyLabel({ county: "Blanco", state: "TX" }), "Blanco County, TX");
  assert.equal(countyLabel({ county: "Orleans Parish", state: "LA" }), "Orleans Parish, LA");
  assert.equal(countyLabel({ county: "Fairbanks North Star Borough", state: "AK" }), "Fairbanks North Star Borough, AK");
  assert.equal(countyLabel({ county: "Blanco" }), "Blanco County");
  assert.equal(countyLabel({}), "County unknown");
});

// ---- side-by-side comparison ----
test("buildComparison: marks the best value per row and handles missing data", () => {
  const app = loadScripts(["config.js", "scoring.js", "sources.js"]);
  const s = plain(app.get("DEFAULT_SETTINGS"));
  const buildComparison = app.get("buildComparison");
  const scoreParcel = app.get("scoreParcel");
  const place = (name, driveMin) => ({ name, miles: 5, driveMin });
  const a = { name: "A", askingPrice: 100000, acres: 10, status: "new", site: { floodZone: "X", slopePct: 3, airportMiles: 20, nearestAirport: "Austin (AUS)",
    internet: { bestMbps: 100, technologies: ["Cable"], providers: [] }, places: { grocery: place("Market", 10), hardware: null, costco: null, feed: null, vet: null } } };
  const b = { name: "B", askingPrice: 80000, acres: 20, status: "interested", site: { floodZone: "AE", slopePct: 8 } };
  // Only Internet is ticked here, so the usual rows for price, slope and the rest are all shown.
  for (const key of Object.keys(s.criteria.on)) s.criteria.on[key] = key === "internet";
  const items = [a, b].map((parcel) => ({ parcel, score: scoreParcel(parcel, s) }));
  const rows = plain(buildComparison(items, s));
  const get = (label) => rows.find((r) => r.label === label);
  assert.equal(rows[2].label, "Internet");                                              // your criteria come right after the score
  assert.equal(get("Internet (best non-satellite)"), undefined);                        // so the usual internet row is not repeated
  assert.deepEqual(get("Asking price").cells.map((c) => c.best), [false, true]);        // cheaper wins
  assert.deepEqual(get("Price per acre").cells.map((c) => c.text), ["$10,000", "$4,000"]);
  assert.deepEqual(get("Price per acre").cells.map((c) => c.best), [false, true]);
  assert.deepEqual(get("Slope").cells.map((c) => c.best), [true, false]);               // flatter wins
  assert.equal(get("Acres").cells.some((c) => c.best), false);                          // no winner for acres
  assert.equal(get("Drive to airport").cells[1].text, "unknown");
  assert.equal(get("Drive to airport").cells.some((c) => c.best), false);               // one value is not a contest
  assert.equal(get("Grocery store").cells[0].text, "Market, 10 min");
  assert.equal(get("Grocery store").cells[1].text, "unknown");
  assert.equal(get("Hardware store").cells[0].text, "None found");
  assert.equal(get("Elementary school").cells[0].text, "not looked up");
  assert.equal(get("Fire station").cells[0].text, "not looked up");                 // parcel saved before schools existed
  assert.match(get("Dealbreakers").cells[1].text, /flood/i);
  // With the default criteria both parcels have a score, and exactly one scores higher.
  const d = plain(app.get("DEFAULT_SETTINGS"));
  const withDefaults = plain(buildComparison([a, b].map((parcel) => ({ parcel, score: scoreParcel(parcel, d) })), d));
  assert.equal(withDefaults.find((r) => r.label === "Score").cells.filter((c) => c.best).length, 1);
  // Your ticked criteria come first, in your order, and their usual rows are not repeated.
  assert.deepEqual(withDefaults.slice(2, 8).map((r) => r.label), ["Septic suitability", "Airport distance", "Price", "Internet", "Slope", "Rainfall"]);
  assert.equal(withDefaults.find((r) => r.label === "Asking price"), undefined);
  assert.match(withDefaults.find((r) => r.label === "Slope").cells[0].text, /^3% \(score 100\)$/);
});

// ---- plain-text summary ----
test("summaryText: includes the key facts, the caveat and a map link; skips missing sections", () => {
  const app = loadScripts(["config.js", "scoring.js", "sources.js"]);
  const s = plain(app.get("DEFAULT_SETTINGS"));
  const summaryText = app.get("summaryText");
  const full = { name: "Creek 10", county: "Blanco", state: "TX", lat: 30.275, lon: -98.4, acres: 10, askingPrice: 95000, status: "interested", notes: "Call the owner",
    site: { floodZone: "X", septicRating: "Not limited", slopePct: 4.5, annualRainIn: 33, airportMiles: 55, airportDriveMin: 70, nearestAirport: "Austin (AUS)",
      internet: { bestMbps: 100, technologies: ["Cable"], providers: [], vintage: "June 2021" },
      places: { grocery: { name: "Blanco Market", miles: 5, driveMin: 9 }, hardware: null, costco: null, feed: null, vet: null } } };
  const text = summaryText(full, s);
  for (const part of ["Creek 10 - Blanco County, TX", "Asking price: $95,000 for 10 acres, $9,500 per acre", "Dealbreakers: none", "Austin (AUS), about 70 min",
    "100 Mbps", "Shops and services: grocery store: Blanco Market, 9 min", "hardware store: none found", "Schools: elementary school: not looked up", "Emergency services: fire station: not looked up", "Rough cost", "My status: interested", "Notes: Call the owner",
    "openstreetmap.org/?mlat=30.27500&mlon=-98.40000", "not a survey"]) {
    assert.ok(text.includes(part), "missing: " + part + "\n" + text);
  }
  const bare = summaryText({ name: "Bare", lat: 30, lon: -98, status: "new", site: {} }, s);
  assert.ok(!bare.includes("Shops and services:") && !bare.includes("Rough cost") && !bare.includes("Internet:") && !bare.includes("My status"));
  assert.ok(bare.includes("County unknown"));
});

// ---- natural hazards (FEMA National Risk Index) ----
const nriReply = (attributes) => ({ body: JSON.stringify({ features: [{ attributes }] }) });
const sampleTract = { RISK_RATNG: "Relatively Moderate", WFIR_RISKR: "Very High", TRND_RISKR: "Relatively High", HAIL_RISKR: "Relatively High",
  DRGT_RISKR: "Relatively Low", IFLD_RISKR: "Very Low", CFLD_RISKR: "Not Applicable", TSUN_RISKR: "Not Applicable", HRCN_RISKR: "Insufficient Data" };

test("hazards: the 18 FEMA hazards have unique codes, and the ratings run from low to high", () => {
  const codes = plain(pure.get("HAZARDS")).map(([code]) => code);
  assert.equal(codes.length, 18);
  assert.equal(new Set(codes).size, 18);
  assert.deepEqual(plain(pure.get("HAZARD_LEVELS")), ["Very Low", "Relatively Low", "Relatively Moderate", "Relatively High", "Very High"]);
});

test("parseHazards: highest risk first, hides hazards that do not apply, counts them", () => {
  const result = plain(pure.get("parseHazards")({ features: [{ attributes: sampleTract }] }));
  assert.equal(result.overall, "Relatively Moderate");
  assert.equal(result.overallLevel, 2);
  assert.deepEqual(result.hazards.map((h) => h.name), ["Wildfire", "Hail", "Tornado", "Drought", "Inland flooding"]);   // ties sorted by name
  assert.equal(result.hazards[0].level, 4);
  assert.equal(result.unrated, 13);                              // 18 minus the 5 rated; missing fields count as unrated
  assert.equal(pure.get("parseHazards")({ features: [] }), null);
  assert.equal(plain(pure.get("parseHazards")({ features: [{ attributes: {} }] })).overallLevel, -1);
});

test("lookupHazards: asks FEMA by point and returns the parsed rating; errors are reported", async () => {
  const fetchFn = fakeFetch({ "National_Risk_Index_Census_Tracts": nriReply(sampleTract) });
  const app = loadScripts(["config.js", "sources.js"], { fetch: fetchFn });
  const result = plain(await app.get("lookupHazards")(30.275, -98.4));
  assert.equal(result.hazards[0].name, "Wildfire");
  const url = fetchFn.calls[0].url;
  assert.ok(url.includes("geometry=-98.4%2C30.275") && url.includes("inSR=4326") && url.includes("returnGeometry=false"));
  const broken = loadScripts(["config.js", "sources.js"], { fetch: fakeFetch({ "National_Risk_Index": { body: JSON.stringify({ error: { code: 400 } }) } }) });
  await assert.rejects(() => broken.get("lookupHazards")(30, -98), /FEMA risk service error/);
});

test("hazards: appear in the summary and the comparison; old parcels say not looked up", () => {
  const app = loadScripts(["config.js", "scoring.js", "sources.js"]);
  const s = plain(app.get("DEFAULT_SETTINGS"));
  const hazards = plain(app.get("parseHazards")({ features: [{ attributes: sampleTract }] }));
  assert.deepEqual(plain(app.get("highHazards")(hazards)), ["Wildfire", "Hail", "Tornado"]);
  const calm = plain(app.get("parseHazards")({ features: [{ attributes: { RISK_RATNG: "Very Low", HAIL_RISKR: "Very Low" } }] }));
  const withHazards = { name: "A", county: "Blanco", state: "TX", lat: 30, lon: -98, status: "new", site: { hazards } };
  assert.ok(app.get("summaryText")(withHazards, s).includes("Natural hazards (FEMA, area-wide): overall relatively moderate; high or very high: Wildfire, Hail, Tornado"));
  const items = [withHazards, { name: "B", lat: 30, lon: -98, status: "new", site: { hazards: calm } }, { name: "C", lat: 30, lon: -98, status: "new", site: {} }]
    .map((parcel) => ({ parcel, score: app.get("scoreParcel")(parcel, s) }));
  const rows = plain(app.get("buildComparison")(items, s));
  const overall = rows.find((r) => r.label === "Natural hazard risk (FEMA)");
  assert.deepEqual(overall.cells.map((c) => c.text), ["Relatively Moderate", "Very Low", "not looked up"]);
  assert.deepEqual(overall.cells.map((c) => c.best), [false, true, false]);         // lower risk wins
  const count = rows.find((r) => r.label === "Hazards rated high or very high");
  assert.deepEqual(count.cells.map((c) => c.text), ["Wildfire, Hail, Tornado", "None", "unknown"]);
});

// ---- plant hardiness zone ----
test("parseZip: finds the five-digit code in the Census reply, whatever the layer or field is called", () => {
  const parseZip = pure.get("parseZip");
  const reply = (layer, area) => ({ result: { geographies: { Counties: [{ NAME: "Blanco County" }], [layer]: [area] } } });
  assert.equal(parseZip(reply("2020 Census ZIP Code Tabulation Areas", { ZCTA5: "78606" })), "78606");
  assert.equal(parseZip(reply("ZIP Code Tabulation Areas", { GEOID: "78605" })), "78605");
  assert.equal(parseZip(reply("2010 Census ZIP Code Tabulation Areas", { NAME: "ZCTA5 78636" })), "78636");
  assert.equal(parseZip({ result: { geographies: { Counties: [{ NAME: "Blanco County" }] } } }), null);   // no ZIP layer in the reply
  assert.equal(parseZip({ result: { geographies: { "ZIP Code Tabulation Areas": [] } } }), null);
  assert.equal(parseZip({}), null);
});

test("hardiness: reads the zone and temperature range; rejects replies that are not a zone", async () => {
  const fetchFn = fakeFetch({ "phzmapi.org/78606.json": { body: JSON.stringify({ zone: "8B", temperature_range: "15 to 20", coordinates: { lat: "30.3", lon: "-98.4" } }) } });
  const app = loadScripts(["config.js", "sources.js"], { fetch: fetchFn });
  assert.deepEqual(plain(await app.get("fetchHardiness")("78606")), { zone: "8b", tempRange: "15 to 20", zip: "78606", vintage: "2023" });
  assert.ok(fetchFn.calls[0].url.endsWith("/78606.json"));
  const odd = loadScripts(["config.js", "sources.js"], { fetch: fakeFetch({ "phzmapi.org": { body: JSON.stringify({ zone: "banana" }) } }) });
  await assert.rejects(() => odd.get("fetchHardiness")("78606"), /Unexpected hardiness zone reply/);
  const missing = loadScripts(["config.js", "sources.js"], { fetch: async () => ({ ok: false, status: 404, text: async () => "Not found" }) });
  await assert.rejects(() => missing.get("fetchHardiness")("00000"), /HTTP 404/);
});

test("hardiness: shows in the summary and comparison; old parcels say not looked up", () => {
  const app = loadScripts(["config.js", "scoring.js", "sources.js"]);
  const s = plain(app.get("DEFAULT_SETTINGS"));
  const hardiness = { zone: "8b", tempRange: "15 to 20", zip: "78606", vintage: "2023" };
  assert.equal(app.get("hardinessText")(hardiness), "Zone 8b (15 to 20 F)");
  assert.equal(app.get("hardinessText")(undefined), "not looked up");
  assert.equal(app.get("hardinessText")(null), "unknown");
  assert.equal(app.get("hardinessText")({ zone: "7a", zip: "1" }), "Zone 7a");
  const a = { name: "A", lat: 30, lon: -98, status: "new", site: { hardiness } };
  assert.ok(app.get("summaryText")(a, s).includes("Plant hardiness zone: 8b (15 to 20 F) lowest winter temperature, by ZIP 78606 (USDA 2023 map)"));
  const items = [a, { name: "B", lat: 30, lon: -98, status: "new", site: {} }].map((parcel) => ({ parcel, score: app.get("scoreParcel")(parcel, s) }));
  const row = plain(app.get("buildComparison")(items, s)).find((r) => r.label === "Hardiness zone (by ZIP)");
  assert.deepEqual(row.cells.map((c) => c.text), ["Zone 8b (15 to 20 F)", "not looked up"]);
  assert.equal(row.cells.some((c) => c.best), false);                   // a zone is not better or worse
});

// ---- soil details ----
test("textureClass: the USDA soil texture triangle", () => {
  const t = pure.get("textureClass");
  assert.equal(t(90, 5, 5), "Sand");
  assert.equal(t(80, 10, 10), "Sandy loam");
  assert.equal(t(82, 10, 8), "Loamy sand");
  assert.equal(t(40, 40, 20), "Loam");
  assert.equal(t(20, 60, 20), "Silt loam");
  assert.equal(t(10, 85, 5), "Silt");
  assert.equal(t(50, 20, 30), "Sandy clay loam");
  assert.equal(t(35, 35, 30), "Clay loam");
  assert.equal(t(10, 60, 30), "Silty clay loam");
  assert.equal(t(50, 5, 45), "Sandy clay");
  assert.equal(t(10, 50, 40), "Silty clay");
  assert.equal(t(30, 30, 40), "Clay");
  assert.equal(t(NaN, 30, 40), null);
});

test("shrinkSwellClass: NRCS classes from linear extensibility", () => {
  const c = pure.get("shrinkSwellClass");
  assert.deepEqual([2.9, 3, 5.9, 6, 8.9, 9, 12].map(c), ["Low", "Moderate", "Moderate", "High", "High", "Very high", "Very high"]);
  assert.equal(c(NaN), null);
});

test("summarizeHorizons: topsoil facts, 5 feet of water capacity, worst shrink-swell in the top 40 inches", () => {
  const rows = [
    { hzdept_r: "0", hzdepb_r: "20", awc_r: "0.15", claytotal_r: "20", sandtotal_r: "40", silttotal_r: "40", om_r: "2.5", ph1to1h2o_r: "6.4", lep_r: "2.0" },
    { hzdept_r: "20", hzdepb_r: "100", awc_r: "0.10", claytotal_r: "45", sandtotal_r: "30", silttotal_r: "25", om_r: "0.5", ph1to1h2o_r: "7.8", lep_r: "7.5" },
    { hzdept_r: "100", hzdepb_r: "200", awc_r: "0.05", claytotal_r: null, sandtotal_r: null, silttotal_r: null, om_r: null, ph1to1h2o_r: null, lep_r: "11" },
  ];
  const result = plain(pure.get("summarizeHorizons")(rows));
  assert.equal(result.texture, "Loam");
  assert.equal(result.organicMatterPct, 2.5);
  assert.equal(result.ph, 6.4);
  // 0.15*20 + 0.10*80 + 0.05*52.4 = 3 + 8 + 2.62 = 13.62 cm of water, which is 5.4 inches
  assert.equal(result.waterHoldingIn, 5.4);
  assert.equal(result.shrinkSwell, "High");          // the 11 below 100 cm does not count
  assert.equal(pure.get("summarizeHorizons")([]), null);
});

test("worstOf: keeps the most frequent flooding value and ignores unknown words", () => {
  const worstOf = pure.get("worstOf");
  const FLOOD = plain(pure.get("FLOOD_ORDER"));
  assert.equal(worstOf(["None", "Rare", "Occasional", "None"], FLOOD), "Occasional");
  assert.equal(worstOf(["Not specified", null], FLOOD), null);
  assert.equal(worstOf([], FLOOD), null);
});

test("lookupSoilDetails: four questions, results combined, unit conversions, partial failure tolerated", async () => {
  const table = (names, ...rows) => ({ body: JSON.stringify({ Table: [names, ...rows] }) });
  const answers = (query) => {
    if (query.includes("farmlndcl")) return table(["farmland", "hydric", "hyd_group", "rock_depth_cm", "rock_kind", "water_table_cm"], ["Not prime farmland", "No", "C", "102", "Lithic bedrock", "61"]);
    if (query.includes("flodfreqcl")) return table(["flood", "pond"], ["None", "None"], ["Rare", "Occasional"]);
    if (query.includes("FROM chorizon")) return table(["hzdept_r", "hzdepb_r", "awc_r", "claytotal_r", "sandtotal_r", "silttotal_r", "om_r", "ph1to1h2o_r", "lep_r"], ["0", "25", "0.14", "22", "38", "40", "2", "6.5", "4"]);
    if (query.includes("cointerp")) return table(["rule", "rating"], ["ENG - Dwellings Without Basements", "Somewhat limited"], ["ENG - Sewage Lagoons", "Very limited"], ["Some Other Rule", "Not limited"]);
    throw new Error("unexpected query");
  };
  const fetchFn = async (url, options) => {
    const query = options.body.get("query");
    const reply = answers(query);
    return { ok: true, status: 200, text: async () => reply.body };
  };
  const app = loadScripts(["config.js", "sources.js"], { fetch: fetchFn });
  const sd = plain(await app.get("lookupSoilDetails")(30.275, -98.4));
  assert.equal(sd.farmland, "Not prime farmland");
  assert.equal(sd.bedrockDepthIn, 40);                  // 102 cm
  assert.equal(sd.bedrockKind, "Lithic bedrock");
  assert.equal(sd.waterTableDepthIn, 24);               // 61 cm
  assert.equal(sd.flooding, "Rare");
  assert.equal(sd.ponding, "Occasional");
  assert.equal(sd.texture, "Loam");
  assert.deepEqual(sd.interps, { dwellings: "Somewhat limited", lagoons: "Very limited" });   // unknown rules are ignored

  // one question failing leaves the rest in place
  let calls = 0;
  const flaky = loadScripts(["config.js", "sources.js"], { fetch: async (url, options) => {
    calls += 1;
    if (options.body.get("query").includes("flodfreqcl")) return { ok: false, status: 500, text: async () => "x" };
    return { ok: true, status: 200, text: async () => answers(options.body.get("query")).body };
  } });
  const partial = plain(await flaky.get("lookupSoilDetails")(30.275, -98.4));
  assert.equal(calls, 4);
  assert.equal(partial.flooding, undefined);
  assert.equal(partial.farmland, "Not prime farmland");

  // every question failing is an error; every question empty is "no data"
  const down = loadScripts(["config.js", "sources.js"], { fetch: async () => ({ ok: false, status: 503, text: async () => "x" }) });
  await assert.rejects(() => down.get("lookupSoilDetails")(30, -98), /HTTP 503/);
  const empty = loadScripts(["config.js", "sources.js"], { fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ Table: [] }) }) });
  assert.equal(await empty.get("lookupSoilDetails")(30, -98), null);
  assert.throws(() => pure.get("mainComponentSql")(NaN, 1), /Bad coordinates/);
});

test("soil details: shown in the summary and the comparison; old parcels say not looked up", () => {
  const app = loadScripts(["config.js", "scoring.js", "sources.js"]);
  const s = plain(app.get("DEFAULT_SETTINGS"));
  const deep = { texture: "Loam", farmland: "All areas are prime farmland", bedrockDepthIn: null, waterTableDepthIn: 60, flooding: "None", shrinkSwell: "Low" };
  const shallow = { texture: "Clay", farmland: "Not prime farmland", bedrockDepthIn: 20, waterTableDepthIn: 12, flooding: "Occasional", shrinkSwell: "High" };
  const make = (name, soilDetails) => ({ name, lat: 30, lon: -98, status: "new", site: soilDetails === undefined ? {} : { soilDetails } });
  const text = app.get("summaryText")(make("A", shallow), s);
  assert.ok(text.includes("Soil details: clay topsoil; not prime farmland; bedrock: 20 in; seasonal water table: 12 in; soil flooding: occasional; shrink-swell: high"));
  assert.equal(app.get("depthText")(60), "5 ft");
  assert.equal(app.get("depthText")(null), "none listed");
  const items = [make("A", deep), make("B", shallow), make("C", undefined), make("D", null)].map((parcel) => ({ parcel, score: app.get("scoreParcel")(parcel, s) }));
  const rows = plain(app.get("buildComparison")(items, s));
  const get = (label) => rows.find((r) => r.label === label);
  assert.deepEqual(get("Seasonal water table depth").cells.map((c) => c.text), ["5 ft", "12 in", "not looked up", "no data"]);
  assert.deepEqual(get("Seasonal water table depth").cells.map((c) => c.best), [true, false, false, false]);    // deeper is better
  assert.deepEqual(get("Soil flooding (soil survey)").cells.map((c) => c.best), [true, false, false, false]);
  assert.deepEqual(get("Shrink-swell").cells.map((c) => c.best), [true, false, false, false]);
  assert.equal(get("Depth to bedrock").cells[0].text, "none listed");
  assert.equal(get("Depth to bedrock").cells.some((c) => c.best), false);   // one real value is not a contest
});

// ---- climate and solar ----
// Builds two full years (2020 and 2021) of made-up weather: mild days, plus the extremes the test asks for.
function fakeDaily(overrides = {}) {
  const time = [], min = [], max = [], snow = [], sun = [];
  for (const year of [2020, 2021]) {
    for (let day = 0; day < 365; day++) {
      const date = new Date(Date.UTC(year, 0, 1 + day)).toISOString().slice(0, 10);
      const o = overrides[date] || {};
      time.push(date);
      min.push(o.min ?? 10); max.push(o.max ?? 25); snow.push(o.snow ?? 0);
      sun.push(o.sun ?? 18);       // 18 MJ/m2 is 5 kWh/m2
    }
  }
  return { time, temperature_2m_min: min, temperature_2m_max: max, snowfall_sum: snow, shortwave_radiation_sum: sun };
}

test("dayOfYear and dayOfYearText convert both ways", () => {
  assert.equal(pure.get("dayOfYear")("2021-01-01"), 1);
  assert.equal(pure.get("dayOfYear")("2021-03-14"), 73);
  assert.equal(pure.get("dayOfYearText")(73), "Mar 14");
  assert.equal(pure.get("dayOfYearText")(365), "Dec 31");
});

test("summarizeClimate: frost dates, season length, hot days, snow, and sunlight", () => {
  const daily = fakeDaily({
    "2020-03-10": { min: -2 }, "2020-03-20": { min: -1 }, "2020-11-05": { min: -3 }, "2020-11-20": { min: -4 },   // last spring 2020-03-20, first fall 2020-11-05
    "2021-03-30": { min: -1 }, "2021-10-25": { min: -2 },
    "2020-07-01": { max: 38 }, "2020-07-02": { max: 36 }, "2021-07-03": { max: 33 },                                 // 100.4 F, 96.8 F, 91.4 F
    "2020-01-15": { snow: 5.08 }, "2021-01-16": { snow: 10.16 },                                                      // 2 in and 4 in
    "2020-12-21": { sun: 7.2 }, "2021-12-21": { sun: 7.2 },
  });
  const { climate, solar } = plain(pure.get("summarizeClimate")(daily));
  assert.equal(climate.years, 2);
  assert.equal(climate.freezeYears, 2);
  assert.equal(climate.lastSpringFreeze, "Mar 26");        // Mar 20 2020 is day 80 and Mar 30 2021 is day 89; the average, 84.5, rounds to day 85
  assert.equal(climate.firstFallFreeze, "Oct 31");         // Nov 5 2020 is day 310 and Oct 25 2021 is day 298; the average is day 304
  assert.equal(climate.freezingDaysPerYear, 3);            // 6 freezing days in 2 years
  assert.equal(climate.daysOver90F, 1.5);
  assert.equal(climate.daysOver100F, 0.5);
  assert.equal(climate.snowInchesPerYear, 3);
  assert.equal(climate.januaryLowF, 50);                   // 10 C
  assert.equal(climate.julyHighF, 77.9);                   // mostly 25 C (77 F); three hot days pull the average up
  assert.ok(solar.sunHoursPerDay > 4.9 && solar.sunHoursPerDay <= 5);
  assert.equal(solar.worstMonth.name, "Dec");
  assert.ok(solar.kwhPerKwYear > 1450 && solar.kwhPerKwYear <= 1460);   // 5 sun hours x 365 x 0.8 = 1460, a little less with the dark days
});

test("lookupClimate: asks Open-Meteo for the right daily values; too little data is an error", async () => {
  const fetchFn = fakeFetch({ "archive-api.open-meteo.com": { body: JSON.stringify({ daily: fakeDaily() }) } });
  const app = loadScripts(["config.js", "sources.js"], { fetch: fetchFn });
  const result = plain(await app.get("lookupClimate")(30.275, -98.4));
  assert.equal(result.climate.lastSpringFreeze, null);          // never freezes in the made-up data
  assert.equal(result.climate.frostFreeDays, 365);
  const url = fetchFn.calls[0].url;
  for (const part of ["temperature_2m_min", "shortwave_radiation_sum", "snowfall_sum", "timezone=auto"]) assert.ok(url.includes(part), part);
  const sparse = loadScripts(["config.js", "sources.js"], { fetch: fakeFetch({ "archive-api": { body: JSON.stringify({ daily: { time: ["2020-01-01"], temperature_2m_min: [1], temperature_2m_max: [2], snowfall_sum: [0], shortwave_radiation_sum: [5] } }) } }) });
  await assert.rejects(() => sparse.get("lookupClimate")(30, -98), /Not enough weather data/);
  const nothing = loadScripts(["config.js", "sources.js"], { fetch: fakeFetch({ "archive-api": { body: "{}" } }) });
  await assert.rejects(() => nothing.get("lookupClimate")(30, -98), /returned no data/);
});

test("climate: shown in the summary and the comparison; old parcels say not looked up", () => {
  const app = loadScripts(["config.js", "scoring.js", "sources.js"]);
  const s = plain(app.get("DEFAULT_SETTINGS"));
  const { climate, solar } = plain(app.get("summarizeClimate")(fakeDaily({ "2020-03-20": { min: -1 }, "2020-11-05": { min: -1 }, "2021-03-20": { min: -1 }, "2021-11-05": { min: -1 } })));
  const a = { name: "A", lat: 30, lon: -98, status: "new", site: { climate, solar } };
  const b = { name: "B", lat: 30, lon: -98, status: "new", site: {} };
  const text = app.get("summaryText")(a, s);
  assert.ok(text.includes("Climate and solar (10-year model data): last spring freeze about Mar 21"));
  assert.ok(text.includes("full-sun hours a day on average"));
  const items = [a, b].map((parcel) => ({ parcel, score: app.get("scoreParcel")(parcel, s) }));
  const rows = plain(app.get("buildComparison")(items, s));
  assert.deepEqual(rows.find((r) => r.label === "Last spring freeze (average)").cells.map((c) => c.text), ["Mar 21", "not looked up"]);
  assert.deepEqual(rows.find((r) => r.label === "Solar: full-sun hours per day").cells.map((c) => c.text), [String(solar.sunHoursPerDay), "not looked up"]);
});

// ---- road access ----
const roadWay = (tags, geometry) => ({ type: "way", tags, geometry });
// Points are given as [lat, lon]. The parcel sits at 30.0, -98.0. 0.001 degrees of latitude is about 365 feet.
const pts = (...pairs) => pairs.map(([lat, lon]) => ({ lat, lon }));

test("distanceToRoadFeet: measures to the nearest point on the line, not the nearest corner", () => {
  const distance = pure.get("distanceToRoadFeet");
  // A road running east-west 0.001 degrees (365 ft) north of the parcel, long enough that the nearest spot is mid-segment.
  assert.ok(Math.abs(distance(30, -98, pts([30.001, -98.01], [30.001, -97.99])) - 365) < 3);
  // The same road, but it ends before the parcel: the nearest spot is its end point.
  const endOnly = distance(30, -98, pts([30.001, -98.02], [30.001, -98.01]));
  assert.ok(Math.abs(endOnly - 3184) < 10, String(endOnly));          // 0.01 degrees of longitude (3,163 ft) east-west, plus the 365 ft north
  assert.equal(distance(30, -98, pts([30, -98])), 0);          // a single point exactly on the parcel
  assert.equal(distance(30, -98, pts([30.001, -98], [30.001, -98])), 365);   // a zero-length piece
});

test("roadSurface and isPublicRoad: tags decide, with sensible defaults", () => {
  const surface = pure.get("roadSurface"), isPublic = pure.get("isPublicRoad");
  assert.equal(surface({ highway: "residential", surface: "asphalt" }), "paved");
  assert.equal(surface({ highway: "residential", surface: "gravel" }), "unpaved");
  assert.equal(surface({ highway: "secondary" }), "paved");            // no surface tag, but this type is nearly always paved
  assert.equal(surface({ highway: "track" }), "unknown");
  assert.equal(isPublic({ highway: "residential" }), true);
  assert.equal(isPublic({ highway: "residential", access: "private" }), false);
  assert.equal(isPublic({ highway: "service" }), false);               // driveways and parking aisles
  assert.equal(isPublic({ highway: "service", access: "yes" }), true);
});

test("summarizeRoads and lookupRoads: nearest road, nearest paved public road, widening search", () => {
  const summarize = pure.get("summarizeRoads");
  const elements = [
    roadWay({ highway: "track", name: "Ranch Track", surface: "dirt" }, pts([30.0005, -98.01], [30.0005, -97.99])),            // 183 ft, unpaved
    roadWay({ highway: "residential", name: "Private Ln", access: "private", surface: "asphalt" }, pts([30.001, -98.01], [30.001, -97.99])),
    roadWay({ highway: "secondary", name: "FM 1234" }, pts([30.003, -98.01], [30.003, -97.99])),                              // 1,095 ft, paved
    { type: "node", lat: 30, lon: -98, tags: { highway: "residential" } },                                                    // not a way: ignored
  ];
  const result = plain(summarize(elements, 30, -98));
  assert.equal(result.nearest.name, "Ranch Track");
  assert.equal(result.nearest.surface, "unpaved");
  assert.equal(result.nearestPublicPaved.name, "FM 1234");              // the private paved road is skipped
  assert.ok(Math.abs(result.nearestPublicPaved.distanceFt - 1095) < 5);
  assert.equal(summarize([], 30, -98).nearest, null);
});

test("lookupRoads: stops at the first circle that finds a public paved road, otherwise widens", async () => {
  const queries = [];
  const paved = roadWay({ highway: "secondary", name: "FM 1234" }, pts([30.003, -98.01], [30.003, -97.99]));
  const track = roadWay({ highway: "track", name: "Ranch Track" }, pts([30.0005, -98.01], [30.0005, -97.99]));
  const make = (answerFor) => loadScripts(["config.js", "sources.js"], { fetch: async (url, options) => {
    const query = options.body.get("data");
    queries.push(query);
    return { ok: true, status: 200, text: async () => JSON.stringify({ elements: answerFor(query) }) };
  } });
  const near = await make(() => [paved, track]).get("lookupRoads")(30, -98);
  assert.equal(queries.length, 1);
  assert.ok(queries[0].includes("around:600") && queries[0].includes("out tags geom("));
  assert.equal(plain(near).nearestPublicPaved.name, "FM 1234");
  queries.length = 0;
  const far = plain(await make((q) => (q.includes("around:10000") ? [paved] : [track])).get("lookupRoads")(30, -98));
  assert.equal(queries.length, 3);                                       // 600 m, then 3 km, then 10 km
  assert.equal(far.searchedMeters, 10000);
  assert.equal(far.nearestPublicPaved.name, "FM 1234");
  queries.length = 0;
  const none = plain(await make(() => []).get("lookupRoads")(30, -98));
  assert.equal(none.nearest, null);
  assert.equal(none.searchedMeters, 10000);                              // it tried every circle
  assert.throws(() => pure.get("roadsQuery")(NaN, 1, 600), /Bad coordinates/);
});

test("roads: distance and road text; shown in the summary and the comparison", () => {
  const app = loadScripts(["config.js", "scoring.js", "sources.js"]);
  const s = plain(app.get("DEFAULT_SETTINGS"));
  assert.equal(app.get("distanceText")(180), "180 ft");
  assert.equal(app.get("distanceText")(2640), "0.5 mi");
  assert.equal(app.get("distanceText")(null), "none found");
  const roads = { nearest: { name: "Ranch Track", distanceFt: 183, surface: "unpaved" }, nearestPublicPaved: null, searchedMeters: 10000 };
  const a = { name: "A", lat: 30, lon: -98, status: "new", site: { roads } };
  const text = app.get("summaryText")(a, s);
  assert.ok(text.includes("nearest road Ranch Track, 183 ft (unpaved); nearest paved public road none within 6.2 mi"));
  const b = { name: "B", lat: 30, lon: -98, status: "new", site: {} };
  const rows = plain(app.get("buildComparison")([a, b].map((parcel) => ({ parcel, score: app.get("scoreParcel")(parcel, s) })), s));
  assert.deepEqual(rows.find((r) => r.label === "Nearest road").cells.map((c) => c.text), ["Ranch Track, 183 ft (unpaved)", "not looked up"]);
});

// ---- wetlands (US Fish and Wildlife Service) ----
const nwiFeature = (type) => ({ attributes: { "Wetlands.WETLAND_TYPE": type, "Wetlands.ACRES": 1.2 } });

test("attr: finds a field with or without a table prefix", () => {
  const attr = pure.get("attr");
  assert.equal(attr({ "Wetlands.WETLAND_TYPE": "Pond" }, "WETLAND_TYPE"), "Pond");
  assert.equal(attr({ WETLAND_TYPE: "Lake" }, "WETLAND_TYPE"), "Lake");
  assert.equal(attr({ OTHER: 1 }, "WETLAND_TYPE"), null);
  assert.equal(attr({ "X.NOT_WETLAND_TYPE_2": 1, "X.XWETLAND_TYPE": 5 }, "WETLAND_TYPE"), null);   // must match the whole name
});

test("wetlands: asks twice (at the point and within 400 m) and summarizes", async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(String(url));
    const nearby = String(url).includes("distance=400");
    const features = nearby ? [nwiFeature("Freshwater Pond"), nwiFeature("Freshwater Emergent Wetland"), nwiFeature("Freshwater Pond")] : [];
    return { ok: true, status: 200, text: async () => JSON.stringify({ features }) };
  };
  const app = loadScripts(["config.js", "sources.js"], { fetch: fetchFn });
  const result = plain(await app.get("lookupWetlands")(30.275, -98.4));
  assert.equal(result.onWetland, false);
  assert.equal(result.nearbyCount, 3);
  assert.deepEqual(result.nearbyTypes, ["Freshwater Pond", "Freshwater Emergent Wetland"]);
  assert.equal(urls.length, 2);
  assert.ok(urls.every((u) => u.includes("geometry=-98.4%2C30.275") && u.includes("inSR=4326") && u.includes("returnGeometry=false")));
  assert.ok(urls.some((u) => u.includes("units=esriSRUnit_Meter")));
  const inside = plain(pure.get("summarizeWetlands")([nwiFeature("Riverine")], [], false));
  assert.equal(inside.onWetland, true);
  assert.deepEqual(inside.onTypes, ["Riverine"]);
  const broken = loadScripts(["config.js", "sources.js"], { fetch: fakeFetch({ "wetlandsmapservice": { body: JSON.stringify({ error: { code: 400 } }) } }) });
  await assert.rejects(() => broken.get("lookupWetlands")(30, -98), /Wetlands service error/);
});

test("wetlands: text, summary and comparison; a point inside a wetland ranks worst", () => {
  const app = loadScripts(["config.js", "scoring.js", "sources.js"]);
  const s = plain(app.get("DEFAULT_SETTINGS"));
  const inside = { onWetland: true, onTypes: ["Freshwater Pond"], nearbyCount: 4, nearbyMore: false, nearbyTypes: [], nearbyMeters: 400 };
  const near = { onWetland: false, onTypes: [], nearbyCount: 2, nearbyMore: false, nearbyTypes: [], nearbyMeters: 400 };
  const clear = { onWetland: false, onTypes: [], nearbyCount: 0, nearbyMore: false, nearbyTypes: [], nearbyMeters: 400 };
  const text = app.get("wetlandText");
  assert.equal(text(inside), "on a mapped wetland (Freshwater Pond)");
  assert.equal(text(near), "2 mapped wetlands within a quarter mile");
  assert.equal(text({ ...near, nearbyCount: 1 }), "1 mapped wetland within a quarter mile");
  assert.equal(text(clear), "none mapped nearby");
  const parcels = [inside, near, clear].map((wetlands, i) => ({ name: "P" + i, lat: 30, lon: -98, status: "new", site: { wetlands } }));
  assert.ok(app.get("summaryText")(parcels[0], s).includes("Wetlands (US Fish and Wildlife Service map, not a delineation): on a mapped wetland"));
  const rows = plain(app.get("buildComparison")(parcels.map((parcel) => ({ parcel, score: app.get("scoreParcel")(parcel, s) })), s));
  assert.deepEqual(rows.find((r) => r.label === "Mapped wetlands").cells.map((c) => c.best), [false, false, true]);
});

// ---- public and protected land (USGS PAD-US) ----
const padFeature = (name, manager, access, acres = 1000, type = "National Forest") =>
  ({ attributes: { Unit_Nm: name, Mang_Name: manager, Des_Tp: type, Pub_Access: access, DOCACRES: acres } });

test("summarizePublicLand: spells out codes, merges pieces of one area, keeps five", () => {
  const areas = plain(pure.get("summarizePublicLand")([
    padFeature("Lost Maples SNA", "SPR", "OA", 2174.4, "State Park"),
    padFeature("Lost Maples SNA", "SPR", "OA", 12),                    // another piece of the same area
    padFeature("Mystery Tract", "ZZZ", "XX"),
    { attributes: {} },
  ]));
  assert.equal(areas.length, 3);
  assert.deepEqual(areas[0], { name: "Lost Maples SNA", manager: "State parks and recreation", type: "State Park", access: "Open", acres: 2174 });
  assert.equal(areas[1].manager, "ZZZ");                                 // unknown code shown as it comes
  assert.equal(areas[1].access, "XX");
  assert.equal(areas[2].name, "(unnamed area)");
  assert.equal(areas[2].manager, "unknown manager");
  const many = Array.from({ length: 9 }, (_, i) => padFeature("Area " + i, "NPS", "OA"));
  assert.equal(pure.get("summarizePublicLand")(many).length, 5);
});

test("lookupPublicLand: widens 0, 3, 10, 25 miles and stops at the first hit", async () => {
  const urls = [];
  const make = (hitAt) => loadScripts(["config.js", "sources.js"], { fetch: async (url) => {
    urls.push(String(url));
    const hit = hitAt !== null && (hitAt === 0 ? !String(url).includes("distance=") : String(url).includes(`distance=${hitAt}&`));
    return { ok: true, status: 200, text: async () => JSON.stringify({ features: hit ? [padFeature("Big Forest", "USFS", "OA")] : [] }) };
  } });
  const onLand = plain(await make(0).get("lookupPublicLand")(30, -98));
  assert.equal(onLand.withinMiles, 0);
  assert.equal(urls.length, 1);
  assert.ok(!urls[0].includes("distance="));
  urls.length = 0;
  const near = plain(await make(10).get("lookupPublicLand")(30, -98));
  assert.equal(near.withinMiles, 10);
  assert.equal(urls.length, 3);                                          // point, 3 miles, 10 miles
  assert.ok(urls[1].includes("distance=3") && urls[1].includes("units=esriSRUnit_StatuteMile"));
  assert.equal(near.areas[0].manager, "US Forest Service");
  urls.length = 0;
  const none = plain(await make(null).get("lookupPublicLand")(30, -98));
  assert.deepEqual(none, { withinMiles: null, areas: [] });
  assert.equal(urls.length, 4);
  const broken = loadScripts(["config.js", "sources.js"], { fetch: fakeFetch({ "PAD": { body: "x" }, "Public_Access": { body: JSON.stringify({ error: { code: 400 } }) } }) });
  await assert.rejects(() => broken.get("lookupPublicLand")(30, -98), /Protected lands service error/);
});

test("public land: text, summary and comparison", () => {
  const app = loadScripts(["config.js", "scoring.js", "sources.js"]);
  const s = plain(app.get("DEFAULT_SETTINGS"));
  const areas = [{ name: "Big Forest", manager: "US Forest Service", type: "National Forest", access: "Open", acres: 5000 }];
  const near = { withinMiles: 3, areas }, on = { withinMiles: 0, areas }, none = { withinMiles: null, areas: [] };
  const text = app.get("publicLandText");
  assert.equal(text(near), "protected or public land within 3 miles: Big Forest (US Forest Service, open access)");
  assert.equal(text(on).startsWith("on protected land:"), true);
  assert.equal(text(none), "none within 25 miles");
  const parcels = [near, none].map((publicLand, i) => ({ name: "P" + i, lat: 30, lon: -98, status: "new", site: { publicLand } }));
  assert.ok(app.get("summaryText")(parcels[0], s).includes("Public and protected land (USGS PAD-US): protected or public land within 3 miles"));
  const rows = plain(app.get("buildComparison")(parcels.map((parcel) => ({ parcel, score: app.get("scoreParcel")(parcel, s) })), s));
  assert.deepEqual(rows.find((r) => r.label === "Public or protected land").cells.map((c) => c.text), ["within 3 miles", "none within 25 miles"]);
});

// ---- county property tax rate (Census American Community Survey) ----
const acsRows = (tax, value) => [["NAME", "B25103_001E", "B25077_001E", "state", "county"], ["Blanco County, Texas", tax, value, "48", "031"]];

test("parseTaxRate: tax divided by value, and 'not available' codes are ignored", () => {
  const parse = pure.get("parseTaxRate");
  assert.deepEqual(plain(parse(acsRows("2850", "285000"), 2023)), { ratePct: 1, medianTax: 2850, medianValue: 285000, year: 2023, name: "Blanco County, Texas" });
  assert.equal(plain(parse(acsRows("3100", "250000"), 2023)).ratePct, 1.24);
  assert.equal(parse(acsRows("-666666666", "250000"), 2023), null);
  assert.equal(parse(acsRows("2000", null), 2023), null);
  assert.equal(parse([], 2023), null);
  assert.equal(parse({ error: "x" }, 2023), null);
});

test("lookupTaxRate: builds the Census request, adds a key only if given, and reports a missing key", async () => {
  const fetchFn = fakeFetch({ "api.census.gov": { body: JSON.stringify(acsRows("2850", "285000")) } });
  const app = loadScripts(["config.js", "sources.js"], { fetch: fetchFn });
  assert.equal(plain(await app.get("lookupTaxRate")("48", "031", "")).ratePct, 1);
  const url = fetchFn.calls[0].url;
  assert.ok(url.includes("/data/2023/acs/acs5?") && url.includes("B25103_001E") && url.includes("for=county%3A031") && url.includes("in=state%3A48"));
  assert.ok(!url.includes("key="));
  await app.get("lookupTaxRate")("48", "031", "abc123");
  assert.ok(fetchFn.calls[1].url.includes("key=abc123"));
  assert.equal(await app.get("lookupTaxRate")(null, "031", ""), null);        // county not known: nothing to ask
  const refused = loadScripts(["config.js", "sources.js"], { fetch: fakeFetch({ "api.census.gov": { body: "<html>Missing Key</html>" } }) });
  assert.deepEqual(plain(await refused.get("lookupTaxRate")("48", "031", "")), { needsKey: true, keyRejected: false });
  assert.deepEqual(plain(await refused.get("lookupTaxRate")("48", "031", "bad")), { needsKey: true, keyRejected: true });
  const down = loadScripts(["config.js", "sources.js"], { fetch: async () => ({ ok: false, status: 503, text: async () => "x" }) });
  await assert.rejects(() => down.get("lookupTaxRate")("48", "031", ""), /HTTP 503/);
});

test("estimateCosts: uses the county's rate when known, your setting when not or when turned off", () => {
  const app = loadScripts(["config.js", "scoring.js", "sources.js"]);
  const s = plain(app.get("DEFAULT_SETTINGS"));
  const taxRate = { ratePct: 1.8, name: "Blanco County, Texas" };
  const withCounty = plain(app.get("estimateCosts")({ askingPrice: 100000, site: { taxRate } }, s));
  assert.equal(withCounty.taxSource, "county");
  assert.equal(withCounty.taxPct, 1.8);
  assert.ok(Math.abs(withCounty.monthly.tax - 150) < 0.01);                     // 1.8% of $100,000 a year
  assert.ok(withCounty.notes.some((n) => n.includes("county's typical 1.8%")));
  s.costs.useCountyTax = false;
  assert.equal(plain(app.get("estimateCosts")({ askingPrice: 100000, site: { taxRate } }, s)).taxSource, "setting");
  s.costs.useCountyTax = true;
  assert.equal(plain(app.get("estimateCosts")({ askingPrice: 100000, site: { taxRate: { needsKey: true } } }, s)).taxPct, 1);   // no usable rate
  assert.equal(plain(app.get("estimateCosts")({ askingPrice: 100000, site: {} }, s)).taxSource, "setting");
});

// ---- groundwater (USGS Water Data API) ----
const gwMeta = (...sites) => ({ features: sites.map(([id, lon, lat]) => ({ properties: { monitoring_location_id: id }, geometry: { coordinates: [lon, lat] } })) });
const gwReading = (id, value, time) => ({ properties: { monitoring_location_id: id, value, time } });

test("nearestWellSites: closest first, each well once, bad rows skipped, at most 8", () => {
  const pick = pure.get("nearestWellSites");
  const meta = gwMeta(["USGS-FAR", -98.2, 30.4], ["USGS-NEAR", -98.41, 30.31], ["USGS-NEAR", -98.41, 30.31], ["USGS-NOGEO", null, null]);
  meta.features.push({ properties: {} }, { properties: { monitoring_location_id: "USGS-NOCOORDS" } });
  const sites = plain(pick(meta, 30.3, -98.4));
  assert.deepEqual(sites.map((s) => s.id), ["USGS-NEAR", "USGS-FAR"]);
  assert.ok(sites[0].distanceMiles < 2 && sites[1].distanceMiles > 10);
  assert.equal(plain(pick(gwMeta(...Array.from({ length: 20 }, (_, i) => [`USGS-${i}`, -98.4 + i * 0.001, 30.3])), 30.3, -98.4)).length, 8);
  assert.deepEqual(plain(pick({}, 30, -98)), []);
});

test("buildGroundwater: newest reading per well, names, age in years, wells with no reading left out", () => {
  const build = pure.get("buildGroundwater");
  const sites = [{ id: "USGS-A", distanceMiles: 1.04 }, { id: "USGS-B", distanceMiles: 3 }, { id: "USGS-C", distanceMiles: 4 }, { id: "USGS-D", distanceMiles: 5 }, { id: "USGS-E", distanceMiles: 6 }];
  const latest = { features: [gwReading("USGS-A", "85.24", "2024-03-05T12:00:00+00:00"), gwReading("USGS-A", "80", "2019-01-01T12:00:00+00:00"),
    gwReading("USGS-C", "", "2020-01-01T12:00:00+00:00"), gwReading("USGS-D", "30", "1996-07-08T12:00:00+00:00"), gwReading("USGS-E", "12.5", "2010-01-01T12:00:00+00:00")] };
  const names = { features: [{ properties: { id: "USGS-A", monitoring_location_name: "LR-57-1" } }] };
  const r = plain(build(sites, latest, names, Date.parse("2026-10-30T00:00:00Z")));
  assert.deepEqual(r.wells.map((w) => w.siteNo), ["A", "D", "E"]);          // B and C have no usable reading; only three are kept
  assert.equal(r.wells[0].depthFt, 85.2);
  assert.equal(r.wells[0].measured, "2024-03-05");
  assert.equal(r.wells[0].name, "LR-57-1");
  assert.equal(r.wells[0].distanceMiles, 1);
  assert.equal(r.wells[0].yearsAgo, 3);
  assert.equal(r.wells[1].yearsAgo, 30);
  assert.equal(r.wells[1].name, "(unnamed well)");
  assert.equal(r.searchedMiles, 17);
  assert.deepEqual(plain(build([], null, null, 0)).wells, []);
});

test("lookupGroundwater: lists wells in a box, then reads the nearest ones and names them", async () => {
  const fetchFn = fakeFetch({
    "field-measurements-metadata": { body: JSON.stringify(gwMeta(["USGS-301800098240001", -98.42, 30.30], ["USGS-300000098000009", -98.1, 30.5])) },
    "latest-field-measurements": { body: JSON.stringify({ features: [gwReading("USGS-301800098240001", "85.24", "2024-03-05T12:00:00+00:00")] }) },
    "monitoring-locations": { body: JSON.stringify({ features: [{ properties: { id: "USGS-301800098240001", monitoring_location_name: "TEST WELL 1" } }] }) },
  });
  const app = loadScripts(["config.js", "sources.js"], { fetch: fetchFn });
  const r = plain(await app.get("lookupGroundwater")(30.3, -98.4));
  assert.equal(r.wells.length, 1);
  assert.equal(r.wells[0].name, "TEST WELL 1");
  const first = decodeURIComponent(fetchFn.calls[0].url);
  assert.ok(first.includes("field-measurements-metadata/items") && first.includes("parameter_code=72019") && first.includes("bbox=-98.65000,30.05000,-98.15000,30.55000"), first);
  const second = decodeURIComponent(fetchFn.calls[1].url);
  assert.ok(second.includes("monitoring_location_id=USGS-301800098240001,USGS-300000098000009"), second);
});

test("lookupGroundwater: no wells in the box gives an empty list without more requests; names failing is not fatal", async () => {
  const none = fakeFetch({ "field-measurements-metadata": { body: JSON.stringify({ features: [] }) } });
  assert.deepEqual(plain(await loadScripts(["config.js", "sources.js"], { fetch: none }).get("lookupGroundwater")(30.3, -98.4)).wells, []);
  assert.equal(none.calls.length, 1);
  const noNames = fakeFetch({
    "field-measurements-metadata": { body: JSON.stringify(gwMeta(["USGS-1", -98.4, 30.3])) },
    "latest-field-measurements": { body: JSON.stringify({ features: [gwReading("USGS-1", "50", "2020-01-01T12:00:00+00:00")] }) },
    "monitoring-locations": { status: 500, body: "boom" },
  });
  const r = plain(await loadScripts(["config.js", "sources.js"], { fetch: noNames }).get("lookupGroundwater")(30.3, -98.4));
  assert.equal(r.wells[0].name, "(unnamed well)");
  assert.equal(r.wells[0].depthFt, 50);
});

test("lookupGroundwater: a service failure is thrown so the report can say so", async () => {
  const down = fakeFetch({ "field-measurements-metadata": { status: 503, body: "" } });
  await assert.rejects(() => loadScripts(["config.js", "sources.js"], { fetch: down }).get("lookupGroundwater")(30.3, -98.4));
});

// ---- Overpass requests wait in line ----
test("overpassQuery sends one request at a time, even when two lookups ask together", async () => {
  let inFlight = 0, mostAtOnce = 0;
  const fetchFn = async () => {
    inFlight += 1; mostAtOnce = Math.max(mostAtOnce, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));   // a slow server
    inFlight -= 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ elements: [{ id: 1 }] }) };
  };
  const app = loadScripts(["config.js", "sources.js"], { fetch: fetchFn });
  const query = app.get("overpassQuery");
  const [a, b, c] = await Promise.all([query("one"), query("two"), query("three")]);
  assert.equal(mostAtOnce, 1);
  assert.deepEqual([a.length, b.length, c.length], [1, 1, 1]);
});

test("overpassQuery names each server that failed, and a failure does not block the next request", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    if (calls <= 4) return { ok: false, status: 504, text: async () => "timeout" };   // every server fails for the first request
    return { ok: true, status: 200, text: async () => JSON.stringify({ elements: [{ id: 2 }] }) };
  };
  const app = loadScripts(["config.js", "sources.js"], { fetch: fetchFn });
  const query = app.get("overpassQuery");
  const first = query("one").catch((error) => error);
  const second = query("two");
  const error = await first;
  assert.match(error.message, /busy or slow/);
  assert.match(error.message, /overpass-api\.de: HTTP 504/);
  assert.match(error.message, /overpass\.openstreetmap\.fr: HTTP 504/);
  assert.match(error.message, /overpass\.kumi\.systems: HTTP 504/);
  assert.equal((await second).length, 1);
});

test("overpassQuery goes first to the server that answered last time", async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(String(url));
    if (String(url).includes("overpass-api.de")) return { ok: false, status: 406, text: async () => "not acceptable" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ elements: [] }) };
  };
  const app = loadScripts(["config.js", "sources.js"], { fetch: fetchFn });
  const query = app.get("overpassQuery");
  await query("one");   // the first server fails, the second answers
  await query("two");   // so the second one is asked first this time
  assert.equal(urls.length, 3);
  assert.ok(urls[0].includes("overpass-api.de") && urls[1].includes("openstreetmap.fr") && urls[2].includes("openstreetmap.fr"));
});

test("the places query asks for exact names and tags, never a name pattern", () => {
  const app = loadScripts(["config.js", "sources.js"]);
  const query = app.get("buildPlacesQuery")(30, -98, 12000, app.get("PLACE_KINDS"));
  assert.ok(!/\["name"~/.test(query), query);   // a name pattern makes the server search every name, which times out
  assert.ok(query.includes('["brand"="Costco"]') && query.includes('["shop"="agrarian"]'));
});

// ---- Clear data ----
test("clearAllData erases what was saved and goes back to the defaults", () => {
  const stored = {};
  const localStorage = { getItem: (k) => (k in stored ? stored[k] : null), setItem: (k, v) => { stored[k] = String(v); }, removeItem: (k) => { delete stored[k]; } };
  const document = { getElementById: () => ({}) };
  const app = loadScripts(["config.js", "scoring.js", "storage.js"], { localStorage, document });
  app.get("parcels").push({ id: "a", name: "Test" });
  app.get("saveParcels")();
  app.get("writeStored")("homestead-screener.settings.v1", { priceTarget: 1 });
  app.get("writeStored")("homestead-screener.view.v1", { sort: "price" });
  assert.equal(Object.keys(stored).length, 3);
  app.get("clearAllData")();
  assert.deepEqual(Object.keys(stored), []);
  assert.equal(app.get("parcels").length, 0);
  assert.equal(app.get("settings.priceTarget"), app.get("DEFAULT_SETTINGS.priceTarget"));
  assert.equal(app.get("view.sort"), app.get("DEFAULT_VIEW.sort"));
});

// ---- address suggestions ----
const photonFeature = (props, coords = [-98.4, 30.275]) => ({ properties: props, geometry: { coordinates: coords } });

test("suggestions: a street address becomes one line with state and ZIP", () => {
  const out = plain(pure.get("formatSuggestion")(photonFeature({ countrycode: "US", housenumber: "12", street: "County Road 12", city: "Blanco", state: "Texas", postcode: "78606" })));
  assert.deepEqual(out, { label: "12 County Road 12, Blanco, Texas 78606", lat: 30.275, lon: -98.4 });
});

test("suggestions: results outside the US or without a state are dropped", () => {
  const f = pure.get("formatSuggestion");
  assert.equal(f(photonFeature({ countrycode: "CA", street: "Main St", city: "Calgary", state: "Alberta" })), null);
  assert.equal(f(photonFeature({ countrycode: "US", name: "Somewhere" })), null);
});

test("suggestions: duplicates are merged and the list stops at six", async () => {
  const features = [];
  for (let i = 0; i < 9; i++) features.push(photonFeature({ countrycode: "US", housenumber: String(i), street: "Oak St", city: "Austin", state: "Texas", postcode: "78701" }));
  features.push(features[0]);
  const app = loadScripts(["config.js", "sources.js"], { fetch: fakeFetch({ "photon.komoot.io": { body: JSON.stringify({ features }) } }) });
  const list = plain(await app.get("suggestAddresses")("oak st austin"));
  assert.equal(list.length, 6);
  assert.equal(new Set(list.map((x) => x.label)).size, 6);
});

test("suggestions: a server error is thrown so the page can say so", async () => {
  const app = loadScripts(["config.js", "sources.js"], { fetch: fakeFetch({ "photon.komoot.io": { status: 503, body: "" } }) });
  await assert.rejects(() => app.get("suggestAddresses")("oak st"));
});

// ---- report section order ----
test("report order: unknown and repeated names are dropped, missing ones go last", () => {
  const norm = pure.get("normalizeReportOrder");
  const all = plain(pure.get("REPORT_SECTIONS")).map((x) => x[0]);
  assert.deepEqual(plain(norm(["cost", "bogus", "cost", "roads"])).slice(0, 2), ["cost", "roads"]);
  assert.equal(plain(norm(["cost", "bogus", "cost", "roads"])).length, all.length);
  assert.deepEqual(plain(norm(undefined)), all);
  assert.deepEqual(plain(norm("nope")), all);
});

test("report order: the default order lists every section once", () => {
  const defaults = plain(pure.get("DEFAULT_SETTINGS.reportOrder"));
  assert.deepEqual([...defaults].sort(), plain(pure.get("REPORT_SECTIONS")).map((x) => x[0]).sort());
});

// ---- USDA loan area ----
test("USDA: a point inside no ineligible area is eligible, one inside an area is not", async () => {
  const inside = loadScripts(["config.js", "sources.js"], { fetch: fakeFetch({ "rdgdwe.sc.egov.usda.gov": { body: JSON.stringify({ features: [{ attributes: { OBJECTID: 1 } }] }) } }) });
  assert.deepEqual(plain(await inside.get("lookupUsda")(30.27, -97.74)), { eligibleArea: false });
  const outside = loadScripts(["config.js", "sources.js"], { fetch: fakeFetch({ "rdgdwe.sc.egov.usda.gov": { body: JSON.stringify({ features: [] }) } }) });
  assert.deepEqual(plain(await outside.get("lookupUsda")(30.275, -98.4)), { eligibleArea: true });
});

test("USDA: a service error is a failure, not 'eligible'", async () => {
  const app = loadScripts(["config.js", "sources.js"], { fetch: fakeFetch({ "rdgdwe.sc.egov.usda.gov": { body: JSON.stringify({ error: { code: 500 } }) } }) });
  await assert.rejects(() => app.get("lookupUsda")(30.27, -97.74));
});

test("saved settings with the old percent down payment become dollars", () => {
  const storage = loadScripts(["config.js", "scoring.js", "sources.js", "storage.js"], {
    localStorage: { getItem: (k) => (k.includes("settings") ? JSON.stringify({ priceTarget: 200000, costs: { downPct: 10 } }) : null), setItem() {}, removeItem() {} },
    document: { getElementById: () => ({ hidden: true }) },
  });
  const loaded = plain(storage.get("loadSettings")());
  assert.equal(loaded.costs.downPayment, 20000);
  assert.equal(loaded.costs.downPct, undefined);
});

test("saved settings with old weights become ticked criteria, flood stays unticked and the switches keep their old behavior", () => {
  const storage = loadScripts(["config.js", "scoring.js", "sources.js", "storage.js"], {
    localStorage: { getItem: (k) => (k.includes("settings") ? JSON.stringify({ weights: { flood: 25, septic: 15, slope: 10, rain: 10, airport: 15, price: 20, hunting: 5, internet: 10 } }) : null), setItem() {}, removeItem() {} },
    document: { getElementById: () => ({ hidden: true }) },
  });
  const loaded = plain(storage.get("loadSettings")());
  const ticked = loaded.criteria.order.filter((k) => loaded.criteria.on[k]);
  assert.deepEqual([...ticked].sort(), ["airport", "internet", "price", "rain", "septic", "slope"]);
  assert.equal(ticked[0], "price");             // price had the biggest weight, so it comes first
  assert.equal(loaded.criteria.on.flood, false);
  assert.equal(loaded.weights, undefined);
  assert.equal(loaded.points, undefined);
  assert.equal(loaded.dealbreakers.flood, true);
  assert.equal(loaded.dealbreakers.airport, true);
  assert.equal(loaded.dealbreakers.price, false);
});
