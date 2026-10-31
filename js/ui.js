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
  return tip ? tipSpan(label, tip) : esc(label);
}

// A label with an explanation of your choosing. tabindex lets keyboard and touch users reach it;
// aria-label puts the explanation in front of screen readers.
function tipSpan(label, tip) {
  return `<span class="help" tabindex="0" role="note" data-tip="${esc(tip)}" aria-label="${esc(`${label}. ${tip}`)}">${esc(label)}</span>`;
}

// Attributes that give a button (or any element) a hover explanation without dotting its text.
function tipAttr(tip) {
  return `data-tip="${esc(tip)}" aria-description="${esc(tip)}"`;
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
const TIP_TARGET = ".help, [data-tip]";   // dotted labels, and buttons or other elements that carry data-tip
document.addEventListener("mouseover", (e) => { const t = e.target.closest && e.target.closest(TIP_TARGET); if (t) showHelpTip(t); });
document.addEventListener("mouseout", (e) => { if (e.target.closest && e.target.closest(TIP_TARGET)) hideHelpTip(); });
document.addEventListener("focusin", (e) => { const t = e.target.closest && e.target.closest(TIP_TARGET); if (t) showHelpTip(t); });
document.addEventListener("focusout", hideHelpTip);
// Pressing a button does its job, so its tip goes away. A tap on a dotted label keeps its tip.
document.addEventListener("click", (e) => { if (!(e.target.closest && e.target.closest(".help"))) hideHelpTip(); });
// The first Escape only closes the tip. Without preventDefault it would also close the report window behind it.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById("help-tip")) { e.preventDefault(); hideHelpTip(); }
}, true);
// Scrolling moves the label out from under the tip, so close it.
document.addEventListener("scroll", hideHelpTip, true);

// Gives the fixed parts of the page (buttons, form fields and the like, listed by id in UI_TIPS) their hover explanations.
// A field gets its tip on its label text; a button gets it on itself. Safe to run again: elements already done are skipped.
function applyStaticTips() {
  for (const [id, tip] of Object.entries(UI_TIPS)) {
    const el = document.getElementById(id);
    if (!el || el.dataset.tipDone) continue;
    el.dataset.tipDone = "1";
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
      const label = el.closest("label");
      const textNode = label && [...label.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
      if (textNode) {
        const holder = document.createElement("span");
        holder.innerHTML = tipSpan(textNode.textContent.trim(), tip);
        textNode.replaceWith(holder.firstChild, document.createTextNode(" "));
        continue;
      }
    }
    el.dataset.tip = tip;
    el.setAttribute("aria-description", tip);
  }
}

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

// "Yes (AE)", "No" or "?" for the list.
function floodShort(zone) {
  const answer = floodAnswer(zone);
  if (answer.inZone === null) return "?";
  return answer.inZone ? `Yes (${zone})` : "No";
}

// "Yes", "No" or "?" for the USDA loan area. Shown as words, not just color.
function usdaCell(usda) {
  if (usda === undefined) return `<span class="sub">${lookingId ? "..." : "?"}</span>`;
  if (usda === null) return "?";
  return usda.eligibleArea ? "Yes" : "No";
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
      <td class="num">${money(p.askingPrice)}</td>
      <td><span class="score ${scoreClass(score.total)}">${scoreText(score.total)}</span><div class="sub">${score.factorsScored}/${score.factorsTotal} factors</div></td>
      <td>${usdaCell(site.usda)}</td>
      <td>${esc(floodShort(site.floodZone))}</td>
      <td>${esc(net)}</td>
      <td class="num col-air">${esc(drive)}</td>
      <td class="col-del">${deleteButton(p.id)}</td>
    </tr>`;
  }).join("");
  $("list").innerHTML = `<div class="table-scroll"><table>
    <thead><tr><th class="col-pick">${tipSpan("Pick", "Tick two or three parcels, then press Compare to see them side by side.")}</th><th class="num col-n">${tipSpan("#", "Rank in the list, by the sort you chose.")}</th><th>${tipSpan("Parcel", "Your name for the parcel, with its county and size. Click a row to open its full report.")}</th><th class="num">${tipSpan("Price", "The asking price you entered.")}</th><th>${tipSpan("Score", "0 to 100, an average of the scored factors weighted by your points. A factor with no data for the parcel is skipped. Open the report to see each factor.")}</th><th>${tipSpan("USDA", "Is the spot in an area where USDA Rural Development guaranteed home loans are available? Yes means it is outside USDA's mapped ineligible areas.")}</th><th>${tipSpan("Flood zone", "Is the spot in a high-risk FEMA flood zone (zones starting with A or V)? Yes means high risk.")}</th><th>${tipSpan("Internet", "Fastest wired or fixed wireless download speed the providers report for the spot, with satellite left out.")}</th><th class="num col-air">${tipSpan("To airport", "Drive time to the nearest airport on the app's list.")}</th><th class="col-del" aria-label="Delete"></th></tr></thead>
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

/* ---- collapsible report categories ---- */
let closedGroups = new Set(readStored(GROUPS_KEY, []));   // categories you collapsed; remembered between visits
let printing = false;                                      // while printing, every category is opened

document.addEventListener("toggle", (event) => {
  const box = event.target;
  if (printing || !(box instanceof HTMLElement) || !box.matches("details.rgroup")) return;
  if (box.open) closedGroups.delete(box.dataset.group); else closedGroups.add(box.dataset.group);
  writeStored(GROUPS_KEY, [...closedGroups]);
}, true);   // "toggle" does not bubble, so listen on the way down

document.addEventListener("click", (event) => {
  const button = event.target.closest && event.target.closest("[data-groups]");
  if (!button) return;
  for (const box of document.querySelectorAll("#detail details.rgroup")) {
    box.open = button.dataset.groups === "open";
    if (box.open) closedGroups.delete(box.dataset.group); else closedGroups.add(box.dataset.group);
  }
  writeStored(GROUPS_KEY, [...closedGroups]);   // saved here as well, so it does not depend on when the browser reports the change
});

// A collapsed category would print as just a heading, so open them all for the printout and put them back afterwards.
window.addEventListener("beforeprint", () => {
  printing = true;
  for (const box of document.querySelectorAll("details.rgroup")) { box.dataset.wasOpen = box.open ? "1" : ""; box.open = true; }
});
window.addEventListener("afterprint", () => {
  for (const box of document.querySelectorAll("details.rgroup")) { box.open = box.dataset.wasOpen === "1"; delete box.dataset.wasOpen; }
  setTimeout(() => { printing = false; }, 0);
});

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
    <p class="hint">From the USGS Protected Areas Database. The list shows areas within the distance above, not in order of distance, and leaves out areas whose public access is unknown. "Open" access means people can visit, not that every use (such as camping) is allowed: check the managing agency. Land next to a parcel can be nice, but a neighboring public area can also bring crowds or fire risk.</p>`;
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
  const ageText = (w) => (w.yearsAgo >= 2 ? ` <span class="sub">(${w.yearsAgo} years ago)</span>` : "");
  const allOld = gw.wells.length > 0 && gw.wells.every((w) => w.yearsAgo > 10);
  const body = gw.wells.length
    ? `<div class="table-scroll"><table><thead><tr><th>Monitoring well</th><th class="num">Distance</th><th class="num">Depth to water</th><th>Last measured</th></tr></thead><tbody>${gw.wells.map((w) =>
      `<tr><td>${esc(w.name)}${w.siteNo ? ` <span class="sub">USGS ${esc(w.siteNo)}</span>` : ""}</td><td class="num">${w.distanceMiles} mi</td><td class="num">${w.depthFt} ft</td><td>${esc(w.measured)}${ageText(w)}</td></tr>`).join("")}</tbody></table></div>
      ${allOld ? `<p class="notice">These wells were last measured more than 10 years ago, so the depths may have changed. Many USGS wells in rural areas are no longer measured.</p>` : ""}`
    : `<p>No USGS monitoring well with a depth-to-water reading within about ${gw.searchedMiles} miles.</p>`;
  return `${body}
    <p class="hint">Depth is feet below ground to the water level in a monitoring well, which is not your lot. Water depth, rock type and well yield can differ a lot over a mile, and a deep or shallow reading nearby does not tell you what a new well will find. A monitoring well may tap a different layer (aquifer) than a household well would. In Texas, the Texas Water Development Board's Water Data for Texas site has driller reports for existing wells near you, and your groundwater conservation district sets the drilling rules. Ask a local well driller what depth and yield to expect.</p>`;
}

