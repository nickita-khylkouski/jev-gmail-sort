import { expect, test } from "bun:test";
import { extractItems } from "../extension/extraction.js";

const page = { title: "Fixture", url: "https://example.test", text: "A fixture page" };
const options = { key: "fixture", prompt: "fixture", models: ["primary", "fallback"] };
const enc = new TextEncoder();
const event = (content, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason }] })}\n\n`;
async function withFetch(fetcher, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  try { await run(); } finally { globalThis.fetch = original; }
}
const stream = (chunks, onCancel = () => {}) => new Response(new ReadableStream({
  start(c) { chunks.forEach((chunk) => c.enqueue(typeof chunk === "string" ? enc.encode(chunk) : chunk)); c.close(); }, cancel: onCancel,
}));

test("handles split UTF-8, SSE and JSON lines", async () => {
  const data = enc.encode(event('{"noun":"finding"}\n{"title":"Café",') + event('"detail":"useful","anchor":"Café"}\n', "stop"));
  const chunks = Array.from(data, (byte) => new Uint8Array([byte]));
  await withFetch(async () => stream(chunks), async () => {
    const items = [];
    expect(await extractItems(page, (it) => items.push(it), options)).toBe("finding");
    expect(items).toEqual([{ title: "Café", detail: "useful", anchor: "Café" }]);
  });
});

test("processes the final SSE event even without a trailing newline", async () => withFetch(
  async () => stream([event('{"title":"Final"}', "stop").trimEnd()]), async () => {
    const items = [];
    await extractItems(page, (it) => items.push(it), options);
    expect(items[0].title).toBe("Final");
  },
));

test("surfaces a provider error inside a successful HTTP stream", async () => withFetch(
  async () => stream(['data: {"error":{"message":"rate limit reached"}}\n\n']), async () => {
    await expect(extractItems(page, () => {}, options)).rejects.toThrow("rate limit reached");
  },
));

test("does not rank a silently interrupted stream", async () => withFetch(
  async () => stream([event('{"title":"Partial"}\n')]), async () => {
    await expect(extractItems(page, () => {}, options)).rejects.toThrow("interrupted");
  },
));

test("reports output limits instead of accepting a partial extraction", async () => withFetch(
  async () => stream([event('{"title":"Partial"}', "length")]), async () => {
    await expect(extractItems(page, () => {}, options)).rejects.toThrow("smaller page");
  },
));

test("DONE ends the response without waiting for the connection to close", async () => {
  let cancelled = false;
  await withFetch(async () => new Response(new ReadableStream({
    start(c) { c.enqueue(enc.encode(event('{"title":"Complete"}') + "data: [DONE]\n\n")); },
    cancel() { cancelled = true; },
  })), async () => {
    await extractItems(page, () => {}, options);
    expect(cancelled).toBe(true);
  });
});

test("unsupported primary model falls back and cancels its response body", async () => {
  const models = [];
  let cancelled = false;
  await withFetch(async (_url, init) => {
    models.push(JSON.parse(init.body).model);
    return models.length === 1 ? new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 404 }) : stream(["data: [DONE]\n\n"]);
  }, async () => {
    await extractItems(page, () => {}, options);
    expect(models).toEqual(["primary", "fallback"]);
    expect(cancelled).toBe(true);
  });
});

test("a stalled stream times out and aborts the HTTP request", async () => {
  let aborted = false;
  await withFetch(async (_url, init) => new Response(new ReadableStream({ start(c) {
    init.signal.addEventListener("abort", () => { aborted = true; c.error(init.signal.reason); }, { once: true });
  } })), async () => {
    await expect(extractItems(page, () => {}, { ...options, timeoutMs: 10 })).rejects.toThrow("timed out");
    expect(aborted).toBe(true);
  });
});

test("switching pages can cancel a pending extraction", async () => {
  const ctl = new AbortController();
  await withFetch(async (_url, init) => new Response(new ReadableStream({ start(c) {
    init.signal.addEventListener("abort", () => c.error(init.signal.reason), { once: true });
    queueMicrotask(() => ctl.abort(new Error("page changed")));
  } })), async () => {
    await expect(extractItems(page, () => {}, { ...options, signal: ctl.signal })).rejects.toThrow("page changed");
  });
});

test("pre-cancelled work never sends page text", async () => {
  const ctl = new AbortController();
  ctl.abort(new Error("already cancelled"));
  let calls = 0;
  await withFetch(async () => { calls++; return stream([]); }, async () => {
    await expect(extractItems(page, () => {}, { ...options, signal: ctl.signal })).rejects.toThrow("already cancelled");
    expect(calls).toBe(0);
  });
});
