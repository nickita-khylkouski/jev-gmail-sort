// Read-only Gmail API access for the background worker. The refresh is downscoped to
// gmail.readonly and any token with a wider scope is refused, so nothing here can send, archive,
// label or delete. Only GETs are issued.
import secrets from "./secrets.js";

const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const GM = "https://gmail.googleapis.com/gmail/v1/users/me";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let token = null;
async function accessToken() {
  if (token && token.exp > Date.now() + 60e3) return token.value;
  const g = secrets.google;
  const res = await fetch(g.token_uri, {
    method: "POST",
    body: new URLSearchParams({ client_id: g.client_id, client_secret: g.client_secret, refresh_token: g.refresh_token, grant_type: "refresh_token", scope: READONLY }),
  });
  const t = await res.json();
  if (!res.ok) throw new Error("Google sign-in failed: " + (t.error_description || t.error || res.status));
  if (t.scope !== READONLY) throw new Error("Refusing a Google token with scope " + t.scope);
  token = { value: t.access_token, exp: Date.now() + t.expires_in * 1000 };
  return token.value;
}

async function get(path) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(GM + path, { headers: { Authorization: `Bearer ${await accessToken()}` } });
    if (res.ok) return res.json();
    const text = await res.text();
    const quota = res.status === 429 || (res.status === 403 && /quota|rate ?limit/i.test(text));
    if (quota) nextAt = Math.max(nextAt, Date.now() + 1000); // back off new reads too, not just this one
    if ((quota || res.status >= 500) && attempt < 5) {
      await sleep((quota ? 1000 : 300) * 2 ** Math.min(attempt, 3));
      continue;
    }
    const err = new Error(`gmail ${res.status}: ${text.slice(0, 160)}`);
    err.status = res.status;
    throw err;
  }
}

let me = null;
export const account = async () => (me ||= (await get("/profile")).emailAddress.toLowerCase());

const utf8 = new TextDecoder();
const b64 = (s) => utf8.decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " ", apos: "'" };
const decode = (s) =>
  s.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => ENT[e.toLowerCase()] ?? (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1))) : m));
// Marketing preheaders pad with invisible characters; Gmail renders them as nothing.
const clean = (s) => s.replace(/[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ﻿ﾠ]/g, "").replace(/\s+/g, " ").trim();
const htmlText = (html) => decode(html.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, " ").replace(/<[^>]+>/g, " "));

