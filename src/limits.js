/**
 * Per-client rate limit for /chat, using a Cloudflare Workers rate limit
 * binding (CHAT_LIMITER in wrangler.toml). Each chat turn can cost several
 * LLM calls and Places searches, so an open endpoint is a wallet risk.
 *
 * Without the binding (local dev, tests) nothing is limited. If the limiter
 * itself fails, let the request through rather than block real users.
 */
export async function isRateLimited(env, request) {
  if (!env.CHAT_LIMITER) return false;

  const key = request.headers.get("cf-connecting-ip") ?? "unknown";
  try {
    const { success } = await env.CHAT_LIMITER.limit({ key });
    return !success;
  } catch (err) {
    console.error("rate limiter failed:", err);
    return false;
  }
}