// "More local conditions": the county profile, drought, weather office and alerts, wind, design rainfall and nearby regulated facilities.
function moreHtml(more) {
  if (more === undefined) return `<p class="hint">${notYetText()}</p>`;
  const failed = more.failed || [];
  const unavailable = `<span class="sub">could not load; use Refresh data to try again</span>`;
  const noData = `<span class="sub">no data for this spot</span>`;
  const row = (label, key, make) => kv(label, failed.includes(key) ? unavailable : (more[key] ? make(more[key]) : noData));
  const prof = more.countyProfile;
  const needsKey = prof && prof.needsKey;
  const profRow = (label, make) => (failed.includes("countyProfile") ? kv(label, unavailable) : needsKey ? kv(label, `<span class="sub">needs a free Census key in Settings</span>`)
    : prof ? kv(label, make(prof)) : kv(label, noData));
  const num = (n) => (n == null ? "?" : Number(n).toLocaleString("en-US"));
  const droughtText = (d) => (d.level
    ? `${esc(d.level)}: ${esc(d.name)} <span class="sub">map of ${esc(d.date || "?")}</span>`
    : `no drought here <span class="sub">current map</span>`);
  return `<div class="kv">
      ${profRow("County population", (c) => num(c.population))}
      ${profRow("County median household income", (c) => (c.medianIncome == null ? "?" : money(c.medianIncome)))}
      ${profRow("County median age", (c) => (c.medianAge == null ? "?" : esc(c.medianAge)))}
      ${profRow("County median home value", (c) => (c.medianHomeValue == null ? "?" : money(c.medianHomeValue)))}
      ${profRow("Households with broadband (county)", (c) => (c.broadbandPct == null ? "?" : `${c.broadbandPct}%`))}
      ${row("Drought now", "drought", droughtText)}
      ${row("Weather service office", "weather", (w) => `${esc(w.office || "?")}${w.nearTown ? ` <span class="sub">near ${esc(w.nearTown)}</span>` : ""}`)}
      ${row("Weather alerts now", "weather", (w) => (w.alerts.length ? esc(w.alerts.join(", ")) : "none in effect"))}
      ${row("Average wind speed", "wind", (w) => (w.windMph == null ? "?" : `${w.windMph} mph`))}
      ${row("Average humidity", "wind", (w) => (w.humidityPct == null ? "?" : `${w.humidityPct}%`))}
      ${row("Regulated facilities within 2 miles", "facilities", (f) => (f.facilities > 0 ? `${f.facilities}` : "none listed"))}
    </div>
    <p class="hint">County figures describe the whole county, not your spot. Drought and weather alerts are snapshots from when the data was fetched.</p>`;
}

