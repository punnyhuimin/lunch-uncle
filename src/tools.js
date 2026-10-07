/**
 * Tool definitions and implementations for Lunch Uncle.
 *
 * Each tool is split in two: a fetch function that talks to the network,
 * and a pure format function that shapes the response for the model.
 * The format functions are the ones covered by tests.
 */

import { cached, cacheKey, TTL_SECONDS } from "./cache.js";

// CT Hub 2, 114 Lavender Street.
export const CT_HUB_2 = { latitude: 1.3115, longitude: 103.8615 };

const SEARCH_RADIUS_METRES = 800;
const MAX_PLACES = 10;
const FORECAST_AREA = "Kallang";

const TOOL_TIMEOUT_MS = 8_000;

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const FORECAST_URL =
  "https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast";
const BUS_URL = "https://arrivelah2.busrouter.sg/";

// ---------------------------------------------------------------------------
// Definitions sent to the model
// ---------------------------------------------------------------------------

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "find_lunch_places",
      description:
        "Search for places to eat near CT Hub 2. Returns name, rating, distance and whether it is open now.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'What to search for, e.g. "chicken rice", "japanese", "cheap lunch".',
          },
          open_now: {
            type: "boolean",
            description: "Only return places that are open right now.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_rain_forecast",
      description:
        "Get the two-hour weather forecast for the Kallang area, which covers CT Hub 2.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_bus_arrivals",
      description:
        "Get the next bus arrivals at a Singapore bus stop, by five-digit stop code.",
      parameters: {
        type: "object",
        properties: {
          stop_code: {
            type: "string",
            description: 'Five-digit bus stop code, e.g. "07371".',
          },
        },
        required: ["stop_code"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Run one tool call requested by the model and return the result as a string.
 */
export async function executeTool(name, args, env) {
  try {
    switch (name) {
      case "find_lunch_places":
        return JSON.stringify(
          await cached(
            cacheKey("places", [String(args.query ?? "").trim().toLowerCase(), args.open_now === true]),
            TTL_SECONDS.places,
            () => findLunchPlaces(args, env),
          ),
        );
      case "get_rain_forecast":
        return JSON.stringify(
          await cached(cacheKey("forecast", [FORECAST_AREA]), TTL_SECONDS.forecast, () =>
            getRainForecast(),
          ),
        );
      case "get_bus_arrivals":
        return JSON.stringify(
          await cached(
            cacheKey("bus", [normaliseStopCode(args.stop_code)]),
            TTL_SECONDS.bus,
            () => getBusArrivals(args),
          ),
        );
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    // Network failure, timeout or bad payload: let the model tell the user.
    console.error(`tool ${name} failed:`, err);
    return JSON.stringify({ error: `${name} failed, try again or answer without it.` });
  }
}

// ---------------------------------------------------------------------------
// find_lunch_places
// ---------------------------------------------------------------------------

async function findLunchPlaces({ query, open_now = false }, env) {
  const centre = CT_HUB_2;

  const body = {
    textQuery: query,
    includedType: "restaurant",
    openNow: open_now,
    pageSize: MAX_PLACES,
    locationBias: {
      circle: { center: centre, radius: SEARCH_RADIUS_METRES },
    },
  };

  const res = await fetch(PLACES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.location,places.rating,places.currentOpeningHours",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  });

  if (!res.ok) {
    return { error: `Places API returned ${res.status}` };
  }

  const data = await res.json();
  return { places: formatPlaces(data.places ?? [], centre) };
}

/**
 * Shape Places API results into the fields Uncle needs.
 *
 * locationBias is only a preference, so Places can return spots far away.
 * Drop anything beyond maxDistance and list the nearest first. A place with
 * no location cannot be measured, so it goes last.
 */
export function formatPlaces(places, origin, maxDistance = SEARCH_RADIUS_METRES) {
  return places
    .map(({ displayName, rating, location, currentOpeningHours }) => ({
      name: displayName?.text ?? "Unnamed",
      rating: rating ?? null,
      distance_m: location ? Math.round(haversineMetres(origin, location)) : null,
      open_now: currentOpeningHours?.openNow ?? null,
    }))
    .filter((p) => p.distance_m === null || p.distance_m <= maxDistance)
    .sort(
      (a, b) =>
        (a.distance_m ?? Infinity) - (b.distance_m ?? Infinity),
    );
}

/**
 * Great-circle distance between two {latitude, longitude} points, in metres.
 */
export function haversineMetres(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------
// get_rain_forecast
// ---------------------------------------------------------------------------

async function getRainForecast() {
  const res = await fetch(FORECAST_URL, { signal: AbortSignal.timeout(TOOL_TIMEOUT_MS) });
  if (!res.ok) {
    return { error: `Forecast API returned ${res.status}` };
  }
  return formatForecast(await res.json(), FORECAST_AREA);
}

/**
 * Pull one area's forecast out of the data.gov.sg two-hour forecast payload.
 */
export function formatForecast(payload, area, now = new Date()) {
  const item = payload?.data?.items?.[0];
  if (!item) {
    return { error: "No forecast available" };
  }
  const end = Date.parse(item.valid_period?.end);
  if (!Number.isNaN(end) && end < now.getTime()) {
    return { error: "Forecast is out of date" };
  }
  const entry = item.forecasts?.find((f) => f.area === area);
  if (!entry?.forecast) {
    // Do not report "Unknown" as a forecast: the model may read it as no rain.
    return { error: `No forecast for ${area}` };
  }
  return {
    area,
    forecast: entry.forecast,
    valid_period: item.valid_period?.text ?? null,
  };
}

// ---------------------------------------------------------------------------
// get_bus_arrivals
// ---------------------------------------------------------------------------

/**
 * Bus stop codes are five digits and can start with 0. The model sometimes
 * sends a number, which drops the zero, so pad short numeric codes.
 * Returns null if the code cannot be a stop code.
 */
export function normaliseStopCode(raw) {
  const text = String(raw ?? "").trim();
  return /^\d{1,5}$/.test(text) ? text.padStart(5, "0") : null;
}

async function getBusArrivals({ stop_code }) {
  const code = normaliseStopCode(stop_code);
  if (!code) {
    return { error: "stop_code must be a five-digit bus stop code" };
  }
  stop_code = code;
  const url = `${BUS_URL}?id=${encodeURIComponent(stop_code)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TOOL_TIMEOUT_MS) });
  if (!res.ok) {
    return { error: `Bus API returned ${res.status}` };
  }
  return formatBusArrivals(await res.json(), stop_code);
}

/**
 * Reduce an arrivelah response to service numbers and minutes to arrival.
 */
export function formatBusArrivals(payload, stopCode) {
  const services = payload?.services ?? [];
  return {
    stop_code: stopCode,
    services: services.map((s) => ({
      service: s.no,
      next_min: minutesFromNow(s.next),
      subsequent_min: minutesFromNow(s.subsequent),
    })),
  };
}

function minutesFromNow(arrival) {
  if (!arrival || typeof arrival.duration_ms !== "number") {
    return null;
  }
  return Math.max(0, Math.round(arrival.duration_ms / 60000));
}
