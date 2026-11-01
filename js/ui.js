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

// Was the last press a finger (or pen) rather than a mouse? Phones send pretend mouse and focus events around a tap,
// including a "mouse left" right after it, which would close the tip at once. So after a touch, only a tap somewhere
// else (or Escape, or scrolling) closes a tip.
let touchPress = false;
document.addEventListener("pointerdown", (e) => { touchPress = e.pointerType !== "mouse"; }, true);

// After a touch, the pretend mouse events can land on whatever was under an earlier tap, so they open no tips; the tap does.
document.addEventListener("mouseover", (e) => { const t = !touchPress && e.target.closest && e.target.closest(TIP_TARGET); if (t) showHelpTip(t); });
document.addEventListener("mouseout", (e) => { if (!touchPress && e.target.closest && e.target.closest(TIP_TARGET)) hideHelpTip(); });
document.addEventListener("focusin", (e) => { const t = e.target.closest && e.target.closest(TIP_TARGET); if (t) showHelpTip(t); });
document.addEventListener("focusout", () => { if (!touchPress) hideHelpTip(); });
// A dotted label inside a <label> (like "Road detour factor" or a tick box's words) would pass a tap on to its box,
// which takes the focus, opens the phone keyboard or flips the tick box, and closes the tip. On a touch screen a tap on
// the dotted words only shows the tip; tapping the box itself still works. With a mouse, hovering shows the tip, so a
// click on the words keeps working as usual. (Capture phase, so this runs before the label acts.)
document.addEventListener("click", (e) => {
  if (touchPress && e.target.closest && e.target.closest(".help") && e.target.closest("label")) e.preventDefault();
}, true);
// Pressing a button does its job, so its tip goes away. A tap or click on a dotted label shows its tip (again, if it
// already had the focus and so got no new focus event).
document.addEventListener("click", (e) => {
  const help = e.target.closest && e.target.closest(".help");
  if (help) showHelpTip(help); else hideHelpTip();
});
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
    // A Texas parcel's boundary from the appraisal district record, drawn as a thin outline under the marker.
    const outline = parcel.site && parcel.site.texas && parcel.site.texas.parcel && parcel.site.texas.parcel.outline;
    if (outline) L.polygon(outline, { color: MARKER_COLORS[scoreClass(score.total)], weight: 2, fill: false, interactive: false }).addTo(markerLayer);
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
    $("list").innerHTML = `<div class="empty"><strong>No addresses yet.</strong><br>Add one with a street address or by picking its spot on the map. You can also load three demo addresses to see how it works.</div>`;
    return;
  }
  updateCompareButton();
  const columns = listColumns();
  const rows = items.map(({ parcel: p, score }, i) => {
    const site = p.site || {};
    return `<tr class="row" data-open="${esc(p.id)}">
      <td class="col-pick"><input type="checkbox" data-compare="${esc(p.id)}" aria-label="Pick ${esc(p.name)} to compare"${compareIds.includes(p.id) ? " checked" : ""}></td>
      <td class="num col-n">${i + 1}</td>
      <td><button class="row-name" type="button" data-open="${esc(p.id)}">${esc(p.name)}</button>${score.dealbreakers.length ? `<span class="badge" title="${esc(score.dealbreakers.join("; "))}">Dealbreaker</span>` : ""}
        <div class="sub">${esc(countyLabel(p))} &middot; ${esc(p.acres ?? "?")} acres${p.acresSource === "appraisal" ? " (appraisal)" : ""}</div></td>
      <td class="num">${money(p.askingPrice)}</td>
      <td><span class="score ${scoreClass(score.total)}">${scoreText(score.total)}</span><div class="sub">${score.factorsScored}/${score.factorsTotal} criteria</div></td>
      <td>${usdaCell(site.usda)}</td>
      <td>${esc(floodShort(site.floodZone))}</td>
      ${columns.map((key, n) => `<td class="${n > 0 ? "col-air" : ""}">${esc(criterionValueText(key, p, settings, true))}</td>`).join("")}
      <td class="col-del">${deleteButton(p.id)}</td>
    </tr>`;
  }).join("");
  $("list").innerHTML = `<div class="table-scroll"><table>
    <thead><tr><th class="col-pick">${tipSpan("Pick", "Tick two or three addresses, then press Compare to see them side by side.")}</th><th class="num col-n">${tipSpan("#", "Rank in the list, by the sort you chose.")}</th><th>${tipSpan("Address", "Your name for the address, with its county and size. Click a row to open its full report.")}</th><th class="num">${tipSpan("Price", "The asking price you entered.")}${sortButton("price")}</th><th>${tipSpan("Score", "0 to 100: the plain average of the criteria you ticked in Settings, each counting the same. A criterion with no data for the parcel is skipped. Open the report to see each one.")}</th><th>${tipSpan("USDA", "Is the spot in an area where USDA Rural Development guaranteed home loans are available? Yes means it is outside USDA's mapped ineligible areas.")}</th><th>${tipSpan("Flood zone", "Is the spot in a high-risk FEMA flood zone (zones starting with A or V)? Yes means high risk.")}</th>${columns.map((key, n) => `<th class="${n > 0 ? "col-air" : ""}">${helpLabel(FACTOR_LABELS[key])}${sortButton(key)}</th>`).join("")}<th class="col-del" aria-label="Delete"></th></tr></thead>
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

/* ---- the list controls: columns, sorting by a criterion, and the value filter ---- */

// The criteria shown as list columns, in your criteria order: the ones you picked in the Columns menu, or until you
// pick, the first few you ticked. Price and flood have their own columns, so they are not offered.
const COLUMN_CHOICES = () => chosenCriteria(settings).filter((key) => key !== "price" && key !== "flood");
function listColumns() {
  const choices = COLUMN_CHOICES();
  return Array.isArray(view.columns) ? choices.filter((key) => view.columns.includes(key)) : choices.slice(0, LIST_CRITERIA_COLUMNS);
}

// The small button in a column heading: sorts by that criterion low to high, then high to low on the next click.
function sortButton(key) {
  const now = CRITERION_SORT.exec(view.sort || "");
  const dir = now && now[1] === key ? now[2] : null;
  const next = dir === "asc" ? "high to low" : "low to high";
  return ` <button class="sort-btn${dir ? " on" : ""}" type="button" data-sort-key="${key}" aria-label="Sort by ${esc(FACTOR_LABELS[key])}, ${next}" ${tipAttr(`Sort the list by ${FACTOR_LABELS[key]}, ${next}. Parcels with no data go last.`)}>${dir === "asc" ? "&#9650;" : dir === "desc" ? "&#9660;" : "&#8661;"}</button>`;
}

// "Slope: low to high" and the like, for the Sort menu.
function criterionSortLabel(key, dir) {
  const unit = criterionUnit(key);
  return `${FACTOR_LABELS[key]}${unit === "score" ? " score" : ""}: ${dir === "asc" ? "low to high" : "high to low"}`;
}

// Rebuilds the Sort menu, the Columns menu and the filter's criterion list, which all follow your ticked criteria.
function renderListControls() {
  const chosen = chosenCriteria(settings);
  const sortKeys = new Set(chosen);
  const current = CRITERION_SORT.exec(view.sort || "");
  if (current) sortKeys.add(current[1]);   // a sort you picked stays in the menu even if you untick the criterion
  $("sort-by").innerHTML = Object.entries(SORTS).map(([key, sort]) => `<option value="${key}">${esc(sort.label)}</option>`).join("")
    + [...sortKeys].map((key) => `<option value="crit:${key}:asc">${esc(criterionSortLabel(key, "asc"))}</option><option value="crit:${key}:desc">${esc(criterionSortLabel(key, "desc"))}</option>`).join("");
  $("sort-by").value = view.sort;
  const shown = listColumns();
  const choices = COLUMN_CHOICES();
  $("col-menu").innerHTML = choices.length
    ? choices.map((key) => `<label><input type="checkbox" data-col="${key}"${shown.includes(key) ? " checked" : ""}> ${esc(FACTOR_LABELS[key])}</label>`).join("")
      + `<span class="sub">Only criteria you ticked in Settings can be columns. Price and flood always show.</span>`
    : `<span class="sub">Tick criteria in Settings &gt; Scoring to add them as columns.</span>`;
  const filterKeys = new Set(chosen);
  if (view.filter) filterKeys.add(view.filter.key);
  $("filter-crit").innerHTML = `<option value="">None</option>` + [...filterKeys].map((key) => `<option value="${key}">${esc(FACTOR_LABELS[key])}</option>`).join("");
  $("filter-crit").value = view.filter ? view.filter.key : "";
  $("filter-op").value = view.filter ? view.filter.op : "max";
  $("filter-value").value = view.filter && view.filter.value != null ? String(view.filter.value) : "";
  $("filter-value").placeholder = view.filter ? (criterionUnit(view.filter.key) === "$" ? "dollars" : criterionUnit(view.filter.key)) : "";
  for (const id of ["filter-op", "filter-value", "filter-clear"]) $(id).disabled = !view.filter;
}

// Says what the filter is doing, and how many parcels it hid.
function renderFilterHint(shownCount) {
  const f = view.filter;
  if (!f || !Number.isFinite(f.value)) { $("filter-hint").hidden = true; return; }
  const unit = criterionUnit(f.key);
  const valueText = unit === "$" ? money(f.value) : unit === "%" ? `${f.value}%` : unit === "score" ? `a score of ${f.value}` : `${f.value} ${unit}`;
  const others = parcels.length - shownCount;
  $("filter-hint").hidden = false;
  $("filter-hint").textContent = `Showing parcels with ${FACTOR_LABELS[f.key]} ${f.op === "max" ? "at most" : "at least"} ${valueText}${others ? `; ${others} hidden by the filters` : ""}. Parcels with no data for it are still shown.`;
}

// Saves a change to how the list looks, and redraws it.
function changeView(changes) {
  view = { ...view, ...changes };
  writeStored(VIEW_KEY, view);
  renderAll();
}

function renderAll() {
  renderListControls();
  const items = ranked();
  renderFilterHint(items.length);
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

// "4 (Flood, Winter Storm); latest Flood, 2026-07-18" for the county's disaster declarations.
function disastersText(d) {
  if (d.count === 0) return `none since ${esc(d.since)}`;
  const latest = d.recent[0];
  return `${d.count} <span class="sub">(${esc(d.types.join(", "))})</span>; latest ${esc(latest.type)}, ${esc(latest.date)}${latest.kind ? ` <span class="sub">(${esc(latest.kind)})</span>` : ""}`;
}

// The exemptions row: what you ticked, a likely ag or wildlife valuation from a Texas record, and who to ask.
function exemptionsHtml(p) {
  const text = exemptionsText(p.exemptions);
  const open = openSpaceValuation(p);
  const likely = !text && open.from === "appraisal" ? "Ag or wildlife valuation likely <span class=\"sub\">(Texas land category D1)</span>" : "";
  const ask = isTexasParcel(p)
    ? ` <span class="sub">Ask the <a href="${esc(appraisalDistrictUrl(p.county || (p.site.texas && p.site.texas.parcel && p.site.texas.parcel.county)))}" target="_blank" rel="noopener">${esc(p.county ? `${p.county} County` : "county")} appraisal district</a>${p.site.texas && p.site.texas.parcel && p.site.texas.parcel.propertyId ? ` about property ID ${esc(p.site.texas.parcel.propertyId)}` : ""}.</span>`
    : ` <span class="sub">Ask the county assessor or appraisal office.</span>`;
  if (text) return `${esc(text)} <span class="sub">(you entered)</span>${text === "None" ? "" : ask}`;
  return `${likely || `unknown: tick them with Edit`}${ask}`;
}

// The extra flood facts after the Yes or No: FEMA's special flood hazard flag and the base flood elevation, when known.
function floodExtras(site) {
  const bits = [];
  if (site.floodBfeFt != null) bits.push(`base flood elevation ${site.floodBfeFt} ft`);
  if (site.floodBfeFt != null && site.elevationFt != null) {
    const above = Math.round((site.elevationFt - site.floodBfeFt) * 10) / 10;
    bits.push(above >= 0 ? `the spot is about ${above} ft above it` : `the spot is about ${-above} ft below it`);
  }
  return bits.length ? ` <span class="sub">(${esc(bits.join("; "))})</span>` : "";
}

// "People and community": survey figures for the census tract next to the whole county.
function peopleHtml(more) {
  if (more === undefined || !("people" in more || (more.failed || []).includes("people"))) return `<p class="hint">${notYetText()}</p>`;
  if ((more.failed || []).includes("people")) return `<p class="hint">Could not load; use Refresh data to try again.</p>`;
  const people = more.people;
  if (!people || (!people.tract && !people.county)) return `<p class="hint">No survey figures for this spot.</p>`;
  const num = (v) => (v == null ? "?" : Number(v).toLocaleString("en-US"));
  const pct = (v) => (v == null ? "?" : `${v}%`);
  const cash = (v) => (v == null ? "?" : money(v));
  const rows = [
    ["Population", "population", num], ["Median age", "medianAge", num], ["Under 18", "under18Pct", pct],
    ["Median household income", "medianIncome", cash], ["Below the poverty line", "povertyPct", pct],
    ["Bachelor's degree or more", "bachelorsPct", pct], ["Work from home", "workFromHomePct", pct],
    ["Households with broadband", "broadbandPct", pct], ["Median home value", "medianHomeValue", cash],
  ];
  const cell = (place, key, format) => (place ? esc(format(place[key])) : "?");
  return `<div class="table-scroll"><table><thead><tr><th></th><th class="num">${tipSpan("This area", "The census tract the spot is in: a neighborhood of a few thousand people drawn by the Census Bureau. Rural tracts can cover many miles.")}</th><th class="num">${tipSpan("Whole county", "The same figures for the whole county, to compare with.")}</th></tr></thead>
    <tbody>${rows.map(([label, key, format]) => `<tr><td>${helpLabel(label)}</td><td class="num">${cell(people.tract, key, format)}</td><td class="num">${cell(people.county, key, format)}</td></tr>`).join("")}</tbody></table></div>
    <p class="hint">Estimates from the Census Bureau's American Community Survey${people.release ? ` (${esc(people.release)})` : ""}, an average over five years of surveys, through Census Reporter. Small rural areas have wide margins of error, so treat close numbers as about the same.</p>`;
}

