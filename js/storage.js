"use strict";

/* =====================================================================
   5. Saving in this browser (localStorage)
   ===================================================================== */
const PARCELS_KEY = "homestead-screener.parcels.v1";
const SETTINGS_KEY = "homestead-screener.settings.v1";
const VIEW_KEY = "homestead-screener.view.v1";
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

function loadSettings() {
  const saved = readStored(SETTINGS_KEY, {});
  return {
    ...DEFAULT_SETTINGS, ...saved,
    weights: { ...DEFAULT_SETTINGS.weights, ...(saved.weights || {}) },
    costs: { ...DEFAULT_SETTINGS.costs, ...(saved.costs || {}) },
    huntingCounties: Array.isArray(saved.huntingCounties) ? saved.huntingCounties : [],
    censusKey: typeof saved.censusKey === "string" ? saved.censusKey : "",
    // Your own airport list is only used if you chose "custom" and the list is not empty.
    airports: Array.isArray(saved.airports) ? saved.airports : [],
    airportMode: saved.airportMode === "custom" && Array.isArray(saved.airports) && saved.airports.length ? "custom" : "auto",
  };
}

function loadView() {
  const saved = readStored(VIEW_KEY, {});
  const view = { ...DEFAULT_VIEW, ...saved };
  if (!SORTS[view.sort]) view.sort = DEFAULT_VIEW.sort;   // ignore a sort name we no longer have
  return view;
}

let settings = loadSettings();
let view = loadView();
let parcels = readStored(PARCELS_KEY, []);
if (!Array.isArray(parcels)) parcels = [];

const saveParcels = () => writeStored(PARCELS_KEY, parcels);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
