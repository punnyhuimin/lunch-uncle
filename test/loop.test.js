import { test } from "node:test";
import assert from "node:assert/strict";
import { runLoop } from "../src/loop.js";

test("runLoop still calls the model when GOOGLE_PLACES_API_KEY is missing", async () => {
  const realFetch = globalThis.fetch;
  let llmCalls = 0;
  globalThis.fetch = async () => {
    llmCalls++;
    return Response.json({
      choices: [{ message: { role: "assistant", content: "Bring umbrella." } }],
    });
  };

  try {
    const reply = await runLoop([], "will it rain?", { OPENCODE_API_KEY: "test" });
    assert.equal(llmCalls, 1);
    assert.equal(reply, "Bring umbrella.");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("find_lunch_places returns an error when the Places key is missing", async () => {
  const { executeTool } = await import("../src/tools.js");
  const result = JSON.parse(await executeTool("find_lunch_places", { query: "rice" }, {}));
  assert.deepEqual(result, { error: "Places search is not configured" });
});
