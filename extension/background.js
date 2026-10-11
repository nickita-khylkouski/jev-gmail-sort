// Runs the ranking. content.js sends the thread ids on screen; we read those threads from the Gmail
// API (read-only) for full bodies, then rank them with Jev.
import { configure, jev, rank } from "./engine.js";
import { cards, prefetch } from "./gmail.js";
import { jobKey } from "./job-key.js";
import secrets from "./secrets.js";

const GUIDE = [
  "Prefer: a real person writing to the owner personally, anything that needs a reply or action, deadlines, money, security and account access.",
  "Deprioritize: marketing, newsletters, promotions, social-network alerts, and automated notifications.",
];
const DEFAULT_Q = "what matters most to me and should be read first";

// Independent of the sort sentence: would the owner be fine never reading this? One Jev question per
// email, run alongside the ranking.
const JUNK = {
  type: "choice",
  instructions: [
    "Would the owner be fine with `email` going straight to Trash without ever reading it?",
    "Trash: promotions, marketing, newsletters, social-network alerts, automated notifications with nothing to act on, event reminders that have passed.",
    "Keep: anything a real person wrote to the owner, replies in a conversation the owner is part of, security or account-access alerts, receipts, invoices and money, deadlines, and anything that needs action.",
  ],
  criteria: { trash: "safe to trash", keep: "the owner should keep it" },
};
const junk = (items, owner, emit) =>
  Promise.all(
    items.map((it) =>
      jev({ owner, email: it.card }, { trash: JUNK })
        .then((r) => emit({ type: "junk", id: it.id, p: r.answers.trash?.probabilities?.trash ?? 0 }))
        .catch(() => {}),
    ),
  ).then(() => emit({ type: "junkdone" }));

// Sort ideas written for the inbox on screen, by OpenAI. Only sender, subject and a short preview are
// sent. Cached for the latest inbox so reopening Gmail is instant.
const SUGGEST_MODELS = ["gpt-6-luna", "gpt-5.6-luna"];
const SUGGEST_ICONS = ["person", "money", "trend", "clock", "shield", "work", "school", "travel", "code", "event", "receipt", "chat", "star", "reply"];
const SUGGEST_PROMPT = `You write sort criteria for an email client that ranks the inbox by a sentence. Given the inbox, return JSON {"suggestions":[{"q":string,"icon":string}]} with 5 criteria (3 to 8 words, lowercase, no trailing period) this person would actually want to sort these emails by. Be specific to the real people, companies, projects and themes you see; avoid generic ideas like "important emails". icon is one of: ${SUGGEST_ICONS.join(", ")}.`;
let suggesting = null;
async function suggest(items) {
  const key = items.map((i) => i.from + "|" + i.subject).join("\n");
  const { openai = "", sugg } = await chrome.storage.local.get(["openai", "sugg"]);
  if (sugg?.key === key && Date.now() - sugg.at < 12 * 36e5) return sugg;
  if (suggesting?.key === key) return suggesting.p;
  const auth = openai || secrets.openaiKey;
  if (!auth) return { suggestions: [], error: "no OpenAI key" };
  const ask = async (model) => {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        model,
        reasoning_effort: "none", // ab/suggest.ts: 1.7s vs 4.5s at the default effort, same quality
        max_completion_tokens: 300,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SUGGEST_PROMPT },
          { role: "user", content: items.map((i) => `${i.from}: ${i.subject}${i.snippet ? " - " + i.snippet : ""}`).join("\n") },
        ],
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error?.message || `OpenAI ${r.status}`), { status: r.status });
    return JSON.parse(j.choices[0].message.content).suggestions;
  };
  const p = (async () => {
    let raw;
    try {
      raw = await ask(SUGGEST_MODELS[0]);
    } catch (e) {
      if (e.status !== 404 && e.status !== 400) throw e;
      raw = await ask(SUGGEST_MODELS[1]); // newest model not on this account
    }
    const suggestions = (Array.isArray(raw) ? raw : [])
      .filter((s) => typeof s?.q === "string" && s.q.trim())
      .slice(0, 5)
      .map((s) => ({ q: s.q.trim().replace(/[.?!]+$/, "").slice(0, 80), icon: SUGGEST_ICONS.includes(s.icon) ? s.icon : "sparkle" }));
    const out = { key, at: Date.now(), suggestions };
    if (suggestions.length) await chrome.storage.local.set({ sugg: out });
    return out;
  })()
    .catch((e) => (console.warn("suggestions:", e.message), { suggestions: [], error: e.message }))
    .finally(() => (suggesting = null));
  suggesting = { key, p };
  return p;
}

// Open the connection to Jev ahead of the first Sort, so that click doesn't pay for DNS + TLS.
let warmAt = 0;
const preconnect = () => Date.now() - warmAt > 60000 && ((warmAt = Date.now()), fetch("https://api.typesafe.ai/v1/systemone", { method: "OPTIONS" }).catch(() => {}));

// The toolbar icon opens the "sort this page" side panel (panel.js).
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  if (m.type === "options") chrome.runtime.openOptionsPage();
  // Gmail showed a list: read those threads now, so pressing Sort doesn't wait on Gmail.
  if (m.type === "prefetch") {
    prefetch(m.ids.slice(0, 50)).catch(() => {});
    preconnect();
    presort(m);
  }
  if (m.type === "suggest") {
    suggest(m.items.slice(0, 50)).then(reply);
    return true; // reply comes later
  }
});

// ---------- sort jobs ----------
// A job is one ranking of one set of emails by one sentence. Jobs are shared: a click on Sort joins the
// job the background already started when Gmail loaded (or replays its finished result), so most
// clicks show the sorted inbox at once instead of waiting ~3s for Jev.
const jobs = new Map(); // key -> { key, log, subs, done, at }
const FRESH = 30 * 60e3; // reuse a finished sort for half an hour

