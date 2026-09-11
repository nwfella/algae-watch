#!/usr/bin/env python3
"""AlgaeWatch Phase 1 collector.

Builds data/algaewatch_data.json from exclusively official U.S. federal
sources. Python standard library only (target Python 3.11+).
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PROBE_DIR = REPO_ROOT / "_probe"
OUT_PATH = REPO_ROOT / "data" / "algaewatch_data.json"

BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
APP_UA = "(algaewatch/1.0)"

# The single documented exception to the .gov-only rule (USGS + EPA + NGWMN joint).
GOV_EXCEPTION = "www.waterqualitydata.us"

# Freshness budgets in hours (SPEC.md §9 / PHASE1_BRIEF.md #7).
SOURCES = [
    {
        "id": "cyan",
        "name": "NOAA CoastWatch CyAN",
        "url": "https://coastwatch.noaa.gov/erddap/griddap/noaacwNPPN20S3ASCIDINEOF2kmDaily.csv",
        "agency": "NOAA",
        "freshness_budget_hours": 72,  # <= 3 days
    },
    {
        "id": "wqp",
        "name": "Water Quality Portal (USGS + EPA) lab cyanotoxins",
        "url": "https://www.waterqualitydata.us/data/Result/search",
        "agency": "USGS + EPA",
        "freshness_budget_hours": 1080,  # <= 45 days
    },
    {
        "id": "usgs",
        "name": "USGS Water Data OGC API",
        "url": "https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items",
        "agency": "USGS",
        "freshness_budget_hours": 168,  # <= 7 days
    },
    {
        "id": "nws",
        "name": "NWS active alerts (api.weather.gov)",
        "url": "https://api.weather.gov/alerts/active",
        "agency": "NOAA / NWS",
        "freshness_budget_hours": 24,  # <= 24 h
    },
]

# Three characteristics are expected to return rows. Anatoxin-a is the one
# legitimately-empty characteristic, so it is declared with expect_zero.
# Names must match WQP's `characteristicname` code list EXACTLY — it is
# case-sensitive and returns HTTP 400 (empty body) for an unknown name.
# Verified 2026-09-11 against https://www.waterqualitydata.us/Codes/characteristicname:
#   'Anatoxin-a' (lowercase final a) is NOT valid; 'Anatoxin-A' is.
WQP_CHARACTERISTICS = {
    "Microcystin": {"expect_zero": False},
    "Cylindrospermopsin": {"expect_zero": False},
    "Saxitoxin": {"expect_zero": False},
    "Anatoxin-A": {"expect_zero": True},
}

USGS_PARAM_CODES = {"32266": "chlorophyll_a_bluegreen", "32267": "phycocyanin"}

# Cached fixtures used by --offline so the pipeline is testable with no network.
# These mirror the live responses captured 2026-09-11.
USGS_SENSORS_CACHED = {
    "features": [
        {
            "properties": {
                "monitoring_location_id": "USGS-01670209",
                "parameter_code": "32266",
                "time": "2025-01-14T17:30:00+00:00",
                "value": "3.18",
                "unit_of_measure": "ug/l",
            },
            "geometry": {"coordinates": [-77.89483611111112, 38.13868333333333]},
        },
        {
            "properties": {
                "monitoring_location_id": "USGS-01670310",
                "parameter_code": "32266",
                "time": "2025-01-14T17:30:00+00:00",
                "value": "0.27",
                "unit_of_measure": "ug/l",
            },
            "geometry": {"coordinates": [-77.8861111111111, 38.14083333333333]},
        },
        {
            "properties": {
                "monitoring_location_id": "USGS-01670500",
                "parameter_code": "32266",
                "time": "2025-01-14T17:30:00+00:00",
                "value": "0.34",
                "unit_of_measure": "ug/l",
            },
            "geometry": {"coordinates": [-77.86944444444444, 38.15166666666667]},
        },
        {
            "properties": {
                "monitoring_location_id": "USGS-01670209",
                "parameter_code": "32267",
                "time": "2025-01-14T17:30:00+00:00",
                "value": "0.00",
                "unit_of_measure": "ug/l",
            },
            "geometry": {"coordinates": [-77.89483611111112, 38.13868333333333]},
        },
        {
            "properties": {
                "monitoring_location_id": "USGS-01670144",
                "parameter_code": "32267",
                "time": "2025-01-14T14:15:00+00:00",
                "value": "0.00",
                "unit_of_measure": "ug/l",
            },
            "geometry": {"coordinates": [-77.8811111111111, 38.12527777777778]},
        },
        {
            "properties": {
                "monitoring_location_id": "USGS-016702576",
                "parameter_code": "32267",
                "time": "2025-01-14T19:30:00+00:00",
                "value": "0.00",
                "unit_of_measure": "ug/l",
            },
            "geometry": {"coordinates": [-77.87472222222222, 38.14222222222222]},
        },
    ]
}

USGS_META_CACHED = {
    "USGS-01670209": {"name": "LAKE ANNA NEAR HENRYS POINT NEAR HOLLADAY, VA", "state": "VA", "type": "Lake, Reservoir, Impoundment"},
    "USGS-01670310": {"name": "LAKE ANNA NEAR BUCKERS, VA", "state": "VA", "type": "Lake, Reservoir, Impoundment"},
    "USGS-01670500": {"name": "NORTH ANNA RIVER AT HART CORNER, VA", "state": "VA", "type": "Stream"},
    "USGS-01670144": {"name": "LAKE ANNA NEAR HOLLADAY, VA", "state": "VA", "type": "Lake, Reservoir, Impoundment"},
    "USGS-016702576": {"name": "LAKE ANNA NEAR HENRYS POINT, VA", "state": "VA", "type": "Lake, Reservoir, Impoundment"},
}

NWS_ALERTS_CACHED = [
    {
        "id": "urn:oid:2.49.0.1.840.0.9c9dc90af5845c14c7e36f5a583719b5cff90944.001.1",
        "areaDesc": "Mason; Oceana; Muskegon",
        "sent": "2026-09-11T14:27:00-04:00",
        "event": "Beach Hazards Statement",
        "headline": "Beach Hazards Statement issued September 11 at 2:27PM EDT until September 12 at 8:00PM EDT by NWS Grand Rapids MI",
    },
    {
        "id": "urn:oid:2.49.0.1.840.0.b6a6a52c3c15f3c40e6f90dcb6b58b1e1f8a2c4b.002.1",
        "areaDesc": "Kewaunee; Manitowoc",
        "sent": "2026-09-11T10:00:00-05:00",
        "event": "Beach Hazards Statement",
        "headline": "Beach Hazards Statement issued September 11 at 10:00AM CDT by NWS Green Bay WI",
    },
    {
        "id": "urn:oid:2.49.0.1.840.0.81a69036b8a0d9b1e62b8e33fba6d9218ffb64e2.003.1",
        "areaDesc": "Door; Southern Schoolcraft",
        "sent": "2026-09-11T09:30:00-05:00",
        "event": "Marine Weather Statement",
        "headline": "Marine Weather Statement issued September 11 by NWS Marquette MI",
    },
]

FIPS_TO_STATE = {
    "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT",
    "10": "DE", "11": "DC", "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL",
    "18": "IN", "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD",
    "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT", "31": "NE",
    "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND",
    "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD",
    "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA", "54": "WV",
    "55": "WI", "56": "WY", "60": "AS", "66": "GU", "69": "MP", "72": "PR", "78": "VI",
}

ORG_STATE = {
    "OREGONDEQ": "OR",
    "21IOWA_WQX": "IA",
    "21NEB001_WQX": "NE",
    "UMC": "MO",
    "21FLGW_WQX": "FL",
    "21FLTPA_WQX": "FL",
    "21FLSFWM_WQX": "FL",
    "21NC03WQ": "NC",
    "CA_BVR": "CA",
    "MNPCA": "MN",
    "INSTOR_WQX": "IN",
    "EPA_R7_WQX": "MO",
}

ALL_STATES = [
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL",
    "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT",
    "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
    "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
]


def allowlist_guard(url: str) -> None:
    """Refuse any host that is not *.gov, with one documented exception.

    Raises ValueError naming the offending host — never a warning.
    """
    host = urllib.parse.urlparse(url).hostname or ""
    if host == GOV_EXCEPTION:
        return
    if host.endswith(".gov"):
        return
    raise ValueError(f"allowlist violation: host '{host}' is not a .gov host")


def iso_to_utc(value: str) -> str:
    """Normalise an ISO-8601 timestamp to a naive UTC string for comparisons."""
    value = value.strip()
    if not value:
        return ""
    value = value.replace("Z", "+00:00")
    if re.search(r"[+-]\d{2}:\d{2}$", value):
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is not None:
            dt = dt.astimezone(timezone.utc)
        return dt.replace(tzinfo=None).isoformat(timespec="seconds")
    return value


def parse_wqp_date(value: str) -> str:
    """WQP dates are MM-DD-YYYY (or blank). Return YYYY-MM-DD or empty."""
    value = (value or "").strip()
    if not value:
        return ""
    m = re.match(r"^(\d{1,2})-(\d{1,2})-(\d{4})$", value)
    if not m:
        return value
    month, day, year = m.groups()
    return f"{year}-{int(month):02d}-{int(day):02d}"


def parse_numeric(value: str) -> float | None:
    """Parse a lab result into a float, returning None for non-detects/blank.

    Never converts missing data into 0 — and never lets a NaN/inf through.
    ERDDAP returns the literal string 'NaN' for a pixel with no satellite
    retrieval, and float('NaN') parses happily, so an unguarded parser turns
    'no data' into a float nan that only explodes later at json.dumps time.
    """
    value = (value or "").strip()
    if not value:
        return None
    if value.startswith("<") or value.lower() in {"nd", "not detected"}:
        return None
    try:
        num = float(value)
    except ValueError:
        return None
    # num != num catches NaN; the inf comparisons catch both infinities.
    if num != num or num in (float("inf"), float("-inf")):
        return None
    return num


def state_from_site_id(site_id: str) -> str | None:
    for prefix, state in ORG_STATE.items():
        if site_id.startswith(prefix):
            return state
    return None


def state_from_nws(area_desc: str) -> str | None:
    """Best-effort state for an NWS advisory area description."""
    area = (area_desc or "").upper()
    tokens = re.split(r"[;,]|\s+", area)
    county_state = {
        "KEWAUNEE": "WI", "MANITOWOC": "WI", "DOOR": "WI", "SCHOOLCRAFT": "MI",
        "MASON": "MI", "OCEANA": "MI", "MUSKEGON": "MI",
    }
    for token in tokens:
        if token in FIPS_TO_STATE.values():
            return token
    for token in tokens:
        if token in county_state:
            return county_state[token]
    return None


def http_get(url: str, ua: str = BROWSER_UA, timeout: int = 30) -> bytes:
    allowlist_guard(url)
    req = urllib.request.Request(url, headers={"User-Agent": ua})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as exc:
        # Never let an HTTP failure surface without its reason. WQP answers an
        # unknown characteristicName with a bare HTTP 400 and an EMPTY body,
        # which is otherwise indistinguishable from a transient fault.
        body = b""
        try:
            body = exc.read() or b""
        except Exception:  # pragma: no cover - defensive
            pass
        detail = body.decode("utf-8", errors="replace").strip()[:400] or "(empty response body)"
        raise SystemExit(
            f"fail loudly: HTTP {exc.code} from {url}\n  server said: {detail}"
        ) from exc


def http_get_json(url: str, ua: str = BROWSER_UA) -> object:
    return json.loads(http_get(url, ua).decode("utf-8"))


def load_json(path: Path) -> object:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def load_wqp_results(offline: bool, now: datetime) -> tuple[list[dict], dict[str, dict]]:
    """Return (result rows, station index)."""
    rows: list[dict] = []
    stations: dict[str, dict] = {}
    rows_per_char: dict[str, int] = {}

    if offline:
        station_path = PROBE_DIR / "habsites.csv"
        if station_path.exists():
            with station_path.open("r", encoding="utf-8", newline="") as fh:
                for row in csv.DictReader(fh):
                    sid = (row.get("MonitoringLocationIdentifier") or "").strip()
                    if sid:
                        state_code = (row.get("StateCode") or "").strip()
                        stations[sid] = {
                            "name": (row.get("MonitoringLocationName") or "").strip() or sid,
                            "lat": parse_numeric(row.get("LatitudeMeasure")),
                            "lon": parse_numeric(row.get("LongitudeMeasure")),
                            "state": FIPS_TO_STATE.get(state_code, state_from_site_id(sid)),
                            "type": (row.get("MonitoringLocationTypeName") or "").strip() or "Waterbody",
                        }
        for char, cfg in WQP_CHARACTERISTICS.items():
            if cfg["expect_zero"]:
                continue
            path = PROBE_DIR / f"cy_{char}.csv"
            if not path.exists():
                if not cfg["expect_zero"]:
                    raise SystemExit(f"fail loudly: expected WQP {char} rows, but {path} is missing")
                continue
            count = 0
            with path.open("r", encoding="utf-8", newline="") as fh:
                for row in csv.DictReader(fh):
                    sid = (row.get("MonitoringLocationIdentifier") or "").strip()
                    value = parse_numeric(row.get("ResultMeasureValue"))
                    rows.append(
                        {
                            "site_id": sid,
                            "param": (row.get("CharacteristicName") or char).lower(),
                            "value": value,
                            "unit": (row.get("ResultMeasure/MeasureUnitCode") or "ug/L").strip(),
                            "ts": parse_wqp_date(row.get("ActivityStartDate") or ""),
                            "source_id": "wqp",
                            "method": "lab",
                            "raw_char": (row.get("CharacteristicName") or char).strip(),
                        }
                    )
                    count += 1
            rows_per_char[char] = count
            if count == 0 and not cfg["expect_zero"]:
                raise SystemExit(f"fail loudly: WQP {char} returned 0 rows")
    else:
        station_url = (
            "https://www.waterqualitydata.us/data/Station/search"
            "?characteristicName=Microcystin&mimeType=csv&zip=no"
        )
        station_csv = http_get(station_url, ua=BROWSER_UA).decode("utf-8", errors="replace")
        for row in csv.DictReader(station_csv.splitlines()):
            sid = (row.get("MonitoringLocationIdentifier") or "").strip()
            if sid:
                state_code = (row.get("StateCode") or "").strip()
                stations[sid] = {
                    "name": (row.get("MonitoringLocationName") or "").strip() or sid,
                    "lat": parse_numeric(row.get("LatitudeMeasure")),
                    "lon": parse_numeric(row.get("LongitudeMeasure")),
                    "state": FIPS_TO_STATE.get(state_code, state_from_site_id(sid)),
                    "type": (row.get("MonitoringLocationTypeName") or "").strip() or "Waterbody",
                }

        start = (now - timedelta(days=365)).strftime("%m-%d-%Y")
        end = now.strftime("%m-%d-%Y")
        for char, cfg in WQP_CHARACTERISTICS.items():
            url = (
                "https://www.waterqualitydata.us/data/Result/search"
                f"?characteristicName={urllib.parse.quote(char)}&mimeType=csv&zip=no"
                f"&startDateLo={start}&startDateHi={end}"
            )
            body = http_get(url, ua=BROWSER_UA).decode("utf-8", errors="replace")
            count = 0
            for row in csv.DictReader(body.splitlines()):
                sid = (row.get("MonitoringLocationIdentifier") or "").strip()
                rows.append(
                    {
                        "site_id": sid,
                        "param": (row.get("CharacteristicName") or char).lower(),
                        "value": parse_numeric(row.get("ResultMeasureValue")),
                        "unit": (row.get("ResultMeasure/MeasureUnitCode") or "ug/L").strip(),
                        "ts": parse_wqp_date(row.get("ActivityStartDate") or ""),
                        "source_id": "wqp",
                        "method": "lab",
                        "raw_char": (row.get("CharacteristicName") or char).strip(),
                    }
                )
                count += 1
            rows_per_char[char] = count
            if count == 0 and not cfg["expect_zero"]:
                raise SystemExit(f"fail loudly: WQP {char} returned 0 rows")

    return rows, stations


def load_usgs(offline: bool) -> tuple[list[dict], dict[str, dict]]:
    if offline:
        features = USGS_SENSORS_CACHED["features"]
        meta = dict(USGS_META_CACHED)
    else:
        features: list[dict] = []
        for code in USGS_PARAM_CODES:
            url = (
                "https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items"
                f"?f=json&parameter_code={code}&limit=2000"
            )
            data = http_get_json(url)
            features.extend(data.get("features", []))
        meta: dict[str, dict] = {}
        site_numbers = sorted(
            {f["properties"].get("monitoring_location_id", "") for f in features}
        )
        for site_id in site_numbers:
            number = site_id.split("-", 1)[1] if site_id.startswith("USGS-") else site_id
            url = (
                "https://api.waterdata.usgs.gov/ogcapi/v0/collections/monitoring-locations/items"
                f"?f=json&monitoring_location_number={number}"
            )
            data = http_get_json(url)
            feats = data.get("features", [])
            if feats:
                props = feats[0]["properties"]
                meta[site_id] = {
                    "name": props.get("monitoring_location_name") or site_id,
                    "state": FIPS_TO_STATE.get(str(props.get("state_code") or "").strip()),
                    "type": props.get("site_type") or "Waterbody",
                }

    obs: list[dict] = []
    for f in features:
        props = f["properties"]
        site_id = props.get("monitoring_location_id", "")
        code = props.get("parameter_code", "")
        value = parse_numeric(props.get("value"))
        ts = iso_to_utc(props.get("time") or "")
        m = meta.get(site_id, {})
        obs.append(
            {
                "site_id": site_id,
                "param": USGS_PARAM_CODES.get(code, code),
                "value": value,
                "unit": (props.get("unit_of_measure") or "ug/l").strip(),
                "ts": ts,
                "source_id": "usgs",
                "method": "sensor",
                "meta": {
                    "name": m.get("name") or site_id,
                    "state": m.get("state"),
                    "type": m.get("type") or "Waterbody",
                },
            }
        )
    return obs, meta


def load_nws(offline: bool) -> list[dict]:
    if offline:
        alerts = list(NWS_ALERTS_CACHED)
    else:
        alerts: list[dict] = []
        for event in ("Beach Hazards Statement", "Marine Weather Statement"):
            url = (
                "https://api.weather.gov/alerts/active"
                f"?event={urllib.parse.quote(event)}"
            )
            data = http_get_json(url, ua=APP_UA)
            for feature in data.get("features", []):
                props = feature.get("properties", {})
                alerts.append(
                    {
                        "id": props.get("id", ""),
                        "areaDesc": props.get("areaDesc", ""),
                        "sent": props.get("sent", ""),
                        "event": props.get("event", event),
                        "headline": props.get("headline", ""),
                    }
                )
    return alerts


def deterministic_grid(site_id: str, pad: float, rows: int, cols: int) -> tuple[list[list[float | None]], float | None]:
    """Deterministic offline stand-in for a CyAN slice.

    Produces a mix of null (no retrieval) and positive values. NaN is never
    coerced to 0; missing pixels stay null.
    """
    seed = 0
    for ch in site_id:
        seed = (seed * 131 + ord(ch)) & 0xFFFFFFFF
    grid: list[list[float | None]] = []
    values: list[float] = []
    for r in range(rows):
        row: list[float | None] = []
        for c in range(cols):
            h = (seed + r * 73856093 + c * 19349663) & 0xFFFFFFFF
            if h % 5 == 0:
                row.append(None)
            else:
                v = 0.5 + ((h >> 8) % 4000) / 100.0
                row.append(round(v, 4))
                values.append(v)
        grid.append(row)
    mean = round(sum(values) / len(values), 4) if values else None
    return grid, mean


CYAN_INFO_URL = (
    "https://coastwatch.noaa.gov/erddap/info/"
    "noaacwNPPN20S3ASCIDINEOF2kmDaily/index.csv"
)


def cyan_available_through() -> str:
    """Newest date the CyAN dataset actually serves.

    The dataset LAGS real time — observed on 2026-09-11 its time axis ended
    2026-08-31, an ~11 day publication lag. Requesting 'yesterday' therefore
    fails with HTTP 404 "Constraint ... is greater than the axis maximum".
    """
    text = http_get(CYAN_INFO_URL, timeout=90).decode("utf-8", errors="replace")
    for line in text.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 5 and parts[2] == "time_coverage_end":
            return parts[4].strip()[:10]
    raise SystemExit("fail loudly: CyAN info response has no time_coverage_end")


def cyan_window_end(now: datetime, offline: bool) -> str:
    """Newest date to request: never later than the dataset's axis max."""
    yesterday = (now - timedelta(days=1)).strftime("%Y-%m-%d")
    if offline:
        return yesterday
    return min(yesterday, cyan_available_through())