// The Texas-only section. `tx` is what lookupTexas found; `failed` names the pieces whose service did not answer.
function texasHtml(tx, p) {
  if (tx === undefined) return `<p class="hint">${notYetText()}</p>`;
  const failed = tx.failed || [];
  const unavailable = `<span class="sub">could not load; use Refresh data to try again</span>`;
  const row = (label, key, make) => kv(label, failed.includes(key) ? unavailable : make());
  const par = tx.parcel;
  const none = `<span class="sub">none found at this exact point (it may be on a road, or in a county missing from the statewide set)</span>`;
  const acresNote = par && par.appraisalAcres != null && p.acres > 0 && Math.abs(par.appraisalAcres - p.acres) / p.acres > 0.2
    ? ` <span class="sub">(you entered ${esc(p.acres)})</span>` : "";
  const perAcre = par && par.landValuePerAcre != null ? ` <span class="sub">(${money(par.landValuePerAcre)} an acre)</span>` : "";
  const wells = tx.wells;
  const wellsText = !wells ? `none in the database within ${TX_WELL_RADII_MILES[TX_WELL_RADII_MILES.length - 1]} miles`
    : `${wells.count}${wells.more ? "+" : ""} within ${wells.searchedMiles} mi`
      + (wells.medianDepthFt != null ? `; typical depth ${wells.medianDepthFt} ft <span class="sub">(range ${wells.minDepthFt} to ${wells.maxDepthFt} ft)</span>` : "");
  const pipes = tx.pipelines;
  const pipeText = !pipes || pipes.segments === 0 ? "none mapped"
    : `${pipes.segments}${pipes.more ? "+" : ""} segment${pipes.segments === 1 ? "" : "s"}`
      + (pipes.operators.length ? ` run by ${esc(pipes.operators.join(", "))}` : "")
      + (pipes.commodities.length ? ` <span class="sub">(${esc(pipes.commodities.join(", ").toLowerCase())})</span>` : "");
  const oil = tx.oilGasWells;
  const edwards = tx.edwards;
  const gcd = tx.groundwaterDistrict;
  return `${edwards && edwards.inRechargeZone ? `<p class="notice bad"><strong>Inside the mapped Edwards Aquifer recharge zone.</strong> Septic systems, building and land clearing here fall under extra state water-protection rules and need TCEQ approval. Talk to TCEQ and the county before you buy.</p>` : ""}
    <div class="kv">
      ${row("Appraisal district acres", "parcel", () => (par && par.appraisalAcres != null ? `${esc(par.appraisalAcres)} acres${acresNote}` : par ? "?" : none))}
      ${par ? row("Appraised land value", "parcel", () => (par.landValue != null ? `${money(par.landValue)}${perAcre} <span class="sub">tax year ${esc(par.taxYear || "?")}</span>` : "?")) : ""}
      ${par && par.marketValue != null ? row("Appraised total value", "parcel", () => money(par.marketValue)) : ""}
      ${par && par.landUse ? row("Land use (appraisal district)", "parcel", () => esc(par.landUse)) : ""}
      ${row("Groundwater district", "groundwaterDistrict", () => (gcd && gcd.name ? esc(gcd.name) : "not in a groundwater conservation district"))}
      ${row("School district", "schoolDistrict", () => (tx.schoolDistrict && tx.schoolDistrict.name ? esc(tx.schoolDistrict.name) : "?"))}
      ${row("Water wells nearby", "wells", () => wellsText)}
      ${wells && wells.aquifers.length ? row("Aquifer (nearby wells)", "wells", () => esc(wells.aquifers.join(", "))) : ""}
      ${row("Oil and gas wells within 1 mile", "oilGasWells", () => (oil && oil.count > 0 ? `${oil.count}` : "none mapped"))}
      ${row("Pipelines within half a mile", "pipelines", () => pipeText)}
      ${row("Edwards Aquifer recharge zone", "edwards", () => (edwards && edwards.inRechargeZone ? "Yes" : "No"))}
    </div>
    <p class="hint">These come from Texas state sources and only appear for parcels in Texas. They do not show who owns the minerals, easements, deed restrictions, or your county's septic (OSSF) rules, so check the deed, a title search and the county. Appraisal values are for tax, not sale price, and farm and ranch land is often taxed at a low farming value. The owner's name and mailing address in the appraisal record are deliberately not shown.</p>`;
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
  if (t && t.needsKey) return `<p class="hint">${t.keyRejected ? "The Census did not accept your API key." : "The Census asks for a free API key before it will share county tax rates."} Get one at <a href="${CENSUS_KEY_SIGNUP_URL}" target="_blank" rel="noopener">api.census.gov/data/key_signup.html</a> and paste it into Settings &gt; Costs and loans, then click Refresh data.</p>`;
  if (t === null) return `<p class="hint">The Census has no property tax figure for this county, so your own tax setting is used.</p>`;
  return "";
}