// What a late joiner needs: the result and the per-email answers, not 300 individual matches.
function replay(log, finished) {
  const keep = log.filter((e) => !["match", "standings", "phase", "read"].includes(e.type));
  const last = (t) => log.findLast((e) => e.type === t);
  const lead = [last("read")].filter(Boolean);
  const live = [last("standings"), last("phase")].filter(Boolean);
  const i = keep.findIndex((e) => e.type === "done");
  const out = i < 0 ? [...lead, ...keep, ...live] : [...lead, ...keep.slice(0, i), ...live, ...keep.slice(i)];
  return finished ? out.map((e) => (e.type === "done" ? { ...e, presorted: true } : e)) : out;
}

async function findJob(key) {
  const j = jobs.get(key);
  if (j && (!j.done || Date.now() - j.at < FRESH)) return j;
  // The service worker sleeps when idle; finished sorts survive in session storage.
  const { saved = [] } = await chrome.storage.session.get("saved");
  const hit = saved.find((x) => x.key === key && Date.now() - x.at < FRESH);
  return hit ? { ...hit, subs: new Set(), done: true } : null;
}

function startJob(rows, q, owner, budget) {
  const key = jobKey(rows, q, owner);
  const job = { key, log: [], subs: new Set(), done: false, at: Date.now() };
  jobs.set(key, job);
  for (const k of [...jobs.keys()].slice(0, -6)) jobs.delete(k);
  const emit = (ev) => {
    job.log.push(ev);
    for (const f of job.subs) f(ev);
  };
  runJob(rows, q, owner, budget, emit)
    .then(async (ok) => {
      job.done = true;
      job.at = Date.now();
      if (!ok) return jobs.delete(key); // failed: the next click starts over
      const { saved = [] } = await chrome.storage.session.get("saved");
      await chrome.storage.session.set({ saved: [...saved.filter((x) => x.key !== key).slice(-3), { key, at: job.at, log: replay(job.log, false) }] });
    })
    .catch(() => jobs.delete(key));
  return job;
}

async function runJob(rows, q, owner, budget, emit) {
  const { key: stored = "", about = "", concurrency } = await chrome.storage.local.get(["key", "about", "concurrency"]);
  const key = stored || secrets.jevKey;
  if (!key) return emit({ type: "nokey" }), false;
  try {
    // Full threads from the API; rows the API can't return keep what the list row showed.
    const t0 = performance.now();
    let full = 0;
    const got = await cards(rows.map((r) => r.id), (done, ok) => {
      full += ok ? 1 : 0;
      emit({ type: "read", done, total: rows.length });
    }, budget).catch((e) => (emit({ type: "readfail", message: String(e.message || e) }), []));
    const items = rows.map((r, i) => ({ id: r.id, card: got[i] || r.card }));
    emit({ type: "read", done: items.length, total: items.length, full, ms: Math.round(performance.now() - t0) });
    if (!full) emit({ type: "readfail", message: "the Gmail API returned no threads" });

    configure({ key, concurrency: concurrency || 256 });
    // The trash check waits until triage is done: sharing triage's 50-call burst slowed ranking down
    // (ab/junk.ts: median 3.5s vs 2.8s); during the Swiss rounds it costs nothing.
    let startJunk;
    const junked = new Promise((go) => (startJunk = go)).then(() => junk(items, { name: owner.name, email: owner.email }, emit));
    const ranked = rank(
      items,
      {
        noun: "email",
        context: { owner: { name: owner.name, email: owner.email, ...(about.trim() ? { about: about.trim() } : {}) }, note: `"me"/"I"/"my" in the criterion means the owner.` },
        criterion: q,
        guide: q === DEFAULT_Q ? GUIDE : undefined,
        algo: "auto",
      },
      (ev) => {
        if (ev.type === "phase" && ev.key !== "triage") startJunk();
        emit(ev);
      },
    );
    await ranked.finally(startJunk);
    await junked;
    return true;
  } catch (e) {
    emit({ type: "fatal", message: String(e?.message || e) });
    return false;
  }
}

// Gmail loaded a list: sort it in the background by the sentence the Sort button would use, so the
// click is instant. Debounced (Gmail re-renders a few times while loading) and at most once a minute.
let presortTimer = 0, presortAt = 0;
async function presort(m) {
  const { presort: on = true } = await chrome.storage.local.get("presort");
  if (!on || !m.rows?.length) return;
  clearTimeout(presortTimer);
  presortTimer = setTimeout(async () => {
    const q = (m.q || "").trim() || DEFAULT_Q;
    if (Date.now() - presortAt < 60e3 || (await findJob(jobKey(m.rows, q, m.owner)))) return;
    presortAt = Date.now();
    startJob(m.rows, q, m.owner, 15000);
  }, 1500);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "jev") return;
  let sub = null, job = null;
  const emit = (ev) => {
    try {
      port.postMessage(ev);
    } catch {}
  };
  port.onDisconnect.addListener(() => job?.subs.delete(sub));
  port.onMessage.addListener(async (msg) => {
    if (msg.type !== "rank") return;
    const q = (msg.q || "").trim() || DEFAULT_Q;
    const rows = msg.rows.slice(0, 50);
    job = (await findJob(jobKey(rows, q, msg.owner))) || startJob(rows, q, msg.owner, 3000);
    // Catch up on what already happened, then follow along. No await in between, so nothing is missed.
    for (const ev of replay(job.log, job.done)) emit(ev);
    if (!job.done) job.subs.add((sub = emit));
  });
});
