import { test, expect } from "bun:test";
import { lookupContext, inspectEmail, sentence, redact } from "../src/context";
import { CompanionHub, companionHandler } from "../src/companion";
import { jev, rank } from "../src/rank";
import { fetchThreadContext } from "../src/gmail";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const answer = "Swift actors protect shared mutable state by serializing access to isolated properties.";
const evidence = () => ({ results: [{ title: "Swift actors", url: "https://www.swift.org/documentation/" }], output: {
  content: { answer, supported: true }, grounding: [{ field: "answer", confidence: "high", citations: [{ url: "https://www.swift.org/documentation/" }] }]
} });
const input = (mode = "screen") => ({ mode, candidates: [{ text: "How do Swift actors prevent data races?" }], days: 0 });
const provider = (inspect: (url: string, body: any) => void = () => {}, result = evidence()) => async (url: any, init: any) => {
  const body = JSON.parse(init.body); inspect(String(url), body);
  return Response.json(String(url).includes("typesafe") ? { answers: { focus: { choice: "region_0", confidence: 0.99 } } } : result);
};
test("K shares the Jev client and uses Exa Instant structured explanations", async () => {
  const calls: string[] = [];
  const result = await lookupContext(input(), { jevKey: "synthetic", exaKey: "synthetic", fetch: provider((url, body) => {
    calls.push(url);
    if (url.includes("exa")) { expect(body.type).toBe("instant"); expect(body.outputSchema.required).toContain("supported"); expect(body.startPublishedDate).toBeUndefined(); }
  }) });
  expect(calls).toHaveLength(2); expect(result.text).toBe(answer); expect(result.result.url).toContain("swift.org");
});
test("L skips Jev, keeps freshness, and can explicitly request a source excerpt", async () => {
  let calls = 0;
  const result = await lookupContext({ ...input("cursor"), days: 30 }, { exaKey: "synthetic", fetch: provider((url, body) => {
    calls++; expect(url).toContain("exa"); expect(Date.parse(body.startPublishedDate)).toBeGreaterThan(Date.now() - 31 * 86400e3);
  }) });
  expect(calls).toBe(1); expect(result.text).toBe(answer);
  const excerpt = await lookupContext({ ...input("cursor"), brief: false }, { exaKey: "synthetic", fetch: provider((_url, body) => expect(body.outputSchema).toBeUndefined()) });
  expect(excerpt.note).toBe("Source excerpt");
});
test("unsupported, verbose, low-confidence and uncited output never falls back to an excerpt", async () => {
  const variations = [evidence(), evidence(), evidence(), evidence()];
  variations[0].output.content.supported = false;
  variations[1].output.content.answer = "One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen.";
  variations[2].output.grounding[0].confidence = "low";
  variations[3].output.grounding[0].field = "supported";
  for (const result of variations) await expect(lookupContext(input("cursor"), { exaKey: "synthetic", fetch: provider(() => {}, result) })).rejects.toThrow();
  expect(sentence("Short excerpt")).toBeNull();
});
test("screen secrets are redacted and Jev may decline a topic", async () => {
  expect(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxabcdefgh")).toBe("[redacted]");
  const data = { ...input(), candidates: [{ text: "How do actors work? person@example.test password=private apikey_secret123456 https://example.test/?token=private" }] };
  await lookupContext(data, { jevKey: "synthetic", exaKey: "synthetic", fetch: provider((_url, body) => {
    expect(JSON.stringify(body)).not.toContain("password=private"); expect(JSON.stringify(body)).not.toContain("person@example.test");
  }) });
  await expect(lookupContext(input(), { jevKey: "synthetic", exaKey: "synthetic", fetch: async () => Response.json({ answers: { focus: { choice: "none", confidence: 1 } } }) })).rejects.toThrow("No useful public topic");
});
test("an aborted poll cannot claim a command, and commands retain their original tab", async () => {
  const hub = new CompanionHub(), signal = new AbortController().signal;
  hub.heartbeat("synthetic-client-01", true, 42);
  const pending = hub.request("screen", "", signal), ctl = new AbortController(); ctl.abort();
  expect(await hub.next("synthetic-client-01", ctl.signal)).toBeNull();
  const command = await hub.next("synthetic-client-01", signal);
  expect(command?.tab).toBe(42); expect(hub.current("synthetic-client-01")).toBe(command!.id);
  hub.heartbeat("synthetic-client-01", true, 43);
  expect(command?.tab).toBe(42);
  hub.respond("synthetic-client-01", command!.id, { error: "Focus changed" });
  await expect(pending).rejects.toThrow("Focus changed"); expect(hub.current("synthetic-client-01")).toBeNull();
});
test("provider errors are bounded and do not expose raw response bodies", async () => {
  await expect(lookupContext(input("cursor"), { exaKey: "synthetic", fetch: async () => new Response("private provider body", { status: 401 }) })).rejects.toThrow("Exa could not");
  await expect(lookupContext({ ...input(), candidates: Array(25).fill({ text: "some text" }) })).rejects.toThrow("readable screen");
});
test("Gmail L uses only Jev and gives a conservative supported next step", async () => {
  const note = await inspectEmail({ subject: "Please reply", snippet: "Can you confirm?" }, { jevKey: "synthetic", fetch: async (url) => {
    expect(String(url)).toContain("typesafe"); return Response.json({ answers: { action: { choice: "reply", confidence: 0.99 } } });
  } });
  expect(note).toContain("reply"); expect(note.split(/\s+/).length).toBeGreaterThanOrEqual(10);
});
test("Gmail command round trip targets only the active extension and rejects duplicates", async () => {
  const hub = new CompanionHub(), signal = new AbortController().signal;
  hub.heartbeat("synthetic-client-01", true);
  const result = hub.request("screen", "deadline first", signal);
  await expect(hub.request("cursor", "", signal)).rejects.toThrow("already running");
  const command = await hub.next("synthetic-client-01", signal);
  expect(command?.criterion).toBe("deadline first");
  expect(() => hub.respond("synthetic-client-02", command!.id, {})).toThrow("Expired");
  hub.respond("synthetic-client-01", command!.id, { threadID: "abc12345" });
  expect((await result).threadID).toBe("abc12345");
  expect(() => hub.respond("synthetic-client-01", command!.id, {})).toThrow("Expired");
});
test("cancelled commands release ownership and late results cannot finish a new request", async () => {
  const hub = new CompanionHub(), ctl = new AbortController(); hub.heartbeat("synthetic-client-01", true);
  const pending = hub.request("screen", "", ctl.signal); const old = await hub.next("synthetic-client-01", ctl.signal);
  ctl.abort(); await expect(pending).rejects.toThrow("cancelled");
  const next = hub.request("cursor", "", new AbortController().signal);
  expect(() => hub.respond("synthetic-client-01", old!.id, {})).toThrow("Expired");
  const command = await hub.next("synthetic-client-01", new AbortController().signal);
  hub.respond("synthetic-client-01", command!.id, { threadID: "abc12345" }); await next;
});
test("companion routes require a native token and reject hostile origins, hosts and oversized bodies", async () => {
  const handler = companionHandler({ token: "a".repeat(64), recent: async () => ({ threads: [] }) });
  const req = (path: string, body?: any, extra = {}) => new Request(`http://localhost:8383/api/companion/${path}`, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body), headers: { Authorization: `Bearer ${"a".repeat(64)}`, "Content-Type": "application/json", ...extra } });
  expect((await handler(req("health")))!.status).toBe(200);
  expect((await handler(req("health", undefined, { Authorization: "" })))!.status).toBe(401);
  expect((await handler(req("health", undefined, { Origin: "https://evil.test" })))!.status).toBe(403);
  expect((await handler(new Request("http://evil.test/api/companion/health")))!.status).toBe(403);
  expect((await handler(req("context", { text: "x".repeat(64_001) })))!.status).toBe(413);
});
test("native Gmail lookup reuses the server's existing recent inbox and validates source URLs", async () => {
  const hub = new CompanionHub(); hub.heartbeat("synthetic-client-01", true);
  let reads = 0;
  const handler = companionHandler({ token: "a".repeat(64), hub, recent: async () => { reads++; return { threads: [{ id: "abc12345", subject: "Please confirm the meeting", from: { name: "Alex" } }] }; } });
  const run = (source: string) => {
    const pending = handler(new Request("http://localhost:8383/api/companion/gmail", { method: "POST", headers: { Authorization: `Bearer ${"a".repeat(64)}`, "Content-Type": "application/json" }, body: JSON.stringify({ mode: "screen" }) }));
    return (async () => {
      await Bun.sleep(1); const command = await hub.next("synthetic-client-01", new AbortController().signal);
      hub.respond("synthetic-client-01", command!.id, { threadID: "abc12345", source }); return (await pending)!;
    })();
  };
  const response = await run("https://mail.google.com/mail/u/0/#inbox/abc12345");
  expect((await response.json()).text).toContain("Please confirm"); expect(reads).toBe(1);
  expect((await run("https://mail.google.com.evil.test/mail/u/0/#inbox/abc12345")).status).toBe(400);
});
test("the shared Jev client aborts ancillary calls and rejects failed hedged calls", async () => {
  const ctl = new AbortController(); ctl.abort();
  await expect(jev({}, {}, { signal: ctl.signal, recordStats: false })).rejects.toThrow();
  const started = performance.now();
  await expect(jev({}, {}, { fetch: async () => { throw new Error("synthetic network failure"); } })).rejects.toThrow();
  expect(performance.now() - started).toBeLessThan(2000);
});
test("cursor Gmail lookup fetches only the selected thread through the read-only Google client", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-google-fixture-")), file = join(dir, "synthetic-token.json");
  await writeFile(file, JSON.stringify({ client_id: "synthetic", client_secret: "synthetic", refresh_token: "synthetic" }));
  const original = globalThis.fetch, originalFile = process.env.GOOGLE_TOKEN_FILE;
  process.env.GOOGLE_TOKEN_FILE = file;
  const requests: string[] = [];
  globalThis.fetch = async (url: any, init: any) => {
    requests.push(String(url));
    if (String(url).includes("oauth2")) {
      expect(init.body.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
      return Response.json({ access_token: "synthetic", expires_in: 3600, scope: "https://www.googleapis.com/auth/gmail.readonly" });
    }
    expect(init.method || "GET").toBe("GET");
    if (String(url).endsWith("/profile")) return Response.json({ emailAddress: "owner@example.test" });
    expect(String(url)).toContain("/threads/abc12345?format=full");
    return Response.json({ messages: [
      { labelIds: ["DRAFT"], payload: { headers: [{ name: "Subject", value: "Ignore draft" }] } },
      { labelIds: ["INBOX"], snippet: "Please confirm", payload: { mimeType: "text/plain", body: { data: Buffer.from("Can you confirm the meeting?").toString("base64url") }, headers: [{ name: "Subject", value: "Meeting" }, { name: "From", value: "Alex <alex@example.test>" }] } }
    ] });
  };
  try {
    const thread = await fetchThreadContext("abc12345");
    expect(thread.subject).toBe("Meeting"); expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0].text).toContain("confirm the meeting"); expect(thread.ownerEmail).toBe("owner@example.test");
    expect(requests.some((url) => url.includes("/threads?"))).toBe(false);
    await expect(fetchThreadContext("../invalid")).rejects.toThrow("Invalid Gmail");
  } finally {
    globalThis.fetch = original;
    if (originalFile === undefined) delete process.env.GOOGLE_TOKEN_FILE; else process.env.GOOGLE_TOKEN_FILE = originalFile;
    await rm(dir, { recursive: true });
  }
});
test("the original full, pivot and Swiss ranking algorithms still order synthetic cards", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init: any) => {
    const b = JSON.parse(init.body);
    const answers = Object.fromEntries(Object.entries(b.questions).map(([id, q]: [string, any]) => {
      const ids = Object.keys(q.criteria);
      // Deterministic score from supplied cards, independent of randomized A/B placement.
      let choice = ids[0];
      if (id === "higher") choice = b.state.A.score > b.state.B.score ? "A" : "B";
      if (ids.includes("top")) choice = "top";
      return [id, { choice, confidence: 0.99, probabilities: Object.fromEntries(ids.map((x) => [x, x === choice ? 0.99 : 0.01 / Math.max(1, ids.length - 1)])) }];
    }));
    return Response.json({ answers });
  };
  try {
    for (const algo of ["full", "pivot", "swiss"] as const) {
      const r = await rank(Array.from({ length: 5 }, (_, i) => ({ id: `card${i}`, card: { score: i } })), { noun: "card", context: {}, criterion: "higher score first", algo }, () => {});
      expect(r.order[0]).toBe("card4"); expect(r.order).toHaveLength(5); expect(r.jev.errors).toBe(0);
    }
  } finally { globalThis.fetch = original; }
});
test("cancelling any tournament aborts provider calls and never publishes a completed order", async () => {
  const original = globalThis.fetch;
  try {
    for (const algo of ["full", "pivot", "swiss"] as const) {
      let aborted = 0; const events: any[] = [], ctl = new AbortController();
      globalThis.fetch = async (_url, init: any) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => { aborted++; reject(init.signal.reason); }, { once: true });
      });
      const pending = rank(Array.from({ length: 5 }, (_, i) => ({ id: `card${i}`, card: { score: i } })), { noun: "card", context: {}, criterion: "higher score first", algo }, (event) => events.push(event), ctl.signal);
      ctl.abort(); await expect(pending).rejects.toThrow();
      expect(aborted).toBeGreaterThan(0); expect(events.some((event) => event.type === "done")).toBe(false);
    }
  } finally { globalThis.fetch = original; }
});