def load_cyan(offline: bool, watchlist: list[dict], now: datetime, pad: float, max_requests: int, window: int = 7) -> list[dict]:
    """Fetch a padded bbox slice per watchlist site and form a weekly composite.

    The composite is the cell-wise mean of non-null values across the rolling
    window; a cell with no retrieval anywhere stays null (never 0).
    """
    window = max(window, 1)
    sat_entries: list[dict] = []
    requests = 0
    latest_date = (now - timedelta(days=1)).strftime("%Y-%m-%d")
    window_end = cyan_window_end(now, offline)
    window_end_dt = datetime.fromisoformat(window_end)

    for site in watchlist:
        if requests >= max_requests:
            break
        lat = site.get("lat")
        lon = site.get("lon")
        if lat is None or lon is None:
            continue
        lat_lo = round(lat - pad, 6)
        lat_hi = round(lat + pad, 6)
        lon_lo = round(lon - pad, 6)
        lon_hi = round(lon + pad, 6)
        bbox = [lat_lo, lon_lo, lat_hi, lon_hi]

        synthetic = bool(offline)
        dated_grids: list[tuple[str, list[list[float | None]]]] = []
        if offline:
            dated_grids = [(latest_date, deterministic_grid(site["id"], pad, rows=5, cols=6)[0])]
        else:
            for day in range(window):
                if requests >= max_requests:
                    break
                date = (window_end_dt - timedelta(days=day)).strftime("%Y-%m-%d")
                query = (
                    f"chlor_a%5B({date})%5D%5B(0.0)%5D"
                    f"%5B({lat_lo}):1:({lat_hi})%5D%5B({lon_lo}):1:({lon_hi})%5D"
                )
                url = (
                    "https://coastwatch.noaa.gov/erddap/griddap/"
                    f"noaacwNPPN20S3ASCIDINEOF2kmDaily.csv?{query}"
                )
                body = http_get(url, ua=BROWSER_UA).decode("utf-8", errors="replace")
                requests += 1
                dated_grids.append((date, parse_cyan_csv(body)))

        daily_grids = [g for _, g in dated_grids]
        grid = composite_grid(daily_grids)
        mean = grid_mean(grid)
        # Report the NEWEST day that actually returned a value. Using the
        # requested date would claim freshness we never received.
        days_with_data = [
            d for d, g in dated_grids if any(v is not None for row in g for v in row)
        ]
        entry = {
            "site_id": site["id"],
            "date": max(days_with_data) if days_with_data else None,
            "bbox": bbox,
            "grid": grid,
            "res_km": 2,
            "mean": mean,
            "days_with_data": len(days_with_data),
            "window_days": len(dated_grids),
        }
        if synthetic:
            entry["synthetic"] = True
        sat_entries.append(entry)

    uncovered = [
        w["id"] for w in watchlist if w["id"] not in {e["site_id"] for e in sat_entries}
    ]
    if uncovered:
        print(
            f"WARNING: CyAN request cap reached — no satellite slice for "
            f"{len(uncovered)} of {len(watchlist)} watchlist sites: "
            + ", ".join(uncovered[:5])
            + (" ..." if len(uncovered) > 5 else ""),
            file=sys.stderr,
        )
    return sat_entries