function costHtml(parcel) {
  const est = estimateCosts(parcel, settings);
  if (!est) return `<p class="hint">Add an asking price to see a rough cost estimate.</p>`;
  const c = settings.costs;
  const loanText = c.years > 0 ? `${money(est.monthly.loan)}` : "$0 (cash)";
  const h = est.homeLoans, conv = h.conventional, fha = h.fha;
  const taxAndIns = est.monthly.tax + est.monthly.insurance;
  const land = { down: est.downPayment, borrowed: parcel.askingPrice - est.downPayment, rate: c.years > 0 ? `${c.ratePct}% for ${c.years} years` : "cash" };
  const pct = (x) => `${x}%`;
  const rows = [
    ["Cash down payment", money(land.down), money(conv.downPayment), money(fha.downPayment)],
    ["Amount borrowed", c.years > 0 ? money(land.borrowed) : "$0", money(conv.borrowed), `${money(fha.borrowed)}<div class="sub">includes ${money(fha.upfrontInsurance)} upfront insurance</div>`],
    ["Interest rate", esc(land.rate), `${pct(conv.ratePct)} for 30 years`, `${pct(fha.ratePct)} for 30 years`],
    ["Principal and interest", loanText, money(conv.pi), money(fha.pi)],
    ["Mortgage insurance", "none", `${money(conv.insurance)}<div class="sub">${esc(conv.insuranceNote)}</div>`, `${money(fha.insurance)}<div class="sub">${esc(fha.insuranceNote)}</div>`],
    ["Property tax and home insurance", money(taxAndIns), money(taxAndIns), money(taxAndIns)],
  ];
  const homeNotes = [];
  if (conv.raisedToMinimum) homeNotes.push(`Your down payment is under the ${LOAN_RULES.conventionalMinDownPct}% a conventional loan needs, so ${money(conv.minimumDown)} is used.`);
  if (fha.raisedToMinimum) homeNotes.push(`Your down payment is under the ${LOAN_RULES.fhaMinDownPct}% an FHA loan needs, so ${money(fha.minimumDown)} is used.`);
  if (fha.overLimit) homeNotes.push(`The FHA loan is above the ${money(LOAN_RULES.fhaLoanLimitFloor)} national limit floor. Limits are higher in costly counties, so check the county limit.`);
  return `<div class="kv">
      <div>Loan payment</div><div>${loanText}${c.years > 0 ? ` <span class="sub">(${money(est.downPayment)} down, ${c.ratePct}% for ${c.years} years)</span>` : ""}</div>
      <div>Property tax</div><div>${money(est.monthly.tax)} <span class="sub">(${est.taxPct}% a year, ${est.taxSource === "county" ? `typical for ${esc(parcel.site.taxRate.name)}` : "your setting"})</span></div>
      <div>Insurance</div><div>${money(est.monthly.insurance)}</div>
      <div><strong>About per month</strong></div><div><strong>${money(est.monthly.total)}</strong></div>
      <div>Cash down payment</div><div>${money(est.downPayment)}</div>
      <div>Septic system</div><div>${money(est.oneTime.septic)}</div>
      <div>Water well</div><div>${money(est.oneTime.well)}</div>
      <div><strong>One-time start-up</strong></div><div><strong>${money(est.oneTime.total)}</strong></div>
    </div>
    <p class="hint">${esc(est.notes.join(" "))} These numbers come from the placeholder rates and prices in Settings, not from a quote. Property tax, insurance and building costs vary widely by state and county, and this leaves out the house, the driveway, electricity, and loan fees. Ask a lender, the county tax office and local contractors.</p>${taxKeyHint(parcel)}
    <h4>Monthly payment by loan type</h4>
    <div class="table-scroll"><table class="loan-table">
      <thead><tr><th></th><th class="num">Land loan (your terms)</th><th class="num">Conventional, 30 years</th><th class="num">FHA, 30 years</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${r[0]}</td><td class="num">${r[1]}</td><td class="num">${r[2]}</td><td class="num">${r[3]}</td></tr>`).join("")}
        <tr class="total"><td><strong>About per month</strong></td><td class="num"><strong>${money(est.monthly.total)}</strong></td><td class="num"><strong>${money(conv.total)}</strong></td><td class="num"><strong>${money(fha.total)}</strong></td></tr>
      </tbody></table></div>
    ${homeNotes.length ? `<p class="hint">${esc(homeNotes.join(" "))}</p>` : ""}
    <p class="hint"><strong>Read this first:</strong> banks do not make FHA or conventional loans on bare land. Those two columns show what the same price would cost as a home purchase, or as a construction-to-permanent loan that covers the land and the house. An FHA loan is only for a home you will live in. The land loan column uses your own terms from Settings. Rates, insurance and limits here are placeholders: the conventional rate is the Freddie Mac weekly average for a 30-year loan (7.32% on October 22, 2026) rounded, the FHA rate is a guess, and FHA's insurance is 1.75% at closing (added to the loan) plus ${c.fhaAnnualPct}% a year. A lender will quote real numbers for your credit and county.</p>
    <p class="hint">USDA loan area: <strong>${usdaCell(parcel.site && parcel.site.usda)}</strong>. ${parcel.site && parcel.site.usda ? (parcel.site.usda.eligibleArea ? "This spot is outside USDA's mapped ineligible areas, so a USDA guaranteed home loan may be possible here. " : "This spot is inside a USDA ineligible area. ") : ""}USDA loans also have household income limits and are for buying a home, not bare land. Check the exact address on <a href="https://eligibility.sc.egov.usda.gov/eligibility/" target="_blank" rel="noopener">USDA's eligibility site</a> and ask a USDA-approved lender.</p>`;
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
      <td class="num">${settings.points[name]}</td></tr>`).join("");
  let drive = "?";
  if (site.airportMiles != null) {
    drive = site.airportDriveMin != null
      ? `${site.nearestAirport}, ${site.airportRoadMiles} mi by road (about ${site.airportDriveMin} min drive, from a road route)`
      : `${site.nearestAirport}, ${site.airportMiles} mi straight line (about ${Math.round(driveMinutes(site.airportMiles, settings))} min drive, estimated)`;
  }
  // Each report section as its own piece, so the order can follow your settings.
  const sections = {
    data: `
      <h3>What the data says</h3>
      <div class="kv">
        ${kv("Coordinates", `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`)}
        ${kv("In a flood zone?", esc(floodAnswer(site.floodZone).text))}
        ${kv("Elevation", site.elevationFt != null ? `${site.elevationFt} ft` : "?")}
        ${kv("Slope (steepest of 4 directions)", site.slopePct != null ? `${site.slopePct}%` : "?")}
        ${kv("Soil", esc(site.soilName || "?"))}
        ${kv("Drainage class", esc(site.drainageClass || "?"))}
        ${kv("Septic rating", esc(site.septicRating || "?"))}
        ${kv("Average yearly rain", site.annualRainIn != null ? `${site.annualRainIn} in` : "?")}
        ${kv("Nearest airport", esc(drive))}
        ${kv("USDA loan area", usdaCell(site.usda))}
        ${kv("Plant hardiness zone", site.hardiness ? `${esc(hardinessText(site.hardiness))} <span class="sub">by ZIP ${esc(site.hardiness.zip)}, USDA ${esc(site.hardiness.vintage)} map</span>` : (site.hardiness === undefined ? "not looked up yet" : "?"))}
        ${kv("Data fetched", p.fetchedAt ? esc(new Date(p.fetchedAt).toLocaleString()) : "never")}
      </div>
      <p class="source">Sources for this table: ${["county", "flood", "elevation", "soil", "rain", "airport", "hardiness", "usda"].filter((k) => sourceKeysUsed(p).includes(k)).map((k) => `${esc(DATA_SOURCES[k].label)}: ${DATA_SOURCES[k].url ? `<a href="${esc(DATA_SOURCES[k].url)}" target="_blank" rel="noopener">${esc(DATA_SOURCES[k].name)}</a>` : esc(DATA_SOURCES[k].name)}, ${esc(sourceVintage(k, site))}`).join("; ")}.</p>`,
    internet: `
      <h3>Internet</h3>
      ${internetHtml(site.internet)}
      ${sourceHtml("internet", site)}`,
    places: `
      <h3>Nearby</h3>
      ${placesHtml(site.places)}
      ${sourceHtml("places", site)}`,
    publicLand: `
      <h3>Public and protected land</h3>
      ${publicLandHtml(site.publicLand)}
      ${sourceHtml("publicLand", site)}`,
    groundwater: `
      <h3>Groundwater</h3>
      ${groundwaterHtml(site.groundwater)}
      ${sourceHtml("groundwater", site)}`,
    wetlands: `
      <h3>Wetlands</h3>
      ${wetlandsHtml(site.wetlands)}
      ${sourceHtml("wetlands", site)}`,
    roads: `
      <h3>Road access</h3>
      ${roadsHtml(site.roads)}
      ${sourceHtml("roads", site)}`,
    climate: `
      <h3>Climate and solar</h3>
      ${climateHtml(site.climate, site.solar)}
      ${sourceHtml("climate", site)}`,
    soilDetails: `
      <h3>Soil details</h3>
      ${soilDetailsHtml(site.soilDetails)}
      ${sourceHtml("soilDetails", site)}`,
    hazards: `
      <h3>Natural hazards</h3>
      ${hazardsHtml(site.hazards)}
      ${sourceHtml("hazards", site)}`,
    more: `
      <h3>More local conditions</h3>
      ${moreHtml(site.more)}
      ${(() => { const keys = sourceKeysUsed(p).filter((k) => ["censusProfile", "drought", "nws", "power", "echo"].includes(k)); return keys.length ? sourceHtml(keys, site) : ""; })()}`,
    texas: isTexasParcel(p) ? `
      <h3>Texas details</h3>
      ${texasHtml(site.texas, p)}
      ${(() => { const keys = sourceKeysUsed(p).filter((k) => k.startsWith("tx")); return keys.length ? sourceHtml(keys, site) : ""; })()}` : "",
    cost: `
      <h3>Rough cost</h3>
      ${costHtml(p)}
      ${sourceHtml("costs", site)}${p.site && p.site.taxRate && p.site.taxRate.ratePct != null ? sourceHtml("taxRate", site) : ""}`,
  };
  // The sections sit inside collapsible categories. A category with nothing to show (such as Texas for a parcel elsewhere) is left out.
  const orderedSections = groupSections(normalizeReportOrder(settings.reportOrder)).map((group) => {
    const bodies = group.sections.map((key) => sections[key]).filter(Boolean);
    if (!bodies.length) return "";
    return `<details class="rgroup" data-group="${esc(group.key)}"${closedGroups.has(group.key) ? "" : " open"}>
      <summary>${tipSpan(group.label, GROUP_TIPS[group.key] || group.label)}</summary>
      <div class="rgroup-body">${bodies.join("")}</div></details>`;
  }).join("");
  $("detail").innerHTML = `
    <div class="dlg-bar no-print">
      <div class="bar-group">
        <button class="btn small" type="button" data-refresh="${esc(p.id)}" ${tipAttr("Look up all the public data for this spot again, since sources change.")}${busy ? " disabled" : ""}>${busy ? "Looking up..." : "Refresh data"}</button>
        <button class="btn small" type="button" data-print ${tipAttr("Print this report, or save it as a PDF from the print window.")}>Print</button>
        <button class="btn small" type="button" data-copy-summary="${esc(p.id)}" ${tipAttr("Copy a short plain-text summary of this parcel that you can paste into an email or message.")}>Copy summary</button>
        <button class="btn small" type="button" data-edit="${esc(p.id)}" ${tipAttr("Change this parcel's name, address, acres, price or location.")}${busy ? " disabled" : ""}>Edit</button>
      </div>
      <div class="bar-group">
        <button class="btn small primary" type="button" data-save-notes="${esc(p.id)}" ${tipAttr("Save the status and notes below.")}>Save notes</button>
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
      ${busy ? `<p class="notice no-print" role="status">Looking up data: ${lookupDone} of ${SOURCE_STEPS.length + 3 + (isTexasParcel(p) ? 1 : 0)} lookups finished. The report fills in as each one arrives.</p>` : ""}
      ${score.dealbreakers.length ? `<p class="notice bad"><strong>Dealbreakers:</strong> ${esc(score.dealbreakers.join("; "))}</p>` : ""}
      <div class="score-line"><span class="big">${scoreText(score.total)}</span><span class="sub">score &middot; ${score.factorsScored} of ${score.factorsTotal} factors had data</span></div>
      <div class="table-scroll"><table><thead><tr><th>${helpLabel("Factor")}</th><th class="num">${tipSpan("Score", "This factor's score from 0 (worst) to 100 (best). \"no data\" means the lookup found nothing, so the factor is skipped, not scored as zero.")}</th><th></th><th class="num">${helpLabel("Points")}</th></tr></thead><tbody>${factorRows}</tbody></table></div>
      ${!busy && p.errors && p.errors.length ? `<p class="notice">Some lookups failed, so the score is partial: ${esc(p.errors.join("; "))}. Use Refresh data to try again.</p>` : ""}
      <div class="group-tools no-print"><button class="btn small" type="button" data-groups="open" ${tipAttr("Open every category in this report.")}>Expand all</button><button class="btn small" type="button" data-groups="close" ${tipAttr("Close every category so only the headings show.")}>Collapse all</button></div>
      ${orderedSections}
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
  applyStaticTips();
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

    if (editingId) {
      const existing = parcels.find((x) => x.id === editingId);
      if (!existing) { editingId = null; $("dlg-add").close(); return; }
      // Moving the pin makes every looked-up value wrong, so the data is cleared and fetched again.
      const moved = Math.abs(existing.lat - lat) > 1e-6 || Math.abs(existing.lon - lon) > 1e-6;
      existing.name = name; existing.address = address || null; existing.acres = acres; existing.askingPrice = price;
      if (moved) { existing.lat = lat; existing.lon = lon; existing.county = null; existing.site = {}; existing.errors = []; existing.fetchedAt = null; }
      saveParcels();
      renderAll();
      const id = editingId;
      editingId = null;
      setAddFormMode(false);
      $("form-add").reset();
      closeSuggestions();
      nameFromAddress = true;
      coordsFromSuggestion = false;
      $("dlg-add").close();
      if (moved) {
        const lookups = runLookups(existing);
        openDetail(id);
        await lookups;
      } else {
        openDetail(id);
      }
      return;
    }
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
    button.textContent = editingId ? "Save changes" : "Add and look up data";
  }
}

