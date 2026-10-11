import { fetchInbox, fetchThreadContext, type Thread } from "./src/gmail";
import { rank } from "./src/rank";
import { emailTask } from "./src/emails";
import { spellcheckRequest } from "./src/spellcheck";
import { companionHandler } from "./src/companion";
import { companionToken } from "./src/companion-config";
import { localOrigin } from "./src/local-origin";

const PORT = Number(process.env.PORT || 8383);
const CACHE = "data/inbox.json";
const MAX = Number(process.env.INBOX_MAX || 100);

let inbox: { email: string; total: number; unread: number; drafts: number; fetchedAt: number; threads: Thread[] } | null = null;
let loading: Promise<void> | null = null;

async function load(force = false) {
  if (!force && !inbox && (await Bun.file(CACHE).exists())) inbox = await Bun.file(CACHE).json();
  if (!force && inbox) return;
  loading ||= (async () => {
    const t0 = performance.now();
    const r = await fetchInbox(MAX);
    inbox = { ...r, fetchedAt: Date.now() };
    await Bun.write(CACHE, JSON.stringify(inbox));
    console.log(`fetched ${r.threads.length} threads for ${r.email} in ${Math.round(performance.now() - t0)}ms`);
  })().finally(() => (loading = null));
  await loading;
}

// Last-N-hours slice for the Chrome extension. Live read-only fetch, cached briefly so repeated
// sorts don't re-hit Gmail's per-user quota.
type Recent = { email: string; hours: number; fetchedAt: number; threads: Thread[] };
let recent: Recent | null = null;
let recentLoading: Promise<Recent> | null = null;
async function loadRecent(hours: number, force = false): Promise<Recent> {
  if (!force && recent && recent.hours === hours && Date.now() - recent.fetchedAt < 600e3) return recent;
  recentLoading ||= (async () => {
    const t0 = performance.now();
    const r = await fetchInbox(100, undefined, `newer_than:${Math.ceil(hours / 24)}d`);
    const cutoff = Date.now() - hours * 36e5;
    recent = { email: r.email, hours, fetchedAt: Date.now(), threads: r.threads.filter((t) => t.date >= cutoff) };
    await Bun.write("data/recent.json", JSON.stringify(recent));
    console.log(`fetched last ${hours}h: ${recent.threads.length} threads in ${Math.round(performance.now() - t0)}ms`);
    return recent;
  })().finally(() => (recentLoading = null));
  return recentLoading;
}

const listView = (t: Thread) => {
  const { messages, ...rest } = t;
  return { ...rest, count: messages.length, attachments: messages.flatMap((m) => m.attachments).slice(0, 3) };
};

const companion = companionHandler({ token: await companionToken(), recent: () => loadRecent(24), thread: fetchThreadContext });

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/") && !localOrigin(req)) return Response.json({ error: "Origin denied." }, { status: 403 });
    const companionResponse = await companion(req);
    if (companionResponse) return companionResponse;
    if (url.pathname === "/api/spellcheck") return spellcheckRequest(req);
    try {
      if (url.pathname === "/api/inbox") {
        await load(url.searchParams.get("refresh") === "1");
        const { threads, ...meta } = inbox!;
        return Response.json({ ...meta, threads: threads.map(listView) });
      }
      if (url.pathname.startsWith("/api/thread/")) {
        await load();
        const t = inbox!.threads.find((x) => x.id === url.pathname.split("/").pop());
        return t ? Response.json(t) : new Response("not found", { status: 404 });
      }
      if (url.pathname === "/api/recent") {
        const r = await loadRecent(Number(url.searchParams.get("hours") || 24), url.searchParams.get("refresh") === "1");
        return Response.json({ email: r.email, hours: r.hours, fetchedAt: r.fetchedAt, threads: r.threads.map(listView) });
      }
      if (url.pathname === "/api/analyze") {
        const src = url.searchParams.get("src") === "recent" ? await loadRecent(Number(url.searchParams.get("hours") || 24)) : (await load(), inbox!);
        const threads = src.threads;
        const a = url.searchParams.get("algo");
        const algo = a === "swiss" || a === "pivot" || a === "full" ? a : "auto";
        const { items, task } = emailTask(threads, src.email.toLowerCase(), (url.searchParams.get("q") || "").slice(0, 300), algo);
        const enc = new TextEncoder();
        const ctl = new AbortController(), signal = AbortSignal.any([req.signal, ctl.signal]);
        const stream = new ReadableStream({
          async start(ctrl) {
            const emit = (ev: Record<string, unknown>) => { if (!signal.aborted) ctrl.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`)); };
            try {
              const r = await rank(items, task, emit, signal);
              console.log(`[${algo}] "${task.criterion}" ranked ${items.length} in ${r.ms}ms · ${r.jev.calls} calls / ${r.jev.decisions} decisions · p50 ${r.jev.p50}ms p90 ${r.jev.p90}ms · ${r.jev.hedges} hedged · $${r.jev.costUsd.toFixed(4)}`);
            } catch (e) {
              emit({ type: "fatal", message: String(e) });
            }
            if (!signal.aborted) ctrl.close();
          },
          cancel() { ctl.abort(); },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
      }
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = Bun.file((path.startsWith("/extension/") ? "." : "public") + path.replace(/\.\./g, ""));
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    } catch (e) {
      console.error(e);
      return Response.json({ error: String(e) }, { status: 500 });
    }
  },
});

console.log(`Gmail × Jev on http://localhost:${PORT}`);
