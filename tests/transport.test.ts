import { test, expect } from "bun:test";

test("OAuth, retry and queued cancellation preserve a healthy slow tournament", async () => {
  const child = Bun.spawn([process.execPath, "run", "tests/fixtures/transport.ts"], {
    env: { ...process.env, JEV_CONCURRENCY: "1", TYPESAFE_API_KEY: "synthetic", EXA_API_KEY: "" }, stdout: "pipe", stderr: "pipe"
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, err }).toEqual({ code: 0, err: "" });
  expect(JSON.parse(out)).toEqual({ oauthCancellation: true, quotaCancellation: true, queuedCancellation: true, healthyQueuedSort: true });
}, 20000);

test("disconnecting the real analysis SSE cancels all active provider requests", async () => {
  const child = Bun.spawn([process.execPath, "run", "tests/fixtures/http-cancel.ts"], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, err }).toEqual({ code: 0, err: "" });
  expect(out).toContain('"allCancelled":true');
});
