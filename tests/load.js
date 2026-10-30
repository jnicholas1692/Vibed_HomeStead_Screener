// Loads the plain browser scripts into an isolated sandbox so Node can test them.
// The scripts are written for the browser, so there is nothing to import or export.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadScripts(names, extraGlobals = {}) {
  // Give the sandbox only the few browser features the scripts use.
  const sandbox = vm.createContext({
    AbortController, URLSearchParams, setTimeout, clearTimeout, ...extraGlobals,
  });
  for (const name of names) {
    const file = path.join(__dirname, "..", "js", name);
    vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
  }
  // get("scoreParcel") reads one function or constant out of the sandbox.
  return { get: (expression) => vm.runInContext(expression, sandbox) };
}

// Values made inside the sandbox have their own object types, so copy them
// into ordinary objects before comparing.
const plain = (value) => JSON.parse(JSON.stringify(value));

// A stand-in for fetch(): `routes` maps a piece of the URL to the reply text.
function fakeFetch(routes) {
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const key = Object.keys(routes).find((part) => String(url).includes(part));
    if (!key) throw new Error("No fake reply for " + url);
    const reply = routes[key];
    return { ok: reply.status === undefined || reply.status < 400, status: reply.status ?? 200, text: async () => reply.body, json: async () => JSON.parse(reply.body) };
  };
  fetchFn.calls = calls;
  return fetchFn;
}

module.exports = { loadScripts, plain, fakeFetch };
