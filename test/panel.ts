// Headless test of the "sort this page" side panel on the demo pages. The panel is opened as a tab
// pointed at the page's tab (headless Chrome has no side panel UI); everything else is real: the page
// text, the extraction model and the live ranking. --ahead waits for the read-ahead before pressing
// Sort (the usual case: the panel is open before you've typed); without it, Sort is pressed at once.
//   bun run test/panel.ts [yc|linkedin|hn|all] ["sentence"] [--ahead] [--headed]
import { chromium } from "playwright";

const which = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "all";
const custom = process.argv.slice(3).find((a) => !a.startsWith("--"));
const ext = new URL("../extension", import.meta.url).pathname;
const ctx = await chromium.launchPersistentContext("", { headless: !process.argv.includes("--headed"), channel: "chromium", args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`], viewport: { width: 1300, height: 900 } });
const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
const extId = new URL(sw.url()).host;

// LinkedIn needs a login, so its demo page is a mock made from a saved profile's text (data/, not in git).
const li = await Bun.file("data/linkedin.txt").text().catch(() => "");
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
await ctx.route("https://www.linkedin.com/in/**", (r) =>
  r.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><title>Profile | LinkedIn</title><body style="font:14px system-ui;max-width:760px;margin:24px auto">${li.split("\n").map((l) => `<p>${esc(l)}</p>`).join("")}</body>` }),
);

const DEMOS = {
  yc: { url: "https://www.ycombinator.com/security", q: "how big the vulnerability was" },
  linkedin: { url: "https://www.linkedin.com/in/demo-profile/", q: "most impressive achievement, on merit" },
  hn: { url: "https://news.ycombinator.com/item?id=50045984", q: "most useful" },
};
for (const [name, d] of Object.entries(DEMOS)) {
  if (which !== "all" && which !== name) continue;
  const page = await ctx.newPage();
  await page.goto(d.url, { waitUntil: "domcontentloaded" });
  const tabId = await sw.evaluate((u) => chrome.tabs.query({}).then((ts) => ts.find((t) => t.url?.startsWith(u))?.id), d.url);
  const panel = await ctx.newPage();
  panel.on("pageerror", (e) => console.log("[panel error]", e.message));
  await panel.setViewportSize({ width: 400, height: 900 });
  await panel.goto(`chrome-extension://${extId}/panel.html?tab=${tabId}`);
  await panel.fill("#q", custom || d.q);
  if (process.argv.includes("--ahead")) await panel.waitForTimeout(12000);
  const t0 = Date.now();
  await panel.press("#q", "Enter");
  let first = 0, seen = 0;
  const watch = setInterval(async () => {
    const n = await panel.$$eval("#list li", (x) => x.length).catch(() => 0);
    if (n && !first) first = Date.now() - t0;
    seen = n;
  }, 50);
  await panel.waitForSelector("#status.done, #note.err:not([hidden])", { timeout: 90000 });
  clearInterval(watch);
  await panel.waitForTimeout(500);
  const err = await panel.$eval("#note", (n) => (n.hidden ? "" : n.textContent));
  console.log(`\n== ${name}: "${custom || d.q}"`);
  if (err) console.log("error:", err);
  console.log(`first item shown after ${first}ms · ${await panel.$eval("#stage", (e) => e.textContent)} · ${await panel.$eval("#meta", (e) => e.textContent)}`);
  console.log((await panel.$$eval("#list li", (xs) => xs.map((x) => `${x.querySelector(".n")!.textContent}. ${x.querySelector(".t")!.textContent} (${x.querySelector(".r")!.textContent}) — ${x.querySelector(".d")!.textContent!.slice(0, 90)}`))).join("\n"));
  await panel.screenshot({ path: `data/panel-${name}.png`, fullPage: true });
  // Clicking a result scrolls the page to it.
  await panel.click("#list li:nth-child(1)");
  await page.waitForTimeout(800);
  console.log("click #1 → page scrolled to y =", await page.evaluate(() => Math.round(scrollY)));
}
await ctx.close();
