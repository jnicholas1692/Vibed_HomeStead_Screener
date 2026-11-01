"""Browser tests for the Homestead Land Screener.

The Node tests (npm test) check the scoring and the parsers. This script checks what only a real
browser can: the page loads, the dialogs work, the report fills in, failures stay contained,
owner details never appear, every label has hover help, and settings survive a reload.

Every outside data service is replaced by a fake answer, so the tests run the same way every time
and never touch the real services. A few core services get realistic answers; the rest fail on
purpose to prove one broken service cannot break the report. Leaflet (the map library) is still
loaded from unpkg, so the machine needs an internet connection for the map.

Needs Python 3.9+ and Playwright:
    python -m pip install playwright
    python -m playwright install chromium

Run from the project folder:
    python test_site.py            (add --headed to watch the browser)

It serves the site itself on http://127.0.0.1:8765, so that port must be free.
Exits with code 1 if any check fails.
"""

import functools
import http.server
import json
import pathlib
import re
import socket
import sys
import threading
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent
PORT = 8765
SITE = f"http://127.0.0.1:{PORT}/"

# A spot in Blanco County, Texas, used for the parcels added in the tests.
LAT, LON = 30.275, -98.4

# Owner details the fake Texas parcel service sends. None of them may ever reach the page or storage.
SECRETS = ["SECRET OWNER", "1 PRIVATE RD", "99 SECRET LANE"]

# A made-up Census key. The tests check it is only ever sent to the Census.
FAKE_CENSUS_KEY = "TESTKEY0123456789"

# A made-up api.data.gov key for the FBI crime figures. The tests check it is only ever sent to api.usa.gov.
FAKE_CRIME_KEY = "CRIMEKEY0123456789"

# Every outside host the app is allowed to talk to. A request to anything else fails a check.
ALLOWED_HOSTS = {
    "unpkg.com", "tile.openstreetmap.org",
    "geocoding.geo.census.gov", "photon.komoot.io", "hazards.fema.gov", "epqs.nationalmap.gov",
    "sdmdataaccess.sc.egov.usda.gov", "archive-api.open-meteo.com", "geo.fcc.gov", "opendata.fcc.gov",
    "overpass-api.de", "overpass.openstreetmap.fr", "overpass.kumi.systems", "overpass.private.coffee",
    "router.project-osrm.org", "services.arcgis.com", "services5.arcgis.com", "phzmapi.org",
    "api.census.gov", "fwspublicservices.wim.usgs.gov", "rdgdwe.sc.egov.usda.gov",
    "api.waterdata.usgs.gov", "api.weather.gov", "power.larc.nasa.gov", "echodata.epa.gov",
    "feature.geographic.texas.gov", "services.twdb.texas.gov", "gis.rrc.texas.gov", "www.fema.gov",
    "tigerweb.geo.census.gov", "api.censusreporter.org", "api.usa.gov", "www.arcgis.com", "services3.arcgis.com",
}

# The smallest valid PNG (one clear pixel), handed back for map tiles.
BLANK_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082"
)


# ---------------------------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------------------------
# Windows consoles cannot print every character (like the sort arrows), so print what they can instead of crashing.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

passed, failed = [], []


def check(name, ok, detail=""):
    """Records one check and prints it as it happens."""
    if ok:
        passed.append(name)
        print(f"  ok    {name}")
    else:
        failed.append(f"{name}{': ' + detail if detail else ''}")
        print(f"  FAIL  {name}{': ' + detail if detail else ''}")


def section(title):
    print(f"\n{title}")


# ---------------------------------------------------------------------------------------------
# A small web server for the site's own files
# ---------------------------------------------------------------------------------------------
class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass   # keep the test output readable


def start_server():
    # Fail early with a clear message if something (often an old test run) still holds the port.
    with socket.socket() as probe:
        if probe.connect_ex(("127.0.0.1", PORT)) == 0:
            sys.exit(f"Port {PORT} is already in use. Stop whatever is using it and run the tests again.")
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


# ---------------------------------------------------------------------------------------------
# Fake data services
# ---------------------------------------------------------------------------------------------
def feature(attributes):
    return {"attributes": attributes}


def jsonp_reply(url, data):
    """The Census geocoder is called with JSONP: the reply is a script that calls the named function."""
    callback = parse_qs(urlparse(url).query).get("callback", ["callback"])[0]
    return {"status": 200, "content_type": "application/javascript", "body": f"{callback}({json.dumps(data)});"}


def json_reply(data, status=200):
    return {"status": status, "content_type": "application/json", "body": json.dumps(data),
            "headers": {"Access-Control-Allow-Origin": "*"}}


def elevation_reply(url):
    # The center point is 1200 ft and the four points 60 m away are 1206 ft,
    # so the slope is 6 ft (1.83 m) over 60 m, about 3%.
    q = parse_qs(urlparse(url).query)
    x, y = float(q["x"][0]), float(q["y"][0])
    at_center = abs(x - LON) < 1e-9 and abs(y - LAT) < 1e-9
    return json_reply({"value": 1200 if at_center else 1206})


def soil_reply(post_body):
    # Soil Data Access answers several different questions at one address. Only the basic soil
    # question gets an answer; the soil-detail questions get an empty table (no data).
    if "septic_rating" in (post_body or ""):
        return json_reply({"Table": [["soil_name", "drainage_class", "septic_rating"],
                                     ["Krum silty clay, 1 to 3 percent slopes", "Well drained", "Somewhat limited"]]})
    return json_reply({"Table": []})