def parse_cyan_csv(body: str) -> list[list[float | None]]:
    """Parse a CyAN ERDDAP CSV into a 2-D grid of chlor_a values.

    Rows are latitude bands (high to low); columns are longitude (low to high).
    NaN (no satellite retrieval) stays null, never 0.
    """
    lat_bands: dict[str, dict[str, float | None]] = {}
    for line in body.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split(",")]
        if not parts or parts[0] in {"time", "UTC"}:
            continue
        if len(parts) < 5:
            continue
        time, altitude, lat, lon, value = parts[0], parts[1], parts[2], parts[3], parts[4]
        lat_bands.setdefault(lat, {})[lon] = parse_numeric(value)

    grid: list[list[float | None]] = []
    for lat in sorted(lat_bands, reverse=True):
        grid.append([lat_bands[lat][lon] for lon in sorted(lat_bands[lat])])
    return grid


def composite_grid(daily_grids: list[list[list[float | None]]]) -> list[list[float | None]]:
    """Cell-wise mean of non-null values across daily grids."""
    if not daily_grids:
        return []
    rows = max(len(g) for g in daily_grids)
    cols = max(len(g[0]) for g in daily_grids if g)
    out: list[list[float | None]] = []
    for r in range(rows):
        out_row: list[float | None] = []
        for c in range(cols):
            vals = [g[r][c] for g in daily_grids if r < len(g) and c < len(g[r]) and g[r][c] is not None]
            out_row.append(round(sum(vals) / len(vals), 4) if vals else None)
        out.append(out_row)
    return out