// "Family needs": for the ages you ticked in Settings, the places that matter and what to know. Empty when none is ticked,
// so the section is left out of the report.
function familyHtml(p) {
  const stages = Object.keys(FAMILY_STAGES).filter((key) => settings.family && settings.family[key]);
  if (!stages.length) return "";
  const site = p.site || {};
  const texas = isTexasParcel(p);
  const sub = (text) => `<span class="sub">${text}</span>`;
  const minutesText = (place) => `${Math.round(placeMinutes(place, settings))} min${place.driveMin == null ? " (estimated)" : ""}`;
  // One row per kind of place the ticked ages need, each listed once, in the order of PLACE_KINDS.
  const wanted = new Set(stages.flatMap((key) => FAMILY_STAGES[key].places));
  const placeRows = PLACE_KINDS.filter((kind) => wanted.has(kind.key)).map((kind) => {
    const places = site.places;
    if (!places) return kv(kind.label, sub(notYetText()));
    if (!(kind.key in places)) return kv(kind.label, sub("not looked up yet; use Refresh data"));
    const place = places[kind.key];
    return kv(kind.label, place ? `${esc(place.name)} ${sub(`${esc(minutesText(place))}, ${place.miles} mi`)}` : sub("none found in OpenStreetMap; ask locally"));
  }).join("");
  // Texas-designated delivery and newborn care hospitals, for "Expecting".
  let designated = "";
  if (stages.some((key) => FAMILY_STAGES[key].maternity)) {
    if (!texas) {
      designated = kv("Delivery hospital", sub("There is no public list of hospitals that deliver babies outside Texas that the app can read. Call the hospitals under Nearby and ask about labor and delivery and newborn care."));
    } else {
      const tx = site.texas || {};
      const failed = tx.failed || [];
      const list = (key) => {
        if (failed.includes(key)) return sub("could not load; use Refresh data to try again");
        if (!(key in tx)) return sub(site.texas ? "not looked up yet; use Refresh data" : notYetText());
        const hospitals = (tx[key] && tx[key].hospitals) || [];
        if (!hospitals.length) return sub("none designated within 150 miles");
        return `<ul class="tight">${hospitals.map((h) => `<li>${esc(h.name)} ${sub(`${esc(h.city || "")}; Level ${esc(h.level || "?")}; ${h.driveMin != null ? `${h.driveMin} min drive` : `${h.miles} mi (about ${Math.round(driveMinutes(h.miles, settings))} min)`}`)}</li>`).join("")}</ul>`;
      };
      designated = kv("Delivery hospital", list("maternal")) + kv("Newborn care (NICU)", list("neonatal"));
    }
  }
  const links = {
    expecting: texas ? `<a href="${DATA_SOURCES.txMaternal.url}" target="_blank" rel="noopener">DSHS designation map</a>` : "",
    toddler: texas ? `<a href="${TX_CHILDCARE_SEARCH_URL}" target="_blank" rel="noopener">Search Texas Child Care</a>` : "",
    prek: texas ? `<a href="${TX_CHILDCARE_SEARCH_URL}" target="_blank" rel="noopener">Search Texas Child Care</a> &middot; <a href="${TX_SCHOOL_REPORT_CARDS_URL}" target="_blank" rel="noopener">Texas School Report Cards</a>` : "",
    elementary: texas ? `<a href="${TX_SCHOOL_REPORT_CARDS_URL}" target="_blank" rel="noopener">Texas School Report Cards</a>` : "",
    middle: texas ? `<a href="${TX_SCHOOL_REPORT_CARDS_URL}" target="_blank" rel="noopener">Texas School Report Cards</a>` : "",
    high: texas ? `<a href="${TX_SCHOOL_REPORT_CARDS_URL}" target="_blank" rel="noopener">Texas School Report Cards</a>` : "",
  };
  const advice = stages.map((key) => {
    const stage = FAMILY_STAGES[key];
    const lines = [...stage.advice, ...(texas && stage.texas ? [stage.texas] : [])];
    return `<div class="family-stage"><strong>${esc(stage.label)}</strong>${links[key] ? ` ${sub(links[key])}` : ""}<ul class="tight">${lines.map((line) => `<li>${esc(line)}</li>`).join("")}</ul></div>`;
  }).join("");
  return `
      <h3>Family needs</h3>
      <div class="kv">${designated}${placeRows}</div>
      ${advice}
      <p class="hint">Doctors' offices, child care and preschools are thinly mapped in OpenStreetMap, so "none found" often means "not on the map". Drive times marked estimated come from straight-line distance. Confirm with the providers, the school district and the hospital before you rely on any of this.</p>
      ${(() => { const keys = sourceKeysUsed(p).filter((k) => k === "txMaternal" || k === "places"); return keys.length ? sourceHtml(keys, site) : ""; })()}`;
}

