import { test } from "node:test";
import assert from "node:assert/strict";
import { isRateLimited } from "../src/limits.js";

const req = (ip) =>
  new Request("https://example.com/chat", {
    method: "POST",
    headers: ip ? { "cf-connecting-ip": ip } : {},
  });

test("isRateLimited does nothing without the binding", async () => {
  assert.equal(await isRateLimited({}, req("1.2.3.4")), false);
});

test("isRateLimited keys on the client IP and reports a refusal", async () => {
  const keys = [];
  const env = {
    CHAT_LIMITER: {
      async limit({ key }) {
        keys.push(key);
        return { success: key !== "9.9.9.9" };
      },
    },
  };
  assert.equal(await isRateLimited(env, req("1.2.3.4")), false);
  assert.equal(await isRateLimited(env, req("9.9.9.9")), true);
  assert.deepEqual(keys, ["1.2.3.4", "9.9.9.9"]);
});

test("isRateLimited lets requests through if the limiter fails", async () => {
  const env = { CHAT_LIMITER: { async limit() { throw new Error("down"); } } };
  const origError = console.error;
  console.error = () => {};
  try {
    assert.equal(await isRateLimited(env, req("1.2.3.4")), false);
  } finally {
    console.error = origError;
  }
});
