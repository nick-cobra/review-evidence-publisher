import assert from "node:assert/strict";
import { test } from "node:test";
import { createEvidencePublisher } from "../index.mjs";

const { githubJson } = createEvidencePublisher({ repository: "acme/widget" });
const endpoint = "repos/acme/widget/actions/runs?per_page=100";
const serverFailure = (status) =>
  Object.assign(new Error("GitHub CLI request failed"), {
    stderr: Buffer.from(`gh: Server Error (HTTP ${status})\n`),
  });

for (const status of [502, 503, 504])
  test(`metadata GET recovers from HTTP ${status} using bounded backoff`, () => {
    let calls = 0;
    const waits = [];
    const result = githubJson(["api", endpoint], {
      exec: () => {
        if (++calls < 3) throw serverFailure(status);
        return '{"id":123}';
      },
      sleep: (ms) => waits.push(ms),
    });
    assert.deepEqual(result, { id: 123 });
    assert.equal(calls, 3);
    assert.deepEqual(waits, [250, 500]);
  });

test("transient metadata errors exhaust one shared three-attempt budget", () => {
  let calls = 0;
  const waits = [];
  assert.throws(
    () =>
      githubJson(["api", "--method", "GET", endpoint], {
        exec: () => {
          calls++;
          if (calls === 1) throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
          throw serverFailure(503);
        },
        sleep: (ms) => waits.push(ms),
      }),
    /failed after 3 attempts.*GitHub CLI request failed/,
  );
  assert.equal(calls, 3);
  assert.deepEqual(waits, [250, 500]);
});

test("metadata command timeouts and backoff share a ninety-second deadline", () => {
  let elapsed = 0;
  const timeouts = [];
  assert.throws(
    () =>
      githubJson(["api", endpoint], {
        now: () => elapsed,
        sleep: (ms) => (elapsed += ms),
        exec: (_args, { timeout }) => {
          timeouts.push(timeout);
          elapsed += timeout;
          throw Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" });
        },
      }),
    /failed after 3 attempts/,
  );
  assert.deepEqual(timeouts, [30000, 30000, 29250]);
  assert.equal(elapsed, 90000);
});

for (const args of [
  ["api", endpoint, "--method", "POST"],
  ["api", "-X", "DELETE", endpoint],
  ["api", "--method=PATCH", endpoint],
  ["api", "-XPUT", endpoint],
  ["api", endpoint, "-f", "key=value"],
  ["api", endpoint, "--raw-field=key=value"],
  ["api", endpoint, "--input", "-"],
  ["api", "graphql"],
  ["workflow", "run", "publisher.yml"],
])
  for (const fault of [() => serverFailure(502), () => new Error("request timed out")])
    test(`does not replay a mutation or unrecognised command: ${args.join(" ")} / ${fault().message}`, () => {
      let calls = 0;
      const failure = fault();
      assert.throws(
        () =>
          githubJson(args, {
            exec: () => {
              calls++;
              throw failure;
            },
            sleep: () => assert.fail("unsafe command must not back off"),
          }),
        (error) => error === failure,
      );
      assert.equal(calls, 1);
    });

for (const status of [401, 403, 404, 422, 429, 500])
  test(`HTTP ${status} remains immediately visible`, () => {
    let calls = 0;
    const failure = serverFailure(status);
    assert.throws(
      () =>
        githubJson(["api", endpoint], {
          exec: () => {
            calls++;
            throw failure;
          },
          sleep: () => assert.fail("permanent or out-of-scope response must not back off"),
        }),
      (error) => error === failure,
    );
    assert.equal(calls, 1);
  });

test("malformed JSON is not a transient HTTP error", () => {
  let calls = 0;
  assert.throws(
    () =>
      githubJson(["api", endpoint], {
        exec: () => {
          calls++;
          return 'invalid JSON "gh: Server Error (HTTP 502)"';
        },
        sleep: () => assert.fail("invalid JSON must not back off"),
      }),
    SyntaxError,
  );
  assert.equal(calls, 1);
});

test("callers can lower the attempt limit but cannot remove its bound", () => {
  for (const attempts of [0, 4, Infinity, NaN, 1.5])
    assert.throws(
      () => githubJson(["api", endpoint], { attempts, exec: () => assert.fail("invalid limit") }),
      /attempts must be an integer from 1 to 3/,
    );
});
