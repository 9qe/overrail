const { test } = require("node:test");
const assert = require("node:assert/strict");

const { withFailover } = require("../lib/failover");

test("returns the first successful attempt immediately", async () => {
  const calls = [];
  const result = await withFailover(["a", "b", "c"], async (profile) => {
    calls.push(profile);
    return { ok: true, status: 200, profile };
  });
  assert.equal(result.profile, "a");
  assert.deepEqual(calls, ["a"]);
});

test("retries past retryable statuses then succeeds", async () => {
  const responses = {
    a: { ok: false, status: 500 },
    b: { ok: false, status: 503 },
    c: { ok: true, status: 200 },
  };
  const calls = [];
  const result = await withFailover(["a", "b", "c"], async (profile) => {
    calls.push(profile);
    return responses[profile];
  });
  assert.equal(result.status, 200);
  assert.deepEqual(calls, ["a", "b", "c"]);
});

test("throws with attempts after exhausting the chain", async () => {
  const seen = [];
  await assert.rejects(
    withFailover(["a", "b"], async (profile) => {
      seen.push(profile);
      return { ok: false, status: 503 };
    }),
    (err) => {
      assert.deepEqual(seen, ["a", "b"]);
      assert.deepEqual(err.attempts, [
        { profile: "a", error: "http 503" },
        { profile: "b", error: "http 503" },
      ]);
      return true;
    }
  );
});

test("network errors (rejections) trigger failover", async () => {
  const result = await withFailover(["a", "b"], async (profile) => {
    if (profile === "a") throw new Error("ECONNREFUSED");
    return { ok: true, status: 200 };
  });
  assert.equal(result.status, 200);
});

test("does not retry on 401", async () => {
  const seen = [];
  await assert.rejects(
    withFailover(["a", "b"], async (profile) => {
      seen.push(profile);
      return { ok: false, status: 401 };
    }),
    (err) => {
      assert.deepEqual(seen, ["a"]);
      assert.equal(err.attempts.length, 1);
      assert.deepEqual(err.attempts, [{ profile: "a", error: "http 401" }]);
      return true;
    }
  );
});

test("does not retry on 400", async () => {
  const seen = [];
  await assert.rejects(
    withFailover(["a", "b"], async (profile) => {
      seen.push(profile);
      return { ok: false, status: 400 };
    }),
    (err) => {
      assert.deepEqual(seen, ["a"]);
      assert.equal(err.attempts.length, 1);
      return true;
    }
  );
});
