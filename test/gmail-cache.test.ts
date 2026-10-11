import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), "jev-cache-"));
  const originalFetch = globalThis.fetch, originalChrome = globalThis.chrome, originalNow = Date.now;
  let now = originalNow(), reads = 0, draft = false, body = "original email";
  const stored = {};
  try {
    Date.now = () => now;
    globalThis.chrome = { storage: { session: {
      get: async (key) => ({ [key]: stored[key] }), set: async (data) => { Object.assign(stored, data); },
    } } };
    await Bun.write(join(dir, "gmail.js"), await Bun.file(new URL("../extension/gmail.js", import.meta.url)).text());
    await Bun.write(join(dir, "secrets.js"), 'export default { google: {token_uri: "https://oauth2.googleapis.com/token"} };');
    globalThis.fetch = async (url) => {
      if (String(url).includes("oauth2")) return Response.json({ access_token: "fixture", expires_in: 3600, scope: "https://www.googleapis.com/auth/gmail.readonly" });
      if (String(url).endsWith("/profile")) return Response.json({ emailAddress: "me@example.test" });
      reads++;
      return Response.json({ messages: [{ labelIds: draft ? ["DRAFT"] : ["INBOX"], internalDate: String(now), payload: {
        headers: [{ name: "from", value: "Sender <sender@example.test>" }, { name: "subject", value: "Fixture" }], mimeType: "text/plain", body: { data: Buffer.from(body).toString("base64url") },
      } }] });
    };
    const { cards } = await import(join(dir, "gmail.js"));
    await run({ read: () => cards(["abc"], null), stored, now: () => now, advance: () => { now += 121000; }, update: (value) => { body = value; draft = false; }, draft: () => { draft = true; }, reads: () => reads });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalChrome === undefined) delete globalThis.chrome; else globalThis.chrome = originalChrome;
    Date.now = originalNow;
    await rm(dir, { recursive: true, force: true });
  }
}

test("recent cards are reused, then refreshed after two minutes", async () => fixture(async (f) => {
  expect((await f.read())[0].body).toBe("original email");
  f.update("new reply");
  expect((await f.read())[0].body).toBe("original email");
  expect(f.reads()).toBe(1);
  f.advance();
  expect((await f.read())[0].body).toBe("new reply");
  expect(f.reads()).toBe(2);
}));

test("draft-only results do not poison the card cache", async () => fixture(async (f) => {
  f.draft();
  expect((await f.read())[0]).toBeNull();
  f.update("sent message");
  expect((await f.read())[0].body).toBe("sent message");
  expect(f.reads()).toBe(2);
}));

test("expired session records are refreshed after a worker restart", async () => fixture(async (f) => {
  f.stored["c:abc"] = { at: f.now() - 121000, card: { body: "stale session" } };
  expect((await f.read())[0].body).toBe("original email");
  expect(f.reads()).toBe(1);
}));

test("recent session records survive a worker restart", async () => fixture(async (f) => {
  f.stored["c:abc"] = { at: f.now(), card: { body: "recent session" } };
  expect((await f.read())[0].body).toBe("recent session");
  expect(f.reads()).toBe(0);
}));

test("legacy session records without timestamps are refreshed", async () => fixture(async (f) => {
  f.stored["c:abc"] = { body: "legacy card" };
  expect((await f.read())[0].body).toBe("original email");
}));

test("concurrent misses still share one thread read", async () => fixture(async (f) => {
  const result = await Promise.all(Array.from({ length: 6 }, f.read));
  expect(result.every((cards) => cards[0].body === "original email")).toBe(true);
  expect(f.reads()).toBe(1);
}));
