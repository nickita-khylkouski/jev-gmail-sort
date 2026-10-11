// Isolated process: no production token cache, network, credentials, or shared test globals.
import { expect } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchThreadContext } from "../../src/gmail";
import { jev, rank } from "../../src/rank";

const dir = await mkdtemp(join(tmpdir(), "jev-transport-test-"));
process.env.GOOGLE_TOKEN_FILE = join(dir, "token.json");
await writeFile(process.env.GOOGLE_TOKEN_FILE, JSON.stringify({ client_id: "synthetic", client_secret: "synthetic", refresh_token: "synthetic" }));
try {
  let refreshes = 0;
  globalThis.fetch = async (_url, init: any) => {
    refreshes++; expect(init.signal).toBeInstanceOf(AbortSignal);
    await sleep(10000, undefined, { signal: init.signal }); throw Error("Refresh should abort");
  };
  let ctl = new AbortController(), started = performance.now();
  let pending = fetchThreadContext("abc12345", ctl.signal);
  setTimeout(() => ctl.abort(), 20);
  await expect(pending).rejects.toThrow(); expect(performance.now() - started).toBeLessThan(500); expect(refreshes).toBe(2);

  globalThis.fetch = async (url) => String(url).includes("oauth2")
    ? Response.json({ access_token: "synthetic", expires_in: 3600, scope: "https://www.googleapis.com/auth/gmail.readonly" })
    : new Response("quota", { status: 429 });
  ctl = new AbortController(); started = performance.now(); pending = fetchThreadContext("abc12345", ctl.signal);
  setTimeout(() => ctl.abort(), 20);
  await expect(pending).rejects.toThrow(); expect(performance.now() - started).toBeLessThan(500);

  // Occupy the only Jev slot, then cancel a queued ancillary request before it starts.
  let release: (value: Response) => void = () => {};
  const busy = jev({}, {}, { recordStats: false, fetch: async () => new Promise((resolve) => { release = resolve; }) });
  ctl = new AbortController(); let called = false; started = performance.now();
  const queued = jev({}, {}, { recordStats: false, signal: ctl.signal, fetch: async () => { called = true; return Response.json({ answers: {} }); } });
  setTimeout(() => ctl.abort(), 20);
  await expect(queued).rejects.toThrow(); expect(called).toBe(false); expect(performance.now() - started).toBeLessThan(500);
  release(Response.json({ answers: {} })); await busy;

  Math.random = () => 0.6;
  globalThis.fetch = async (_url, init: any) => {
    await sleep(600, undefined, { signal: init.signal });
    const body = JSON.parse(init.body);
    return Response.json({ answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]: [string, any]) => {
      const ids = Object.keys(q.criteria), choice = id === "higher" ? (body.state.A.score > body.state.B.score ? "A" : "B") : "top";
      return [id, { choice, confidence: 0.99, probabilities: Object.fromEntries(ids.map((x) => [x, x === choice ? 0.99 : 0.01 / Math.max(1, ids.length - 1)])) }];
    })) });
  };
  const result = await rank(Array.from({ length: 5 }, (_, i) => ({ id: `card${i}`, card: { score: i } })), { noun: "card", context: {}, criterion: "higher score first", algo: "full" }, () => {});
  expect(result.order).toEqual(["card4", "card3", "card2", "card1", "card0"]);
  expect(result.jev.errors).toBe(0); expect(result.jev.decisions).toBe(15);
  console.log(JSON.stringify({ oauthCancellation: true, quotaCancellation: true, queuedCancellation: true, healthyQueuedSort: true }));
} finally { await rm(dir, { recursive: true, force: true }); }
