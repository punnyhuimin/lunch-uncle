import { test } from "node:test";
import assert from "node:assert/strict";
import { runLoop } from "../src/loop.js";

test("runLoop stops after MAX_ROUNDS when the model keeps calling tools", async () => {
  const realFetch = globalThis.fetch;
  let llmCalls = 0;

  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/chat/completions")) {
      llmCalls++;
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call_${llmCalls}`,
                  type: "function",
                  function: { name: "get_rain_forecast", arguments: "{}" },
                },
              ],
            },
          },
        ],
      });
    }
    return Response.json({ data: { items: [] } });
  };

  try {
    const env = { GOOGLE_PLACES_API_KEY: "test", OPENCODE_API_KEY: "test" };
    const reply = await runLoop([], "will it rain?", env);
    assert.equal(llmCalls, 8);
    assert.match(reply, /too many times/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
