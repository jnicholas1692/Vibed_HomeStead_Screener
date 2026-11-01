"use strict";

/* =====================================================================
   5. Saving in this browser (localStorage)
   ===================================================================== */
const PARCELS_KEY = "homestead-screener.parcels.v1";
const SETTINGS_KEY = "homestead-screener.settings.v1";
const VIEW_KEY = "homestead-screener.view.v1";
const GROUPS_KEY = "homestead-screener.closed-groups.v1";   // which report categories are collapsed
let storageOk = true;

function readStored(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    storageOk = true;
  } catch {
    storageOk = false;
  }
  document.getElementById("storage-warning").hidden = storageOk;
}

// Older versions saved the down payment as a percent. Turn it into dollars once, using the price target.
function migrateCosts(costs, saved) {
  const old = saved.costs || {};
  if (old.downPayment === undefined && Number.isFinite(old.downPct)) {
    costs.downPayment = Math.round((saved.priceTarget ?? DEFAULT_SETTINGS.priceTarget) * old.downPct / 100);
  }
  delete costs.downPct;
  return costs;
}

// Your criteria. Settings saved before v2.3.0 have skill-tree points instead (and before v2.0.0, weights like
// flood 25, septic 15). Those are turned into criteria once: a factor with points is ticked, more points come first.
function loadCriteria(saved) {
  if (saved.criteria && typeof saved.criteria === "object") return normalizeCriteria(saved.criteria);
  if (saved.points && typeof saved.points === "object") return criteriaFromPoints(normalizePoints(saved.points));
  if (saved.weights && typeof saved.weights === "object") {
    const { flood, hunting, ...rest } = saved.weights;     // flood was not scored then, and hunting was removed
    return criteriaFromPoints(normalizePoints(pointsFromWeights({ ...OLD_DEFAULT_POINTS, ...rest }, POINT_BUDGET)));
  }
  return normalizeCriteria(DEFAULT_SETTINGS.criteria);
}

function onlyBooleans(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj && typeof obj === "object" ? obj : {})) if (typeof v === "boolean") out[k] = v;
  return out;
}

function loadSettings() {
  const saved = readStored(SETTINGS_KEY, {});
  return {
    ...DEFAULT_SETTINGS, ...saved, weights: undefined, points: undefined,
    criteria: loadCriteria(saved),
    uses: { ...DEFAULT_SETTINGS.uses, ...onlyBooleans(saved.uses) },
    family: { ...DEFAULT_SETTINGS.family, ...onlyBooleans(saved.family) },
    dealbreakers: { ...DEFAULT_SETTINGS.dealbreakers, ...onlyBooleans(saved.dealbreakers) },
    costs: migrateCosts({ ...DEFAULT_SETTINGS.costs, ...(saved.costs || {}) }, saved),
    reportOrder: normalizeReportOrder(saved.reportOrder),
    huntingCounties: undefined,                     // removed in v2.1.0; old saved lists are ignored
    censusKey: typeof saved.censusKey === "string" ? saved.censusKey : "",
    crimeKey: typeof saved.crimeKey === "string" ? saved.crimeKey : "",
    // Your own airport list is only used if you chose "custom" and the list is not empty.
    airports: Array.isArray(saved.airports) ? saved.airports : [],
    airportMode: saved.airportMode === "custom" && Array.isArray(saved.airports) && saved.airports.length ? "custom" : "auto",
  };
}

function loadView() {
  const saved = readStored(VIEW_KEY, {});
  const view = { ...DEFAULT_VIEW, ...saved };
  if (!isKnownSort(view.sort)) view.sort = DEFAULT_VIEW.sort;   // ignore a sort name we no longer have
  view.columns = Array.isArray(view.columns) ? view.columns.filter((key) => FACTOR_LABELS[key]) : null;
  const f = view.filter;
  view.filter = f && FACTOR_LABELS[f.key] && (f.op === "max" || f.op === "min")
    ? { key: f.key, op: f.op, value: Number.isFinite(f.value) ? f.value : null } : null;
  return view;
}

let settings = loadSettings();
let view = loadView();
let parcels = readStored(PARCELS_KEY, []);
if (!Array.isArray(parcels)) parcels = [];

// Before v2.10.0 a children's dentist could be saved as the nearest pediatrician. Only the name was kept, so a saved
// one whose name sounds like a dentist is forgotten; Refresh data then looks the pediatrician up again.
const DENTIST_NAME = /dent|orthodon|teeth|tooth|smile/i;   // "dent" also catches Dental, Dentistry and Dentist
function forgetDentistPediatricians(list) {
  for (const parcel of list) {
    const places = parcel && parcel.site && parcel.site.places;
    if (places && places.pediatrician && DENTIST_NAME.test(places.pediatrician.name || "")) delete places.pediatrician;
  }
  return list;
}
forgetDentistPediatricians(parcels);

const saveParcels = () => writeStored(PARCELS_KEY, parcels);

// Erases everything this app saved in this browser (parcels, criteria, list view) and starts again from the defaults.
function clearAllData() {
  for (const key of [PARCELS_KEY, SETTINGS_KEY, VIEW_KEY, GROUPS_KEY, OVERPASS_MEMORY_KEY]) {
    try { localStorage.removeItem(key); } catch { /* storage is blocked, so there is nothing saved to remove */ }
  }
  parcels = [];
  settings = loadSettings();
  view = loadView();
}
// Removes every saved address (parcel) but keeps your settings, including the Census and api.data.gov keys.
function clearParcels() {
  parcels = [];
  saveParcels();
}
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
