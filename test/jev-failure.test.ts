import { expect, test } from "bun:test";
import * as source from "../src/rank";
import * as bundle from "../extension/engine.js";

test.each([["source", source], ["extension bundle", bundle]] as const)("failed Jev calls still reject when the hedge budget is exhausted (%s)", async (_name, { configure, jev, summary }) => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return new Response("invalid key", { status: 401 });
  }) as typeof fetch;
  configure({ key: "test-key", concurrency: 1 });
  const ask = () => jev({ item: "test" }, { ok: { type: "choice" } });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    // Each failed call consumes one hedge, until the slowdown guard suppresses duplicates.
    for (let i = 0; i < 9; i++) await expect(ask()).rejects.toThrow("jev 401: invalid key");
    expect(summary().hedges).toBe(9);
    await expect(Promise.race([
      ask(),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("request never settled")), 1500); }),
    ])).rejects.toThrow("jev 401: invalid key");
    expect(requests).toBe(19); // nine primary + hedge pairs, then one unhedged request
    // The rejected request also releases the only concurrency slot for the next call.
    globalThis.fetch = (async () => Response.json({ answers: { ok: { choice: "yes" } } })) as typeof fetch;
    const next = await Promise.race([
      ask(),
      new Promise<never>((_, reject) => { clearTimeout(deadline); deadline = setTimeout(() => reject(new Error("concurrency slot never released")), 1500); }),
    ]);
    expect(next.answers.ok.choice).toBe("yes");
  } finally {
    clearTimeout(deadline);
    globalThis.fetch = originalFetch;
    configure({ key: "", concurrency: 256 });
  }
}, 15000);