/* ---- editing a parcel: the Add window, filled in with the parcel's values ---- */
let editingId = null;   // the parcel being edited, or null when the window is adding a new one

// Switches the Add window between "add" and "edit" wording.
function setAddFormMode(editing) {
  $("add-title").textContent = editing ? "Edit parcel" : "Add a parcel";
  $("btn-save").textContent = editing ? "Save changes" : "Add and look up data";
  $("btn-demo").hidden = editing;
  $("edit-hint").hidden = !editing;
}

function openEdit(id) {
  const p = parcels.find((x) => x.id === id);
  if (!p || lookingId === id) return;
  closeSuggestions();
  editingId = id;
  setAddFormMode(true);
  $("f-name").value = p.name;
  $("f-address").value = p.address || "";
  $("f-lat").value = String(p.lat);
  $("f-lon").value = String(p.lon);
  $("f-acres").value = p.acres ?? "";
  $("f-price").value = p.askingPrice ?? "";
  nameFromAddress = !p.name || p.name === p.address;
  coordsFromSuggestion = false;
  $("add-error").hidden = true;
  $("dlg-detail").close();   // the map pick needs the page visible, so the report steps aside while editing
  $("dlg-add").showModal();
}

// Opening the window to add a parcel after editing one starts from an empty form.
function openAdd() {
  if (editingId) {
    editingId = null;
    $("form-add").reset();
    nameFromAddress = true;
    coordsFromSuggestion = false;
  }
  setAddFormMode(false);
  $("add-error").hidden = true;
  $("dlg-add").showModal();
}

