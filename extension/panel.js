// Shortlist: sort any page by a sentence. The side panel reads the page's text, a fast model picks out
// the items worth ranking (streamed in one by one), and pairwise judgments rank them while they arrive.
// The page is read ahead for its first starter sentence as soon as the panel shows it, so that one is instant.
import { configure, rankLive } from "./engine.js";
import secrets from "./secrets.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const MODELS = ["gpt-6-luna", "gpt-5.6-luna"];
const MAX_TEXT = 60000; // characters of page text sent to the extractor
const MAX_ITEMS = 150;

// Starter sentences for the demo pages; anything else gets a generic one.
const IDEAS = [
  [/ycombinator\.com\/security/, ["how big the vulnerability was", "most data exposed", "easiest to exploit"]],
  [/news\.ycombinator\.com\/item/, ["most insightful", "first-hand experience", "most useful"]],
  [/linkedin\.com\/in\//, ["most impressive achievement, on merit", "hardest to get", "most relevant to building startups"]],
  [/mail\.google\.com/, ["what matters most to me", "a real person is waiting on my reply"]],
  [/./, ["most important", "most useful to me"]],
];

let tab = null, run = 0;
const fixedTab = new URLSearchParams(location.search).get("tab"); // tests open the panel as a tab

async function currentTab() {
  if (fixedTab) return chrome.tabs.get(Number(fixedTab));
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t;
}

async function showTab() {
  const t = await currentTab().catch(() => null);
  if (!t || (tab && t.id === tab.id && t.url === tab.url)) return;
  tab = t;
  run++; // a different page: whatever was running is for the old one
  $("#ptitle").textContent = t.title || "This page";
  $("#phost").textContent = t.url ? new URL(t.url).hostname.replace(/^www\./, "") : "";
  if (t.favIconUrl) $("#fav").src = t.favIconUrl;
  else $("#fav").removeAttribute("src");
  const ideas = ideasFor(t.url);
  $("#ideas").innerHTML = ideas.map((q) => `<button type="button">${esc(q)}</button>`).join("");
  $("#list").innerHTML = "";
  $("#status").hidden = true;
  note(/mail\.google\.com/.test(t.url || "") ? "On Gmail, the Sort button next to “Inbox” reads the full emails and sorts Gmail itself. This panel sorts what's on the page." : "");
  setBusy(false);
  if (t.status === "complete") readAhead(t);
}
chrome.tabs.onActivated.addListener(showTab);
chrome.tabs.onUpdated.addListener((id, info, t) => {
  if (id !== tab?.id) return;
  if (info.url && info.url !== tab.url) return (tab = null), showTab(); // navigated: a new page
  if (info.status === "loading") jobs.delete(tab.url); // reloaded: the text read ahead is stale
  if (info.status === "complete") readAhead(t);
  if (info.title) $("#ptitle").textContent = t.title;
  if (info.favIconUrl) $("#fav").src = t.favIconUrl;
});

function note(text, err = false) {
  $("#note").hidden = !text;
  $("#note").textContent = text;
  $("#note").classList.toggle("err", err);
}
function setBusy(b) {
  $("#go").disabled = b;
  $("#q").disabled = b;
}
const status = (stage, meta = "", prog = null, done = false) => {
  $("#status").hidden = false;
  $("#status").classList.toggle("done", done);
  $("#stage").textContent = stage;
  $("#meta").textContent = meta;
  if (prog != null) $("#prog").style.width = Math.round(100 * Math.min(1, prog)) + "%";
};

// ---------- 1. read the page ----------
async function readPage(t) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: t.id },
    func: () => ({ title: document.title, url: location.href, text: document.body.innerText }),
  });
  // Numbered lines, so the model can point at items instead of copying them out.
  const lines = [];
  let size = 0;
  for (const l of result.text.split("\n")) {
    const t = l.replace(/\s+/g, " ").trim().slice(0, 800);
    if (!t) continue;
    if ((size += t.length + 6) > MAX_TEXT) break;
    lines.push(t);
  }
  return { ...result, lines };
}