function parts(payload) {
  let plain = "", html = "";
  const files = [];
  const walk = (p) => {
    if (!p) return;
    if (p.filename) files.push(p.filename);
    else if (p.mimeType === "text/plain" && p.body?.data && !plain) plain = b64(p.body.data);
    else if (p.mimeType === "text/html" && p.body?.data && !html) html = b64(p.body.data);
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  return { text: clean(plain || htmlText(html)), files };
}
const header = (m, name) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value || "";
function addr(v) {
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  return m ? { name: decode(m[1].trim()) || m[2], email: m[2].toLowerCase() } : { name: v.trim(), email: v.trim().toLowerCase() };
}

// One thread -> the fields the ranker sees. Same shape as the server's card in src/emails.ts.
async function thread(id, mine) {
  const t = await get(`/threads/${id}?format=full`);
  const msgs = t.messages.filter((m) => !(m.labelIds || []).includes("DRAFT"));
  if (!msgs.length) return null;
  const last = msgs.at(-1);
  const labels = new Set(msgs.flatMap((m) => m.labelIds || []));
  const from = msgs.map((m) => addr(header(m, "from")));
  const other = [...from].reverse().find((f) => f.email !== mine) || from.at(-1);
  const people = [...new Set(from.map((f) => (f.email === mine ? "me" : f.name.split(/\s+/)[0])))];
  const { text, files } = parts(last.payload);
  return {
    from: `${other.name} <${other.email}>`,
    subject: decode(header(msgs[0], "subject")) || "(no subject)",
    received: ago(Number(last.internalDate)),
    gmail_tab: (["PROMOTIONS", "SOCIAL", "UPDATES", "FORUMS"].find((c) => labels.has("CATEGORY_" + c)) || "PRIMARY").toLowerCase(),
    signals: [
      header(last, "list-unsubscribe") ? "bulk mail (List-Unsubscribe)" : "no unsubscribe header",
      labels.has("UNREAD") ? "unread" : "read",
      labels.has("STARRED") ? "starred" : "",
      from.at(-1).email === mine ? "the owner sent the latest message in this thread (they are waiting on the other side)" : "",
      msgs.length > 1 ? `thread of ${msgs.length} (participants: ${people.join(", ")})` : "",
      files.length ? `attachments: ${files.slice(0, 3).join(", ")}` : "",
    ].filter(Boolean).join(" · "),
    body: (text || clean(decode(last.snippet || ""))).slice(0, 900),
  };
}
const ago = (ms) => {
  const h = (Date.now() - ms) / 36e5;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} minutes ago` : h < 48 ? `${Math.round(h)} hours ago` : `${Math.round(h / 24)} days ago`;
};

// Gmail's per-user quota is 250 units/s and threads.get costs 10, so about 25 threads/s. Pace request
// starts just under that instead of bursting into 429s.
let nextAt = 0;
const paced = async () => {
  const now = Date.now();
  const at = Math.max(now, nextAt);
  nextAt = at + 45;
  if (at > now) await sleep(at - now);
};

// Cards are cached in session storage (memory only, cleared when Chrome quits), so they survive the
// service worker going idle. In-flight reads are shared, so a prefetch and a sort never double up.
const CACHE_MS = 2 * 60e3;
const fresh = (entry) => entry?.card && Number.isFinite(entry.at) && Date.now() >= entry.at && Date.now() - entry.at < CACHE_MS;
const cache = new Map(); // id -> { at, card }; thread ids remain the same when a new reply arrives
const inflight = new Map();
const load = async (id) => {
  const memory = cache.get(id);
  if (fresh(memory)) return memory.card;
  cache.delete(id);
  const k = "c:" + id;
  const stored = (await chrome.storage.session.get(k))[k];
  if (fresh(stored)) return cache.set(id, stored), stored.card;
  if (!inflight.has(id))
    inflight.set(id, (async () => {
      try {
        await paced();
        const c = await thread(id, await account());
        // An all-draft thread may become a sent message on the very next read.
        if (c) {
          const entry = { at: Date.now(), card: c };
          cache.set(id, entry);
          chrome.storage.session.set({ [k]: entry }).catch(() => {});
        }
        return c;
      } catch (e) {
        if (e.status !== 404) console.warn("thread", id, String(e).slice(0, 160)); // 404: a different account's Gmail tab
        return null;
      } finally {
        inflight.delete(id);
      }
    })());
  return inflight.get(id);
};

export const prefetch = (ids) => Promise.all(ids.map(load));

// Cards for the given ids. Whatever isn't read in time comes back null (the caller falls back to the
// list-row preview) and keeps loading into the cache for next time. "In time": at most `budget` ms,
// and we stop waiting early once reads stall (Gmail throttling), since a sort shouldn't sit idle.
export async function cards(ids, onDone, budget = 3000, stall = 900) {
  let done = 0, last = 0, giveUp;
  const t0 = Date.now();
  const late = new Promise((r) => (giveUp = r));
  // The stall clock starts at the first email that arrives (the first read also refreshes the token).
  const watch = setInterval(() => ((last && Date.now() - last > stall) || Date.now() - t0 > budget) && giveUp("late"), 100);
  try {
    return await Promise.all(
      ids.map(async (id) => {
        const c = await Promise.race([load(id), late]);
        const ok = c && c !== "late";
        if (ok) last = Date.now();
        onDone?.(++done, !!ok);
        return ok ? c : null;
      }),
    );
  } finally {
    clearInterval(watch);
  }
}
