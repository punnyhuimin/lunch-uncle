import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt, buildTimeContext } from "../src/prompt.js";

test("buildSystemPrompt is identical across calls so it can be cached", () => {
  assert.equal(buildSystemPrompt(), buildSystemPrompt());
});

test("buildTimeContext carries the current time", () => {
  const text = buildTimeContext(new Date("2026-10-07T04:00:00.000Z"));
  assert.equal(text, "Current time: 2026-10-07T04:00:00.000Z.");
});
