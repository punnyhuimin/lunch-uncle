import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatForecast,
  formatBusArrivals,
  formatPlaces,
  haversineMetres,
  normaliseStopCode,
} from "../src/tools.js";

test("formatForecast picks the requested area", () => {
  const payload = {
    data: {
      items: [
        {
          valid_period: { text: "12 pm to 2 pm" },
          forecasts: [
            { area: "Geylang", forecast: "Fair" },
            { area: "Kallang", forecast: "Light Rain" },
          ],
        },
      ],
    },
  };

  assert.deepEqual(formatForecast(payload, "Kallang"), {
    area: "Kallang",
    forecast: "Light Rain",
    valid_period: "12 pm to 2 pm",
  });
});

test("formatBusArrivals converts durations to whole minutes", () => {
  const payload = {
    services: [
      {
        no: "13",
        next: { duration_ms: 100_798 },
        subsequent: { duration_ms: 1_210_000 },
      },
      { no: "107M", next: { duration_ms: 30_000 }, subsequent: null },
    ],
  };

  assert.deepEqual(formatBusArrivals(payload, "07371"), {
    stop_code: "07371",
    services: [
      { service: "13", next_min: 2, subsequent_min: 20 },
      { service: "107M", next_min: 1, subsequent_min: null },
    ],
  });
});

test("haversineMetres measures CT Hub 2 to Lavender MRT at under 600 m", () => {
  const ctHub2 = { latitude: 1.3115, longitude: 103.8615 };
  const lavenderMrt = { latitude: 1.3073, longitude: 103.8631 };
  const distance = haversineMetres(ctHub2, lavenderMrt);
  assert.ok(distance > 400 && distance < 550, `got ${distance}`);
});

test("formatPlaces reports open_now from currentOpeningHours", () => {
  const origin = { latitude: 1.3115, longitude: 103.8615 };
  const places = [
    {
      displayName: { text: "Open Stall" },
      rating: 4.5,
      location: origin,
      currentOpeningHours: { openNow: true },
    },
    {
      displayName: { text: "Closed Stall" },
      rating: 4,
      location: origin,
      currentOpeningHours: { openNow: false },
    },
    { displayName: { text: "No Hours" }, location: origin },
  ];

  assert.deepEqual(
    formatPlaces(places, origin).map((p) => p.open_now),
    [true, false, null],
  );
});

test("formatForecast does not throw when forecasts is missing", () => {
  const result = formatForecast({ data: { items: [{}] } }, "Kallang");
  assert.deepEqual(result, { error: "No forecast for Kallang" });
});

test("formatForecast errors instead of reporting Unknown for a missing area", () => {
  const payload = {
    data: { items: [{ forecasts: [{ area: "Geylang", forecast: "Fair" }] }] },
  };
  assert.deepEqual(formatForecast(payload, "Kallang"), {
    error: "No forecast for Kallang",
  });
});

test("formatForecast refuses a forecast whose valid period has ended", () => {
  const payload = {
    data: {
      items: [
        {
          valid_period: { end: "2020-01-01T14:00:00+08:00" },
          forecasts: [{ area: "Kallang", forecast: "Heavy Rain" }],
        },
      ],
    },
  };
  assert.deepEqual(formatForecast(payload, "Kallang", new Date("2026-10-07T04:30:00Z")), {
    error: "Forecast is out of date",
  });
});

test("normaliseStopCode pads numbers and rejects non-codes", () => {
  assert.equal(normaliseStopCode("07371"), "07371");
  assert.equal(normaliseStopCode(7371), "07371");
  assert.equal(normaliseStopCode(" 7371 "), "07371");
  for (const bad of ["abc", "", "123456", undefined, null, "07 371"]) {
    assert.equal(normaliseStopCode(bad), null, String(bad));
  }
});

test("formatPlaces drops places beyond the radius and lists the nearest first", () => {
  const origin = { latitude: 1.3115, longitude: 103.8615 };
  const at = (name, dLat) => ({
    displayName: { text: name },
    location: { latitude: origin.latitude + dLat, longitude: origin.longitude },
  });
  const places = [
    at("Far", 0.03), // about 3.3 km
    at("Mid", 0.004), // about 440 m
    { displayName: { text: "No Location" } },
    at("Near", 0.001), // about 110 m
  ];
  assert.deepEqual(
    formatPlaces(places, origin).map((p) => p.name),
    ["Near", "Mid", "No Location"],
  );
});

test("formatPlaces keeps a place that has no location", () => {
  const [place] = formatPlaces([{ displayName: { text: "Mystery Stall" } }], {
    latitude: 1.3115,
    longitude: 103.8615,
  });
  assert.equal(place.name, "Mystery Stall");
  assert.equal(place.distance_m, null);
});