// Closing the edit window without saving goes back to the report. (Choosing a spot on the map also
// closes it for a moment; pickMode tells the two apart.)
$("dlg-add").addEventListener("close", () => {
  if (editingId && !pickMode) {
    const id = editingId;
    editingId = null;
    setAddFormMode(false);
    $("form-add").reset();   // do not leave this parcel's values behind for the next "Add"
    nameFromAddress = true;
    coordsFromSuggestion = false;
    openDetail(id);
  }
});

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
  return `<button class="btn small danger${armed ? " armed" : ""}" type="button" data-delete="${esc(id)}" ${tipAttr("Delete this parcel. The first click arms the button and the second one deletes it.")}>${armed ? "Click again to delete" : "Delete"}</button>`;
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
// Number boxes for the Scoring tab: where each factor's range starts and ends.
const SCORING_FIELDS = [
  ["Price: full marks at or below ($)", "priceTarget"], ["Price: zero at or above ($)", "priceMax"],
  ["Slope: full marks at or below (%)", "slopeIdeal"], ["Slope: zero at or above (%)", "slopeMax"],
  ["Rain: full marks at (in/year)", "rainFull"], ["Rain: zero at (in/year)", "rainZero"],
  ["Airport: full marks within (min)", "airportFullMin"], ["Airport: dealbreaker beyond (min)", "airportMaxMin"],
  ["Road detour factor", "detourFactor"], ["Average speed (mph)", "avgMph"],
  ["Internet: full marks at (Mbps)", "internetFullMbps"], ["Internet: zero at (Mbps)", "internetZeroMbps"],
];

// Number boxes for the Costs and loans tab.
const COST_FIELDS = [
  ["Cost: down payment ($)", "costs.downPayment"], ["Cost: land loan interest rate (%)", "costs.ratePct"],
  ["Cost: loan length (years, 0 = cash)", "costs.years"], ["Cost: property tax (% of price per year)", "costs.taxPct"],
  ["Cost: insurance ($ per month)", "costs.insuranceMonthly"], ["Cost: standard septic ($)", "costs.septicStandard"],
  ["Cost: engineered septic ($)", "costs.septicEngineered"], ["Cost: water well ($)", "costs.well"],
  ["Home loan: conventional 30-year rate (%)", "costs.conventionalRatePct"], ["Home loan: FHA 30-year rate (%)", "costs.fhaRatePct"],
  ["Home loan: private mortgage insurance (% a year)", "costs.pmiPct"],
  ["Home loan: FHA upfront insurance (%)", "costs.fhaUpfrontPct"], ["Home loan: FHA yearly insurance (%)", "costs.fhaAnnualPct"],
];

const getPath = (obj, path) => path.split(".").reduce((o, k) => o[k], obj);
function setPath(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = value;
}

let orderDraft = [];   // the report order being edited in the settings window; saved with the Save button

function renderOrderList(focus) {
  const label = Object.fromEntries(REPORT_SECTIONS);
  $("c-order-list").innerHTML = orderDraft.map((key, i) => `<li data-key="${key}">
      <span class="order-grip" title="Drag to reorder" aria-hidden="true">&#8942;&#8942;</span>
      <span class="order-name">${SECTION_TIPS[key] ? tipSpan(label[key], SECTION_TIPS[key]) : esc(label[key])}</span>
      <span class="order-group sub">${esc(groupLabelOf(key))}</span>
      <button class="btn small" type="button" data-move="up" data-key="${key}" aria-label="Move ${esc(label[key])} up"${i === 0 ? " disabled" : ""}>Up</button>
      <button class="btn small" type="button" data-move="down" data-key="${key}" aria-label="Move ${esc(label[key])} down"${i === orderDraft.length - 1 ? " disabled" : ""}>Down</button>
    </li>`).join("");
  // Keep the keyboard focus on the button that was just used, or on its partner if it is now disabled.
  if (focus) {
    const wanted = $("c-order-list").querySelector(`button[data-key="${focus.key}"][data-move="${focus.dir}"]:not(:disabled)`)
      || $("c-order-list").querySelector(`button[data-key="${focus.key}"]:not(:disabled)`);
    if (wanted) wanted.focus();
  }
}

/* ---- dragging a row to a new place (the Up and Down buttons still work, and are the keyboard way) ---- */
let orderDrag = null;   // { row, pointerId } while a row is being dragged

function finishOrderDrag() {
  if (!orderDrag) return;
  const list = $("c-order-list");
  orderDrag.row.classList.remove("dragging");
  orderDrag = null;
  orderDraft = [...list.children].map((row) => row.dataset.key);   // the rows were moved on screen; read the new order from them
  renderOrderList();
}

// The list is built each time Settings opens, so the listener sits on the window that always exists.
$("criteria-fields").addEventListener("pointerdown", (event) => {
  const grip = event.target.closest(".order-grip");
  if (!grip || event.button > 0) return;
  event.preventDefault();
  grip.setPointerCapture(event.pointerId);   // keeps the moves coming even when the pointer leaves the handle
  orderDrag = { row: grip.closest("li"), pointerId: event.pointerId };
  orderDrag.row.classList.add("dragging");
});

$("criteria-fields").addEventListener("pointermove", (event) => {
  if (!orderDrag || event.pointerId !== orderDrag.pointerId) return;
  const list = $("c-order-list");
  // The dragged row goes just above the first other row whose middle is below the pointer, or to the end.
  const others = [...list.children].filter((row) => row !== orderDrag.row);
  const next = others.find((row) => { const box = row.getBoundingClientRect(); return event.clientY < box.top + box.height / 2; });
  if (next) { if (orderDrag.row.nextElementSibling !== next) list.insertBefore(orderDrag.row, next); }
  else if (list.lastElementChild !== orderDrag.row) list.appendChild(orderDrag.row);
  // Near the top or bottom edge of the window, scroll so a row can be dragged further than what is visible.
  const dialog = $("dlg-criteria"), edge = dialog.getBoundingClientRect();
  if (event.clientY < edge.top + 40) dialog.scrollTop -= 12;
  else if (event.clientY > edge.bottom - 40) dialog.scrollTop += 12;
});