def fake_service(url, post_body, mode):
    """Returns the fake reply for one outside request, or None to let it through (only for unpkg)."""
    host = urlparse(url).hostname or ""
    if host == "unpkg.com":
        return None
    if host.endswith("tile.openstreetmap.org"):
        return {"status": 200, "content_type": "image/png", "body": BLANK_PNG}
    if mode == "all_fail":
        # Every data service is down. The geocoder is a script tag, so it fails as a script would.
        return {"status": 503, "content_type": "text/plain", "body": "Service unavailable"}

    if "geocoding.geo.census.gov/geocoder/geographies" in url:
        return jsonp_reply(url, {"result": {"geographies": {
            "Counties": [{"NAME": "Blanco County", "STATE": "48", "COUNTY": "031"}],
            "States": [{"STUSAB": "TX", "STATE": "48"}],
            "Census Tracts": [{"GEOID": "48031950101", "NAME": "Census Tract 9501.01"}]}}})
    if "geocoding.geo.census.gov/geocoder/locations" in url:
        address = parse_qs(urlparse(url).query).get("address", [""])[0]
        matches = [] if "nowhere" in address.lower() else [
            {"coordinates": {"x": LON, "y": LAT}, "matchedAddress": "100 MAIN ST, BLANCO, TX, 78606"}]
        return jsonp_reply(url, {"result": {"addressMatches": matches}})
    if host == "photon.komoot.io":
        return json_reply({"features": [{
            "geometry": {"coordinates": [LON, LAT]},
            "properties": {"countrycode": "US", "housenumber": "100", "street": "Main Street",
                           "city": "Blanco", "state": "Texas", "postcode": "78606"}}]})
    if host == "www.arcgis.com" and "/content/items/" in url:
        # The DSHS map: its layer list, from which the app finds the current maternal and neonatal layers.
        return json_reply({"operationalLayers": [
            {"title": "Maternal Designated Hospitals _ Test", "url": "https://services3.arcgis.com/test/arcgis/rest/services/Maternal_Test/FeatureServer/0"},
            {"title": "Neonatal Designated Hospitals _ Test", "url": "https://services3.arcgis.com/test/arcgis/rest/services/Neonatal_Test/FeatureServer/1"}]})
    if host == "services3.arcgis.com" and "/query" in url:
        level = "II - Specialty Care" if "Maternal" in url else "I - Well Care"
        def hospital(name, city, x, y):
            return {"attributes": {"USER_Primary_Name": name, "USER_Main_City": city, "USER_Designate_Level": level}, "geometry": {"x": x, "y": y}}
        return json_reply({"features": [
            hospital("METHODIST HOSPITAL HILL COUNTRY", "FREDERICKSBURG", -98.881, 30.2619),
            hospital("BAYLOR SCOTT & WHITE MEDICAL CENTER - MARBLE FALLS", "MARBLE FALLS", -98.305, 30.5115)]})
    if host == "api.censusreporter.org":
        # Census survey tables for the tract and the county (a few of the real Blanco County figures).
        def place(pop, income):
            return {"B01003": {"estimate": {"B01003001": pop}}, "B19013": {"estimate": {"B19013001": income}},
                    "B17001": {"estimate": {"B17001001": pop, "B17001002": pop // 10}}}
        return json_reply({"release": {"name": "ACS 2024 5-year", "years": "2020-2024"},
                           "data": {"14000US48031950101": place(2613, 63500), "05000US48031": place(12446, 92425)}})
    if host == "api.usa.gov" and "/agency/byStateAbbr/TX" in url:
        return json_reply({"BLANCO": [
            {"ori": "TX0160100", "agency_name": "Blanco Police Department", "agency_type_name": "City", "state_name": "Texas"},
            {"ori": "TX0160000", "agency_name": "Blanco County Sheriff's Office", "agency_type_name": "County", "state_name": "Texas"}]})
    if host == "api.usa.gov" and "/summarized/agency/TX0160000/" in url:
        # Twelve months: 1 violent or 3 property offenses a month, for 9,520 people.
        per_month = 1 if "/V?" in url else 3
        months = [f"{m:02d}-{int(parse_qs(urlparse(url).query)['from'][0][3:])}" for m in range(1, 13)]
        name = "Blanco County Sheriff's Office"
        return json_reply({"offenses": {
            "actuals": {f"{name} Offenses": {m: per_month for m in months}},
            "rates": {"Texas Offenses": {m: 30 if per_month == 1 else 170 for m in months},
                      "United States Offenses": {m: 28 if per_month == 1 else 140 for m in months}}},
            "populations": {"population": {name: {m: 9520 for m in months}}}})
    if host == "tigerweb.geo.census.gov":
        # The Census TIGER roads, the first backup when the OpenStreetMap servers (all down in this test) fail.
        road = {"attributes": {"NAME": "E Main St", "MTFCC": "S1200"},
                "geometry": {"paths": [[[LON - 0.001, LAT + 0.0005], [LON + 0.001, LAT + 0.0005]]]}}
        return json_reply({"features": [road] if "/MapServer/6/" in url else []})
    if host == "www.fema.gov":
        # OpenFEMA disaster declarations for the county (two disasters, one listed twice).
        return json_reply({"DisasterDeclarationsSummaries": [
            {"disasterNumber": 3649, "declarationDate": "2026-07-18T00:00:00.000Z", "incidentType": "Flood", "declarationType": "EM"},
            {"disasterNumber": 4705, "declarationDate": "2023-04-21T00:00:00.000Z", "incidentType": "Winter Storm", "declarationType": "DR"},
            {"disasterNumber": 3649, "declarationDate": "2026-07-18T00:00:00.000Z", "incidentType": "Flood", "declarationType": "EM"}]})
    if "National_Risk_Index_Census_Tracts" in url:
        return json_reply({"features": [feature({
            "RISK_RATNG": "Relatively Moderate", "TRND_RISKR": "Relatively High", "HAIL_RISKR": "Relatively Moderate",
            "SOVI_RATNG": "Relatively High", "RESL_RATNG": "Relatively Moderate"})]})
    if host == "hazards.fema.gov":
        return json_reply({"features": [feature({"FLD_ZONE": "X", "ZONE_SUBTY": "AREA OF MINIMAL FLOOD HAZARD"})]})
    if host == "epqs.nationalmap.gov":
        return elevation_reply(url)
    if host == "sdmdataaccess.sc.egov.usda.gov":
        return soil_reply(post_body)

    # Texas services, shaped like the fixtures in tests/texas.test.js.
    if host == "feature.geographic.texas.gov":
        # A small square parcel around the test spot, as the identify request returns it (longitude first).
        ring = [[LON - 0.002, LAT - 0.002], [LON + 0.002, LAT - 0.002], [LON + 0.002, LAT + 0.002], [LON - 0.002, LAT + 0.002], [LON - 0.002, LAT - 0.002]]
        return json_reply({"results": [{"geometry": {"rings": [ring], "spatialReference": {"wkid": 4326}}, **feature({
            "PROP_ID": "R123", "LEGAL_AREA": "10.5", "LGL_AREA_UNIT": "Null", "GIS_AREA": "10.4",
            "LAND_VALUE": "21000", "IMP_VALUE": "50000", "MKT_VALUE": "71000", "COUNTY": "Blanco",
            "TAX_YEAR": "2025", "STAT_LAND_USE": "Null", "LOC_LAND_USE": "Ranch land", "YEAR_BUILT": "1998",
            "OWNER_NAME": SECRETS[0], "MAIL_ADDR": SECRETS[1], "SITUS_ADDR": SECRETS[2]})}]})
    if "GroundWaterConservationDistricts" in url:
        return json_reply({"features": [feature({"DistrictName": "Blanco-Pedernales GCD"})]})
    if "TEA_TX_School_Districts" in url:
        return json_reply({"features": [feature({"NAME": "Blanco ISD", "NAME2": "Blanco"})]})
    if "TWDB_Groundwater_database" in url:
        return json_reply({"features": [feature({"WellDepth": 300, "AquiferCodeName": "218TRNT - Trinity"}),
                                        feature({"WellDepth": 100, "AquiferCodeName": "218TRNT - Trinity"})]})
    if "MapServer/13/query" in url and host == "gis.rrc.texas.gov":
        return json_reply({"features": [feature({"OPERATOR": "ACME PIPELINE", "COMMODITY_DESCRIPTION": "Natural Gas"})]})
    if "MapServer/1/query" in url and host == "gis.rrc.texas.gov":
        return json_reply({"count": 4})
    if "ed_aq_recharge_zone" in url:
        return json_reply({"features": []})

    # Everything else (rain, internet, places, routes, hazards, wetlands and so on) is down on purpose.
    return {"status": 503, "content_type": "text/plain", "body": "Service unavailable",
            "headers": {"Access-Control-Allow-Origin": "*"}}


class Browser:
    """One fresh browser profile with the fake services plugged in, and a record of every outside request."""

    def __init__(self, playwright, mode="happy", headed=False, viewport=None, touch=False):
        self.mode = mode
        self.requests = []      # every URL the page asked for outside this site
        self.page_errors = []   # JavaScript errors the page threw
        self.browser = playwright.chromium.launch(headless=not headed)
        # touch=True acts like a phone: a touch screen, and taps instead of mouse clicks.
        self.context = self.browser.new_context(viewport=viewport or {"width": 1280, "height": 900}, accept_downloads=True,
                                                has_touch=touch, is_mobile=touch)
        self.context.route("**/*", self._route)
        self.page = self.context.new_page()
        self.page.on("pageerror", lambda error: self.page_errors.append(str(error)))
        self.page.goto(SITE)
        self.page.wait_for_load_state("networkidle")

    def _route(self, route):
        url = route.request.url
        if url.startswith(SITE):
            return route.continue_()
        self.requests.append(url)
        reply = fake_service(url, route.request.post_data, self.mode)
        if reply is None:
            return route.continue_()
        route.fulfill(status=reply["status"], content_type=reply["content_type"],
                      body=reply["body"], headers=reply.get("headers"))

    def close(self):
        self.browser.close()


# ---------------------------------------------------------------------------------------------
# Small helpers for the page
# ---------------------------------------------------------------------------------------------
def config_value(name):
    """Reads a simple text constant, like APP_VERSION = "2.2.0", out of js/config.js."""
    text = (ROOT / "js" / "config.js").read_text(encoding="utf-8")
    match = re.search(rf'^const {name} = "([^"]*)"', text, re.M)
    return match.group(1) if match else None


def open_settings(page, tab="scoring"):
    page.click("#btn-criteria")
    page.click(f"#tab-{tab}")


def save_settings(page):
    page.click("#form-criteria button[type=submit]")


def add_parcel(page, name="Test parcel", lat=LAT, lon=LON, acres="10", price="95000", address=""):
    """Fills the Add window and saves it. Leave lat and lon as "" to look up the address instead."""
    page.click("#btn-add")
    page.fill("#f-name", name)
    if address:
        page.fill("#f-address", address)
    page.fill("#f-lat", str(lat))
    page.fill("#f-lon", str(lon))
    page.fill("#f-acres", acres)
    page.fill("#f-price", price)
    page.click("#btn-save")


def wait_for_report(page, timeout=30000):
    """Waits until the report is open and every lookup has finished."""
    page.wait_for_selector("#dlg-detail[open] #detail-title", timeout=timeout)
    page.wait_for_function(
        "() => !document.querySelector('#detail').textContent.includes('Looking up data:')", timeout=timeout)


def stored_text(page):
    """Everything the app saved in this browser, as one piece of text."""
    return page.evaluate("() => Object.keys(localStorage).map((k) => k + '=' + localStorage.getItem(k)).join('\\n')")


def close_dialog(page, dialog_id):
    page.click(f"#{dialog_id}[open] [data-close]")


# ---------------------------------------------------------------------------------------------
# The tests
# ---------------------------------------------------------------------------------------------
def test_page_and_footer(b):
    section("Page, footer and header")
    page = b.page
    check("page title", page.title() == "Homestead Land Screener", page.title())
    check("the map library loaded", page.is_hidden("#map-warning"))
    version, updated = config_value("APP_VERSION"), config_value("APP_UPDATED")
    package_version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
    check("config.js version matches package.json", version == package_version, f"{version} vs {package_version}")
    footer = page.text_content("#app-version") or ""
    check("footer shows the version", f"Version {version}," in footer, footer)
    year, month, day = (int(part) for part in updated.split("-"))
    check("footer shows the update date without slipping a day", f"{day}, {year}" in footer, footer)
    page.hover("#app-version")
    check("footer version has a hover tip", page.is_visible("#help-tip") and "version" in page.text_content("#help-tip").lower())
    page.mouse.move(0, 0)
    link = page.locator(".repo-link a")
    check("header links to the GitHub repository",
          link.get_attribute("href") == "https://github.com/jnicholas1692/Vibed_HomeStead_Screener")
    check("empty list explains how to start", "No addresses yet" in page.text_content("#list"))


def test_static_hover_help(b):
    section("Hover help on the fixed parts of the page")
    page = b.page
    # Every button in the header and list controls carries a tip.
    missing = page.evaluate("""() => [...document.querySelectorAll('header button, .list-controls button')]
        .filter((el) => !el.dataset.tip).map((el) => el.id || el.textContent)""")
    check("every header and list button has a tip", missing == [], str(missing))
    labels = page.evaluate("""() => ['sort-by', 'filter-status', 'hide-dealbreakers']
        .filter((id) => !document.getElementById(id).closest('label').querySelector('.help'))""")
    check("list controls have dotted, explained labels", labels == [], str(labels))
    page.hover("#btn-add")
    check("hovering a button shows its tip", page.is_visible("#help-tip"))
    page.keyboard.press("Escape")
    check("Escape closes the tip", page.locator("#help-tip").count() == 0)
    page.focus("#app-version")
    check("tabbing to the version shows its tip", page.is_visible("#help-tip"))
    page.mouse.move(0, 0)
    page.evaluate("() => document.activeElement.blur()")


def test_settings(b):
    section("Settings")
    page = b.page
    open_settings(page, "scoring")
    check("Settings opens", page.is_visible("#dlg-criteria"))
    check("six criteria start ticked, each counting the same", "6 ticked, each counts 17%" in page.text_content("#c-criteria-count"))
    rows = page.eval_on_selector_all("#c-criteria-list li", "els => els.map((li) => li.dataset.key)")
    check("all fifteen criteria are listed", len(rows) == 15 and rows[-3:] == ["delivery", "pediatrician", "childcare"], str(rows))
    no_tip = page.evaluate("() => [...document.querySelectorAll('#c-criteria-list .order-name')].filter((n) => !n.querySelector('.help')).length")
    check("every criterion name has a hover explanation", no_tip == 0)
    check("every criterion has a dealbreaker switch", page.locator("#c-criteria-list input[data-deal]").count() == 15)
    help_missing = page.evaluate("""() => [...document.querySelectorAll('#criteria-fields input[data-path]')]
        .filter((input) => !input.closest('label').querySelector('.help')).map((input) => input.dataset.path)""")
    check("every number box in Settings has a hover explanation", help_missing == [], str(help_missing))

    page.click("#tab-costs")
    check("Costs and loans tab shows the Census key box", page.is_visible("#c-census-key"))
    link = page.locator("#c-census-key-link")
    check("Census sign-up link is visible", link.is_visible())
    check("Census link goes to the sign-up page", link.get_attribute("href") == "https://api.census.gov/data/key_signup.html")
    check("Census link opens in a new tab", link.get_attribute("target") == "_blank")
    check("Census link does not pass this page along", "noopener" in (link.get_attribute("rel") or ""))
    below = page.evaluate("""() => document.getElementById('c-census-key').getBoundingClientRect().bottom
        <= document.getElementById('c-census-key-link').getBoundingClientRect().top""")
    check("Census link sits under the key box", below)
    link.hover()
    check("Census link has a hover tip", page.is_visible("#help-tip") and "Census" in page.text_content("#help-tip"))
    page.mouse.move(0, 0)

    page.click("#tab-layout")
    check("Report layout tab lists the sections", page.locator("#c-order-list li").count() >= 10)

    # Change two settings, save, reload, and see that they stuck.
    page.click("#tab-scoring")
    page.fill("input[data-path=priceTarget]", "120000")
    page.click("#tab-costs")
    page.fill("#c-census-key", FAKE_CENSUS_KEY)
    save_settings(page)
    check("Save settings closes the window", not page.is_visible("#dlg-criteria"))
    page.reload()
    page.wait_for_load_state("networkidle")
    open_settings(page, "scoring")
    check("a changed setting survives a reload", page.input_value("input[data-path=priceTarget]") == "120000")
    page.click("#tab-costs")
    check("the Census key survives a reload", page.input_value("#c-census-key") == FAKE_CENSUS_KEY)

    # Reset saves the defaults at once and closes Settings, but keeps the key.
    page.click("#btn-reset-criteria")
    check("Reset to defaults closes Settings", not page.is_visible("#dlg-criteria"))
    open_settings(page, "scoring")
    check("Reset to defaults restores the price target", page.input_value("input[data-path=priceTarget]") == "100000")
    page.click("#tab-costs")
    check("Reset to defaults keeps the Census key", page.input_value("#c-census-key") == FAKE_CENSUS_KEY)
    close_dialog(page, "dlg-criteria")


def test_sliders_and_uses(b):
    section("Two-ended sliders, and recommended values for what the land is for")
    page = b.page
    open_settings(page, "scoring")
    box = lambda path: page.input_value(f'input[data-path="{path}"]')
    thumb = lambda pair, which: page.locator(f'.range-pair[data-pair="{pair}"] input.dual-{which}')
    check("every scoring range has a slider with two thumbs", page.locator(".range-pair").count() == 11
          and page.locator(".range-pair input[type=range]").count() == 22)
    check("each thumb is labelled for screen readers", thumb("slope", "lo").get_attribute("aria-label") == "Slope: full marks at or below (%)")
    check("the boxes start at the saved values", box("slopeIdeal") == "5" and box("slopeMax") == "20")

    # Keyboard: each arrow press moves the thumb one step (0.5% for slope), and the box follows.
    thumb("slope", "lo").focus()
    for _ in range(4):
        page.keyboard.press("ArrowRight")
    check("moving a thumb updates its box", box("slopeIdeal") == "7", box("slopeIdeal"))
    # The thumbs cannot cross: pushing the left one to the far end stops one step short of the right one, and pushes it.
    page.keyboard.press("End")
    check("a thumb pushed past its partner pushes it along", float(box("slopeIdeal")) < float(box("slopeMax")), f'{box("slopeIdeal")} / {box("slopeMax")}')

    # Typing in a box moves the thumb, and a number beyond the end stretches the slider.
    page.fill('input[data-path="priceMax"]', "2000000")
    check("typing in a box moves its thumb", thumb("price", "hi").input_value() == "2000000")
    check("a number past the end stretches the slider", thumb("price", "hi").get_attribute("max") == "2000000")
    fill = page.evaluate("() => getComputedStyle(document.querySelector('.range-pair[data-pair=price] .dual')).getPropertyValue('--hi').trim()")
    check("the colored track follows the thumbs", fill == "100%", fill)

    # Mouse: drag the airport's right thumb to the left.
    before = float(box("airportMaxMin"))
    knob = thumb("airport", "hi").bounding_box()
    track = page.locator('.range-pair[data-pair="airport"] .dual').bounding_box()
    hi_pct = page.evaluate("() => parseFloat(getComputedStyle(document.querySelector('.range-pair[data-pair=airport] .dual')).getPropertyValue('--hi'))")
    x = track["x"] + track["width"] * hi_pct / 100
    page.mouse.move(x, track["y"] + track["height"] / 2)
    page.mouse.down()
    page.mouse.move(x - 60, track["y"] + track["height"] / 2, steps=6)
    page.mouse.up()
    check("dragging a thumb with the mouse changes its box", float(box("airportMaxMin")) < before, f"{before} -> {box('airportMaxMin')}")

    # Uses: nothing ticked means no recommendation, and the buttons wait.
    check("the recommendation buttons wait for a use", page.is_disabled("#c-apply-recommended") and page.is_disabled("#c-tick-suggested"))
    check("every use has a hover explanation", page.locator("label:has(input[data-use]) .help").count() == 5)
    page.check('input[data-use="farm"]')
    page.check('input[data-use="garden"]')
    rec = page.text_content('[data-rec="slope"]')
    check("ticking uses shows the stricter recommendation with its unit", rec == "Recommended: full marks at 3%, zero at 12%", rec)
    check("rain shows its recommendation in inches", "35 in/year" in page.text_content('[data-rec="rain"]'))
    check("price has no recommendation, since it depends on you", "No recommendation" in page.text_content('[data-rec="price"]'))
    check("the suggested criteria are listed", "Groundwater depth" in page.text_content("#c-use-summary"))
    page.click("#c-apply-recommended")
    check("Use recommended values moves the sliders", box("slopeIdeal") == "3" and box("slopeMax") == "12" and box("rainFull") == "35" and box("rainZero") == "18",
          f'{box("slopeIdeal")} {box("slopeMax")} {box("rainFull")} {box("rainZero")}')
    check("the thumbs follow the recommended values", thumb("slope", "lo").input_value() == "3" and thumb("slope", "hi").input_value() == "12")
    check("Use recommended values leaves price alone", box("priceMax") == "2000000")
    page.click("#c-tick-suggested")
    ticked = page.eval_on_selector_all("#c-criteria-list input[data-crit]:checked", "els => els.map((e) => e.dataset.crit)")
    check("Tick suggested criteria ticks the farm and garden criteria", {"groundwater", "hazards", "flood"} <= set(ticked), str(ticked))
    sizes = page.evaluate("() => { const d = document.getElementById('dlg-criteria'); return [d.scrollWidth, d.clientWidth, d.offsetHeight - d.clientHeight]; }")
    check("Settings has no sideways scrolling", sizes[0] <= sizes[1] and sizes[2] <= 2, str(sizes))
    save_settings(page)
    page.reload()
    page.wait_for_load_state("networkidle")
    open_settings(page, "scoring")
    check("the uses survive a reload", page.is_checked('input[data-use="farm"]') and page.is_checked('input[data-use="garden"]')
          and not page.is_checked('input[data-use="homestead"]'))
    check("the slider values survive a reload", box("slopeIdeal") == "3" and thumb("slope", "hi").input_value() == "12")
    page.click("#btn-reset-criteria")   # back to the defaults for the tests that follow (the Census key is kept)


def test_criteria(b):
    section("Choosing and ordering your criteria")
    page = b.page
    open_settings(page, "scoring")
    order = lambda: page.eval_on_selector_all("#c-criteria-list li", "els => els.map((li) => li.dataset.key)")
    # Untick everything and try to save: refused.
    while page.locator("#c-criteria-list input[data-crit]:checked").count():   # uncheck the first ticked box until none are left
        page.locator("#c-criteria-list input[data-crit]:checked").first.uncheck()
    check("the count says none are ticked", "None ticked" in page.text_content("#c-criteria-count"))
    save_settings(page)
    check("saving with nothing ticked is refused", page.is_visible("#criteria-error") and "at least one" in page.text_content("#criteria-error"))
    # Tick septic, slope and groundwater, and move groundwater to the top with the Up button.
    for key in ["septic", "slope", "groundwater"]:
        page.check(f"#c-criteria-list input[data-crit={key}]")
    check("the count follows the ticks", "3 ticked, each counts 33%" in page.text_content("#c-criteria-count"))
    while order()[0] != "groundwater":
        page.click("#c-criteria-list button[data-cmove=up][data-key=groundwater]")
    check("Up moves a criterion to the top", order()[0] == "groundwater")
    check("the keyboard focus stays on the moved row", page.evaluate("() => document.activeElement.dataset.key") == "groundwater")
    # Drag slope (wherever it is) above septic by its handle.
    grip = page.locator("#c-criteria-list li[data-key=slope] .order-grip").bounding_box()
    target = page.locator("#c-criteria-list li[data-key=septic]").bounding_box()
    page.mouse.move(grip["x"] + grip["width"] / 2, grip["y"] + grip["height"] / 2)
    page.mouse.down()
    page.mouse.move(target["x"] + 20, target["y"] + 4, steps=8)
    page.mouse.up()
    now = order()
    check("dragging a row moves it", now.index("slope") < now.index("septic"), str(now[:4]))
    save_settings(page)
    check("the criteria save", not page.is_visible("#dlg-criteria"))
    page.reload()
    page.wait_for_load_state("networkidle")
    open_settings(page, "scoring")
    saved = order()
    ticked = page.eval_on_selector_all("#c-criteria-list input[data-crit]:checked", "els => els.map((e) => e.dataset.crit)")
    check("the order survives a reload", saved[:3] == ["groundwater", "slope", "septic"], str(saved[:3]))
    check("the ticks survive a reload", ticked == ["groundwater", "slope", "septic"], str(ticked))
    close_dialog(page, "dlg-criteria")
    # Back to the defaults for the rest of the tests (the Census key is kept).
    open_settings(page, "scoring")
    page.click("#btn-reset-criteria")


def test_road_backup_and_refresh(b):
    section("Road backup, and refreshing only what is missing")
    page = b.page
    page.click("#list .row-name")
    page.wait_for_selector("#dlg-detail[open]")
    detail = page.text_content("#detail")
    check("roads come from the Census backup when OpenStreetMap is down", "E Main St" in detail and "TIGER" in detail)
    check("the report says why the backup was used", "OpenStreetMap servers were busy" in detail)
    failed_note = page.evaluate("() => [...document.querySelectorAll('#detail .notice')].map((n) => n.textContent).find((t) => t.includes('Some lookups failed')) || ''")
    check("other lookups did fail in this test", "Internet:" in failed_note)
    check("Road access is not listed as a failed lookup", "Roads:" not in failed_note, failed_note[:200])
    check("there is a Refresh all button", page.locator("[data-refresh][data-mode=all]").count() == 1)

    # Refresh data: only the lookups that failed (internet, rain, places and others in this test) are asked again.
    seen = len(b.requests)
    page.click("[data-refresh][data-mode=missing]")
    wait_for_report(page)
    asked = {urlparse(u).hostname for u in b.requests[seen:]}
    check("Refresh data asks a service that failed before (FCC internet)", "geo.fcc.gov" in asked, str(sorted(asked)))
    check("Refresh data does not ask the flood map again", "hazards.fema.gov" not in asked, str(sorted(asked)))
    check("Refresh data does not ask the elevation service again", "epqs.nationalmap.gov" not in asked)
    check("Refresh data does not ask the Texas parcel service again", "feature.geographic.texas.gov" not in asked)
    check("the report shows when missing data was filled in", "missing data filled in" in page.text_content("#detail"))
    check("the data that was already there is kept", "1200 ft" in page.text_content("#detail") and "Blanco ISD" in page.text_content("#detail"))

    # Refresh all asks everything again.
    seen = len(b.requests)
    page.click("[data-refresh][data-mode=all]")
    wait_for_report(page)
    asked = {urlparse(u).hostname for u in b.requests[seen:]}
    check("Refresh all asks every service again", {"hazards.fema.gov", "epqs.nationalmap.gov", "feature.geographic.texas.gov"} <= asked, str(sorted(asked)))
    check("Refresh all clears the filled-in note", "missing data filled in" not in page.text_content("#detail"))
    close_dialog(page, "dlg-detail")


def test_people_and_crime(b):
    section("People and community, and crime")
    page = b.page
    page.locator("#list .row-name", has_text="Blanco test 10 acres").click()
    page.wait_for_selector("#dlg-detail[open]")
    detail = page.text_content("#detail")
    check("the People and safety category is shown", page.locator("details.rgroup[data-group=community]").count() == 1)
    check("tract and county populations are shown side by side", "2,613" in detail and "12,446" in detail)
    check("tract and county incomes are shown", "$63,500" in detail and "$92,425" in detail)
    check("the survey release is named", "ACS 2024 5-year" in detail)
    check("the old Census-key county profile is gone", "County population" not in detail and "needs a free Census key in Settings" not in detail)
    check("crime asks for a free key first", "The FBI's crime figures need a free key" in detail)
    check("no request went to the FBI without a key", not any(urlparse(u).hostname == "api.usa.gov" for u in b.requests))
    close_dialog(page, "dlg-detail")

    # Add the crime key in Settings, then Refresh data: only the crime figures are asked for.
    open_settings(page, "costs")
    check("Settings has a crime data key box", page.is_visible("#c-crime-key"))
    link = page.locator("#c-crime-key-link")
    check("Settings links to the api.data.gov sign-up page", link.get_attribute("href") == "https://api.data.gov/signup/" and link.get_attribute("target") == "_blank")
    page.fill("#c-crime-key", FAKE_CRIME_KEY)
    save_settings(page)
    page.locator("#list .row-name", has_text="Blanco test 10 acres").click()
    page.wait_for_selector("#dlg-detail[open]")
    seen = len(b.requests)
    page.click("[data-refresh][data-mode=missing]")
    wait_for_report(page)
    asked = {urlparse(u).hostname for u in b.requests[seen:]}
    check("Refresh data asks the FBI once a key is set", "api.usa.gov" in asked, str(sorted(asked)))
    check("Refresh data does not ask Census Reporter again", "api.censusreporter.org" not in asked)
    detail = page.text_content("#detail")
    check("the county sheriff is named", "Blanco County Sheriff's Office" in detail)
    check("violent crime: 12 offenses, 126.1 per 100,000, with Texas and US", re.search(r"Violent crime\s*12\s*126\.1\s*360\s*336", detail) is not None,
          (re.search(r"Violent crime[\s\d,.]*", detail) or [""])[0])
    check("property crime: 36 offenses, 378.2 per 100,000", re.search(r"Property crime\s*36\s*378\.2\s*2,040\s*1,680", detail) is not None)
    key_hosts = sorted({urlparse(u).hostname for u in b.requests if FAKE_CRIME_KEY in u})
    check("the crime key was sent only to api.usa.gov", key_hosts == ["api.usa.gov"], str(key_hosts))
    no_tip = page.evaluate("() => [...document.querySelectorAll('#detail .kv > div:nth-child(odd), #detail td:first-child')].filter((d) => d.textContent.trim() && !d.querySelector('.help') && d.closest('details[data-group=community]')).map((d) => d.textContent.trim())")
    check("every label in the new sections is explained", no_tip == [], str(no_tip))
    close_dialog(page, "dlg-detail")


def test_family_needs(b):
    section("Family needs: who is moving with you")
    page = b.page
    page.locator("#list .row-name", has_text="Blanco test 10 acres").click()
    page.wait_for_selector("#dlg-detail[open]")
    check("no Family needs section until an age is ticked", "Family needs" not in page.text_content("#detail .dlg-body"))
    close_dialog(page, "dlg-detail")
    open_settings(page, "scoring")
    boxes = page.locator("label:has(input[data-family])")
    check("Settings asks who is moving with you, six ages", boxes.count() == 6)
    check("every age has a hover explanation", page.locator("label:has(input[data-family]) .help").count() == 6)
    page.check('input[data-family="expecting"]')
    page.check('input[data-family="prek"]')
    summary = page.text_content("#c-use-summary")
    check("the suggestion names the ages and their criteria", "expecting or a newborn" in summary and "Delivery hospital drive" in summary and "Child care drive" in summary, summary)
    check("Use recommended values waits for a land use", page.is_disabled("#c-apply-recommended") and page.is_enabled("#c-tick-suggested"))
    page.click("#c-tick-suggested")
    ticked = page.eval_on_selector_all("#c-criteria-list input[data-crit]:checked", "els => els.map((e) => e.dataset.crit)")
    check("Tick suggested criteria ticks the family criteria", {"delivery", "pediatrician", "childcare", "hospital"} <= set(ticked), str(ticked))
    save_settings(page)

    # Refresh data asks only for what the new ages need: the DSHS layers, and the new kinds of places.
    page.locator("#list .row-name", has_text="Blanco test 10 acres").click()
    page.wait_for_selector("#dlg-detail[open]")
    seen = len(b.requests)
    page.click("[data-refresh][data-mode=missing]")
    wait_for_report(page)
    asked = {urlparse(u).hostname for u in b.requests[seen:]}
    check("Refresh data asks the DSHS designation map", {"www.arcgis.com", "services3.arcgis.com"} <= asked, str(sorted(asked)))
    check("Refresh data does not ask the flood map or Census Reporter again", not ({"hazards.fema.gov", "api.censusreporter.org"} & asked), str(sorted(asked)))
    detail = page.text_content("#detail")
    check("the Family needs section appears", "Family needs" in detail)
    family = page.text_content("details[data-group=community] .rgroup-body")
    family = family[family.find("Family needs"):]
    # Marble Falls is about 17 miles from the test spot and Fredericksburg about 29, so Marble Falls comes first.
    check("the designated delivery hospitals are named, nearest first", 0 <= family.find("Baylor Scott & White Medical Center - Marble Falls") < family.find("Methodist Hospital Hill Country"),
          family[family.find("Delivery hospital"):][:200])
    check("the delivery hospital's level is shown", "Level II - Specialty Care" in detail)
    check("newborn care (NICU) levels are shown", "Newborn care (NICU)" in detail and "Level I - Well Care" in detail)
    check("Texas pre-K and kindergarten rules are explained", "4 by September 1" in detail and "5 by September 1" in detail)
    check("prenatal and newborn advice is shown", "3 to 5 days after birth" in detail)
    check("links to the Texas child care search and school report cards", page.locator('#detail a[href="https://childcare.hhs.texas.gov/Public/childcaresearch"]').count() >= 1
          and page.locator('#detail a[href="https://txschools.gov/"]').count() >= 1)
    check("the family places are listed", "Pediatrician" in detail and "OB-GYN" in detail and "Preschool or pre-K" in detail)
    summary_rows = page.eval_on_selector_all(".summary-table tbody tr td:first-child", "els => els.map((e) => e.textContent.trim())")
    check("the delivery criterion is in the report summary", "Delivery hospital drive" in summary_rows, str(summary_rows))
    no_tip = page.evaluate("() => [...document.querySelectorAll('#detail .kv > div:nth-child(odd)')].filter((d) => !d.querySelector('.help')).map((d) => d.textContent.trim())")
    check("every family label is explained", no_tip == [], str(no_tip))
    close_dialog(page, "dlg-detail")
    open_settings(page, "scoring")
    page.click("#btn-reset-criteria")   # back to the defaults (no family ages) for the tests that follow


def test_texas_tax_and_exemptions(b):
    section("Texas acres, tax values and exemptions")
    page = b.page
    # Add a parcel with the acres left blank and two exemptions ticked.
    page.click("#btn-add")
    page.fill("#f-name", "Blanco no acres")
    page.fill("#f-lat", str(LAT))
    page.fill("#f-lon", str(LON))
    page.fill("#f-price", "120000")
    check("the exemption boxes have hover help", page.locator(".exemptions .help").count() == 4)
    page.check("#f-ex-ag")
    page.check("#f-ex-homestead")
    page.check("#f-ex-none")
    check("ticking None of these clears the others", not page.is_checked("#f-ex-ag") and not page.is_checked("#f-ex-homestead"))
    page.check("#f-ex-ag")
    check("ticking an exemption clears None of these", not page.is_checked("#f-ex-none"))
    page.check("#f-ex-homestead")
    page.click("#btn-save")
    wait_for_report(page)
    detail = page.text_content("#detail")
    check("blank acres are filled in from the appraisal record", "10.5 acres" in page.text_content("#detail .dlg-head"), page.text_content("#detail .dlg-head"))
    check("the report says those acres came from the appraisal district", "used as the parcel's acres" in detail)
    check("the exemptions you ticked are listed", "Ag (open-space) valuation, homestead exemption" in detail)
    link = page.locator('#detail a[href$="/county-directory/blanco.php"]')
    check("there is a link to the county's appraisal district", link.count() == 1)
    check("the link names the property ID to ask about", "property ID R123" in detail)
    check("the improvement value is shown", "Appraised improvement value" in detail)
    check("the year built is shown", re.search(r"Year built\s*1998", detail) is not None)
    check("an estimated yearly tax before exemptions is shown", re.search(r"Estimated yearly tax before exemptions\s*\$710", detail) is not None,
          (re.search(r"Estimated yearly tax before exemptions[^%]*%", detail) or [""])[0])
    no_tip = page.evaluate("() => [...document.querySelectorAll('#detail .kv > div:nth-child(odd)')].filter((d) => !d.querySelector('.help')).map((d) => d.textContent.trim())")
    check("every new label is explained", no_tip == [], str(no_tip))
    check("nothing about the owner reached the page", not any(s in page.content() for s in SECRETS))
    close_dialog(page, "dlg-detail")
    check("the list marks appraisal acres", "10.5 acres (appraisal)" in page.text_content("#list"))

    # Edit keeps the ticks, and typing your own acres makes them yours.
    page.locator("#list .row-name", has_text="Blanco no acres").click()
    page.click("#detail [data-edit]")
    check("Edit shows the exemptions you ticked", page.is_checked("#f-ex-ag") and page.is_checked("#f-ex-homestead") and not page.is_checked("#f-ex-wildlife"))
    check("Edit shows the filled-in acres", page.input_value("#f-acres") == "10.5")
    page.fill("#f-acres", "11")
    page.click("#btn-save")
    page.wait_for_selector("#dlg-detail[open]")
    check("acres you type replace the appraisal acres", "11 acres" in page.text_content("#detail .dlg-head") and "used as the parcel's acres" not in page.text_content("#detail"))
    close_dialog(page, "dlg-detail")

    # The ag or wildlife criterion scores from your answer.
    open_settings(page, "scoring")
    page.check("#c-criteria-list input[data-crit=agValuation]")
    save_settings(page)
    page.locator("#list .row-name", has_text="Blanco no acres").click()
    page.wait_for_selector("#dlg-detail[open]")
    summary = page.text_content(".summary-table")
    check("the ag criterion appears in the report summary", "Ag or wildlife valuation" in summary and "Yes (you entered)" in summary)
    # Delete this parcel (two clicks) so the tests after this one see the list they expect.
    page.click("#detail [data-delete]")
    page.click("#detail [data-delete].armed")
    check("the extra parcel is deleted", "Blanco no acres" not in page.text_content("#list"))
    open_settings(page, "scoring")
    page.click("#btn-reset-criteria")


def test_criteria_order_shows(b):
    section("Your criteria order shows in the report, the list and the compare table")
    page = b.page
    open_settings(page, "scoring")
    while page.locator("#c-criteria-list input[data-crit]:checked").count():
        page.locator("#c-criteria-list input[data-crit]:checked").first.uncheck()
    for key in ["hazards", "septic", "price"]:
        page.check(f"#c-criteria-list input[data-crit={key}]")
    order = lambda: page.eval_on_selector_all("#c-criteria-list li", "els => els.map((li) => li.dataset.key)")
    for key in ["price", "septic", "hazards"]:        # each one to the top in turn, so hazards ends up first
        while order()[0] != key:
            page.click(f"#c-criteria-list button[data-cmove=up][data-key={key}]")
    save_settings(page)
    page.click("#list .row-name")
    page.wait_for_selector("#dlg-detail[open]")
    summary = page.eval_on_selector_all(".summary-table tbody tr td:first-child", "els => els.map((e) => e.textContent.trim())")
    check("the report summary lists your criteria in your order", summary == ["Natural hazard rating", "Septic suitability", "Price"], str(summary))
    detail = page.text_content("#detail")
    check("the score counts your three criteria", "3 of 3 of your criteria had data" in detail,
          (re.search(r"\d+ of \d+ of your criteria had data", detail) or [""])[0])
    check("the hazard criterion shows what was found", "Relatively Moderate" in page.text_content(".summary-table"))
    close_dialog(page, "dlg-detail")
    # Each heading's own words (its dotted label), without the little sort button next to it.
    heads = page.eval_on_selector_all("#list thead th", "els => els.map((e) => (e.querySelector('.help') || e).textContent.trim())")
    check("the list columns follow your order (price already has a column)",
          heads[heads.index("Flood zone") + 1:heads.index("Flood zone") + 3] == ["Natural hazard rating", "Septic suitability"], str(heads))
    check("the list says how many criteria had data", "3/3 criteria" in page.text_content("#list"))
    # Back to the default criteria for the rest of the tests.
    open_settings(page, "scoring")
    page.click("#btn-reset-criteria")


def test_add_errors(b):
    section("Add window: mistakes are explained")
    page = b.page
    page.click("#btn-add")
    page.fill("#f-name", "Bad numbers")
    page.fill("#f-lat", "thirty")
    page.fill("#f-lon", "-98")
    page.click("#btn-save")
    check("letters in a number box are refused", "must be numbers" in page.text_content("#add-error"))
    page.fill("#f-lat", "51.5")
    page.fill("#f-lon", "-0.12")
    page.click("#btn-save")
    check("a spot outside the US is refused", "outside the United States" in page.text_content("#add-error"))
    page.fill("#f-lat", "")
    page.fill("#f-lon", "")
    page.fill("#f-address", "1 Nowhere Road, Nowhere")
    page.click("#btn-save")
    page.wait_for_function("() => document.getElementById('add-error').textContent.includes('No match')")
    check("an address with no match says so", "No match for that address" in page.text_content("#add-error"))
    close_dialog(page, "dlg-add")
    check("nothing was added by the mistakes", "No addresses yet" in page.text_content("#list"))


def test_address_suggestions(b):
    section("Address suggestions")
    page = b.page
    page.reload()   # a fresh Add window, so the name has not been typed by an earlier test
    page.wait_for_load_state("networkidle")
    page.click("#btn-add")
    page.fill("#f-address", "")
    page.type("#f-address", "100 Main", delay=30)
    page.wait_for_selector("#address-list:not([hidden]) li", timeout=5000)
    check("typing shows a suggestion", "Blanco" in page.text_content("#address-list"))
    page.click("#address-list li")
    check("picking a suggestion fills the latitude", page.input_value("#f-lat").startswith("30.27"))
    check("the name follows the address", "Main Street" in page.input_value("#f-name"))
    check("suggestions were asked of photon.komoot.io",
          any(urlparse(u).hostname == "photon.komoot.io" for u in b.requests))
    page.fill("#f-address", "")
    close_dialog(page, "dlg-add")


def test_full_report(b):
    section("A Texas parcel: the report, fail-soft lookups and privacy")
    page = b.page
    add_parcel(page, name="Blanco test 10 acres")
    wait_for_report(page)
    detail = page.text_content("#detail")
    check("report opens with the parcel's name", page.text_content("#detail-title") == "Blanco test 10 acres")
    check("county and state come from the Census", "Blanco County, TX" in detail)
    check("flood zone answer shows zone X", re.search(r"No\b.*\bX\b", detail) is not None)
    check("elevation is shown", "1200 ft" in detail)
    check("slope comes from the elevation points", "3%" in detail, re.search(r"Slope[^%]*%", detail).group(0) if re.search(r"Slope[^%]*%", detail) else "")
    check("septic rating is shown", "Somewhat limited" in detail)
    check("the score counts only criteria with data", "4 of 6 of your criteria had data" in detail,
          (re.search(r"\d+ of \d+ of your criteria had data", detail) or [""])[0])
    summary = page.eval_on_selector_all(".summary-table tbody tr td:first-child", "els => els.map((e) => e.textContent.trim())")
    check("the summary table lists the default criteria in order",
          summary == ["Septic suitability", "Airport distance", "Price", "Internet", "Slope", "Rainfall"], str(summary))
    check("slope says which way the ground faces", "about flat" in detail)
    check("FEMA social vulnerability is shown", "Social vulnerability" in detail and "Relatively High" in detail)
    check("FEMA community resilience is shown", "Community resilience" in detail)
    check("county disaster declarations are counted once each", re.search(r"FEMA disaster declarations \(10 years\)\s*2\b", detail) is not None)
    check("the latest declaration is named", "latest Flood, 2026-07-18" in detail)
    check("the Texas parcel outline is reported", "drawn on the map" in detail)
    check("failed lookups are listed", "Some lookups failed" in detail and "Internet" in detail)
    check("a failed section says it can be refreshed", "Refresh data" in detail)
    check("the page threw no JavaScript errors", b.page_errors == [], "; ".join(b.page_errors))

    # Texas details
    check("Texas category is shown for a Texas parcel", page.locator("details.rgroup[data-group=texas]").count() == 1)
    for text in ["Blanco ISD", "Blanco-Pedernales GCD", "Trinity", "ACME PIPELINE", "Ranch land"]:
        check(f"Texas details show {text}", text in detail)
    check("the aquifer code prefix is removed", "218TRNT" not in detail)

    # Privacy: the owner details the fake parcel service sent must be nowhere.
    html = page.content()
    for secret in SECRETS:
        check(f"'{secret}' is not on the page", secret not in html)
        check(f"'{secret}' is not saved in the browser", secret not in stored_text(page))

    # Report categories
    groups = page.eval_on_selector_all("details.rgroup", "els => els.map((e) => e.dataset.group)")
    check("report has its categories", set(groups) >= {"overview", "land", "access", "climate", "texas", "money"}, str(groups))
    check("no category appears twice", len(groups) == len(set(groups)), str(groups))
    stray = page.evaluate("""() => [...document.querySelectorAll('#detail .dlg-body h3')]
        .filter((h) => !h.closest('details.rgroup')).map((h) => h.textContent)""")
    check("every section heading sits inside a category (except sources and notes)",
          sorted(stray) == ["Data sources", "Your notes"], str(stray))
    no_tip = page.evaluate("() => [...document.querySelectorAll('#detail .help')].filter((e) => !e.dataset.tip).length")
    check("every dotted label in the report has a tip", no_tip == 0, f"{no_tip} without a tip")
    unexplained = page.evaluate("""() => [...document.querySelectorAll('#detail .kv > div:nth-child(odd)')]
        .filter((d) => !d.querySelector('.help')).map((d) => d.textContent.trim()).slice(0, 10)""")
    check("every data label in the report is explained", unexplained == [], str(unexplained))
    check("every report section names its source", page.locator("#detail .source").count() >= 8)

    # Collapse and expand, and the choice is remembered.
    page.click("[data-groups=close]")
    check("Collapse all closes every category", page.evaluate("() => [...document.querySelectorAll('details.rgroup')].every((d) => !d.open)"))
    page.evaluate("() => window.dispatchEvent(new Event('beforeprint'))")
    check("printing opens every category", page.evaluate("() => [...document.querySelectorAll('details.rgroup')].every((d) => d.open)"))
    page.evaluate("() => window.dispatchEvent(new Event('afterprint'))")
    check("after printing the categories close again", page.evaluate("() => [...document.querySelectorAll('details.rgroup')].every((d) => !d.open)"))
    page.click("[data-groups=open]")
    check("Expand all opens every category", page.evaluate("() => [...document.querySelectorAll('details.rgroup')].every((d) => d.open)"))

    # Copy summary: the clipboard may be refused in a test browser, so it may fall back to a text box.
    page.click("[data-copy-summary]")
    page.wait_for_timeout(300)
    summary = page.input_value("#summary-text") if page.is_visible("#summary-text") else ""
    message = page.text_content("#summary-msg") or ""
    check("Copy summary gives a result", bool(summary) or bool(message.strip()))
    if summary:
        check("the summary has the score line", "of your criteria had data" in summary)
        check("the summary has no owner details", not any(s in summary for s in SECRETS))

    # Notes are saved with the parcel. Save notes also closes the report.
    page.select_option("#d-status", "interested")
    page.fill("#d-notes", "Good road frontage")
    page.click("[data-save-notes]")
    check("notes are saved in the browser", "Good road frontage" in stored_text(page))
    check("Save notes closes the report", not page.is_visible("#dlg-detail"))

    # The list row
    row = page.text_content("#list")
    check("the list shows the new parcel", "Blanco test 10 acres" in row and "$95,000" in row)
    check("the list shows how many criteria had data", "4/6 criteria" in row)
    check("the parcel outline is drawn on the map", page.locator(".leaflet-overlay-pane path").count() >= 1)
    check("the outline is saved without owner details", "SECRET" not in stored_text(page) and '"outline"' in stored_text(page))

    # Network: only known services were asked, and the Census key went only to the Census.
    strangers = sorted({urlparse(u).hostname for u in b.requests} - ALLOWED_HOSTS
                       - {h for h in {urlparse(u).hostname for u in b.requests} if h and h.endswith("tile.openstreetmap.org")})
    check("no request went to an unknown host", strangers == [], str(strangers))
    key_hosts = sorted({urlparse(u).hostname for u in b.requests if FAKE_CENSUS_KEY in u})
    check("the Census key was sent only to api.census.gov", key_hosts in ([], ["api.census.gov"]), str(key_hosts))
    check("the Census data API was asked (the key was used)", "api.census.gov" in key_hosts, str(key_hosts))


def test_export(b):
    section("Export")
    page = b.page
    with page.expect_download() as info:
        page.click("#btn-export")
    path = info.value.path()
    data = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    check("export is a JSON file of this app", data.get("app") == "homestead-screener")
    check("export holds the parcel", any(p.get("name") == "Blanco test 10 acres" for p in data.get("parcels", [])))
    check("export has no owner details", not any(s in json.dumps(data) for s in SECRETS))


def test_demo_list_compare(b):
    section("Demo parcels, list, compare and delete")
    page = b.page
    page.click("#btn-add")
    page.click("#btn-demo")
    page.wait_for_function("() => document.querySelectorAll('#list tr.row').length === 4")
    check("three demo parcels are added", page.locator("#list tr.row").count() == 4)
    check("the list header labels are explained",
          page.evaluate("() => [...document.querySelectorAll('#list thead th')].filter((th) => th.textContent.trim() && !th.querySelector('.help')).length") == 0)

    page.select_option("#sort-by", index=1)
    check("sorting keeps every parcel", page.locator("#list tr.row").count() == 4)
    page.locator('label:has(#hide-dealbreakers) .help').click()
    check("with a mouse, clicking a tick box's words still ticks it", page.is_checked("#hide-dealbreakers"))
    page.uncheck("#hide-dealbreakers")
    page.check("#hide-dealbreakers")
    shown = page.locator("#list tr.row").count()
    check("Hide dealbreakers hides the flood-zone demo parcel", shown == 3 and "Low ground" not in page.text_content("#list"), f"{shown} shown")
    page.uncheck("#hide-dealbreakers")

    check("Compare starts disabled", page.is_disabled("#btn-compare"))
    boxes = page.locator("#list input[data-compare]")
    boxes.nth(0).check()
    boxes.nth(1).check()
    check("picking two parcels enables Compare", page.is_enabled("#btn-compare"))
    page.click("#btn-compare")
    page.wait_for_selector("#dlg-compare[open]")
    names = page.eval_on_selector_all("#list .row-name", "els => els.slice(0, 2).map((e) => e.textContent)")
    compare = page.text_content("#compare")
    check("the compare table shows both parcels", all(n in compare for n in names), str(names))
    check("the compare table names its sources", "Data sources" in compare or "Sources" in compare)
    labels = page.eval_on_selector_all("#compare tbody tr td:first-child", "els => els.map((e) => e.textContent.trim())")
    check("the compare table starts with your criteria in your order",
          labels[2:8] == ["Septic suitability", "Airport distance", "Price", "Internet", "Slope", "Rainfall"], str(labels[:8]))
    check("a ticked criterion's usual row is not repeated", "Asking price" not in labels and "Internet (best non-satellite)" not in labels)
    close_dialog(page, "dlg-compare")
    boxes.nth(0).uncheck()
    boxes.nth(1).uncheck()

    # Delete takes two clicks.
    first_delete = page.locator("#list [data-delete]").first
    first_delete.click()
    check("the first Delete click asks again", page.locator("#list tr.row").count() == 4
          and "again" in page.locator("#list [data-delete]").first.text_content().lower())
    page.locator("#list [data-delete].armed").first.click()
    check("the second click deletes", page.locator("#list tr.row").count() == 3)


def test_list_columns_sort_filter(b):
    section("List columns, sorting by a criterion, and the value filter")
    page = b.page
    page.select_option("#sort-by", "score")
    rows_before = page.locator("#list tr.row").count()
    heads = lambda: page.eval_on_selector_all("#list thead th", "els => els.map((e) => (e.querySelector('.help') || e).textContent.trim())")
    # Columns menu: offers the ticked criteria except price and flood (they always have columns).
    page.click("#col-picker-button")
    offered = page.eval_on_selector_all("#col-menu [data-col]", "els => els.map((e) => e.dataset.col)")
    check("the Columns menu offers the ticked criteria", offered == ["septic", "airport", "internet", "slope", "rain"], str(offered))
    check("the first three start as columns", page.eval_on_selector_all("#col-menu [data-col]:checked", "els => els.map((e) => e.dataset.col)") == ["septic", "airport", "internet"])
    page.uncheck('#col-menu [data-col="airport"]')
    check("unticking a criterion removes its column", "Airport distance" not in heads(), str(heads()))
    check("the Columns menu stays open while you change it", page.locator("#col-picker[open]").count() == 1)
    page.check('#col-menu [data-col="slope"]')
    check("ticking a criterion adds its column", "Slope" in heads(), str(heads()))
    page.locator("#list h2, h2").first.click()
    check("a click elsewhere closes the Columns menu", page.locator("#col-picker[open]").count() == 0)
    page.reload()
    page.wait_for_load_state("networkidle")
    check("the chosen columns survive a reload", "Slope" in heads() and "Airport distance" not in heads(), str(heads()))

    # Sorting by a column heading: low to high, then high to low.
    slope_col = heads().index("Slope")
    slopes = lambda: [float(t.rstrip("%")) for t in page.eval_on_selector_all(f"#list tbody tr td:nth-child({slope_col + 1})", "els => els.map((e) => e.textContent.trim())")]
    page.click('#list [data-sort-key="slope"]')
    check("a heading's sort button sorts low to high", slopes() == sorted(slopes()), str(slopes()))
    check("the Sort menu shows the criterion sort", page.input_value("#sort-by") == "crit:slope:asc")
    page.click('#list [data-sort-key="slope"]')
    check("a second click sorts high to low", slopes() == sorted(slopes(), reverse=True), str(slopes()))
    labels = page.eval_on_selector_all("#sort-by option", "els => els.map((e) => e.textContent)")
    check("the Sort menu offers each ticked criterion both ways", "Rainfall: high to low" in labels and "Septic suitability score: low to high" in labels, str(labels[-4:]))
    check("the sort buttons have hover help", page.locator("#list [data-sort-key]").first.get_attribute("data-tip") is not None)

    # Filter: slope at most 5% hides the steeper parcels and says so.
    page.select_option("#filter-crit", "slope")
    check("choosing a filter moves to the value box", page.evaluate("() => document.activeElement.id") == "filter-value")
    page.fill("#filter-value", "5")
    shown = slopes()
    check("the filter keeps only parcels at most 5%", shown and all(v <= 5 for v in shown), str(shown))
    check("the filter hint says what it does and how many are hidden", "Slope at most 5%" in page.text_content("#filter-hint")
          and "hidden by the filters" in page.text_content("#filter-hint"), page.text_content("#filter-hint"))
    page.select_option("#filter-op", "min")
    check("at least flips the filter", all(v >= 5 for v in slopes()), str(slopes()))
    page.reload()
    page.wait_for_load_state("networkidle")
    check("the filter survives a reload", page.input_value("#filter-crit") == "slope" and page.input_value("#filter-value") == "5")
    page.click("#filter-clear")
    check("Clear filter shows every parcel again", page.locator("#list tr.row").count() == rows_before and page.is_hidden("#filter-hint"))
    page.select_option("#sort-by", "score")


def test_clear_data(b):
    section("Clear addresses and Clear data")
    page = b.page
    # Clear addresses: the addresses go, the keys and other settings stay.
    page.evaluate("() => { settings.censusKey = 'census-test'; settings.crimeKey = 'crime-test'; writeStored(SETTINGS_KEY, settings); }")
    settings_before = page.evaluate("() => localStorage.getItem(SETTINGS_KEY)")
    page.click("#btn-clear-addresses")
    check("Clear addresses asks again first", page.locator("#list tr.row").count() == 3)
    page.click("#btn-clear-addresses")
    check("the second click removes every address", "No addresses yet" in page.text_content("#list"))
    check("Clear addresses keeps the API keys and settings", page.evaluate("() => localStorage.getItem(SETTINGS_KEY)") == settings_before
          and "census-test" in settings_before and "crime-test" in settings_before)
    check("Clear addresses leaves no saved addresses", page.evaluate("() => JSON.parse(localStorage.getItem(PARCELS_KEY))") == [])
    # Put three addresses back for Clear data.
    page.click("#btn-add")
    page.click("#btn-demo")
    page.wait_for_function("() => document.querySelectorAll('#list tr.row').length === 3")

    page.click("#btn-clear")
    check("Clear data asks again first", page.locator("#list tr.row").count() == 3)
    page.click("#btn-clear")
    check("the second click empties the list", "No addresses yet" in page.text_content("#list"))
    leftover = page.evaluate("() => Object.keys(localStorage).filter((k) => k.startsWith('homestead-screener.parcels'))")
    check("the saved parcels are erased", leftover == [] or stored_text(page).count("Blanco test") == 0, str(leftover))


def test_everything_down(playwright, headed):
    section("Every data service is down")
    b = Browser(playwright, mode="all_fail", headed=headed)
    page = b.page
    add_parcel(page, name="Offline test")
    wait_for_report(page, timeout=60000)
    detail = page.text_content("#detail")
    check("the report still opens", page.text_content("#detail-title") == "Offline test")
    check("the failures are listed", "Some lookups failed" in detail)
    found = re.search(r"(\d+) of (\d+) of your criteria had data", detail)
    check("the score only counts what the app could work out itself", found is not None and int(found.group(1)) <= 2,
          found.group(0) if found else "no score line")
    check("sections say they could not load", "could not load" in detail or "Refresh data" in detail)
    check("the page threw no JavaScript errors", b.page_errors == [], "; ".join(b.page_errors))
    close_dialog(page, "dlg-detail")
    check("the parcel is still saved in the list", "Offline test" in page.text_content("#list"))
    b.close()


def test_phone_width(playwright, headed):
    section("Phone width")
    b = Browser(playwright, headed=headed, viewport={"width": 375, "height": 812}, touch=True)
    overflow = b.page.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
    check("no sideways scrolling at 375 px wide", overflow <= 0, f"{overflow}px too wide")
    check("the footer version shows on a phone", b.page.is_visible("#app-version"))
    open_settings(b.page, "scoring")
    sizes = b.page.evaluate("() => { const d = document.getElementById('dlg-criteria'); return [d.scrollWidth, d.clientWidth]; }")
    check("Settings and its sliders fit a phone without sideways scrolling", sizes[0] <= sizes[1], str(sizes))
    track = b.page.locator('.range-pair[data-pair="slope"] .dual').bounding_box()
    check("a slider is wide enough to use on a phone", track["width"] >= 250, str(round(track["width"])))

    # Tapping dotted words opens their tip and leaves it open: phones send a pretend "mouse left" right after a tap,
    # and a dotted label inside a <label> used to pass the tap on to its box. Every kind of dotted label is tried.
    page = b.page
    kinds = {
        "a number box's label (Road detour factor)": 'label:has(input[data-path="detourFactor"]) .help',
        "a box under a slider": 'label:has(input[data-path="priceTarget"]) .help',
        "a land use tick box": 'label:has(input[data-use="farm"]) .help',
        "a Dealbreaker switch": 'label:has(input[data-deal="septic"]) .help',
        "a criterion name": '#c-criteria-list li[data-key="slope"] .order-name .help',
        "a slider title": '.range-pair[data-pair="slope"] .range-head .help',
        "a Costs and loans box": 'label:has(input[data-path="costs.downPayment"]) .help',
    }
    for name, selector in kinds.items():
        if "Costs" in name:
            page.locator("#tab-costs").tap()
        target = page.locator(selector).first
        target.scroll_into_view_if_needed()
        ticked_before = page.is_checked('input[data-use="farm"]') if page.locator('input[data-use="farm"]').is_visible() else None
        target.tap()
        page.wait_for_timeout(400)
        still_open = page.locator("#help-tip").count() == 1
        focus = page.evaluate("() => document.activeElement && document.activeElement.tagName")
        check(f"on a phone, tapping {name} keeps its tip open", still_open)
        check(f"on a phone, tapping {name} does not jump to its box", focus != "INPUT", str(focus))
        if ticked_before is not None and "tick box" in name:
            check("on a phone, tapping a tick box's words does not tick it", page.is_checked('input[data-use="farm"]') == ticked_before)
        page.locator("#criteria-title").tap()   # a tap somewhere else closes it
        page.wait_for_timeout(150)
        check(f"on a phone, a tap elsewhere closes the tip for {name}", page.locator("#help-tip").count() == 0)
    page.locator("#tab-scoring").tap()
    box = page.locator('input[data-use="farm"]')
    box.tap()
    check("on a phone, tapping the tick box itself still ticks it", box.is_checked())
    b.close()


def main():
    headed = "--headed" in sys.argv
    server = start_server()
    print(f"Serving {ROOT} at {SITE}")
    try:
        with sync_playwright() as playwright:
            b = Browser(playwright, headed=headed)
            # These run in order on one browser profile: settings first, so the Census key is set
            # before the parcel is looked up.
            for test in [test_page_and_footer, test_static_hover_help, test_settings, test_sliders_and_uses, test_criteria, test_add_errors,
                         test_address_suggestions, test_full_report, test_road_backup_and_refresh, test_people_and_crime, test_family_needs, test_texas_tax_and_exemptions,
                         test_criteria_order_shows, test_export,
                         test_demo_list_compare, test_list_columns_sort_filter, test_clear_data]:
                try:
                    test(b)
                except Exception as error:   # one broken test should not hide the results of the rest
                    check(f"{test.__name__} ran to the end", False, f"{type(error).__name__}: {error}".splitlines()[0])
                    for dialog in ["dlg-detail", "dlg-add", "dlg-criteria", "dlg-compare"]:
                        b.page.evaluate(f"() => document.getElementById('{dialog}').open && document.getElementById('{dialog}').close()")
            b.close()
            for test in [test_everything_down, test_phone_width]:
                try:
                    test(playwright, headed)
                except Exception as error:
                    check(f"{test.__name__} ran to the end", False, f"{type(error).__name__}: {error}".splitlines()[0])
    finally:
        server.shutdown()

    print(f"\n{len(passed)}/{len(passed) + len(failed)} checks passed")
    if failed:
        print("\nFailed:")
        for item in failed:
            print(f"  - {item}")
        sys.exit(1)


if __name__ == "__main__":
    main()
