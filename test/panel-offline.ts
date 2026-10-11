// Real unpacked-extension smoke check with synthetic pages and mocked providers; no keys needed.
// bun run test/panel-offline.ts
import { chromium } from "playwright";
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const dir = await mkdtemp(join(tmpdir(), "jev-panel-"));
let ctx, release;
try {
  const ext = join(dir, "extension");
  await cp(new URL("../extension", import.meta.url), ext, { recursive: true, filter: (path) => !path.endsWith("/secrets.js") });
  await Bun.write(join(ext, "secrets.js"), 'export default { jevKey: "fixture", openaiKey: "fixture", google: {} };');
  ctx = await chromium.launchPersistentContext(join(dir, "profile"), { headless: true, channel: "chromium", args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  await ctx.route("https://fixture.test/**", (r) => r.fulfill({ contentType: "text/html", body: `<title>${r.request().url().endsWith("/second") ? "Second" : "First"}</title><body><p>First item</p><p>Second item</p></body>` }));
  let mode = "normal", calls = 0, pending;
  const waiting = () => new Promise((resolve) => { pending = resolve; });
  await ctx.route("https://api.openai.com/**", async (r) => {
    if (mode === "stalled") {
      pending();
      await new Promise((resolve) => { release = resolve; });
      return r.abort().catch(() => {});
    }
    const content = '{"noun":"item"}\n{"title":"First item","detail":"One","anchor":"First item"}\n{"title":"Second item","detail":"Two","anchor":"Second item"}';
    const body = mode === "error" ? 'data: {"error":{"message":"fixture provider error"}}\n\n' : `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\n`;
    await r.fulfill({ contentType: "text/event-stream", body });
  });
  await ctx.route("https://api.typesafe.ai/**", (r) => {
    calls++;
    return r.fulfill({ contentType: "application/json", body: JSON.stringify({ answers: { higher: { choice: "A", confidence: 0.8, probabilities: { A: 0.8, B: 0.2 } } } }) });
  });
  const target = await ctx.newPage();
  await target.goto("https://fixture.test/first");
  const tabId = await sw.evaluate(() => chrome.tabs.query({}).then((ts) => ts.find((t) => t.url === "https://fixture.test/first").id));
  const panel = await ctx.newPage();
  const errors = [];
  panel.on("pageerror", (e) => errors.push(e.message));
  await panel.goto(`chrome-extension://${extId}/panel.html?tab=${tabId}`);
  await panel.waitForFunction(() => document.querySelector("#ptitle").textContent === "First");
  const submit = async () => { await panel.fill("#q", "most useful"); await panel.press("#q", "Enter"); };
  await submit();
  await panel.waitForSelector("#status.done");
  assert.equal(await panel.locator("#list li").count(), 2);
  assert.equal(await panel.locator("#go").isEnabled(), true);
  console.log("PASS complete extraction → Swiss ranking → two results");

  mode = "error";
  const before = calls;
  await submit();
  await panel.waitForSelector("#note.err:not([hidden])");
  assert.match(await panel.locator("#note").innerText(), /fixture provider error/);
  assert.equal(calls, before);
  console.log("PASS provider stream error is shown without starting a ranking");

  mode = "stalled";
  const started = waiting();
  await panel.evaluate(() => {
    window.aborts = 0;
    const original = window.fetch;
    window.fetch = (url, init) => { init?.signal?.addEventListener("abort", () => window.aborts++); return original(url, init); };
  });
  await submit();
  await started;
  await target.goto("https://fixture.test/second");
  await panel.waitForFunction(() => document.querySelector("#ptitle").textContent === "Second" && window.aborts === 1);
  assert.equal(await panel.locator("#go").isEnabled(), true);
  assert.equal(await panel.locator("#list li").count(), 0);
  assert.equal(await panel.locator("#note").isVisible(), false);
  release();
  assert.deepEqual(errors, []);
  console.log("PASS navigation aborts old extraction and resets the new page cleanly");
} finally {
  release?.();
  await ctx?.close();
  await rm(dir, { recursive: true, force: true });
}