def grid_mean(grid: list[list[float | None]]) -> float | None:
    vals = [v for row in grid for v in row if v is not None]
    return round(sum(vals) / len(vals), 4) if vals else None


def build_sites(observations: list[dict], stations: dict[str, dict], watchlist: list[dict], usgs_meta: dict[str, dict]) -> list[dict]:
    watch_ids = {w["id"] for w in watchlist}
    sites: dict[str, dict] = {}

    for obs in observations:
        sid = obs["site_id"]
        if not sid or sid in sites:
            continue
        if obs["source_id"] == "usgs":
            meta = usgs_meta.get(sid, {})
            sites[sid] = {
                "id": sid,
                "name": meta.get("name") or sid,
                "lat": None,
                "lon": None,
                "state": meta.get("state"),
                "type": meta.get("type") or "Waterbody",
                "agency": "USGS",
                "watch": sid in watch_ids,
            }
        elif obs["source_id"] == "nws":
            meta = obs.get("meta") or {}
            sites[sid] = {
                "id": sid,
                "name": meta.get("area") or meta.get("headline") or sid,
                "lat": None,
                "lon": None,
                "state": state_from_nws(meta.get("area") or ""),
                "type": "Advisory area",
                "agency": "NWS",
                "watch": sid in watch_ids,
            }
        else:
            st = stations.get(sid, {})
            sites[sid] = {
                "id": sid,
                "name": st.get("name") or sid,
                "lat": st.get("lat"),
                "lon": st.get("lon"),
                "state": st.get("state") or state_from_site_id(sid),
                "type": st.get("type") or "Waterbody",
                "agency": "USGS + EPA",
                "watch": sid in watch_ids,
            }

    for w in watchlist:
        if w["id"] not in sites:
            sites[w["id"]] = {
                "id": w["id"],
                "name": w.get("name") or w["id"],
                "lat": w.get("lat"),
                "lon": w.get("lon"),
                "state": w.get("state"),
                "type": w.get("type") or "Waterbody",
                "agency": w.get("agency") or "USGS/EPA WQP",
                "watch": True,
            }

    return [sites[k] for k in sorted(sites)]


