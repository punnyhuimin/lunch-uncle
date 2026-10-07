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
    const { reply } = await runLoop([], "will it rain?", { OPENCODE_API_KEY: "test" });
    assert.equal(llmCalls, 1);
    assert.equal(reply, "Bring umbrella.");
  } finally {
    globalThis.fetch = realFetch;
  }
});

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

const env = { GOOGLE_PLACES_API_KEY: "test", OPENCODE_API_KEY: "test" };

function toolCallMessage(name, args, id = "call_1") {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
  };
}

// Reply to LLM calls from a script, and to tool calls with `toolFetch`.
async function withFetch(script, toolFetch, run) {
  const realFetch = globalThis.fetch;
  let llmCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/chat/completions")) {
      const next = script[Math.min(llmCalls++, script.length - 1)];
      return Response.json(next);
    }
    return toolFetch(url, init);
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("runLoop feeds a failing tool back to the model instead of failing the turn", async () => {
  const script = [
    { choices: [{ message: toolCallMessage("get_rain_forecast", "{}") }] },
    { choices: [{ message: { role: "assistant", content: "Cannot check, bring umbrella." } }] },
  ];
  const origError = console.error;
  console.error = () => {};
  try {
    await withFetch(script, async () => { throw new Error("network down"); }, async () => {
      const { reply, messages } = await runLoop([], "rain?", env);
      assert.equal(reply, "Cannot check, bring umbrella.");
      assert.match(messages[2].content, /failed/);
    });
  } finally {
    console.error = origError;
  }
});

test("runLoop answers every tool call, including malformed ones", async () => {
  const message = {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "a", type: "function", function: { name: "find_lunch_places", arguments: "null" } },
      { id: "b", type: "function", function: { name: "get_rain_forecast", arguments: "{oops" } },
      { type: "function", function: { name: "get_rain_forecast", arguments: "{}" } },
      { id: "d" },
    ],
  };
  const script = [
    { choices: [{ message }] },
    { choices: [{ message: { role: "assistant", content: "ok" } }] },
  ];
  await withFetch(script, async () => Response.json({ data: { items: [] } }), async () => {
    const { messages } = await runLoop([], "hi", env);
    const toolMessages = messages.filter((m) => m.role === "tool");
    assert.equal(toolMessages.length, 4);
    assert.match(toolMessages[0].content, /Invalid tool call/);
    assert.match(toolMessages[1].content, /Invalid tool call/);
    assert.ok(toolMessages[2].tool_call_id);
    assert.match(toolMessages[3].content, /Invalid tool call/);
  });
});

test("runLoop caps tool calls per round and still answers the extras", async () => {
  const calls = Array.from({ length: 6 }, (_, i) => ({
    id: `c${i}`,
    type: "function",
    function: { name: "get_rain_forecast", arguments: "{}" },
  }));
  const script = [
    { choices: [{ message: { role: "assistant", content: null, tool_calls: calls } }] },
    { choices: [{ message: { role: "assistant", content: "done" } }] },
  ];
  let toolFetches = 0;
  await withFetch(script, async () => { toolFetches++; return Response.json({ data: { items: [] } }); }, async () => {
    const { messages } = await runLoop([], "hi", env);
    assert.equal(messages.filter((m) => m.role === "tool").length, 6);
    assert.equal(toolFetches, 4);
  });
});

test("runLoop turns an empty model reply into a real reply", async () => {
  const script = [{ choices: [{ message: { role: "assistant", content: null }, finish_reason: "length" }] }];
  await withFetch(script, async () => {}, async () => {
    const { reply, messages } = await runLoop([], "hi", env);
    assert.ok(reply.length > 0);
    assert.equal(messages.at(-1).content, reply);
  });
});

test("runLoop throws a clear error when the provider returns no choices", async () => {
  await withFetch([{}], async () => {}, async () => {
    await assert.rejects(() => runLoop([], "hi", env), /no message/);
  });
});

test("find_lunch_places returns an error when the Places key is missing", async () => {
  const { executeTool } = await import("../src/tools.js");
  const result = JSON.parse(await executeTool("find_lunch_places", { query: "rice" }, {}));
  assert.deepEqual(result, { error: "Places search is not configured" });
});
