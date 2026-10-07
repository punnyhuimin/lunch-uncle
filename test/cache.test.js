import { test } from "node:test";
import assert from "node:assert/strict";
import { cached, cacheKey } from "../src/cache.js";

// In-memory stand-in for caches.default.
function fakeCache() {
  const store = new Map();
  return {
    store,
    async match(req) {
      const res = store.get(req.url);
      return res ? res.clone() : undefined;
    },
    async put(req, res) {
      store.set(req.url, res);
    },
  };
}

test("cached runs the producer once for identical keys", async () => {
  const cache = fakeCache();
  let runs = 0;
  const produce = async () => ({ runs: ++runs });

  const first = await cached("k", 60, produce, cache);
  const second = await cached("k", 60, produce, cache);

  assert.deepEqual(first, { runs: 1 });
  assert.deepEqual(second, { runs: 1 });
  assert.equal(runs, 1);
});

test("cached keeps different keys apart", async () => {
  const cache = fakeCache();
  let runs = 0;
  const produce = async () => ({ runs: ++runs });

  await cached(cacheKey("places", ["chicken rice", false]), 60, produce, cache);
  await cached(cacheKey("places", ["chicken rice", true]), 60, produce, cache);
  assert.equal(runs, 2);
});

test("cached does not store error results", async () => {
  const cache = fakeCache();
  let runs = 0;
  const produce = async () => ({ error: `fail ${++runs}` });

  await cached("k", 60, produce, cache);
  const second = await cached("k", 60, produce, cache);

  assert.equal(runs, 2);
  assert.equal(second.error, "fail 2");
  assert.equal(cache.store.size, 0);
});

test("cached sets the TTL on the stored response", async () => {
  const cache = fakeCache();
  await cached("k", 300, async () => ({ ok: true }), cache);
  const [res] = cache.store.values();
  assert.equal(res.headers.get("cache-control"), "public, max-age=300");
});

test("cached still answers when the cache throws", async () => {
  const broken = {
    async match() { throw new Error("boom"); },
    async put() { throw new Error("boom"); },
  };
  const origError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await cached("k", 60, async () => ({ ok: 1 }), broken), { ok: 1 });
  } finally {
    console.error = origError;
  }
});

test("cached runs the producer directly when there is no cache", async () => {
  assert.deepEqual(await cached("k", 60, async () => ({ ok: 1 }), undefined), { ok: 1 });
});

test("producer exceptions are not swallowed or cached", async () => {
  const cache = fakeCache();
  await assert.rejects(
    () => cached("k", 60, async () => { throw new Error("upstream down"); }, cache),
    /upstream down/,
  );
  assert.equal(cache.store.size, 0);
});