// "Crime": what the county sheriff reported to the FBI for the last full year, with Texas and US rates.
function crimeHtml(more) {
  if (more === undefined || !("crime" in more || (more.failed || []).includes("crime"))) return `<p class="hint">${notYetText()}</p>`;
  if ((more.failed || []).includes("crime")) return `<p class="hint">Could not load; use Refresh data to try again.</p>`;
  const crime = more.crime;
  if (crime && crime.needsKey) {
    return `<p class="hint">${crime.keyRejected ? "The FBI's service did not accept your crime data key." : "The FBI's crime figures need a free key."} Get one at <a href="${CRIME_KEY_SIGNUP_URL}" target="_blank" rel="noopener">api.data.gov/signup</a>, paste it into Settings &gt; Costs and loans, then click Refresh data.</p>`;
  }
  if (!crime) return `<p class="hint">No county found for this spot, so there is no sheriff to look up.</p>`;
  if (!crime.agency) return `<p class="hint">The FBI's list has no county sheriff for this county.</p>`;
  const per = (v) => (v == null ? "?" : Number(v).toLocaleString("en-US"));
  const row = (label, o) => `<tr><td>${helpLabel(label)}</td><td class="num">${o ? per(o.count) : "?"}</td><td class="num">${o ? per(o.ratePer100k) : "?"}</td><td class="num">${o ? per(o.stateRate) : "?"}</td><td class="num">${o ? per(o.usRate) : "?"}</td></tr>`;
  const months = Math.min(crime.violent ? crime.violent.months : 12, crime.property ? crime.property.months : 12);
  return `<div class="kv">${kv("Sheriff's office", `${esc(crime.agency)} <span class="sub">${esc(crime.year)}${crime.violent && crime.violent.population ? `, serving about ${per(crime.violent.population)} people` : ""}</span>`)}</div>
    <div class="table-scroll"><table><thead><tr><th></th><th class="num">Offenses</th><th class="num">Per 100,000</th><th class="num">Texas</th><th class="num">US</th></tr></thead>
      <tbody>${row("Violent crime", crime.violent)}${row("Property crime", crime.property)}</tbody></table></div>
    ${months < 12 ? `<p class="notice">The sheriff reported only ${months} of 12 months, so these numbers are low.</p>` : ""}
    <p class="hint">Offenses the county sheriff reported to the FBI for the year. The sheriff covers the county outside city limits; towns report their own figures. Rates are per 100,000 people the sheriff serves (the Texas and US columns are for the whole state and country), and with a small rural population a few incidents change the rate a lot. It says nothing about a particular road or neighborhood, so ask neighbors and the sheriff's office too.</p>`;
}