// ---------- 2. pick out the items (streamed as JSON lines) ----------
// The sentence decides what the items are: "most useful" on a profile is its accomplishments,
// "most useful person" is the people on it. So every sentence gets its own read of the page.
const PROMPT = (q) => `You pick out the items on a web page that someone wants to rank. They will rank them by: "${q}".
If the sentence names what to rank ("most useful person", "best repo", "cheapest flight"), pick out exactly those. Otherwise the sentence only says how to rank, and the items are the page's main content, as below.
The page text is given as numbered lines. Point at the items by line number; don't copy their text.
Output JSON Lines only: one JSON object per line, no prose, no code fences.
First line: {"noun": "<singular noun for one item, e.g. comment, finding, achievement, product>"}
Then one line per item: {"t": "<label, at most 8 words>", "l": [first, last]}
- l: the line numbers of the item's own content. For comments or posts, just the text, not the header line with the username and time, and not "reply".
- t: who or what it is. For comments, reports or submissions: "<username>: <gist in a few words>". On a profile, just the accomplishment, without the person's name.
- Only if several items share one line, add "d": that item's facts in at most 20 words, copied from the page.
What the items are: the repeated entries that make up the page's main content. On a discussion or thread page, the comments and replies (not the original post). On a list, feed, table or search page, its entries. On one person's or company's profile, each of their own accomplishments separately: every role, company founded, degree, fellowship, award, competition result, investment, fundraise, community or audience built, and notable post with a result. Never other people the page suggests.
Be exhaustive: every item of that kind, at most ${MAX_ITEMS}. Skip navigation, ads, "people also viewed", footers.`;

// Long pages are split into parts read in parallel (a 116-comment thread: 12s in one go).
const PART = 160; // lines per part
const OVERLAP = 12; // lines shared by neighbouring parts, so an item on a boundary is seen whole

async function extract(page, q, onItem, onNoun) {
  const { openai = "" } = await chrome.storage.local.get("openai");
  const key = openai || secrets.openaiKey;
  if (!key) throw new Error("Add an OpenAI key in the settings to read pages.");
  const n = page.lines.length;
  const parts = Math.max(1, Math.min(8, Math.ceil(n / PART)));
  const size = Math.ceil(n / parts);
  const claimed = new Set(); // first lines of items already taken (parts overlap)
  const nouns = await Promise.all(
    Array.from({ length: parts }, (_, k) =>
      extractPart(key, page, q, k * size, Math.min(n, (k + 1) * size + OVERLAP), k, parts, onNoun, (it) => {
        if (claimed.has(it.from)) return;
        claimed.add(it.from);
        onItem(it);
      }),
    ),
  );
  return nouns.find((x) => x !== "item") || "item";
}

async function extractPart(key, page, q, from, to, k, parts, onNoun, onItem) {
  const where = parts > 1 ? `This is part ${k + 1} of ${parts} of the page (lines ${from + 1}-${to}); list the items in this part.\n` : "";
  const ask = (model) =>
    fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: true,
        reasoning_effort: "none",
        max_completion_tokens: 6000,
        messages: [
          { role: "system", content: PROMPT(q) },
          { role: "user", content: `Page: ${page.title}\nURL: ${page.url}\n${where}\n${page.lines.slice(from, to).map((l, i) => `${from + i + 1}| ${l}`).join("\n")}` },
        ],
      }),
    });
  let res = await ask(MODELS[0]);
  if (res.status === 400 || res.status === 404) res = await ask(MODELS[1]);
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);

  let noun = "item", out = "", sse = "";
  const take = (line) => {
    line = line.trim().replace(/^```\w*|```$/g, "").replace(/,$/, "");
    if (!line.startsWith("{")) return;
    try {
      const o = JSON.parse(line);
      if (o.noun) onNoun((noun = String(o.noun).toLowerCase()));
      else if (o.l != null) {
        const [a, b = a] = [].concat(o.l).map(Number);
        const own = page.lines.slice(Math.max(0, a - 1), Math.min(page.lines.length, Math.max(a, b)));
        if (!own.length) return;
        const text = own.join(" ");
        const anchor = own.reduce((x, y) => (y.length > x.length ? y : x)).slice(0, 60);
        onItem({ from: o.d ? `${a}:${o.d}` : a, title: String(o.t || own[0].slice(0, 60)), detail: o.d ? String(o.d) : text, text: (o.d ? o.d + " (from: " : "") + text.slice(0, 1200) + (o.d ? ")" : ""), anchor });
      }
    } catch {}
  };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sse += dec.decode(value, { stream: true });
    let i;
    while ((i = sse.indexOf("\n")) >= 0) {
      const ev = sse.slice(0, i).trim();
      sse = sse.slice(i + 1);
      if (!ev.startsWith("data:") || ev === "data: [DONE]") continue;
      out += JSON.parse(ev.slice(5)).choices?.[0]?.delta?.content || "";
      let j;
      while ((j = out.indexOf("\n")) >= 0) (take(out.slice(0, j)), (out = out.slice(j + 1)));
    }
  }
  take(out);
  return noun;
}