$("criteria-fields").addEventListener("pointerup", finishOrderDrag);
$("criteria-fields").addEventListener("pointercancel", finishOrderDrag);

function moveSection(key, dir) {
  const i = orderDraft.indexOf(key);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= orderDraft.length) return;
  [orderDraft[i], orderDraft[j]] = [orderDraft[j], orderDraft[i]];
  renderOrderList({ key, dir });
}

// What each dealbreaker switch means, shown beside the switch.
const DEALBREAKER_RULES = {
  flood: "if the spot is in a high-risk FEMA flood zone",
  septic: "if the soil is very limited for a septic system",
  slope: "if the slope reaches the zero end of its range below",
  rain: "if rainfall is at or below the zero end of its range below",
  airport: "if the drive to the airport is longer than the dealbreaker minutes below",
  price: "if the price is at or above the zero end of its range below",
  internet: "if there is no wired or fixed wireless service, or the speed is at or below the zero end below",
};

let pointsDraft = {};   // the skill tree being edited; saved with the Save button
let dealDraft = {};     // the dealbreaker switches being edited

function pointsLeft() { return POINT_BUDGET - Object.values(pointsDraft).reduce((a, b) => a + b, 0); }

function renderTree() {
  const left = pointsLeft();
  $("c-points-left").textContent = left === 0 ? `All ${POINT_BUDGET} points spent` : `${left} of ${POINT_BUDGET} points left`;
  $("c-points-left").classList.toggle("spent", left === 0);
  $("c-tree").innerHTML = Object.keys(DEFAULT_SETTINGS.points).map((key) => {
    const n = pointsDraft[key], name = FACTOR_LABELS[key];
    const pips = Array.from({ length: POINT_BUDGET }, (_, i) => `<i class="${i < n ? "on" : ""}"></i>`).join("");
    return `<li class="node${n > 0 ? " active" : ""}">
      <div class="node-main">
        <span class="node-name">${helpLabel(name)}</span>
        <span class="pips" aria-hidden="true">${pips}</span>
        <button class="btn small" type="button" data-point="${key}" data-delta="-1" aria-label="Take a point from ${esc(name)}" ${tipAttr(`Take a point away from ${name}. The point goes back to your pool.`)}${n === 0 ? " disabled" : ""}>&minus;</button>
        <output class="node-points" aria-label="${esc(name)} points">${n}</output>
        <button class="btn small" type="button" data-point="${key}" data-delta="1" aria-label="Give a point to ${esc(name)}" ${tipAttr(`Give a point to ${name}. More points make it pull the total score harder.`)}${left === 0 ? " disabled" : ""}>+</button>
      </div>
      <label class="node-deal"><input type="checkbox" data-deal="${key}"${dealDraft[key] ? " checked" : ""}> ${tipSpan("Dealbreaker", `When on, a parcel is flagged as a dealbreaker ${DEALBREAKER_RULES[key]}. It still gets a score, and you can hide flagged parcels in the list. Missing data never triggers it.`)} <span class="sub">${esc(DEALBREAKER_RULES[key])}</span></label>
    </li>`;
  }).join("");
}

function showSettingsTab(name) {
  for (const tab of document.querySelectorAll("#form-criteria [data-tab]")) {
    const on = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", on ? "true" : "false");
    tab.tabIndex = on ? 0 : -1;
  }
  for (const panel of document.querySelectorAll("#criteria-fields [data-panel]")) panel.hidden = panel.dataset.panel !== name;
}

function numberBoxes(fields) {
  return fields.map(([label, path]) =>
    `<label>${SETTING_TIPS[path] ? tipSpan(label, SETTING_TIPS[path]) : esc(label)}<input data-path="${path}" inputmode="decimal" value="${esc(getPath(settings, path))}"></label>`).join("");
}

