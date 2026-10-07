/**
 * Short-lived caching of tool results in the Workers Cache API.
 *
 * Places searches cost money and the forecast and bus feeds are shared by
 * everyone, so identical calls inside the TTL reuse one upstream response.
 * Error results are never cached. Outside Workers (tests, plain Node) there
 * is no cache and every call runs the producer.
 */

export const TTL_SECONDS = { places: 600, forecast: 300, bus: 20 };

export function cacheKey(name, parts) {
  return `${name}/${encodeURIComponent(JSON.stringify(parts))}`;
}

export async function cached(key, ttlSeconds, produce, cache = globalThis.caches?.default) {
  if (!cache) return produce();

  const request = new Request(`https://lunch-uncle.cache/${key}`);

  try {
    const hit = await cache.match(request);
    if (hit) return await hit.json();
  } catch (err) {
    console.error("cache read failed:", err);
  }

  const value = await produce();

  if (!value?.error) {
    try {
      await cache.put(
        request,
        new Response(JSON.stringify(value), {
          headers: { "cache-control": `public, max-age=${ttlSeconds}` },
        }),
      );
    } catch (err) {
      console.error("cache write failed:", err);
    }
  }
  return value;
}
