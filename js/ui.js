"use strict";

/* =====================================================================
   6. Page helpers
   ===================================================================== */
const $ = (id) => document.getElementById(id);

// Escapes text before it goes into HTML, so a parcel name can never run as code.
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

// A label with a hover explanation. Hover it, tap it, or tab to it to read what the data means and who supplies it.
// The explanations are in GLOSSARY (config.js). A label with no entry is shown as plain text.
function helpLabel(label) {
  const tip = glossaryTip(label);
  if (!tip) return esc(label);
  // tabindex lets keyboard and touch users reach it; aria-label puts the explanation in front of screen readers.
  return `<span class="help" tabindex="0" role="note" data-tip="${esc(tip)}" aria-label="${esc(`${label}. ${tip}`)}">${esc(label)}</span>`;
}

// The floating explanation. One element is reused for every label. It is placed inside the open dialog (if any) because
// an open dialog covers everything outside it, and it uses fixed positioning so a scrolling table cannot clip it.
function showHelpTip(target) {
  hideHelpTip();
  const tip = document.createElement("div");
  tip.id = "help-tip";
  tip.setAttribute("aria-hidden", "true");       // screen readers already get the text from the label's aria-label
  tip.textContent = target.dataset.tip;
  (document.querySelector("dialog[open]") || document.body).appendChild(tip);
  const box = target.getBoundingClientRect();
  const width = tip.offsetWidth, height = tip.offsetHeight;
  const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8));
  // Below the label if it fits, otherwise above it.
  const top = box.bottom + 6 + height > window.innerHeight ? Math.max(8, box.top - height - 6) : box.bottom + 6;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
function hideHelpTip() {
  const old = document.getElementById("help-tip");
  if (old) old.remove();
}
document.addEventListener("mouseover", (e) => { const t = e.target.closest && e.target.closest(".help"); if (t) showHelpTip(t); });
document.addEventListener("mouseout", (e) => { if (e.target.closest && e.target.closest(".help")) hideHelpTip(); });
document.addEventListener("focusin", (e) => { const t = e.target.closest && e.target.closest(".help"); if (t) showHelpTip(t); });
document.addEventListener("focusout", hideHelpTip);
// The first Escape only closes the tip. Without preventDefault it would also close the report window behind it.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById("help-tip")) { e.preventDefault(); hideHelpTip(); }
}, true);
// Scrolling moves the label out from under the tip, so close it.
document.addEventListener("scroll", hideHelpTip, true);

// One row of a label and its value, used by the report sections.
const kv = (label, value) => `<div>${helpLabel(label)}</div><div>${value}</div>`;

// Turns "$250,000" or "10.5" into a number; blank gives null; junk gives NaN.
function parseNumber(text) {
  const cleaned = String(text).trim().replace(/[$,\s]/g, "");
  return cleaned === "" ? null : Number(cleaned);
}

const scoreClass = (v) => (v == null ? "none" : v >= 70 ? "hi" : v >= 50 ? "mid" : "lo");

function ranked() {
  const items = parcels.map((p) => ({ parcel: p, score: scoreParcel(p, settings) }));
  return applyView(items, view, settings);   // filter and sort the way the controls say
}

/* =====================================================================
   7. Map
   ===================================================================== */
let map = null, markerLayer = null, pickMode = false;

function initMap() {
  if (typeof L === "undefined") { $("map-warning").hidden = false; return; }
  map = L.map("map").setView([39.5, -98.35], 4); // starts over the whole United States
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18, attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  map.on("click", (event) => {
    if (!pickMode) return;
    $("f-lat").value = event.latlng.lat.toFixed(5);
    $("f-lon").value = event.latlng.lng.toFixed(5);
    coordsFromSuggestion = false;   // the person chose this spot, so typing in the address box must not wipe it
    endPick();
  });
}

const MARKER_COLORS = { hi: "#2b7a33", mid: "#d98200", lo: "#c62828", none: "#7a8a80" };

function drawMarkers(items) {
  if (!map) return;
  markerLayer.clearLayers();
  const points = [];
  for (const { parcel, score } of items) {
    const marker = L.circleMarker([parcel.lat, parcel.lon], {
      radius: 9, color: "#ffffff", weight: 2, fillColor: MARKER_COLORS[scoreClass(score.total)], fillOpacity: 0.95,
    }).addTo(markerLayer);
    marker.bindTooltip(`${parcel.name} (${scoreText(score.total)})`);
    marker.on("click", () => { if (!pickMode) openDetail(parcel.id); });
    points.push([parcel.lat, parcel.lon]);
  }
  if (points.length) map.fitBounds(points, { padding: [40, 40], maxZoom: 12 });
}

function startPick() {
  $("dlg-add").close();
  pickMode = true;
  document.body.classList.add("picking");
  $("map").scrollIntoView({ block: "center", behavior: "smooth" });
}

function endPick() {
  pickMode = false;
  document.body.classList.remove("picking");
  if (!$("dlg-add").open) $("dlg-add").showModal();
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && pickMode) endPick();
});

/* =====================================================================
   8. Rendering
   ===================================================================== */
// Parcels ticked for the side-by-side view (kept in memory only, at most three).
let compareIds = [];
const MAX_COMPARE = 3;

function updateCompareButton() {
  compareIds = compareIds.filter((id) => parcels.some((p) => p.id === id));   // forget deleted parcels
  const n = compareIds.length;
  $("btn-compare").textContent = n ? `Compare (${n})` : "Compare";
  $("btn-compare").disabled = n < 2;
}

