import { test } from "node:test";
import assert from "node:assert/strict";
import { runLoop } from "../src/loop.js";

test("runLoop returns the turn's tool calls and results for the client to keep", async () => {
  const realFetch = globalThis.fetch;
  let llmCalls = 0;

  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/chat/completions")) {
      llmCalls++;
      const message =
        llmCalls === 1
          ? {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "get_rain_forecast", arguments: "{}" },
                },
              ],
            }
          : { role: "assistant", content: "Bring umbrella." };
      return Response.json({ choices: [{ message }] });
    }
    return Response.json({ data: { items: [] } });
  };

  try {
    const env = { GOOGLE_PLACES_API_KEY: "test", OPENCODE_API_KEY: "test" };
    const prior = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
    const { reply, messages } = await runLoop(prior, "will it rain?", env);

    assert.equal(reply, "Bring umbrella.");
    assert.deepEqual(
      messages.map((m) => m.role),
      ["user", "assistant", "tool", "assistant"],
    );
    assert.equal(messages[0].content, "will it rain?");
    assert.equal(messages[2].tool_call_id, "call_1");
  } finally {
    globalThis.fetch = realFetch;
  }
});

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
    const { reply } = await runLoop([], "will it rain?", env);
    assert.equal(llmCalls, 8);
    assert.match(reply, /too many times/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
