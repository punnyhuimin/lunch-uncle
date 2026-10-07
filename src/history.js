/**
 * Validation for the chat history a client sends back to the Worker.
 *
 * The client is untrusted: it can send anything. We only accept the message
 * shapes the loop itself produces (user, assistant, tool), copy just the
 * fields we know, and refuse histories whose tool calls and tool results do
 * not pair up, because the LLM provider rejects those with a 400.
 */

export const MAX_MESSAGE_CHARS = 2000;
export const MAX_HISTORY_MESSAGES = 60;
export const MAX_HISTORY_CHARS = 60_000;

/**
 * Check and clean a client-supplied history.
 *
 * Returns { history } with sanitised messages, or { error } with a reason.
 * Oversized histories are not an error: the oldest whole turns are dropped.
 */
export function validateHistory(raw) {
  if (!Array.isArray(raw)) {
    return { error: "history must be an array" };
  }

  const history = [];
  for (const m of raw) {
    const clean = cleanMessage(m);
    if (!clean) {
      return { error: "history contains an invalid message" };
    }
    history.push(clean);
  }

  if (!toolCallsPair(history)) {
    return { error: "history has tool calls without matching results" };
  }

  return { history: trimHistory(history) };
}

function cleanMessage(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;

  switch (m.role) {
    case "user":
      return typeof m.content === "string"
        ? { role: "user", content: m.content }
        : null;

    case "tool":
      return typeof m.tool_call_id === "string" && typeof m.content === "string"
        ? { role: "tool", tool_call_id: m.tool_call_id, content: m.content }
        : null;

    case "assistant": {
      const content = m.content ?? null;
      if (content !== null && typeof content !== "string") return null;

      if (m.tool_calls === undefined) {
        return content === null ? null : { role: "assistant", content };
      }
      if (!Array.isArray(m.tool_calls) || m.tool_calls.length === 0) return null;

      const tool_calls = [];
      for (const call of m.tool_calls) {
        if (
          typeof call?.id !== "string" ||
          typeof call.function?.name !== "string" ||
          typeof call.function.arguments !== "string"
        ) {
          return null;
        }
        tool_calls.push({
          id: call.id,
          type: "function",
          function: {
            name: call.function.name,
            arguments: call.function.arguments,
          },
        });
      }
      return { role: "assistant", content, tool_calls };
    }

    default:
      // Includes "system": clients may not inject instructions.
      return null;
  }
}

/**
 * True when every assistant tool_calls message is followed by exactly one
 * tool message per call id, and no tool message appears anywhere else.
 */
export function toolCallsPair(messages) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];

    if (m.role === "tool") return false;

    if (m.role === "assistant" && m.tool_calls) {
      const wanted = new Set(m.tool_calls.map((c) => c.id));
      if (wanted.size !== m.tool_calls.length) return false;

      for (let j = 0; j < wanted.size; j++) {
        const next = messages[i + 1 + j];
        if (next?.role !== "tool" || !wanted.has(next.tool_call_id)) return false;
        wanted.delete(next.tool_call_id);
      }
      if (wanted.size !== 0) return false;
      i += m.tool_calls.length;
    }
  }
  return true;
}

/**
 * Drop the oldest turns until the history fits the caps. A turn starts at a
 * user message, so a tool call is never separated from its results.
 */
export function trimHistory(messages) {
  let start = 0;
  while (start < messages.length && exceedsCaps(messages, start)) {
    let next = start + 1;
    while (next < messages.length && messages[next].role !== "user") next++;
    start = next;
  }
  return messages.slice(start);
}

function exceedsCaps(messages, start) {
  if (messages.length - start > MAX_HISTORY_MESSAGES) return true;
  let chars = 0;
  for (let i = start; i < messages.length; i++) {
    chars += JSON.stringify(messages[i]).length;
  }
  return chars > MAX_HISTORY_CHARS;
}