function openCriteria() {
  pointsDraft = { ...settings.points };
  dealDraft = { ...settings.dealbreakers };
  $("criteria-fields").innerHTML = `
    <div class="tab-panel" id="panel-scoring" role="tabpanel" aria-labelledby="tab-scoring" data-panel="scoring">
      <div class="stack">
        <div class="tree-head"><strong>${tipSpan("Skill tree", "You have 10 points to spend on what matters most. A factor's share of the points decides how much it counts toward the 0 to 100 score. 0 points means the factor is ignored.")}</strong><span class="points-left" id="c-points-left" role="status"></span></div>
        <p class="hint">Spend ${POINT_BUDGET} points on what matters most to you. More points means the factor pulls the score harder. A factor with 0 points is not scored, and a factor with no data for a parcel is skipped, not counted as zero. Turn on Dealbreaker to rule a parcel out completely when that factor is at its worst.</p>
        <ul class="tree" id="c-tree"></ul>
        <div class="node flood-node">
          <div class="node-main"><span class="node-name">${helpLabel("In a flood zone?")}</span><span class="sub">Not scored. The report shows a plain Yes or No with the zone.</span></div>
          <label class="node-deal"><input type="checkbox" data-deal="flood"${dealDraft.flood ? " checked" : ""}> ${tipSpan("Dealbreaker", `When on, a parcel is flagged as a dealbreaker ${DEALBREAKER_RULES.flood}. Missing data never triggers it.`)} <span class="sub">${esc(DEALBREAKER_RULES.flood)}</span></label>
        </div>
      </div>
      <div class="fields">
        <p class="hint wide">These ranges are starting points, not rules. Rainfall, price and slope that count as good vary a lot across the US (for example, 15 inches of rain a year is dry in Georgia but normal in Nevada), so set them for the region you are searching.</p>
        ${numberBoxes(SCORING_FIELDS)}
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
        </div>
      </div>
    </div>
    <div class="tab-panel" id="panel-costs" role="tabpanel" aria-labelledby="tab-costs" data-panel="costs" hidden>
      <div class="fields">
        <p class="hint wide">These are placeholders for the rough cost estimate and the loan comparison. Replace them with real quotes for the area you are searching.</p>
        ${numberBoxes(COST_FIELDS)}
        <label class="wide">Census API key (optional and free; lets the app look up your county's typical property tax rate)
          <input id="c-census-key" value="${esc(settings.censusKey)}" autocomplete="off" placeholder="Paste your key here"></label>
        <p class="hint wide key-help">No key yet? <a id="c-census-key-link" href="${CENSUS_KEY_SIGNUP_URL}" target="_blank" rel="noopener noreferrer">Get a free Census API key</a>. It opens in a new tab, and the Census emails the key to you. Paste it above, press Save settings, then Refresh data on a parcel.</p>
        <label class="check wide"><input type="checkbox" id="c-use-county-tax" ${settings.costs.useCountyTax !== false ? "checked" : ""}> Use the county's typical tax rate when it is known (otherwise use the rate above)</label>
      </div>
    </div>
    <div class="tab-panel" id="panel-layout" role="tabpanel" aria-labelledby="tab-layout" data-panel="layout" hidden>
      <div class="stack" id="c-order-block">
        <strong>Order of the report sections</strong>
        <p class="hint">The score and factor table always come first, and the data sources and your notes always come last. Drag a row by the dots on its left, or use Up and Down, to arrange everything between them. The report groups sections into collapsible categories (shown at the right of each row). Inside a category the sections follow this order, and the category that holds your first section comes first. The change applies to the report on screen and to the printout.</p>
        <ol class="order-list" id="c-order-list"></ol>
        <div><button class="btn small" type="button" id="c-order-reset">Reset to the default order</button></div>
      </div>
    </div>`;
  renderTree();
  orderDraft = normalizeReportOrder(settings.reportOrder);
  renderOrderList();
  $("c-airport-mode").value = settings.airportMode;
  $("criteria-error").hidden = true;
  showSettingsTab("scoring");
  applyStaticTips();
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
  // An error is shown at the top, which is always visible, and the tab that holds the problem opens.
  const settingsError = (message, where) => {
    $("criteria-error").textContent = message;
    $("criteria-error").hidden = false;
    const panel = where && where.closest("[data-panel]");
    if (panel) showSettingsTab(panel.dataset.panel);
  };
  for (const input of $("criteria-fields").querySelectorAll("input[data-path]")) {
    const value = parseNumber(input.value);
    if (value == null || Number.isNaN(value) || value < 0) {
      settingsError("Every number field needs a number of zero or more.", input);
      return;
    }
    setPath(next, input.dataset.path, value);
  }
  if (pointsLeft() === POINT_BUDGET) {
    settingsError("Spend at least one point in the skill tree, or every parcel would have no score.", $("c-tree"));
    return;
  }
  next.points = normalizePoints(pointsDraft);
  next.dealbreakers = { ...dealDraft };
  if (next.priceMax === next.priceTarget || next.slopeMax === next.slopeIdeal || next.rainFull === next.rainZero
      || next.airportMaxMin === next.airportFullMin || next.internetFullMbps === next.internetZeroMbps) {
    settingsError("The two ends of each range must be different numbers.", $("c-tree"));
    return;
  }
  next.censusKey = $("c-census-key").value.trim();
  next.reportOrder = normalizeReportOrder(orderDraft);
  next.costs.useCountyTax = $("c-use-county-tax").checked;
  next.airportMode = $("c-airport-mode").value;
  const airportResult = parseAirports($("c-airports").value);
  if (next.airportMode === "custom" && airportResult.error) {
    settingsError(airportResult.error, $("c-airports"));
    return;
  }
  next.airports = airportResult.airports || [];   // keep a typed list even while the national list is in use
  settings = next;
  writeStored(SETTINGS_KEY, settings);
  recomputeAirports();
  $("dlg-criteria").close();
  renderAll();
  liveRender();   // an open report picks up the new section order
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
  const el = event.target.closest("[data-open],[data-close],[data-refresh],[data-delete],[data-edit],[data-save-notes],[data-print],[data-copy-summary]");
  if (!el) return;
  if (el.dataset.print !== undefined) window.print();
  else if (el.dataset.copySummary) copySummary(el.dataset.copySummary);
  else if (el.dataset.close !== undefined) el.closest("dialog").close();
  else if (el.dataset.open) openDetail(el.dataset.open);
  else if (el.dataset.refresh) refreshParcel(el.dataset.refresh);
  else if (el.dataset.delete) deleteParcel(el.dataset.delete);
  else if (el.dataset.edit) openEdit(el.dataset.edit);
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

$("btn-add").addEventListener("click", openAdd);
$("btn-pick").addEventListener("click", startPick);
$("btn-demo").addEventListener("click", loadDemo);
$("form-add").addEventListener("submit", addParcelFromForm);
$("btn-criteria").addEventListener("click", openCriteria);
$("form-criteria").addEventListener("submit", saveCriteria);
$("form-criteria").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab]");
  if (tab) showSettingsTab(tab.dataset.tab);
});
// Arrow keys move between the tabs, as on any tab bar.
$("form-criteria").addEventListener("keydown", (event) => {
  const tab = event.target.closest("[data-tab]");
  if (!tab || (event.key !== "ArrowRight" && event.key !== "ArrowLeft")) return;
  const tabs = [...document.querySelectorAll("#form-criteria [data-tab]")];
  const next = tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
  showSettingsTab(next.dataset.tab);
  next.focus();
});
$("criteria-fields").addEventListener("click", (event) => {
  const point = event.target.closest("[data-point]");
  if (point) {
    const key = point.dataset.point, delta = Number(point.dataset.delta);
    if (delta > 0 && pointsLeft() === 0) return;
    if (delta < 0 && pointsDraft[key] === 0) return;
    pointsDraft[key] += delta;
    renderTree();
    // The buttons were redrawn, so put the keyboard focus back on the one that was used (or its partner if it is now off).
    const again = $("c-tree").querySelector(`button[data-point="${key}"][data-delta="${delta}"]:not(:disabled)`)
      || $("c-tree").querySelector(`button[data-point="${key}"]:not(:disabled)`);
    if (again) again.focus();
    return;
  }
  const move = event.target.closest("[data-move]");
  if (move) { moveSection(move.dataset.key, move.dataset.move); return; }
  if (event.target.id === "c-order-reset") { orderDraft = normalizeReportOrder([]); renderOrderList(); }
});
// Choosing a preset airport adds its line to the text box.
$("criteria-fields").addEventListener("change", (event) => {
  if (event.target.dataset.deal) { dealDraft[event.target.dataset.deal] = event.target.checked; return; }
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

$("app-version").textContent = versionText(APP_VERSION, APP_UPDATED);
initMap();
renderAll();
applyStaticTips();
if (!storageOk) $("storage-warning").hidden = false;