def build_alerts(observations: list[dict], criteria: dict, watchlist: list[dict]) -> list[dict]:
    watch_ids = {w["id"] for w in watchlist}
    alerts: list[dict] = []
    verified = bool(criteria.get("verified", False))
    routes = criteria.get("routes", {})

    for obs in observations:
        if obs["source_id"] != "wqp" or obs["value"] is None:
            continue
        if obs["site_id"] not in watch_ids:
            continue
        for route_key, route in routes.items():
            for crit in route.get("criteria", []):
                if crit["param"] != obs["param"]:
                    continue
                value = obs["value"]
                criterion = crit["value"]
                if value >= criterion:
                    level = "exceedance"
                elif value >= criterion * 0.75:
                    level = "approaching"
                else:
                    continue
                criterion_src = f"{route['label']} — {crit['citation']}"
                if not verified:
                    criterion_src += " (VERIFY)"
                alerts.append(
                    {
                        "site_id": obs["site_id"],
                        "param": obs["param"],
                        "value": value,
                        "criterion": criterion,
                        "criterion_src": criterion_src,
                        "level": level,
                        "ts": obs["ts"],
                        "verified": verified,
                    }
                )
    return alerts


def add_nws(nws_alerts: list[dict], observations: list[dict], alerts: list[dict], now: datetime) -> None:
    for a in nws_alerts:
        sent = iso_to_utc(a.get("sent", ""))
        obs = {
            "site_id": "NWS-" + (a.get("id", "") or a.get("areaDesc", "alert")),
            "param": re.sub(r"\W+", "_", a.get("event", "alert")).lower(),
            "value": None,
            "unit": "event",
            "ts": sent,
            "source_id": "nws",
            "method": "advisory",
            "meta": {"area": a.get("areaDesc", ""), "headline": a.get("headline", "")},
        }
        observations.append(obs)
        alerts.append(
            {
                "site_id": obs["site_id"],
                "param": obs["param"],
                "value": None,
                "criterion": None,
                "criterion_src": "NWS active alerts",
                "level": "advisory",
                "ts": sent,
                "verified": False,
            }
        )