// Read-aheads: one extraction per page, for its first starter sentence. A Sort by that sentence uses
// it (once); any other Sort, or the same one again, reads the page fresh. Not on Gmail: its own Sort
// button covers the inbox, and mail shouldn't leave the browser without a click.
const jobs = new Map(); // url -> { q, items, noun, subs, done, tEnd }
const ideasFor = (url) => IDEAS.find(([re]) => re.test(url || ""))[1];
function readAhead(t) {
  if (!/^https?:/.test(t.url || "") || /mail\.google\.com/.test(t.url) || jobs.has(t.url)) return;
  const j = job(t, ideasFor(t.url)[0]);
  jobs.set(t.url, j);
  j.done.catch(() => jobs.get(t.url) === j && jobs.delete(t.url)); // retried on the next visit
  for (const u of [...jobs.keys()].slice(0, -12)) jobs.delete(u);
}
function take(t, q) {
  const j = jobs.get(t.url);
  if (j?.q === q) return jobs.delete(t.url), j;
  return job(t, q);
}
function job(t, q) {
  const j = { q, items: [], noun: "item", subs: new Set(), tEnd: 0 };
  const me = j;
  j.done = (async () => {
    const page = await readPage(t).catch(() => {
      throw new Error("Chrome doesn't let extensions read this page. Try a normal website.");
    });
    me.page = page;
    const noun = await extract(
      page,
      q,
      (it) => {
        if (me.items.length >= MAX_ITEMS) return;
        me.items.push(it);
        for (const f of me.subs) f(it);
      },
      (n) => n !== "item" && me.noun === "item" && (me.noun = n),
    );
    if (me.noun === "item") me.noun = noun;
    me.tEnd = performance.now();
  })();
  return j;
}

// ---------- the list ----------
const rows = new Map(); // id -> li
function addRow(id, it) {
  const li = document.createElement("li");
  li.dataset.id = id;
  li.innerHTML = `<i class="s"></i><span class="n">${rows.size + 1}</span><span class="t">${esc(it.title)}</span><span class="r"></span><span class="d">${esc(it.detail)}</span>`;
  li.addEventListener("click", () => highlight(it));
  rows.set(id, li);
  $("#list").appendChild(li);
}
// Reorder with a FLIP animation so you can watch items climb.
function reorder(order, record) {
  const list = $("#list");
  const before = new Map([...rows.values()].map((li) => [li, li.getBoundingClientRect().top]));
  order.forEach((id, i) => {
    const li = rows.get(id);
    li.querySelector(".n").textContent = i + 1;
    if (record?.[id]) li.querySelector(".r").textContent = `${record[id].w}–${record[id].l}`;
    list.appendChild(li);
  });
  for (const [li, top] of before) {
    const dy = top - li.getBoundingClientRect().top;
    if (Math.abs(dy) >= 1) li.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 400, easing: "cubic-bezier(.2,.8,.2,1)" });
  }
}
function flash(id, won) {
  const li = rows.get(id);
  if (!li) return;
  li.classList.add(won ? "won" : "lost");
  setTimeout(() => li.classList.remove("won", "lost"), 350);
}

// Click a result: scroll the page to it and outline it for a moment.
async function highlight(it) {
  await chrome.scripting
    .executeScript({
      target: { tabId: tab.id },
      args: [it.anchor, it.title],
      func: (anchor, title) => {
        const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
        const want = [anchor, title].map((s) => norm(s || "")).filter((s) => s.length >= 4);
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let hit = null;
        for (const target of want) {
          for (let n; !hit && (n = w.nextNode()); ) if (norm(n.nodeValue).includes(target.slice(0, 40)) && n.parentElement.offsetParent) hit = n.parentElement;
          if (hit) break;
          w.currentNode = document.body;
        }
        if (!hit) return false;
        const el = hit.closest("li, tr, article, section > div, p, div") || hit;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.animate([{ outline: "3px solid #0b57d0", outlineOffset: "4px", backgroundColor: "rgba(11,87,208,.08)" }, { outline: "3px solid transparent", outlineOffset: "4px", backgroundColor: "transparent" }], { duration: 2200, easing: "ease-in" });
        return true;
      },
    })
    .catch(() => {});
}

