// Read-only Gmail access. The refresh is downscoped to gmail.readonly, so the access token
// this process holds cannot modify, send or delete anything, and we only ever issue GETs.
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const GM = "https://gmail.googleapis.com/gmail/v1/users/me";

let token: { value: string; exp: number } | null = null;
let refreshing: Promise<string> | null = null;

async function accessToken() {
  if (token && token.exp > Date.now() + 60e3) return token.value;
  // Inbox reads start together. Share one refresh, and allow another attempt after a failure.
  return (refreshing ||= refreshToken().finally(() => { refreshing = null; }));
}

async function refreshToken() {
  const cred = await Bun.file(process.env.GOOGLE_TOKEN_FILE!).json();
  const res = await fetch(cred.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: cred.client_id,
      client_secret: cred.client_secret,
      refresh_token: cred.refresh_token,
      grant_type: "refresh_token",
      scope: READONLY,
    }),
  });
  const t: any = await res.json();
  if (!res.ok) throw new Error("google refresh failed: " + JSON.stringify(t));
  if (t.scope !== READONLY) throw new Error("refusing token with scope " + t.scope);
  token = { value: t.access_token, exp: Date.now() + t.expires_in * 1000 };
  return token.value;
}

async function get(path: string): Promise<any> {
  let refreshed = false;
  for (let attempt = 0; ; attempt++) {
    const value = await accessToken();
    const res = await fetch(GM + path, { headers: { Authorization: `Bearer ${value}` } });
    if (res.ok) return res.json();
    if (res.status === 401 && !refreshed) {
      // A late 401 for an older token must not invalidate a refresh another read just finished.
      if (token?.value === value) token = null;
      refreshed = true;
      await res.body?.cancel();
      continue;
    }
    const text = await res.text();
    const quota = res.status === 429 || (res.status === 403 && /quota|rate ?limit/i.test(text));
    if ((quota || res.status >= 500) && attempt < 6) {
      await Bun.sleep((quota ? 2000 : 400) * 2 ** Math.min(attempt, 4));
      continue;
    }
    throw new Error(`gmail ${res.status} ${path.split("?")[0]}: ${text.slice(0, 200)}`);
  }
}

export async function profile() {
  return get("/profile");
}

const b64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " ", apos: "'" };
export const decodeEntities = (s: string) =>
  s.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) =>
    entities[e.toLowerCase()] ??
    (e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1))) : m),
  );

// Marketing preheaders pad with invisible characters; Gmail renders them as nothing.
const clean = (s: string) => s.replace(/[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0]/g, "").replace(/\s+/g, " ").trim();

function htmlToText(html: string) {
  return decodeEntities(
    html
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>|<\/h\d>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ‌​͏]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

function parts(payload: any) {
  let plain = "", html = "";
  const attachments: string[] = [];
  const walk = (p: any) => {
    if (!p) return;
    if (p.filename) attachments.push(p.filename);
    else if (p.mimeType === "text/plain" && p.body?.data && !plain) plain = b64(p.body.data);
    else if (p.mimeType === "text/html" && p.body?.data && !html) html = b64(p.body.data);
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  return { plain, html, attachments };
}

const header = (msg: any, name: string) =>
  msg.payload?.headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

function parseAddr(v: string) {
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) return { name: decodeEntities(m[1].trim()) || m[2], email: m[2].toLowerCase() };
  return { name: v.trim(), email: v.trim().toLowerCase() };
}

// "Lowe, Dave (HQP)" -> "Dave", "Jon Corrin" -> "Jon"
const firstName = (name: string) => (name.includes(",") ? name.split(",")[1] : name).trim().split(/\s+/)[0] || name;

export interface Message {
  id: string;
  from: { name: string; email: string };
  to: string;
  date: number;
  html: string;
  text: string;
  attachments: string[];
}

export interface Thread {
  id: string;
  subject: string;
  snippet: string;
  date: number;
  unread: boolean;
  starred: boolean;
  important: boolean;
  category: string;
  bulk: boolean;
  senders: string[];
  from: { name: string; email: string };
  messages: Message[];
}

async function pool<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>, onDone?: (done: number) => void): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let i = 0, done = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, async () => {
      while (i < xs.length) {
        const k = i++;
        out[k] = await f(xs[k]);
        onDone?.(++done);
      }
    }),
  );
  return out;
}

export async function fetchInbox(max: number, onProgress?: (done: number, total: number) => void, query = ""): Promise<{ email: string; total: number; unread: number; drafts: number; threads: Thread[] }> {
  const [me, list, label, drafts] = await Promise.all([
    profile(),
    get(`/threads?labelIds=INBOX&maxResults=${max}${query ? "&q=" + encodeURIComponent(query) : ""}`),
    get(`/labels/INBOX`),
    get(`/labels/DRAFT`),
  ]);
  const ids: string[] = (list.threads || []).map((t: any) => t.id);
  const threads = await pool(
    ids,
    25,
    async (tid): Promise<Thread | null> => {
      try {
        const t = await get(`/threads/${tid}?format=full`);
        const msgs = (t.messages as any[]).filter((m) => !(m.labelIds || []).includes("DRAFT"));
        if (!msgs.length) return null;
        const last = msgs[msgs.length - 1];
        const labels = new Set<string>(msgs.flatMap((m) => m.labelIds || []));
        const messages: Message[] = msgs.map((m) => {
          const p = parts(m.payload);
          return {
            id: m.id,
            from: parseAddr(header(m, "From")),
            to: header(m, "To"),
            date: Number(m.internalDate),
            html: p.html,
            text: clean((p.plain || htmlToText(p.html)).replace(/\n/g, "\u0001")).replace(/\u0001/g, "\n").slice(0, 20000),
            attachments: p.attachments,
          };
        });
        const senders: string[] = [];
        for (const m of messages) {
          const n = m.from.email === me.emailAddress.toLowerCase() ? "me" : messages.length > 1 ? firstName(m.from.name) : m.from.name;
          if (!senders.includes(n)) senders.push(n);
        }
        const cat = ["PROMOTIONS", "SOCIAL", "UPDATES", "FORUMS"].find((c) => labels.has("CATEGORY_" + c)) || "PRIMARY";
        return {
          id: tid,
          subject: decodeEntities(header(msgs[0], "Subject")) || "(no subject)",
          snippet: clean(decodeEntities(last.snippet || "")),
          date: Number(last.internalDate),
          unread: labels.has("UNREAD"),
          starred: labels.has("STARRED"),
          important: labels.has("IMPORTANT"),
          category: cat,
          bulk: !!header(last, "List-Unsubscribe"),
          senders,
          from: messages[messages.length - 1].from,
          messages,
        };
      } catch (e) {
        console.error("thread", tid, String(e).slice(0, 200));
        return null;
      }
    },
    (d) => onProgress?.(d, ids.length),
  );
  return { email: me.emailAddress, total: label.threadsTotal ?? me.threadsTotal, unread: label.threadsUnread ?? 0, drafts: drafts.threadsTotal ?? 0, threads: threads.filter(Boolean) as Thread[] };
}