def source_last_updated(observations: list[dict], sat_entries: list[dict]) -> dict[str, str]:
    last: dict[str, str] = {}
    for src in SOURCES:
        src_obs = [o["ts"] for o in observations if o["source_id"] == src["id"] and o["ts"]]
        if src["id"] == "cyan":
            for s in sat_entries:
                if s.get("date"):
                    src_obs.append(s["date"])
        if src_obs:
            last[src["id"]] = max(src_obs)
        else:
            last[src["id"]] = ""
    return last


def is_stale(ts: str, budget_hours: int, now: datetime) -> bool:
    if not ts:
        return True
    try:
        dt = datetime.fromisoformat(ts)
    except ValueError:
        return True
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return (now.replace(tzinfo=None) - dt) > timedelta(hours=budget_hours)


def compute_coverage(sites: list[dict]) -> dict:
    with_data = sorted({s["state"] for s in sites if s.get("state")})
    no_data = [s for s in ALL_STATES if s not in with_data]
    return {
        "states_with_data": with_data,
        "states_no_data": no_data,
        "note": "Absence of data is not absence of blooms.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="AlgaeWatch Phase 1 collector")
    parser.add_argument("--offline", action="store_true", help="read _probe/*.csv + cached fixtures instead of the network")
    parser.add_argument("--now", default=None, help="ISO-8601 UTC reference timestamp (default: now)")
    parser.add_argument("--window", type=int, default=7, help="CyAN rolling window days (default 7)")
    parser.add_argument("--pad", type=float, default=0.3, help="CyAN bbox padding in degrees (default 0.3)")
    parser.add_argument("--max-requests", type=int, default=None, help="cap on CyAN requests (default: watchlist sites x window)")
    parser.add_argument("--allowlist-check", metavar="FILE", help="validate every sources[].url in a JSON blob against the .gov allowlist, then exit")
    args = parser.parse_args()

    if args.allowlist_check:
        blob = load_json(Path(args.allowlist_check))
        for source in blob.get("sources", []):
            allowlist_guard(source["url"])
        print("allowlist check passed")
        return 0

    if args.now:
        now = datetime.fromisoformat(args.now.replace("Z", "+00:00"))
        if now.tzinfo is not None:
            now = now.astimezone(timezone.utc).replace(tzinfo=None)
    else:
        now = datetime.now(timezone.utc).replace(tzinfo=None)

    criteria = load_json(REPO_ROOT / "collector" / "criteria.json")
    watchlist = load_json(REPO_ROOT / "collector" / "watchlist.json")

    # Default the CyAN cap to full watchlist coverage so a default run cannot
    # silently drop sites from the satellite layer.
    if args.max_requests is None:
        args.max_requests = max(40, len(watchlist) * max(args.window, 1))

    wqp_rows, stations = load_wqp_results(args.offline, now)
    usgs_obs, usgs_meta = load_usgs(args.offline)
    nws_alerts = load_nws(args.offline)
    sat_entries = load_cyan(args.offline, watchlist, now, args.pad, args.max_requests, args.window)

    observations: list[dict] = list(wqp_rows)
    observations.extend(usgs_obs)

    for src in SOURCES:
        budget = src["freshness_budget_hours"]
        for obs in observations:
            if obs["source_id"] == src["id"]:
                obs["stale"] = is_stale(obs["ts"], budget, now)

    for s in sat_entries:
        obs = {
            "site_id": s["site_id"],
            "param": "cyan_index",
            "value": s["mean"],
            "unit": "mg m^-3",
            "ts": s["date"],
            "source_id": "cyan",
            "method": "satellite",
        }
        if s.get("synthetic"):
            obs["synthetic"] = True
        obs["stale"] = is_stale(obs["ts"], 72, now)
        observations.append(obs)

    alerts = build_alerts(observations, criteria, watchlist)
    add_nws(nws_alerts, observations, alerts, now)

    sites = build_sites(observations, stations, watchlist, usgs_meta)
    coverage = compute_coverage(sites)
    freshness = source_last_updated(observations, sat_entries)

    sources_out = []
    for src in SOURCES:
        entry = dict(src)
        entry["last_updated"] = freshness.get(src["id"], "")
        sources_out.append(entry)

    baselines = []
    for s in sat_entries:
        mean = s["mean"]
        if mean is None or not s.get("date"):
            continue
        try:
            doy = datetime.fromisoformat(s["date"]).timetuple().tm_yday
        except ValueError:
            doy = 0
        baselines.append(
            {
                "site_id": s["site_id"],
                "doy": doy,
                "mean": mean,
                "p90": mean,
                "years": 1,
                # Single-window stand-in, NOT the 2018-present day-of-year
                # baseline the spec calls for. Flagged so the UI cannot
                # present it as a multi-year climatology.
                "estimated": True,
                "source": "cyan",
            }
        )

    output = {
        "generated_utc": now.replace(microsecond=0).isoformat().replace(" ", "T") + "Z",
        # Provenance: 'offline' means the satellite layer is SYNTHETIC and must
        # never be shipped. verify_site.js refuses offline blobs by default.
        "mode": "offline" if args.offline else "live",
        "freshness": freshness,
        "sites": sites,
        "observations": observations,
        "satellite": [
            {
                "site_id": s["site_id"],
                "date": s["date"],
                "bbox": s["bbox"],
                "grid": s["grid"],
                "res_km": s["res_km"],
                "days_with_data": s.get("days_with_data"),
                "window_days": s.get("window_days"),
                **({"synthetic": True} if s.get("synthetic") else {}),
            }
            for s in sat_entries
        ],
        "alerts": alerts,
        "baselines": baselines,
        "coverage": coverage,
        "sources": sources_out,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(output, sort_keys=True, allow_nan=False, ensure_ascii=False)
    OUT_PATH.write_text(payload, encoding="utf-8")

    wqp_count = len(wqp_rows)
    print(f"wrote {OUT_PATH}")
    print(f"WQP cyanotoxin rows reconciled: {wqp_count}")
    print(f"observations: {len(observations)}")
    print(f"sites: {len(sites)}")
    print(f"alerts: {len(alerts)}")
    print(f"states_with_data: {len(coverage['states_with_data'])}")
    print(f"states_no_data: {len(coverage['states_no_data'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