// ---------- 3. sort ----------
// Ranking starts with the second item and keeps taking items while the page is still being read.
async function sort(q) {
  q = q.trim();
  if (!q || !tab) return;
  const me = ++run;
  const live = () => me === run;
  setBusy(true);
  note("");
  rows.clear();
  $("#list").innerHTML = "";
  $("#list").classList.remove("ranked");
  const t0 = performance.now();
  const ids = new Map(); // item -> id
  let ranker = null, decided = 0, budget = 1;
  const plural = () => `${ids.size} ${ids.size === 1 || j.noun.endsWith("s") ? j.noun : j.noun.replace(/([^aeiou])y$/, "$1ie") + "s"}`;
  const elapsed = () => ((performance.now() - t0) / 1000).toFixed(1);
  const j = take(tab, q);
  const ahead = !!j.tEnd;
  const tick = setInterval(() => {
    if (!live()) return;
    const reading = !j.tEnd;
    const found = ids.size ? `${ids.size} found · ` : "";
    const meta = ranker ? `${reading ? found : ""}${decided} comparisons · ${elapsed()}s` : `${found}${elapsed()}s`;
    status(reading ? "Finding what to rank" : `Ranking ${plural()}`, meta, (reading ? 0.05 : 0.15) + 0.85 * Math.min(1, decided / budget));
  }, 100);
  const feed = (it) => {
    if (!live() || ids.has(it)) return;
    const id = "i" + ids.size;
    ids.set(it, id);
    addRow(id, it);
    if (ranker) return ranker.add({ id, card: { title: it.title, text: it.text } });
    if (ids.size < 2) return;
    ranker = rankLive({ noun: j.noun, context: { page: { title: tab.title, url: tab.url } }, criterion: q }, (ev) => {
      if (!live()) return ranker.stop();
      if (ev.type === "match") (decided++, flash(ev.a, ev.pA >= 0.5), flash(ev.b, ev.pA < 0.5));
      if (ev.type === "standings") (reorder(ev.order, ev.record), (budget = ev.budget));
    });
    for (const [x, xid] of ids) ranker.add({ id: xid, card: { title: x.title, text: x.text } });
  };
  try {
    const { key: stored = "" } = await chrome.storage.local.get("key");
    const key = stored || secrets.jevKey;
    if (!key) throw new Error("Add your ranking API key in the settings.");
    configure({ key, concurrency: 256 });
    status(ahead ? "Ranking" : "Reading the page", "", 0.02);
    j.items.forEach(feed);
    j.subs.add(feed);
    try {
      await j.done;
    } finally {
      j.subs.delete(feed);
    }
    if (!live()) return ranker?.stop();
    if (ids.size < 2) throw new Error(ids.size ? "Only one thing on this page to rank." : "Nothing to rank found here. Try a page with a list, a thread or a profile.");
    const tFind = ((j.tEnd - t0) / 1000).toFixed(1);
    const ev = await ranker.end();
    if (!live()) return;
    reorder(ev.order, ev.record);
    $("#list").classList.add("ranked");
    status(`Sorted ${plural()}`, `${elapsed()}s · ${ahead ? "page read ahead" : `found in ${tFind}s`} · ${ev.jev.decisions} comparisons · $${ev.jev.costUsd.toFixed(4)}`, 1, true);
  } catch (e) {
    ranker?.stop();
    if (!live()) return;
    $("#status").hidden = true;
    note(String(e.message || e), true);
  } finally {
    clearInterval(tick);
    if (live()) setBusy(false);
  }
}

$("#ask").addEventListener("submit", (e) => (e.preventDefault(), sort($("#q").value)));
$("#ideas").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  $("#q").value = b.textContent;
  sort(b.textContent);
});
$("#opts").addEventListener("click", () => chrome.runtime.openOptionsPage());
showTab();
$("#q").focus();