// "More local conditions": drought, weather office and alerts, wind, nearby regulated facilities and disaster declarations.
function moreHtml(more) {
  if (more === undefined) return `<p class="hint">${notYetText()}</p>`;
  const failed = more.failed || [];
  const unavailable = `<span class="sub">could not load; use Refresh data to try again</span>`;
  const noData = `<span class="sub">no data for this spot</span>`;
  const row = (label, key, make) => kv(label, failed.includes(key) ? unavailable : (more[key] ? make(more[key]) : noData));
  const droughtText = (d) => (d.level
    ? `${esc(d.level)}: ${esc(d.name)} <span class="sub">map of ${esc(d.date || "?")}</span>`
    : `no drought here <span class="sub">current map</span>`);
  return `<div class="kv">
      ${row("Drought now", "drought", droughtText)}
      ${row("Weather service office", "weather", (w) => `${esc(w.office || "?")}${w.nearTown ? ` <span class="sub">near ${esc(w.nearTown)}</span>` : ""}`)}
      ${row("Weather alerts now", "weather", (w) => (w.alerts.length ? esc(w.alerts.join(", ")) : "none in effect"))}
      ${row("Average wind speed", "wind", (w) => (w.windMph == null ? "?" : `${w.windMph} mph`))}
      ${row("Average humidity", "wind", (w) => (w.humidityPct == null ? "?" : `${w.humidityPct}%`))}
      ${row("Regulated facilities within 2 miles", "facilities", (f) => (f.facilities > 0 ? `${f.facilities}` : "none listed"))}
      ${"disasters" in more || failed.includes("disasters") ? row("FEMA disaster declarations (10 years)", "disasters", disastersText) : ""}
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
  const acresNote = p.acresSource === "appraisal" ? ` <span class="sub">(used as the parcel's acres)</span>`
    : par && par.appraisalAcres != null && p.acres > 0 && Math.abs(par.appraisalAcres - p.acres) / p.acres > 0.2
      ? ` <span class="sub">(you entered ${esc(p.acres)})</span>` : "";
  const tax = estimatedTaxBeforeExemptions(p, settings);
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
      ${par && par.improvementValue != null ? row("Appraised improvement value", "parcel", () => money(par.improvementValue)) : ""}
      ${par && par.marketValue != null ? row("Appraised total value", "parcel", () => money(par.marketValue)) : ""}
      ${tax ? row("Estimated yearly tax before exemptions", "parcel", () => `${money(tax.amount)} <span class="sub">(${tax.ratePct}% ${tax.source === "county" ? "typical county rate" : "your rate from Settings"})</span>`) : ""}
      ${par && par.yearBuilt ? row("Year built", "parcel", () => esc(par.yearBuilt)) : ""}
      ${par && par.landUse ? row("Land use (appraisal district)", "parcel", () => esc(par.landUse)) : ""}
      ${par ? row("Parcel outline", "parcel", () => (par.outline ? "drawn on the map" : "not available for this parcel")) : ""}
      ${row("Groundwater district", "groundwaterDistrict", () => (gcd && gcd.name ? esc(gcd.name) : "not in a groundwater conservation district"))}
      ${row("School district", "schoolDistrict", () => (tx.schoolDistrict && tx.schoolDistrict.name ? esc(tx.schoolDistrict.name) : "?"))}
      ${row("Water wells nearby", "wells", () => wellsText)}
      ${wells && wells.aquifers.length ? row("Aquifer (nearby wells)", "wells", () => esc(wells.aquifers.join(", "))) : ""}
      ${row("Oil and gas wells within 1 mile", "oilGasWells", () => (oil && oil.count > 0 ? `${oil.count}` : "none mapped"))}
      ${row("Pipelines within half a mile", "pipelines", () => pipeText)}
      ${row("Edwards Aquifer recharge zone", "edwards", () => (edwards && edwards.inRechargeZone ? "Yes" : "No"))}
    </div>
    <p class="hint">These come from Texas state sources and only appear for parcels in Texas. They do not show who owns the minerals, easements, deed restrictions, or your county's septic (OSSF) rules, so check the deed, a title search and the county. Appraisal values are for tax, not sale price. The statewide data has no exemptions and no taxable value after exemptions, and farm and ranch land under ag or wildlife valuation is taxed on a much lower use value, so ask the appraisal district for the real taxable value. The owner's name and mailing address in the appraisal record are deliberately not shown.</p>`;
}

function roadsHtml(roads) {
  if (roads === undefined) return `<p class="hint">${notYetText()}</p>`;
  if (roads === null) return `<p class="hint">No road data for this spot.</p>`;
  const describe = (road) => (road ? `${esc(road.name)} <span class="sub">(${esc(road.type.replace(/_/g, " "))}${road.surface === "unknown" ? "" : `, ${esc(road.surface)}`}${road.access ? `, access: ${esc(road.access)}` : ""})</span>` : "");
  const far = !roads.nearest || roads.nearest.distanceFt > 1500;
  const noneWithin = roads.searchedMeters ? `none within ${esc(distanceText(Math.round(roads.searchedMeters * 3.28084)))}` : "none found";
  return `${far ? `<p class="notice">${roads.nearest ? "The nearest road is far from this spot" : "No road found near this spot"}. Confirm how you would get to the land, and whether you have a legal right to use that route.</p>` : ""}
    <div class="kv">
      ${kv("Nearest road", roads.nearest ? `${esc(distanceText(roads.nearest.distanceFt))} away: ${describe(roads.nearest)}` : noneWithin)}
      ${kv("Nearest paved public road", roads.nearestPublicPaved ? `${esc(distanceText(roads.nearestPublicPaved.distanceFt))} away: ${describe(roads.nearestPublicPaved)}`
        : roads.source === "osrm" ? `<span class="sub">not known: the map servers were busy, so only the backup nearest-road answer came back. Use Refresh data later.</span>` : noneWithin)}
    </div>
    ${roads.source === "tiger" ? `<p class="notice">The OpenStreetMap servers were busy, so these roads come from the Census Bureau's TIGER road map instead. It does not record surfaces, so only highways count as paved here, and a paved county road nearby may not show. Use Refresh all later for the OpenStreetMap details.</p>` : ""}
    <p class="hint">${roads.source === "tiger" ? "From the US Census Bureau's TIGER roads." : "From OpenStreetMap."} This shows that a road exists near the point you picked, not that the parcel touches it or that you may use it. Many rural roads and driveways are private, and some roads are missing. Legal access (road frontage, an easement) shows up in the deed and the survey, so check those with the county and a title company.</p>`;
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
      ${kv("Soil permeability (slowest layer)", sd.permeability ? `${esc(sd.permeability.rating)} <span class="sub">(${sd.permeability.umPerSec} micrometers a second)</span>` : sd.permeability === undefined ? "not looked up" : "?")}
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
    ${hazards.socialVulnerability || hazards.resilience ? `<div class="kv">
      ${kv("Social vulnerability", esc(hazards.socialVulnerability || "?"))}
      ${kv("Community resilience", esc(hazards.resilience || "?"))}
    </div>` : ""}
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
      <div>${helpLabel("Loan payment")}</div><div>${loanText}${c.years > 0 ? ` <span class="sub">(${money(est.downPayment)} down, ${c.ratePct}% for ${c.years} years)</span>` : ""}</div>
      <div>${helpLabel("Property tax")}</div><div>${money(est.monthly.tax)} <span class="sub">(${est.taxPct}% a year, ${est.taxSource === "county" ? `typical for ${esc(parcel.site.taxRate.name)}` : "your setting"})</span></div>
      <div>${helpLabel("Insurance")}</div><div>${money(est.monthly.insurance)}</div>
      <div><strong>${helpLabel("About per month")}</strong></div><div><strong>${money(est.monthly.total)}</strong></div>
      <div>${helpLabel("Cash down payment")}</div><div>${money(est.downPayment)}</div>
      <div>${helpLabel("Septic system")}</div><div>${money(est.oneTime.septic)}</div>
      <div>${helpLabel("Water well")}</div><div>${money(est.oneTime.well)}</div>
      <div><strong>${helpLabel("One-time start-up")}</strong></div><div><strong>${money(est.oneTime.total)}</strong></div>
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
  const summaryRows = score.chosen.map((key) => {
    const v = score.parts[key];
    return `<tr>
      <td>${helpLabel(FACTOR_LABELS[key])}</td>
      <td>${esc(criterionValueText(key, p, settings))}</td>
      <td class="num">${v == null ? "no data" : Math.round(v)}</td>
      <td>${v == null ? "" : `<div class="bar"><span style="width:${v}%"></span></div>`}</td></tr>`;
  }).join("");
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
        ${kv("In a flood zone?", esc(floodAnswer(site.floodZone, site.floodSfha).text) + floodExtras(site))}
        ${kv("Elevation", site.elevationFt != null ? `${site.elevationFt} ft` : "?")}
        ${kv("Slope (steepest of 4 directions)", site.slopePct != null ? `${site.slopePct}%${site.slopeFacing ? ` <span class="sub">(${site.slopeFacing === "flat" ? "about flat" : `faces ${esc(site.slopeFacing)}`})</span>` : ""}` : "?")}
        ${kv("Soil", esc(site.soilName || "?"))}
        ${kv("Drainage class", esc(site.drainageClass || "?"))}
        ${kv("Septic rating", esc(site.septicRating || "?"))}
        ${kv("Average yearly rain", site.annualRainIn != null ? `${site.annualRainIn} in` : "?")}
        ${kv("Nearest airport", esc(drive))}
        ${kv("USDA loan area", usdaCell(site.usda))}
        ${kv("Tax exemptions", exemptionsHtml(p))}
        ${kv("Plant hardiness zone", site.hardiness ? `${esc(hardinessText(site.hardiness))} <span class="sub">by ZIP ${esc(site.hardiness.zip)}, USDA ${esc(site.hardiness.vintage)} map</span>` : (site.hardiness === undefined ? "not looked up yet" : "?"))}
        ${kv("Data fetched", (p.fetchedAt ? esc(new Date(p.fetchedAt).toLocaleString()) : "never") + (p.filledAt ? ` <span class="sub">(missing data filled in ${esc(new Date(p.filledAt).toLocaleString())})</span>` : ""))}
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
      ${sourceHtml(roadSourceKey(site.roads), site)}`,
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
      ${(() => { const keys = sourceKeysUsed(p).filter((k) => ["drought", "nws", "power", "echo", "femaDisasters"].includes(k)); return keys.length ? sourceHtml(keys, site) : ""; })()}`,
    people: `
      <h3>People and community</h3>
      ${peopleHtml(site.more)}
      ${sourceKeysUsed(p).includes("censusReporter") ? sourceHtml("censusReporter", site) : ""}`,
    family: familyHtml(p),
    crime: `
      <h3>Crime</h3>
      ${crimeHtml(site.more)}
      ${sourceKeysUsed(p).includes("fbiCrime") ? sourceHtml("fbiCrime", site) : ""}`,
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
        <button class="btn small" type="button" data-refresh="${esc(p.id)}" data-mode="missing" ${tipAttr("Look up only what is missing: lookups that failed last time, pieces that did not load, drive times that were estimated, and data added in newer versions of the app. What is already here is kept, which saves requests to the free services.")}${busy ? " disabled" : ""}>${busy ? "Looking up..." : "Refresh data"}</button>
        <button class="btn small" type="button" data-refresh="${esc(p.id)}" data-mode="all" ${tipAttr("Look up all the public data for this spot again, since sources change. This asks every service again, so use it before a decision rather than every time.")}${busy ? " disabled" : ""}>Refresh all</button>
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
      ${busy ? `<p class="notice no-print" role="status">Looking up data: ${lookupDone} of ${lookupTotal} lookups finished. The report fills in as each one arrives.</p>` : ""}
      ${score.dealbreakers.length ? `<p class="notice bad"><strong>Dealbreakers:</strong> ${esc(score.dealbreakers.join("; "))}</p>` : ""}
      <div class="score-line"><span class="big">${scoreText(score.total)}</span><span class="sub">score &middot; ${score.factorsScored} of ${score.factorsTotal} of your criteria had data</span></div>
      <div class="table-scroll"><table class="summary-table"><thead><tr><th>${helpLabel("Criterion")}</th><th>${helpLabel("What we found")}</th><th class="num">${tipSpan("Score", "This criterion's score from 0 (worst) to 100 (best). \"no data\" means the lookup found nothing, so the criterion is skipped, not scored as zero.")}</th><th></th></tr></thead><tbody>${summaryRows}</tbody></table></div>
      <p class="hint no-print">Your criteria, in your order. Every one counts the same. Choose which count, and their order, in Settings &gt; Scoring.</p>
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
let lookupTotal = 0;     // how many lookups this run will make
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

// `mode` is "all" (every lookup) or "missing" (only what failed or was never looked up; see planLookups).
async function runLookups(parcel, mode = "all") {
  clearTimeout(statusTimer);
  const plan = planLookups(parcel, mode, settings);
  if (plan.nothingToDo) {
    $("status").hidden = false;
    $("status").innerHTML = `<strong>Nothing is missing for ${esc(parcel.name)},</strong> so no services were asked. Use Refresh all to look everything up again.`;
    clearProgress(8000);
    return;
  }
  lookingId = parcel.id;
  lookupDone = 0;
  lookupTotal = plan.total;
  $("status").innerHTML = `<strong style="font-size:.85rem">${mode === "all" ? "Looking up" : "Filling in what is missing for"} ${esc(parcel.name)}:</strong>`;
  try {
    await lookupAll(parcel, showProgress, mode, plan);
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
  const exemptions = readExemptions();
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
      if (acres !== existing.acres) existing.acresSource = acres == null ? undefined : "you";   // you changed them, so they are yours now
      existing.name = name; existing.address = address || null; existing.acres = acres; existing.askingPrice = price;
      existing.exemptions = exemptions;
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
    const parcel = { id: newId(), name, address: address || null, lat, lon, county: null, acres, askingPrice: price, exemptions,
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

// The exemption tick boxes in the Add window, by the key they set on the parcel.
const EXEMPTION_KEYS = ["ag", "wildlife", "homestead", "none"];

// What the tick boxes say, or null when none is ticked (you do not know yet).
function readExemptions() {
  const ex = Object.fromEntries(EXEMPTION_KEYS.map((key) => [key, $(`f-ex-${key}`).checked]));
  return Object.values(ex).some(Boolean) ? ex : null;
}

/* ---- editing a parcel: the Add window, filled in with the parcel's values ---- */
let editingId = null;   // the parcel being edited, or null when the window is adding a new one

// Switches the Add window between "add" and "edit" wording.
function setAddFormMode(editing) {
  $("add-title").textContent = editing ? "Edit address" : "Add an address";
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
  const ex = p.exemptions || {};
  for (const key of EXEMPTION_KEYS) $(`f-ex-${key}`).checked = Boolean(ex[key]);
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

async function refreshParcel(id, mode = "missing") {
  const p = parcels.find((x) => x.id === id);
  if (!p || lookingId) return;
  const lookups = runLookups(p, mode);
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
    forgetDentistPediatricians(parcels);   // a file exported before v2.10.0 can hold a dentist as the pediatrician
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
  ["Groundwater: full marks at or above (ft)", "groundwaterFullFt"], ["Groundwater: zero at or below (ft)", "groundwaterZeroFt"],
  ["Hospital: full marks within (min)", "hospitalFullMin"], ["Hospital: zero at (min)", "hospitalMaxMin"],
  ["Grocery: full marks within (min)", "groceryFullMin"], ["Grocery: zero at (min)", "groceryMaxMin"],
  ["Delivery hospital: full marks within (min)", "deliveryFullMin"], ["Delivery hospital: zero at (min)", "deliveryMaxMin"],
  ["Pediatrician: full marks within (min)", "pediatricianFullMin"], ["Pediatrician: zero at (min)", "pediatricianMaxMin"],
  ["Child care: full marks within (min)", "childcareFullMin"], ["Child care: zero at (min)", "childcareMaxMin"],
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
  const list = orderDrag.list;
  orderDrag.row.classList.remove("dragging");
  orderDrag = null;
  const keys = [...list.children].map((row) => row.dataset.key);   // the rows were moved on screen; read the new order from them
  if (list.id === "c-criteria-list") { criteriaDraft.order = keys; renderCriteriaList(); }
  else { orderDraft = keys; renderOrderList(); }
}

// The list is built each time Settings opens, so the listener sits on the window that always exists.
$("criteria-fields").addEventListener("pointerdown", (event) => {
  const grip = event.target.closest(".order-grip");
  if (!grip || event.button > 0) return;
  event.preventDefault();
  grip.setPointerCapture(event.pointerId);   // keeps the moves coming even when the pointer leaves the handle
  orderDrag = { row: grip.closest("li"), list: grip.closest("ol"), pointerId: event.pointerId };   // the report order or the criteria
  orderDrag.row.classList.add("dragging");
});

$("criteria-fields").addEventListener("pointermove", (event) => {
  if (!orderDrag || event.pointerId !== orderDrag.pointerId) return;
  const list = orderDrag.list;
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

// How many of your ticked criteria get their own column in the parcel list (after price, USDA and flood).
const LIST_CRITERIA_COLUMNS = 3;

// What each dealbreaker switch means, shown in its hover explanation.
const DEALBREAKER_RULES = {
  flood: "if the spot is in a high-risk FEMA flood zone",
  septic: "if the soil is very limited for a septic system",
  slope: "if the slope reaches the zero end of its range below",
  rain: "if rainfall is at or below the zero end of its range below",
  airport: "if the drive to the airport is longer than the dealbreaker minutes below",
  price: "if the price is at or above the zero end of its range below",
  internet: "if there is no wired or fixed wireless service, or the speed is at or below the zero end below",
  groundwater: "if the nearest well's water is at or below the zero depth below",
  hazards: "if FEMA rates the area's overall natural hazard risk Very High",
  hospital: "if the nearest emergency hospital is at or beyond the zero minutes below",
  grocery: "if the nearest supermarket is at or beyond the zero minutes below",
  agValuation: "if you entered that the land has no ag or wildlife valuation",
  delivery: "if the nearest designated delivery hospital is at or beyond the zero minutes below",
  pediatrician: "if the nearest pediatrician is at or beyond the zero minutes below",
  childcare: "if the nearest child care center or preschool is at or beyond the zero minutes below",
};

let criteriaDraft = { order: [], on: {} };   // the criteria being edited; saved with the Save button
let dealDraft = {};                          // the dealbreaker switches being edited

// "4 ticked, each counts 25% of the score".
function updateCriteriaCount() {
  const n = criteriaDraft.order.filter((key) => criteriaDraft.on[key]).length;
  $("c-criteria-count").textContent = n === 0 ? "None ticked" : `${n} ticked, each counts ${Math.round(100 / n)}% of the score`;
  $("c-criteria-count").classList.toggle("spent", n === 0);
}

function renderCriteriaList(focus) {
  const last = criteriaDraft.order.length - 1;
  $("c-criteria-list").innerHTML = criteriaDraft.order.map((key, i) => {
    const name = FACTOR_LABELS[key], on = criteriaDraft.on[key];
    return `<li data-key="${key}" class="${on ? "active" : ""}">
      <span class="order-grip" title="Drag to reorder" aria-hidden="true">&#8942;&#8942;</span>
      <input type="checkbox" data-crit="${key}" aria-label="Count ${esc(name)} in the score"${on ? " checked" : ""}>
      <span class="order-name">${helpLabel(name)}</span>
      <label class="node-deal"><input type="checkbox" data-deal="${key}"${dealDraft[key] ? " checked" : ""}> ${tipSpan("Dealbreaker", `When on, a parcel is flagged as a dealbreaker ${DEALBREAKER_RULES[key]}. This works even if the criterion is not ticked. Missing data never triggers it.`)}</label>
      <button class="btn small" type="button" data-cmove="up" data-key="${key}" aria-label="Move ${esc(name)} up"${i === 0 ? " disabled" : ""}>Up</button>
      <button class="btn small" type="button" data-cmove="down" data-key="${key}" aria-label="Move ${esc(name)} down"${i === last ? " disabled" : ""}>Down</button>
    </li>`;
  }).join("");
  updateCriteriaCount();
  if (focus) {
    const wanted = $("c-criteria-list").querySelector(`button[data-key="${focus.key}"][data-cmove="${focus.dir}"]:not(:disabled)`)
      || $("c-criteria-list").querySelector(`button[data-key="${focus.key}"]:not(:disabled)`);
    if (wanted) wanted.focus();
  }
}

function moveCriterion(key, dir) {
  const i = criteriaDraft.order.indexOf(key);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= criteriaDraft.order.length) return;
  [criteriaDraft.order[i], criteriaDraft.order[j]] = [criteriaDraft.order[j], criteriaDraft.order[i]];
  renderCriteriaList({ key, dir });
}

function showSettingsTab(name) {
  for (const tab of document.querySelectorAll("#form-criteria [data-tab]")) {
    const on = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", on ? "true" : "false");
    tab.tabIndex = on ? 0 : -1;
  }
  for (const panel of document.querySelectorAll("#criteria-fields [data-panel]")) panel.hidden = panel.dataset.panel !== name;
}

// The label for a setting's number box, from SCORING_FIELDS.
const fieldLabel = (path) => (SCORING_FIELDS.find(([, p]) => p === path) || [path])[0];

// Where a value sits on a slider, as a percent of its width (for the colored track).
const sliderPercent = (value, min, max) => (max > min ? Math.max(0, Math.min(100, (value - min) / (max - min) * 100)) : 0);

// One scoring range as a slider with two thumbs, plus its two number boxes. The left thumb and box hold the smaller
// number. For "lower is better" (price, slope, drive times) that is the full-marks end; for "higher is better"
// (rain, internet) it is the zero end. Both thumbs and boxes stay in step (see syncRangePair).
function rangePairHtml(pair) {
  const [loPath, hiPath] = pair.better === "lower" ? [pair.good, pair.bad] : [pair.bad, pair.good];
  const lo = getPath(settings, loPath), hi = getPath(settings, hiPath);
  const max = Math.max(pair.max, lo, hi);   // a saved value beyond the usual end stretches the slider
  const box = (path) => `<label>${SETTING_TIPS[path] ? tipSpan(fieldLabel(path), SETTING_TIPS[path]) : esc(fieldLabel(path))}<input data-path="${path}" inputmode="decimal" value="${esc(getPath(settings, path))}"></label>`;
  const thumb = (which, value, path) => `<input type="range" class="dual-${which}" min="${pair.min}" max="${max}" step="${pair.step}" value="${esc(value)}" aria-label="${esc(fieldLabel(path))}">`;
  const tip = `Drag the two ends. ${pair.better === "lower" ? "At or below the left end" : "At or above the right end"} scores 100 (green), ${pair.better === "lower" ? "at or above the right end" : "at or below the left end"} scores 0 (red), and values in between score evenly. You can also type exact numbers in the boxes.`;
  return `<div class="range-pair wide" data-pair="${pair.key}">
      <div class="range-head"><strong>${tipSpan(`${pair.title} (${pair.unit})`, tip)}</strong><span class="sub range-rec" data-rec="${pair.key}"></span></div>
      <div class="dual ${pair.better}" style="--lo:${sliderPercent(lo, pair.min, max)}%;--hi:${sliderPercent(hi, pair.min, max)}%">${thumb("lo", lo, loPath)}${thumb("hi", hi, hiPath)}</div>
      <div class="range-boxes">${box(loPath)}${box(hiPath)}</div>
    </div>`;
}

// Keeps a slider and its two number boxes in step after the person moved `moved` (a thumb or a box).
// The thumbs may not cross: the one being dragged pushes the other along, one step apart.
function syncRangePair(block, moved) {
  const pair = RANGE_PAIRS.find((p) => p.key === block.dataset.pair);
  const [loBox, hiBox] = block.querySelectorAll("input[data-path]");
  const [loThumb, hiThumb] = block.querySelectorAll("input[type=range]");
  let lo, hi;
  if (moved === loThumb || moved === hiThumb) {
    lo = Number(loThumb.value); hi = Number(hiThumb.value);
    if (lo > hi - pair.step) {
      if (moved === loThumb) hi = Math.min(Number(hiThumb.max), lo + pair.step); else lo = Math.max(pair.min, hi - pair.step);
      if (lo > hi - pair.step) lo = hi - pair.step;   // pushed against the end of the slider
    }
    // Round away the tiny errors that adding decimal steps can leave (0.1 + 0.2 is 0.30000000000000004 in JavaScript).
    const tidy = (v) => Math.round(v * 1000) / 1000;
    loBox.value = String(tidy(lo)); hiBox.value = String(tidy(hi));
  } else {
    lo = parseNumber(loBox.value); hi = parseNumber(hiBox.value);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;   // half-typed; the save checks it later
    const max = Math.max(pair.max, lo, hi);                      // stretch the slider to show a number beyond its end
    loThumb.max = hiThumb.max = String(max);
  }
  loThumb.value = String(lo); hiThumb.value = String(hi);
  const dual = block.querySelector(".dual");
  dual.style.setProperty("--lo", `${sliderPercent(lo, pair.min, Number(loThumb.max))}%`);
  dual.style.setProperty("--hi", `${sliderPercent(hi, pair.min, Number(hiThumb.max))}%`);
}

let usesDraft = {};   // the land uses being edited; saved with the Save button
let familyDraft = {}; // who is moving with you, being edited; saved with the Save button

// A slider value with its unit: "$100,000", "5%", "30 in/year", "45 min".
function rangeValueText(pair, value) {
  if (pair.unit === "$") return money(value);
  return pair.unit === "%" ? `${value}%` : `${value} ${pair.unit}`;
}

// Shows the recommended range under each slider for the ticked uses, and which criteria they suggest.
function updateRecommendations() {
  const recs = recommendedRanges(usesDraft);
  const any = Object.values(usesDraft).some(Boolean);
  for (const pair of RANGE_PAIRS) {
    const el = $("criteria-fields").querySelector(`[data-rec="${pair.key}"]`);
    if (!el) continue;
    const rec = recs[pair.key];
    el.textContent = rec ? `Recommended: full marks at ${rangeValueText(pair, rec[0])}, zero at ${rangeValueText(pair, rec[1])}`
      : any ? "No recommendation: set it for your own needs" : "";
  }
  const suggested = suggestedCriteria(usesDraft, familyDraft);
  const ages = Object.keys(FAMILY_STAGES).filter((key) => familyDraft[key]).map((key) => FAMILY_STAGES[key].label.toLowerCase());
  const who = [any ? usesText(usesDraft) : "", ages.join(", ")].filter(Boolean).join("; and for ");
  $("c-use-summary").textContent = who && suggested.length
    ? `For ${who}, these criteria matter most: ${suggested.map((key) => FACTOR_LABELS[key]).join(", ")}.`
    : "Tick what you plan to do and who is moving with you, and the app suggests ranges and criteria for it.";
  $("c-apply-recommended").disabled = !any;   // only land uses recommend slider values
  $("c-tick-suggested").disabled = suggested.length === 0;
}

// Moves each slider that has a recommendation to it. Nothing is saved until Save settings.
function applyRecommendations() {
  const recs = recommendedRanges(usesDraft);
  for (const [key, [good, bad]] of Object.entries(recs)) {
    const pair = RANGE_PAIRS.find((p) => p.key === key);
    const block = $("criteria-fields").querySelector(`.range-pair[data-pair="${key}"]`);
    block.querySelector(`input[data-path="${pair.good}"]`).value = String(good);
    block.querySelector(`input[data-path="${pair.bad}"]`).value = String(bad);
    syncRangePair(block, null);
  }
}

function numberBoxes(fields) {
  return fields.map(([label, path]) =>
    `<label>${SETTING_TIPS[path] ? tipSpan(label, SETTING_TIPS[path]) : esc(label)}<input data-path="${path}" inputmode="decimal" value="${esc(getPath(settings, path))}"></label>`).join("");
}

function openCriteria() {
  usesDraft = { ...DEFAULT_SETTINGS.uses, ...settings.uses };
  familyDraft = { ...DEFAULT_SETTINGS.family, ...settings.family };
  criteriaDraft = normalizeCriteria(settings.criteria);
  dealDraft = { ...settings.dealbreakers };
  $("criteria-fields").innerHTML = `
    <div class="tab-panel" id="panel-scoring" role="tabpanel" aria-labelledby="tab-scoring" data-panel="scoring">
      <div class="stack uses-block">
        <strong>${tipSpan("What will you use the land for?", "Tick one or more. The app then suggests ranges for the sliders below and criteria worth ticking. They are rules of thumb for screening, not standards, and nothing changes until you press a button below and then Save settings.")}</strong>
        <div class="use-list">${Object.entries(LAND_USES).map(([key, use]) => `<label class="check"><input type="checkbox" data-use="${key}"${usesDraft[key] ? " checked" : ""}> ${tipSpan(use.label, use.tip)}</label>`).join("")}</div>
        <strong>${tipSpan("Who is moving with you?", "Tick every age that applies. Each report then gets a Family needs section with the places that matter at those ages (delivery hospitals, doctors, child care, schools, libraries) and what to know, and the criteria worth ticking are suggested below. Places are only looked up for the ages you tick.")}</strong>
        <div class="use-list">${Object.entries(FAMILY_STAGES).map(([key, stage]) => `<label class="check"><input type="checkbox" data-family="${key}"${familyDraft[key] ? " checked" : ""}> ${tipSpan(stage.label, stage.tip)}</label>`).join("")}</div>
        <p class="hint" id="c-use-summary" role="status"></p>
        <div class="bar-group"><button class="btn small" type="button" id="c-apply-recommended">Use recommended values</button><button class="btn small" type="button" id="c-tick-suggested">Tick suggested criteria</button></div>
      </div>
      <div class="stack">
        <div class="tree-head"><strong>${tipSpan("Your criteria", "Tick what matters to you. Every ticked criterion counts the same toward the 0 to 100 score. The order is the order they appear in each report's summary, in the list columns and in the compare table.")}</strong><span class="points-left" id="c-criteria-count" role="status"></span></div>
        <p class="hint">Tick the criteria that matter most to you. Each ticked one counts the same, and one with no data for a parcel is skipped, not counted as zero. Drag a row by the dots on its left, or use Up and Down, to set the order they are shown in. The first ${LIST_CRITERIA_COLUMNS} (besides price and flood) also become columns in the parcel list. Turn on Dealbreaker to rule a parcel out completely when that criterion is at its worst.</p>
        <ol class="order-list crit-list" id="c-criteria-list"></ol>
      </div>
      <div class="fields">
        <p class="hint wide">These ranges are starting points, not rules. Rainfall, price and slope that count as good vary a lot across the US (for example, 15 inches of rain a year is dry in Georgia but normal in Nevada), so set them for the region you are searching.</p>
        ${RANGE_PAIRS.map(rangePairHtml).join("")}
        ${numberBoxes(SCORING_FIELDS.filter(([, path]) => !RANGE_PAIRS.some((p) => p.good === path || p.bad === path)))}
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
        <label class="wide">Crime data key (optional and free; lets the app show crime reported by the county sheriff to the FBI)
          <input id="c-crime-key" value="${esc(settings.crimeKey)}" autocomplete="off" placeholder="Paste your api.data.gov key here"></label>
        <p class="hint wide key-help">No key yet? <a id="c-crime-key-link" href="${CRIME_KEY_SIGNUP_URL}" target="_blank" rel="noopener noreferrer">Get a free api.data.gov key</a>. It opens in a new tab, and the key is emailed to you. Paste it above, press Save settings, then Refresh data on a parcel.</p>
        <p class="hint wide key-help">No key yet? <a id="c-census-key-link" href="${CENSUS_KEY_SIGNUP_URL}" target="_blank" rel="noopener noreferrer">Get a free Census API key</a>. It opens in a new tab, and the Census emails the key to you. Paste it above, press Save settings, then Refresh data on a parcel.</p>
        <label class="check wide"><input type="checkbox" id="c-use-county-tax" ${settings.costs.useCountyTax !== false ? "checked" : ""}> Use the county's typical tax rate when it is known (otherwise use the rate above)</label>
      </div>
    </div>
    <div class="tab-panel" id="panel-layout" role="tabpanel" aria-labelledby="tab-layout" data-panel="layout" hidden>
      <div class="stack" id="c-order-block">
        <strong>Order of the report sections</strong>
        <p class="hint">The score and the summary of your criteria always come first, and the data sources and your notes always come last. Drag a row by the dots on its left, or use Up and Down, to arrange everything between them. The report groups sections into collapsible categories (shown at the right of each row). Inside a category the sections follow this order, and the category that holds your first section comes first. The change applies to the report on screen and to the printout.</p>
        <ol class="order-list" id="c-order-list"></ol>
        <div><button class="btn small" type="button" id="c-order-reset">Reset to the default order</button></div>
      </div>
    </div>`;
  renderCriteriaList();
  updateRecommendations();
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
  if (!criteriaDraft.order.some((key) => criteriaDraft.on[key])) {
    settingsError("Tick at least one criterion, or every parcel would have no score.", $("c-criteria-list"));
    return;
  }
  next.criteria = normalizeCriteria(criteriaDraft);
  next.uses = { ...usesDraft };
  next.family = { ...familyDraft };
  next.dealbreakers = { ...dealDraft };
  const ranges = [["deliveryFullMin", "deliveryMaxMin"], ["pediatricianFullMin", "pediatricianMaxMin"], ["childcareFullMin", "childcareMaxMin"], ["priceTarget", "priceMax"], ["slopeIdeal", "slopeMax"], ["rainFull", "rainZero"], ["airportFullMin", "airportMaxMin"],
    ["internetFullMbps", "internetZeroMbps"], ["groundwaterFullFt", "groundwaterZeroFt"], ["hospitalFullMin", "hospitalMaxMin"], ["groceryFullMin", "groceryMaxMin"]];
  if (ranges.some(([a, b]) => next[a] === next[b])) {
    settingsError("The two ends of each range must be different numbers.", $("c-criteria-list"));
    return;
  }
  next.censusKey = $("c-census-key").value.trim();
  next.crimeKey = $("c-crime-key").value.trim();
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
  $("compare-hint").textContent = 'Tick two or three addresses in the "Pick" column to compare them side by side.';
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
  else if (el.dataset.refresh) refreshParcel(el.dataset.refresh, el.dataset.mode);
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
// "None of these" and the exemptions cannot both be ticked: ticking one side clears the other.
$("form-add").addEventListener("change", (event) => {
  if (event.target.id === "f-ex-none" && event.target.checked) for (const key of ["ag", "wildlife", "homestead"]) $(`f-ex-${key}`).checked = false;
  else if (/^f-ex-(ag|wildlife|homestead)$/.test(event.target.id) && event.target.checked) $("f-ex-none").checked = false;
});
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
// Dragging a thumb or typing in a box moves its partner.
$("criteria-fields").addEventListener("input", (event) => {
  const block = event.target.closest(".range-pair");
  if (block) syncRangePair(block, event.target);
});
$("criteria-fields").addEventListener("click", (event) => {
  if (event.target.id === "c-apply-recommended") { applyRecommendations(); return; }
  if (event.target.id === "c-tick-suggested") {
    for (const key of suggestedCriteria(usesDraft, familyDraft)) criteriaDraft.on[key] = true;
    renderCriteriaList();
    return;
  }
  const cmove = event.target.closest("[data-cmove]");
  if (cmove) { moveCriterion(cmove.dataset.key, cmove.dataset.cmove); return; }
  const move = event.target.closest("[data-move]");
  if (move) { moveSection(move.dataset.key, move.dataset.move); return; }
  if (event.target.id === "c-order-reset") { orderDraft = normalizeReportOrder([]); renderOrderList(); }
});
// Choosing a preset airport adds its line to the text box.
$("criteria-fields").addEventListener("change", (event) => {
  if (event.target.dataset.deal) { dealDraft[event.target.dataset.deal] = event.target.checked; return; }
  if (event.target.dataset.use) { usesDraft[event.target.dataset.use] = event.target.checked; updateRecommendations(); return; }
  if (event.target.dataset.family) { familyDraft[event.target.dataset.family] = event.target.checked; updateRecommendations(); return; }
  if (event.target.dataset.crit) {
    criteriaDraft.on[event.target.dataset.crit] = event.target.checked;
    event.target.closest("li").classList.toggle("active", event.target.checked);
    updateCriteriaCount();
    return;
  }
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
  const keptKey = settings.censusKey, keptCrimeKey = settings.crimeKey;   // resetting the criteria should not throw away your keys
  settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  settings.censusKey = keptKey;
  settings.crimeKey = keptCrimeKey;
  writeStored(SETTINGS_KEY, settings);
  recomputeAirports();
  $("dlg-criteria").close();
  renderAll();
});
// Clear addresses and Clear data each take two clicks, like Delete: the first click asks, the second does it,
// and the question goes away by itself after 5 seconds.
function twoClickButton(id, question, onConfirm) {
  const button = $(id);
  const label = button.textContent;
  let timer = null;
  const reset = () => { clearTimeout(timer); button.textContent = label; button.classList.remove("armed"); };
  button.addEventListener("click", () => {
    if (!button.classList.contains("armed")) {
      clearTimeout(timer);
      button.textContent = question;
      button.classList.add("armed");
      timer = setTimeout(reset, 5000);
      return;
    }
    reset();
    onConfirm();
  });
}
// Clear addresses removes only the saved addresses; your keys, criteria and other settings stay.
twoClickButton("btn-clear-addresses", "Remove all addresses? Click again", () => {
  clearParcels();
  compareIds = [];
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  renderAll();
  $("status").hidden = false;
  $("status").innerHTML = "<strong>All saved addresses were removed.</strong> Your API keys, criteria and other settings were kept.";
  clearProgress(10000);
});
// Clear data erases everything saved in this browser.
twoClickButton("btn-clear", "Erase everything? Click again", () => {
  clearAllData();
  compareIds = [];
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
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
$("filter-status").value = view.status;
$("hide-dealbreakers").checked = view.hideDealbreakers;
function viewChanged() {
  changeView({ sort: $("sort-by").value, status: $("filter-status").value, hideDealbreakers: $("hide-dealbreakers").checked });
}
for (const id of ["sort-by", "filter-status", "hide-dealbreakers"]) $(id).addEventListener("change", viewChanged);
// The Columns menu: ticking a criterion adds its column, unticking removes it.
$("col-menu").addEventListener("change", (event) => {
  const box = event.target.closest("[data-col]");
  if (!box) return;
  const shown = new Set(listColumns());
  if (box.checked) shown.add(box.dataset.col); else shown.delete(box.dataset.col);
  changeView({ columns: COLUMN_CHOICES().filter((key) => shown.has(key)) });
  $("col-picker").open = true;   // redrawing the list keeps the menu open so several can be changed in a row
});
// A tap or click outside the Columns menu closes it.
document.addEventListener("click", (event) => { if (!event.target.closest("#col-picker")) $("col-picker").open = false; });
// A sort button in a column heading.
$("list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-sort-key]");
  if (!button) return;
  event.stopPropagation();   // the heading is not a parcel row, but keep the click from doing anything else
  const key = button.dataset.sortKey;
  changeView({ sort: view.sort === `crit:${key}:asc` ? `crit:${key}:desc` : `crit:${key}:asc` });
});
// The value filter. A criterion with no number typed yet filters nothing.
$("filter-crit").addEventListener("change", () => {
  const key = $("filter-crit").value;
  changeView({ filter: key ? { key, op: view.filter ? view.filter.op : "max", value: null } : null });
  if (key) $("filter-value").focus();
});
$("filter-op").addEventListener("change", () => changeView({ filter: { ...view.filter, op: $("filter-op").value } }));
$("filter-value").addEventListener("input", () => {
  const value = parseNumber($("filter-value").value);
  view = { ...view, filter: { ...view.filter, value: Number.isFinite(value) ? value : null } };
  writeStored(VIEW_KEY, view);
  // Only the list redraws while typing, so the box keeps its focus and caret.
  const items = ranked();
  renderList(items);
  drawMarkers(items);
  renderFilterHint(items.length);
});
$("filter-clear").addEventListener("click", () => changeView({ filter: null }));

$("app-version").textContent = versionText(APP_VERSION, APP_UPDATED);
initMap();
renderAll();
applyStaticTips();
if (!storageOk) $("storage-warning").hidden = false;
