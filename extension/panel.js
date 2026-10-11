// Sort any page by a sentence. The side panel reads the page's text, Luna (OpenAI) picks out just the
// items worth ranking (streamed in one by one), then Jev ranks them with Swiss rounds, live.
import { configure, rank } from "./engine.js";
import secrets from "./secrets.js";
import { extractItems } from "./extraction.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const MODELS = ["gpt-6-luna", "gpt-5.6-luna"];
const MAX_TEXT = 60000; // characters of page text sent to Luna
const MAX_ITEMS = 60;

// Starter sentences for the demo pages; anything else gets a generic one.
const IDEAS = [
  [/ycombinator\.com\/security/, ["how big the vulnerability was", "most data exposed", "easiest to exploit"]],
  [/linkedin\.com\/in\//, ["most impressive achievement, on merit", "hardest to get", "most relevant to building startups"]],
  [/mail\.google\.com/, ["what matters most to me", "a real person is waiting on my reply"]],
  [/./, ["most important", "most useful to me"]],
];

let tab = null, run = 0, extraction = null;
addEventListener("pagehide", () => extraction?.abort());
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
  extraction?.abort();
  run++; // a different page: whatever was running is for the old one
  $("#ptitle").textContent = t.title || "This page";
  $("#phost").textContent = t.url ? new URL(t.url).hostname.replace(/^www\./, "") : "";
  if (t.favIconUrl) $("#fav").src = t.favIconUrl;
  else $("#fav").removeAttribute("src");
  const ideas = IDEAS.find(([re]) => re.test(t.url || ""))[1];
  $("#ideas").innerHTML = ideas.map((q) => `<button type="button">${esc(q)}</button>`).join("");
  $("#list").innerHTML = "";
  $("#status").hidden = true;
  note(/mail\.google\.com/.test(t.url || "") ? "On Gmail, the Sort button next to “Inbox” reads the full emails and sorts Gmail itself. This panel sorts what's on the page." : "");
  setBusy(false);
}
chrome.tabs.onActivated.addListener(showTab);
chrome.tabs.onUpdated.addListener((id, info, t) => {
  if (id !== tab?.id) return;
  if (info.url && info.url !== tab.url) return (tab = null), showTab(); // navigated: a new page
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
async function readPage() {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({ title: document.title, url: location.href, text: document.body.innerText }),
  });
  return { ...result, text: result.text.replace(/\n{3,}/g, "\n\n").slice(0, MAX_TEXT) };
}

// ---------- 2. Luna picks out the items (streamed as JSON lines) ----------
const PROMPT = (q) => `You pick out the items on a web page that someone wants to rank. They will rank them by: "${q}".
Output JSON Lines only: one JSON object per line, no prose, no code fences.
First line: {"noun": "<singular noun for one item, e.g. finding, achievement, product>"}
Then one line per item: {"title": "...", "detail": "...", "anchor": "..."}
- title: who or what it is, at most 8 words. For a list of reports or submissions, start with the person's name.
- detail: the facts from the page that matter for ranking by the criterion, at most 35 words. Copy facts with their numbers and dates; don't judge.
- anchor: an exact, verbatim substring of the page text (10 to 60 characters) that is part of this item.
Be exhaustive: include every item of that kind on the page, at most ${MAX_ITEMS}; when unsure whether something counts, include it.
If the page is one person's or company's profile, the items are each of their own accomplishments listed separately: every role, company founded, degree, fellowship, award, honor, competition result, investment, fundraise, community or audience built, and notable post with a result (views, attendees, money). Not other people the page suggests.
Skip navigation, ads, "people also viewed", footers.`;

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
async function sort(q) {
  q = q.trim();
  if (!q || !tab) return;
  const me = ++run;
  extraction?.abort();
  const ctl = (extraction = new AbortController());
  const live = () => me === run;
  setBusy(true);
  note("");
  rows.clear();
  $("#list").innerHTML = "";
  $("#list").classList.remove("ranked");
  const t0 = performance.now();
  try {
    status("Reading the page", "", 0.02);
    let page;
    try {
      page = await readPage();
    } catch {
      throw new Error("Chrome doesn't let extensions read this page. Try a normal website.");
    }
    if (!live()) return;
    status("Luna is picking out what to rank", `${Math.round(page.text.length / 1000)}k characters of page text`, 0.05);
    const items = [];
    const { openai = "" } = await chrome.storage.local.get("openai");
    if (!live()) return;
    const noun = await extractItems(page, (it) => {
      if (!live() || items.length >= MAX_ITEMS) return;
      const id = "i" + items.length;
      items.push({ id, ...it });
      addRow(id, it);
      status("Luna is picking out what to rank", `${items.length} found`, 0.05 + 0.1 * Math.min(1, items.length / 20));
    }, { key: openai || secrets.openaiKey, prompt: PROMPT(q), models: MODELS, signal: ctl.signal });
    if (!live()) return;
    const tLuna = ((performance.now() - t0) / 1000).toFixed(1);
    if (items.length < 2) throw new Error(items.length ? "Only one thing on this page to rank." : "Luna didn't find anything to rank here. Try a sentence that names what to rank.");

    const { key: stored = "" } = await chrome.storage.local.get("key");
    const key = stored || secrets.jevKey;
    if (!key) throw new Error("Add your Jev API key in the settings.");
    configure({ key, concurrency: 256 });
    const plural = `${items.length} ${noun}${items.length === 1 || noun.endsWith("s") ? "" : "s"}`;
    let rounds = 1, total = 1, decided = 0, label = "";
    const tRank = performance.now();
    const tick = setInterval(() => live() && status(label || `Ranking ${plural}`, `${decided} Jev decisions · ${((performance.now() - tRank) / 1000).toFixed(1)}s`, 0.15 + 0.85 * (decided / total)), 100);
    try {
      await rank(
        items.map((it) => ({ id: it.id, card: { title: it.title, detail: it.detail } })),
        { noun, context: { page: { title: page.title, url: page.url } }, criterion: q, algo: "swiss", plain: true },
        (ev) => {
          if (!live()) return;
          if (ev.type === "plan") (rounds = ev.phases.length - 1), (total = ev.phases.reduce((s, p) => s + (p.total || 0), 0) || 1);
          if (ev.type === "phase" && ev.key !== "bt") label = `Swiss round ${ev.key.slice(1)} of ${rounds}`;
          if (ev.type === "match") (decided++, flash(ev.a, ev.pA >= 0.5), flash(ev.b, ev.pA < 0.5));
          if (ev.type === "standings") reorder(ev.order, ev.record);
          if (ev.type === "done") {
            reorder(ev.order, ev.record);
            $("#list").classList.add("ranked");
            const secs = ((performance.now() - t0) / 1000).toFixed(1);
            status(`Sorted ${plural}`, `${secs}s total · Luna ${tLuna}s · ${ev.jev.decisions} Jev decisions in ${rounds} Swiss rounds · $${ev.jev.costUsd.toFixed(4)}`, 1, true);
          }
        },
      );
    } finally {
      clearInterval(tick);
    }
  } catch (e) {
    if (!live()) return;
    $("#status").hidden = true;
    note(String(e.message || e), true);
  } finally {
    if (extraction === ctl) extraction = null;
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
