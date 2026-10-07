import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, buildTimeContext } from "../src/prompt.js";

test("buildSystemPrompt is identical across calls so it can be cached", () => {
  assert.equal(buildSystemPrompt(), buildSystemPrompt());
});

test("buildTimeContext states the time in Singapore, not UTC", () => {
  // 04:30 UTC is 12:30 in Singapore.
  assert.equal(
    buildTimeContext(new Date("2026-10-07T04:30:00.000Z")),
    "Current time: Wednesday 7 October 2026, 12:30 Singapore time (UTC+8).",
  );
});

test("buildTimeContext rolls over to the next Singapore day", () => {
  // 16:30 UTC on the 7th is 00:30 on the 8th in Singapore.
  assert.equal(
    buildTimeContext(new Date("2026-10-07T16:30:00.000Z")),
    "Current time: Thursday 8 October 2026, 00:30 Singapore time (UTC+8).",
  );
});
