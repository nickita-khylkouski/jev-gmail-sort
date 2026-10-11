import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const variants = ["server", "extension"];
async function client(variant, run) {
  const dir = await mkdtemp(join(tmpdir(), "jev-auth-"));
  const originalFetch = globalThis.fetch, originalToken = process.env.GOOGLE_TOKEN_FILE;
  try {
    const google = { client_id: "fixture", client_secret: "fixture", refresh_token: "fixture", token_uri: "https://oauth2.googleapis.com/token" };
    process.env.GOOGLE_TOKEN_FILE = join(dir, "token.json");
    await Bun.write(process.env.GOOGLE_TOKEN_FILE, JSON.stringify(google));
    const file = variant === "server" ? "gmail.ts" : "gmail.js";
    await Bun.write(join(dir, file), await Bun.file(new URL(variant === "server" ? "../src/gmail.ts" : "../extension/gmail.js", import.meta.url)).text());
    await Bun.write(join(dir, "secrets.js"), `export default ${JSON.stringify({ google })};`);
    const mod = await import(join(dir, file));
    await run(mod.profile || mod.account);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GOOGLE_TOKEN_FILE;
    else process.env.GOOGLE_TOKEN_FILE = originalToken;
    await rm(dir, { recursive: true, force: true });
  }
}
const tokenResponse = (value, scope = READONLY) => Response.json({ access_token: value, expires_in: 3600, scope });

test.each(variants)("%s shares a single refresh across concurrent reads", async (variant) => client(variant, async (profile) => {
  let refreshes = 0, reads = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("oauth2")) {
      refreshes++;
      expect(init.body.get("scope")).toBe(READONLY);
      await Bun.sleep(10);
      return tokenResponse("fresh");
    }
    reads++;
    expect(init.method || "GET").toBe("GET");
    return Response.json({ emailAddress: "fixture@example.test" });
  };
  await Promise.all(Array.from({ length: 12 }, () => profile()));
  expect(reads).toBe(12);
  expect(refreshes).toBe(1);
}));

test.each(variants)("%s refreshes once after an early 401", async (variant) => client(variant, async (profile) => {
  let refreshes = 0, reads = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("oauth2")) return tokenResponse(`token-${++refreshes}`);
    reads++;
    return init.headers.Authorization === "Bearer token-1" ? new Response("expired", { status: 401 }) : Response.json({ emailAddress: "fixture@example.test" });
  };
  await profile();
  expect(refreshes).toBe(2);
  expect(reads).toBe(2);
}));

test.each(variants)("%s can retry after a failed refresh", async (variant) => client(variant, async (profile) => {
  let refreshes = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("oauth2")) return ++refreshes === 1 ? Response.json({ error: "temporary failure" }, { status: 503 }) : tokenResponse("fresh");
    return Response.json({ emailAddress: "fixture@example.test" });
  };
  await expect(profile()).rejects.toThrow();
  await profile();
  expect(refreshes).toBe(2);
}));

test.each(variants)("%s still refuses a wider Google scope", async (variant) => client(variant, async (profile) => {
  globalThis.fetch = async () => tokenResponse("unsafe", "https://mail.google.com/");
  await expect(profile()).rejects.toThrow("scope");
}));

test.each(variants)("%s stops after the single auth retry", async (variant) => client(variant, async (profile) => {
  let refreshes = 0, reads = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("oauth2")) return tokenResponse(`token-${++refreshes}`);
    reads++;
    return new Response("still unauthorized", { status: 401 });
  };
  await expect(profile()).rejects.toThrow("gmail 401");
  expect(reads).toBe(2);
  expect(refreshes).toBe(2);
}));

test.each(variants)("%s does not invalidate a new token on a late old-token 401", async (variant) => client(variant, async (profile) => {
  let refreshes = 0, reads = 0, oldReads = 0, release;
  const late = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("oauth2")) return tokenResponse(`token-${++refreshes}`);
    reads++;
    if (init.headers.Authorization === "Bearer token-1") {
      if (++oldReads === 2) await late;
      return new Response("expired", { status: 401 });
    }
    release();
    return Response.json({ emailAddress: "fixture@example.test" });
  };
  await Promise.all([profile(), profile()]);
  expect(refreshes).toBe(2);
  expect(reads).toBe(4);
}));