function renderList(items) {
  if (items.length === 0 && parcels.length > 0) {
    $("list").innerHTML = `<div class="empty"><strong>No parcels match these filters.</strong><br>Change the status filter or untick "Hide dealbreakers".</div>`;
    return;
  }
  if (items.length === 0) {
    $("list").innerHTML = `<div class="empty"><strong>No parcels yet.</strong><br>Add one with a street address or by picking its spot on the map. You can also load three demo parcels to see how it works.</div>`;
    return;
  }
  updateCompareButton();
  const rows = items.map(({ parcel: p, score }, i) => {
    const site = p.site || {};
    const net = site.internet ? (site.internet.bestMbps != null ? `${site.internet.bestMbps} Mbps` : (site.internet.technologies.includes("Satellite") ? "Satellite" : "None listed")) : "?";
    const airportMin = airportMinutes(site, settings);
    const drive = airportMin != null ? `${Math.round(airportMin)} min` : "?";
    return `<tr class="row" data-open="${esc(p.id)}">
      <td class="col-pick"><input type="checkbox" data-compare="${esc(p.id)}" aria-label="Pick ${esc(p.name)} to compare"${compareIds.includes(p.id) ? " checked" : ""}></td>
      <td class="num col-n">${i + 1}</td>
      <td><button class="row-name" type="button" data-open="${esc(p.id)}">${esc(p.name)}</button>${score.dealbreakers.length ? `<span class="badge" title="${esc(score.dealbreakers.join("; "))}">Dealbreaker</span>` : ""}
        <div class="sub">${esc(countyLabel(p))} &middot; ${esc(p.acres ?? "?")} acres</div></td>
      <td><span class="score ${scoreClass(score.total)}">${scoreText(score.total)}</span><div class="sub">${score.factorsScored}/${score.factorsTotal} factors</div></td>
      <td>${esc(site.floodZone || "unknown")}</td>
      <td>${esc(net)}</td>
      <td class="num col-air">${esc(drive)}</td>
      <td class="num">${money(p.askingPrice)}</td>
      <td class="col-del">${deleteButton(p.id)}</td>
    </tr>`;
  }).join("");
  $("list").innerHTML = `<div class="table-scroll"><table>
    <thead><tr><th class="col-pick">Pick</th><th class="num col-n">#</th><th>Parcel</th><th>Score</th><th>Flood</th><th>Internet</th><th class="num col-air">To airport</th><th class="num">Price</th><th class="col-del" aria-label="Delete"></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function showComparison() {
  const items = compareIds.map((id) => parcels.find((p) => p.id === id)).filter(Boolean)
    .map((parcel) => ({ parcel, score: scoreParcel(parcel, settings) }));
  if (items.length < 2) return;
  const rows = buildComparison(items, settings);
  $("compare").innerHTML = `<div class="table-scroll"><table class="compare-table">
    <thead><tr><th></th>${items.map((it) => `<th>${esc(it.parcel.name)}<div class="sub">${esc(countyLabel(it.parcel))}</div></th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${helpLabel(r.label)}</td>${r.cells.map((c) => `<td class="${c.best ? "best" : ""}">${esc(c.text)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    <p class="hint">A star marks the best value in a row when the parcels differ. Drive times marked from OpenStreetMap places can be missing in rural areas.</p>
    <p class="source">Sources: ${comparisonSourceKeys(items).map((k) => `${esc(DATA_SOURCES[k].label)}: ${DATA_SOURCES[k].url ? `<a href="${esc(DATA_SOURCES[k].url)}" target="_blank" rel="noopener">${esc(DATA_SOURCES[k].name)}</a>` : esc(DATA_SOURCES[k].name)}`).join("; ")}. Open a parcel for the data dates.</p>`;
  $("dlg-compare").showModal();
}

function renderAll() {
  const items = ranked();
  renderList(items);
  drawMarkers(items);
}

// A small "Source:" line under a section. `keys` is one or more keys of DATA_SOURCES.
function sourceHtml(keys, site) {
  const items = [].concat(keys).map((key) => {
    const info = DATA_SOURCES[key];
    const name = info.url ? `<a href="${esc(info.url)}" target="_blank" rel="noopener">${esc(info.name)}</a>` : esc(info.name);
    return `${name}, ${esc(sourceVintage(key, site))}`;
  });
  return `<p class="source">Source: ${items.join("; ")}.</p>`;
}

// The list that ends the report: every source used, with the address spelled out so it still reads on paper.
function sourcesFooterHtml(keys, site, fetchedAt) {
  if (!keys.length) return `<p class="hint">No data has been looked up for this parcel yet.</p>`;
  return `<ul class="sources">${keys.map((key) => {
    const info = DATA_SOURCES[key];
    return `<li><strong>${esc(info.label)}:</strong> ${esc(info.name)}, ${esc(sourceVintage(key, site))}${info.url ? ` <span class="src-url">${esc(info.url)}</span>` : ""}</li>`;
  }).join("")}</ul>
    <p class="hint">${fetchedAt ? `Data fetched ${esc(new Date(fetchedAt).toLocaleDateString())}. ` : ""}Public data changes, so use Refresh data before a decision.</p>`;
}

function internetHtml(internet) {
  if (!internet) return `<p class="hint">Internet data is not available for this parcel. Try Refresh data.</p>`;
  const summary = internet.providers.length === 0
    ? `No providers were listed for this census block in the ${esc(internet.vintage)} data.`
    : `${internet.bestMbps != null ? `Best listed non-satellite download: <strong>${internet.bestMbps} Mbps</strong>. ` : "No wired or fixed-wireless service listed. "}Technologies listed: ${esc(internet.technologies.join(", "))}.`;
  const rows = internet.providers.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.tech)}</td><td class="num">${p.down} / ${p.up}</td></tr>`).join("");
  return `<p style="margin:0">${summary}</p>
    ${rows ? `<div class="table-scroll"><table><thead><tr><th>Provider</th><th>Technology</th><th class="num">Max Mbps down / up</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
    <p class="hint">FCC Form 477 data from ${esc(internet.vintage)} (the latest block-level set in the FCC's open data), reported per census block. A block counts as served if any location in it is, so this likely overstates coverage on rural land, and it does not include newer services such as Starlink. Check the exact address on the <a href="https://broadbandmap.fcc.gov/" target="_blank" rel="noopener">FCC National Broadband Map</a> and with each provider before relying on it.</p>`;
}

function placesHtml(places) {
  if (!places) return `<p class="hint">Nearby places are not available for this parcel. Try Refresh data.</p>`;
  const rows = PLACE_GROUPS.map((group) => {
    const kindRows = group.kinds.map((key) => {
      const kind = PLACE_KINDS.find((k) => k.key === key);
      const place = places[key];
      if (!(key in places)) return `<tr><td>${esc(kind.label)}</td><td colspan="3">${notYetText()}</td></tr>`;   // saved before this kind existed
      if (!place) return `<tr><td>${esc(kind.label)}</td><td colspan="3">None found within about 75 miles</td></tr>`;
      return `<tr><td>${esc(kind.label)}</td><td>${esc(place.name)}</td>
        <td class="num">${place.miles} mi</td>
        <td class="num">${place.driveMin != null ? `${place.driveMin} min` : `~${Math.round(driveMinutes(place.miles, settings))} min`}</td></tr>`;
    }).join("");
    return `<tr class="group-row"><th colspan="4">${esc(group.label)}</th></tr>${kindRows}`;
  }).join("");
  return `<div class="table-scroll"><table><thead><tr><th>Type</th><th>Nearest</th><th class="num">Straight line</th><th class="num">Drive</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="hint">From OpenStreetMap, which volunteers keep up to date. Rural shops are often missing or unnamed, so "none found" does not prove there is none. School levels come from the grades, the level tag or the name, and a school with none of those is skipped. Private and charter schools are included, and the list says nothing about which school serves your address, so ask the district. Volunteer fire departments and small sheriff substations are often missing, and a hospital listed here may not run a full emergency room, so call to confirm before you rely on it. A drive time with "~" is estimated from straight-line distance; one without it comes from a road route. Confirm on a map before you rely on it.</p>`;
}

function publicLandHtml(pl) {
  if (pl === undefined) return `<p class="hint">${notYetText()}</p>`;
  if (pl === null) return `<p class="hint">No protected-land data for this spot.</p>`;
  const headline = pl.withinMiles == null ? "No public or protected land mapped within 25 miles."
    : pl.withinMiles === 0 ? "This point is on protected land. Check that the parcel really is private property."
    : `Nearest public or protected land is within ${pl.withinMiles} miles.`;
  const rows = pl.areas.map((a) => `<tr><td>${esc(a.name)}</td><td>${esc(a.manager)}</td><td>${esc(a.type || "")}</td><td>${esc(a.access)}</td><td class="num">${a.acres ? a.acres.toLocaleString("en-US") : "?"}</td></tr>`).join("");
  return `<p style="margin:0">${esc(headline)}</p>
    ${rows ? `<div class="table-scroll"><table><thead><tr><th>Area</th><th>Managed by</th><th>Type</th><th>Public access</th><th class="num">Acres</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
    <p class="hint">From the USGS Protected Areas Database. The list shows areas within the distance above, not in order of distance, and leaves out areas whose public access is unknown. "Open" access means people can visit, not that hunting or camping is allowed: check the managing agency and your state wildlife agency (in Texas, Texas Parks and Wildlife has a public hunting program). Land next to a parcel can be nice, but a neighboring public area can also bring crowds, hunting pressure or fire risk.</p>`;
}

function wetlandsHtml(w) {
  if (w === undefined) return `<p class="hint">${notYetText()}</p>`;
  if (w === null) return `<p class="hint">No wetlands data for this spot.</p>`;
  const nearby = w.nearbyCount > 0 ? `${w.nearbyMore ? "100 or more" : w.nearbyCount} mapped (${esc(w.nearbyTypes.join(", ") || "type not listed")})` : "none mapped";
  return `${w.onWetland ? `<p class="notice bad"><strong>This point is inside a mapped wetland</strong> (${esc(w.onTypes.join(", ") || "type not listed")}). Building, filling or draining a wetland can need federal and state permits.</p>` : ""}
    <div class="kv">
      ${`<div>At this point</div><div>${w.onWetland ? "inside a mapped wetland" : "not in a mapped wetland"}</div>`}
      ${`<div>Within a quarter mile</div><div>${nearby}</div>`}
    </div>
    <p class="hint">From the US Fish and Wildlife Service National Wetlands Inventory, mapped mostly from aerial photos. It is a screening map, not a legal wetland boundary: small or seasonal wetlands can be missing, and some areas were mapped decades ago. A formal wetland delineation (done by a qualified consultant, for the Army Corps of Engineers) decides what counts. Ponds and lakes are included here.</p>`;
}

function groundwaterHtml(gw) {
  if (gw === undefined) return `<p class="hint">${notYetText()}</p>`;
  if (gw === null) return `<p class="hint">No groundwater data for this spot.</p>`;
  const body = gw.wells.length
    ? `<div class="table-scroll"><table><thead><tr><th>Monitoring well</th><th class="num">Distance</th><th class="num">Depth to water</th><th>Measured</th></tr></thead><tbody>${gw.wells.map((w) =>
      `<tr><td>${esc(w.name)}${w.siteNo ? ` <span class="sub">USGS ${esc(w.siteNo)}</span>` : ""}</td><td class="num">${w.distanceMiles} mi</td><td class="num">${w.depthFt} ft</td><td>${esc(w.measured)}</td></tr>`).join("")}</tbody></table></div>`
    : `<p>No USGS monitoring well with a reading in the past 10 years within about ${gw.searchedMiles} miles.</p>`;
  return `${body}
    <p class="hint">Depth is feet below ground to the water level in a monitoring well, which is not your lot. Water depth, rock type and well yield can differ a lot over a mile, and a deep or shallow reading nearby does not tell you what a new well will find. A monitoring well may tap a different layer (aquifer) than a household well would. In Texas, the Texas Water Development Board's Water Data for Texas site has driller reports for existing wells near you, and your groundwater conservation district sets the drilling rules. Ask a local well driller what depth and yield to expect.</p>`;
}

function roadsHtml(roads) {
  if (roads === undefined) return `<p class="hint">${notYetText()}</p>`;
  if (roads === null) return `<p class="hint">No road data for this spot.</p>`;
  const describe = (road) => (road ? `${esc(road.name)} <span class="sub">(${esc(road.type.replace(/_/g, " "))}${road.surface === "unknown" ? "" : `, ${esc(road.surface)}`}${road.access ? `, access: ${esc(road.access)}` : ""})</span>` : "");
  const far = !roads.nearest || roads.nearest.distanceFt > 1500;
  return `${far ? `<p class="notice">${roads.nearest ? "The nearest road is far from this spot" : "No road found near this spot"}. Confirm how you would get to the land, and whether you have a legal right to use that route.</p>` : ""}
    <div class="kv">
      ${kv("Nearest road", roads.nearest ? `${esc(distanceText(roads.nearest.distanceFt))} away: ${describe(roads.nearest)}` : `none within ${esc(distanceText(Math.round(roads.searchedMeters * 3.28084)))}`)}
      ${kv("Nearest paved public road", roads.nearestPublicPaved ? `${esc(distanceText(roads.nearestPublicPaved.distanceFt))} away: ${describe(roads.nearestPublicPaved)}` : `none within ${esc(distanceText(Math.round(roads.searchedMeters * 3.28084)))}`)}
    </div>
    <p class="hint">From OpenStreetMap. This shows that a road exists near the point you picked, not that the parcel touches it or that you may use it. Many rural roads and driveways are private, and some roads are missing. Legal access (road frontage, an easement) shows up in the deed and the survey, so check those with the county and a title company.</p>`;
}

function climateHtml(climate, solar) {
  if (climate === undefined) return `<p class="hint">${notYetText()}</p>`;   // saved before this feature existed
  if (climate === null) return `<p class="hint">No climate data for this spot.</p>`;
  const freeze = climate.lastSpringFreeze
    ? kv("Last spring freeze (average)", esc(climate.lastSpringFreeze)) + kv("First fall freeze (average)", esc(climate.firstFallFreeze || "none"))
      + kv("Frost-free days", `${climate.frostFreeDays} <span class="sub">(freezes in ${climate.freezeYears} of ${climate.years} years)</span>`)
    : kv("Freezes", `rare: ${climate.freezeYears} of ${climate.years} years had one`);
  const sun = solar ? kv("Sunlight", `${solar.sunHoursPerDay} full-sun hours a day <span class="sub">(best ${esc(solar.bestMonth.name)} ${solar.bestMonth.value}, lowest ${esc(solar.worstMonth.name)} ${solar.worstMonth.value})</span>`)
    + kv("Rough solar output", `about ${solar.kwhPerKwYear.toLocaleString("en-US")} kWh a year for each kW of panels`) : "";
  return `<div class="kv">
      ${freeze}
      ${kv("Freezing days a year", climate.freezingDaysPerYear)}
      ${kv("Days over 90 F / 100 F", `${climate.daysOver90F} / ${climate.daysOver100F}`)}
      ${kv("Typical January low / July high", `${climate.januaryLowF} F / ${climate.julyHighF} F`)}
      ${kv("Snow", `${climate.snowInchesPerYear} in a year`)}
      ${sun}
    </div>
    <p class="hint">Worked out from ${climate.years} years of daily weather from Open-Meteo, a computer model of the atmosphere with a grid about 10 km wide, not a weather station at your lot. Low ground and hilltops can freeze two weeks earlier or later than the model says. "Full-sun hours" is sunlight energy on flat ground divided by a full-sun hour, and the solar output is a rough rule (80% of sun hours times 365 days) for a flat-lying panel. Real output depends on tilt, shade and equipment. For planting dates ask your county extension office.</p>`;
}

function soilDetailsHtml(sd) {
  if (sd === undefined) return `<p class="hint">${notYetText()}</p>`;   // saved before this feature existed
  if (sd === null) return `<p class="hint">The USDA has no soil survey data for this spot.</p>`;
  const percent = (v) => (v == null ? "?" : `${v}%`);
  const rating = (v) => esc(v || "?");
  const topsoil = sd.texture
    ? `${esc(sd.texture)} <span class="sub">(${percent(sd.sandPct)} sand, ${percent(sd.siltPct)} silt, ${percent(sd.clayPct)} clay)</span>` : "?";
  return `<div class="kv">
      ${kv("Topsoil", topsoil)}
      ${kv("Organic matter / pH", `${percent(sd.organicMatterPct)} / ${sd.ph == null ? "?" : sd.ph}`)}
      ${kv("Water the top 5 ft can hold", sd.waterHoldingIn == null ? "?" : `${sd.waterHoldingIn} in`)}
      ${kv("Farmland class", esc(sd.farmland || "?"))}
      ${kv("Wetland-type (hydric) soil", esc(sd.hydric || "?"))}
      ${kv("Seasonal water table", sd.waterTableDepthIn == null ? "none listed" : `${esc(depthText(sd.waterTableDepthIn))} below the surface`)}
      ${kv("Depth to bedrock", sd.bedrockDepthIn == null ? "none listed within the survey depth" : `${esc(depthText(sd.bedrockDepthIn))} <span class="sub">(${esc(sd.bedrockKind || "bedrock")})</span>`)}
      ${kv("Flooding / ponding (soil survey)", `${esc(sd.flooding || "?")} / ${esc(sd.ponding || "?")}`)}
      ${kv("Shrink-swell", esc(sd.shrinkSwell || "?"))}
      ${kv("Water runoff group", esc(sd.hydrologicGroup || "?"))}
      ${sd.interps ? kv("Home without basement", rating(sd.interps.dwellings)) + kv("Shallow excavations", rating(sd.interps.excavations)) + kv("Local roads", rating(sd.interps.roads)) + kv("Pond reservoir", rating(sd.interps.ponds)) + kv("Sewage lagoon", rating(sd.interps.lagoons)) : ""}
    </div>
    <p class="hint">From the USDA soil survey, for the main soil type at this point. Soil changes over short distances, so a different part of the parcel can differ. The building ratings say how much the soil limits a use, not whether it can be done: "Very limited" often just means more engineering. A shrink-swell rating of High or Very high means foundations and driveways need extra care. This does not replace a soil test, a percolation test or a geotechnical report.</p>`;
}

function hazardsHtml(hazards) {
  if (hazards === undefined) return `<p class="hint">${notYetText()}</p>`;   // saved before this feature existed
  if (hazards === null) return `<p class="hint">FEMA has no risk rating for this spot.</p>`;
  const rows = hazards.hazards.map((h) =>
    `<tr><td>${esc(h.name)}</td><td class="risk-${h.level}">${esc(h.rating)}</td></tr>`).join("");
  return `<p style="margin:0"><strong>Overall: ${esc(hazards.overall)}</strong>${hazards.unrated ? ` <span class="sub">(${hazards.unrated} of 18 hazards do not apply here)</span>` : ""}</p>
    <div class="table-scroll"><table><thead><tr><th>Hazard</th><th>FEMA rating</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="hint">From FEMA's National Risk Index, which rates each census tract (a neighborhood-sized area, not your exact lot) against the rest of the United States. A rating combines how likely a hazard is, what it would damage, and how well the community can cope. It is not a forecast, and it does not replace the flood zone above, which is specific to the parcel. Read more at <a href="https://hazards.fema.gov/nri/" target="_blank" rel="noopener">hazards.fema.gov/nri</a>.</p>`;
}

// Tells you how to get the county tax rate when the Census asked for a key.
function taxKeyHint(parcel) {
  const t = (parcel.site || {}).taxRate;
  if (t === undefined) return "";
  if (t && t.needsKey) return `<p class="hint">${t.keyRejected ? "The Census did not accept your API key." : "The Census asks for a free API key before it will share county tax rates."} Get one at <a href="https://api.census.gov/data/key_signup.html" target="_blank" rel="noopener">api.census.gov/data/key_signup.html</a> and paste it into Criteria, then click Refresh data.</p>`;
  if (t === null) return `<p class="hint">The Census has no property tax figure for this county, so your own tax setting is used.</p>`;
  return "";
}

function costHtml(parcel) {
  const est = estimateCosts(parcel, settings);
  if (!est) return `<p class="hint">Add an asking price to see a rough cost estimate.</p>`;
  const c = settings.costs;
  const loanText = c.years > 0 ? `${money(est.monthly.loan)}` : "$0 (cash)";
  return `<div class="kv">
      <div>Loan payment</div><div>${loanText}${c.years > 0 ? ` <span class="sub">(${c.downPct}% down, ${c.ratePct}% for ${c.years} years)</span>` : ""}</div>
      <div>Property tax</div><div>${money(est.monthly.tax)} <span class="sub">(${est.taxPct}% a year, ${est.taxSource === "county" ? `typical for ${esc(parcel.site.taxRate.name)}` : "your setting"})</span></div>
      <div>Insurance</div><div>${money(est.monthly.insurance)}</div>
      <div><strong>About per month</strong></div><div><strong>${money(est.monthly.total)}</strong></div>
      <div>Cash down payment</div><div>${money(est.downPayment)}</div>
      <div>Septic system</div><div>${money(est.oneTime.septic)}</div>
      <div>Water well</div><div>${money(est.oneTime.well)}</div>
      <div><strong>One-time start-up</strong></div><div><strong>${money(est.oneTime.total)}</strong></div>
    </div>
    <p class="hint">${esc(est.notes.join(" "))} These numbers come from the placeholder rates and prices in Criteria, not from a quote. Property tax, insurance and building costs vary widely by state and county, and this leaves out the house, the driveway, electricity, and loan fees. Ask a lender, the county tax office and local contractors.</p>${taxKeyHint(parcel)}`;
}

function openDetail(id) {
  const p = parcels.find((x) => x.id === id);
  if (!p) return;
  const score = scoreParcel(p, settings);
  const site = p.site || {};
  detailId = id;
  const busy = lookingId === p.id;
  const factorRows = Object.entries(score.parts).map(([name, v]) => `<tr>
      <td>${helpLabel(FACTOR_LABELS[name])}</td>
      <td class="num">${v == null ? "no data" : Math.round(v)}</td>
      <td>${v == null ? "" : `<div class="bar"><span style="width:${v}%"></span></div>`}</td>
      <td class="num">${settings.weights[name]}</td></tr>`).join("");
  let drive = "?";
  if (site.airportMiles != null) {
    drive = site.airportDriveMin != null
      ? `${site.nearestAirport}, ${site.airportRoadMiles} mi by road (about ${site.airportDriveMin} min drive, from a road route)`
      : `${site.nearestAirport}, ${site.airportMiles} mi straight line (about ${Math.round(driveMinutes(site.airportMiles, settings))} min drive, estimated)`;
  }
  $("detail").innerHTML = `
    <div class="dlg-bar no-print">
      <div class="bar-group">
        <button class="btn small" type="button" data-refresh="${esc(p.id)}"${busy ? " disabled" : ""}>${busy ? "Looking up..." : "Refresh data"}</button>
        <button class="btn small" type="button" data-print>Print</button>
        <button class="btn small" type="button" data-copy-summary="${esc(p.id)}">Copy summary</button>
      </div>
      <div class="bar-group">
        <button class="btn small primary" type="button" data-save-notes="${esc(p.id)}">Save notes</button>
        ${deleteButton(p.id)}
        <button class="btn small" type="button" data-close>Close</button>
      </div>
    </div>
    <div class="dlg-head">
      <div><h2 id="detail-title">${esc(p.name)}</h2>
        <div class="sub">${esc(p.address || "")}${p.address ? " &middot; " : ""}${esc(countyLabel(p))} &middot; ${esc(p.acres ?? "?")} acres &middot; ${money(p.askingPrice)}</div></div>
    </div>
    <div class="dlg-body">
      <div class="print-only sub">Printed ${esc(new Date().toLocaleDateString())} from Homestead Land Screener. Data sources are listed at the end of the report.</div>
      ${busy ? `<p class="notice no-print" role="status">Looking up data: ${lookupDone} of ${SOURCE_STEPS.length + 2} lookups finished. The report fills in as each one arrives.</p>` : ""}
      ${score.dealbreakers.length ? `<p class="notice bad"><strong>Dealbreakers:</strong> ${esc(score.dealbreakers.join("; "))}</p>` : ""}
      <div class="score-line"><span class="big">${scoreText(score.total)}</span><span class="sub">score &middot; ${score.factorsScored} of ${score.factorsTotal} factors had data</span></div>
      <div class="table-scroll"><table><thead><tr><th>Factor</th><th class="num">Score</th><th></th><th class="num">Weight</th></tr></thead><tbody>${factorRows}</tbody></table></div>
      ${!busy && p.errors && p.errors.length ? `<p class="notice">Some lookups failed, so the score is partial: ${esc(p.errors.join("; "))}. Use Refresh data to try again.</p>` : ""}
      <h3>What the data says</h3>
      <div class="kv">
        ${kv("Coordinates", `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`)}
        ${kv("FEMA flood zone", esc(site.floodZone || "unknown (not mapped or lookup failed)"))}
        ${kv("Elevation", site.elevationFt != null ? `${site.elevationFt} ft` : "?")}
        ${kv("Slope (steepest of 4 directions)", site.slopePct != null ? `${site.slopePct}%` : "?")}
        ${kv("Soil", esc(site.soilName || "?"))}
        ${kv("Drainage class", esc(site.drainageClass || "?"))}
        ${kv("Septic rating", esc(site.septicRating || "?"))}
        ${kv("Average yearly rain", site.annualRainIn != null ? `${site.annualRainIn} in` : "?")}
        ${kv("Nearest airport", esc(drive))}
        ${kv("Plant hardiness zone", site.hardiness ? `${esc(hardinessText(site.hardiness))} <span class="sub">by ZIP ${esc(site.hardiness.zip)}, USDA ${esc(site.hardiness.vintage)} map</span>` : (site.hardiness === undefined ? "not looked up yet" : "?"))}
        ${kv("Data fetched", p.fetchedAt ? esc(new Date(p.fetchedAt).toLocaleString()) : "never")}
      </div>
      <p class="source">Sources for this table: ${["county", "flood", "elevation", "soil", "rain", "airport", "hardiness"].filter((k) => sourceKeysUsed(p).includes(k)).map((k) => `${esc(DATA_SOURCES[k].label)}: ${DATA_SOURCES[k].url ? `<a href="${esc(DATA_SOURCES[k].url)}" target="_blank" rel="noopener">${esc(DATA_SOURCES[k].name)}</a>` : esc(DATA_SOURCES[k].name)}, ${esc(sourceVintage(k, site))}`).join("; ")}.</p>
      <h3>Internet</h3>
      ${internetHtml(site.internet)}
      ${sourceHtml("internet", site)}
      <h3>Nearby</h3>
      ${placesHtml(site.places)}
      ${sourceHtml("places", site)}
      <h3>Public and protected land</h3>
      ${publicLandHtml(site.publicLand)}
      ${sourceHtml("publicLand", site)}
      <h3>Groundwater</h3>
      ${groundwaterHtml(site.groundwater)}
      ${sourceHtml("groundwater", site)}
      <h3>Wetlands</h3>
      ${wetlandsHtml(site.wetlands)}
      ${sourceHtml("wetlands", site)}
      <h3>Road access</h3>
      ${roadsHtml(site.roads)}
      ${sourceHtml("roads", site)}
      <h3>Climate and solar</h3>
      ${climateHtml(site.climate, site.solar)}
      ${sourceHtml("climate", site)}
      <h3>Soil details</h3>
      ${soilDetailsHtml(site.soilDetails)}
      ${sourceHtml("soilDetails", site)}
      <h3>Natural hazards</h3>
      ${hazardsHtml(site.hazards)}
      ${sourceHtml("hazards", site)}
      <h3>Rough cost</h3>
      ${costHtml(p)}
      ${sourceHtml("costs", site)}${p.site && p.site.taxRate && p.site.taxRate.ratePct != null ? sourceHtml("taxRate", site) : ""}
      <h3>Data sources</h3>
      ${sourcesFooterHtml(sourceKeysUsed(p), site, p.fetchedAt)}
      <h3>Your notes</h3>
      <div class="print-only"><p>Status: ${esc(p.status)}</p><p class="notes-print">${esc(p.notes || "(none)")}</p></div>
      <div class="fields no-print">
        <label>Status
          <select id="d-status">${["new", "interested", "visited", "rejected"].map((s) => `<option value="${s}"${s === p.status ? " selected" : ""}>${s}</option>`).join("")}</select>
        </label>
        <label class="wide">Notes <textarea id="d-notes" rows="4">${esc(p.notes || "")}</textarea></label>
      </div>
      <p class="hint no-print" id="summary-msg" role="status" hidden></p>
      <textarea id="summary-text" class="no-print" rows="8" readonly hidden></textarea>
    </div>
`;
  if (!$("dlg-detail").open) $("dlg-detail").showModal();
}

/* ---- live report: the open report fills in while the lookups run ---- */
let detailId = null;     // the parcel whose report is open, or null
let lookingId = null;    // the parcel being looked up right now, or null
let lookupDone = 0;      // how many of its lookups have finished
let liveTimer = null;

// What a section says when its data is missing: "Looking up now" during a lookup, otherwise how to fetch it.
function notYetText() {
  return lookingId && lookingId === detailId ? "Looking up now..." : "Not looked up yet. Click Refresh data.";
}

// Redraws the open report, keeping the scroll position and whatever was typed in the notes box.
function liveRender() {
  const dialog = $("dlg-detail");
  if (!detailId || !dialog.open) return;
  const notes = $("d-notes"), status = $("d-status");
  const kept = notes ? { notes: notes.value, status: status.value, focused: document.activeElement === notes, caret: notes.selectionStart } : null;
  const top = dialog.scrollTop;
  hideHelpTip();
  openDetail(detailId);
  dialog.scrollTop = top;
  if (kept) {
    $("d-notes").value = kept.notes;
    $("d-status").value = kept.status;
    if (kept.focused) { $("d-notes").focus(); $("d-notes").setSelectionRange(kept.caret, kept.caret); }
  }
}
// Several lookups can finish at the same moment, so wait a moment and redraw once.
function scheduleLiveRender() {
  if (liveTimer) return;
  liveTimer = setTimeout(() => { liveTimer = null; liveRender(); }, 150);
}

/* ---- the lookup progress strip ---- */
let statusTimer = null;
function showProgress(label, state) {
  const box = $("status");
  box.hidden = false;
  let chip = box.querySelector(`[data-chip="${label}"]`);
  if (!chip) {
    chip = document.createElement("span");
    chip.dataset.chip = label;
    box.appendChild(chip);
  }
  chip.className = `chip ${state}`;
  chip.innerHTML = `<i></i>${esc(label)}${state === "failed" ? " failed" : ""}`;
  if (state !== "running") { lookupDone += 1; scheduleLiveRender(); }
}
function clearProgress(delayMs) {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { $("status").hidden = true; $("status").innerHTML = ""; }, delayMs);
}

async function runLookups(parcel) {
  clearTimeout(statusTimer);
  lookingId = parcel.id;
  lookupDone = 0;
  $("status").innerHTML = `<strong style="font-size:.85rem">Looking up ${esc(parcel.name)}:</strong>`;
  try {
    await lookupAll(parcel, showProgress);
  } finally {
    lookingId = null;
  }
  saveParcels();
  renderAll();
  liveRender();
  clearProgress(10000);
}

/* =====================================================================
   9. Actions
   ===================================================================== */
async function addParcelFromForm(event) {
  event.preventDefault();
  const errorBox = $("add-error");
  errorBox.hidden = true;
  const fail = (message) => { errorBox.textContent = message; errorBox.hidden = false; };

  const address = $("f-address").value.trim();
  const name = $("f-name").value.trim() || address;   // the address is the default name
  let lat = parseNumber($("f-lat").value), lon = parseNumber($("f-lon").value);
  const acres = parseNumber($("f-acres").value), price = parseNumber($("f-price").value);
  if (!name) return fail("Enter a name or an address.");
  if ([lat, lon, acres, price].some((v) => Number.isNaN(v))) return fail("Latitude, longitude, acres and price must be numbers.");
  if ((lat == null) !== (lon == null)) return fail("Enter both latitude and longitude, or neither.");

  const button = $("btn-save");
  button.disabled = true;
  button.textContent = "Looking up address...";
  try {
    if (lat == null) {
      if (!address) return fail("Enter an address, enter coordinates, or pick the spot on the map.");
      let match;
      try { match = await geocodeAddress(address); } catch { return fail("The address lookup service did not respond. Try again, or pick the spot on the map."); }
      if (!match) return fail("No match for that address. Pick the spot on the map instead.");
      lat = match.lat; lon = match.lon;
    }
    if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) return fail("Coordinates are out of range.");
    if (!inUnitedStates(lat, lon)) return fail("That spot looks outside the United States, and these data sources only cover the US. Check the latitude and longitude (US longitudes are negative).");

    const parcel = { id: newId(), name, address: address || null, lat, lon, county: null, acres, askingPrice: price,
      status: "new", notes: "", createdAt: new Date().toISOString(), site: {}, errors: [], fetchedAt: null };
    parcels.push(parcel);
    saveParcels();
    renderAll();
    $("form-add").reset();
    closeSuggestions();
    coordsFromSuggestion = false;
    nameFromAddress = true;
    $("dlg-add").close();
    const lookups = runLookups(parcel);   // starts now; the report below fills in as each lookup finishes
    openDetail(parcel.id);
    await lookups;
  } finally {
    button.disabled = false;
    button.textContent = "Add and look up data";
  }
}

function loadDemo() {
  // Every value here is invented, only to show what the app looks like.
  const internet = (best, techs, providers) => ({ bestMbps: best, technologies: techs, providers, blockCode: "demo", vintage: "June 2021" });
  // A quick way to write the five nearby places: miles and name for each.
  const places = (gMi, gName, hMi, hName, cMi, cName, fMi, fName, vMi, vName) => ({
    grocery: { name: gName, miles: gMi }, hardware: { name: hName, miles: hMi },
    costco: { name: cName, miles: cMi }, feed: { name: fName, miles: fMi }, vet: { name: vName, miles: vMi },
  });
  const demo = [
    { name: "DEMO: Creekside 10 acres", lat: 30.31, lon: -98.55, acres: 10, askingPrice: 95000, county: "Demo",
      site: { floodZone: "X", elevationFt: 1120, slopePct: 4.5, soilName: "Demo clay loam, 1 to 3 percent slopes", drainageClass: "Well drained", septicRating: "Not limited", annualRainIn: 33, airportMiles: 55, nearestAirport: "Austin (AUS)",
        places: places(8, "Demo Market", 12, "Demo Hardware", 40, "Demo Warehouse Club", 14, "Demo Feed & Supply", 9, "Demo Animal Clinic"),
        internet: internet(50, ["Fixed wireless", "DSL", "Satellite"], [{ name: "Demo Wireless Co", tech: "Fixed wireless", down: 50, up: 5 }, { name: "Demo Telephone", tech: "DSL", down: 12, up: 1 }, { name: "Demo Sky", tech: "Satellite", down: 25, up: 3 }]) } },
    { name: "DEMO: Low ground 5 acres", lat: 30.05, lon: -97.9, acres: 5, askingPrice: 70000, county: "Demo",
      site: { floodZone: "AE", elevationFt: 640, slopePct: 1, soilName: "Demo alluvial silt loam", drainageClass: "Poorly drained", septicRating: "Very limited", annualRainIn: 35, airportMiles: 25, nearestAirport: "Austin (AUS)",
        places: places(2, "Demo Market", 4, "Demo Hardware", 22, "Demo Warehouse Club", 6, "Demo Feed & Supply", 3, "Demo Animal Clinic"),
        internet: internet(1000, ["Fiber", "Cable"], [{ name: "Demo Fiber", tech: "Fiber", down: 1000, up: 1000 }, { name: "Demo Cable", tech: "Cable", down: 300, up: 20 }]) } },
    { name: "DEMO: Hilltop 12 acres", lat: 30.5, lon: -98.95, acres: 12, askingPrice: 140000, county: "Demo",
      site: { floodZone: "X", elevationFt: 1480, slopePct: 14, soilName: "Demo shallow rocky loam", drainageClass: "Well drained", septicRating: "Somewhat limited", annualRainIn: 28, airportMiles: 80, nearestAirport: "Austin (AUS)",
        places: places(18, "Demo Market", 25, "Demo Hardware", 70, "Demo Warehouse Club", 20, "Demo Feed & Supply", 15, "Demo Animal Clinic"),
        internet: internet(null, ["Satellite"], [{ name: "Demo Sky", tech: "Satellite", down: 25, up: 3 }]) } },
  ];
  for (const d of demo) {
    parcels.push({ id: newId(), address: null, status: "new", notes: "", createdAt: new Date().toISOString(), errors: [], fetchedAt: new Date().toISOString(), ...d });
  }
  saveParcels();
  renderAll();
  $("dlg-add").close();
}

async function refreshParcel(id) {
  const p = parcels.find((x) => x.id === id);
  if (!p || lookingId) return;
  const lookups = runLookups(p);
  if ($("dlg-detail").open) openDetail(id);   // redraw now so the buttons and notes show the lookup has started
  await lookups;
}

// Deleting takes two clicks: the first turns the button into "Click again to delete", the second deletes
// (a page like this can't rely on confirm dialogs). The question goes away by itself after a few seconds.
let armedDeleteId = null;
let armedTimer = null;
function deleteButton(id) {
  const armed = armedDeleteId === id;
  return `<button class="btn small danger${armed ? " armed" : ""}" type="button" data-delete="${esc(id)}">${armed ? "Click again to delete" : "Delete"}</button>`;
}
function deleteParcel(id) {
  clearTimeout(armedTimer);
  if (armedDeleteId !== id) {
    armedDeleteId = id;
    armedTimer = setTimeout(() => { armedDeleteId = null; renderAll(); liveRender(); }, 4000);
    renderAll();    // redraw the list and the open report so their Delete buttons show the question
    liveRender();
    return;
  }
  armedDeleteId = null;
  parcels = parcels.filter((x) => x.id !== id);
  saveParcels();
  $("dlg-detail").close();
  renderAll();
}

function saveNotes(id) {
  const p = parcels.find((x) => x.id === id);
  if (!p) return;
  p.status = $("d-status").value;
  p.notes = $("d-notes").value;
  saveParcels();
  $("dlg-detail").close();
  renderAll();
}

function exportData() {
  const payload = { app: "homestead-screener", version: 1, exportedAt: new Date().toISOString(), settings, parcels };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `homestead-screener-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    const incoming = Array.isArray(data) ? data : data.parcels;
    if (!Array.isArray(incoming)) throw new Error("No parcels found in that file.");
    let added = 0;
    for (const p of incoming) {
      if (!p || typeof p.name !== "string" || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue; // skip bad entries
      parcels.push({ status: "new", notes: "", site: {}, errors: [], ...p, id: newId() });
      added += 1;
    }
    saveParcels();
    renderAll();
    alertNotice(`Imported ${added} parcel${added === 1 ? "" : "s"}.`);
  } catch (error) {
    alertNotice("Could not import that file: " + error.message, true);
  }
}

function alertNotice(message, bad = false) {
  const box = $("status");
  box.hidden = false;
  box.innerHTML = `<span class="notice${bad ? " bad" : ""}">${esc(message)}</span>`;
  clearProgress(8000);
}

/* ---- criteria dialog ---- */
const CRITERIA_FIELDS = [
  ["Weight: flood", "weights.flood"], ["Weight: septic", "weights.septic"], ["Weight: slope", "weights.slope"],
  ["Weight: rainfall", "weights.rain"], ["Weight: airport", "weights.airport"], ["Weight: price", "weights.price"],
  ["Weight: hunting", "weights.hunting"], ["Weight: internet", "weights.internet"],
  ["Price: full marks at or below ($)", "priceTarget"], ["Price: zero at or above ($)", "priceMax"],
  ["Slope: full marks at or below (%)", "slopeIdeal"], ["Slope: zero at or above (%)", "slopeMax"],
  ["Rain: full marks at (in/year)", "rainFull"], ["Rain: zero at (in/year)", "rainZero"],
  ["Airport: full marks within (min)", "airportFullMin"], ["Airport: dealbreaker beyond (min)", "airportMaxMin"],
  ["Road detour factor", "detourFactor"], ["Average speed (mph)", "avgMph"],
  ["Internet: full marks at (Mbps)", "internetFullMbps"], ["Internet: zero at (Mbps)", "internetZeroMbps"],
  ["Cost: down payment (%)", "costs.downPct"], ["Cost: loan interest rate (%)", "costs.ratePct"],
  ["Cost: loan length (years, 0 = cash)", "costs.years"], ["Cost: property tax (% of price per year)", "costs.taxPct"],
  ["Cost: insurance ($ per month)", "costs.insuranceMonthly"], ["Cost: standard septic ($)", "costs.septicStandard"],
  ["Cost: engineered septic ($)", "costs.septicEngineered"], ["Cost: water well ($)", "costs.well"],
];

const getPath = (obj, path) => path.split(".").reduce((o, k) => o[k], obj);
function setPath(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = value;
}

function openCriteria() {
  $("criteria-fields").innerHTML = `<p class="hint wide">These are starting points, not rules. Rainfall, price and slope that count as good vary a lot across the US (for example, 15 inches of rain a year is dry in Georgia but normal in Nevada), so set them for the region you are searching.</p>`
    + CRITERIA_FIELDS.map(([label, path]) =>
    `<label>${esc(label)}<input data-path="${path}" inputmode="decimal" value="${esc(getPath(settings, path))}"></label>`).join("")
    + `<label class="wide">Counties where you can hunt (comma-separated; add the state, like "Blanco TX", because many states share county names; leave empty to skip this factor)
       <input id="c-hunting" value="${esc(settings.huntingCounties.join(", "))}" placeholder="Example: Blanco TX, Gillespie TX"></label>
     <label class="wide">Census API key (optional and free; lets the app look up your county's typical property tax rate)
       <input id="c-census-key" value="${esc(settings.censusKey)}" autocomplete="off" placeholder="Paste a key from api.census.gov/data/key_signup.html"></label>
     <label class="check wide"><input type="checkbox" id="c-use-county-tax" ${settings.costs.useCountyTax !== false ? "checked" : ""}> Use the county's typical tax rate when it is known (otherwise use the rate above)</label>
     <label class="wide">Which airports count?
       <select id="c-airport-mode">
         <option value="auto">The nearest major US airport (default)</option>
         <option value="custom">Only the airports I list</option>
       </select></label>
     <div class="wide stack" id="c-custom-airports" ${settings.airportMode === "custom" ? "" : "hidden"}>
       <label>Your airports (one per line: name, latitude, longitude). The nearest one is used.
         <textarea id="c-airports" rows="4">${esc(formatAirports(settings.airports))}</textarea></label>
       <label>Add a preset airport
         <select id="c-airport-preset"><option value="">Choose one to add it to the list...</option>${
           AIRPORT_PRESETS.map((a, i) => `<option value="${i}">${esc(a.name)}</option>`).join("")}</select></label>
     </div>`;
  $("c-airport-mode").value = settings.airportMode;
  $("criteria-error").hidden = true;
  $("dlg-criteria").showModal();
}

// Distance to the nearest airport is simple math, so redo it for every saved parcel
// when the airport list changes. No web lookups are needed.
function recomputeAirports() {
  for (const p of parcels) {
    if (!p.site) continue;
    const before = p.site.nearestAirport;
    Object.assign(p.site, nearestAirport(p.lat, p.lon, activeAirports(settings)));
    if (p.site.nearestAirport !== before) {   // a routed time belongs to the old airport, so drop it
      delete p.site.airportDriveMin;
      delete p.site.airportRoadMiles;
    }
  }
  saveParcels();
}

function saveCriteria(event) {
  event.preventDefault();
  const next = JSON.parse(JSON.stringify(settings));
  for (const input of $("criteria-fields").querySelectorAll("input[data-path]")) {
    const value = parseNumber(input.value);
    if (value == null || Number.isNaN(value) || value < 0) {
      $("criteria-error").textContent = "Every criteria field needs a number of zero or more.";
      $("criteria-error").hidden = false;
      return;
    }
    setPath(next, input.dataset.path, value);
  }
  if (next.priceMax === next.priceTarget || next.slopeMax === next.slopeIdeal || next.rainFull === next.rainZero
      || next.airportMaxMin === next.airportFullMin || next.internetFullMbps === next.internetZeroMbps) {
    $("criteria-error").textContent = "The two ends of each range must be different numbers.";
    $("criteria-error").hidden = false;
    return;
  }
  next.huntingCounties = $("c-hunting").value.split(",").map((c) => c.trim().replace(/\s+county\b/i, "")).filter(Boolean);
  next.censusKey = $("c-census-key").value.trim();
  next.costs.useCountyTax = $("c-use-county-tax").checked;
  next.airportMode = $("c-airport-mode").value;
  const airportResult = parseAirports($("c-airports").value);
  if (next.airportMode === "custom" && airportResult.error) {
    $("criteria-error").textContent = airportResult.error;
    $("criteria-error").hidden = false;
    return;
  }
  next.airports = airportResult.airports || [];   // keep a typed list even while the national list is in use
  settings = next;
  writeStored(SETTINGS_KEY, settings);
  recomputeAirports();
  $("dlg-criteria").close();
  renderAll();
}

/* =====================================================================
   10. Wiring
   ===================================================================== */
// Ticking a "Pick" box. The change event fires after the box has already changed.
document.addEventListener("change", (event) => {
  const box = event.target.closest("[data-compare]");
  if (!box) return;
  const id = box.dataset.compare;
  if (box.checked && !compareIds.includes(id)) {
    if (compareIds.length >= MAX_COMPARE) {
      box.checked = false;
      $("compare-hint").textContent = `You can compare up to ${MAX_COMPARE} parcels at once. Untick one first.`;
      return;
    }
    compareIds.push(id);
  } else if (!box.checked) {
    compareIds = compareIds.filter((x) => x !== id);
  }
  $("compare-hint").textContent = 'Tick two or three parcels in the "Pick" column to compare them side by side.';
  updateCompareButton();
});
$("btn-compare").addEventListener("click", showComparison);

// Copies the plain-text summary. If the browser refuses, show it so it can be copied by hand.
async function copySummary(id) {
  const p = parcels.find((x) => x.id === id);
  if (!p) return;
  const text = summaryText(p, settings);
  const message = $("summary-msg");
  message.hidden = false;
  try {
    await navigator.clipboard.writeText(text);
    message.textContent = "Summary copied. Paste it into a message or email.";
  } catch {
    message.textContent = "Your browser did not allow copying. Select the text below and copy it yourself.";
    $("summary-text").value = text;
    $("summary-text").hidden = false;
    $("summary-text").select();
  }
}

$("dlg-detail").addEventListener("close", () => { detailId = null; });

document.addEventListener("click", (event) => {
  if (event.target.closest("[data-compare]")) return;   // a Pick box must not also open the parcel
  const el = event.target.closest("[data-open],[data-close],[data-refresh],[data-delete],[data-save-notes],[data-print],[data-copy-summary]");
  if (!el) return;
  if (el.dataset.print !== undefined) window.print();
  else if (el.dataset.copySummary) copySummary(el.dataset.copySummary);
  else if (el.dataset.close !== undefined) el.closest("dialog").close();
  else if (el.dataset.open) openDetail(el.dataset.open);
  else if (el.dataset.refresh) refreshParcel(el.dataset.refresh);
  else if (el.dataset.delete) deleteParcel(el.dataset.delete);
  else if (el.dataset.saveNotes) saveNotes(el.dataset.saveNotes);
});

/* =====================================================================
   Address suggestions: a list under the Address box that fills in as you type
   ===================================================================== */
let suggestions = [];          // what the list is showing right now
let suggestActive = -1;        // which row the arrow keys are on
let suggestTimer = null;       // waits for a pause in typing before asking the service
let suggestRequest = null;     // the lookup in flight, so a newer one can cancel it
let nameFromAddress = true;         // true until the person types their own name; then the address stops overwriting it
let coordsFromSuggestion = false;   // true while the latitude and longitude boxes hold values a suggestion put there

// Keeps the Name box in step with the address until the person types a name of their own.
function syncNameToAddress() {
  if (nameFromAddress) $("f-name").value = $("f-address").value.trim().slice(0, 80);
}

function closeSuggestions() {
  clearTimeout(suggestTimer);
  if (suggestRequest) suggestRequest.abort();
  suggestions = []; suggestActive = -1;
  $("address-list").hidden = true;
  $("address-list").innerHTML = "";
  $("f-address").setAttribute("aria-expanded", "false");
  $("f-address").removeAttribute("aria-activedescendant");
}

function showSuggestions(note) {
  const list = $("address-list");
  if (note) {
    list.innerHTML = `<li class="note" role="option" aria-disabled="true">${esc(note)}</li>`;
  } else {
    list.innerHTML = suggestions.map((s, i) =>
      `<li role="option" id="address-opt-${i}" data-index="${i}" aria-selected="${i === suggestActive}">${esc(s.label)}</li>`).join("");
  }
  list.hidden = false;
  $("f-address").setAttribute("aria-expanded", "true");
  if (suggestActive >= 0) $("f-address").setAttribute("aria-activedescendant", `address-opt-${suggestActive}`);
  else $("f-address").removeAttribute("aria-activedescendant");
}

function pickSuggestion(index) {
  const s = suggestions[index];
  if (!s) return;
  closeSuggestions();
  $("f-address").value = s.label;
  syncNameToAddress();
  // Fill the coordinates only if the person has not typed their own.
  const latBox = $("f-lat"), lonBox = $("f-lon");
  if ((!latBox.value && !lonBox.value) || coordsFromSuggestion) {
    latBox.value = s.lat.toFixed(5);
    lonBox.value = s.lon.toFixed(5);
    coordsFromSuggestion = true;
  }
}

$("f-address").addEventListener("input", () => {
  syncNameToAddress();
  // Changing the address after picking a suggestion makes its coordinates stale, so clear them.
  if (coordsFromSuggestion) { $("f-lat").value = ""; $("f-lon").value = ""; coordsFromSuggestion = false; }
  clearTimeout(suggestTimer);
  const text = $("f-address").value.trim();
  if (text.length < 4) { closeSuggestions(); return; }
  suggestTimer = setTimeout(async () => {
    if (suggestRequest) suggestRequest.abort();
    const request = new AbortController();
    suggestRequest = request;
    const timeout = setTimeout(() => request.abort(), 8000);
    try {
      const found = await suggestAddresses(text, request.signal);
      if (suggestRequest !== request) return;   // a newer search replaced this one
      suggestions = found; suggestActive = -1;
      showSuggestions(found.length ? null : "No suggestions. You can still type the full address.");
    } catch {
      if (suggestRequest !== request) return;
      suggestions = [];
      showSuggestions("Suggestions are unavailable right now. You can still type the full address.");
    } finally {
      clearTimeout(timeout);
    }
  }, 350);
});

$("f-address").addEventListener("keydown", (e) => {
  const open = !$("address-list").hidden && suggestions.length > 0;
  if (e.key === "Escape" && !$("address-list").hidden) { e.preventDefault(); e.stopPropagation(); closeSuggestions(); return; }
  if (!open) return;
  if (e.key === "ArrowDown") { e.preventDefault(); suggestActive = (suggestActive + 1) % suggestions.length; showSuggestions(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); suggestActive = (suggestActive - 1 + suggestions.length) % suggestions.length; showSuggestions(); }
  else if (e.key === "Enter" && suggestActive >= 0) { e.preventDefault(); pickSuggestion(suggestActive); }
});

// mousedown (not click) so the pick lands before the box loses focus and the list closes.
$("address-list").addEventListener("mousedown", (e) => {
  const row = e.target.closest("li[data-index]");
  if (row) { e.preventDefault(); pickSuggestion(Number(row.dataset.index)); }
});
$("f-address").addEventListener("blur", () => setTimeout(closeSuggestions, 150));
// Typing in the Name box takes over from the address; clearing it hands the name back to the address.
$("f-name").addEventListener("input", () => { nameFromAddress = $("f-name").value.trim() === ""; syncNameToAddress(); });
for (const id of ["f-lat", "f-lon"]) $(id).addEventListener("input", () => { coordsFromSuggestion = false; });
$("dlg-add").addEventListener("close", closeSuggestions);

$("btn-add").addEventListener("click", () => { $("add-error").hidden = true; $("dlg-add").showModal(); });
$("btn-pick").addEventListener("click", startPick);
$("btn-demo").addEventListener("click", loadDemo);
$("form-add").addEventListener("submit", addParcelFromForm);
$("btn-criteria").addEventListener("click", openCriteria);
$("form-criteria").addEventListener("submit", saveCriteria);
// Choosing a preset airport adds its line to the text box.
$("criteria-fields").addEventListener("change", (event) => {
  if (event.target.id === "c-airport-mode") {
    $("c-custom-airports").hidden = event.target.value !== "custom";
    return;
  }
  if (event.target.id !== "c-airport-preset" || event.target.value === "") return;
  const airport = AIRPORT_PRESETS[Number(event.target.value)];
  const box = $("c-airports");
  if (!box.value.includes(airport.name)) box.value = (box.value.trim() + "\n" + formatAirports([airport])).trim();
  event.target.value = "";
});

$("btn-reset-criteria").addEventListener("click", () => {
  const keptKey = settings.censusKey;              // resetting the criteria should not throw away your API key
  settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  settings.censusKey = keptKey;
  writeStored(SETTINGS_KEY, settings);
  recomputeAirports();
  $("dlg-criteria").close();
  renderAll();
});
// Clear data erases everything saved in this browser. Like Delete it takes two clicks, and the question goes away by itself.
let clearTimer = null;
function resetClearButton() {
  clearTimeout(clearTimer);
  const button = $("btn-clear");
  button.textContent = "Clear data";
  button.classList.remove("armed");
}
$("btn-clear").addEventListener("click", () => {
  const button = $("btn-clear");
  if (!button.classList.contains("armed")) {
    clearTimeout(clearTimer);
    button.textContent = "Erase everything? Click again";
    button.classList.add("armed");
    clearTimer = setTimeout(resetClearButton, 5000);
    return;
  }
  resetClearButton();
  clearAllData();
  compareIds = [];
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  $("sort-by").value = view.sort;
  $("filter-status").value = view.status;
  $("hide-dealbreakers").checked = view.hideDealbreakers;
  renderAll();
  $("status").hidden = false;
  $("status").innerHTML = "<strong>Everything this app saved in this browser was erased.</strong> Your criteria are back to the defaults.";
  clearProgress(10000);
});
$("btn-export").addEventListener("click", exportData);
$("btn-import").addEventListener("click", () => $("file-import").click());
$("file-import").addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (file) importData(file);
  event.target.value = "";
});

// The sort and filter controls above the list.
$("sort-by").innerHTML = Object.entries(SORTS).map(([key, sort]) => `<option value="${key}">${esc(sort.label)}</option>`).join("");
$("sort-by").value = view.sort;
$("filter-status").value = view.status;
$("hide-dealbreakers").checked = view.hideDealbreakers;
function viewChanged() {
  view = { sort: $("sort-by").value, status: $("filter-status").value, hideDealbreakers: $("hide-dealbreakers").checked };
  writeStored(VIEW_KEY, view);
  renderAll();
}
for (const id of ["sort-by", "filter-status", "hide-dealbreakers"]) $(id).addEventListener("change", viewChanged);

initMap();
renderAll();
if (!storageOk) $("storage-warning").hidden = false;
