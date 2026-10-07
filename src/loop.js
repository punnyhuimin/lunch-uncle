import { buildSystemPrompt, buildTimeContext } from "./prompt.js";
import { toolDefinitions, executeTool } from "./tools.js";

// TODO: set the base URL and model for your OpenAI-compatible provider.
const LLM_BASE_URL = "https://opencode.ai/zen/go/v1";
const LLM_MODEL = "glm-5.3-flash";

const LLM_TIMEOUT_MS = 20_000;
// Replies are capped at 120 words in the prompt; this stops a runaway answer.
const MAX_OUTPUT_TOKENS = 400;
const MAX_ROUNDS = 8;
const MAX_TOOL_CALLS_PER_ROUND = 4;
// Stop starting new rounds after this long, so one chat cannot run for minutes.
const TURN_DEADLINE_MS = 45_000;

const FALLBACK_REPLY = "Just go Berseh Food Centre lah.";
const GIVE_UP_REPLY = "Uncle tried too many times already. Ask something simpler.";
const EMPTY_REPLY = "Uncle blur for a moment. Ask again lah.";

/**
 * Run the agentic loop for one user turn.
 *
 * history is the prior conversation as OpenAI-style messages, including any
 * assistant tool_calls and tool results from earlier turns.
 *
 * Returns { reply, messages }, where messages are the new messages from this
 * turn (user, assistant, tool) for the client to send back as history.
 */
export async function runLoop(history, message, env) {
  // If the Places key is missing, Uncle cannot search, so give a safe answer.
  if (!env.GOOGLE_PLACES_API_KEY) {
    return finish(FALLBACK_REPLY, [
      { role: "user", content: message },
      { role: "assistant", content: FALLBACK_REPLY },
    ]);
  }

  const messages = [
    { role: "system", content: buildSystemPrompt() },
    ...history,
    { role: "system", content: buildTimeContext() },
    { role: "user", content: message },
  ];

  const turnStart = messages.length - 1;

  // One session id per turn, shared by every model call in this loop run,
  // so the OpenCode Go endpoint can route and cache consistently.
  const sessionId = crypto.randomUUID();

  const deadline = Date.now() + TURN_DEADLINE_MS;

  for (let round = 0; round < MAX_ROUNDS && Date.now() < deadline; round++) {
    const assistant = await callModel(messages, env, sessionId);
    messages.push(assistant);

    const toolCalls = assistant.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // Never store or return an empty reply: show a line and keep history valid.
      if (!assistant.content?.trim()) {
        assistant.content = EMPTY_REPLY;
      }
      return finish(assistant.content, messages.slice(turnStart));
    }

    const results = await Promise.all(
      toolCalls.map((call, i) => runToolCall(call, i, round, env)),
    );
    messages.push(...results);
  }

  messages.push({ role: "assistant", content: GIVE_UP_REPLY });
  return finish(GIVE_UP_REPLY, messages.slice(turnStart));
}

/**
 * Run one tool call and always return a tool message for it, so the history
 * stays valid and the model can recover from a bad call.
 */
async function runToolCall(call, index, round, env) {
  // Providers can omit ids; the tool message must still match the call.
  call.id ??= `call_${round}_${index}`;

  if (index >= MAX_TOOL_CALLS_PER_ROUND) {
    return toolMessage(call, { error: "Too many tool calls at once, ask for fewer." });
  }

  const name = call.function?.name;
  const args = parseArgs(call.function?.arguments);
  if (typeof name !== "string" || args === null) {
    return toolMessage(call, { error: "Invalid tool call: arguments must be a JSON object." });
  }

  console.log(`round ${round}: ${name}`, args);
  return { role: "tool", tool_call_id: call.id, content: await executeTool(name, args, env) };
}

function toolMessage(call, result) {
  return { role: "tool", tool_call_id: call.id, content: JSON.stringify(result) };
}

function finish(reply, messages) {
  return { reply, messages };
}

async function callModel(messages, env, sessionId) {
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENCODE_API_KEY}`,
      "x-opencode-session": sessionId,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      tools: toolDefinitions,
      max_tokens: MAX_OUTPUT_TOKENS,
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`LLM returned ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const message = data?.choices?.[0]?.message;
  if (!message) {
    throw new Error(`LLM returned no message: ${JSON.stringify(data).slice(0, 500)}`);
  }
  // Keep only what we send back later; some providers add extra fields.
  return {
    role: "assistant",
    content: message.content ?? null,
    ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
  };
}

/**
 * Parse tool-call arguments. Returns a plain object, or null if the model sent
 * something that is not a JSON object.
 */
export function parseArgs(raw) {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
